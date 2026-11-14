// 应用层端口（design §5 核心接口）。这些是插件内部契约，不宣称为 DSH 已有方法；
// 实现分别在 adapters/（Node 侧）与 client/。
// 3.1 落地资料位置与基础接入所需端口；注册表、本机聚合与命令封套分别在 3.2／3.4 补。

import type { ProjectDocument, Sha256Fn, ValidationIssue } from '../domain/types.js';
import type { LocationIssue, LocationKind, LocationPlan, LocationRequest } from './location.js';
import type {
  InstanceAggregate,
  LocalRootPlan,
  LocalRootView,
  PrivateRootCheck,
  QuarantineInfo,
  Registry,
} from './local-state.js';

/** 资料源：选择、登记、读取与刷新公开资料根（位置解析见 LocationResolverPort；登记在 3.2）。 */
export interface ProjectSourcePort {
  /** 生成新的源代际；接入时核对项目身份，不隐式迁移。 */
  open(rootDescriptor: unknown): Promise<unknown>;
  /** 重读完整资料基线并返回明确刷新结果（第 3.5 段）。 */
  refresh(instanceId: string): Promise<unknown>;
}

/** 本机运行数据后端：独立文件型 LocalStatePort（design §2 决定，不用 storageDomain）。 */
export interface LocalStatePort {
  /** 单实例聚合替换：回执与双修订一次落盘；结果为 saved / not-saved / unknown-state。 */
  replaceInstanceAggregate(instanceId: string, aggregate: unknown): Promise<unknown>;
  readInstanceAggregate(instanceId: string): Promise<unknown>;
}

/** 聊天：本机多对多关联与打开实际聊天（第 6 段实现）。 */
export interface ConversationPort {
  link(link: unknown): Promise<unknown>;
  open(conversationId: string): Promise<unknown>;
}

/** 可信执行上下文：入口处捕获的只读判别联合（remote-owner | agent-work）。 */
export interface ExecutionContextPort {
  capture(): unknown;
  verify(captured: unknown): boolean;
}

/** 失效通知：快照订阅的只读失效流（第 5 段实现）。 */
export interface ChangeNotificationPort {
  publish(notification: unknown): void;
  subscribe(listener: (notification: unknown) => void): () => void;
}

/** 已解析的资料位置：绝对根 + 面向用户的显示路径（home 前缀折叠为 `~`）。 */
export interface LocationView {
  kind?: LocationKind;
  root: string;
  displayPath: string;
}

/** 位置解析端口：把定位计划落实成绝对路径，并拒绝非绝对、越界或不可用输入。 */
export interface LocationResolverPort {
  resolve(plan: LocationPlan): { ok: true; location: LocationView } | { ok: false; issues: LocationIssue[] };
  /** 已有资料根的显示形式（home 前缀折叠为 `~`）；不推断位置种类。 */
  describe(root: string): LocationView;
}

/** 资料根检查结果：只描述磁盘现状，不判定项目合法性（合法性由领域校验给出）。 */
export interface RootInspection {
  root: string;
  exists: boolean;
  isDirectory: boolean;
  /** 根目录第一层条目（文件名），用于判断非空目标；不存在时为空数组。 */
  entries: string[];
  hasProjectJson: boolean;
}

/** 公开资料文件端口：读写限定在用户选定的资料根；不含本机运行数据。 */
export interface SourceFilesPort {
  inspect(root: string): Promise<RootInspection>;
  /** 复制随包格式资源（README 模板／schema／协议正文与向量）并建立 records/。 */
  copyFormatAssets(root: string): Promise<void>;
  readDocument(
    root: string,
  ): Promise<{ ok: true; doc: ProjectDocument } | { ok: false; issues: ValidationIssue[] }>;
  /** 读取资料头原始字节（基线需要字节哈希，解析结果不代替原字节）。 */
  readHead(root: string): Promise<{ ok: true; bytes: Uint8Array; text: string } | { ok: false; issues: ValidationIssue[] }>;
  /** 读取根内单个文件（走范围校验）；用于引用正文。 */
  readScopedFile(
    root: string,
    relativePath: string,
  ): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; issues: ValidationIssue[] }>;
  writeDocument(
    root: string,
    doc: ProjectDocument,
    hooks?: PublishHooksPort,
  ): Promise<
    { ok: true; headHash: string } | { ok: false; status: 'not-published' | 'unknown'; issues: ValidationIssue[] }
  >;
  /** 渲染资料头文本与其哈希（用于 prepared 意图保存候选字节，发布前不含磁盘状态）。 */
  renderHead(doc: ProjectDocument): { text: string; headHash: string };
  /** 不可变正文写入（内容寻址）；已存在同字节为幂等，不同字节为冲突。 */
  writeBody(
    root: string,
    recordId: string,
    contentHash: string,
    bytes: Uint8Array,
    hooks?: PublishHooksPort,
  ): Promise<BodyWriteOutcome>;
}

/** 故障注入钩子（仅测试使用）；生产调用不传。 */
export interface PublishHooksPort {
  beforeTempWrite?: () => void | Promise<void>;
  beforeRename?: () => void | Promise<void>;
  afterRename?: () => void | Promise<void>;
  beforeReread?: () => void | Promise<void>;
}

export interface BodyWriteOutcome {
  status: 'written' | 'already-present' | 'conflict' | 'not-published' | 'unknown';
  /** 协议路径 `records/<recordId>/<contentHash-hex>.md`。 */
  path: string;
  detail?: string;
}

export type GitTrackState = 'tracked' | 'untracked' | 'ignored' | 'unknown';

/** Git 只读观察：不 commit、不 add、不改配置；拿不到时以 unknown 表达。 */
export interface GitStateView {
  available: boolean;
  repositoryRoot?: string;
  repositoryRootDisplay?: string;
  trackState: GitTrackState;
  dirty: boolean | 'unknown';
  reason?: 'git-unavailable' | 'not-a-repository' | 'probe-failed';
}

export interface GitObservePort {
  read(root: string): GitStateView;
}

/** 资料服务的依赖装配；id 与内容哈希由应用层注入（domain 不自取随机或加密实现）。 */
export interface SourceServiceDeps {
  location: LocationResolverPort;
  files: SourceFilesPort;
  git: GitObservePort;
  sha256: Sha256Fn;
  /** 应用层生成项目 id；测试可注入固定实现。 */
  newProjectId: () => string;
  /** 应用层生成节点 id（初始根节点与后续拆分）；测试可注入固定实现。 */
  newNodeId: () => string;
}

export type { LocationIssue, LocationKind, LocationPlan, LocationRequest };

/** 本机运行数据的稳定问题码（与公开资料问题分开，避免把私有失败混进资料诊断）。 */
export interface LocalIssue {
  code: string;
  message: string;
  path?: string;
}

export type RootRelation = 'same' | 'nested' | 'disjoint';

/** 本机根解析端口：绝对路径 + 显示路径 + 两个根的关系判定。 */
export interface LocalRootResolverPort {
  resolveLocal(plan: LocalRootPlan): { ok: true; root: LocalRootView } | { ok: false; issues: LocalIssue[] };
  /** 判断 source 与 local 是否相同、互相包含或互不相关（3.3 补 realpath 与大小写细节）。 */
  relation(sourceRoot: string, localRoot: string): RootRelation;
}

/** 私有根检查端口：本机根若在 Git 工作副本内，必须无已跟踪文件且被忽略。 */
export interface GitPrivateRootPort {
  inspect(localRoot: string): PrivateRootCheck;
}

/** 锁信息：只用于诊断与显式释放，不自动按超时抢占。 */
export interface LocalLockInfo {
  pid: number;
  hostname: string;
  token: string;
  acquiredAt: string;
  purpose?: string;
}

/** 本机状态文件端口：注册表、实例聚合与独占锁；不含公开资料读写。 */
export interface LocalStateStorePort {
  ensureDirs(localRoot: string): Promise<void>;
  readRegistry(localRoot: string): Promise<Registry>;
  writeRegistry(localRoot: string, registry: Registry): Promise<void>;
  readAggregate(localRoot: string, instanceId: string): Promise<InstanceAggregate | null>;
  writeAggregate(localRoot: string, aggregate: InstanceAggregate): Promise<void>;
  /** 三态替换（tasks 3.4）：saved／not-saved／unknown-state，不能把 unknown 当失败重试。 */
  replaceAggregateChecked(
    localRoot: string,
    aggregate: InstanceAggregate,
    hooks?: PublishHooksPort,
  ): Promise<{ status: 'saved' | 'not-saved' | 'unknown-state'; stage: string; detail?: string }>;
  /** 独占锁内执行；同进程重复写者或锁被占用时返回 false 与诊断，不等待、不抢占。 */
  withLock<T>(localRoot: string, run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; issues: LocalIssue[] }>;
  lockInfo(localRoot: string): Promise<LocalLockInfo | null>;
  /** 读隔离标记（只读诊断可用；不因聚合损坏而不可读）。 */
  readQuarantine(localRoot: string, instanceId: string): Promise<QuarantineInfo | null>;
  /** 写隔离标记：实例进入停止读写状态，直到显式解除。 */
  quarantine(localRoot: string, info: QuarantineInfo): Promise<void>;
  /** 解除隔离（调用方必须已取得用户明确的离线核对确认）。 */
  releaseQuarantine(localRoot: string, instanceId: string): Promise<boolean>;
  listQuarantined(localRoot: string): Promise<QuarantineInfo[]>;
  /** 显式释放遗留锁：需 force 或持有者 token 匹配；不提供自动超时释放。 */
  releaseLock(
    localRoot: string,
    options: { force?: boolean; expectedToken?: string },
  ): Promise<{ ok: true; released: boolean } | { ok: false; issues: LocalIssue[] }>;
}
