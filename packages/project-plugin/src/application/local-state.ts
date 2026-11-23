// 本机根、注册表与实例聚合（tasks 3.2，design §2）。
// 边界：本文件只描述语义（位置、注册、聚合形状）与编排；路径拼接、锁与文件读写由 adapters 落实。
// 公开资料根与本机运行根必须互不包含；本机数据不写回公开头。

import type { BaselineResult, SourceBaseline } from './baseline.js';
import type { LocationKind } from './location.js';
import type { LocalIssue, LocalStateStorePort, LocalRootResolverPort, GitPrivateRootPort } from './ports.js';
import type { Sha256Fn } from '../domain/types.js';

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
  /** schema 1＝无迁移记录的旧注册表；schema 2 起携带迁移记录（1.4）。首笔迁移时整表原子升级。 */
  schemaVersion: 1 | 2;
  instances: RegistryEntry[];
  /** 迁移记录（1.4，design §1）；schema 1 没有该字段，读取时归一化为空数组。 */
  migrations?: MigrationRecord[];
}

/** 迁移状态机（1.4）：prepared → target-ready → switched → committed；未切换可 canceled。 */
export type MigrationStatus = 'prepared' | 'target-ready' | 'switched' | 'committed' | 'canceled';

/** 未结束的迁移：占用目标、阻止实例刷新与登记抢占；switched 之后只允许补齐，不允许取消。 */
export const MIGRATION_OPEN_STATUSES: readonly MigrationStatus[] = ['prepared', 'target-ready', 'switched'];

export function isMigrationOpen(status: MigrationStatus): boolean {
  return (MIGRATION_OPEN_STATUSES as readonly string[]).includes(status);
}

export interface MigrationManifestFile {
  /** 协议相对路径（project.json 或 records/<id>/<hash>.md）。 */
  path: string;
  /** 逐字节观察哈希（sha256:…）。 */
  hash: string;
}

/** 迁移冻结清单（1.4）：头哈希 + 全部引用正文哈希 + 清单哈希；复制与恢复逐字节核对的依据。 */
export interface MigrationManifest {
  headHash: string;
  files: MigrationManifestFile[];
  filesHash: string;
}

export interface MigrationReceipt {
  operationId: string;
  committedAt: string;
  sourceGeneration: number;
  effectiveRoot: string;
}

export interface MigrationRecord {
  operationId: string;
  /** 原请求摘要：恢复／取消的重复确认与它核对，不认别的身份。 */
  requestDigest: string;
  instanceId: string;
  projectId: string;
  from: { root: string; kind: LocationKind; expectedGeneration: number };
  to: { root: string; kind: LocationKind };
  newGeneration: number;
  /** 目标侧独占候选目录与所有权标识；取消只清理有所有权证据且内容核对过的候选。 */
  candidate: { path: string; ownershipToken: string };
  manifest: MigrationManifest;
  status: MigrationStatus;
  /** committed 后的原回执；恢复补齐时填入，重复恢复按原回执返回。 */
  receipt?: MigrationReceipt;
  /** canceled 记录：清理了哪些路径（仅限所有权证据 + 内容核对过的候选／装入目标）。 */
  cancel?: { at: string; removed: string[] };
  createdAt: string;
  updatedAt: string;
}

/** 注册表迁移记录归一化：schema 1 或缺字段时为空数组，不静默改写磁盘。 */
export function migrationsOf(value: unknown): MigrationRecord[] {
  if (value === null || typeof value !== 'object' || !Array.isArray((value as { migrations?: unknown }).migrations)) {
    return [];
  }
  return (value as { migrations: MigrationRecord[] }).migrations;
}

/** 最近一次有效观察：规划指纹之外另记头字节哈希与逐条正文哈希（3.5）。 */
export interface ObservationRecord {
  /** 索引记录 id（1.2 起记录，用于「同 ID 改写」与「索引丢失」追踪）；旧观察缺省时按 path 追踪。 */
  recordId?: string;
  path: string;
  contentHash: string;
  observedHash: string;
}

export interface ObservationBaseline {
  planVersion: string;
  headHash: string;
  records: ObservationRecord[];
  /** 接纳时的 Git 只读观察（1.3 起记录）；旧观察缺省，同一性核对缺失时以逐字节核对为准。 */
  git?: { repositoryRoot?: string; headCommit?: string };
  observedAt: string;
}

/** 本机仓库映射（tasks 1.1）：repositoryId → 本机绝对路径；按实例保存，不同副本各自独立。 */
export interface RepositoryMap {
  repositoryId: string;
  absolutePath: string;
  updatedAt: string;
}

/** 旧聚合没有 repositoryMaps（1.1 前未定形）；读取时归一化，不静默改写磁盘。 */
export function repositoryMapsOf(value: unknown): RepositoryMap[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is RepositoryMap =>
      item !== null && typeof item === 'object'
      && typeof (item as RepositoryMap).repositoryId === 'string'
      && typeof (item as RepositoryMap).absolutePath === 'string'
      && typeof (item as RepositoryMap).updatedAt === 'string',
  );
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
  /** 提交前磁盘头的哈希：恢复时用于区分“候选已发布”与“退回原基线”。 */
  originalHeadHash: string;
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
  /** true 表示回执由恢复核对补齐，不证明作者或文件外动作。 */
  recovered?: boolean;
}

/**
 * 单实例聚合：双修订、聊天关系、工作意图／WorkRun、意图／回执与最近有效观察同存一处。
 * 3.2 落形状与基本读写，3.5 补完整基线，4.2 补操作意图／回执；6.1 落聊天关联形状；6.2 落工作意图与 WorkRun。
 * 私有授权（工作意图／运行／绑定）只存本机聚合，不进公开资料；导入外部 v1 资料不带来任何授权。
 */
export interface InstanceAggregate {
  schemaVersion: 1;
  instanceId: string;
  projectId: string;
  source: { root: string; kind: LocationKind; generation: number };
  revisions: { plan: number; state: number };
  conversations: ConversationState;
  workIntents: WorkIntent[];
  workRuns: WorkRunRecord[];
  /** 绑定外变更建议（6.4）；旧聚合归一化为空数组。 */
  workSuggestions: WorkSuggestion[];
  /** 接续记录的本机聊天指针（3.3）；旧聚合归一化为空数组。 */
  resumePointers?: ResumeChatPointer[];
  operations: OperationRecord[];
  lastObservation: ObservationBaseline | null;
  /** 本机仓库映射（1.1）；旧聚合归一化为空数组。 */
  repositoryMaps?: RepositoryMap[];
}

/** 本机聊天关联（tasks 6.1）：多对多，链接只表达背景关系，不构成写授权。 */
export interface ConversationLink {
  /** 本机稳定链接 id；同一 Session 可有多条链接（不同用途）。 */
  linkId: string;
  /** 宿主实际返回的 Session 身份（非预期 id）。 */
  sessionId: string;
  /** 关联节点集合（多对多的一端）。 */
  nodeIds: string[];
  purpose: string;
  /** 来源：面板创建／认领，或（后续段落的）Agent 工具。 */
  origin: 'panel' | 'agent';
  createdAt: string;
  updatedAt: string;
}

/**
 * 创建／认领聊天的持久意图（tasks 6.1，design §7）：
 * 先落盘意图再调宿主；结果未知时保留 pending，由显式 reconcile 核对，不盲目再建第二个聊天。
 */
export interface ConversationIntent {
  operationId: string;
  action: 'create' | 'claim';
  nodeIds: string[];
  purpose: string;
  origin: 'panel' | 'agent';
  createdAt: string;
  /** linked：已写入链接；unknown：宿主结果未知（等 reconcile）；pending：尚未取得宿主结果。 */
  status: 'pending' | 'linked' | 'unknown';
  resolvedSessionId?: string;
  detail?: string;
}

export interface ConversationState {
  links: ConversationLink[];
  intents: ConversationIntent[];
}

/** 工作意图允许的动作子集（design §7）：范围显式确认，不自动扩大。 */
export type WorkAction = 'add' | 'update' | 'split' | 'dependencies' | 'record' | 'status';

export const WORK_ACTIONS: readonly WorkAction[] = ['add', 'update', 'split', 'dependencies', 'record', 'status'];

/** 工作意图登记的输入规划基线快照；运行期间命令基线与之核对，外部变化即失配。 */
export interface WorkBaseline {
  planVersion: string;
  planRevision: number;
  sourceEpoch: number;
}

/**
 * 工作意图（tasks 6.2，design §7）：目标集合、允许动作、原因可发布范围与输入规划基线。
 * 用户经“开始工作”确认具体范围后进入 awaiting-message，等期望消息（source.rpcId）
 * 被宿主实际消费时才启动 WorkRun；排队未消费只登记，不改绑定。
 */
export interface WorkIntent {
  workIntentId: string;
  /** 目标集合（多节点允许）；绑定外目标一律拒绝。 */
  nodeIds: string[];
  allowedActions: WorkAction[];
  /** 原因可发布范围：public＝原因可写入公开记录；local＝原因只留在本机聚合。 */
  reasonScope: 'public' | 'local';
  purpose: string;
  origin: 'panel' | 'agent';
  baseline: WorkBaseline;
  /** 期望消息来源：Client prompt 的 requestId（宿主保存为消息 source.rpcId）；rpcId 不是授权令牌。 */
  expectedRpcId?: string;
  /** 期望会话；缺省由首次消费匹配确定。 */
  sessionId?: string;
  /** pending：已登记待确认；awaiting-message：已确认等消息消费；active：运行中；
   *  completed：运行真实终态；stopped：显式停止；blocked：准入拒绝（agent 缺失／归属不唯一等）。 */
  status: 'pending' | 'awaiting-message' | 'active' | 'completed' | 'stopped' | 'blocked';
  blockedReason?: string;
  /** 最近一次排队观测（只登记； informational）。 */
  queuedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 接续记录（tasks 6.4，design §7）：范围扩展只能经显式接续纳入；每次接续保留
 * 来源（谁、从哪个版本到哪个版本、纳入了什么、为什么），不把扩权藏进静默改写。
 */
export interface WorkContinuation {
  /** 接续发生时刻（UTC instant）。 */
  at: string;
  fromVersion: number;
  toVersion: number;
  /** 本次显式纳入的新目标节点。 */
  addedTargets: string[];
  /** 接续原因（必填；spec 要求保留接续原因）。 */
  reason: string;
  origin: 'panel' | 'agent';
}

/**
 * 绑定外变更建议（tasks 6.4，design §7「绑定外变更先保留为建议」）：
 * agent 工具试图写入绑定外目标／动作被拒时，保留一条建议供用户复核；
 * 建议是背景信息，不构成任何写授权。
 */
export interface WorkSuggestion {
  suggestionId: string;
  /** 提出建议的运行与会话（来源）。 */
  workRunId: string;
  sessionId: string;
  action: WorkAction;
  /** 试图写入的目标节点（被拒的那次命令的目标集合）。 */
  nodeIds: string[];
  /** 被拒原因（来自稳定拒绝的说明）。 */
  reason: string;
  /** open：待复核；included：已随接续纳入；dismissed：用户明确不采纳。 */
  status: 'open' | 'included' | 'dismissed';
  createdAt: string;
  lastSeenAt: string;
  resolvedAt?: string;
  resolvedHow?: string;
}

/**
 * WorkRun（tasks 6.2）：一次真实执行的活动绑定。身份键＝(bootGeneration, sessionId, turn)；
 * 同一会话同时最多一个生效运行。bindingVersion 从 1 起，本运行规划提交成功后 +1
 * （只更新已接受基线，范围与动作不变）；重启后旧代际运行不再有写资格。
 * 6.4：范围扩展经显式接续（版本再 +1），接续记录保留在运行上。
 */
export interface WorkRunRecord {
  workRunId: string;
  workIntentId: string;
  sessionId: string;
  turn: number;
  bootGeneration: number;
  bindingVersion: number;
  acceptedBaseline: WorkBaseline;
  targets: string[];
  allowedActions: WorkAction[];
  reasonScope: 'public' | 'local';
  rpcId: string;
  /** active：生效中；stopped：显式停止；ended：真实终态（完成／取消）。 */
  status: 'active' | 'stopped' | 'ended';
  /**
   * 取消请求观测时刻（tasks 6.5，design §7）：收到真实取消／steer abort 后立即停止
   * 新写准入，但 status 保持 active 等真实终态（turn/end）确认——预告不作数。
   */
  admissionStoppedAt?: string;
  endedAt?: string;
  endKind?: 'completed' | 'aborted' | 'stopped';
  startedAt: string;
  /** 显式接续历史（6.4）；缺省为空（旧聚合归一化）。 */
  continuations?: WorkContinuation[];
}

/** 旧版聚合的 conversations 是空数组（3.2 预留）；读取时归一化为新形状。 */
export function conversationStateOf(value: unknown): ConversationState {
  if (Array.isArray(value)) return { links: [], intents: [] };
  if (value !== null && typeof value === 'object') {
    const state = value as Partial<ConversationState>;
    return {
      links: Array.isArray(state.links) ? [...state.links] : [],
      intents: Array.isArray(state.intents) ? [...state.intents] : [],
    };
  }
  return { links: [], intents: [] };
}

/**
 * 接续记录的本机聊天指针（R2 3.3，design §3）：
 * 公开记录（recordId + contentHash 定位具体版本）与本机聊天链接（linkId）的私有关联。
 * 只存本机聚合，绝不写入公开资料；同一记录保留一条指针（重新关联即替换）。
 */
export interface ResumeChatPointer {
  /** 接续记录 id（公开索引）。 */
  recordId: string;
  /** 指针建立时该记录在已接纳索引中的正文哈希（版本语义）。 */
  contentHash: string;
  /** 本机聊天链接 id（ConversationState.links）。 */
  linkId: string;
  createdAt: string;
}

/** 旧聚合没有 resumePointers（3.3 前未定形）；读取时归一化，不静默改写磁盘。 */
export function resumePointersOf(value: unknown): ResumeChatPointer[] {
  return Array.isArray(value)
    ? (value as ResumeChatPointer[]).filter(
        (item) =>
          item !== null && typeof item === 'object'
          && typeof (item as ResumeChatPointer).recordId === 'string'
          && typeof (item as ResumeChatPointer).contentHash === 'string'
          && typeof (item as ResumeChatPointer).linkId === 'string',
      )
    : [];
}

/**
 * 工作状态归一化（tasks 6.2）：旧聚合没有 workIntents（workRuns 曾是 unknown[] 占位）；
 * 读取时归一化为类型化数组。6.4 补充 workSuggestions 归一化。
 * 私有授权只在本地聚合，导入的公开资料不带任何工作状态。
 */
export function workStateOf(
  aggregate: Pick<InstanceAggregate, 'workIntents' | 'workRuns' | 'workSuggestions'>,
): {
  intents: WorkIntent[];
  runs: WorkRunRecord[];
  suggestions: WorkSuggestion[];
} {
  return {
    intents: Array.isArray(aggregate.workIntents) ? [...aggregate.workIntents] : [],
    runs: Array.isArray(aggregate.workRuns) ? [...aggregate.workRuns] : [],
    suggestions: Array.isArray(aggregate.workSuggestions) ? [...aggregate.workSuggestions] : [],
  };
}

/**
 * 实例隔离标记（tasks 4.5）：本机聚合写入结果未知或不可读时，停止该实例读写。
 * 标记与聚合分开保存，因此聚合本身不可信时仍能读到隔离原因。
 */
export interface QuarantineInfo {
  schemaVersion: 1;
  instanceId: string;
  reason: 'unknown-state' | 'aggregate-unreadable';
  /** 触发隔离的阶段（如 receipt／local-state／recover）。 */
  stage: string;
  /** 保留原操作 id，便于离线核对后继续。 */
  operationId?: string;
  createdAt: string;
  detail?: string;
  requires: 'offline-review';
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
  /** 刷新成功后发布失效通知（第 5 段）；失败不影响刷新结果。 */
  notify?: (result: { entry: RegistryEntry; aggregate: InstanceAggregate; changes: RefreshChanges }) => void;
  /** 1.2：完整资料基线读取（预览与接纳分离；接纳时在写入锁内重读磁盘）。 */
  readBaseline?: (sourceRoot: string) => Promise<BaselineResult>;
  /** 1.2／1.3：Git 只读观察（HEAD、分支、未合并条目、工作区状态）。 */
  gitObserve?: (sourceRoot: string) => GitObservation;
  /** 1.3：历史 commit 树只读核对（逐字节比对候选与历史）。 */
  gitHistory?: (sourceRoot: string) => GitHistoryPort;
  /** 1.3：历史字节哈希复算（回退逐字节核对的等价形式）。 */
  sha256?: Sha256Fn;
}

/** Git 只读观察的最小形状（应用层不依赖 adapters 的具体实现）。 */
export interface GitObservation {
  available: boolean;
  repositoryRoot?: string;
  headCommit?: string;
  branch?: string;
  unmerged: boolean | 'unknown';
  dirty: boolean | 'unknown';
}

/** 历史 commit 树只读核对（应用层端口；实现在 adapters/fs/git-history）。 */
export interface GitHistoryPort {
  commitExists(commit: string): boolean;
  isAncestor(ancestor: string, descendant: string): boolean | 'unknown';
  commitFileBytes(commit: string, relativePath: string): Uint8Array | null;
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
  /** 1.1：本机仓库映射（repositoryId → 本机绝对路径）；按实例保存，复用登记时显式更新。 */
  repositoryMaps?: { repositoryId: string; absolutePath: string }[];
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
  /**
   * 1.2：预览阶段的候选观察。提供后 refresh 在写入锁内重读磁盘并与该观察逐项比较，
   * 失配返回 `source-observation-changed`；候选停写诊断需匹配的 `confirmFallback` 才能接纳。
   */
  preview?: RefreshPreview;
  /** 1.3：显式确认合法历史回退；commit 必须与预览给出的证据一致。 */
  confirmFallback?: { commit: string };
  /** 1.4：调用方读取基线时使用的资料根；与实例有效定位不一致即拒绝（外部编辑旧根不刷新新实例）。 */
  source?: string;
}

/** 预览刷新的候选观察（preview-refresh 输出、refresh 接纳输入的最小契约）。 */
export interface RefreshPreview {
  headHash: string;
  records: { recordId?: string; path: string; contentHash: string; observedHash: string }[];
  /** 预览诊断（index-loss／rewritten 等）；接纳时按此决定是否需要回退确认。 */
  diagnostics: LocalIssue[];
  /** 预览核实的合法历史回退证据；缺省表示无回退可用。 */
  fallback?: { commit: string; repositoryRoot: string };
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

/** 合法历史回退证据（1.3）：候选头与全部引用正文逐字节对应历史 commit 树。 */
export interface FallbackEvidence {
  commit: string;
  repositoryRoot: string;
  /** 逐字节核对通过的相对路径清单（含 project.json）。 */
  verifiedPaths: string[];
}

export interface PreviewRefreshResult {
  ok: true;
  root: LocalRootView;
  entry: RegistryEntry;
  /** 磁盘重读的候选基线（接纳时用于观察比较）。 */
  candidate: SourceBaseline;
  changes: RefreshChanges;
  /** 停写诊断：非空时接纳需要匹配的回退确认（1.2／1.3）。 */
  diagnostics: LocalIssue[];
  /** 预览核实的合法历史回退；仅当诊断需要回退且核对全部通过时出现。 */
  fallback?: FallbackEvidence;
}

/**
 * 观察比较（tasks 1.2）：以公开记录身份（recordId，缺失时 path）为键区分三种外部变化。
 * 追加记录允许（只推进状态修订）；丢索引项与同 ID 改写给出停写诊断。
 */
export function compareObservation(
  previous: ObservationBaseline | null,
  candidate: SourceBaseline,
): { changes: RefreshChanges; diagnostics: LocalIssue[] } {
  const previousKey = new Map<string, ObservationRecord>();
  for (const record of previous?.records ?? []) {
    previousKey.set(record.recordId ?? record.path, record);
  }
  const candidateKey = new Map<string, SourceBaseline['records'][number]>();
  for (const record of candidate.records) {
    candidateKey.set(record.recordId ?? record.path, record);
  }

  const recordsAdded: string[] = [];
  const recordsRemoved: string[] = [];
  const recordsChanged: string[] = [];
  const diagnostics: LocalIssue[] = [];

  for (const [key, record] of candidateKey) {
    const old = previousKey.get(key);
    if (old === undefined) {
      recordsAdded.push(record.path);
      continue;
    }
    if (old.contentHash !== record.contentHash) {
      recordsChanged.push(record.path);
      diagnostics.push({
        code: 'source-record-rewritten',
        message: `记录 ${key} 的正文哈希被改写（原 ${old.contentHash} → 现 ${record.contentHash}）；候选停写，需合法回退证据或修复资料后重取`,
        path: record.path,
      });
    }
  }
  for (const [key, old] of previousKey) {
    if (!candidateKey.has(key)) {
      recordsRemoved.push(old.path);
      diagnostics.push({
        code: 'source-index-loss',
        message: `已发布记录 ${key} 不在候选索引中（原路径 ${old.path}）；候选停写，需合法回退证据或修复资料后重取`,
        path: old.path,
      });
    }
  }

  return {
    changes: {
      initial: previous === null,
      headChanged: previous === null || previous.headHash !== candidate.headHash,
      planVersionChanged: previous === null || previous.planVersion !== candidate.planVersion,
      recordsAdded: recordsAdded.sort(),
      recordsRemoved: recordsRemoved.sort(),
      recordsChanged: recordsChanged.sort(),
    },
    diagnostics,
  };
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

/** 归一化仓库映射输入：去重、按 repositoryId 排序；同 id 重复取最后一次（显式更新语义）。 */
function normaliseRepositoryMaps(
  input: { repositoryId: string; absolutePath: string }[] | undefined,
  now: string,
): RepositoryMap[] {
  if (input === undefined) return [];
  const byId = new Map<string, string>();
  for (const item of input) {
    if (typeof item.repositoryId === 'string' && item.repositoryId.trim() !== ''
      && typeof item.absolutePath === 'string' && item.absolutePath.trim() !== '') {
      byId.set(item.repositoryId, item.absolutePath);
    }
  }
  return [...byId.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repositoryId, absolutePath]) => ({ repositoryId, absolutePath, updatedAt: now }));
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
      // 1.4：目标正被未结束迁移占用时拒绝登记——复制期间不得抢占目标。
      const occupant = migrationsOf(registry).find(
        (item) => isMigrationOpen(item.status) && item.to.root === request.sourceRoot,
      );
      if (occupant !== undefined) {
        return {
          ok: false as const,
          issues: [
            {
              code: 'migration-target-occupied',
              message: `目标正被实例 ${occupant.instanceId} 的迁移 ${occupant.operationId} 占用（状态 ${occupant.status}）；不抢占`,
              path: request.sourceRoot,
            },
          ],
        };
      }
      const existing = registry.instances.find((entry) => entry.sourceRoot === request.sourceRoot);
      if (existing !== undefined) {        if (existing.projectId !== request.projectId) {
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
        // 1.1：复用登记时显式提供映射即更新（不同副本各自保存，不共享、不猜路径）。
        const requestedMaps = normaliseRepositoryMaps(request.repositoryMaps, now);
        const nextAggregate: InstanceAggregate =
          requestedMaps.length > 0 ? { ...aggregate, repositoryMaps: requestedMaps } : aggregate;
        if (nextAggregate !== aggregate) {
          const saved = await this.deps.store.replaceAggregateChecked(rootView.root, nextAggregate);
          if (saved.status !== 'saved') {
            return {
              ok: false as const,
              issues: [
                {
                  code: saved.status === 'not-saved' ? 'local-state-write-failed' : 'unknown-state',
                  message: `仓库映射未确认（${saved.stage}）：${saved.detail ?? '本机状态未保存'}`,
                  path: rootView.root,
                },
              ],
            };
          }
        }
        return { ok: true as const, reused: true, entry: existing, aggregate: nextAggregate, root: rootView };
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
        conversations: { links: [], intents: [] },
        workIntents: [],
        workRuns: [],
        workSuggestions: [],
        operations: [],
        // 完整基线由显式刷新（3.5）建立；登记不写半截观察，避免被误当作已核查基线。
        lastObservation: null,
        repositoryMaps: normaliseRepositoryMaps(request.repositoryMaps, now),
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
   * 预览刷新（tasks 1.2／1.3）：锁外只读候选与旧观察比较，产出候选、差异、停写诊断与
   * 合法历史回退证据；不改基线。接纳走 refresh 并携带本结果的 preview 契约。
   */
  async previewRefresh(
    request: LocalRootRequest & { instanceId: string; source: string },
  ): Promise<LocalResult<PreviewRefreshResult>> {
    try {
      if (this.deps.readBaseline === undefined) {
        return { ok: false, issues: [{ code: 'baseline-reader-missing', message: '未装配资料基线读取依赖；无法预览刷新' }] };
      }
      const planned = planLocalRoot(request);
      if (!planned.ok) return { ok: false, issues: planned.issues };
      const resolved = this.deps.resolver.resolveLocal(planned.plan);
      if (!resolved.ok) return resolved;
      const rootPath = resolved.root.root;

      const registry = await this.deps.store.readRegistry(rootPath);
      const entry = registry.instances.find((item) => item.instanceId === request.instanceId);
      if (entry === undefined) {
        return {
          ok: false,
          issues: [{ code: 'registry-instance-not-found', message: `本机注册表中没有实例 ${request.instanceId}`, path: rootPath }],
        };
      }
      const aggregate = await this.deps.store.readAggregate(rootPath, entry.instanceId);
      if (aggregate === null) {
        return {
          ok: false,
          issues: [{ code: 'registry-aggregate-missing', message: '注册表指向的实例聚合缺失；不自动重建', path: rootPath }],
        };
      }

      // Git 只读观察（先于基线读取）：真实合并冲突遗留直接拒绝，修复后显式重取；
      // 冲突文件通常同时含冲突标记，不能让标记诊断抢在未合并条目之前。
      const gitView = this.deps.gitObserve?.(request.source);
      if (gitView?.unmerged === true) {
        return {
          ok: false,
          issues: [
            {
              code: 'git-unmerged',
              message: '工作副本存在未合并条目（Git 合并冲突遗留）；先解决冲突并提交，再重取资料',
              path: entry.sourceRoot,
            },
          ],
        };
      }

      const candidateResult = await this.deps.readBaseline(request.source);
      if (!candidateResult.ok) return { ok: false, issues: candidateResult.issues };
      const candidate = candidateResult.baseline;

      const gitObservation: GitObservation | undefined = candidate.git ?? gitView;

      const { changes, diagnostics } = compareObservation(aggregate.lastObservation, candidate);

      // 合法历史回退核对（1.3）：候选头与全部引用正文逐字节对应历史 commit 树才给出证据。
      const fallback = this.verifyFallback(aggregate.lastObservation, candidate, request.source, gitObservation);

      return {
        ok: true,
        root: resolved.root,
        entry,
        candidate,
        changes,
        diagnostics,
        ...(fallback === undefined ? {} : { fallback }),
      };
    } catch (error) {
      return failureOf(error);
    }
  }

  /** 预览与接纳之间的观察漂移比较：一致返回 null，漂移返回差异描述（1.2）。 */
  private previewDrifted(
    preview: RefreshPreview,
    current: SourceBaseline,
  ): string | null {
    if (preview.headHash !== current.headHash) return `头哈希 ${preview.headHash} → ${current.headHash}`;
    const keyOf = (record: { recordId?: string; path: string }): string => record.recordId ?? record.path;
    const previewRecords = new Map(preview.records.map((record) => [keyOf(record), record.observedHash]));
    const currentRecords = new Map(current.records.map((record) => [keyOf(record), record.observedHash]));
    for (const [key, hash] of previewRecords) {
      const now = currentRecords.get(key);
      if (now === undefined) return `记录 ${key} 已从候选索引移除`;
      if (now !== hash) return `记录 ${key} 正文哈希 ${hash} → ${now}`;
    }
    for (const key of currentRecords.keys()) {
      if (!previewRecords.has(key)) return `候选索引新增记录 ${key}`;
    }
    return null;
  }

  /** 回退证据核对：诊断非空时尝试把候选对齐到当前 HEAD 的真实历史；任何一步失配都不给证据。 */
  private verifyFallback(
    previous: ObservationBaseline | null,
    candidate: SourceBaseline,
    sourceRoot: string,
    gitObservation: GitObservation | undefined,
  ): FallbackEvidence | undefined {
    const { diagnostics } = compareObservation(previous, candidate);
    if (diagnostics.length === 0) return undefined;
    const sha256 = this.deps.sha256;
    const gitHistoryFactory = this.deps.gitHistory;
    if (sha256 === undefined || gitHistoryFactory === undefined) return undefined;

    const git = gitObservation ?? candidate.git;
    const commit = git?.headCommit;
    const repositoryRoot = git?.repositoryRoot;
    if (git?.available !== true || commit === undefined || repositoryRoot === undefined) return undefined;
    // 同一已映射仓库：先前观察记录过不同仓库根时拒绝。
    const previousRepoRoot = previous?.git?.repositoryRoot;
    if (previousRepoRoot !== undefined && previousRepoRoot !== repositoryRoot) return undefined;

    const history = gitHistoryFactory(sourceRoot);
    if (!history.commitExists(commit)) return undefined;

    // git show <commit>:./<path> 的 ./ 以 git 子进程 cwd（资料根）为基准，
    // 因此历史路径直接使用资料根相对路径，不再叠加仓库前缀。
    const verifiedPaths: string[] = [];
    const headBytes = history.commitFileBytes(commit, 'project.json');
    if (headBytes === null || sha256(headBytes) !== candidate.headHash.slice('sha256:'.length)) return undefined;
    verifiedPaths.push('project.json');
    for (const record of candidate.records) {
      const bytes = history.commitFileBytes(commit, record.path);
      if (bytes === null || sha256(bytes) !== record.observedHash.slice('sha256:'.length)) return undefined;
      verifiedPaths.push(record.path);
    }
    return { commit, repositoryRoot, verifiedPaths };
  }

  /**
   * 显式刷新（tasks 3.5）：以磁盘重读的完整基线更新本机观察与源代际。
   * 始终以磁盘为准，不复用旧缓存；项目身份变化时拒绝刷新，不覆盖既有聚合。
   * 1.2：提供 preview 时在写入锁内重读磁盘并与预览观察逐项比较（source-observation-changed）；
   * 预览存在停写诊断时，必须携带与证据一致的 confirmFallback 才能接纳（1.3）。
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
        // 1.4：实例存在未结束迁移时停写——复制期间到达的刷新收到 migration-in-progress。
        const openMigration = migrationsOf(registry).find(
          (item) => item.instanceId === entry.instanceId && isMigrationOpen(item.status),
        );
        if (openMigration !== undefined) {
          return {
            ok: false as const,
            issues: [
              {
                code: 'migration-in-progress',
                message: `实例迁移 ${openMigration.operationId} 进行中（状态 ${openMigration.status}）；完成或取消后再刷新`,
                path: openMigration.to.root,
              },
            ],
          };
        }
        // 1.4：调用方声明的来源与实例有效定位不一致即拒绝——外部编辑旧根不会刷新新实例。
        if (request.source !== undefined && request.source !== entry.sourceRoot) {
          return {
            ok: false as const,
            issues: [
              {
                code: 'source-location-mismatch',
                message: `提供的来源 ${request.source} 不是实例的有效定位 ${entry.sourceRoot}；旧根不刷新新实例，显式重接入请另行登记`,
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

        // 1.2：预览接纳两步——锁内重读磁盘并与预览观察逐项比较，预览与接纳之间被改动即拒绝。
        let effectiveBaseline: SourceBaseline = request.baseline;
        if (request.preview !== undefined) {
          if (this.deps.readBaseline === undefined) {
            return {
              ok: false as const,
              issues: [{ code: 'baseline-reader-missing', message: '未装配资料基线读取依赖；无法按预览接纳' }],
            };
          }
          const reread = await this.deps.readBaseline(entry.sourceRoot);
          if (!reread.ok) return { ok: false as const, issues: reread.issues };
          const current = reread.baseline;
          const drifted = this.previewDrifted(request.preview, current);
          if (drifted !== null) {
            return {
              ok: false as const,
              issues: [
                {
                  code: 'source-observation-changed',
                  message: `预览与接纳之间资料已变化（${drifted}）；重新预览后再接纳，不覆盖中间变化`,
                  path: entry.sourceRoot,
                },
              ],
            };
          }
          if (request.preview.diagnostics.length > 0) {
            const fallback = request.preview.fallback;
            if (fallback === undefined) {
              return { ok: false as const, issues: request.preview.diagnostics };
            }
            if (request.confirmFallback === undefined || request.confirmFallback.commit !== fallback.commit) {
              return {
                ok: false as const,
                issues: [
                  ...request.preview.diagnostics,
                  {
                    code: 'fallback-confirm-missing',
                    message: `候选需要显式确认合法历史回退（commit ${fallback.commit}）；未确认或与预览证据不一致`,
                    path: entry.sourceRoot,
                  },
                ],
              };
            }
            const history = this.deps.gitHistory?.(entry.sourceRoot);
            if (history !== undefined && !history.commitExists(fallback.commit)) {
              return {
                ok: false as const,
                issues: [
                  {
                    code: 'source-observation-changed',
                    message: `确认的回退 commit ${fallback.commit} 已不可解析；重新预览后再接纳`,
                    path: entry.sourceRoot,
                  },
                ],
              };
            }
          }
          effectiveBaseline = current;
        }

        const previous = aggregate.lastObservation;
        // 差异统一以公开记录身份比较、以协议路径输出（1.2 起与 compareObservation 一致）。
        const changes: RefreshChanges = compareObservation(previous, effectiveBaseline).changes;
        const observedAt = this.deps.clock();
        const nextAggregate: InstanceAggregate = {
          ...aggregate,
          source: { ...aggregate.source, generation: aggregate.source.generation + 1 },
          lastObservation: {
            planVersion: effectiveBaseline.planVersion,
            headHash: effectiveBaseline.headHash,
            records: effectiveBaseline.records.map((record) => ({
              recordId: record.recordId,
              path: record.path,
              contentHash: record.contentHash,
              observedHash: record.observedHash,
            })),
            git: {
              repositoryRoot: effectiveBaseline.git?.repositoryRoot,
              headCommit: effectiveBaseline.git?.headCommit,
            },
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
        // 刷新推进了源代际：对订阅者是替换边界，通知失败不改变刷新结果。
        try {
          this.deps.notify?.({ entry: nextEntry, aggregate: nextAggregate, changes });
        } catch {
          // 失效通知只是信号，订阅方仍会在下次回读时看到新基线。
        }
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
