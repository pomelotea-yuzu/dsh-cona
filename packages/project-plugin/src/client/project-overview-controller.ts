// 顶部项目概览控制器（R2 任务 2.2）：实例列表、选择、折叠态，
// 以及按实例隔离的 PanelController（草稿/选择/连接代际各自独立）。
// 不依赖 DOM/React，可脱离浏览器测试；渲染层只读状态、调方法。

import { PanelController, type IPanelController, type IngestOutcome, type PanelDraft, type PanelState, type SaveStatus } from './panel-controller.js';
import type { PanelTransport } from './api.js';
import { buildResume, type NextStepKind, type ResumePayload } from '../domain/resume.js';
import type {
  ResumeChatChoiceView,
  ResumeChatsResult,
  ResumeLinkResult,
  ResumeChatTargetResult,
} from '../host/overview-service.js';
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
      void this.loadResumeCard(instanceId);
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
  editDraft(patch: Partial<Pick<PanelDraft, 'goal' | 'title' | 'criteria'>>): void { this.current().editDraft(patch); }
  setReason(reason: string): void { this.current().setReason(reason); }
  discardDraft(): void { this.current().discardDraft(); }
  save(): Promise<SaveStatus> { return this.current().save(); }
  ingest(result: Awaited<ReturnType<PanelTransport['snapshot']>>, generation: number): IngestOutcome {
    return this.current().ingest(result, generation);
  }
}
