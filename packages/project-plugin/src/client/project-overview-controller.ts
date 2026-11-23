// 顶部项目概览控制器（R2 任务 2.2）：实例列表、选择、折叠态，
// 以及按实例隔离的 PanelController（草稿/选择/连接代际各自独立）。
// 不依赖 DOM/React，可脱离浏览器测试；渲染层只读状态、调方法。

import {
  PanelController, type IPanelController, type IngestOutcome, type PanelDraft, type PanelState,
  type SaveStatus, type StructurePreview, type MergeResolutionView, type UserTemplateView,
} from './panel-controller.js';
import type { PanelTransport, PresetView } from './api.js';
import { buildResume, type NextStepKind, type ResumePayload } from '../domain/resume.js';
import type {
  ResumeChatChoiceView,
  ResumeChatsResult,
  ResumeLinkResult,
  ResumeChatTargetResult,
  RegisterPreviewResult,
  RegisterSourceResult,
  MigrationOpResult,
  MigrationPreviewOpResult,
  MigrationListOpResult,
} from '../host/overview-service.js';
import type { LocationKind } from '../application/location.js';

/** client 侧视图：OwnerDenial 的 null 已在传输层归一为 rejected，不再出现在控制器输入。 */
export type RegisterPreviewView = Exclude<RegisterPreviewResult, null>;
export type RegisterSourceView = Exclude<RegisterSourceResult, null>;
export type MigrationOpView = Exclude<MigrationOpResult, null>;
export type MigrationPreviewOpView = Exclude<MigrationPreviewOpResult, null>;
export type MigrationListView = Exclude<MigrationListOpResult, null>;
import type { ResumeChatPointerView } from '../application/resume-chat.js';
import type { ChatsView, ConversationOutcome, SessionChoice } from '../application/conversations.js';
import type { WorkAction } from '../application/work.js';
import type { RoadmapEnableImpact, RoadmapStateView } from '../application/command-service.js';

/** client 侧结果：OwnerDenial 的 null 已在传输层归一为 rejected，不再出现在控制器输入。 */
type ResumeChatsView = Exclude<ResumeChatsResult, null>;
type ResumeLinkView = Exclude<ResumeLinkResult, null>;
type ResumeChatTargetView = Exclude<ResumeChatTargetResult, null>;

/** 代码观察视图（由 Host 只读观察投影）：历史验证之外的"待核对"呈现。 */
export type CodeObservationView =
  | { status: 'observed'; head: string; dirtyCount: number }
  | { status: 'not-configured' }
  | { status: 'unavailable'; reason: string };

/** 接续卡片视图（由 Host resumeCandidate 投影；chat 为本机聊天指针三态）。 */
export type ResumeCardView =
  | {
      status: 'card';
      recordId: string;
      /** 候选正文哈希；打开原聊天前按它复查记录版本。 */
      contentHash: string;
      payload: ResumePayload;
      codeObservation: CodeObservationView;
      chat: ResumeChatPointerView;
    }
  | { status: 'empty' }
  | { status: 'unread' }
  | { status: 'diagnostic'; code: string; message: string };

/** 接续保存草稿：全部为共享内容字段 + 本机聊天选择；operationId 复用以幂等重试。 */
export interface ResumeDraft {
  stoppedAt: string;
  nextStep: string;
  nextStepKind: NextStepKind;
  outcome: string;
  decisions: string;
  openIssues: string;
  /** 选中的本机聊天链接；null = 本次保存不关联聊天（公开摘要仍保存）。 */
  chatLinkId: string | null;
  operationId: string | null;
}

export type ResumeSaveStatus = 'idle' | 'saving' | 'saved' | 'partial' | 'failed' | 'conflict' | 'pending';

export interface ResumeSaveState {
  status: ResumeSaveStatus;
  code: string | null;
  message: string | null;
}

/** 部分保存：公开记录已提交，聊天指针未保存；就现有记录重试不产生第二条记录。 */
export interface ResumePartial {
  recordId: string;
  linkId: string;
}

/** 3.1 概览聊天行（本机链接投影）：用途为用户原文，不翻译。 */
export interface ChatLinkRow {
  linkId: string;
  sessionId: string;
  purpose: string;
  nodeIds: string[];
  /** 宿主列表可见性；null 表示目录不可用（未知，不冒充失效）。 */
  visible: boolean | null;
}

/** 3.1 可选会话（选择已有）：目录只读投影。 */
export interface ChatSessionRow {
  sessionId: string;
  blank: boolean;
  running: boolean;
  updatedAt: number;
  linked: boolean;
}

/** 3.1 待核对意图：候选只供显式认领，不自动写入。 */
export interface PendingChatRow {
  operationId: string;
  action: 'create' | 'claim';
  nodeIds: string[];
  purpose: string;
  status: 'pending' | 'unknown';
  createdAt: string;
  detail?: string;
  candidates?: string[];
}

/** 3.1 概览聊天区状态：列表、可选会话、待核对与最近一次操作诊断。 */
export interface ChatsState {
  phase: 'idle' | 'loading' | 'ready' | 'unavailable';
  links: ChatLinkRow[];
  sessions: ChatSessionRow[];
  pending: PendingChatRow[];
  reason: string | null;
  notice: { code: string; message: string } | null;
  /** 正在提交创建／关联／解绑（防重复点击）。 */
  busy: boolean;
}

/** 重绑草稿：卡片的记录身份；下一次创建／关联成功后把指针指过去。 */
export interface RebindDraft {
  recordId: string;
  contentHash: string;
}

// ---------- 3.2：配置实例上的项目工作 ----------

/** 预览目标（条件、直接依赖与已知性）。 */
export interface WorkPreviewTargetView {
  id: string;
  known: boolean;
  title?: string;
  status?: string;
  goal?: string;
  completionCriteria?: string[];
  dependsOn: Array<{ id: string; known: boolean; title?: string }>;
  requiredBy: Array<{ id: string; known: boolean; title?: string }>;
}

export type WorkContextItemKind = 'decision' | 'suggestion' | 'unverified';

/** 预览上下文（与运行上下文同源同口径；只读，不构成授权）。 */
export interface WorkPreviewView {
  sessionId: string;
  targets: WorkPreviewTargetView[];
  constraints: { allowedActions: WorkAction[]; reasonScope: 'public' | 'local' };
  baseline: { planVersion: string; planRevision: number; sourceEpoch: number };
  sourceEpoch: number | null;
  publicRecords: Array<{ id: string; kind: string; summary: string; path: string; subjectNodeIds: string[] }>;
  chatEntries: Array<{ linkId: string; sessionId: string; purpose: string; origin: string }>;
  backgroundNodeIds: string[];
  items: Array<{ kind: WorkContextItemKind; source: string; text: string; nodeIds?: string[] }>;
  generatedAt: string;
}

/** 工作草稿：确认前的范围（会话、目标、动作、目的与输入基线）。 */
export interface WorkDraft {
  sessionId: string;
  purpose: string;
  actions: WorkAction[];
  reasonScope: 'public' | 'local';
  nodeIds: string[];
  workIntentId: string;
}

export interface WorkState {
  phase: 'idle' | 'previewing' | 'previewed' | 'preparing' | 'awaiting-message' | 'error';
  draft: WorkDraft | null;
  preview: WorkPreviewView | null;
  notice: { code: string; message: string } | null;
  /** 已确认范围：在该会话发送下一条消息后由真实消费边界生效。 */
  started: { workIntentId: string; sessionId: string } | null;
}

const EMPTY_WORK: WorkState = {
  phase: 'idle',
  draft: null,
  preview: null,
  notice: null,
  started: null,
};

export const WORK_ACTION_OPTIONS: readonly WorkAction[] = ['update', 'record', 'status', 'add', 'split', 'dependencies', 'move', 'insert'];

const EMPTY_CHATS: ChatsState = {
  phase: 'idle',
  links: [],
  sessions: [],
  pending: [],
  reason: null,
  notice: null,
  busy: false,
};

/** 4.2：路线图区状态。v1 为“未启用 + 空里程碑”；预览持有确认摘要与原 operationId。 */
export interface RoadmapState {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  /** 当前资料的路线图投影；null 表示尚未读取。 */
  view: RoadmapStateView | null;
  /** 启用预览：确认摘要与原 operationId（重试复用，不产生第二次发布）。 */
  preview: { impact: RoadmapEnableImpact; operationId: string } | null;
  notice: { code: string; message: string } | null;
  busy: boolean;
}

const EMPTY_ROADMAP: RoadmapState = {
  phase: 'idle',
  view: null,
  preview: null,
  notice: null,
  busy: false,
};

/** 聊天写入结果（与 ConversationOutcome 同形，client 只读投影）。 */
export type ChatMutationView<S> =
  | { status: 'committed'; value: S; stateRevision: number }
  | { status: 'rejected'; code: string; message: string }
  | { status: 'unknown-state'; code: string; message: string; stage: string };

/** 概览聊天读取结果（chats）：与宿主 OverviewChatsResult 同形。 */
export type OverviewChatsView = ChatMutationView<ChatsView> | { status: 'rejected'; code: string; message: string };

export type RebindResumeView =
  | { status: 'linked'; recordId: string; linkId: string; sessionId: string; purpose: string; reusedLink: boolean }
  | { status: 'rejected'; code: string; message: string };

const EMPTY_DRAFT: ResumeDraft = {
  stoppedAt: '',
  nextStep: '',
  nextStepKind: 'suggested',
  outcome: '',
  decisions: '',
  openIssues: '',
  chatLinkId: null,
  operationId: null,
};

export interface OverviewRow {
  instanceId: string;
  projectId: string;
  readable: boolean;
  sourceDisplay?: string;
  sourceKind?: string;
  sourceEpoch?: number;
  code?: string;
  message?: string;
  /** 3.1：是否为宿主启动配置实例；false 时界面提示项目工作入口不可用。 */
  configured?: boolean;
}

export type OverviewListResult =
  | { status: 'listed'; instances: OverviewRow[] }
  | { status: 'unconfigured'; message: string }
  | { status: 'rejected'; code: string; message: string };

/** client 侧迁移记录视图（host migrationList 投影；requestDigest 用于重复确认核对）。 */
export interface MigrationRecordView {
  operationId: string;
  requestDigest: string;
  instanceId: string;
  projectId: string;
  from: { root: string; kind: string; expectedGeneration: number };
  to: { root: string; kind: string };
  newGeneration: number;
  status: string;
  receipt?: { operationId: string; committedAt: string; sourceGeneration: number; effectiveRoot: string };
  cancel?: { at: string; removed: string[] };
  createdAt: string;
  updatedAt: string;
}

/** 1.5：迁移操作面板状态：预览 → 确认/取消/恢复，宿主结果原样投影。 */
export interface MigrationState {
  phase: 'idle' | 'busy' | 'ready' | 'error';
  /** 上一次预览结果（checks 含占用／重叠／工作守卫诊断）。 */
  preview: MigrationPreviewOpView | null;
  /** 最近一次迁移操作返回的记录（prepared/target-ready/switched/committed/canceled）。 */
  record: MigrationRecordView | null;
  /** 全部迁移记录（诊断与恢复入口）。 */
  migrations: MigrationRecordView[];
  message: string | null;
  code: string | null;
}

/** 1.1：接入登记面板状态：预览（位置／Git／项目 ID／版本）→ 显式登记。 */
export interface RegisterState {
  phase: 'idle' | 'busy' | 'ready' | 'error';
  preview: RegisterPreviewResult | null;
  message: string | null;
  code: string | null;
}

const EMPTY_MIGRATION: MigrationState = {
  phase: 'idle',
  preview: null,
  record: null,
  migrations: [],
  message: null,
  code: null,
};

const EMPTY_REGISTER: RegisterState = {
  phase: 'idle',
  preview: null,
  message: null,
  code: null,
};

export interface OverviewControllerDeps {
  /** 列出已登记实例（conaOverview/instances）。 */
  listInstances: () => Promise<OverviewListResult>;
  /** 读取所选实例的接续卡片（conaOverview/resumeCandidate）。 */
  readResumeCard: (instanceId: string) => Promise<ResumeCardView>;
  /** 保存表单的聊天选项（conaOverview/resumeChats）。 */
  listResumeChats: (instanceId: string) => Promise<ResumeChatsView>;
  /** 保存聊天指针（conaOverview/linkResume）；失败不影响已提交的公开记录。 */
  linkResume: (instanceId: string, recordId: string, linkId: string) => Promise<ResumeLinkView>;
  /** 打开原聊天前复查（conaOverview/resumeChatTarget）。 */
  resolveChatTarget: (instanceId: string, recordId: string, contentHash: string, linkId: string) => Promise<ResumeChatTargetView>;
  /** 宿主导航打开会话（uiWorkspace.openSession；仅 DSH 导航，不带任何执行绑定）。 */
  openSession: (sessionId: string) => void;
  /** 为指定实例构造独立 transport（A→conaProject，B→conaOverview）。 */
  transportFor: (instanceId: string) => PanelTransport;
  newOperationId: () => string;
  /** 1.5：迁移预览（conaOverview/migrationPreview；宿主未装配时 unavailable）。 */
  migrationPreview?: (instanceId: string, toRoot: string, toKind: LocationKind) => Promise<MigrationPreviewOpView>;
  /** 1.5：迁移确认（conaOverview/migrationRun）。 */
  migrationRun?: (instanceId: string, toRoot: string, toKind: LocationKind, operationId?: string) => Promise<MigrationOpView>;
  /** 1.5：迁移恢复（conaOverview/migrationRecover；确认摘要核对原操作）。 */
  migrationRecover?: (instanceId: string, operationId: string, confirmDigest: string) => Promise<MigrationOpView>;
  /** 1.5：迁移取消（conaOverview/migrationCancel；未切换才可取消）。 */
  migrationCancel?: (instanceId: string, operationId: string, confirmDigest: string) => Promise<MigrationOpView>;
  /** 1.5：迁移记录列表（conaOverview/migrationList）。 */
  migrationList?: () => Promise<MigrationListView>;
  /** 1.1：接入预览（conaOverview/registerPreview）。 */
  registerPreview?: (sourceRoot: string) => Promise<RegisterPreviewView>;
  /** 1.1：显式登记（conaOverview/registerSource；预览后由 owner 确认）。 */
  registerSource?: (request: { sourceRoot: string; sourceKind: LocationKind; projectId: string }) => Promise<RegisterSourceView>;
  /** 3.1：按实例读取本机聊天链接与待核对意图（conaOverview/chats）。 */
  listChats?: (instanceId: string) => Promise<ConversationOutcome<ChatsView> | { status: 'rejected'; code: string; message: string }>;
  /** 3.1：可选会话（conaOverview/chatSessions；选择已有）。 */
  listChatSessions?: (instanceId: string) => Promise<
    ConversationOutcome<{ sessions: SessionChoice[] }> | { status: 'rejected'; code: string; message: string }
  >;
  /** 3.1：创建聊天（宿主可能复用空白会话）。 */
  createChat?: (request: {
    instanceId: string; operationId: string; nodeIds: string[]; purpose: string;
  }) => Promise<ChatMutationView<{ sessionId: string; linkId: string; reusedBlank: boolean }>>;
  /** 3.1：关联已有会话（核对宿主可见性）。 */
  linkChat?: (request: {
    instanceId: string; operationId: string; sessionId: string; nodeIds: string[]; purpose: string;
  }) => Promise<ChatMutationView<{ linkId: string; reused: boolean }>>;
  /** 3.1：认领待核对候选。 */
  claimChat?: (request: {
    instanceId: string; operationId: string; sessionId: string; nodeIds: string[]; purpose: string;
  }) => Promise<ChatMutationView<{ linkId: string; reusedBlank: boolean }>>;
  /** 3.1：解除关联（缺省整条）。 */
  unlinkChat?: (request: { instanceId: string; operationId: string; linkId: string }) => Promise<ChatMutationView<{ removed: boolean }>>;
  /** 3.1：打开前复查链接与宿主实际 Session。 */
  resolveChatLinkTarget?: (instanceId: string, linkId: string) => Promise<ChatMutationView<{ sessionId: string }>>;
  /** 3.1：接续卡片显式重绑（建立／复用链接后写指针）。 */
  rebindResumeChat?: (request: {
    instanceId: string; recordId: string; contentHash: string;
    mode: 'create' | 'link'; sessionId?: string; purpose: string;
  }) => Promise<RebindResumeView>;
  /** 3.2：工作预览（conaOverview/workPreview；只读）。 */
  workPreview?: (request: {
    instanceId: string; sessionId: string; nodeIds: string[]; allowedActions: WorkAction[];
    reasonScope: 'public' | 'local'; purpose: string;
    baseline: { planVersion: string; planRevision: number; sourceEpoch: number };
  }) => Promise<ChatMutationView<WorkPreviewView> | { status: 'rejected'; code: string; message: string }>;
  /** 3.2：登记意图（conaOverview/workPrepare）。 */
  workPrepare?: (request: {
    instanceId: string; workIntentId: string; nodeIds: string[]; allowedActions: WorkAction[];
    reasonScope: 'public' | 'local'; purpose: string;
    baseline: { planVersion: string; planRevision: number; sourceEpoch: number };
  }) => Promise<ChatMutationView<{ workIntentId: string; reused: boolean }>>;
  /** 3.2：确认范围（conaOverview/workStart；不预填 rpcId）。 */
  workStart?: (request: { instanceId: string; workIntentId: string; sessionId: string }) => Promise<
    ChatMutationView<{ workIntentId: string; status: 'awaiting-message' }>
  >;
  /** 4.2：路线图只读状态（conaOverview/roadmap）。 */
  readRoadmap?: (instanceId: string) => Promise<
    { status: 'ok'; roadmap: RoadmapStateView } | { status: 'rejected'; code: string; message: string }
  >;
  /** 4.2：启用扩展规划预览（conaOverview/roadmapPreview；只读）。 */
  previewRoadmapEnable?: (instanceId: string) => Promise<
    { status: 'available'; impact: RoadmapEnableImpact } | { status: 'rejected'; code: string; message: string }
  >;
}

export interface OverviewState {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  instances: OverviewRow[];
  selectedId: string | null;
  expanded: boolean;
  message: string | null;
  /** 未配置/拒绝的稳定码（用于诊断展示）。 */
  code: string | null;
  /** 当前选中实例的接续卡片；null 表示尚未读取。 */
  resumeCard: ResumeCardView | null;
  /** 接续保存草稿；null 表示未在编辑。切换实例即丢弃。 */
  resumeDraft: ResumeDraft | null;
  /** 接续保存回执状态。 */
  resumeSave: ResumeSaveState;
  /** 保存表单的聊天选项（打开表单时读取）。 */
  resumeChats: { phase: 'idle' | 'loading' | 'ready' | 'unavailable'; chats: ResumeChatChoiceView[]; reason: string | null };
  /** 部分保存：公开记录已提交、聊天指针未保存。 */
  resumePartial: ResumePartial | null;
  /** 打开原聊天失败提示（稳定码）。 */
  chatNotice: { code: string; message: string } | null;
  /** 3.1：本机聊天区（链接、可选会话、待核对与诊断）。 */
  chats: ChatsState;
  /** 3.1：重绑草稿（卡片记录身份）；下一次创建／关联成功后写指针。 */
  rebindDraft: RebindDraft | null;
  /** 3.2：配置实例的项目工作（草稿、预览、确认与等待消息状态）。 */
  work: WorkState;
  /** 4.2：路线图区（v1 空态、启用预览与发布状态）。 */
  roadmap: RoadmapState;
  /** 1.5：迁移操作状态（预览／确认／取消／恢复）。 */
  migration: MigrationState;
  /** 1.1：接入登记状态（预览与显式登记）。 */
  register: RegisterState;
}

const EMPTY: OverviewState = {
  phase: 'idle',
  instances: [],
  selectedId: null,
  expanded: false,
  message: null,
  code: null,
  resumeCard: null,
  resumeDraft: null,
  resumeSave: { status: 'idle', code: null, message: null },
  resumeChats: { phase: 'idle', chats: [], reason: null },
  resumePartial: null,
  chatNotice: null,
  chats: EMPTY_CHATS,
  rebindDraft: null,
  work: EMPTY_WORK,
  roadmap: EMPTY_ROADMAP,
  migration: EMPTY_MIGRATION,
  register: EMPTY_REGISTER,
};

export class ProjectOverviewController {
  private state: OverviewState = EMPTY;
  private readonly listeners = new Set<(state: OverviewState) => void>();
  /** 每实例独立的面板控制器；切实例不共享草稿/基线/连接代际。 */
  private readonly byInstance = new Map<string, PanelController>();

  constructor(private readonly deps: OverviewControllerDeps) {}

  getState(): OverviewState {
    return this.state;
  }

  subscribe(listener: (state: OverviewState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private patch(change: Partial<OverviewState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener(this.state);
  }

  /** 读取实例列表；只读、不自动展开。已选实例仍在则保留。 */
  async load(): Promise<void> {
    this.patch({ phase: 'loading', message: null, code: null });
    let result: OverviewListResult;
    try {
      result = await this.deps.listInstances();
    } catch (error) {
      this.patch({ phase: 'error', message: (error as Error).message, code: 'transport-failed' });
      return;
    }
    if (result.status === 'rejected' || result.status === 'unconfigured') {
      this.patch({ phase: 'error', message: result.message, code: result.status === 'rejected' ? result.code : 'unconfigured' });
      return;
    }
    const instances = result.instances;
    const stillPresent = instances.some((row) => row.instanceId === this.state.selectedId);
    const firstReadable = instances.find((row) => row.readable)?.instanceId ?? null;
    const selected = stillPresent ? this.state.selectedId : firstReadable;
    this.patch({
      phase: 'ready',
      instances,
      selectedId: selected,
      resumeCard: selected === null ? null : this.state.selectedId === selected ? this.state.resumeCard : null,
    });
    if (selected !== null && !stillPresent) {
      void this.loadResumeCard(selected);
      void this.loadRoadmap(selected);
    }
    if (selected !== null) void this.loadChats(selected);
  }

  /** 顶部按钮：展开/收起。首次展开时读取列表。 */
  async toggle(): Promise<void> {
    const next = !this.state.expanded;
    this.patch({ expanded: next });
    if (next && this.state.phase !== 'ready') await this.load();
  }

  /** 键盘 Escape：收起，返回焦点由渲染层处理。 */
  collapse(): void {
    this.patch({ expanded: false });
  }

  /** 选择实例；只接受已登记且可读的行。切换时清旧卡片与接续编辑状态并读取新卡片。 */
  select(instanceId: string): boolean {
    const row = this.state.instances.find((item) => item.instanceId === instanceId);
    if (row === undefined || !row.readable) return false;
    if (this.state.selectedId === instanceId) return true;
    this.patch({
      selectedId: instanceId,
      resumeCard: null,
      resumeDraft: null,
      resumeSave: { status: 'idle', code: null, message: null },
      resumeChats: { phase: 'idle', chats: [], reason: null },
      resumePartial: null,
      chatNotice: null,
      chats: EMPTY_CHATS,
      rebindDraft: null,
      work: EMPTY_WORK,
      roadmap: EMPTY_ROADMAP,
      migration: EMPTY_MIGRATION,
      register: EMPTY_REGISTER,
    });
    void this.loadResumeCard(instanceId);
    void this.loadChats(instanceId);
    void this.loadRoadmap(instanceId);
    return true;
  }

  /** 4.2：读取路线图状态。未装配或读取失败都保留稳定码，不把“读不到”显示成“未启用”。 */
  async loadRoadmap(instanceId: string): Promise<void> {
    if (this.deps.readRoadmap === undefined) {
      if (this.state.selectedId === instanceId) {
        this.patch({
          roadmap: { ...EMPTY_ROADMAP, phase: 'error', notice: { code: 'roadmap-unavailable', message: '' } },
        });
      }
      return;
    }
    if (this.state.selectedId === instanceId) {
      this.patch({ roadmap: { ...this.state.roadmap, phase: 'loading', notice: null } });
    }
    try {
      const result = await this.deps.readRoadmap(instanceId);
      if (this.state.selectedId !== instanceId) return;
      if (result.status === 'ok') {
        this.patch({ roadmap: { phase: 'ready', view: result.roadmap, preview: null, notice: null, busy: false } });
        return;
      }
      this.patch({
        roadmap: { phase: 'error', view: null, preview: null, notice: { code: result.code, message: result.message }, busy: false },
      });
    } catch (error) {
      if (this.state.selectedId !== instanceId) return;
      this.patch({
        roadmap: {
          phase: 'error', view: null, preview: null,
          notice: { code: 'transport-failed', message: (error as Error).message }, busy: false,
        },
      });
    }
  }

  /** 4.2：启用扩展规划预览（只读）；成功后持有确认摘要与原 operationId。 */
  async beginRoadmapEnable(): Promise<void> {
    const instanceId = this.state.selectedId;
    if (instanceId === null || this.state.roadmap.busy || this.state.roadmap.preview !== null) return;
    if (this.deps.previewRoadmapEnable === undefined) {
      this.patch({ roadmap: { ...this.state.roadmap, notice: { code: 'roadmap-unavailable', message: '' } } });
      return;
    }
    this.patch({ roadmap: { ...this.state.roadmap, busy: true, notice: null } });
    try {
      const result = await this.deps.previewRoadmapEnable(instanceId);
      if (this.state.selectedId !== instanceId) return;
      if (result.status !== 'available') {
        this.patch({
          roadmap: { ...this.state.roadmap, busy: false, notice: { code: result.code, message: result.message } },
        });
        return;
      }
      this.patch({
        roadmap: {
          ...this.state.roadmap,
          busy: false,
          notice: null,
          preview: { impact: result.impact, operationId: this.deps.newOperationId() },
        },
      });
    } catch (error) {
      if (this.state.selectedId !== instanceId) return;
      this.patch({
        roadmap: { ...this.state.roadmap, busy: false, notice: { code: 'transport-failed', message: (error as Error).message } },
      });
    }
  }

  /** 取消启用：丢弃预览与摘要；资料未写，重新预览会得到新的 operationId。 */
  cancelRoadmapEnable(): void {
    if (this.state.roadmap.preview === null) return;
    this.patch({ roadmap: { ...this.state.roadmap, preview: null, notice: null } });
  }

  /**
   * 4.2：确认启用（owner 显式发布 v2）。
   * 先按新快照核对预览基线，再用原 operationId 提交；成功后刷新路线图与接续卡片。
   * 待核对保留预览与原操作 id，重试只核对不产生第二次发布。
   */
  async confirmRoadmapEnable(): Promise<void> {
    const instanceId = this.state.selectedId;
    const preview = this.state.roadmap.preview;
    if (instanceId === null || preview === null || this.state.roadmap.busy) return;
    this.patch({ roadmap: { ...this.state.roadmap, busy: true, notice: null } });
    const transport = this.deps.transportFor(instanceId);
    let baseline;
    try {
      baseline = await transport.snapshot({ connectionGeneration: 0 });
    } catch (error) {
      if (this.state.selectedId !== instanceId) return;
      this.patch({
        roadmap: { ...this.state.roadmap, busy: false, notice: { code: 'transport-failed', message: (error as Error).message } },
      });
      return;
    }
    if (this.state.selectedId !== instanceId) return;
    if (baseline.status !== 'snapshot') {
      const code = baseline.status === 'rejected' ? baseline.code : `unsynced-${baseline.reason}`;
      const message = baseline.status === 'rejected' ? baseline.message : baseline.detail;
      this.patch({ roadmap: { ...this.state.roadmap, busy: false, notice: { code, message } } });
      return;
    }
    const snap = baseline.snapshot;
    // 本地先核对：预览后规划已变就不要带旧摘要提交，直接要求重新预览。
    if (snap.planVersion !== preview.impact.current.planVersion) {
      this.patch({
        roadmap: { ...this.state.roadmap, busy: false, preview: null, notice: { code: 'preview-mismatch', message: '' } },
      });
      return;
    }
    let result;
    try {
      result = await transport.execute({
        operationId: preview.operationId,
        command: { type: 'enable-roadmap', previewDigest: preview.impact.previewDigest },
        expectedPlanVersion: snap.planVersion,
        expectedPlanRevision: snap.planRevision,
        sourceEpoch: snap.sourceEpoch,
      });
    } catch (error) {
      if (this.state.selectedId !== instanceId) return;
      this.patch({
        roadmap: { ...this.state.roadmap, busy: false, notice: { code: 'transport-failed', message: (error as Error).message } },
      });
      return;
    }
    if (this.state.selectedId !== instanceId) return;
    if (result.status === 'committed') {
      this.patch({ roadmap: { ...this.state.roadmap, busy: false, preview: null, notice: null } });
      void this.loadRoadmap(instanceId);
      // 验证记录转为历史：接续卡片的代码观察与验证状态需要重读。
      void this.loadResumeCard(instanceId);
      return;
    }
    if (result.status === 'pending-reconciliation') {
      this.patch({
        roadmap: { ...this.state.roadmap, busy: false, notice: { code: result.stage, message: result.message } },
      });
      return;
    }
    // 拒绝：预览与摘要可能已过期，清掉并提示重新预览（原 operationId 的拒绝会按幂等重放）。
    this.patch({
      roadmap: { ...this.state.roadmap, busy: false, preview: null, notice: { code: result.code, message: result.message } },
    });
  }

  /** 读取当前选中实例的接续卡片；任何失败显示为诊断，不影响实例选择。 */
  async loadResumeCard(instanceId: string): Promise<void> {
    try {
      const card = await this.deps.readResumeCard(instanceId);
      // 只接受当前仍选中的实例结果，丢弃切换后的迟到响应（design §2 代际）。
      if (this.state.selectedId !== instanceId) return;
      this.patch({ resumeCard: card });
    } catch (error) {
      if (this.state.selectedId !== instanceId) return;
      this.patch({ resumeCard: { status: 'diagnostic', code: 'transport-failed', message: (error as Error).message } });
    }
  }

  /** 开始写接续：清空草稿（不预填旧卡片，新停点应新写）并读取聊天选项。 */
  editResume(): void {
    if (this.state.selectedId === null) return;
    this.patch({
      resumeDraft: { ...EMPTY_DRAFT },
      resumeSave: { status: 'idle', code: null, message: null },
      resumePartial: null,
      chatNotice: null,
      resumeChats: { phase: 'loading', chats: [], reason: null },
    });
    void this.loadResumeChats(this.state.selectedId);
  }

  /** 读取当前实例的本机聊天链接（保存表单选项）；本机状态不可读给 unavailable。 */
  async loadResumeChats(instanceId: string): Promise<void> {
    try {
      const result = await this.deps.listResumeChats(instanceId);
      if (this.state.selectedId !== instanceId) return;
      if (result.status === 'listed') {
        this.patch({ resumeChats: { phase: 'ready', chats: result.chats, reason: null } });
        return;
      }
      const reason = result.status === 'unavailable'
        ? result.reason
        : `${result.code}: ${result.message}`;
      this.patch({ resumeChats: { phase: 'unavailable', chats: [], reason } });
    } catch (error) {
      if (this.state.selectedId !== instanceId) return;
      this.patch({ resumeChats: { phase: 'unavailable', chats: [], reason: `transport-failed: ${(error as Error).message}` } });
    }
  }

  /** 修改草稿字段。 */
  patchResumeDraft(patch: Partial<Omit<ResumeDraft, 'operationId'>>): void {
    if (this.state.resumeDraft === null) return;
    this.patch({ resumeDraft: { ...this.state.resumeDraft, ...patch } });
  }

  // ---------- 1.5：迁移操作 ----------

  private requireMigrationDeps(): boolean {
    if (
      this.deps.migrationPreview === undefined ||
      this.deps.migrationRun === undefined ||
      this.deps.migrationRecover === undefined ||
      this.deps.migrationCancel === undefined ||
      this.deps.migrationList === undefined
    ) {
      this.patch({ migration: { ...EMPTY_MIGRATION, phase: 'error', message: null, code: 'migration-unavailable' } });
      return false;
    }
    return true;
  }

  private migrationFailure(code: string, message: string, record?: MigrationRecordView | null): MigrationState {
    return {
      ...EMPTY_MIGRATION,
      phase: 'error',
      preview: this.state.migration.preview,
      migrations: this.state.migration.migrations,
      ...(record === undefined || record === null ? {} : { record }),
      code,
      message,
    };
  }

  private migrationFromOutcome(result: MigrationOpView, fallbackCode: string): MigrationState {
    if ('status' in result) {
      // rejected（owner 准入已归一）或 unavailable（宿主未装配迁移服务）。
      return result.status === 'unavailable'
        ? this.migrationFailure('migration-unavailable', result.message)
        : this.migrationFailure(result.code, result.message);
    }
    if (result.ok === false) {
      const first = result.issues[0];
      return this.migrationFailure(first?.code ?? fallbackCode, result.issues.map((issue) => issue.message).join('；'), result.record ?? null);
    }
    return {
      ...EMPTY_MIGRATION,
      phase: 'ready',
      preview: this.state.migration.preview,
      migrations: this.state.migration.migrations,
      record: result.record as MigrationRecordView,
      code: null,
      message: null,
    };
  }

  /** 迁移预览：只读；checks 的占用／重叠／工作守卫诊断由渲染层展示。 */
  async previewMigration(toRoot: string, toKind: LocationKind): Promise<void> {
    const instanceId = this.state.selectedId;
    if (instanceId === null || !this.requireMigrationDeps()) return;
    this.patch({ migration: { ...EMPTY_MIGRATION, phase: 'busy', migrations: this.state.migration.migrations } });
    try {
      const preview = await this.deps.migrationPreview!(instanceId, toRoot, toKind);
      if (this.state.selectedId !== instanceId) return;
      this.patch({ migration: { ...EMPTY_MIGRATION, phase: 'ready', preview, migrations: this.state.migration.migrations } });
    } catch (error) {
      if (this.state.selectedId !== instanceId) return;
      this.patch({ migration: this.migrationFailure('transport-failed', (error as Error).message) });
    }
  }

  /** 迁移确认：事务化执行；中断时保留 record（恢复入口）。 */
  async runMigration(toRoot: string, toKind: LocationKind, operationId?: string): Promise<void> {
    const instanceId = this.state.selectedId;
    if (instanceId === null || !this.requireMigrationDeps()) return;
    this.patch({ migration: { ...EMPTY_MIGRATION, phase: 'busy', preview: this.state.migration.preview, migrations: this.state.migration.migrations } });
    try {
      const result = await this.deps.migrationRun!(instanceId, toRoot, toKind, operationId);
      if (this.state.selectedId !== instanceId) return;
      this.patch({ migration: this.migrationFromOutcome(result, 'migration-failed') });
    } catch (error) {
      if (this.state.selectedId !== instanceId) return;
      this.patch({ migration: this.migrationFailure('transport-failed', (error as Error).message) });
    }
  }

  /** 迁移恢复（重启后继续／补齐）：确认摘要与登记的原请求摘要核对。 */
  async recoverMigration(operationId: string, confirmDigest: string): Promise<void> {
    const instanceId = this.state.selectedId;
    if (instanceId === null || !this.requireMigrationDeps()) return;
    this.patch({ migration: { ...EMPTY_MIGRATION, phase: 'busy', preview: this.state.migration.preview, migrations: this.state.migration.migrations } });
    try {
      const result = await this.deps.migrationRecover!(instanceId, operationId, confirmDigest);
      if (this.state.selectedId !== instanceId) return;
      this.patch({ migration: this.migrationFromOutcome(result, 'migration-recover-failed') });
    } catch (error) {
      if (this.state.selectedId !== instanceId) return;
      this.patch({ migration: this.migrationFailure('transport-failed', (error as Error).message) });
    }
  }

  /** 迁移取消：未切换才可取消；只清理有所有权证据且内容核对过的候选。 */
  async cancelMigration(operationId: string, confirmDigest: string): Promise<void> {
    const instanceId = this.state.selectedId;
    if (instanceId === null || !this.requireMigrationDeps()) return;
    this.patch({ migration: { ...EMPTY_MIGRATION, phase: 'busy', preview: this.state.migration.preview, migrations: this.state.migration.migrations } });
    try {
      const result = await this.deps.migrationCancel!(instanceId, operationId, confirmDigest);
      if (this.state.selectedId !== instanceId) return;
      this.patch({ migration: this.migrationFromOutcome(result, 'migration-cancel-failed') });
    } catch (error) {
      if (this.state.selectedId !== instanceId) return;
      this.patch({ migration: this.migrationFailure('transport-failed', (error as Error).message) });
    }
  }

  /** 读取迁移记录列表（诊断与恢复入口）。 */
  async loadMigrations(): Promise<void> {
    if (!this.requireMigrationDeps()) return;
    try {
      const result = await this.deps.migrationList!();
      if ('status' in result) {
        // rejected（owner 准入已归一）或 unavailable（宿主未装配迁移服务）。
        this.patch({
          migration: result.status === 'unavailable'
            ? this.migrationFailure('migration-unavailable', result.message)
            : this.migrationFailure(result.code, result.message),
        });
        return;
      }
      if (result.ok === false) {
        const first = result.issues[0];
        this.patch({ migration: this.migrationFailure(first?.code ?? 'migration-list-failed', first?.message ?? '读取迁移记录失败') });
        return;
      }
      this.patch({
        migration: {
          ...this.state.migration,
          phase: this.state.migration.phase === 'busy' ? 'ready' : this.state.migration.phase,
          migrations: result.migrations as MigrationRecordView[],
        },
      });
    } catch (error) {
      this.patch({ migration: this.migrationFailure('transport-failed', (error as Error).message) });
    }
  }

  // ---------- 1.1：接入预览与显式登记 ----------

  /** 接入预览：只读资料基线与 Git 状态；显式登记前必须先预览。 */
  async previewRegister(sourceRoot: string): Promise<void> {
    if (this.deps.registerPreview === undefined || this.deps.registerSource === undefined) {
      this.patch({ register: { ...EMPTY_REGISTER, phase: 'error', code: 'register-unavailable', message: null } });
      return;
    }
    this.patch({ register: { ...EMPTY_REGISTER, phase: 'busy' } });
    try {
      const preview = await this.deps.registerPreview(sourceRoot);
      this.patch({
        register: preview.status === 'preview'
          ? { phase: 'ready', preview, message: null, code: null }
          : { phase: 'error', preview: null, message: preview.status === 'rejected' ? preview.message : null, code: preview.status === 'rejected' ? preview.code : 'register-preview-failed' },
      });
    } catch (error) {
      this.patch({ register: { phase: 'error', preview: null, message: (error as Error).message, code: 'transport-failed' } });
    }
  }

  /** 显式登记：预览后确认；重复接入同一规范根回到既有实例。 */
  async confirmRegister(sourceRoot: string, sourceKind: LocationKind, projectId: string): Promise<void> {
    if (this.deps.registerSource === undefined) {
      this.patch({ register: { ...EMPTY_REGISTER, phase: 'error', code: 'register-unavailable', message: null } });
      return;
    }
    this.patch({ register: { ...EMPTY_REGISTER, phase: 'busy' } });
    try {
      const result = await this.deps.registerSource({ sourceRoot, sourceKind, projectId });
      if (result.status === 'registered') {
        this.patch({ register: { phase: 'ready', preview: this.state.register.preview, message: null, code: null } });
        await this.load();
        return;
      }
      this.patch({
        register: {
          phase: 'error',
          preview: this.state.register.preview,
          message: result.status === 'rejected' ? result.message : null,
          code: result.status === 'rejected' ? result.code : 'register-failed',
        },
      });
    } catch (error) {
      this.patch({ register: { phase: 'error', preview: this.state.register.preview, message: (error as Error).message, code: 'transport-failed' } });
    }
  }

  /** 丢弃草稿与保存状态。 */
  discardResumeDraft(): void {
    this.patch({ resumeDraft: null, resumeSave: { status: 'idle', code: null, message: null } });
  }

  /** 生成保存预览（共享内容：带前缀 summary + 版本化正文）；必填缺失时给稳定码。 */
  resumePreview(): { ok: true; summary: string; body: string } | { ok: false; code: string; message: string } {
    const draft = this.state.resumeDraft;
    if (draft === null) return { ok: false, code: 'no-draft', message: '未在编辑接续' };
    const built = buildResume({
      stoppedAt: draft.stoppedAt,
      nextStep: draft.nextStep,
      nextStepKind: draft.nextStepKind,
      savedAt: new Date().toISOString(),
      ...(draft.outcome.trim() === '' ? {} : { outcome: draft.outcome.trim() }),
      ...(draft.decisions.trim() === '' ? {} : { decisions: draft.decisions.trim() }),
      ...(draft.openIssues.trim() === '' ? {} : { openIssues: draft.openIssues.trim() }),
    });
    if (!built.ok) return built;
    return { ok: true, summary: built.summary, body: built.body };
  }

  /**
   * 保存接续：先取快照基线，再经 conaOverview/execute 提交 append-record。
   * 失败/冲突/未知一律保留草稿与原 operationId（幂等重试不产生第二条记录）；
   * 提交成功清草稿并刷新卡片。
   */
  async saveResume(): Promise<ResumeSaveStatus> {
    const draft = this.state.resumeDraft;
    const instanceId = this.state.selectedId;
    if (draft === null || instanceId === null) return 'idle';
    if (this.state.resumeSave.status === 'saving') return 'saving';
    if (draft.stoppedAt.trim() === '' || draft.nextStep.trim() === '') {
      this.patch({ resumeSave: { status: 'failed', code: 'missing-required', message: null } });
      return 'failed';
    }
    this.patch({ resumeSave: { status: 'saving', code: null, message: null } });
    const transport = this.deps.transportFor(instanceId);
    let baseline;
    try {
      baseline = await transport.snapshot({ connectionGeneration: 0 });
    } catch (error) {
      this.patch({ resumeSave: { status: 'failed', code: 'transport-unknown', message: (error as Error).message } });
      return 'failed';
    }
    if (baseline.status !== 'snapshot') {
      const code = baseline.status === 'rejected' ? baseline.code : `unsynced-${baseline.reason}`;
      const message = baseline.status === 'rejected' ? baseline.message : baseline.detail;
      this.patch({ resumeSave: { status: 'failed', code, message } });
      return 'failed';
    }
    const snap = baseline.snapshot;
    const built = buildResume({
      stoppedAt: draft.stoppedAt,
      nextStep: draft.nextStep,
      nextStepKind: draft.nextStepKind,
      savedAt: new Date().toISOString(),
      ...(draft.outcome.trim() === '' ? {} : { outcome: draft.outcome.trim() }),
      ...(draft.decisions.trim() === '' ? {} : { decisions: draft.decisions.trim() }),
      ...(draft.openIssues.trim() === '' ? {} : { openIssues: draft.openIssues.trim() }),
    });
    if (!built.ok) {
      this.patch({ resumeSave: { status: 'failed', code: built.code, message: built.message } });
      return 'failed';
    }
    const subjectId = snap.tree[0]?.id;
    const operationId = draft.operationId ?? this.deps.newOperationId();
    if (draft.operationId === null) this.patch({ resumeDraft: { ...draft, operationId } });
    let result;
    try {
      result = await transport.execute({
        operationId,
        command: {
          type: 'append-record',
          kind: 'execution-note',
          subjectNodeIds: subjectId === undefined ? [] : [subjectId],
          summary: built.summary,
          sources: [],
          body: built.body,
        },
        expectedPlanVersion: snap.planVersion,
        expectedPlanRevision: snap.planRevision,
        sourceEpoch: snap.sourceEpoch,
      });
    } catch (error) {
      this.patch({ resumeSave: { status: 'failed', code: 'transport-unknown', message: (error as Error).message } });
      return 'failed';
    }
    if (result.status === 'committed') {
      // 公开记录已提交：清草稿；聊天指针失败降级为部分保存，可就现有记录重试。
      const recordId = result.recordId;
      const chatLinkId = draft.chatLinkId;
      this.patch({ resumeDraft: null, resumeSave: { status: 'saved', code: null, message: null } });
      if (chatLinkId !== null && typeof recordId === 'string' && recordId !== '') {
        const link = await this.tryLinkResume(instanceId, recordId, chatLinkId);
        if (this.state.selectedId !== instanceId) return 'saved';
        if (link.ok) {
          this.patch({ resumePartial: null, resumeSave: { status: 'saved', code: null, message: null } });
        } else {
          this.patch({
            resumePartial: { recordId, linkId: chatLinkId },
            resumeSave: { status: 'partial', code: link.code, message: link.message },
          });
        }
      }
      // 卡片刷新放在指针写之后：否则卡片会短暂显示「聊天未关联」。
      void this.loadResumeCard(instanceId);
      return 'saved';
    }
    if (result.status === 'pending-reconciliation') {
      this.patch({ resumeSave: { status: 'pending', code: result.stage, message: result.message } });
      return 'pending';
    }
    const conflict = result.code === 'plan-conflict' || result.code === 'source-changed';
    this.patch({
      resumeSave: { status: conflict ? 'conflict' : 'failed', code: result.code, message: result.message },
    });
    return conflict ? 'conflict' : 'failed';
  }

  /** 保存聊天指针；传输异常与宿主拒绝统一为 {ok:false, code, message}，不改公开记录。 */
  private async tryLinkResume(instanceId: string, recordId: string, linkId: string): Promise<
    { ok: true } | { ok: false; code: string; message: string | null }
  > {
    try {
      const result = await this.deps.linkResume(instanceId, recordId, linkId);
      if (result.status === 'linked') return { ok: true };
      return { ok: false, code: result.code, message: result.message };
    } catch (error) {
      return { ok: false, code: 'transport-failed', message: (error as Error).message };
    }
  }

  /** 部分保存重试：就现有公开记录重试保存聊天指针（幂等，公开记录数不变）。 */
  async retryResumeChatLink(): Promise<'saved' | 'partial' | 'idle'> {
    const partial = this.state.resumePartial;
    const instanceId = this.state.selectedId;
    if (partial === null || instanceId === null) return 'idle';
    this.patch({ resumeSave: { status: 'saving', code: null, message: null } });
    const link = await this.tryLinkResume(instanceId, partial.recordId, partial.linkId);
    if (this.state.selectedId !== instanceId) return 'saved';
    if (link.ok) {
      this.patch({ resumePartial: null, resumeSave: { status: 'saved', code: null, message: null } });
      void this.loadResumeCard(instanceId);
      return 'saved';
    }
    this.patch({ resumeSave: { status: 'partial', code: link.code, message: link.message } });
    return 'partial';
  }

  /**
   * 打开原聊天：点击时复查记录版本、指针、链接与宿主实际 Session（Host resumeChatTarget），
   * 通过后仅用 DSH 导航打开会话；不携带、不恢复任何执行绑定。
   * 选择代际检查：请求返回时实例已切换则丢弃（与卡片迟到响应同口径）。
   */
  async openResumeChat(): Promise<void> {
    const card = this.state.resumeCard;
    const instanceId = this.state.selectedId;
    if (card === null || card.status !== 'card' || card.chat.status !== 'linked' || instanceId === null) return;
    this.patch({ chatNotice: null });
    let result: ResumeChatTargetView;
    try {
      result = await this.deps.resolveChatTarget(instanceId, card.recordId, card.contentHash, card.chat.linkId);
    } catch (error) {
      if (this.state.selectedId === instanceId) {
        this.patch({ chatNotice: { code: 'transport-failed', message: (error as Error).message } });
      }
      return;
    }
    if (this.state.selectedId !== instanceId) return;
    if (result.status === 'ok') {
      this.deps.openSession(result.sessionId);
      return;
    }
    this.patch({ chatNotice: { code: result.code, message: result.message } });
  }

  // ---------- 3.1：本机聊天（实例路由，浏览实例也能管理自己的聊天） ----------

  /** 聊天依赖缺失（旧宿主）时给 unavailable，不猜测内容。 */
  private chatsUnavailable(): boolean {
    if (this.deps.listChats === undefined || this.deps.listChatSessions === undefined) {
      this.patch({ chats: { ...EMPTY_CHATS, phase: 'unavailable', reason: 'chats-unavailable' } });
      return true;
    }
    return false;
  }

  /** 读取所选实例的链接、可选会话与待核对意图；只读，丢弃切换后的迟到响应。 */
  async loadChats(instanceId: string): Promise<void> {
    if (this.chatsUnavailable()) return;
    if (this.state.selectedId === instanceId) {
      this.patch({ chats: { ...this.state.chats, phase: 'loading', reason: null } });
    }
    const noticeAtStart = this.state.chats.notice;
    let linksView: Awaited<ReturnType<NonNullable<OverviewControllerDeps['listChats']>>>;
    let sessionsView: Awaited<ReturnType<NonNullable<OverviewControllerDeps['listChatSessions']>>>;
    try {
      [linksView, sessionsView] = await Promise.all([
        this.deps.listChats!(instanceId),
        this.deps.listChatSessions!(instanceId),
      ]);
    } catch (error) {
      if (this.state.selectedId !== instanceId) return;
      this.patch({ chats: { ...EMPTY_CHATS, phase: 'unavailable', reason: `transport-failed: ${(error as Error).message}` } });
      return;
    }
    if (this.state.selectedId !== instanceId) return;
    if (linksView.status !== 'committed') {
      this.patch({ chats: { ...EMPTY_CHATS, phase: 'unavailable', reason: `${linksView.code}: ${linksView.message}` } });
      return;
    }
    const sessions = sessionsView.status === 'committed' ? sessionsView.value.sessions : [];
    const sessionsNotice = sessionsView.status === 'committed'
      ? null
      : { code: sessionsView.code, message: sessionsView.message };
    // 读取期间若有更新的操作诊断（失败提示），保留它，不被本轮刷新覆盖。
    const notice = this.state.chats.notice !== noticeAtStart ? this.state.chats.notice : sessionsNotice;
    this.patch({
      chats: {
        phase: 'ready',
        links: linksView.value.links.map((link) => ({
          linkId: link.linkId,
          sessionId: link.sessionId,
          purpose: link.purpose,
          nodeIds: [...link.nodeIds],
          visible: link.visible,
        })),
        sessions: sessions.map((session) => ({
          sessionId: session.sessionId,
          blank: session.blank,
          running: session.running,
          updatedAt: session.updatedAt,
          linked: session.linked,
        })),
        pending: linksView.value.pendingIntents.map((intent) => ({
          operationId: intent.operationId,
          action: intent.action,
          nodeIds: [...intent.nodeIds],
          purpose: intent.purpose,
          status: intent.status === 'linked' ? 'pending' : intent.status,
          createdAt: intent.createdAt,
          ...(intent.detail === undefined ? {} : { detail: intent.detail }),
          ...(intent.candidates === undefined ? {} : { candidates: [...intent.candidates] }),
        })),
        reason: null,
        notice,
        // 刷新不改变“是否有写操作在途”。
        busy: this.state.chats.busy,
      },
    });
  }

  /** 卡片上的显式重绑入口：记下记录身份，下一次创建／关联成功后写指针。 */
  beginRebindResume(): boolean {
    const card = this.state.resumeCard;
    if (card === null || card.status !== 'card') return false;
    this.patch({ rebindDraft: { recordId: card.recordId, contentHash: card.contentHash } });
    return true;
  }

  cancelRebindResume(): void {
    this.patch({ rebindDraft: null });
  }

  /** 聊天关联用的节点集合：面板多选优先，其次单选（用户必须明确选择）。 */
  private chatNodeIds(instanceId: string): string[] {
    const panel = this.panelController(instanceId).getState();
    if (panel.selectedNodeIds.length > 0) return [...panel.selectedNodeIds];
    return panel.selectedNodeId === null ? [] : [panel.selectedNodeId];
  }

  private chatFailure(code: string, message: string): void {
    this.patch({ chats: { ...this.state.chats, busy: false, notice: { code, message } } });
  }

  /** 提交后的统一收尾：清重绑草稿与在途标记，再刷新链接、可选会话与卡片。 */
  private afterChatWrite(instanceId: string): void {
    this.patch({ rebindDraft: null, chats: { ...this.state.chats, busy: false, notice: null } });
    void this.loadChats(instanceId);
    void this.loadResumeCard(instanceId);
  }

  /** 创建聊天（宿主可能复用空白会话）；重绑草稿存在时改为写接续指针。 */
  async createChat(purpose: string): Promise<'ok' | 'failed' | 'idle'> {
    const instanceId = this.state.selectedId;
    if (instanceId === null) return 'idle';
    if (purpose.trim() === '') {
      this.chatFailure('missing-purpose', '用途不能为空');
      return 'failed';
    }
    const rebind = this.state.rebindDraft;
    if (rebind !== null) {
      const deps = this.deps.rebindResumeChat;
      if (deps === undefined) {
        this.chatFailure('chats-unavailable', '此宿主未提供聊天重绑入口');
        return 'failed';
      }
      if (this.state.chats.busy) return 'idle';
      this.patch({ chats: { ...this.state.chats, busy: true, notice: null } });
      try {
        const result = await deps({
          instanceId, recordId: rebind.recordId, contentHash: rebind.contentHash,
          mode: 'create', purpose: purpose.trim(),
        });
        if (this.state.selectedId !== instanceId) return 'ok';
        if (result.status === 'linked') {
          this.afterChatWrite(instanceId);
          return 'ok';
        }
        this.chatFailure(result.code, result.message);
        return 'failed';
      } catch (error) {
        if (this.state.selectedId === instanceId) this.chatFailure('transport-failed', (error as Error).message);
        return 'failed';
      }
    }
    const nodeIds = this.chatNodeIds(instanceId);
    if (nodeIds.length === 0) {
      this.chatFailure('no-node-selected', '先在树中选择要关联的节点');
      return 'failed';
    }
    const create = this.deps.createChat;
    if (create === undefined) {
      this.chatFailure('chats-unavailable', '此宿主未提供聊天创建入口');
      return 'failed';
    }
    if (this.state.chats.busy) return 'idle';
    this.patch({ chats: { ...this.state.chats, busy: true, notice: null } });
    try {
      const result = await create({ instanceId, operationId: this.deps.newOperationId(), nodeIds, purpose: purpose.trim() });
      if (this.state.selectedId !== instanceId) return 'ok';
      if (result.status === 'committed') {
        this.afterChatWrite(instanceId);
        return 'ok';
      }
      this.chatFailure(result.code, result.message);
      return 'failed';
    } catch (error) {
      if (this.state.selectedId === instanceId) this.chatFailure('transport-failed', (error as Error).message);
      return 'failed';
    }
  }

  /** 关联已有会话（宿主核对可见性）；重绑草稿存在时改为写接续指针。 */
  async linkSession(sessionId: string, purpose: string): Promise<'ok' | 'failed' | 'idle'> {
    const instanceId = this.state.selectedId;
    if (instanceId === null || sessionId === '') return 'idle';
    if (purpose.trim() === '') {
      this.chatFailure('missing-purpose', '用途不能为空');
      return 'failed';
    }
    const rebind = this.state.rebindDraft;
    if (rebind !== null) {
      const deps = this.deps.rebindResumeChat;
      if (deps === undefined) {
        this.chatFailure('chats-unavailable', '此宿主未提供聊天重绑入口');
        return 'failed';
      }
      if (this.state.chats.busy) return 'idle';
      this.patch({ chats: { ...this.state.chats, busy: true, notice: null } });
      try {
        const result = await deps({
          instanceId, recordId: rebind.recordId, contentHash: rebind.contentHash,
          mode: 'link', sessionId, purpose: purpose.trim(),
        });
        if (this.state.selectedId !== instanceId) return 'ok';
        if (result.status === 'linked') {
          this.afterChatWrite(instanceId);
          return 'ok';
        }
        this.chatFailure(result.code, result.message);
        return 'failed';
      } catch (error) {
        if (this.state.selectedId === instanceId) this.chatFailure('transport-failed', (error as Error).message);
        return 'failed';
      }
    }
    const nodeIds = this.chatNodeIds(instanceId);
    if (nodeIds.length === 0) {
      this.chatFailure('no-node-selected', '先在树中选择要关联的节点');
      return 'failed';
    }
    const link = this.deps.linkChat;
    if (link === undefined) {
      this.chatFailure('chats-unavailable', '此宿主未提供聊天关联入口');
      return 'failed';
    }
    if (this.state.chats.busy) return 'idle';
    this.patch({ chats: { ...this.state.chats, busy: true, notice: null } });
    try {
      const result = await link({ instanceId, operationId: this.deps.newOperationId(), sessionId, nodeIds, purpose: purpose.trim() });
      if (this.state.selectedId !== instanceId) return 'ok';
      if (result.status === 'committed') {
        this.afterChatWrite(instanceId);
        return 'ok';
      }
      this.chatFailure(result.code, result.message);
      return 'failed';
    } catch (error) {
      if (this.state.selectedId === instanceId) this.chatFailure('transport-failed', (error as Error).message);
      return 'failed';
    }
  }

  /** 认领待核对候选：只对用户明确点击的候选写链接。 */
  async claimPending(row: PendingChatRow, sessionId: string): Promise<'ok' | 'failed' | 'idle'> {
    const instanceId = this.state.selectedId;
    if (instanceId === null || sessionId === '') return 'idle';
    const claim = this.deps.claimChat;
    if (claim === undefined) {
      this.chatFailure('chats-unavailable', '此宿主未提供聊天认领入口');
      return 'failed';
    }
    if (this.state.chats.busy) return 'idle';
    this.patch({ chats: { ...this.state.chats, busy: true, notice: null } });
    try {
      const result = await claim({
        instanceId, operationId: this.deps.newOperationId(), sessionId,
        nodeIds: [...row.nodeIds], purpose: row.purpose,
      });
      if (this.state.selectedId !== instanceId) return 'ok';
      if (result.status === 'committed') {
        this.afterChatWrite(instanceId);
        return 'ok';
      }
      this.chatFailure(result.code, result.message);
      return 'failed';
    } catch (error) {
      if (this.state.selectedId === instanceId) this.chatFailure('transport-failed', (error as Error).message);
      return 'failed';
    }
  }

  /** 解除关联（整条）；只推进本机状态修订。 */
  async unlinkChat(linkId: string): Promise<'ok' | 'failed' | 'idle'> {
    const instanceId = this.state.selectedId;
    if (instanceId === null || linkId === '') return 'idle';
    const unlink = this.deps.unlinkChat;
    if (unlink === undefined) {
      this.chatFailure('chats-unavailable', '此宿主未提供解绑入口');
      return 'failed';
    }
    if (this.state.chats.busy) return 'idle';
    this.patch({ chats: { ...this.state.chats, busy: true, notice: null } });
    try {
      const result = await unlink({ instanceId, operationId: this.deps.newOperationId(), linkId });
      if (this.state.selectedId !== instanceId) return 'ok';
      if (result.status === 'committed') {
        this.afterChatWrite(instanceId);
        return 'ok';
      }
      this.chatFailure(result.code, result.message);
      return 'failed';
    } catch (error) {
      if (this.state.selectedId === instanceId) this.chatFailure('transport-failed', (error as Error).message);
      return 'failed';
    }
  }

  /**
   * 打开所选聊天：Host 复查链接与宿主实际 Session，通过后只做 DSH 导航。
   * 不发快照、不建绑定、不改 A 的目标与订阅。
   */
  async openChatLink(linkId: string): Promise<void> {
    const instanceId = this.state.selectedId;
    if (instanceId === null || linkId === '') return;
    const resolve = this.deps.resolveChatLinkTarget;
    if (resolve === undefined) {
      this.chatFailure('chats-unavailable', '此宿主未提供聊天打开入口');
      return;
    }
    this.patch({ chats: { ...this.state.chats, notice: null } });
    try {
      const result = await resolve(instanceId, linkId);
      if (this.state.selectedId !== instanceId) return;
      if (result.status === 'committed') {
        this.deps.openSession(result.value.sessionId);
        return;
      }
      this.chatFailure(result.code, result.message);
    } catch (error) {
      if (this.state.selectedId === instanceId) this.chatFailure('transport-failed', (error as Error).message);
    }
  }

  // ---------- 3.2：配置实例上的项目工作（预览 → 确认 → 等待真实消息边界） ----------

  /** 只有启动配置实例才有工作入口；浏览实例明确不可用（不静默换实例）。 */
  isWorkEntryAvailable(): boolean {
    const row = this.selected();
    return row !== null && row.readable && row.configured === true;
  }

  private workFailure(code: string, message: string): void {
    this.patch({ work: { ...EMPTY_WORK, draft: this.state.work.draft, preview: this.state.work.preview, phase: 'error', notice: { code, message } } });
  }

  /**
   * 开始填写工作范围：目标 = 树面板当前选择，会话 = 该实例首条可见链接，
   * 动作默认 update+record（最小可用集合，用户可改）。不落盘。
   */
  beginWork(): boolean {
    const instanceId = this.state.selectedId;
    if (instanceId === null || !this.isWorkEntryAvailable()) {
      this.workFailure('work-entry-unavailable', '项目工作入口只对启动配置实例可用');
      return false;
    }
    const nodeIds = this.chatNodeIds(instanceId);
    if (nodeIds.length === 0) {
      this.workFailure('no-node-selected', '先在树中选择本次工作的目标节点');
      return false;
    }
    const sessionId = this.state.chats.links[0]?.sessionId ?? this.state.chats.sessions[0]?.sessionId ?? '';
    this.patch({
      work: {
        phase: 'idle',
        draft: {
          sessionId,
          purpose: '',
          actions: ['update', 'record'],
          reasonScope: 'local',
          nodeIds,
          workIntentId: this.deps.newOperationId(),
        },
        preview: null,
        notice: null,
        started: null,
      },
    });
    return true;
  }

  /** 修改草稿字段（动作集合只接受已知值）。 */
  patchWorkDraft(patch: Partial<Omit<WorkDraft, 'workIntentId'>>): void {
    const draft = this.state.work.draft;
    if (draft === null) return;
    const actions = patch.actions === undefined
      ? draft.actions
      : patch.actions.filter((action) => WORK_ACTION_OPTIONS.includes(action));
    this.patch({
      work: {
        ...this.state.work,
        draft: {
          ...draft,
          ...patch,
          ...(patch.actions === undefined ? {} : { actions }),
        },
        preview: null,
        notice: null,
      },
    });
  }

  /** 只读预览：先取当前快照基线，再让宿主按目标集合组装上下文。 */
  async previewWork(): Promise<'ok' | 'failed' | 'idle'> {
    const instanceId = this.state.selectedId;
    const draft = this.state.work.draft;
    if (instanceId === null || draft === null) return 'idle';
    if (!this.isWorkEntryAvailable()) {
      this.workFailure('work-entry-unavailable', '项目工作入口只对启动配置实例可用');
      return 'failed';
    }
    if (draft.sessionId === '') {
      this.workFailure('session-identity-missing', '先选择一个本机会话');
      return 'failed';
    }
    if (draft.purpose.trim() === '') {
      this.workFailure('missing-purpose', '用途不能为空');
      return 'failed';
    }
    if (draft.actions.length === 0) {
      this.workFailure('missing-actions', '至少授权一个动作');
      return 'failed';
    }
    const preview = this.deps.workPreview;
    if (preview === undefined) {
      this.workFailure('work-unavailable', '此宿主未提供工作预览入口');
      return 'failed';
    }
    this.patch({ work: { ...this.state.work, phase: 'previewing', notice: null } });
    const transport = this.deps.transportFor(instanceId);
    let baseline;
    try {
      baseline = await transport.snapshot({ connectionGeneration: 0 });
    } catch (error) {
      if (this.state.selectedId === instanceId) this.workFailure('transport-failed', (error as Error).message);
      return 'failed';
    }
    if (this.state.selectedId !== instanceId) return 'ok';
    if (baseline.status !== 'snapshot') {
      const code = baseline.status === 'rejected' ? baseline.code : `unsynced-${baseline.reason}`;
      const message = baseline.status === 'rejected' ? baseline.message : baseline.detail;
      this.workFailure(code, message);
      return 'failed';
    }
    const base = {
      planVersion: baseline.snapshot.planVersion,
      planRevision: baseline.snapshot.planRevision,
      sourceEpoch: baseline.snapshot.sourceEpoch,
    };
    try {
      const result = await preview({
        instanceId,
        sessionId: draft.sessionId,
        nodeIds: [...draft.nodeIds],
        allowedActions: [...draft.actions],
        reasonScope: draft.reasonScope,
        purpose: draft.purpose.trim(),
        baseline: base,
      });
      if (this.state.selectedId !== instanceId) return 'ok';
      if (result.status === 'committed') {
        this.patch({
          work: {
            phase: 'previewed',
            draft: this.state.work.draft === null ? null : { ...this.state.work.draft },
            preview: result.value,
            notice: null,
            started: null,
          },
        });
        return 'ok';
      }
      this.workFailure(result.code, result.message);
      return 'failed';
    } catch (error) {
      if (this.state.selectedId === instanceId) this.workFailure('transport-failed', (error as Error).message);
      return 'failed';
    }
  }

  /**
   * 确认范围：登记意图（pending）→ 确认等待该会话下一条消息 → 记录待生效提示。
   * 任一步失败都保留预览与草稿；绑定只在真实消费边界形成。
   */
  async confirmWork(): Promise<'ok' | 'failed' | 'idle'> {
    const instanceId = this.state.selectedId;
    const draft = this.state.work.draft;
    const preview = this.state.work.preview;
    if (instanceId === null || draft === null || preview === null) return 'idle';
    if (this.state.work.phase === 'preparing') return 'idle';
    const prepare = this.deps.workPrepare;
    const start = this.deps.workStart;
    if (prepare === undefined || start === undefined) {
      this.workFailure('work-unavailable', '此宿主未提供工作确认入口');
      return 'failed';
    }
    this.patch({ work: { ...this.state.work, phase: 'preparing', notice: null } });
    try {
      const prepared = await prepare({
        instanceId,
        workIntentId: draft.workIntentId,
        nodeIds: [...draft.nodeIds],
        allowedActions: [...draft.actions],
        reasonScope: draft.reasonScope,
        purpose: draft.purpose.trim(),
        baseline: preview.baseline,
      });
      if (this.state.selectedId !== instanceId) return 'ok';
      if (prepared.status !== 'committed') {
        this.workFailure(prepared.code, prepared.message);
        return 'failed';
      }
      const started = await start({ instanceId, workIntentId: draft.workIntentId, sessionId: draft.sessionId });
      if (this.state.selectedId !== instanceId) return 'ok';
      if (started.status !== 'committed') {
        this.workFailure(started.code, started.message);
        return 'failed';
      }
      this.patch({
        work: {
          ...this.state.work,
          phase: 'awaiting-message',
          notice: null,
          started: { workIntentId: draft.workIntentId, sessionId: draft.sessionId },
        },
      });
      return 'ok';
    } catch (error) {
      if (this.state.selectedId === instanceId) this.workFailure('transport-failed', (error as Error).message);
      return 'failed';
    }
  }

  /** 丢弃工作草稿与预览（已确认待发的意图保留，不在这里撤销）。 */
  cancelWork(): void {
    this.patch({ work: EMPTY_WORK });
  }

  /** 打开已确认范围所在的会话，让用户在那里发送下一条消息。 */
  openWorkSession(): void {
    const started = this.state.work.started;
    if (started !== null) this.deps.openSession(started.sessionId);
  }

  /** 取（或建）某实例的面板控制器；同实例复用，草稿/选择/代际保持。 */
  panelController(instanceId: string): PanelController {
    const existing = this.byInstance.get(instanceId);
    if (existing !== undefined) return existing;
    const created = new PanelController({
      transport: this.deps.transportFor(instanceId),
      newOperationId: this.deps.newOperationId,
    });
    this.byInstance.set(instanceId, created);
    return created;
  }

  /** 当前选中实例；只读。 */
  selected(): OverviewRow | null {
    return this.state.instances.find((row) => row.instanceId === this.state.selectedId) ?? null;
  }

  /** 当前选中实例的面板控制器；无选中时返回 null。 */
  activePanelController(): IPanelController | null {
    return this.state.selectedId === null ? null : this.panelController(this.state.selectedId);
  }
}

/**
 * 面板委托控制器（2.2）：注入给既有 `cona-project` 树面板。
 * 所有调用转发到概览当前选中实例的真实 PanelController；
 * 选中切换时重新订阅，使面板立即显示新实例且保留各自草稿/代际。
 */
export class DelegatingPanelController implements IPanelController {
  private readonly listeners = new Set<(state: PanelState) => void>();
  private bound: IPanelController | null = null;
  private unbind: (() => void) | null = null;
  private readonly unsubOverview: () => void;

  constructor(private readonly overview: ProjectOverviewController) {
    this.unsubOverview = overview.subscribe(() => this.rebind());
    this.rebind();
  }

  /** 释放对概览的订阅（插件卸载时）。 */
  dispose(): void {
    this.unsubOverview();
    this.unbind?.();
    this.unbind = null;
  }

  private rebind(): void {
    const next = this.overview.activePanelController();
    if (next === this.bound) return;
    this.unbind?.();
    this.bound = next;
    this.unbind = next === null ? null : next.subscribe((state) => {
      for (const listener of this.listeners) listener(state);
    });
    if (next !== null) {
      for (const listener of this.listeners) listener(next.getState());
    }
  }

  private current(): IPanelController {
    const active = this.bound ?? this.overview.activePanelController();
    if (active === null) throw new Error('未选择实例');
    return active;
  }

  getState(): PanelState {
    const active = this.bound;
    return active === null
      ? {
          phase: 'idle', message: null, status: null, snapshot: null,
          selectedNodeId: null, selectedNodeIds: [], draft: null, reason: '',
          save: { status: 'idle', code: null, message: null },
          connection: { generation: 1, status: 'connected', error: null },
          presets: [], presetsStatus: 'idle', presetsError: null, structurePreview: null, pendingReceipt: null,
          userTemplates: { status: 'idle', templates: [], code: null, message: null },
          undoHistory: { status: 'idle', entries: [], code: null, message: null },
        }
      : active.getState();
  }
  subscribe(listener: (state: PanelState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  isDirty(): boolean { return this.bound?.isDirty() ?? false; }
  isSaved(): boolean { return this.bound?.isSaved() ?? false; }
  isDraftBaselineStale(): boolean { return this.bound?.isDraftBaselineStale() ?? false; }
  open(): Promise<void> { return this.current().open(); }
  reconnect(): Promise<void> { return this.current().reconnect(); }
  markOffline(reason: string): void { this.current().markOffline(reason); }
  poll(): Promise<IngestOutcome> { return this.current().poll(); }
  select(nodeId: string): void { this.current().select(nodeId); }
  toggleSelect(nodeId: string): void { this.current().toggleSelect(nodeId); }
  clearSelection(): void { this.current().clearSelection(); }
  editGoal(nodeId: string, goal: string): void { this.current().editGoal(nodeId, goal); }
  beginAddNode(parentId?: string): void { this.current().beginAddNode(parentId); }
  beginMove(nodeId: string, parentId: string | null, beforeNodeId: string | null): void { this.current().beginMove(nodeId, parentId, beforeNodeId); }
  loadPresets(): Promise<void> { return this.current().loadPresets(); }
  beginInsertPreset(preset: PresetView, contentLocale: string, parentId: string, beforeNodeId: string | null): void {
    this.current().beginInsertPreset(preset, contentLocale, parentId, beforeNodeId);
  }
  beginGroup(group: { title: string; goal: string; completionCriteria: string[] }, anchorId: string | null): void {
    this.current().beginGroup(group, anchorId);
  }
  beginMerge(keepNodeId: string, patch: { title?: string; goal?: string; completionCriteria?: string[] }, resolutions: MergeResolutionView[]): void {
    this.current().beginMerge(keepNodeId, patch, resolutions);
  }
  beginCopy(parentId: string | null, beforeNodeId: string | null, externalDependencies: { nodeId: string; requiresNodeId: string }[]): void {
    this.current().beginCopy(parentId, beforeNodeId, externalDependencies);
  }
  beginUndo(targetOperationId: string, previewDigest: string, direction: 'undo' | 'redo'): void {
    this.current().beginUndo(targetOperationId, previewDigest, direction);
  }
  beginSaveUserTemplate(templateId: string, title: string, bodyLanguage: string, rootNodeId: string): void {
    this.current().beginSaveUserTemplate(templateId, title, bodyLanguage, rootNodeId);
  }
  beginInsertUserTemplate(template: UserTemplateView, parentId: string, beforeNodeId: string | null): void {
    this.current().beginInsertUserTemplate(template, parentId, beforeNodeId);
  }
  loadUserTemplates(): Promise<void> { return this.current().loadUserTemplates(); }
  loadUndoHistory(): Promise<void> { return this.current().loadUndoHistory(); }
  previewUndoAction(targetOperationId: string, direction: 'undo' | 'redo'): Promise<{ ok: true; previewDigest: string } | { ok: false; code: string; message: string }> {
    return this.current().previewUndoAction(targetOperationId, direction);
  }
  preview(): StructurePreview | null { return this.current().preview(); }
  retryRead(): Promise<SaveStatus> { return this.current().retryRead(); }
  editDraft(patch: Partial<Pick<PanelDraft, 'goal' | 'title' | 'criteria'>>): void { this.current().editDraft(patch); }
  setReason(reason: string): void { this.current().setReason(reason); }
  discardDraft(): void { this.current().discardDraft(); }
  save(): Promise<SaveStatus> { return this.current().save(); }
  ingest(result: Awaited<ReturnType<PanelTransport['snapshot']>>, generation: number): IngestOutcome {
    return this.current().ingest(result, generation);
  }
}
