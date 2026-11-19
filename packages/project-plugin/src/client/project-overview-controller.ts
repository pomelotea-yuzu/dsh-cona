// 顶部项目概览控制器（R2 任务 2.2）：实例列表、选择、折叠态，
// 以及按实例隔离的 PanelController（草稿/选择/连接代际各自独立）。
// 不依赖 DOM/React，可脱离浏览器测试；渲染层只读状态、调方法。

import { PanelController, type IPanelController, type IngestOutcome, type PanelDraft, type PanelState, type SaveStatus } from './panel-controller.js';
import type { PanelTransport } from './api.js';
import type { ResumePayload } from '../domain/resume.js';

/** 接续卡片视图（由 Host resumeCandidate 投影）。 */
export type ResumeCardView =
  | { status: 'card'; recordId: string; payload: ResumePayload }
  | { status: 'empty' }
  | { status: 'unread' }
  | { status: 'diagnostic'; code: string; message: string };

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
}

const EMPTY: OverviewState = {
  phase: 'idle',
  instances: [],
  selectedId: null,
  expanded: false,
  message: null,
  code: null,
  resumeCard: null,
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

  /** 选择实例；只接受已登记且可读的行。切换时清旧卡片并读取新卡片。 */
  select(instanceId: string): boolean {
    const row = this.state.instances.find((item) => item.instanceId === instanceId);
    if (row === undefined || !row.readable) return false;
    if (this.state.selectedId === instanceId) return true;
    this.patch({ selectedId: instanceId, resumeCard: null });
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
