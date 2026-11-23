// 面板控制器（5.2／5.3）：小树、详情、目标编辑、节点新增、变更原因，以及连接代际与草稿分离。
//
// 规则（design §8、tasks 5.2／5.3）：
// - 草稿单独保存，权威快照刷新不清空草稿；只有保存成功或显式放弃才清空；
// - 保存失败或冲突时草稿保留，且**不标已保存**；结果未知时保留原 operationId，不换 id 重试；
// - 连接代际（generation）在重连时递增：旧代际的迟到答复一律丢弃；
// - 同一源代际内 `stateRevision` 单调：更旧的快照不覆盖更新的；
// - `sourceEpoch` 变化是**替换边界**：接受新代际内容，不与旧代际比较修订大小；
// - 旧回执不让已提交的事实回退：提交后按当前代际重新回读，回读受同一单调守卫约束。
//
// 本文件不得依赖 DOM、React 或 Node：渲染层只读状态、调方法。

import type { Command, PanelSnapshot, PanelTransport, ConaProjectStatus, PresetView } from './api.js';

export type SaveStatus =
  | 'idle' | 'saving' | 'saved' | 'conflict' | 'pending' | 'failed' | 'partial'
  /** 已确认提交但完整回读尚未核对：只重读，不重提已成功的变更。 */
  | 'committed-pending-sync';

export interface DraftBaseline {
  planVersion: string;
  planRevision: number;
  stateRevision: number;
  sourceEpoch: number;
}

/** 合并/复制依赖处置：与领域 MergeDependencyResolution 同形（仅传输原始终端码）。 */
export interface MergeResolutionView {
  edge: { nodeId: string; requiresNodeId: string };
  action: 'keep' | 'reattach' | 'drop';
}

/** 一份草稿：目标编辑、新增节点、结构移动/预设插入，以及 2.1–2.5 的批量树编辑。同一时间只保留一份。 */
export interface PanelDraft {
  kind:
    | 'update-goal' | 'add-node' | 'move' | 'insert-preset'
    | 'group-nodes' | 'merge-nodes' | 'copy-subtree'
    | 'undo-plan-edit' | 'redo-plan-edit'
    | 'save-user-template' | 'insert-user-template';
  /** 目标编辑的节点 id；新增节点时为父节点 id；移动时为被移动节点 id。 */
  nodeId: string;
  goal: string;
  /** 仅新增节点使用。 */
  title?: string;
  criteria?: string[];
  /** 移动：目标父节点（null=根组）与同级锚点（null=末尾）。 */
  parentId?: string | null;
  beforeNodeId?: string | null;
  /** 移动：目标位置是否等于原位置（原位；保存按钮禁用）。 */
  noChange?: boolean;
  /** 插入：预设身份与本次冻结的正文语言（语言切换不改变已建草稿）。 */
  templateId?: string;
  templateVersion?: number;
  contentLocale?: string;
  preset?: PresetView;
  /** 分组/合并/复制：多选节点；合并的保留节点、依赖处置；复制的外部依赖。 */
  nodeIds?: string[];
  keepNodeId?: string;
  resolutions?: MergeResolutionView[];
  externalDependencies?: { nodeId: string; requiresNodeId: string }[];
  /** 撤销/重做：目标操作与确认预览指纹（进入草稿时冻结）。 */
  targetOperationId?: string;
  previewDigest?: string;
  /** 用户模板保存：正文语言、子树根；插入：版本三元组。 */
  bodyLanguage?: string;
  rootNodeId?: string;
  versionRecordId?: string;
  contentHash?: string;
  /** 进入草稿时的权威基线（保存时作为 expected* 提交，不随刷新变化）。 */
  baseline: DraftBaseline;
  /** 已发出的 operationId：重试复用同一个，避免结果未知时重复应用。 */
  operationId: string | null;
}

/** 结构操作的统一预览：拖放、键盘菜单与批量编辑生成同一形状。 */
export interface StructurePreview {
  kind:
    | 'move' | 'insert' | 'group' | 'merge' | 'copy'
    | 'undo' | 'redo' | 'save-template' | 'insert-user-template';
  /** 层级化展示行（缩进 depth 由调用方渲染）。 */
  lines: { depth: number; title: string }[];
  targetParentId: string | null;
  beforeNodeId: string | null;
  /** 回到原位置：无业务变化。 */
  noChange: boolean;
  /** 插入预设的展示字段（来源、版本、语言、内部依赖）。 */
  preset?: {
    id: string;
    version: number;
    source: string;
    locales: string[];
    contentLocale: string;
    name: string;
    description: string;
    dependencies: { from: string; to: string }[];
  };
  /** 合并来源/复制来源/撤销目标的标题（原文，非 key），供界面明确显示影响范围。 */
  sources?: string[];
  /** 复制的外部依赖（标题对，供界面确认）。 */
  externalDependencies?: { from: string; to: string }[];
  /** 用户模板来源与版本三元组（原文，非 key）。 */
  templateSource?: { templateId: string; versionRecordId: string; contentHash: string; bodyLanguage?: string };
  /** 当前实例存在活动工作时为真；界面据此显示条件句提示。 */
  workNotice: boolean;
}

export interface ConnectionState {
  /** 每次重连 +1；旧代际的答复与回执按此丢弃。 */
  generation: number;
  status: 'connected' | 'offline';
  /** 最近一次连接失败或未同步的原因；正常时为 null。 */
  error: string | null;
}

export interface PanelState {
  phase: 'idle' | 'loading' | 'ready' | 'error';
  /** 打开失败的稳定说明（未配置、资料不合法等）。 */
  message: string | null;
  status: ConaProjectStatus | null;
  snapshot: PanelSnapshot | null;
  selectedNodeId: string | null;
  /** 键盘/点击多选（分组、合并的来源）；单选时与 selectedNodeId 一致。 */
  selectedNodeIds: string[];
  draft: PanelDraft | null;
  /** 变更原因：随本次保存追加一条 plan-change 记录。 */
  reason: string;
  /** `code` 为稳定码（不翻译），`message` 为宿主原文；界面文案由字典提供。 */
  save: { status: SaveStatus; code: string | null; message: string | null };
  connection: ConnectionState;
  /** 随包预设列表（3.2）。 */
  presets: PresetView[];
  presetsStatus: 'idle' | 'loading' | 'listed' | 'rejected';
  presetsError: { code: string; message: string } | null;
  /** 当前结构草稿的统一预览；非结构草稿为 null。 */
  structurePreview: StructurePreview | null;
  /** 已提交待同步时保存的回执基线；retryRead 只有回读覆盖它才转 saved。 */
  pendingReceipt: DraftBaseline | null;
  /** 用户模板目录（异步读取）+ 撤销历史（异步读取）；仅 UI 展示，不构成授权。 */
  userTemplates: { status: 'idle' | 'loading' | 'listed' | 'rejected'; templates: UserTemplateView[]; code: string | null; message: string | null };
  undoHistory: { status: 'idle' | 'loading' | 'listed' | 'rejected'; entries: UndoHistoryView[]; code: string | null; message: string | null };
}

/** 用户模板目录项的 UI 视图（只含原文与身份，来自宿主只读查询）。 */
export interface UserTemplateView {
  source: 'user';
  templateId: string;
  versionRecordId: string;
  contentHash: string;
  bodyLanguage: string;
  title: string;
}

/** 撤销历史项的 UI 视图。 */
export interface UndoHistoryView {
  operationId: string;
  commandType: string;
  createdAt: string;
  canUndo: boolean;
  canRedo: boolean;
  reason?: string;
}

export interface PanelControllerDeps {
  transport: PanelTransport;
  newOperationId: () => string;
}

const EMPTY: PanelState = {
  phase: 'idle',
  message: null,
  status: null,
  snapshot: null,
  selectedNodeId: null,
  selectedNodeIds: [],
  draft: null,
  reason: '',
  save: { status: 'idle', code: null, message: null },
  connection: { generation: 1, status: 'connected', error: null },
  presets: [],
  presetsStatus: 'idle',
  presetsError: null,
  structurePreview: null,
  pendingReceipt: null,
  userTemplates: { status: 'idle', templates: [], code: null, message: null },
  undoHistory: { status: 'idle', entries: [], code: null, message: null },
};

/** 一次读取的结论：是否被采纳、是否因代际／修订过旧被丢弃。 */
export type IngestOutcome = 'applied' | 'stale-generation' | 'stale-source' | 'stale-revision' | 'unsynced' | 'failed';

/** 面板渲染层所需的最小控制器接口（允许按实例委托，见 project-overview-controller）。 */
export interface IPanelController {
  getState(): PanelState;
  subscribe(listener: (state: PanelState) => void): () => void;
  isDirty(): boolean;
  isSaved(): boolean;
  isDraftBaselineStale(): boolean;
  open(): Promise<void>;
  reconnect(): Promise<void>;
  markOffline(reason: string): void;
  poll(): Promise<IngestOutcome>;
  select(nodeId: string): void;
  /** 切换多选成员（键盘 Space/点击）；单选节点仍由 select 决定焦点。 */
  toggleSelect(nodeId: string): void;
  clearSelection(): void;
  editGoal(nodeId: string, goal: string): void;
  beginAddNode(parentId?: string): void;
  /** 进入移动草稿（拖放与键盘菜单共用）。noChange 由位置是否等于原位置判定。 */
  beginMove(nodeId: string, parentId: string | null, beforeNodeId: string | null): void;
  /** 读取随包预设列表。 */
  loadPresets(): Promise<void>;
  /** 进入预设插入草稿；contentLocale 进入时冻结，语言切换不改变。 */
  beginInsertPreset(preset: PresetView, contentLocale: string, parentId: string, beforeNodeId: string | null): void;
  /** 2.1–2.5 批量树编辑与逆向/模板草稿。 */
  beginGroup(group: { title: string; goal: string; completionCriteria: string[] }, anchorId: string | null): void;
  beginMerge(keepNodeId: string, patch: { title?: string; goal?: string; completionCriteria?: string[] }, resolutions: MergeResolutionView[]): void;
  beginCopy(parentId: string | null, beforeNodeId: string | null, externalDependencies: { nodeId: string; requiresNodeId: string }[]): void;
  beginUndo(targetOperationId: string, previewDigest: string, direction: 'undo' | 'redo'): void;
  beginSaveUserTemplate(templateId: string, title: string, bodyLanguage: string, rootNodeId: string): void;
  beginInsertUserTemplate(template: UserTemplateView, parentId: string, beforeNodeId: string | null): void;
  /** 异步只读目录：用户模板版本、撤销历史（未挂载宿主时给明确诊断）。 */
  loadUserTemplates(): Promise<void>;
  loadUndoHistory(): Promise<void>;
  /** 撤销/重做只读预览：返回确认指纹或冲突原因，不写盘。 */
  previewUndoAction(targetOperationId: string, direction: 'undo' | 'redo'): Promise<{ ok: true; previewDigest: string } | { ok: false; code: string; message: string }>;
  /** 当前结构草稿的预览（拖放/键盘/插入/批量统一形状）。 */
  preview(): StructurePreview | null;
  /** 已提交待同步：只重读快照，不重提已成功的变更。 */
  retryRead(): Promise<SaveStatus>;
  editDraft(patch: Partial<Pick<PanelDraft, 'goal' | 'title' | 'criteria'>>): void;
  setReason(reason: string): void;
  discardDraft(): void;
  save(): Promise<SaveStatus>;
  ingest(result: Awaited<ReturnType<PanelTransport['snapshot']>>, generation: number): IngestOutcome;
}

/** 面板状态机：所有写入都返回新状态并通知订阅者。 */
export class PanelController implements IPanelController {
  private state: PanelState = EMPTY;
  private readonly listeners = new Set<(state: PanelState) => void>();
  /** 当前失效订阅（V32）；null 表示宿主无 follow 或订阅失败，回退 snapshot 轮询。 */
  private followHandle: { id: string; generation: number; nextIndex: number } | null = null;

  constructor(private readonly deps: PanelControllerDeps) {}

  getState(): PanelState {
    return this.state;
  }

  subscribe(listener: (state: PanelState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 是否有未保存内容（草稿或有变更原因）。 */
  isDirty(): boolean {
    return this.state.draft !== null || this.state.reason.trim() !== '';
  }

  /** 是否已保存：只在成功提交后为真；任何编辑立即清除。 */
  isSaved(): boolean {
    return this.state.save.status === 'saved';
  }

  /** 草稿基线是否已落后于权威快照（源代际或修订变化）：提示用户重新对照，不清草稿。 */
  isDraftBaselineStale(): boolean {
    const draft = this.state.draft;
    const snapshot = this.state.snapshot;
    if (draft === null || snapshot === null) return false;
    return draft.baseline.sourceEpoch !== snapshot.sourceEpoch || draft.baseline.planRevision !== snapshot.planRevision;
  }

  /** 打开／重新读取权威快照。草稿与原因不被清空。先订阅再回读（design §8）。 */
  async open(): Promise<void> {
    const minRevision = await this.establishFollow();
    await this.load(minRevision);
  }

  /**
   * 重连：递增连接代际，释放旧订阅并重新订阅（真正的“重新订阅”），再完整回读。
   * 旧代际的迟到答复因代际不符被丢弃；草稿保留。
   */
  async reconnect(): Promise<void> {
    const previous = this.followHandle;
    this.followHandle = null;
    if (previous !== null && this.deps.transport.followClose !== undefined) {
      void this.deps.transport.followClose({ subscriptionId: previous.id }).catch(() => {});
    }
    this.patch({
      connection: { generation: this.state.connection.generation + 1, status: 'connected', error: null },
    });
    const minRevision = await this.establishFollow();
    await this.load(minRevision);
  }

  /**
   * 建立失效订阅并返回 ready 水位（design §8：先订阅再回读，通知不是内容来源）。
   * 宿主不支持 follow 或订阅被拒时返回 undefined，调用方回退到普通快照读取。
   */
  private async establishFollow(): Promise<number | undefined> {
    const follow = this.deps.transport.follow;
    if (follow === undefined) return undefined;
    const generation = this.state.connection.generation;
    try {
      const result = await follow({
        ...(this.state.snapshot === undefined || this.state.snapshot === null
          ? {}
          : { afterStateRevision: this.state.snapshot.stateRevision }),
      });
      if (generation !== this.state.connection.generation) return undefined;
      if (result.status !== 'following') return undefined;
      // host 的 change-stream 代际是权威：client 本地代际必须与之一致，
      // 否则 snapshot 带旧代际会被 stale-connection 拒绝（面板卡在 Loading）。
      this.patch({
        connection: { ...this.state.connection, generation: result.value.connectionGeneration },
      });
      this.followHandle = {
        id: result.value.subscriptionId,
        generation: result.value.connectionGeneration,
        nextIndex: 0,
      };
      return result.value.ready.stateRevision;
    } catch {
      // 传输失败不阻断面板：回退到 snapshot 轮询，连接状态由后续 markOffline 反映。
      return undefined;
    }
  }

  /** 连接失败：保留内容与草稿，只标离线。 */
  markOffline(reason: string): void {
    this.patch({ connection: { ...this.state.connection, status: 'offline', error: reason } });
  }

  /**
   * 检测一次权威变化（V32）：有失效订阅时先拉订阅事件，只有出现更高修订才回读快照；
   * 无订阅（旧宿主／订阅失败）时回退到 snapshot 轮询。受代际与修订守卫约束，失败只标离线。
   */
  async poll(): Promise<IngestOutcome> {
    if (this.state.snapshot === null) return 'failed';
    const generation = this.state.connection.generation;
    const handle = this.followHandle;
    if (handle !== null && handle.generation === generation && this.deps.transport.followEvents !== undefined) {
      try {
        const batch = await this.deps.transport.followEvents({ subscriptionId: handle.id });
        if (generation !== this.state.connection.generation) return 'stale-generation';
        if (batch.status === 'not-found' || batch.closed) {
          // 订阅终结（源代际替换／服务端关闭）：重新订阅一次，再完整回读。
          this.followHandle = null;
          const minRevision = await this.establishFollow();
          await this.load(minRevision);
          return 'applied';
        }
        handle.nextIndex = batch.nextIndex;
        const changed = batch.events.some((event) => event.stateRevision > this.state.snapshot!.stateRevision);
        if (changed) {
          await this.load();
          return 'applied';
        }
        return 'stale-revision'; // 无新事实：未改动的正常结果
      } catch {
        // 订阅拉取失败（断线窗口）：保留订阅与草稿，标离线，交给重连重建订阅。
        this.markOffline('订阅拉取失败');
        return 'failed';
      }
    }
    try {
      const result = await this.deps.transport.snapshot({
        connectionGeneration: generation,
        minStateRevision: this.state.snapshot.stateRevision,
      });
      return this.ingest(result, generation);
    } catch (error) {
      this.markOffline((error as Error).message);
      return 'failed';
    }
  }

  select(nodeId: string): void {
    this.patch({ selectedNodeId: nodeId, selectedNodeIds: [nodeId] });
  }

  toggleSelect(nodeId: string): void {
    const current = this.state.selectedNodeIds;
    const next = current.includes(nodeId) ? current.filter((id) => id !== nodeId) : [...current, nodeId];
    this.patch({ selectedNodeId: nodeId, selectedNodeIds: next });
  }

  clearSelection(): void {
    this.patch({ selectedNodeIds: [] });
  }

  /** 进入目标编辑草稿；基线取当前快照（之后刷新不改变这份草稿的期望版本）。 */
  editGoal(nodeId: string, goal: string): void {
    const snapshot = this.state.snapshot;
    if (snapshot === null) return;
    const node = snapshot.tree.find((item) => item.id === nodeId);
    if (node === undefined) return;
    this.patch({
      selectedNodeId: nodeId,
      draft: {
        kind: 'update-goal',
        nodeId,
        goal,
        baseline: baselineOf(snapshot),
        operationId: null,
      },
      save: { status: 'idle', code: null, message: null },
    });
  }

  /** 新增节点草稿（父节点默认当前选中）。 */
  beginAddNode(parentId?: string): void {
    const snapshot = this.state.snapshot;
    if (snapshot === null) return;
    const parent = parentId ?? this.state.selectedNodeId ?? snapshot.tree[0]?.id;
    if (parent === undefined) return;
    this.patch({
      draft: {
        kind: 'add-node',
        nodeId: parent,
        title: '',
        goal: '',
        criteria: [],
        baseline: baselineOf(snapshot),
        operationId: null,
      },
      save: { status: 'idle', code: null, message: null },
    });
  }

  /**
   * 进入移动草稿。拖放与键盘菜单都以同一签名进入，位置由 parentId + beforeNodeId
   * 表达，预览由 preview() 统一生成。已有其它草稿时调用方须先保存或放弃（3.4）。
   */
  beginMove(nodeId: string, parentId: string | null, beforeNodeId: string | null): void {
    const snapshot = this.state.snapshot;
    if (snapshot === null) return;
    const node = snapshot.tree.find((item) => item.id === nodeId);
    if (node === undefined) return;
    // 目标父节点必须存在（null=根组例外）；锚点须存在于目标同级组。
    if (parentId !== null && !snapshot.tree.some((item) => item.id === parentId)) return;
    if (beforeNodeId !== null && !snapshot.tree.some((item) => item.id === beforeNodeId && item.parentId === parentId)) return;
    const noChange = this.isMoveNoChange(node, parentId, beforeNodeId, snapshot);
    this.patch({
      selectedNodeId: nodeId,
      draft: {
        kind: 'move', nodeId, goal: node.goal, parentId, beforeNodeId, noChange,
        baseline: baselineOf(snapshot), operationId: null,
      },
      save: { status: 'idle', code: null, message: null },
      structurePreview: null,
    });
    this.refreshPreview();
  }

  /** 读取随包预设；任何草稿不受影响。 */
  async loadPresets(): Promise<void> {
    if (this.deps.transport.treePresets === undefined) {
      this.patch({ presetsStatus: 'rejected', presetsError: { code: 'unsupported', message: '宿主不支持预设读取' } });
      return;
    }
    this.patch({ presetsStatus: 'loading', presetsError: null });
    try {
      const result = await this.deps.transport.treePresets();
      if (result.status === 'listed') {
        this.patch({ presets: result.presets, presetsStatus: 'listed', presetsError: null });
      } else {
        this.patch({ presetsStatus: 'rejected', presetsError: { code: result.code, message: result.message } });
      }
    } catch (error) {
      this.patch({ presetsStatus: 'rejected', presetsError: { code: 'transport-failed', message: (error as Error).message } });
    }
  }

  /** 进入预设插入草稿；正文语言在此时冻结，之后切换宿主语言不改变。 */
  beginInsertPreset(preset: PresetView, contentLocale: string, parentId: string, beforeNodeId: string | null): void {
    const snapshot = this.state.snapshot;
    if (snapshot === null) return;
    const parent = snapshot.tree.find((item) => item.id === parentId);
    if (parent === undefined) return;
    if (beforeNodeId !== null && !snapshot.tree.some((item) => item.id === beforeNodeId && item.parentId === parentId)) return;
    this.patch({
      draft: {
        kind: 'insert-preset', nodeId: parentId, goal: '', parentId, beforeNodeId,
        templateId: preset.id, templateVersion: preset.version, contentLocale, preset,
        baseline: baselineOf(snapshot), operationId: null,
      },
      save: { status: 'idle', code: null, message: null },
      structurePreview: null,
    });
    this.refreshPreview();
  }

  /** 分组：以多选节点为来源；组标题/目标/条件由调用方表单给出。 */
  beginGroup(group: { title: string; goal: string; completionCriteria: string[] }, anchorId: string | null): void {
    const snapshot = this.state.snapshot;
    if (snapshot === null) return;
    const ids = [...this.state.selectedNodeIds];
    if (ids.length < 2 || ids.some((id) => !snapshot.tree.some((node) => node.id === id))) return;
    if (anchorId !== null && !snapshot.tree.some((node) => node.id === anchorId)) return;
    this.patch({
      draft: {
        kind: 'group-nodes', nodeId: ids[0]!, nodeIds: ids, goal: group.goal,
        title: group.title, criteria: [...group.completionCriteria],
        parentId: null, beforeNodeId: anchorId,
        baseline: baselineOf(snapshot), operationId: null,
      },
      save: { status: 'idle', code: null, message: null }, structurePreview: null,
    });
    this.refreshPreview();
  }

  /** 合并：以多选节点为来源，keepNodeId 必须为其中之一；依赖处置逐条确认。 */
  beginMerge(keepNodeId: string, patch: { title?: string; goal?: string; completionCriteria?: string[] }, resolutions: MergeResolutionView[]): void {
    const snapshot = this.state.snapshot;
    if (snapshot === null) return;
    const ids = [...this.state.selectedNodeIds];
    if (ids.length < 2 || !ids.includes(keepNodeId)) return;
    if (ids.some((id) => !snapshot.tree.some((node) => node.id === id))) return;
    this.patch({
      draft: {
        kind: 'merge-nodes', nodeId: keepNodeId, nodeIds: ids, keepNodeId,
        goal: patch.goal ?? '', title: patch.title, criteria: patch.completionCriteria === undefined ? undefined : [...patch.completionCriteria],
        resolutions: resolutions.map((item) => ({ edge: { ...item.edge }, action: item.action })),
        baseline: baselineOf(snapshot), operationId: null,
      },
      save: { status: 'idle', code: null, message: null }, structurePreview: null,
    });
    this.refreshPreview();
  }

  /** 复制：以当前单选节点为源，位置与显式外部依赖由调用方给出。 */
  beginCopy(parentId: string | null, beforeNodeId: string | null, externalDependencies: { nodeId: string; requiresNodeId: string }[]): void {
    const snapshot = this.state.snapshot;
    if (snapshot === null) return;
    const source = snapshot.tree.find((node) => node.id === this.state.selectedNodeId);
    if (source === undefined) return;
    if (parentId !== null && !snapshot.tree.some((node) => node.id === parentId)) return;
    if (beforeNodeId !== null && !snapshot.tree.some((node) => node.id === beforeNodeId && node.parentId === parentId)) return;
    this.patch({
      draft: {
        kind: 'copy-subtree', nodeId: source.id, goal: source.goal, parentId, beforeNodeId,
        externalDependencies: externalDependencies.map((edge) => ({ ...edge })),
        baseline: baselineOf(snapshot), operationId: null,
      },
      save: { status: 'idle', code: null, message: null }, structurePreview: null,
    });
    this.refreshPreview();
  }

  /** 撤销/重做：确认指纹来自只读预览，进入草稿时冻结。 */
  beginUndo(targetOperationId: string, previewDigest: string, direction: 'undo' | 'redo'): void {
    const snapshot = this.state.snapshot;
    if (snapshot === null) return;
    this.patch({
      draft: {
        kind: direction === 'undo' ? 'undo-plan-edit' : 'redo-plan-edit',
        nodeId: this.state.selectedNodeId ?? snapshot.tree[0]?.id ?? '', goal: '',
        targetOperationId, previewDigest,
        baseline: baselineOf(snapshot), operationId: null,
      },
      save: { status: 'idle', code: null, message: null }, structurePreview: null,
    });
    this.refreshPreview();
  }

  /** 保存用户模板：从所选子树（当前单选节点）抽取正文，语言为作者原文。 */
  beginSaveUserTemplate(templateId: string, title: string, bodyLanguage: string, rootNodeId: string): void {
    const snapshot = this.state.snapshot;
    if (snapshot === null) return;
    if (!snapshot.tree.some((node) => node.id === rootNodeId)) return;
    this.patch({
      draft: {
        kind: 'save-user-template', nodeId: rootNodeId, rootNodeId, goal: '',
        templateId, title, bodyLanguage,
        baseline: baselineOf(snapshot), operationId: null,
      },
      save: { status: 'idle', code: null, message: null }, structurePreview: null,
    });
    this.refreshPreview();
  }

  /** 插入用户模板：三元组来自异步目录/正文，位置必须是现有父节点。 */
  beginInsertUserTemplate(template: UserTemplateView, parentId: string, beforeNodeId: string | null): void {
    const snapshot = this.state.snapshot;
    if (snapshot === null) return;
    if (!snapshot.tree.some((node) => node.id === parentId)) return;
    if (beforeNodeId !== null && !snapshot.tree.some((node) => node.id === beforeNodeId && node.parentId === parentId)) return;
    this.patch({
      draft: {
        kind: 'insert-user-template', nodeId: parentId, goal: '', parentId, beforeNodeId,
        templateId: template.templateId, versionRecordId: template.versionRecordId,
        contentHash: template.contentHash, bodyLanguage: template.bodyLanguage, title: template.title,
        baseline: baselineOf(snapshot), operationId: null,
      },
      save: { status: 'idle', code: null, message: null }, structurePreview: null,
    });
    this.refreshPreview();
  }

  /** 独立只读回读：用户模板目录；宿主未挂载时给明确诊断，不猜测内容。 */
  async loadUserTemplates(): Promise<void> {
    const instanceId = this.state.snapshot?.instanceId;
    if (instanceId === undefined) return;
    if (this.deps.transport.userTemplates === undefined) {
      this.patch({ userTemplates: { status: 'rejected', templates: [], code: 'unsupported', message: '宿主不支持模板目录' } });
      return;
    }
    this.patch({ userTemplates: { status: 'loading', templates: [], code: null, message: null } });
    try {
      const result = await this.deps.transport.userTemplates({ instanceId });
      if (result.status === 'committed') {
        this.patch({ userTemplates: { status: 'listed', templates: result.templates.map((item) => ({
          source: 'user' as const, templateId: item.templateId, versionRecordId: item.versionRecordId,
          contentHash: item.contentHash, bodyLanguage: item.bodyLanguage, title: item.title,
        })), code: null, message: null } });
      } else {
        this.patch({ userTemplates: { status: 'rejected', templates: [], code: result.code, message: result.message } });
      }
    } catch (error) {
      this.patch({ userTemplates: { status: 'rejected', templates: [], code: 'transport-failed', message: (error as Error).message } });
    }
  }

  /** 独立只读回读：撤销历史；宿主未挂载时给明确诊断。 */
  async loadUndoHistory(): Promise<void> {
    const instanceId = this.state.snapshot?.instanceId;
    if (instanceId === undefined) return;
    if (this.deps.transport.undoHistory === undefined) {
      this.patch({ undoHistory: { status: 'rejected', entries: [], code: 'unsupported', message: '宿主不支持撤销历史' } });
      return;
    }
    this.patch({ undoHistory: { status: 'loading', entries: [], code: null, message: null } });
    try {
      const result = await this.deps.transport.undoHistory({ instanceId });
      if (result.status === 'committed') {
        this.patch({ undoHistory: { status: 'listed', entries: result.entries.map((item) => ({
          operationId: item.operationId, commandType: item.commandType, createdAt: item.createdAt,
          canUndo: item.canUndo, canRedo: item.canRedo, reason: item.reason,
        })), code: null, message: null } });
      } else {
        this.patch({ undoHistory: { status: 'rejected', entries: [], code: result.code, message: result.message } });
      }
    } catch (error) {
      this.patch({ undoHistory: { status: 'rejected', entries: [], code: 'transport-failed', message: (error as Error).message } });
    }
  }

  /**
   * 撤销/重做的只读预览：取回确认指纹与冲突对象，不写盘。
   * 预览成功只返回指纹，由界面显式确认后调用 beginUndo 进入草稿。
   */
  async previewUndoAction(
    targetOperationId: string, direction: 'undo' | 'redo',
  ): Promise<{ ok: true; previewDigest: string } | { ok: false; code: string; message: string }> {
    const instanceId = this.state.snapshot?.instanceId;
    if (instanceId === undefined) return { ok: false, code: 'unsupported', message: '未打开实例' };
    if (this.deps.transport.previewUndo === undefined) {
      return { ok: false, code: 'unsupported', message: '宿主不支持撤销预览' };
    }
    try {
      const result = await this.deps.transport.previewUndo({ instanceId, targetOperationId, direction });
      if (result.status === 'available') return { ok: true, previewDigest: result.previewDigest };
      return { ok: false, code: result.status === 'conflict' ? (result.conflicts?.[0]?.code ?? 'inverse-conflict') : result.status, message: result.message };
    } catch (error) {
      return { ok: false, code: 'transport-failed', message: (error as Error).message };
    }
  }

  /** 当前结构草稿的统一预览；内容与权威快照同步重算，取消时随草稿清空。 */
  preview(): StructurePreview | null {
    return this.state.structurePreview;
  }

  /** 已提交待同步：只重读快照（只重试读取，不重提已成功的变更）。 */
  async retryRead(): Promise<SaveStatus> {
    if (this.state.save.status !== 'committed-pending-sync') return this.state.save.status;
    const generation = this.state.connection.generation;
    try {
      const result = await this.deps.transport.snapshot({ connectionGeneration: generation });
      const outcome = this.ingest(result, generation);
      const receipt = this.state.pendingReceipt;
      const snapshot = this.state.snapshot;
      if (outcome === 'applied' && receipt !== null && snapshot !== null && snapshot.sourceEpoch === receipt.sourceEpoch) {
        this.patch({ save: { status: 'saved', code: null, message: null }, pendingReceipt: null });
        return 'saved';
      }
    } catch (error) {
      this.markOffline((error as Error).message);
    }
    return 'committed-pending-sync';
  }

  editDraft(patch: Partial<Pick<PanelDraft, 'goal' | 'title' | 'criteria'>>): void {
    const draft = this.state.draft;
    if (draft === null) return;
    this.patch({ draft: { ...draft, ...patch }, save: { status: 'idle', code: null, message: null } });
  }

  setReason(reason: string): void {
    this.patch({
      reason,
      save: this.state.save.status === 'saved' ? { status: 'idle', code: null, message: null } : this.state.save,
    });
  }

  discardDraft(): void {
    this.patch({
      draft: null, reason: '', structurePreview: null, pendingReceipt: null,
      save: { status: 'idle', code: null, message: null },
    });
  }

  /** 保存：先规划命令，再（如有原因）追加记录。失败保留草稿且不标已保存。 */
  async save(): Promise<SaveStatus> {
    // 已提交待同步：不重提已成功的变更，只重试读取。
    if (this.state.save.status === 'committed-pending-sync') return this.retryRead();
    const draft = this.state.draft;
    if (this.state.snapshot === null) return 'failed';
    if (draft === null && this.state.reason.trim() === '') return 'idle';
    // 原位移动：无变化，禁用保存。
    if (draft?.kind === 'move' && draft.noChange === true) return 'idle';
    if (this.state.save.status === 'saving') return 'saving';
    const generation = this.state.connection.generation;
    this.patch({ save: { status: 'saving', code: null, message: null } });

    if (draft !== null) {
      const operationId = draft.operationId ?? this.deps.newOperationId();
      if (draft.operationId === null) this.patch({ draft: { ...draft, operationId } });
      const command = commandOf(draft, this.state.snapshot);
      let result;
      try {
        result = await this.deps.transport.execute({
          operationId,
          command,
          expectedPlanVersion: draft.baseline.planVersion,
          expectedPlanRevision: draft.baseline.planRevision,
          sourceEpoch: draft.baseline.sourceEpoch,
        });
      } catch (error) {
        // 传输异常 = 结果未知：保留草稿与原 operationId，不换 id 重试。
        this.markOffline((error as Error).message);
        return this.fail('failed', 'transport-unknown', (error as Error).message, true);
      }
      if (result.status === 'rejected') {
        const conflict = result.code === 'plan-conflict' || result.code === 'source-changed';
        return this.fail(conflict ? 'conflict' : 'failed', result.code, result.message, true);
      }
      if (result.status === 'pending-reconciliation') {
        return this.fail('pending', 'pending-reconciliation', result.message, true);
      }
      // 规划已提交：清草稿，再按需追加原因记录。
      this.patch({ draft: null });
      // 回读须与回执同源：结构操作与既有节点编辑共用同一判据。
      const synced = await this.reloadQuietly(generation, result);
      if (this.state.reason.trim() !== '') {
        const recorded = await this.appendReason(
          [reasonSubjectOf(draft)],
          result.planVersion,
          result.planRevision,
          result.sourceEpoch,
        );
        if (!recorded) {
          return this.fail('partial', 'record-failed', null, false);
        }
        this.patch({ reason: '' });
      }
      // 回读成功才算普通已保存；已确认但回读失败/落后 → 已提交待同步（只重读）。
      if (!synced) {
        this.patch({
          save: { status: 'committed-pending-sync', code: 'snapshot-not-synced', message: null },
          pendingReceipt: {
            planVersion: result.planVersion, planRevision: result.planRevision,
            stateRevision: result.stateRevision, sourceEpoch: result.sourceEpoch,
          },
        });
        return 'committed-pending-sync';
      }
      this.patch({ save: { status: 'saved', code: null, message: null } });
      return 'saved';
    }

    // 只有变更原因：直接追加记录（用当前快照作为基线）。
    const snapshot = this.state.snapshot;
    const subjects = this.state.selectedNodeId ?? snapshot.tree[0]?.id;
    if (subjects === undefined) return this.fail('failed', 'no-subject', null, false);
    const recorded = await this.appendReason([subjects], snapshot.planVersion, snapshot.planRevision, snapshot.sourceEpoch);
    await this.reloadQuietly(generation);
    if (!recorded) return this.fail('failed', 'record-failed', null, false);
    this.patch({ reason: '', save: { status: 'saved', code: null, message: null } });
    return 'saved';
  }

  /** 应用一次读取结果：代际 → 源代际 → 修订，逐层守卫。 */
  ingest(result: Awaited<ReturnType<PanelTransport['snapshot']>>, generation: number): IngestOutcome {
    if (generation !== this.state.connection.generation) return 'stale-generation';
    if (result.status === 'rejected') {
      if (result.code === 'stale-connection') return 'stale-generation';
      this.patch({ connection: { ...this.state.connection, status: 'connected', error: `${result.code}: ${result.message}` } });
      return 'failed';
    }
    if (result.status === 'unsynced') {
      // 不一致时不改树：宁可显示旧内容并标未同步，也不混两版。
      this.patch({
        connection: { ...this.state.connection, status: 'connected', error: `快照未同步（${result.reason}）：${result.detail}` },
      });
      return 'unsynced';
    }
    const verdict = this.accepts(result.snapshot);
    if (verdict !== 'applied') return verdict;
    this.apply(result.snapshot);
    return 'applied';
  }

  private accepts(snapshot: PanelSnapshot): 'applied' | 'stale-source' | 'stale-revision' {
    const current = this.state.snapshot;
    if (current === null) return 'applied';
    if (current.instanceId === snapshot.instanceId) {
      // 旧源：整体过期，丢弃整份内容，不用它覆盖新代际。
      if (snapshot.sourceEpoch < current.sourceEpoch) return 'stale-source';
      // 同代际内只接受不更旧的修订（乱序答复不覆盖新状态）。
      if (snapshot.sourceEpoch === current.sourceEpoch && snapshot.stateRevision < current.stateRevision) {
        return 'stale-revision';
      }
    }
    return 'applied';
  }

  private apply(snapshot: PanelSnapshot): void {
    const selected =
      this.state.selectedNodeId !== null && snapshot.tree.some((node) => node.id === this.state.selectedNodeId)
        ? this.state.selectedNodeId
        : (snapshot.tree[0]?.id ?? null);
    this.patch({
      phase: 'ready',
      snapshot,
      selectedNodeId: selected,
      message: null,
      connection: { ...this.state.connection, status: 'connected', error: null },
    });
    // 结构草稿预览依赖权威快照；快照刷新后重算（草稿与基线保持不变）。
    if (this.state.draft?.kind === 'move' || this.state.draft?.kind === 'insert-preset') this.refreshPreview();
  }

  private async load(minStateRevision?: number): Promise<void> {
    const generation = this.state.connection.generation;
    this.patch({ phase: this.state.snapshot === null ? 'loading' : this.state.phase, message: null });
    let status: ConaProjectStatus;
    try {
      status = await this.deps.transport.status();
    } catch (error) {
      this.markOffline((error as Error).message);
      if (this.state.snapshot === null) this.patch({ phase: 'error', message: (error as Error).message });
      return;
    }
    if (generation !== this.state.connection.generation) return;
    if (!status.configured) {
      this.patch({ phase: 'error', status, message: status.error?.message ?? '未配置资料源' });
      return;
    }
    let result: Awaited<ReturnType<PanelTransport['snapshot']>>;
    try {
      result = await this.deps.transport.snapshot({
        connectionGeneration: generation,
        ...(minStateRevision === undefined ? {} : { minStateRevision }),
      });
    } catch (error) {
      this.markOffline((error as Error).message);
      if (this.state.snapshot === null) this.patch({ phase: 'error', status, message: (error as Error).message });
      return;
    }
    if (result.status === 'snapshot') {
      this.patch({ status });
      this.ingest(result, generation);
      if (this.state.save.status === 'saved') this.patch({ save: { status: 'idle', code: null, message: null } });
      return;
    }
    const outcome = this.ingest(result, generation);
    if (outcome === 'stale-generation') return;
    this.patch({
      status,
      ...(this.state.snapshot === null
        ? { phase: 'error' as const, message: describeFailure(result) }
        : {}),
    });
  }

  /**
   * 提交后回读：只有快照覆盖回执（同实例、源代际、规划/状态修订与指纹匹配）才算同步成功。
   * 已确认提交但回读失败或落后时返回 false——调用方据此显示「已提交，待同步」，只重试读取。
   */
  private async reloadQuietly(generation: number, receipt?: { planVersion: string; planRevision: number; stateRevision: number; sourceEpoch: number }): Promise<boolean> {
    try {
      const result = await this.deps.transport.snapshot({ connectionGeneration: generation });
      const outcome = this.ingest(result, generation);
      if (receipt === undefined || outcome !== 'applied') return outcome === 'applied';
      const snapshot = this.state.snapshot;
      // 同源判定：完整回读成功（outcome=applied）且仍属同一资料源代际，才算已同步。
      // 换源后旧回执属于历史，由 sourceEpoch 核对拦截；修订单调由 ingest.accepts 守卫。
      // 真实的「回执已确认但完整回读失败」由 outcome !== applied / 抛错捕获。
      return snapshot !== null && snapshot.sourceEpoch === receipt.sourceEpoch;
    } catch (error) {
      this.markOffline((error as Error).message);
      return false;
    }
  }

  private async appendReason(
    subjectNodeIds: string[],
    planVersion: string,
    planRevision: number,
    sourceEpoch: number,
  ): Promise<boolean> {
    const reason = this.state.reason.trim();
    try {
      const result = await this.deps.transport.execute({
        operationId: this.deps.newOperationId(),
        command: {
          type: 'append-record',
          kind: 'plan-change',
          subjectNodeIds,
          summary: reason,
          sources: [],
          body: `# 变更原因\n\n${reason}\n`,
        },
        expectedPlanVersion: planVersion,
        expectedPlanRevision: planRevision,
        sourceEpoch,
      });
      return result.status === 'committed';
    } catch {
      return false;
    }
  }

  /** 原位判定：模拟移动后的同级顺序，看节点新位置是否等于当前位置。 */
  private isMoveNoChange(node: { id: string; parentId: string | null; order: number }, parentId: string | null, beforeNodeId: string | null, snapshot: PanelSnapshot): boolean {
    if (node.parentId !== parentId) return false;
    const all = snapshot.tree.filter((item) => item.parentId === parentId).sort((a, b) => a.order - b.order);
    const originalIndex = all.findIndex((item) => item.id === node.id);
    if (originalIndex < 0) return false;
    const rest = all.filter((item) => item.id !== node.id);
    const newIndex = beforeNodeId === null
      ? rest.length
      : rest.findIndex((item) => item.id === beforeNodeId);
    return newIndex === originalIndex;
  }

  /** 从草稿 + 权威快照生成预览；草稿变化或快照刷新后重算。 */
  private refreshPreview(): void {
    const draft = this.state.draft;
    const snapshot = this.state.snapshot;
    if (draft === null || snapshot === null) {
      this.patch({ structurePreview: null });
      return;
    }
    const workNotice = (snapshot.local.workRunCount ?? 0) > 0;
    const titleOf = (id: string): string => snapshot.tree.find((node) => node.id === id)?.title ?? id;
    // 2.1–2.5：分组/合并/复制/撤销/模板的本地预览；来源与依赖以原文展示，不落盘。
    if (draft.kind !== 'move' && draft.kind !== 'insert-preset') {
      const base = {
        targetParentId: draft.parentId ?? null,
        beforeNodeId: draft.beforeNodeId ?? null,
        noChange: false,
        workNotice,
      };
      if (draft.kind === 'group-nodes') {
        this.patch({ structurePreview: {
          ...base, kind: 'group', sources: (draft.nodeIds ?? []).map(titleOf),
          lines: (draft.nodeIds ?? []).map((id) => ({ depth: 1, title: titleOf(id) })),
        } });
        return;
      }
      if (draft.kind === 'merge-nodes') {
        this.patch({ structurePreview: {
          ...base, kind: 'merge',
          sources: (draft.nodeIds ?? []).filter((id) => id !== draft.keepNodeId).map(titleOf),
          lines: [{ depth: 0, title: `保留：${titleOf(draft.keepNodeId ?? draft.nodeId)}` }],
        } });
        return;
      }
      if (draft.kind === 'copy-subtree') {
        this.patch({ structurePreview: {
          ...base, kind: 'copy', sources: [titleOf(draft.nodeId)],
          lines: [{ depth: 0, title: `复制：${titleOf(draft.nodeId)}` }],
          externalDependencies: (draft.externalDependencies ?? []).map((edge) => ({ from: titleOf(edge.nodeId), to: titleOf(edge.requiresNodeId) })),
        } });
        return;
      }
      if (draft.kind === 'undo-plan-edit' || draft.kind === 'redo-plan-edit') {
        this.patch({ structurePreview: {
          ...base, kind: draft.kind === 'undo-plan-edit' ? 'undo' : 'redo',
          sources: [draft.targetOperationId ?? ''],
          lines: [{ depth: 0, title: draft.targetOperationId ?? '' }],
        } });
        return;
      }
      if (draft.kind === 'save-user-template') {
        this.patch({ structurePreview: {
          ...base, kind: 'save-template', sources: [titleOf(draft.rootNodeId ?? draft.nodeId)],
          lines: [{ depth: 0, title: titleOf(draft.rootNodeId ?? draft.nodeId) }],
          templateSource: {
            templateId: draft.templateId ?? '', versionRecordId: '', contentHash: '',
            bodyLanguage: draft.bodyLanguage,
          },
        } });
        return;
      }
      if (draft.kind === 'insert-user-template') {
        this.patch({ structurePreview: {
          ...base, kind: 'insert-user-template',
          lines: [{ depth: 0, title: `插入：${draft.title ?? ''}` }],
          templateSource: {
            templateId: draft.templateId ?? '', versionRecordId: draft.versionRecordId ?? '',
            contentHash: draft.contentHash ?? '', bodyLanguage: draft.bodyLanguage,
          },
        } });
        return;
      }
      this.patch({ structurePreview: null });
      return;
    }
    if (draft.kind === 'move') {
      const node = snapshot.tree.find((item) => item.id === draft.nodeId);
      const parent = draft.parentId === null ? null : snapshot.tree.find((item) => item.id === draft.parentId);
      const anchor = draft.beforeNodeId === null ? null : snapshot.tree.find((item) => item.id === draft.beforeNodeId);
      const lines: { depth: number; title: string }[] = [];
      if (parent !== undefined && parent !== null) {
        let depth = 0;
        let cursor: string | null = parent.parentId;
        while (cursor !== null) {
          depth += 1;
          cursor = snapshot.tree.find((item) => item.id === cursor)?.parentId ?? null;
        }
        lines.push({ depth, title: parent.title });
      }
      if (node !== undefined) lines.push({ depth: (lines[0]?.depth ?? 0) + 1, title: `移动：${node.title}` });
      if (anchor !== undefined && anchor !== null) lines.push({ depth: (lines[0]?.depth ?? 0) + 1, title: `插入到「${anchor.title}」之前` });
      this.patch({
        structurePreview: {
          kind: 'move', lines,
          targetParentId: draft.parentId ?? null,
          beforeNodeId: draft.beforeNodeId ?? null,
          noChange: draft.noChange ?? false,
          workNotice,
        },
      });
      return;
    }
    // 插入预设：节点键按层级/顺序展示，内部依赖映射为本次语言的标题。
    const preset = draft.preset;
    const locale = draft.contentLocale ?? 'en';
    const lines: { depth: number; title: string }[] = [];
    for (const ref of [...(preset?.nodes ?? [])].sort((a, b) => a.order - b.order)) {
      const depth = ref.parentKey === null ? 0 : 1;
      const title = preset?.text[locale as 'zh-CN' | 'en']?.[ref.key]?.title ?? ref.key;
      lines.push({ depth, title: ref.parentKey === null ? `插入：${title}` : title });
    }
    this.patch({
      structurePreview: {
        kind: 'insert', lines,
        targetParentId: draft.parentId ?? null,
        beforeNodeId: draft.beforeNodeId ?? null,
        noChange: false,
        workNotice,
        preset: preset === undefined ? undefined : {
          id: preset.id, version: preset.version, source: preset.source,
          locales: [...preset.contentLocales], contentLocale: locale,
          name: preset.content[locale as 'zh-CN' | 'en']?.title ?? preset.id,
          description: preset.content[locale as 'zh-CN' | 'en']?.description ?? '',
          dependencies: preset.dependencies.map((edge) => ({
            from: preset.text[locale as 'zh-CN' | 'en']?.[edge.nodeKey]?.title ?? edge.nodeKey,
            to: preset.text[locale as 'zh-CN' | 'en']?.[edge.requiresKey]?.title ?? edge.requiresKey,
          })),
        },
      },
    });
  }

  private fail(status: SaveStatus, code: string | null, message: string | null, keepDraft: boolean): SaveStatus {
    this.patch({
      save: { status, code, message },
      ...(keepDraft ? {} : { draft: null }),
    });
    return status;
  }

  private patch(patch: Partial<PanelState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener(this.state);
  }
}

function describeFailure(result: Extract<Awaited<ReturnType<PanelTransport['snapshot']>>, { status: 'rejected' | 'unsynced' }>): string {
  return result.status === 'rejected'
    ? `${result.code}: ${result.message}`
    : `快照未同步（${result.reason}）：${result.detail}`;
}

function baselineOf(snapshot: PanelSnapshot): DraftBaseline {
  return {
    planVersion: snapshot.planVersion,
    planRevision: snapshot.planRevision,
    stateRevision: snapshot.stateRevision,
    sourceEpoch: snapshot.sourceEpoch,
  };
}

/** 变更原因的记录主体：移动以移动节点为主体，插入以目标父节点为主体（design §7）。 */
function reasonSubjectOf(draft: PanelDraft): string {
  return draft.nodeId;
}

/** 草稿 → 规划命令；新节点 order 取同级最大值 +1（资料要求同级有序且不重复）。 */
function commandOf(draft: PanelDraft, snapshot: PanelSnapshot): Command {
  if (draft.kind === 'update-goal') {
    return { type: 'update-node', nodeId: draft.nodeId, patch: { goal: draft.goal } };
  }
  if (draft.kind === 'move') {
    return {
      type: 'move-node',
      nodeId: draft.nodeId,
      parentId: draft.parentId ?? null,
      beforeNodeId: draft.beforeNodeId ?? null,
    };
  }
  if (draft.kind === 'insert-preset') {
    return {
      type: 'insert-preset',
      templateId: draft.templateId ?? '',
      templateVersion: draft.templateVersion ?? 0,
      contentLocale: (draft.contentLocale ?? 'en') as 'zh-CN' | 'en',
      parentId: draft.parentId ?? null,
      beforeNodeId: draft.beforeNodeId ?? null,
    };
  }
  if (draft.kind === 'group-nodes') {
    return {
      type: 'group-nodes',
      nodeIds: [...(draft.nodeIds ?? [])],
      group: { title: draft.title ?? '', goal: draft.goal, completionCriteria: [...(draft.criteria ?? [])] },
      anchorId: draft.beforeNodeId ?? null,
    };
  }
  if (draft.kind === 'merge-nodes') {
    return {
      type: 'merge-nodes',
      keepNodeId: draft.keepNodeId ?? draft.nodeId,
      sourceNodeIds: [...(draft.nodeIds ?? [])],
      ...(draft.title === undefined && draft.criteria === undefined
        ? {}
        : { patch: {
            ...(draft.title === undefined ? {} : { title: draft.title }),
            ...(draft.goal === '' ? {} : { goal: draft.goal }),
            ...(draft.criteria === undefined ? {} : { completionCriteria: [...draft.criteria] }),
          } }),
      resolutions: [...(draft.resolutions ?? [])],
    };
  }
  if (draft.kind === 'copy-subtree') {
    return {
      type: 'copy-subtree', nodeId: draft.nodeId,
      targetParentId: draft.parentId ?? null, anchorId: draft.beforeNodeId ?? null,
      externalDependencies: [...(draft.externalDependencies ?? [])],
    };
  }
  if (draft.kind === 'undo-plan-edit' || draft.kind === 'redo-plan-edit') {
    return {
      type: draft.kind, targetOperationId: draft.targetOperationId ?? '', previewDigest: draft.previewDigest ?? '',
    };
  }
  if (draft.kind === 'save-user-template') {
    return {
      type: 'save-user-template', templateId: draft.templateId ?? '', title: draft.title ?? '',
      bodyLanguage: draft.bodyLanguage ?? 'und', rootNodeId: draft.rootNodeId ?? draft.nodeId,
    };
  }
  if (draft.kind === 'insert-user-template') {
    return {
      type: 'insert-user-template', templateId: draft.templateId ?? '',
      versionRecordId: draft.versionRecordId ?? '', contentHash: draft.contentHash ?? '',
      parentId: draft.parentId ?? null, beforeNodeId: draft.beforeNodeId ?? null,
    };
  }
  const siblings = snapshot.tree.filter((node) => node.parentId === draft.nodeId).map((node) => node.order);
  const order = siblings.length === 0 ? 0 : Math.max(...siblings) + 1;
  return {
    type: 'add-nodes',
    nodes: [
      {
        parentId: draft.nodeId,
        order,
        title: draft.title ?? '',
        goal: draft.goal,
        completionCriteria: [...(draft.criteria ?? [])],
      },
    ],
  };
}
