// 完整快照与“先订阅再回读”协议（tasks 5.1，design §8）。
//
// 一致性规则（不输出半新半旧快照）：
// 1. 先读本机聚合拿到修订，再读资料头与全部引用正文并逐条复核哈希，最后再读一次本机聚合；
// 2. 两次聚合读取之间修订、源代际必须不变，否则重读（读取中变更时以磁盘为准，不混两版）；
// 3. 存在 prepared／publishing 未决发布时不产生“已保存”快照（发布结果未定）；
// 4. 已知最高修订（订阅水位）或调用方下限高于本机修订时继续追读，直到覆盖或达到重试上限；
// 5. 重试耗尽仍无法取得一致结果时返回 `unsynced`，不返回树。
//
// 同步状态：磁盘头与本机最近观察不一致（外部编辑未刷新）时，仍返回一份磁盘一致内容，
// 但明确标 `not-synced(source-drift)`，面板不得据此显示“已保存”。

import type {
  DependencyEdge,
  ProjectDocument,
  ProjectMeta,
  RecordIndexEntry,
  Sha256Fn,
  ValidationIssue,
  WorkNode,
} from '../domain/types.js';
import { NODE_STATUSES, RECORD_KINDS } from '../domain/types.js';
import { readSourceBaseline } from './baseline.js';
import type { ChangeStreamPort } from './change-stream.js';
import { checkTrustedContext, type TrustedContext } from './command-service.js';
import type { InstanceAggregate, QuarantineInfo, RegistryEntry } from './local-state.js';
import type { LocationKind } from './location.js';
import type { LocalStateStorePort, SourceFilesPort } from './ports.js';

/** 树与规划摘要：同一快照派生，供面板与未来路线图共用基础数据。 */
export interface PlanSummary {
  nodeCount: number;
  rootCount: number;
  maxDepth: number;
  statusCounts: Record<string, number>;
  dependencyCount: number;
  recordCount: number;
  recordsByKind: Record<string, number>;
}

export interface SnapshotSync {
  status: 'synced' | 'not-synced';
  /** 仅 `not-synced` 时出现。 */
  reason?: 'source-drift';
  /** true 表示必须先显式刷新才能继续写入。 */
  requiresRefresh: boolean;
  /**
   * `local-observation`：磁盘头与本机最近观察一致；
   * `current-read`：本机尚无观察基线（登记后未刷新），本次读取即为当前事实，但不构成已验收基线。
   */
  basis: 'local-observation' | 'current-read';
}

/** 完整快照：一次读取内的权威内容 + 本机修订 + 同步状态。 */
export interface ProjectSnapshot {
  projectId: string;
  instanceId: string;
  sourceEpoch: number;
  schemaVersion: number;
  planVersion: string;
  planRevision: number;
  stateRevision: number;
  /** 请求携带的连接代际，原样回传；客户端先核对代际再核对单调修订。 */
  connectionGeneration: number;
  sync: SnapshotSync;
  /** 资料位置展示（来源种类 + 折叠 home 的显示路径）；面板只展示，不改位置。 */
  source: { kind: LocationKind; displayPath: string };
  project: ProjectMeta;
  /** 完整小树：父节点先于子节点，同级按 order、id 排序。 */
  tree: WorkNode[];
  /** 依赖边（规划的一部分；摘要的 dependencyCount 与它同源）。 */
  dependencies: DependencyEdge[];
  /** 完整记录索引（不含正文；正文按需读取）。 */
  records: RecordIndexEntry[];
  summary: PlanSummary;
  local: {
    /** 本机聊天关联数量（R1 面板只显示数量；关系本身属第 6 段）。 */
    conversationCount: number;
    /** 本机 WorkRun 历史数量。 */
    workRunCount: number;
    quarantined: QuarantineInfo | null;
  };
  readAt: string;
}

export interface SnapshotReadRequest {
  instanceId: string;
  connectionGeneration: number;
  /** 订阅 ready／通知给出的最高修订；读取必须至少覆盖它。 */
  minStateRevision?: number;
}

export type SnapshotResult =
  | { status: 'snapshot'; snapshot: ProjectSnapshot }
  | {
      status: 'unsynced';
      reason: 'unstable' | 'pending-operation' | 'source-replaced';
      attempts: number;
      detail: string;
    }
  | { status: 'rejected'; code: string; message: string; issues?: ValidationIssue[] };

export interface FollowRequest {
  instanceId: string;
  /** 客户端已见最高修订（重连时带上，ready 至少报到这个水位）。 */
  afterStateRevision?: number;
}

export type FollowResult =
  | {
      status: 'following';
      connectionGeneration: number;
      /** 订阅已建立：客户端收到 ready 后才回读快照。 */
      ready: StreamEventView;
      events: AsyncIterable<StreamEventView>;
      close(): void;
    }
  | { status: 'rejected'; code: string; message: string };

/** follow 事件视图（与 change-stream 的 StreamEvent 同形，避免应用层外泄内部类型）。 */
export interface StreamEventView {
  kind: 'ready' | 'committed' | 'rejected' | 'refreshed' | 'source-replaced';
  instanceId: string;
  projectId: string;
  sourceEpoch: number;
  stateRevision: number;
  planRevision: number;
  connectionGeneration: number;
  operationId?: string;
  at: string;
  detail?: string;
}

export interface SnapshotHooks {
  /** 在第 n 次尝试读取资料头之前调用（测试注入并发变更）。 */
  beforeBaselineRead?: (attempt: number) => void | Promise<void>;
  /** 在第 n 次尝试的第二次本机聚合读取之前调用（测试注入读取中提交）。 */
  beforeSecondAggregateRead?: (attempt: number) => void | Promise<void>;
}

export interface SnapshotDeps {
  localRoot: string;
  store: LocalStateStorePort;
  files: SourceFilesPort;
  sha256: Sha256Fn;
  clock: () => string;
  stream: ChangeStreamPort;
  /** 资料根显示路径（home 折叠）；缺省时原样返回绝对路径。 */
  describeLocation?: (root: string) => { displayPath: string };
  /** 一致读取的最大尝试次数；默认 4。 */
  maxAttempts?: number;
  hooks?: SnapshotHooks;
}

/** 资源外错误：本机聚合不可读时以稳定码返回，不抛裸异常。 */
function rejection(code: string, message: string, issues?: ValidationIssue[]): SnapshotResult {
  return issues === undefined
    ? { status: 'rejected', code, message }
    : { status: 'rejected', code, message, issues };
}

/** 基线失败里可直接透出的码：调用方需要区分“正文不符”与“结构非法”。 */
const KEEP_BASELINE_CODES = new Set(['body-hash-mismatch', 'body-missing', 'source-conflict-markers']);

/** 按父节点分组的深度优先排序；同级按 order、id 升序。数据已由领域校验保证无环，仍防重入。 */
export function orderTree(nodes: readonly WorkNode[]): WorkNode[] {
  const children = new Map<string | null, WorkNode[]>();
  for (const node of nodes) {
    const key = node.parentId;
    const bucket = children.get(key) ?? [];
    bucket.push(node);
    children.set(key, bucket);
  }
  for (const bucket of children.values()) {
    bucket.sort((a, b) => (a.order === b.order ? a.id.localeCompare(b.id) : a.order - b.order));
  }
  const out: WorkNode[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number): void => {
    for (const node of children.get(parentId) ?? []) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      out.push({ ...node, completionCriteria: [...node.completionCriteria] });
      walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  // 父节点不存在的节点不会在 DFS 中出现（领域校验会拒绝），此处不静默补造父子关系。
  return out;
}

/** 从同一份树与记录索引派生摘要：不接受另一份数据来源，避免“摘要与树不一致”。 */
export function summarizePlan(
  tree: readonly WorkNode[],
  dependencies: readonly DependencyEdge[],
  records: readonly RecordIndexEntry[],
): PlanSummary {
  const statusCounts: Record<string, number> = {};
  for (const status of NODE_STATUSES) statusCounts[status] = 0;
  const recordsByKind: Record<string, number> = {};
  for (const kind of RECORD_KINDS) recordsByKind[kind] = 0;

  const depthOf = new Map<string, number>();
  let maxDepth = 0;
  let rootCount = 0;
  for (const node of tree) {
    statusCounts[node.status] = (statusCounts[node.status] ?? 0) + 1;
    if (node.parentId === null) rootCount += 1;
    const depth = node.parentId === null ? 1 : (depthOf.get(node.parentId) ?? 0) + 1;
    depthOf.set(node.id, depth);
    if (depth > maxDepth) maxDepth = depth;
  }
  for (const record of records) recordsByKind[record.kind] = (recordsByKind[record.kind] ?? 0) + 1;

  return {
    nodeCount: tree.length,
    rootCount,
    maxDepth,
    statusCounts,
    dependencyCount: dependencies.length,
    recordCount: records.length,
    recordsByKind,
  };
}

function copyRecords(records: readonly RecordIndexEntry[]): RecordIndexEntry[] {
  return records.map((record) => ({
    ...record,
    subjectNodeIds: [...record.subjectNodeIds],
    sources: record.sources.map((source) => (typeof source === 'string' ? source : { ...source })),
    ...(record.verification === undefined ? {} : { verification: { ...record.verification } }),
  }));
}

/** 极简异步队列：把订阅回调转成 AsyncIterable，供 Host 映射为 RemoteStream。 */
class EventQueue implements AsyncIterable<StreamEventView> {
  private readonly buffer: StreamEventView[] = [];
  private readonly waiters: ((result: IteratorResult<StreamEventView>) => void)[] = [];
  private ended = false;

  push(event: StreamEventView): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.buffer.push(event);
    else waiter({ value: event, done: false });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true } as IteratorResult<StreamEventView>);
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEventView> {
    return {
      next: (): Promise<IteratorResult<StreamEventView>> => {
        const buffered = this.buffer.shift();
        if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true } as IteratorResult<StreamEventView>);
        return new Promise<IteratorResult<StreamEventView>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
      return: (): Promise<IteratorResult<StreamEventView>> => {
        this.end();
        return Promise.resolve({ value: undefined, done: true } as IteratorResult<StreamEventView>);
      },
    };
  }
}

export class ProjectSnapshotService {
  constructor(private readonly deps: SnapshotDeps) {}

  /**
   * 完整快照查询：一致读取 + 追读已知最高修订。
   * 访问判据与命令入口同规则（UI Remote／工具分别判定），不因只读而放宽。
   */
  async read(ctx: TrustedContext | undefined, request: SnapshotReadRequest): Promise<SnapshotResult> {
    const authorized = checkTrustedContext(ctx);
    if (!authorized.ok) return rejection(authorized.code, authorized.message);
    if (ctx !== undefined && ctx.kind === 'agent-work' && ctx.instanceId !== request.instanceId) {
      return rejection('forbidden', '绑定实例与快照请求实例不一致');
    }
    if (typeof request.instanceId !== 'string' || request.instanceId === '') {
      return rejection('operation-mismatch', '缺少实例 id');
    }
    if (!Number.isSafeInteger(request.connectionGeneration) || request.connectionGeneration < 0) {
      return rejection('operation-mismatch', 'connectionGeneration 必须是非负整数');
    }
    if (
      request.minStateRevision !== undefined &&
      (!Number.isSafeInteger(request.minStateRevision) || request.minStateRevision < 0)
    ) {
      return rejection('operation-mismatch', 'minStateRevision 必须是非负整数');
    }

    // 迟到的旧代际请求：先核对代际再读任何内容。
    const latest = this.deps.stream.latestGeneration(request.instanceId);
    if (latest !== null && request.connectionGeneration < latest) {
      return rejection(
        'stale-connection',
        `连接代际 ${request.connectionGeneration} 已被 ${latest} 取代；请按新代际重新订阅后回读`,
      );
    }

    const root = this.deps.localRoot;
    const quarantined = await this.deps.store.readQuarantine(root, request.instanceId);
    if (quarantined !== null) {
      return rejection(
        'unknown-state',
        `该实例已隔离（${quarantined.reason}，阶段 ${quarantined.stage}）；只提供只读诊断，不提供快照`,
      );
    }

    const registry = await this.deps.store.readRegistry(root);
    const entry = registry.instances.find((item) => item.instanceId === request.instanceId);
    if (entry === undefined) return rejection('binding-expired', '本机注册表中没有该实例');

    const maxAttempts = this.deps.maxAttempts ?? 4;
    let lastReason: 'unstable' | 'pending-operation' | 'source-replaced' = 'unstable';
    let lastDetail = '读取期间状态持续变化';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const first = await this.readAggregate(request.instanceId);
      if ('code' in first) return rejection(first.code, first.message);
      const before = first.aggregate;

      await this.deps.hooks?.beforeBaselineRead?.(attempt);

      const baseline = await readSourceBaseline(this.deps.files, entry.sourceRoot, this.deps.sha256, this.deps.clock);
      if (!baseline.ok) {
        // 混合资料（头与正文不是同一版）一律拒绝，不返回半截快照。
        const formatIssue = baseline.issues.some((issue) =>
          ['invalid-schema-version', 'unknown-field', 'invalid-json'].includes(issue.code),
        );
        // 正文与头不一致等可定位原因保留原码，避免被笼统的 invalid-project 掩盖。
        const specific = baseline.issues[0]?.code;
        const code = formatIssue
          ? 'unsupported-format'
          : specific !== undefined && KEEP_BASELINE_CODES.has(specific)
            ? specific
            : 'invalid-project';
        return rejection(
          code,
          '资料不可读或引用正文不一致；拒绝返回半截快照',
          baseline.issues.map((issue) => ({ code: issue.code, path: issue.path ?? '', message: issue.message })),
        );
      }
      if (baseline.baseline.projectId !== entry.projectId) {
        return rejection('forbidden', '磁盘资料的项目 id 与本机实例不一致');
      }

      await this.deps.hooks?.beforeSecondAggregateRead?.(attempt);

      const second = await this.readAggregate(request.instanceId);
      if ('code' in second) return rejection(second.code, second.message);
      const after = second.aggregate;

      if (after.projectId !== entry.projectId) return rejection('forbidden', '本机聚合的项目 id 与注册表不一致');
      if (
        after.revisions.state !== before.revisions.state ||
        after.revisions.plan !== before.revisions.plan ||
        after.source.generation !== before.source.generation
      ) {
        lastReason = 'unstable';
        lastDetail = '两次读取之间修订或源代际发生变化；已重读';
        continue;
      }
      if (entry.sourceGeneration !== after.source.generation) {
        lastReason = 'source-replaced';
        lastDetail = '读取期间源代际被替换；按新代际重新订阅后再读';
        continue;
      }
      const pending = after.operations.find((item) => item.status === 'prepared' || item.status === 'publishing');
      if (pending !== undefined) {
        // 发布尚未落定：此时不能声称“已保存”。
        lastReason = 'pending-operation';
        lastDetail = `存在未决发布 ${pending.operationId}（${pending.status}）`;
        continue;
      }

      const known = this.deps.stream.highestKnown(request.instanceId);
      if (known !== null) {
        if (known.sourceEpoch > after.source.generation) {
          lastReason = 'source-replaced';
          lastDetail = '订阅水位已进入新源代际；按新描述符重新订阅后再读';
          continue;
        }
        if (known.sourceEpoch === after.source.generation && known.stateRevision > after.revisions.state) {
          lastReason = 'unstable';
          lastDetail = `订阅已知修订 ${known.stateRevision} 高于本机 ${after.revisions.state}；继续追读`;
          continue;
        }
      }
      if (request.minStateRevision !== undefined && after.revisions.state < request.minStateRevision) {
        lastReason = 'unstable';
        lastDetail = `本机修订 ${after.revisions.state} 尚未覆盖请求下限 ${request.minStateRevision}；继续追读`;
        continue;
      }

      return { status: 'snapshot', snapshot: this.build(entry, after, baseline.doc, baseline.baseline.headHash, request, quarantined) };
    }

    return { status: 'unsynced', reason: lastReason, attempts: maxAttempts, detail: lastDetail };
  }

  /**
   * 订阅：建立失效流并立即返回 ready。
   * 客户端顺序固定为 follow → 收到 ready → snapshot(minStateRevision = ready.stateRevision)；
   * 通知只是失效信号，内容一律以快照为准。
   */
  async follow(ctx: TrustedContext | undefined, request: FollowRequest): Promise<FollowResult> {
    const authorized = checkTrustedContext(ctx);
    if (!authorized.ok) return { status: 'rejected', code: authorized.code, message: authorized.message };
    if (ctx !== undefined && ctx.kind === 'agent-work' && ctx.instanceId !== request.instanceId) {
      return { status: 'rejected', code: 'forbidden', message: '绑定实例与订阅实例不一致' };
    }
    if (typeof request.instanceId !== 'string' || request.instanceId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少实例 id' };
    }

    const root = this.deps.localRoot;
    const quarantined = await this.deps.store.readQuarantine(root, request.instanceId);
    if (quarantined !== null) {
      return {
        status: 'rejected',
        code: 'unknown-state',
        message: `该实例已隔离（${quarantined.reason}）；不建立订阅，先离线核对`,
      };
    }
    const registry = await this.deps.store.readRegistry(root);
    const entry = registry.instances.find((item) => item.instanceId === request.instanceId);
    if (entry === undefined) return { status: 'rejected', code: 'binding-expired', message: '本机注册表中没有该实例' };

    const read = await this.readAggregate(request.instanceId);
    if ('code' in read) return { status: 'rejected', code: read.code, message: read.message };

    const sourceEpoch = Math.max(entry.sourceGeneration, read.aggregate.source.generation);
    const known = this.deps.stream.highestKnown(request.instanceId);
    const durableRevision = read.aggregate.revisions.state;
    const stateRevision = Math.max(
      durableRevision,
      request.afterStateRevision ?? 0,
      known !== null && known.sourceEpoch === sourceEpoch ? known.stateRevision : 0,
    );
    const planRevision = Math.max(
      read.aggregate.revisions.plan,
      known !== null && known.sourceEpoch === sourceEpoch ? known.planRevision : 0,
    );

    const connectionGeneration = this.deps.stream.nextGeneration(request.instanceId);
    const queue = new EventQueue();
    const ready: StreamEventView = {
      kind: 'ready',
      instanceId: request.instanceId,
      projectId: entry.projectId,
      sourceEpoch,
      stateRevision,
      planRevision,
      connectionGeneration,
      at: this.deps.clock(),
    };
    const unsubscribe = this.deps.stream.subscribe(request.instanceId, {
      generation: connectionGeneration,
      sourceEpoch,
      lastRevision: stateRevision,
      push: (event) => queue.push(event),
      close: () => queue.end(),
    });

    return {
      status: 'following',
      connectionGeneration,
      ready,
      events: queue,
      close: () => {
        unsubscribe();
        queue.end();
      },
    };
  }

  private async readAggregate(
    instanceId: string,
  ): Promise<{ aggregate: InstanceAggregate } | { code: string; message: string }> {
    let aggregate: InstanceAggregate | null;
    try {
      aggregate = await this.deps.store.readAggregate(this.deps.localRoot, instanceId);
    } catch (error) {
      return { code: 'unknown-state', message: `本机聚合不可读：${(error as Error).message}；先运行只读诊断` };
    }
    if (aggregate === null) return { code: 'binding-expired', message: '实例聚合缺失；不自动重建' };
    return { aggregate };
  }

  private build(
    entry: RegistryEntry,
    aggregate: InstanceAggregate,
    doc: ProjectDocument,
    observedHeadHash: string,
    request: SnapshotReadRequest,
    quarantined: QuarantineInfo | null,
  ): ProjectSnapshot {
    const tree = orderTree(doc.plan.nodes);
    const records = copyRecords(doc.records);
    const observation = aggregate.lastObservation;
    const drift =
      observation !== null &&
      (observation.headHash !== observedHeadHash || observation.planVersion !== doc.planVersion);
    const sync: SnapshotSync = drift
      ? { status: 'not-synced', reason: 'source-drift', requiresRefresh: true, basis: 'local-observation' }
      : {
          status: 'synced',
          requiresRefresh: false,
          basis: observation === null ? 'current-read' : 'local-observation',
        };

    return {
      projectId: entry.projectId,
      instanceId: entry.instanceId,
      sourceEpoch: entry.sourceGeneration,
      schemaVersion: doc.schemaVersion,
      planVersion: doc.planVersion,
      planRevision: aggregate.revisions.plan,
      stateRevision: aggregate.revisions.state,
      connectionGeneration: request.connectionGeneration,
      sync,
      source: {
        kind: entry.sourceKind,
        displayPath: this.deps.describeLocation?.(entry.sourceRoot).displayPath ?? entry.sourceRoot,
      },
      project: {
        ...doc.project,
        constraints: [...doc.project.constraints],
        repositories: doc.project.repositories.map((repo) => ({ ...repo })),
      },
      tree,
      dependencies: doc.plan.dependencies.map((edge) => ({ ...edge })),
      records,
      summary: summarizePlan(tree, doc.plan.dependencies, records),
      local: {
        conversationCount: aggregate.conversations.length,
        workRunCount: aggregate.workRuns.length,
        quarantined,
      },
      readAt: this.deps.clock(),
    };
  }
}
