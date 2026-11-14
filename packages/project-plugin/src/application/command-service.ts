// 规划与记录命令封套（tasks 4.1／4.2，design §5–§6）。
// 本文件负责：可信入口校验、每实例提交队列、提交前重读、不可变变换、三态发布、双修订推进，
// 以及 (instanceId, operationId) 幂等：先写 pending 意图、完成后写回执，重试返回原结果。
// 4.5 增补：unknown-state／聚合不可读时写隔离标记，停止该实例读写，并提供只读诊断与显式解除。

import { applyPlanCommand, appendRecordIndex, type NodePatch, type PlanCommand } from '../domain/commands.js';
import type {
  DependencyEdge,
  NodeStatus,
  ProjectDocument,
  RecordKind,
  RecordSource,
  Sha256Fn,
  ValidationIssue,
  VerificationBlock,
  WorkNode,
} from '../domain/types.js';
import { validateProjectDocument } from '../domain/validate.js';
import { readSourceBaseline } from './baseline.js';
import { InstanceCommandQueue } from './command-queue.js';
import type {
  InstanceAggregate,
  OperationOrigin,
  OperationRecord,
  OperationResultSnapshot,
  QuarantineInfo,
} from './local-state.js';
import type { BodyWriteOutcome, LocalStateStorePort, PublishHooksPort, SourceFilesPort } from './ports.js';

/** 可信主体来源：两条入口分别判据，不共用一个“owner 或为空即放行”的判断。 */
export type TrustedContext =
  | { kind: 'remote-owner' }
  | { kind: 'agent-work'; workRunId: string; bindingVersion: number; instanceId: string };

export interface NewNodeInput {
  parentId: string | null;
  order: number;
  title: string;
  goal: string;
  completionCriteria: string[];
  status?: NodeStatus;
}

export interface AppendRecordCommand {
  type: 'append-record';
  kind: RecordKind;
  subjectNodeIds: string[];
  summary: string;
  sources: RecordSource[];
  /** UTF-8 Markdown 正文；哈希与路径由应用层计算。 */
  body: string;
  verification?: VerificationBlock;
}

export type Command =
  | { type: 'add-nodes'; nodes: NewNodeInput[] }
  | { type: 'update-node'; nodeId: string; patch: NodePatch }
  | { type: 'split-node'; parentId: string; children: Omit<NewNodeInput, 'parentId'>[] }
  | { type: 'set-dependencies'; dependencies: DependencyEdge[] }
  | { type: 'set-node-status'; nodeId: string; status: NodeStatus }
  | AppendRecordCommand;

export interface CommandEnvelope {
  operationId: string;
  projectId: string;
  instanceId: string;
  /** 资料实例的源代际（注册表 sourceGeneration）。 */
  sourceEpoch: number;
  expectedPlanVersion: string;
  expectedPlanRevision: number;
  command: Command;
}

export interface CommandCurrent {
  planVersion: string;
  planRevision: number;
  sourceEpoch: number;
}

export interface CommittedCommand {
  status: 'committed';
  operationId: string;
  impact: 'plan' | 'state';
  planVersion: string;
  planRevision: number;
  stateRevision: number;
  sourceEpoch: number;
  recordId?: string;
  recordPath?: string;
  /** true 表示返回的是历史回执，未再次执行。 */
  replayed?: boolean;
}

export interface RejectedCommand {
  status: 'rejected';
  code: string;
  message: string;
  issues?: ValidationIssue[];
  current?: CommandCurrent;
  replayed?: boolean;
}

export interface PendingCommand {
  status: 'pending-reconciliation';
  operationId: string;
  stage: string;
  message: string;
}

export type CommandResult = CommittedCommand | RejectedCommand | PendingCommand;

export type ReceiptResult = CommandResult | { status: 'not-found' };

/** 只读诊断报告（tasks 4.5）：不写文件，不改变任何状态。 */
export interface DiagnosticsReport {
  instanceId: string;
  quarantined: QuarantineInfo | null;
  operations: {
    operationId: string;
    status: string;
    createdAt: string;
    candidateHeadHash?: string;
    candidateHead?: string;
  }[];
  current: { planVersion: string; headHash: string; recordCount: number } | null;
  comparisons: {
    operationId: string;
    headMatched: boolean;
    bodiesMatched: boolean;
    reverted: boolean;
    diverged: boolean;
  }[];
  issues: { code: string; message: string }[];
  guidance: string[];
}

/**
 * 恢复结论（tasks 4.4）：
 * - committed + `history`：直接返回历史回执，不重放；
 * - committed + `candidate-matched`：磁盘内容精确对应候选，已补回执并一次性补修订；
 * - rejected + `not-published`：prepared 阶段被终止，标记未发布，保留原 operationId；
 * - pending-reconciliation：原基线重现或已分叉，无法判定，不自动重试。
 */
export type RecoveryResult =
  | (CommittedCommand & { replayed: true; recovery: 'history' | 'candidate-matched' })
  | (RejectedCommand & { recovery?: 'history' | 'not-published' })
  | PendingCommand
  | { status: 'not-found' };

export interface ProjectCommandDeps {
  /** R1 单一本机根；多根部署不在支持范围。 */
  localRoot: string;
  store: LocalStateStorePort;
  files: SourceFilesPort;
  sha256: Sha256Fn;
  clock: () => string;
  newNodeId: () => string;
  newRecordId: () => string;
  queue?: InstanceCommandQueue;
  /** 故障注入（仅测试）。 */
  hooks?: { publish?: PublishHooksPort; body?: PublishHooksPort; state?: PublishHooksPort };
  /** 提交后通知（第 5 段接变更流）；失败不撤回提交。 */
  notify?: (result: CommittedCommand) => void | Promise<void>;
}

/** 规划命令（除记录追加外的五类）。 */
type PlanningCommand = Exclude<Command, AppendRecordCommand>;

type AuthorizeResult = { ok: true } | { ok: false; code: string; message: string };

/** 只校验主体本身（不含实例匹配），供回执查询等只读路径复用。 */
export function checkTrustedContext(ctx: TrustedContext | undefined): AuthorizeResult {
  if (ctx === undefined || ctx === null) {
    return { ok: false, code: 'forbidden', message: '缺少可信执行上下文，不降级为进程内 owner' };
  }
  if (ctx.kind === 'remote-owner') return { ok: true };
  if (ctx.kind === 'agent-work') {
    if (typeof ctx.workRunId !== 'string' || ctx.workRunId === '') {
      return { ok: false, code: 'forbidden', message: '工具入口缺少真实 WorkRun 归属' };
    }
    if (!Number.isSafeInteger(ctx.bindingVersion) || ctx.bindingVersion < 1) {
      return { ok: false, code: 'forbidden', message: '工具入口缺少有效绑定版本' };
    }
    return { ok: true };
  }
  return { ok: false, code: 'forbidden', message: '未知入口类型' };
}

/**
 * 入口校验：UI Remote 由适配器在真实 owner invocation 上判定；工具由真实 ToolRunContext 判定。
 * 缺上下文不降级；伪造字段不能借业务参数取得资格。
 */
export function authorizeTrustedContext(ctx: TrustedContext | undefined, envelope: CommandEnvelope): AuthorizeResult {
  const base = checkTrustedContext(ctx);
  if (!base.ok) return base;
  if (ctx !== undefined && ctx.kind === 'agent-work' && ctx.instanceId !== envelope.instanceId) {
    return { ok: false, code: 'forbidden', message: '绑定实例与命令实例不一致' };
  }
  return { ok: true };
}

function originOf(ctx: TrustedContext): OperationOrigin {
  return ctx.kind === 'remote-owner' ? { kind: 'remote-owner' } : { kind: 'agent-work', workRunId: ctx.workRunId };
}

function sameOrigin(a: OperationOrigin, b: OperationOrigin): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'agent-work') return a.workRunId === b.workRunId;
  return true;
}

/** 递归按键排序并丢弃 undefined：同一业务请求必须得到同一摘要，与字面量书写顺序无关。 */
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item === undefined) continue;
      out[key] = stableValue(item);
    }
    return out;
  }
  return value;
}

export class ProjectCommandService {
  private readonly queue: InstanceCommandQueue;

  constructor(private readonly deps: ProjectCommandDeps) {
    this.queue = deps.queue ?? new InstanceCommandQueue();
  }

  /** 规范化请求摘要：命令、业务参数与输入基线；不含 operationId 或重连临时标识。 */
  requestDigest(envelope: CommandEnvelope): string {
    const payload = {
      projectId: envelope.projectId,
      instanceId: envelope.instanceId,
      sourceEpoch: envelope.sourceEpoch,
      expectedPlanVersion: envelope.expectedPlanVersion,
      expectedPlanRevision: envelope.expectedPlanRevision,
      command: envelope.command,
    };
    return 'sha256:' + this.deps.sha256(new TextEncoder().encode(JSON.stringify(stableValue(payload))));
  }

  /**
   * 执行一条命令。同实例串行；失败不占用后续命令。
   * 只有资料与私有聚合都明确成功才返回 `committed`。
   */
  async execute(ctx: TrustedContext | undefined, envelope: CommandEnvelope): Promise<CommandResult> {
    const authorized = authorizeTrustedContext(ctx, envelope);
    if (!authorized.ok) {
      return { status: 'rejected', code: authorized.code, message: authorized.message };
    }
    const shape = this.checkEnvelope(envelope);
    if (shape !== null) return shape;
    return this.queue.run(envelope.instanceId, () => this.commit(ctx as TrustedContext, envelope));
  }

  /** 查询原回执：先于任何新写；归属不同者不能读取。 */
  async getReceipt(
    ctx: TrustedContext | undefined,
    request: { instanceId: string; operationId: string },
  ): Promise<ReceiptResult> {
    const authorized = checkTrustedContext(ctx);
    if (!authorized.ok) return { status: 'rejected', code: authorized.code, message: authorized.message };
    const quarantine = await this.deps.store.readQuarantine(this.deps.localRoot, request.instanceId);
    if (quarantine !== null) {
      return {
        status: 'rejected',
        code: 'unknown-state',
        message: `该实例已隔离（${quarantine.reason}）；只提供只读诊断，不提供回执读取`,
      };
    }
    let aggregate: InstanceAggregate | null;
    try {
      aggregate = await this.deps.store.readAggregate(this.deps.localRoot, request.instanceId);
    } catch (error) {
      await this.isolate(request.instanceId, 'aggregate-unreadable', 'read-receipt', undefined, (error as Error).message);
      return { status: 'rejected', code: 'unknown-state', message: '本机聚合不可读；实例已隔离，只提供只读诊断' };
    }
    if (aggregate === null) return { status: 'not-found' };
    const record = aggregate.operations.find((item) => item.operationId === request.operationId);
    if (record === undefined) return { status: 'not-found' };
    const origin = originOf(ctx as TrustedContext);
    if (!sameOrigin(record.origin, origin)) {
      return { status: 'rejected', code: 'forbidden', message: '该回执属于其他调用归属，不提供正文或结果' };
    }
    return this.replay(record, record.requestDigest, origin);
  }

  /**
   * 显式恢复核对（tasks 4.4）：只核对磁盘与意图，不重放业务命令。
   * 必须在实例队列内执行，保证与正常提交串行。
   */
  async recover(
    ctx: TrustedContext | undefined,
    request: { instanceId: string; operationId: string },
  ): Promise<RecoveryResult> {
    const authorized = checkTrustedContext(ctx);
    if (!authorized.ok) return { status: 'rejected', code: authorized.code, message: authorized.message };
    const quarantine = await this.deps.store.readQuarantine(this.deps.localRoot, request.instanceId);
    if (quarantine !== null) {
      return {
        status: 'rejected',
        code: 'unknown-state',
        message: `该实例已隔离（${quarantine.reason}，阶段 ${quarantine.stage}）；先离线核对并解除隔离后再恢复`,
      };
    }
    return this.queue.run(request.instanceId, async () => {
      const root = this.deps.localRoot;
      const registry = await this.deps.store.readRegistry(root);
      const entry = registry.instances.find((item) => item.instanceId === request.instanceId);
      if (entry === undefined) return { status: 'not-found' };
      let aggregate: InstanceAggregate | null;
      try {
        aggregate = await this.deps.store.readAggregate(root, request.instanceId);
      } catch (error) {
        await this.isolate(request.instanceId, 'aggregate-unreadable', 'read-recover', undefined, (error as Error).message);
        return { status: 'rejected', code: 'unknown-state', message: '本机聚合不可读；实例已隔离' };
      }
      if (aggregate === null) return { status: 'not-found' };
      const record = aggregate.operations.find((item) => item.operationId === request.operationId);
      if (record === undefined) return { status: 'not-found' };
      const origin = originOf(ctx as TrustedContext);
      if (!sameOrigin(record.origin, origin)) {
        return { status: 'rejected', code: 'forbidden', message: '该操作属于其他调用归属，不提供恢复或结果' };
      }

      const replayed = this.replay(record, record.requestDigest, origin);
      if (record.status === 'committed' || record.status === 'rejected') {
        return { ...replayed, recovery: 'history' } as RecoveryResult;
      }

      if (record.status === 'prepared') {
        // 仍在 prepared：可证明未进入发布阶段。标记终止，保留 operationId，不隐式重放。
        const rejected: RejectedCommand = {
          status: 'rejected',
          code: 'not-published',
          message: '该操作停在 prepared，未进入发布；已标记为未发布。如需重做请使用明确的新命令',
        };
        await this.finishRejected(root, aggregate, record.operationId, rejected);
        return { ...rejected, recovery: 'not-published' };
      }

      // publishing：逐项比对当前磁盘与候选，不猜“已提交”或“未提交”。
      const prepared = record.prepared;
      if (prepared === undefined) {
        return {
          status: 'pending-reconciliation',
          operationId: record.operationId,
          stage: 'missing-candidate',
          message: '操作处于 publishing 但缺少候选记录；无法核对，保持待核对',
        };
      }
      const current = await readSourceBaseline(this.deps.files, entry.sourceRoot, this.deps.sha256, this.deps.clock);
      if (!current.ok) {
        return {
          status: 'pending-reconciliation',
          operationId: record.operationId,
          stage: 'invalid-project',
          message: '恢复时资料不可读或不合法；保留待核对并停止该源写入',
        };
      }
      const headMatched = current.baseline.headHash === prepared.candidateHeadHash;
      const bodiesMatched = prepared.bodies.every((body) =>
        current.baseline.records.some((item) => item.path === body.path && item.observedHash === body.contentHash),
      );
      if (headMatched && bodiesMatched) {
        const mergedRevisions = {
          plan: Math.max(aggregate.revisions.plan, prepared.planRevision),
          state: Math.max(aggregate.revisions.state, prepared.stateRevision),
        };
        const receipt: OperationRecord = {
          ...record,
          status: 'committed',
          updatedAt: this.deps.clock(),
          result: prepared.result,
          recovered: true,
        };
        const next: InstanceAggregate = {
          ...aggregate,
          revisions: mergedRevisions,
          lastObservation: {
            planVersion: current.baseline.planVersion,
            headHash: current.baseline.headHash,
            records: current.baseline.records.map((item) => ({
              path: item.path,
              contentHash: item.contentHash,
              observedHash: item.observedHash,
            })),
            observedAt: this.deps.clock(),
          },
          operations: aggregate.operations.map((item) =>
            item.operationId === record.operationId ? receipt : item,
          ),
        };
        const saved = await this.deps.store.replaceAggregateChecked(root, next, this.deps.hooks?.state);
        if (saved.status === 'not-saved') {
          return {
            status: 'pending-reconciliation',
            operationId: record.operationId,
            stage: 'receipt',
            message: `候选已匹配但回执未保存（${saved.stage}）；保留原操作 id 再核对`,
          };
        }
        if (saved.status === 'unknown-state') {
          await this.isolate(request.instanceId, 'unknown-state', 'recover', record.operationId, saved.detail);
          return {
            status: 'pending-reconciliation',
            operationId: record.operationId,
            stage: 'local-state',
            message: '候选已匹配，但本机聚合写入结果未知；实例已隔离，先离线核对再解除',
          };
        }
        return {
          status: 'committed',
          operationId: record.operationId,
          ...prepared.result,
          planRevision: mergedRevisions.plan,
          stateRevision: mergedRevisions.state,
          replayed: true,
          recovery: 'candidate-matched',
        };
      }

      const reverted = current.baseline.headHash === prepared.originalHeadHash;
      return {
        status: 'pending-reconciliation',
        operationId: record.operationId,
        stage: reverted ? 'reverted' : 'diverged',
        message: reverted
          ? '当前资料等于原基线，无法排除“发布后被回退”；保持待核对，不宣称未提交'
          : '当前资料既不匹配候选也不等于原基线（部分匹配或分叉）；保持待核对，不自动覆盖',
      };
    });
  }

  /** 写隔离标记（best-effort）：即使标记写不进去，调用方仍会停止后续操作。 */
  private async isolate(
    instanceId: string,
    reason: QuarantineInfo['reason'],
    stage: string,
    operationId?: string,
    detail?: string,
  ): Promise<void> {
    try {
      await this.deps.store.quarantine(this.deps.localRoot, {
        schemaVersion: 1,
        instanceId,
        reason,
        stage,
        createdAt: this.deps.clock(),
        requires: 'offline-review',
        ...(operationId === undefined ? {} : { operationId }),
        ...(detail === undefined ? {} : { detail }),
      });
    } catch {
      // 标记失败不改变“停止读写”的结论；由调用方返回待核对。
    }
  }

  /**
   * 只读诊断（tasks 4.5）：列出隔离状态、未决操作、当前磁盘基线与候选比对。
   * 不写任何文件；聚合不可读时仍返回隔离原因与诊断建议。
   */
  async diagnostics(instanceId: string): Promise<DiagnosticsReport> {
    const root = this.deps.localRoot;
    const issues: { code: string; message: string }[] = [];
    const quarantined = await this.deps.store.readQuarantine(root, instanceId);

    let aggregate: InstanceAggregate | null = null;
    try {
      aggregate = await this.deps.store.readAggregate(root, instanceId);
    } catch (error) {
      issues.push({
        code: (error as { code?: string }).code ?? 'local-aggregate-unreadable',
        message: (error as Error).message,
      });
    }

    const registry = await this.deps.store.readRegistry(root);
    const entry = registry.instances.find((item) => item.instanceId === instanceId);
    let current: DiagnosticsReport['current'] = null;
    let currentRecords: { path: string; contentHash: string; observedHash: string }[] = [];
    if (entry === undefined) {
      issues.push({ code: 'registry-instance-not-found', message: '本机注册表中没有该实例' });
    } else {
      const baseline = await readSourceBaseline(this.deps.files, entry.sourceRoot, this.deps.sha256, this.deps.clock);
      if (baseline.ok) {
        current = {
          planVersion: baseline.baseline.planVersion,
          headHash: baseline.baseline.headHash,
          recordCount: baseline.baseline.records.length,
        };
        currentRecords = baseline.baseline.records.map((item) => ({
          path: item.path,
          contentHash: item.contentHash,
          observedHash: item.observedHash,
        }));
      } else {
        issues.push(...baseline.issues.map((issue) => ({ code: issue.code, message: issue.message })));
      }
    }

    const operations = (aggregate?.operations ?? []).map((item) => ({
      operationId: item.operationId,
      status: item.status,
      createdAt: item.createdAt,
      ...(item.prepared === undefined
        ? {}
        : { candidateHeadHash: item.prepared.candidateHeadHash, candidateHead: item.prepared.candidateHead }),
    }));

    const comparisons = (aggregate?.operations ?? [])
      .filter((item) => item.status === 'publishing' && item.prepared !== undefined)
      .map((item) => {
        const prepared = item.prepared as NonNullable<OperationRecord['prepared']>;
        const headMatched = current !== null && current.headHash === prepared.candidateHeadHash;
        const reverted = current !== null && current.headHash === prepared.originalHeadHash;
        const bodiesMatched =
          current !== null &&
          prepared.bodies.every((body) =>
            currentRecords.some((record) => record.path === body.path && record.observedHash === body.contentHash),
          );
        return { operationId: item.operationId, headMatched, bodiesMatched, reverted, diverged: !headMatched && !reverted };
      });

    const guidance = [
      quarantined === null
        ? '实例未隔离；如存在未决操作，先运行 recover 核对，不要直接重发业务命令。'
        : `实例已隔离（${quarantined.reason}）：停止所有命令与回执读取。人工核对资料根与本机数据后，用 local unisolate --confirm offline-reviewed 解除。`,
      '核对顺序：看本报告的 current.headHash 与 comparisons；必要时对比 Git 历史确认资料是否被回退。',
      '隔离解除后先用 recover 核对未决操作；匹配候选会补回执，不匹配会保持待核对。',
    ];

    return { instanceId, quarantined, operations, current, comparisons, issues, guidance };
  }

  private checkEnvelope(envelope: CommandEnvelope): CommandResult | null {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    if (!uuid.test(envelope.operationId)) {
      return { status: 'rejected', code: 'operation-mismatch', message: 'operationId 必须是 UUID v4' };
    }
    if (!uuid.test(envelope.instanceId) || !uuid.test(envelope.projectId)) {
      return { status: 'rejected', code: 'operation-mismatch', message: '项目或实例 id 形态非法' };
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(envelope.expectedPlanVersion)) {
      return { status: 'rejected', code: 'operation-mismatch', message: 'expectedPlanVersion 形态非法' };
    }
    if (!Number.isSafeInteger(envelope.expectedPlanRevision) || envelope.expectedPlanRevision < 0) {
      return { status: 'rejected', code: 'operation-mismatch', message: 'expectedPlanRevision 必须是非负整数' };
    }
    if (!Number.isSafeInteger(envelope.sourceEpoch) || envelope.sourceEpoch < 1) {
      return { status: 'rejected', code: 'operation-mismatch', message: 'sourceEpoch 必须是正整数' };
    }
    if (envelope.command === undefined || typeof envelope.command.type !== 'string') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少命令内容' };
    }
    return null;
  }

  /** 重放：同摘要同归属返回原结果；不同摘要或归属拒绝；未决保持待核对。 */
  private replay(record: OperationRecord, digest: string, origin: OperationOrigin): CommandResult {
    if (record.requestDigest !== digest) {
      return {
        status: 'rejected',
        code: 'operation-mismatch',
        message: '同一 operationId 的请求参数或输入基线已不同；拒绝按新命令执行',
      };
    }
    if (!sameOrigin(record.origin, origin)) {
      return { status: 'rejected', code: 'forbidden', message: '该操作属于其他调用归属' };
    }
    if (record.status === 'committed' && record.result !== undefined) {
      return { status: 'committed', operationId: record.operationId, ...record.result, replayed: true };
    }
    if (record.status === 'rejected' && record.rejection !== undefined) {
      return { status: 'rejected', code: record.rejection.code, message: record.rejection.message, replayed: true };
    }
    return {
      status: 'pending-reconciliation',
      operationId: record.operationId,
      stage: record.status,
      message: `该操作处于 ${record.status} 阶段、尚未完成；先核对实际资料再按恢复流程处理，不按新命令重跑`,
    };
  }

  private async commit(ctx: TrustedContext, envelope: CommandEnvelope): Promise<CommandResult> {
    const root = this.deps.localRoot;
    const quarantine = await this.deps.store.readQuarantine(root, envelope.instanceId);
    if (quarantine !== null) {
      return {
        status: 'rejected',
        code: 'unknown-state',
        message: `该实例已隔离（${quarantine.reason}，阶段 ${quarantine.stage}${
          quarantine.operationId === undefined ? '' : `，保留操作 ${quarantine.operationId}`
        }）；先离线核对再用 local unisolate 解除`,
      };
    }
    const registry = await this.deps.store.readRegistry(root);
    const entry = registry.instances.find((item) => item.instanceId === envelope.instanceId);
    if (entry === undefined) {
      return { status: 'rejected', code: 'binding-expired', message: '本机注册表中没有该实例' };
    }
    if (entry.projectId !== envelope.projectId) {
      return { status: 'rejected', code: 'forbidden', message: '命令的项目 id 与已登记实例不一致' };
    }
    if (entry.sourceGeneration !== envelope.sourceEpoch) {
      return {
        status: 'rejected',
        code: 'source-changed',
        message: `资料源代际已变为 ${entry.sourceGeneration}，命令基线为 ${envelope.sourceEpoch}`,
      };
    }
    let aggregate: InstanceAggregate | null;
    try {
      aggregate = await this.deps.store.readAggregate(root, envelope.instanceId);
    } catch (error) {
      await this.isolate(envelope.instanceId, 'aggregate-unreadable', 'read', undefined, (error as Error).message);
      return {
        status: 'rejected',
        code: 'unknown-state',
        message: '本机聚合不可读；实例已隔离，先用 local diagnostics 核对',
      };
    }
    if (aggregate === null) {
      return { status: 'rejected', code: 'binding-expired', message: '实例聚合缺失；不自动重建' };
    }

    // 幂等查询先于任何新写与规划冲突判断；读取资格已在 execute 校验。
    const origin = originOf(ctx);
    const digest = this.requestDigest(envelope);
    const existing = aggregate.operations.find((item) => item.operationId === envelope.operationId);
    if (existing !== undefined) return this.replay(existing, digest, origin);

    // 同一实例最多一个未决发布意图；未决时阻止后续写入（先核对，不自动续写）。
    const blocked = aggregate.operations.find(
      (item) => item.status === 'prepared' || item.status === 'publishing',
    );
    if (blocked !== undefined) {
      return {
        status: 'pending-reconciliation',
        operationId: blocked.operationId,
        stage: 'instance-blocked',
        message: `该实例存在未决操作 ${blocked.operationId}（${blocked.status}）；先核对实际资料，不接受新命令`,
      };
    }

    if (aggregate.revisions.plan !== envelope.expectedPlanRevision) {
      return {
        status: 'rejected',
        code: 'plan-conflict',
        message: `规划修订已变为 ${aggregate.revisions.plan}，命令基线为 ${envelope.expectedPlanRevision}`,
        current: {
          planVersion: aggregate.lastObservation?.planVersion ?? '(unknown)',
          planRevision: aggregate.revisions.plan,
          sourceEpoch: entry.sourceGeneration,
        },
      };
    }

    // 提交前重读权威资料：不使用内存残留，也不信任命令自报的规划内容。
    const baseline = await readSourceBaseline(this.deps.files, entry.sourceRoot, this.deps.sha256, this.deps.clock);
    if (!baseline.ok) {
      const formatIssue = baseline.issues.some((issue) =>
        ['invalid-schema-version', 'unknown-field', 'invalid-json'].includes(issue.code),
      );
      return {
        status: 'rejected',
        code: formatIssue ? 'unsupported-format' : 'invalid-project',
        message: '提交前重读资料失败，停止该源写入',
        issues: baseline.issues.map((issue) => ({ code: issue.code, path: issue.path ?? '', message: issue.message })),
      };
    }
    if (baseline.baseline.projectId !== envelope.projectId) {
      return { status: 'rejected', code: 'forbidden', message: '磁盘资料的项目 id 与命令不一致' };
    }
    if (baseline.baseline.planVersion !== envelope.expectedPlanVersion) {
      return {
        status: 'rejected',
        code: 'plan-conflict',
        message: '规划的 planVersion 已变化（外部修改或另一写者提交）',
        current: {
          planVersion: baseline.baseline.planVersion,
          planRevision: aggregate.revisions.plan,
          sourceEpoch: entry.sourceGeneration,
        },
      };
    }

    // 稳定生成 id：先落意图，重启或核对时复用同一批 id，不重复创建。
    const generated = this.allocateIds(envelope.command);
    const candidate = this.buildCandidate(envelope.command, baseline.doc, baseline.baseline.records, generated);
    if ('rejected' in candidate) return candidate.rejected;

    const planning = envelope.command.type !== 'append-record';
    const noBusinessChange = planning && candidate.doc.planVersion === baseline.baseline.planVersion;
    const impact: 'plan' | 'state' = noBusinessChange ? 'state' : planning ? 'plan' : 'state';
    const planRevision = impact === 'plan' ? aggregate.revisions.plan + 1 : aggregate.revisions.plan;
    const stateRevision = aggregate.revisions.state + 1;
    const rendered = this.deps.files.renderHead(candidate.doc);
    const result: OperationResultSnapshot = {
      impact,
      planVersion: candidate.doc.planVersion,
      planRevision,
      stateRevision,
      sourceEpoch: entry.sourceGeneration,
      ...(candidate.recordId === undefined ? {} : { recordId: candidate.recordId }),
      ...(candidate.recordPath === undefined ? {} : { recordPath: candidate.recordPath }),
    };
    const now = this.deps.clock();
    const record: OperationRecord = {
      operationId: envelope.operationId,
      requestDigest: digest,
      origin,
      status: 'prepared',
      createdAt: now,
      updatedAt: now,
      baseline: {
        expectedPlanVersion: envelope.expectedPlanVersion,
        expectedPlanRevision: envelope.expectedPlanRevision,
        sourceEpoch: envelope.sourceEpoch,
      },
      generated,
      prepared: {
        candidateHead: rendered.text,
        candidateHeadHash: rendered.headHash,
        originalHeadHash: baseline.baseline.headHash,
        candidatePlanVersion: candidate.doc.planVersion,
        bodies: candidate.bodies,
        impact,
        planRevision,
        stateRevision,
        result,
        writeHead: !noBusinessChange,
      },
    };

    // 阶段 1：prepared（候选头与正文清单先持久化；失败则不发布任何内容）。
    let working: InstanceAggregate = { ...aggregate, operations: [...aggregate.operations, record] };
    const preparedSaved = await this.deps.store.replaceAggregateChecked(root, working, this.deps.hooks?.state);
    if (preparedSaved.status !== 'saved') {
      if (preparedSaved.status === 'unknown-state') {
        await this.isolate(envelope.instanceId, 'unknown-state', 'prepared', envelope.operationId, preparedSaved.detail);
        return {
          status: 'pending-reconciliation',
          operationId: envelope.operationId,
          stage: 'prepared',
          message: 'prepared 意图写入结果未知；实例已隔离，先核对本机数据',
        };
      }
      return {
        status: 'rejected',
        code: 'persistence-failed',
        message: `prepared 意图未能持久化（${preparedSaved.stage}）；不开始发布`,
      };
    }

    // 阶段 2：publishing（明确“可能已开始写文件”，恢复时按候选核对）。
    working = this.withRecord(working, envelope.operationId, (item) => ({ ...item, status: 'publishing', updatedAt: this.deps.clock() }));
    const publishingSaved = await this.deps.store.replaceAggregateChecked(root, working, this.deps.hooks?.state);
    if (publishingSaved.status !== 'saved') {
      if (publishingSaved.status === 'unknown-state') {
        await this.isolate(envelope.instanceId, 'unknown-state', 'publishing', envelope.operationId, publishingSaved.detail);
        return {
          status: 'pending-reconciliation',
          operationId: envelope.operationId,
          stage: 'publishing',
          message: 'publishing 阶段写入结果未知；实例已隔离，先核对资料与本机数据',
        };
      }
      const rejected: RejectedCommand = {
        status: 'rejected',
        code: 'persistence-failed',
        message: `publishing 阶段未能持久化（${publishingSaved.stage}）；未写任何文件`,
      };
      await this.finishRejected(root, working, envelope.operationId, rejected);
      return rejected;
    }

    // 阶段 3：先写不可变正文，再发布资料头。
    for (const body of candidate.bodies) {
      const outcome = await this.deps.files.writeBody(
        entry.sourceRoot,
        body.recordId,
        body.contentHash,
        body.bytesData,
        this.deps.hooks?.body,
      );
      if (outcome.status === 'conflict' || outcome.status === 'not-published') {
        const rejected: RejectedCommand = {
          status: 'rejected',
          code: 'persistence-failed',
          message: `正文写入未完成（${outcome.status}）：${outcome.detail ?? ''}`,
        };
        await this.finishRejected(root, working, envelope.operationId, rejected);
        return rejected;
      }
      if (outcome.status === 'unknown') {
        return {
          status: 'pending-reconciliation',
          operationId: envelope.operationId,
          stage: 'body',
          message: '正文写入结果未知；保留原操作 id，先核对资料根',
        };
      }
    }

    let headHash = baseline.baseline.headHash;
    if (record.prepared?.writeHead !== false) {
      const written = await this.deps.files.writeDocument(entry.sourceRoot, candidate.doc, this.deps.hooks?.publish);
      if (!written.ok) {
        if (written.status === 'unknown') {
          // unknown 不能当作未提交：资料可能已替换，保留 publishing 意图待核对。
          return {
            status: 'pending-reconciliation',
            operationId: envelope.operationId,
            stage: 'head',
            message: '资料头发布结果未知；保留原操作 id，先核对资料根与候选内容',
          };
        }
        const rejected: RejectedCommand = {
          status: 'rejected',
          code: 'persistence-failed',
          message: '资料头发布未完成',
          issues: written.issues,
        };
        await this.finishRejected(root, working, envelope.operationId, rejected);
        return rejected;
      }
      headHash = written.headHash;
    }

    // 阶段 4：完成回执与双修订在同一次聚合替换中保存。
    const receipt: OperationRecord = {
      ...(record as OperationRecord),
      status: 'committed',
      updatedAt: this.deps.clock(),
      result,
    };
    const receiptAggregate: InstanceAggregate = {
      ...working,
      revisions: { plan: planRevision, state: stateRevision },
      lastObservation: {
        planVersion: candidate.doc.planVersion,
        headHash,
        records: candidate.records,
        observedAt: this.deps.clock(),
      },
      operations: this.withRecord(working, envelope.operationId, () => receipt).operations,
    };
    const saved = await this.deps.store.replaceAggregateChecked(root, receiptAggregate, this.deps.hooks?.state);
    if (saved.status === 'not-saved') {
      // 资料已发布、回执未落盘：属于待核对，不能返回“可重试的失败”。
      return {
        status: 'pending-reconciliation',
        operationId: envelope.operationId,
        stage: 'receipt',
        message: `资料已发布但本机回执未保存（${saved.stage}）：${saved.detail ?? ''}；保留原操作 id 核对`,
      };
    }
    if (saved.status === 'unknown-state') {
      await this.isolate(envelope.instanceId, 'unknown-state', 'receipt', envelope.operationId, saved.detail);
      return {
        status: 'pending-reconciliation',
        operationId: envelope.operationId,
        stage: 'local-state',
        message: '资料已发布，本机聚合写入结果未知；实例已隔离，先离线核对再解除',
      };
    }

    const committed: CommittedCommand = { status: 'committed', operationId: envelope.operationId, ...result };
    // 通知在提交之后：失败不撤回事实，也不改变返回结果。
    if (this.deps.notify !== undefined) {
      try {
        await this.deps.notify(committed);
      } catch {
        // 通知失败不回滚、不重复执行。
      }
    }
    return committed;
  }

  private withRecord(
    aggregate: InstanceAggregate,
    operationId: string,
    update: (record: OperationRecord) => OperationRecord,
  ): InstanceAggregate {
    return {
      ...aggregate,
      operations: aggregate.operations.map((item) => (item.operationId === operationId ? update(item) : item)),
    };
  }

  /** 明确拒绝也要留回执：重试同一 operationId 不得重新执行。 */
  private async finishRejected(
    root: string,
    aggregate: InstanceAggregate,
    operationId: string,
    rejected: RejectedCommand,
  ): Promise<void> {
    const now = this.deps.clock();
    const next = this.withRecord(aggregate, operationId, (item) => ({
      ...item,
      status: 'rejected',
      updatedAt: now,
      rejection: { code: rejected.code, message: rejected.message },
    }));
    // 回执写入失败不改变“明确拒绝”的事实：没有发布任何内容，重试仍是安全的。
    await this.deps.store.replaceAggregateChecked(root, next, this.deps.hooks?.state);
  }

  /**
   * 构造候选文档与待写正文（不写文件）。
   * 记录命令在此计算哈希与路径，正文实际写入发生在 publishing 阶段之后。
   */
  private buildCandidate(
    command: Command,
    doc: ProjectDocument,
    baselineRecords: { path: string; contentHash: string; observedHash: string }[],
    generated: { recordId?: string; nodeIds?: string[] },
  ):
    | {
        doc: ProjectDocument;
        records: typeof baselineRecords;
        bodies: { recordId: string; contentHash: string; path: string; bytes: number; bytesData: Uint8Array }[];
        recordId?: string;
        recordPath?: string;
      }
    | { rejected: RejectedCommand } {
    if (command.type !== 'append-record') {
      const applied = applyPlanCommand(doc, this.materialize(command, generated.nodeIds ?? []), this.deps.sha256);
      if (!applied.ok) {
        return {
          rejected: {
            status: 'rejected',
            code: 'invalid-project',
            message: '命令变换未通过领域校验',
            issues: applied.issues,
          },
        };
      }
      return { doc: applied.doc, records: baselineRecords, bodies: [] };
    }

    const bytesData = new TextEncoder().encode(command.body);
    const contentHash = 'sha256:' + this.deps.sha256(bytesData);
    const id = generated.recordId ?? this.deps.newRecordId();
    const recordPath = `records/${id}/${contentHash.slice('sha256:'.length)}.md`;
    const appended = appendRecordIndex(doc.records, {
      id,
      kind: command.kind,
      subjectNodeIds: [...command.subjectNodeIds],
      path: recordPath,
      contentHash,
      summary: command.summary,
      sources: command.sources.map((source) => (typeof source === 'string' ? source : { ...source })),
      ...(command.verification === undefined ? {} : { verification: command.verification }),
    });
    if (!appended.ok) {
      return {
        rejected: { status: 'rejected', code: 'invalid-project', message: '记录索引追加失败', issues: appended.issues },
      };
    }
    const validated = validateProjectDocument({ ...doc, records: appended.value }, { sha256: this.deps.sha256 });
    if (!validated.ok) {
      return {
        rejected: { status: 'rejected', code: 'invalid-project', message: '记录未通过领域校验', issues: validated.issues },
      };
    }
    return {
      doc: validated.doc,
      records: [...baselineRecords, { path: recordPath, contentHash, observedHash: contentHash }],
      bodies: [{ recordId: id, contentHash, path: recordPath, bytes: bytesData.length, bytesData }],
      recordId: id,
      recordPath,
    };
  }

  private allocateIds(command: Command): { recordId?: string; nodeIds?: string[] } {
    if (command.type === 'append-record') return { recordId: this.deps.newRecordId() };
    if (command.type === 'add-nodes') return { nodeIds: command.nodes.map(() => this.deps.newNodeId()) };
    if (command.type === 'split-node') return { nodeIds: command.children.map(() => this.deps.newNodeId()) };
    return {};
  }

  /** 新节点 id 由应用层生成并已在意图中固定；命令不能指定 id 覆盖旧节点。 */
  private materialize(command: PlanningCommand, allocated: string[]): PlanCommand {
    let cursor = 0;
    const nextId = (): string => allocated[cursor++] ?? this.deps.newNodeId();
    const toNode = (input: NewNodeInput, parentOverride?: string | null): WorkNode => ({
      id: nextId(),
      parentId: parentOverride === undefined ? input.parentId : parentOverride,
      order: input.order,
      title: input.title,
      goal: input.goal,
      completionCriteria: [...input.completionCriteria],
      status: input.status ?? 'todo',
    });
    switch (command.type) {
      case 'add-nodes':
        return { type: 'add-nodes', nodes: command.nodes.map((node) => toNode(node)) };
      case 'split-node':
        return {
          type: 'split-node',
          parentId: command.parentId,
          children: command.children.map((child) => toNode({ ...child, parentId: command.parentId }, command.parentId)),
        };
      default:
        return command;
    }
  }
}
