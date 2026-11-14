// 本机根、注册表与实例聚合（tasks 3.2，design §2）。
// 边界：本文件只描述语义（位置、注册、聚合形状）与编排；路径拼接、锁与文件读写由 adapters 落实。
// 公开资料根与本机运行根必须互不包含；本机数据不写回公开头。

import type { SourceBaseline } from './baseline.js';
import type { LocationKind } from './location.js';
import type { LocalIssue, LocalStateStorePort, LocalRootResolverPort, GitPrivateRootPort } from './ports.js';

/** DSH 数据目录下本机运行数据的相对分段（design §2）；显式 localDataRoot 时不再追加。 */
export const LOCAL_DATA_SEGMENTS: readonly string[] = ['data', 'dsh-cona', 'local'];

export interface LocalRootRequest {
  /** 宿主 home；与 localDataRoot 二选一。 */
  dshHome?: string;
  /** 用户明确指定的本机绝对目录（插件 localDataRoot 配置）。 */
  localDataRoot?: string;
}

export interface LocalRootPlan {
  base: 'dsh-home' | 'explicit';
  basePath: string;
  segments: readonly string[];
}

export type LocalRootPlanResult = { ok: true; plan: LocalRootPlan } | { ok: false; issues: LocalIssue[] };

export function planLocalRoot(request: LocalRootRequest): LocalRootPlanResult {
  if (typeof request.localDataRoot === 'string' && request.localDataRoot.trim() !== '') {
    return { ok: true, plan: { base: 'explicit', basePath: request.localDataRoot, segments: [] } };
  }
  if (typeof request.dshHome === 'string' && request.dshHome.trim() !== '') {
    return { ok: true, plan: { base: 'dsh-home', basePath: request.dshHome, segments: [...LOCAL_DATA_SEGMENTS] } };
  }
  return {
    ok: false,
    issues: [
      {
        code: 'local-root-missing',
        message: '需要宿主 home 或明确的 localDataRoot；插件不猜用户目录',
      },
    ],
  };
}

/** 注册表条目：同一资料根复用同一实例；同项目不同目录是不同实例。 */
export interface RegistryEntry {
  instanceId: string;
  projectId: string;
  /** 规范化绝对路径（公开资料根）；本机数据，不写入公开头。 */
  sourceRoot: string;
  sourceKind: LocationKind;
  /** 源代际：登记为 1，显式刷新时递增（3.5）。 */
  sourceGeneration: number;
  createdAt: string;
  updatedAt: string;
}

export interface Registry {
  schemaVersion: 1;
  instances: RegistryEntry[];
}

/** 最近一次有效观察：规划指纹之外另记头字节哈希与逐条正文哈希（3.5）。 */
export interface ObservationRecord {
  path: string;
  contentHash: string;
  observedHash: string;
}

export interface ObservationBaseline {
  planVersion: string;
  headHash: string;
  records: ObservationRecord[];
  observedAt: string;
}

/** 操作归属：仅说明来源，不构成授权；回执读取按此隔离。 */
export interface OperationOrigin {
  kind: 'remote-owner' | 'agent-work';
  workRunId?: string;
}

/** 已提交结果快照：重放时返回原版本，而不是当前快照。 */
export interface OperationResultSnapshot {
  impact: 'plan' | 'state';
  planVersion: string;
  planRevision: number;
  stateRevision: number;
  sourceEpoch: number;
  recordId?: string;
  recordPath?: string;
}

/** prepared 意图中登记的正文写入项（内容寻址，可重放核对）。 */
export interface PreparedBody {
  recordId: string;
  contentHash: string;
  path: string;
  bytes: number;
}

/**
 * prepared 意图（tasks 4.3，design §6 步骤 4）：候选头字节、正文清单、生成 id 与预算结果。
 * 保存候选头全文，恢复时可判断“当前内容是否精确对应候选”，不必猜。
 */
export interface PreparedIntent {
  candidateHead: string;
  candidateHeadHash: string;
  candidatePlanVersion: string;
  bodies: PreparedBody[];
  impact: 'plan' | 'state';
  planRevision: number;
  stateRevision: number;
  /** 预算好的回执结果；写入回执时直接采用，不重算。 */
  result: OperationResultSnapshot;
  /** 无业务变化时不重写资料头。 */
  writeHead: boolean;
}

/**
 * 操作记录（tasks 4.2／4.3）：`prepared` → `publishing` → `committed`／`rejected`。
 * `requestDigest` 覆盖命令、业务参数与输入基线，不含 operationId 或重连临时标识。
 * `generated` 保存本操作的稳定生成 id，重启后核对或补写时复用，不重新生成。
 */
export interface OperationRecord {
  operationId: string;
  requestDigest: string;
  origin: OperationOrigin;
  status: 'prepared' | 'publishing' | 'committed' | 'rejected';
  createdAt: string;
  updatedAt: string;
  /** 原请求的输入基线：响应丢失后要“原样重发”，必须能取回这三项，而不是重读当前基线。 */
  baseline: { expectedPlanVersion: string; expectedPlanRevision: number; sourceEpoch: number };
  generated: { recordId?: string; nodeIds?: string[] };
  prepared?: PreparedIntent;
  result?: OperationResultSnapshot;
  rejection?: { code: string; message: string };
}

/**
 * 单实例聚合：双修订、聊天关系、WorkRun 历史、意图／回执与最近有效观察同存一处。
 * 3.2 落形状与基本读写，3.5 补完整基线，4.2 补操作意图／回执；聊天在 3.6 细化。
 */
export interface InstanceAggregate {
  schemaVersion: 1;
  instanceId: string;
  projectId: string;
  source: { root: string; kind: LocationKind; generation: number };
  revisions: { plan: number; state: number };
  conversations: readonly unknown[];
  workRuns: readonly unknown[];
  operations: OperationRecord[];
  lastObservation: ObservationBaseline | null;
}

export interface LocalRootView {
  root: string;
  displayPath: string;
}

/** 本机根的私有性检查结果：位于 Git 仓库时必须无已跟踪文件且被忽略。 */
export interface PrivateRootCheck {
  inRepository: boolean;
  repositoryRoot?: string;
  trackedFiles: string[];
  ignored: boolean | 'unknown';
  /** false 表示无法核查（如 git 不可用）；不得对外显示为“已核查安全”。 */
  checked: boolean;
}

export interface LocalStateDeps {
  resolver: LocalRootResolverPort;
  git: GitPrivateRootPort;
  store: LocalStateStorePort;
  clock: () => string;
  newInstanceId: () => string;
}

export interface EnsureLocalRootResult {
  ok: true;
  root: LocalRootView;
  privacy: PrivateRootCheck;
}

export interface RegisterRequest extends LocalRootRequest {
  /** 公开资料根的绝对路径（来自 3.1 的 location.root）。 */
  sourceRoot: string;
  sourceKind: LocationKind;
  projectId: string;
}

export interface RegisterResult {
  ok: true;
  root: LocalRootView;
  entry: RegistryEntry;
  aggregate: InstanceAggregate;
  reused: boolean;
}

export interface RefreshRequest extends LocalRootRequest {
  instanceId: string;
  /** 由调用方先用 `readSourceBaseline` 重读磁盘得到的完整基线。 */
  baseline: SourceBaseline;
}

export interface RefreshChanges {
  /** 首次建立基线：没有旧观察可比较。 */
  initial: boolean;
  headChanged: boolean;
  planVersionChanged: boolean;
  recordsAdded: string[];
  recordsRemoved: string[];
  recordsChanged: string[];
}

export interface RefreshResult {
  ok: true;
  root: LocalRootView;
  entry: RegistryEntry;
  aggregate: InstanceAggregate;
  changes: RefreshChanges;
}

export interface ListResult {
  ok: true;
  root: LocalRootView;
  entries: RegistryEntry[];
}

export interface ShowResult {
  ok: true;
  root: LocalRootView;
  aggregate: InstanceAggregate | null;
}

export type LocalResult<T> = T | { ok: false; issues: LocalIssue[] };

/** 把适配器抛出的稳定错误码转成 issue，不向调用者抛裸异常。 */
function failureOf(error: unknown): { ok: false; issues: LocalIssue[] } {
  const e = error as { code?: string; message?: string };
  return {
    ok: false,
    issues: [
      {
        code: typeof e.code === 'string' ? e.code : 'local-state-failed',
        message: typeof e.message === 'string' ? e.message : '本机状态操作失败',
      },
    ],
  };
}

export class LocalStateService {
  constructor(private readonly deps: LocalStateDeps) {}

  /**
   * 解析并检查本机根：资料根与本机根不得相同或互相包含；
   * 位于 Git 工作副本时必须处于不跟踪区域（无已跟踪文件且被 ignore 覆盖）。
   * 只检查与建立空目录，不写注册表。
   */
  async ensureRoot(request: LocalRootRequest & { sourceRoot?: string }): Promise<LocalResult<EnsureLocalRootResult>> {
    try {
      return await this.ensureRootUnchecked(request);
    } catch (error) {
      return failureOf(error);
    }
  }

  private async ensureRootUnchecked(
    request: LocalRootRequest & { sourceRoot?: string },
  ): Promise<LocalResult<EnsureLocalRootResult>> {
    const planned = planLocalRoot(request);
    if (!planned.ok) return { ok: false, issues: planned.issues };
    const resolved = this.deps.resolver.resolveLocal(planned.plan);
    if (!resolved.ok) return { ok: false, issues: resolved.issues };
    const r = resolved.root;

    if (typeof request.sourceRoot === 'string' && request.sourceRoot.trim() !== '') {
      const overlap = this.deps.resolver.relation(request.sourceRoot, r.root);
      if (overlap === 'same' || overlap === 'nested') {
        return {
          ok: false,
          issues: [
            {
              code: 'local-root-overlaps-source',
              message:
                overlap === 'same'
                  ? '本机运行根不能与公开资料根相同'
                  : '本机运行根与公开资料根不得互相包含',
              path: r.root,
            },
          ],
        };
      }
    }

    await this.deps.store.ensureDirs(r.root);
    const privacy = this.deps.git.inspect(r.root);
    if (privacy.inRepository) {
      if (privacy.trackedFiles.length > 0) {
        return {
          ok: false,
          issues: [
            {
              code: 'local-root-tracked',
              message: `本机根位于 Git 工作副本且已有被跟踪内容（${privacy.trackedFiles.slice(0, 3).join(', ')}）；私有记录不写入已跟踪区域，请改用被忽略的目录或插件数据根`,
              path: r.root,
            },
          ],
        };
      }
      if (privacy.ignored !== true) {
        return {
          ok: false,
          issues: [
            {
              code: 'local-root-not-ignored',
              message: '本机根位于 Git 工作副本但未被 ignore 覆盖；请先在仓库忽略该目录，或改用插件数据根',
              path: r.root,
            },
          ],
        };
      }
    }

    return { ok: true, root: { root: r.root, displayPath: r.displayPath }, privacy };
  }

  /**
   * 登记或复用实例：同一资料根复用既有 instanceId；同项目不同目录生成不同实例。
   * 注册表先持久化，之后才允许创建命令（3.4 承接）。
   */
  async register(request: RegisterRequest): Promise<LocalResult<RegisterResult>> {
    const ensured = await this.ensureRoot({ ...request, sourceRoot: request.sourceRoot });
    if (!('ok' in ensured) || ensured.ok !== true) return ensured as { ok: false; issues: LocalIssue[] };
    const rootView = ensured.root;

    const locked = await this.deps.store.withLock(rootView.root, async () => {
      const registry = await this.deps.store.readRegistry(rootView.root);
      const now = this.deps.clock();
      const existing = registry.instances.find((entry) => entry.sourceRoot === request.sourceRoot);
      if (existing !== undefined) {
        if (existing.projectId !== request.projectId) {
          return {
            ok: false as const,
            issues: [
              {
                code: 'registry-project-identity-changed',
                message: `同一资料根已登记为项目 ${existing.projectId}，与当前 ${request.projectId} 不一致；拒绝静默复用，请另建实例或核对来源`,
                path: request.sourceRoot,
              },
            ],
          };
        }
        const aggregate = await this.deps.store.readAggregate(rootView.root, existing.instanceId);
        if (aggregate === null) {
          return {
            ok: false as const,
            issues: [
              {
                code: 'registry-aggregate-missing',
                message: `注册表指向实例 ${existing.instanceId}，但其本机聚合缺失；请先核对本机数据根，不自动重建实例`,
                path: rootView.root,
              },
            ],
          };
        }
        return { ok: true as const, reused: true, entry: existing, aggregate, root: rootView };
      }

      const instanceId = this.deps.newInstanceId();
      const entry: RegistryEntry = {
        instanceId,
        projectId: request.projectId,
        sourceRoot: request.sourceRoot,
        sourceKind: request.sourceKind,
        sourceGeneration: 1,
        createdAt: now,
        updatedAt: now,
      };
      const aggregate: InstanceAggregate = {
        schemaVersion: 1,
        instanceId,
        projectId: request.projectId,
        source: { root: request.sourceRoot, kind: request.sourceKind, generation: 1 },
        revisions: { plan: 0, state: 0 },
        conversations: [],
        workRuns: [],
        operations: [],
        // 完整基线由显式刷新（3.5）建立；登记不写半截观察，避免被误当作已核查基线。
        lastObservation: null,
      };
      // 先写聚合再写注册表：注册表是权威索引，不能指向不存在的聚合。
      await this.deps.store.writeAggregate(rootView.root, aggregate);
      await this.deps.store.writeRegistry(rootView.root, {
        ...registry,
        instances: [...registry.instances, entry],
      });
      return { ok: true as const, reused: false, entry, aggregate, root: rootView };
    });

    if (locked.ok === false) return { ok: false, issues: locked.issues };
    const value = locked.value;
    if (value.ok === false) return { ok: false, issues: value.issues };
    return { ok: true, root: value.root, entry: value.entry, aggregate: value.aggregate, reused: value.reused };
  }

  /**
   * 显式刷新（tasks 3.5）：以磁盘重读的完整基线更新本机观察与源代际。
   * 始终以磁盘为准，不复用旧缓存；项目身份变化时拒绝刷新，不覆盖既有聚合。
   */
  async refresh(request: RefreshRequest): Promise<LocalResult<RefreshResult>> {
    try {
      const planned = planLocalRoot(request);
      if (!planned.ok) return { ok: false, issues: planned.issues };
      const resolved = this.deps.resolver.resolveLocal(planned.plan);
      if (!resolved.ok) return resolved;
      const rootPath = resolved.root.root;

      const locked = await this.deps.store.withLock(rootPath, async () => {
        const registry = await this.deps.store.readRegistry(rootPath);
        const entry = registry.instances.find((item) => item.instanceId === request.instanceId);
        if (entry === undefined) {
          return {
            ok: false as const,
            issues: [
              { code: 'registry-instance-not-found', message: `本机注册表中没有实例 ${request.instanceId}`, path: rootPath },
            ],
          };
        }
        if (entry.projectId !== request.baseline.projectId) {
          return {
            ok: false as const,
            issues: [
              {
                code: 'source-identity-changed',
                message: `同一资料路径的项目 id 已变为 ${request.baseline.projectId}（原 ${entry.projectId}）；拒绝刷新，请核对来源后另建实例`,
                path: entry.sourceRoot,
              },
            ],
          };
        }
        const aggregate = await this.deps.store.readAggregate(rootPath, entry.instanceId);
        if (aggregate === null) {
          return {
            ok: false as const,
            issues: [
              { code: 'registry-aggregate-missing', message: '注册表指向的实例聚合缺失；不自动重建', path: rootPath },
            ],
          };
        }

        const previous = aggregate.lastObservation;
        const previousRecords = new Map((previous?.records ?? []).map((record) => [record.path, record.observedHash]));
        const nextRecords = new Map(request.baseline.records.map((record) => [record.path, record.observedHash]));
        const changes: RefreshChanges = {
          initial: previous === null,
          headChanged: previous === null || previous.headHash !== request.baseline.headHash,
          planVersionChanged: previous === null || previous.planVersion !== request.baseline.planVersion,
          recordsAdded: [...nextRecords.keys()].filter((pathKey) => !previousRecords.has(pathKey)).sort(),
          recordsRemoved: [...previousRecords.keys()].filter((pathKey) => !nextRecords.has(pathKey)).sort(),
          recordsChanged: [...nextRecords.entries()]
            .filter(([pathKey, hash]) => previousRecords.has(pathKey) && previousRecords.get(pathKey) !== hash)
            .map(([pathKey]) => pathKey)
            .sort(),
        };

        const observedAt = this.deps.clock();
        const nextAggregate: InstanceAggregate = {
          ...aggregate,
          source: { ...aggregate.source, generation: aggregate.source.generation + 1 },
          lastObservation: {
            planVersion: request.baseline.planVersion,
            headHash: request.baseline.headHash,
            records: request.baseline.records.map((record) => ({
              path: record.path,
              contentHash: record.contentHash,
              observedHash: record.observedHash,
            })),
            observedAt,
          },
        };
        const saved = await this.deps.store.replaceAggregateChecked(rootPath, nextAggregate);
        if (saved.status !== 'saved') {
          return {
            ok: false as const,
            issues: [
              {
                code: saved.status === 'not-saved' ? 'local-state-write-failed' : 'unknown-state',
                message: `刷新未确认（${saved.stage}）：${saved.detail ?? '本机状态未保存'}；不要直接重试覆盖，先核对本机数据`,
                path: rootPath,
              },
            ],
          };
        }
        const nextEntry: RegistryEntry = {
          ...entry,
          sourceGeneration: nextAggregate.source.generation,
          updatedAt: observedAt,
        };
        await this.deps.store.writeRegistry(rootPath, {
          ...registry,
          instances: registry.instances.map((item) => (item.instanceId === entry.instanceId ? nextEntry : item)),
        });
        return { ok: true as const, entry: nextEntry, aggregate: nextAggregate, changes };
      });

      if (locked.ok === false) return { ok: false, issues: locked.issues };
      const value = locked.value;
      if (value.ok === false) return { ok: false, issues: value.issues };
      return { ok: true, root: resolved.root, entry: value.entry, aggregate: value.aggregate, changes: value.changes };
    } catch (error) {
      return failureOf(error);
    }
  }

  async list(request: LocalRootRequest): Promise<LocalResult<ListResult>> {
    try {
      const planned = planLocalRoot(request);
      if (!planned.ok) return { ok: false, issues: planned.issues };
      const resolved = this.deps.resolver.resolveLocal(planned.plan);
      if (!resolved.ok) return { ok: false, issues: resolved.issues };
      const registry = await this.deps.store.readRegistry(resolved.root.root);
      return { ok: true, root: resolved.root, entries: registry.instances };
    } catch (error) {
      return failureOf(error);
    }
  }

  async show(request: LocalRootRequest & { instanceId: string }): Promise<LocalResult<ShowResult>> {
    try {
      const planned = planLocalRoot(request);
      if (!planned.ok) return { ok: false, issues: planned.issues };
      const resolved = this.deps.resolver.resolveLocal(planned.plan);
      if (!resolved.ok) return { ok: false, issues: resolved.issues };
      const aggregate = await this.deps.store.readAggregate(resolved.root.root, request.instanceId);
      return { ok: true, root: resolved.root, aggregate };
    } catch (error) {
      return failureOf(error);
    }
  }
}
