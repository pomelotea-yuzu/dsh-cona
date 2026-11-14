// 规划与记录命令封套（tasks 4.1，design §5–§6）。
// 本文件负责：可信入口校验、每实例提交队列、提交前重读权威资料、不可变变换、三态发布与双修订推进。
// 未包含（4.2–4.5）：幂等意图／回执、prepared／publishing／committed 阶段、unknown-state 隔离。

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

export type CommandResult =
  | {
      status: 'committed';
      operationId: string;
      impact: 'plan' | 'state';
      planVersion: string;
      planRevision: number;
      stateRevision: number;
      sourceEpoch: number;
      recordId?: string;
      /** 记录命令写入的正文协议路径。 */
      recordPath?: string;
    }
  | {
      status: 'rejected';
      code: string;
      message: string;
      issues?: ValidationIssue[];
      current?: CommandCurrent;
    }
  | { status: 'pending-reconciliation'; operationId: string; stage: string; message: string };

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
  hooks?: { publish?: PublishHooksPort; body?: PublishHooksPort };
}

/** 规划命令（除记录追加外的五类）。 */
type PlanningCommand = Exclude<Command, AppendRecordCommand>;

/** 稳定拒绝码（design §5）。 */
export type CommandErrorCode =
  | 'forbidden'
  | 'binding-expired'
  | 'source-changed'
  | 'plan-conflict'
  | 'invalid-project'
  | 'unsupported-format'
  | 'operation-mismatch'
  | 'persistence-failed'
  | 'unknown-state';

type AuthorizeResult = { ok: true } | { ok: false; code: CommandErrorCode; message: string };

/**
 * 入口校验：
 * - UI Remote 由宿主生成真实 owner invocation，适配器判定后传 `remote-owner`；
 * - 工具由真实 ToolRunContext 判定后传 `agent-work`，必须带实际 WorkRun 与绑定版本。
 * 缺上下文不降级为进程内 owner；伪造字段不能借业务参数获得资格。
 */
export function authorizeTrustedContext(ctx: TrustedContext | undefined, envelope: CommandEnvelope): AuthorizeResult {
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
    if (ctx.instanceId !== envelope.instanceId) {
      return { ok: false, code: 'forbidden', message: '绑定实例与命令实例不一致' };
    }
    return { ok: true };
  }
  return { ok: false, code: 'forbidden', message: '未知入口类型' };
}

export class ProjectCommandService {
  private readonly queue: InstanceCommandQueue;

  constructor(private readonly deps: ProjectCommandDeps) {
    this.queue = deps.queue ?? new InstanceCommandQueue();
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
    return this.queue.run(envelope.instanceId, () => this.commit(envelope));
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

  private async commit(envelope: CommandEnvelope): Promise<CommandResult> {
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

    const prepared = await this.prepare(envelope, baseline.doc, baseline.baseline.records, entry.sourceRoot);
    if ('rejected' in prepared) return prepared.rejected;
    if ('pending' in prepared) return prepared.pending;

    const impact: 'plan' | 'state' = envelope.command.type === 'append-record' ? 'state' : 'plan';
    const nextPlanRevision = impact === 'plan' ? aggregate.revisions.plan + 1 : aggregate.revisions.plan;
    const nextStateRevision = aggregate.revisions.state + 1;

    const nextAggregate = {
      ...aggregate,
      revisions: { plan: nextPlanRevision, state: nextStateRevision },
      lastObservation: {
        planVersion: prepared.doc.planVersion,
        headHash: prepared.headHash,
        records: prepared.records,
        observedAt: this.deps.clock(),
      },
    };
    const saved = await this.deps.store.replaceAggregateChecked(root, nextAggregate);
    if (saved.status === 'not-saved') {
      return {
        status: 'rejected',
        code: 'persistence-failed',
        message: `资料已发布但本机记录未保存（${saved.stage}）：${saved.detail ?? ''}`,
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

    return {
      status: 'committed',
      operationId: envelope.operationId,
      impact,
      planVersion: prepared.doc.planVersion,
      planRevision: nextPlanRevision,
      stateRevision: nextStateRevision,
      sourceEpoch: entry.sourceGeneration,
      ...(prepared.recordId === undefined ? {} : { recordId: prepared.recordId }),
      ...(prepared.recordPath === undefined ? {} : { recordPath: prepared.recordPath }),
    };
  }

  /**
   * 构造候选文档并按顺序发布：先正文（若有）、再资料头。
   * 返回三种结局：候选就绪、明确拒绝、结果未知。
   */
  private async prepare(
    envelope: CommandEnvelope,
    doc: ProjectDocument,
    baselineRecords: { path: string; contentHash: string; observedHash: string }[],
    sourceRoot: string,
  ): Promise<
    | { doc: ProjectDocument; headHash: string; records: typeof baselineRecords; recordId?: string; recordPath?: string }
    | { rejected: CommandResult }
    | { pending: CommandResult }
  > {
    const command = envelope.command;
    let candidate = doc;
    let records = baselineRecords;
    let recordId: string | undefined;
    let recordPath: string | undefined;

    if (command.type !== 'append-record') {
      const applied = applyPlanCommand(doc, this.materialize(command), this.deps.sha256);
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
      candidate = applied.doc;
    } else {
      const bodyBytes = new TextEncoder().encode(command.body);
      const contentHash = 'sha256:' + this.deps.sha256(bodyBytes);
      const id = this.deps.newRecordId();
      const path = `records/${id}/${contentHash.slice('sha256:'.length)}.md`;
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
          pending: {
            status: 'pending-reconciliation',
            operationId: envelope.operationId,
            stage: 'body',
            message: '正文写入结果未知；保留原操作 id，先核对资料根',
          },
        };
      }

      const appended = appendRecordIndex(doc.records, {
        id,
        kind: command.kind,
        subjectNodeIds: [...command.subjectNodeIds],
        path,
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
      candidate = { ...doc, records: appended.value };
      // 记录命令同样过完整校验：受检对象、来源与完成条件都不能只靠形状检查。
      const validated = validateProjectDocument(candidate, { sha256: this.deps.sha256 });
      if (!validated.ok) {
        return {
          rejected: { status: 'rejected', code: 'invalid-project', message: '记录未通过领域校验', issues: validated.issues },
        };
      }
      candidate = validated.doc;
      records = [...baselineRecords, { path, contentHash, observedHash: contentHash }];
      recordId = id;
      recordPath = path;
      // records 不参与规划投影：planVersion 保持不变。
    }

    const written = await this.deps.files.writeDocument(sourceRoot, candidate, this.deps.hooks?.publish);
    if (!written.ok) {
      // unknown 不能当作未提交：资料可能已替换，必须保留原操作 id 待核对。
      if (written.status === 'unknown') {
        return {
          pending: {
            status: 'pending-reconciliation',
            operationId: envelope.operationId,
            stage: 'head',
            message: '资料头发布结果未知；保留原操作 id，先核对资料根与候选内容',
          },
        };
      }
      return {
        rejected: {
          status: 'rejected',
          code: 'persistence-failed',
          message: '资料头发布未完成',
          issues: written.issues,
        },
      };
    }
    return { doc: candidate, headHash: written.headHash, records, ...(recordId === undefined ? {} : { recordId }), ...(recordPath === undefined ? {} : { recordPath }) };
  }

  /** 新节点 id 由应用层生成；命令只描述结构，不能指定 id 覆盖旧节点。 */
  private materialize(command: PlanningCommand): PlanCommand {
    const toNode = (input: NewNodeInput, parentOverride?: string | null): WorkNode => ({
      id: this.deps.newNodeId(),
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
