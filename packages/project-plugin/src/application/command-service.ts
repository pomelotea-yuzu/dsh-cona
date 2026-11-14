// 规划与记录命令封套（tasks 4.1／4.2，design §5–§6）。
// 本文件负责：可信入口校验、每实例提交队列、提交前重读、不可变变换、三态发布、双修订推进，
// 以及 (instanceId, operationId) 幂等：先写 pending 意图、完成后写回执，重试返回原结果。
// 未包含（4.3–4.5）：prepared／publishing 阶段、崩溃后候选核对、unknown-state 隔离。

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
import type { InstanceAggregate, OperationOrigin, OperationRecord, OperationResultSnapshot } from './local-state.js';
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
    const aggregate = await this.deps.store.readAggregate(this.deps.localRoot, request.instanceId);
    if (aggregate === null) return { status: 'not-found' };
    const record = aggregate.operations.find((item) => item.operationId === request.operationId);
    if (record === undefined) return { status: 'not-found' };
    const origin = originOf(ctx as TrustedContext);
    if (!sameOrigin(record.origin, origin)) {
      return { status: 'rejected', code: 'forbidden', message: '该回执属于其他调用归属，不提供正文或结果' };
    }
    return this.replay(record, record.requestDigest, origin);
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
      stage: 'intent',
      message: '该操作已有未决意图；核对实际资料后再处理，不按新命令重跑',
    };
  }

  private async commit(ctx: TrustedContext, envelope: CommandEnvelope): Promise<CommandResult> {
    const root = this.deps.localRoot;
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
    const aggregate = await this.deps.store.readAggregate(root, envelope.instanceId);
    if (aggregate === null) {
      return { status: 'rejected', code: 'binding-expired', message: '实例聚合缺失；不自动重建' };
    }

    // 幂等查询先于任何新写与规划冲突判断；读取资格已在 execute 校验。
    const origin = originOf(ctx);
    const digest = this.requestDigest(envelope);
    const existing = aggregate.operations.find((item) => item.operationId === envelope.operationId);
    if (existing !== undefined) return this.replay(existing, digest, origin);

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
    const now = this.deps.clock();
    const intent: OperationRecord = {
      operationId: envelope.operationId,
      requestDigest: digest,
      origin,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      baseline: {
        expectedPlanVersion: envelope.expectedPlanVersion,
        expectedPlanRevision: envelope.expectedPlanRevision,
        sourceEpoch: envelope.sourceEpoch,
      },
      generated,
    };
    const intentAggregate: InstanceAggregate = { ...aggregate, operations: [...aggregate.operations, intent] };
    const intentSaved = await this.deps.store.replaceAggregateChecked(root, intentAggregate, this.deps.hooks?.state);
    if (intentSaved.status !== 'saved') {
      return {
        status: 'rejected',
        code: 'persistence-failed',
        message: `意图未能明确持久化（${intentSaved.stage}）；不开始资料发布`,
      };
    }

    const prepared = await this.prepare(
      envelope.command,
      baseline.doc,
      baseline.baseline.records,
      entry.sourceRoot,
      generated,
    );
    if ('rejected' in prepared) {
      await this.finishRejected(root, intentAggregate, envelope.operationId, prepared.rejected);
      return prepared.rejected;
    }
    if ('pending' in prepared) {
      return {
        status: 'pending-reconciliation',
        operationId: envelope.operationId,
        stage: prepared.pending.stage,
        message: prepared.pending.message,
      };
    }

    const planning = envelope.command.type !== 'append-record';
    const noBusinessChange = planning && prepared.doc.planVersion === baseline.baseline.planVersion;
    let headHash = baseline.baseline.headHash;
    if (!noBusinessChange) {
      const written = await this.deps.files.writeDocument(entry.sourceRoot, prepared.doc, this.deps.hooks?.publish);
      if (!written.ok) {
        if (written.status === 'unknown') {
          // unknown 不能当作未提交：资料可能已替换，必须保留原操作 id 待核对。
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
        await this.finishRejected(root, intentAggregate, envelope.operationId, rejected);
        return rejected;
      }
      headHash = written.headHash;
    }

    // 无业务变化：首次仅保存回执并推进状态修订（不改规划修订，也不重写资料头）。
    const impact: 'plan' | 'state' = noBusinessChange ? 'state' : planning ? 'plan' : 'state';
    const nextPlanRevision = impact === 'plan' ? aggregate.revisions.plan + 1 : aggregate.revisions.plan;
    const nextStateRevision = aggregate.revisions.state + 1;

    const result: OperationResultSnapshot = {
      impact,
      planVersion: prepared.doc.planVersion,
      planRevision: nextPlanRevision,
      stateRevision: nextStateRevision,
      sourceEpoch: entry.sourceGeneration,
      ...(prepared.recordId === undefined ? {} : { recordId: prepared.recordId }),
      ...(prepared.recordPath === undefined ? {} : { recordPath: prepared.recordPath }),
    };
    const receipt: OperationRecord = { ...intent, status: 'committed', updatedAt: this.deps.clock(), result };
    const receiptAggregate: InstanceAggregate = {
      ...intentAggregate,
      revisions: { plan: nextPlanRevision, state: nextStateRevision },
      lastObservation: {
        planVersion: prepared.doc.planVersion,
        headHash,
        records: prepared.records,
        observedAt: this.deps.clock(),
      },
      operations: intentAggregate.operations.map((item) =>
        item.operationId === envelope.operationId ? receipt : item,
      ),
    };
    const saved = await this.deps.store.replaceAggregateChecked(root, receiptAggregate, this.deps.hooks?.state);
    if (saved.status === 'not-saved') {
      return {
        status: 'rejected',
        code: 'persistence-failed',
        message: `资料已发布但本机回执未保存（${saved.stage}）：${saved.detail ?? ''}`,
      };
    }
    if (saved.status === 'unknown-state') {
      return {
        status: 'pending-reconciliation',
        operationId: envelope.operationId,
        stage: 'local-state',
        message: '资料已发布，本机聚合写入结果未知；不要换 id 重试，先核对本机数据',
      };
    }

    return { status: 'committed', operationId: envelope.operationId, ...result };
  }

  /** 明确拒绝也要留回执：重试同一 operationId 不得重新执行。 */
  private async finishRejected(
    root: string,
    aggregate: InstanceAggregate,
    operationId: string,
    rejected: RejectedCommand,
  ): Promise<void> {
    const now = this.deps.clock();
    const next: InstanceAggregate = {
      ...aggregate,
      operations: aggregate.operations.map((item) =>
        item.operationId === operationId
          ? {
              ...item,
              status: 'rejected' as const,
              updatedAt: now,
              rejection: { code: rejected.code, message: rejected.message },
            }
          : item,
      ),
    };
    // 回执写入失败不改变“明确拒绝”的事实：没有发布任何内容，重试仍是安全的。
    await this.deps.store.replaceAggregateChecked(root, next);
  }

  /**
   * 构造候选文档。记录命令先写不可变正文；规划命令只做变换。
   * 发布资料头由 commit 统一处理（无业务变化时不重写）。
   */
  private async prepare(
    command: Command,
    doc: ProjectDocument,
    baselineRecords: { path: string; contentHash: string; observedHash: string }[],
    sourceRoot: string,
    generated: { recordId?: string; nodeIds?: string[] },
  ): Promise<
    | { doc: ProjectDocument; records: typeof baselineRecords; recordId?: string; recordPath?: string }
    | { rejected: RejectedCommand }
    | { pending: { stage: string; message: string } }
  > {
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
      return { doc: applied.doc, records: baselineRecords };
    }

    const bodyBytes = new TextEncoder().encode(command.body);
    const contentHash = 'sha256:' + this.deps.sha256(bodyBytes);
    const id = generated.recordId ?? this.deps.newRecordId();
    const recordPath = `records/${id}/${contentHash.slice('sha256:'.length)}.md`;
    const body: BodyWriteOutcome = await this.deps.files.writeBody(
      sourceRoot,
      id,
      contentHash,
      bodyBytes,
      this.deps.hooks?.body,
    );
    if (body.status === 'conflict' || body.status === 'not-published') {
      return {
        rejected: {
          status: 'rejected',
          code: 'persistence-failed',
          message: `正文写入未完成（${body.status}）：${body.detail ?? ''}`,
        },
      };
    }
    if (body.status === 'unknown') {
      return {
        pending: { stage: 'body', message: '正文写入结果未知；保留原操作 id，先核对资料根' },
      };
    }

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
