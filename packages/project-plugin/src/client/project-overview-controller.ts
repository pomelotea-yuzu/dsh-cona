// 顶部项目概览控制器（R2 任务 2.2）：实例列表、选择、折叠态，
// 以及按实例隔离的 PanelController（草稿/选择/连接代际各自独立）。
// 不依赖 DOM/React，可脱离浏览器测试；渲染层只读状态、调方法。

import { PanelController, type IPanelController, type IngestOutcome, type PanelDraft, type PanelState, type SaveStatus, type StructurePreview } from './panel-controller.js';
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
    if (selected !== null && !stillPresent) void this.loadResumeCard(selected);
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
      migration: EMPTY_MIGRATION,
      register: EMPTY_REGISTER,
    });
    void this.loadResumeCard(instanceId);
    return true;
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
          selectedNodeId: null, draft: null, reason: '',
          save: { status: 'idle', code: null, message: null },
          connection: { generation: 1, status: 'connected', error: null },
          presets: [], presetsStatus: 'idle', presetsError: null, structurePreview: null, pendingReceipt: null,
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
  editGoal(nodeId: string, goal: string): void { this.current().editGoal(nodeId, goal); }
  beginAddNode(parentId?: string): void { this.current().beginAddNode(parentId); }
  beginMove(nodeId: string, parentId: string | null, beforeNodeId: string | null): void { this.current().beginMove(nodeId, parentId, beforeNodeId); }
  loadPresets(): Promise<void> { return this.current().loadPresets(); }
  beginInsertPreset(preset: PresetView, contentLocale: string, parentId: string, beforeNodeId: string | null): void {
    this.current().beginInsertPreset(preset, contentLocale, parentId, beforeNodeId);
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
