// 项目 Agent 工具（tasks 6.3，design §5）：project_read / project_apply / project_record / project_receipt。
//
// 准入与身份（design §5、spec project-conversation-context）：
// - 身份只来自真实 ToolRunContext：exec.agent.id（＝SessionId）经 WorkService.captureBinding
//   映射到唯一生效 WorkRun；工具参数不提供任何可生效的身份／授权字段，未知参数一律拒绝。
// - 无 invocation 是正常情况；agent 缺失或无生效绑定 → 稳定拒绝，不降级、不读 owner 判据。
// - 写入（apply／record）与读取（read）共用命令／快照应用服务；绑定外目标与动作由
//   WorkService.authorizeAgentCommand 拒绝（6.2），本适配器不重复实现范围判断。
// - project_receipt 重试须引用原操作归属：getReceipt 按 origin 隔离，其他归属拿不到结果。
//
// 边界：本文件做参数校验、绑定捕获与输出契约；命令校验、发布序列与幂等都在应用层。
// 工具定义结构体不 import @deepseek-ai/dsh-tools（类型链问题见 host/index.ts 注），
// 由宿主 tools.register() 运行时校验。

import type { RuntimeResult } from './project-service.js'
import type {
  Command,
  CommittedCommand,
  PendingCommand,
  RejectedCommand,
} from '../application/command-service.js'
import type { WorkCapture } from '../application/work.js'

// ---------- 工具定义结构体（与 dsh-tools ToolDefinition 运行时形态对齐） ----------

export interface ConaAbortSignalLike {
  readonly aborted: boolean;
  addEventListener?(type: 'abort', listener: () => void, options?: { readonly once?: boolean }): void;
  removeEventListener?(type: 'abort', listener: () => void): void;
}

/** 真实工具执行上下文的最小结构（2.4 实测：只有 callId/rootCallId/agent/signal，无 invocation）。 */
export interface ConaToolExec {
  agent?: { readonly id: unknown };
  callId?: unknown;
  signal?: ConaAbortSignalLike;
}

export interface ConaToolProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  items?: { type: string };
  enum?: number[];
}

export interface ConaToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    additionalProperties: false;
    properties: Record<string, ConaToolProperty>;
    required?: string[];
  };
  output: {
    schema: {
      type: 'object';
      additionalProperties: false;
      properties: Record<string, ConaToolProperty>;
      required?: string[];
    };
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>;
  };
  execute(args: unknown, exec: ConaToolExec): Promise<Record<string, unknown>>;
}

export interface ConaToolsRegistry {
  register(definition: ConaToolDefinition): () => void;
}

// ---------- 参数与结果形状 ----------

export type ToolOutcome = Record<string, unknown>;

/** project_read 输出：基线 + 绑定范围 + 完整小树与依赖（无正文；正文属记录协议）。 */
export interface ProjectReadOutput {
  status: 'read';
  instanceId: string;
  projectId: string;
  planVersion: string;
  planRevision: number;
  stateRevision: number;
  sourceEpoch: number;
  binding: {
    workRunId: string;
    bindingVersion: number;
    turn: number;
    targets: string[];
    allowedActions: string[];
  };
  nodes: Array<{
    id: string;
    parentId: string | null;
    order: number;
    title: string;
    goal: string;
    status: string;
    completionCriteria: string[];
  }>;
  dependencies: Array<{ nodeId: string; requiresNodeId: string }>;
  recordCount: number;
  readAt: string;
}

export type ToolRejectedOutput = {
  status: 'rejected';
  code: string;
  message: string;
};

export type ToolPendingOutput = {
  status: 'pending-reconciliation';
  operationId: string;
  stage: string;
  message: string;
};

export type ToolCommittedOutput = {
  status: 'committed';
  operationId: string;
  impact: 'plan' | 'state';
  planVersion: string;
  planRevision: number;
  stateRevision: number;
  sourceEpoch: number;
  recordId?: string;
  recordPath?: string;
  /** 规划提交成功后绑定已推进到的新版本（informational；下次调用重新捕获）。 */
  newBindingVersion?: number;
  /** 回执查询（project_receipt）命中原操作时为 true；首次提交结果不带。 */
  replayed?: boolean;
};

export interface ProjectApplyArgs {
  operationId: string;
  /** 规划命令（含 3.3 的 move／insert；记录追加走 project_record）。 */
  command: Command;
  expectedPlanVersion: string;
  expectedPlanRevision: number;
  sourceEpoch: number;
}

export interface ProjectRecordArgs {
  operationId: string;
  kind: string;
  subjectNodeIds: string[];
  summary: string;
  sources: Array<{ repositoryId: string; relativePath: string; observedHash?: string }>;
  body: string;
  verification?: { status: string; subject: { kind: string; id: string }; subjectVersion?: string; scope?: string };
}

export interface ProjectReceiptArgs {
  operationId: string;
}

export interface ProjectToolDeps {
  /** 懒装配（与 Remote 共用同一 runtime promise）；失败结果被记忆。 */
  runtime: () => Promise<RuntimeResult>;
}

// ---------- 参数校验 ----------

const PLANNING_TYPES = new Set([
  'add-nodes', 'update-node', 'split-node', 'set-dependencies', 'set-node-status',
  // tasks 3.3：结构命令经可信 WorkRun 的 move／insert 动作授权，仍受同一命令服务与回执核对。
  'move-node', 'insert-preset', 'insert-user-template',
]);
const RECORD_KINDS = new Set(['plan-change', 'analysis-note', 'execution-note', 'verification']);
const VERIFICATION_STATUSES = new Set(['pass', 'fail', 'blocked', 'untested']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 未知参数拒绝：工具参数不提供身份／授权字段，出现 schema 外的键一律拒绝。 */
function exactKeys(args: unknown, allowed: string[]): Record<string, unknown> | null {
  if (!isRecord(args)) return null;
  const keys = Object.keys(args);
  for (const key of keys) {
    if (!allowed.includes(key)) return null;
  }
  return args;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.length > 0 && value.every((item) => nonEmptyString(item))
    ? (value as string[])
    : null;
}

/** 最小命令形状校验：深度校验由命令服务的 checkEnvelope／领域变换承担。 */
function validatePlanningCommand(command: unknown): { ok: true } | { ok: false; message: string } {
  if (!isRecord(command)) return { ok: false, message: 'command 必须是对象' };
  const type = command['type'];
  if (typeof type !== 'string' || !PLANNING_TYPES.has(type)) {
    return { ok: false, message: `command.type 必须是 ${[...PLANNING_TYPES].join('/')}；记录追加走 project_record` };
  }
  return { ok: true };
}

function validateRecordArgs(args: ProjectRecordArgs): string | null {
  if (typeof args.kind !== 'string' || !RECORD_KINDS.has(args.kind)) {
    return `kind 必须是 ${[...RECORD_KINDS].join('/')}`;
  }
  if (stringArray(args.subjectNodeIds) === null) {
    return 'subjectNodeIds 必须是非空字符串数组';
  }
  if (!nonEmptyString(args.summary)) return '缺少 summary';
  if (typeof args.body !== 'string' || args.body === '') return '缺少 body（UTF-8 Markdown 正文）';
  if (!Array.isArray(args.sources) || !args.sources.every((source) => isRecord(source)
    && nonEmptyString(source['repositoryId']) && nonEmptyString(source['relativePath']))) {
    return 'sources 必须是 { repositoryId, relativePath, observedHash? } 数组';
  }
  const verification = args.verification;
  if (verification !== undefined) {
    if (!isRecord(verification)) return 'verification 必须是对象';
    if (typeof verification['status'] !== 'string' || !VERIFICATION_STATUSES.has(verification['status'])) {
      return `verification.status 必须是 ${[...VERIFICATION_STATUSES].join('/')}`;
    }
    const subject = verification['subject'];
    if (!isRecord(subject) || (subject['kind'] !== 'node' && subject['kind'] !== 'record') || !nonEmptyString(subject['id'])) {
      return 'verification.subject 必须是 { kind: node|record, id }';
    }
  }
  return null;
}

// ---------- 适配器 ----------

export class ProjectToolAdapter {
  constructor(private readonly deps: ProjectToolDeps) {}

  // ---- 绑定捕获（四个工具共用；身份只来自真实 exec.agent） ----

  private async capture(exec: ConaToolExec): Promise<
    { ok: true; capture: WorkCapture; runtime: Extract<RuntimeResult, { ok: true }>['value'] }
    | { ok: false; output: ToolRejectedOutput }
  > {
    const runtime = await this.deps.runtime();
    if (!runtime.ok) {
      return { ok: false, output: { status: 'rejected', code: runtime.code, message: runtime.message } };
    }
    const sessionId = exec !== undefined && exec.agent !== undefined && exec.agent.id !== undefined
      ? String(exec.agent.id)
      : null;
    const captured = await runtime.value.work.captureBinding(sessionId);
    if (!captured.ok) {
      return { ok: false, output: { status: 'rejected', code: captured.code, message: captured.message } };
    }
    return { ok: true, capture: captured.capture, runtime: runtime.value };
  }

  // ---- project_read ----

  async read(args: unknown, exec: ConaToolExec): Promise<ToolOutcome> {
    if (exactKeys(args, []) === null) {
      return { status: 'rejected', code: 'operation-mismatch', message: 'project_read 不接受任何参数；身份与授权字段无效且被拒绝' };
    }
    const captured = await this.capture(exec);
    if (!captured.ok) return captured.output;
    const { runtime, capture } = captured;
    const snapshot = await runtime.snapshot.read(
      { kind: 'agent-work', workRunId: capture.workRunId, bindingVersion: capture.bindingVersion, instanceId: runtime.instance.instanceId },
      { instanceId: runtime.instance.instanceId, connectionGeneration: 0 },
    );
    if (snapshot.status !== 'snapshot') {
      if (snapshot.status === 'rejected') {
        return { status: 'rejected', code: snapshot.code, message: snapshot.message };
      }
      return { status: 'rejected', code: `snapshot-${snapshot.status}`, message: snapshot.detail };
    }
    const s = snapshot.snapshot;
    const output: ProjectReadOutput = {
      status: 'read',
      instanceId: s.instanceId,
      projectId: s.projectId,
      planVersion: s.planVersion,
      planRevision: s.planRevision,
      stateRevision: s.stateRevision,
      sourceEpoch: s.sourceEpoch,
      binding: {
        workRunId: capture.workRunId,
        bindingVersion: capture.bindingVersion,
        turn: capture.turn,
        targets: [...capture.targets],
        allowedActions: [...capture.allowedActions],
      },
      nodes: s.tree.map((node) => ({
        id: node.id,
        parentId: node.parentId,
        order: node.order,
        title: node.title,
        goal: node.goal,
        status: node.status,
        completionCriteria: [...node.completionCriteria],
      })),
      dependencies: s.dependencies.map((edge) => ({ nodeId: edge.nodeId, requiresNodeId: edge.requiresNodeId })),
      recordCount: s.records.length,
      readAt: s.readAt,
    };
    return output as unknown as ToolOutcome;
  }

  // ---- project_apply（规划命令含结构命令；基线必须显式提供并经绑定准入核对） ----

  async apply(args: unknown, exec: ConaToolExec): Promise<ToolOutcome> {
    const checked = exactKeys(args, ['operationId', 'command', 'expectedPlanVersion', 'expectedPlanRevision', 'sourceEpoch']);
    if (checked === null) {
      return {
        status: 'rejected',
        code: 'operation-mismatch',
        message: '参数必须是 operationId／command／expectedPlanVersion／expectedPlanRevision／sourceEpoch；Session／WorkRun／授权等身份字段无效且被拒绝',
      };
    }
    const operationId = checked['operationId'];
    if (!nonEmptyString(operationId)) {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少 operationId' };
    }
    const commandShape = validatePlanningCommand(checked['command']);
    if (!commandShape.ok) {
      return { status: 'rejected', code: 'operation-mismatch', message: commandShape.message };
    }
    const baseline = this.readBaseline(checked);
    if (baseline !== null) return baseline;
    const captured = await this.capture(exec);
    if (!captured.ok) return captured.output;
    const { runtime, capture } = captured;
    const envelope = {
      operationId,
      projectId: runtime.instance.projectId,
      instanceId: runtime.instance.instanceId,
      sourceEpoch: checked['sourceEpoch'] as number,
      expectedPlanVersion: checked['expectedPlanVersion'] as string,
      expectedPlanRevision: checked['expectedPlanRevision'] as number,
      command: checked['command'] as Command,
    };
    const result = await runtime.command.execute(
      { kind: 'agent-work', workRunId: capture.workRunId, bindingVersion: capture.bindingVersion, instanceId: runtime.instance.instanceId },
      envelope,
    );
    await this.maybeObserveAbort(runtime, capture, exec);
    return this.commitOutput(result, capture);
  }

  // ---- project_record（append-record；状态影响不推进绑定版本） ----

  async record(args: unknown, exec: ConaToolExec): Promise<ToolOutcome> {
    const checked = exactKeys(args, ['operationId', 'kind', 'subjectNodeIds', 'summary', 'sources', 'body', 'verification']);
    if (checked === null) {
      return {
        status: 'rejected',
        code: 'operation-mismatch',
        message: '参数必须是 operationId／kind／subjectNodeIds／summary／sources／body／verification；身份与授权字段无效且被拒绝',
      };
    }
    const recordArgs = checked as unknown as ProjectRecordArgs;
    const invalid = validateRecordArgs(recordArgs);
    if (invalid !== null) {
      return { status: 'rejected', code: 'operation-mismatch', message: invalid };
    }
    const captured = await this.capture(exec);
    if (!captured.ok) return captured.output;
    const { runtime, capture } = captured;
    const envelope = {
      operationId: recordArgs.operationId,
      projectId: runtime.instance.projectId,
      instanceId: runtime.instance.instanceId,
      sourceEpoch: capture.acceptedBaseline.sourceEpoch,
      expectedPlanVersion: capture.acceptedBaseline.planVersion,
      expectedPlanRevision: capture.acceptedBaseline.planRevision,
      command: {
        type: 'append-record' as const,
        kind: recordArgs.kind as never,
        subjectNodeIds: recordArgs.subjectNodeIds,
        summary: recordArgs.summary,
        sources: recordArgs.sources as never[],
        body: recordArgs.body,
        ...(recordArgs.verification === undefined ? {} : { verification: recordArgs.verification as never }),
      },
    };
    const result = await runtime.command.execute(
      { kind: 'agent-work', workRunId: capture.workRunId, bindingVersion: capture.bindingVersion, instanceId: runtime.instance.instanceId },
      envelope,
    );
    await this.maybeObserveAbort(runtime, capture, exec);
    return this.commitOutput(result, capture);
  }

  // ---- project_receipt（引用原操作归属；按 origin 隔离） ----

  async receipt(args: unknown, exec: ConaToolExec): Promise<ToolOutcome> {
    const checked = exactKeys(args, ['operationId']);
    if (checked === null) {
      return { status: 'rejected', code: 'operation-mismatch', message: '参数必须是 operationId；身份与授权字段无效且被拒绝' };
    }
    if (!nonEmptyString(checked['operationId'])) {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少 operationId' };
    }
    const captured = await this.capture(exec);
    if (!captured.ok) return captured.output;
    const { runtime, capture } = captured;
    const result = await runtime.command.getReceipt(
      { kind: 'agent-work', workRunId: capture.workRunId, bindingVersion: capture.bindingVersion, instanceId: runtime.instance.instanceId },
      { instanceId: runtime.instance.instanceId, operationId: checked['operationId'] },
    );
    if (result.status === 'not-found') {
      return { status: 'rejected', code: 'not-found', message: '没有该操作记录' };
    }
    return this.commitOutput(result, capture);
  }

  // ---- 内部 ----

  /**
   * 工具 abort 观测（tasks 6.5）：写操作返回时 exec.signal 已中止属取消请求（cancel／steer）——
   * 立即停止该运行的新写准入，等真实终态确认。best-effort：观测失败不影响工具结果本身。
   */
  private async maybeObserveAbort(
    runtime: Extract<RuntimeResult, { ok: true }>['value'],
    capture: WorkCapture,
    exec: ConaToolExec,
  ): Promise<void> {
    if (exec.signal?.aborted !== true) return;
    try {
      await runtime.work.observeCancel({ sessionId: capture.sessionId });
    } catch {
      // 取消观测失败不改变已完成的命令结果；下一次调用仍会经准入核对。
    }
  }

  /** apply 的基线参数核对：必须是正整数修订与合法版本串。 */
  private readBaseline(checked: Record<string, unknown>): ToolRejectedOutput | null {
    const version = checked['expectedPlanVersion'];
    const revision = checked['expectedPlanRevision'];
    const epoch = checked['sourceEpoch'];
    if (!nonEmptyString(version)) {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少 expectedPlanVersion（来自 project_read 输出）' };
    }
    if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
      return { status: 'rejected', code: 'operation-mismatch', message: 'expectedPlanRevision 必须是非负整数' };
    }
    if (!Number.isSafeInteger(epoch) || (epoch as number) < 1) {
      return { status: 'rejected', code: 'operation-mismatch', message: 'sourceEpoch 必须是正整数' };
    }
    return null;
  }

  private commitOutput(
    result: CommittedCommand | RejectedCommand | PendingCommand,
    capture: WorkCapture,
  ): ToolOutcome {
    if (result.status === 'committed') {
      const output: ToolCommittedOutput = {
        status: 'committed',
        operationId: result.operationId,
        impact: result.impact,
        planVersion: result.planVersion,
        planRevision: result.planRevision,
        stateRevision: result.stateRevision,
        sourceEpoch: result.sourceEpoch,
        ...(result.recordId === undefined ? {} : { recordId: result.recordId }),
        ...(result.recordPath === undefined ? {} : { recordPath: result.recordPath }),
        ...(result.impact === 'plan' ? { newBindingVersion: capture.bindingVersion + 1 } : {}),
        ...(result.replayed === true ? { replayed: true } : {}),
      };
      return output as unknown as ToolOutcome;
    }
    if (result.status === 'rejected') {
      const output: ToolRejectedOutput & { current?: unknown } = {
        status: 'rejected',
        code: result.code,
        message: result.message,
      };
      return output as unknown as ToolOutcome;
    }
    const pending: ToolPendingOutput = {
      status: 'pending-reconciliation',
      operationId: result.operationId,
      stage: result.stage,
      message: result.message,
    };
    return pending as unknown as ToolOutcome;
  }
}

// ---------- 工具定义（schema + render + execute 转发） ----------

function renderJson(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }];
}

function renderRejected(value: unknown): Array<{ type: 'text'; text: string }> {
  const v = value as { status?: string; code?: string; message?: string };
  return [{ type: 'text' as const, text: `${v.status ?? 'rejected'}（${v.code ?? '?'}）：${v.message ?? ''}` }];
}

type SchemaShape = {
  type: 'object';
  additionalProperties: false;
  properties: Record<string, ConaToolProperty>;
  required?: string[];
};

const REJECTED_SCHEMA: SchemaShape = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', description: 'rejected' },
    code: { type: 'string', description: '稳定拒绝码' },
    message: { type: 'string', description: '面向调用者的说明' },
  },
  required: ['status'],
};

const COMMITTED_SCHEMA: SchemaShape = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', description: 'committed / rejected / pending-reconciliation' },
    operationId: { type: 'string' },
    impact: { type: 'string' },
    planVersion: { type: 'string' },
    planRevision: { type: 'integer' },
    stateRevision: { type: 'integer' },
    sourceEpoch: { type: 'integer' },
    recordId: { type: 'string' },
    recordPath: { type: 'string' },
    newBindingVersion: { type: 'integer' },
    replayed: { type: 'boolean' },
    code: { type: 'string' },
    message: { type: 'string' },
    stage: { type: 'string' },
  },
  required: ['status'],
};

/** 四个工具的宿主定义：schema 即输出契约，execute 转发适配器。 */
export function defineProjectTools(adapter: ProjectToolAdapter): ConaToolDefinition[] {
  return [
    {
      name: 'project_read',
      description: 'Read the bound project snapshot: plan baseline, active WorkRun scope (targets and allowed actions), full node tree and dependencies. Identity comes only from the real tool context (agent id mapped to the active WorkRun); the tool accepts no arguments. Read-only.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', description: 'read / rejected' },
            instanceId: { type: 'string' },
            projectId: { type: 'string' },
            planVersion: { type: 'string' },
            planRevision: { type: 'integer' },
            stateRevision: { type: 'integer' },
            sourceEpoch: { type: 'integer' },
            binding: { type: 'object', description: 'workRunId / bindingVersion / turn / targets / allowedActions' },
            nodes: { type: 'array', description: '完整小树（id/parentId/order/title/goal/status/completionCriteria）' },
            dependencies: { type: 'array', description: '依赖边（nodeId/requiresNodeId）' },
            recordCount: { type: 'integer' },
            readAt: { type: 'string' },
            code: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['status'],
        },
        render(_args, value) {
          const v = value as { status?: string };
          return v.status === 'read' ? renderJson(value) : renderRejected(value);
        },
      },
      execute: (args, exec) => adapter.read(args, exec),
    },
    {
      name: 'project_apply',
      description: 'Apply one planning command (add-nodes / update-node / split-node / set-dependencies / set-node-status / move-node / insert-preset / insert-user-template) through the unified command envelope. Requires operationId, the command, and the expected plan baseline from project_read output. Writes are authorized only inside the active WorkRun scope: targets, allowed actions, and — for structural commands — the affected source group, subtree, destination group and reordered siblings computed from the current plan. move into or within the root group needs a separately granted root-group permission; insert requires an existing parent (parentId: null always returns parent-not-found) and an exactly authorized template identity/version (user templates also fix the record id and content hash). The binding version and baseline are checked at commit; generated nodes never join the target set. No identity or authorization fields are accepted.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          operationId: { type: 'string', description: '本次操作的稳定 id（重试须复用同一 id）' },
          command: { type: 'object', description: '规划命令对象（type 为八类之一；记录追加走 project_record）' },
          expectedPlanVersion: { type: 'string', description: '期望规划版本（来自 project_read）' },
          expectedPlanRevision: { type: 'integer', description: '期望规划修订' },
          sourceEpoch: { type: 'integer', description: '资料源代际' },
        },
        required: ['operationId', 'command', 'expectedPlanVersion', 'expectedPlanRevision', 'sourceEpoch'],
      },
      output: { schema: COMMITTED_SCHEMA, render(_args, value) { return renderJson(value); } },
      execute: (args, exec) => adapter.apply(args, exec),
    },
    {
      name: 'project_record',
      description: 'Append a sourced record (plan-change / analysis-note / execution-note / verification) with subject nodes, summary, sources and a markdown body. Uses the captured binding baseline; state-only impact does not advance the binding version. No identity or authorization fields are accepted.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          operationId: { type: 'string', description: '本次操作的稳定 id' },
          kind: { type: 'string', description: 'plan-change | analysis-note | execution-note | verification' },
          subjectNodeIds: { type: 'array', items: { type: 'string' }, description: '主题节点 id 列表' },
          summary: { type: 'string', description: '记录摘要（索引可见）' },
          sources: { type: 'array', description: '来源列表（repositoryId/relativePath/observedHash?）' },
          body: { type: 'string', description: 'UTF-8 Markdown 正文' },
          verification: { type: 'object', description: '可选验证块（status/subject/subjectVersion/scope）' },
        },
        required: ['operationId', 'kind', 'subjectNodeIds', 'summary', 'sources', 'body'],
      },
      output: { schema: COMMITTED_SCHEMA, render(_args, value) { return renderJson(value); } },
      execute: (args, exec) => adapter.record(args, exec),
    },
    {
      name: 'project_receipt',
      description: 'Query the receipt of an operation previously issued by this same execution origin (WorkRun). Takes operationId only; receipts of other origins are not readable. Use for idempotent retries instead of re-issuing writes.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { operationId: { type: 'string' } },
        required: ['operationId'],
      },
      output: {
        schema: REJECTED_SCHEMA,
        render(_args, value) { return renderJson(value); },
      },
      execute: (args, exec) => adapter.receipt(args, exec),
    },
  ];
}
