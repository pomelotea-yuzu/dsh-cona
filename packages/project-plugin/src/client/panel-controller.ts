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

import type { Command, PanelSnapshot, PanelTransport, ConaProjectStatus } from './api.js';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'conflict' | 'pending' | 'failed' | 'partial';

export interface DraftBaseline {
  planVersion: string;
  planRevision: number;
  stateRevision: number;
  sourceEpoch: number;
}

/** 一份草稿：目标编辑或新增节点。同一时间只保留一份，避免合并冲突。 */
export interface PanelDraft {
  kind: 'update-goal' | 'add-node';
  /** 目标编辑的节点 id；新增节点时为父节点 id。 */
  nodeId: string;
  goal: string;
  /** 仅新增节点使用。 */
  title?: string;
  criteria?: string[];
  /** 进入草稿时的权威基线（保存时作为 expected* 提交，不随刷新变化）。 */
  baseline: DraftBaseline;
  /** 已发出的 operationId：重试复用同一个，避免结果未知时重复应用。 */
  operationId: string | null;
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
  draft: PanelDraft | null;
  /** 变更原因：随本次保存追加一条 plan-change 记录。 */
  reason: string;
  save: { status: SaveStatus; message: string | null };
  connection: ConnectionState;
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
  draft: null,
  reason: '',
  save: { status: 'idle', message: null },
  connection: { generation: 1, status: 'connected', error: null },
};

/** 一次读取的结论：是否被采纳、是否因代际／修订过旧被丢弃。 */
export type IngestOutcome = 'applied' | 'stale-generation' | 'stale-source' | 'stale-revision' | 'unsynced' | 'failed';

/** 面板状态机：所有写入都返回新状态并通知订阅者。 */
export class PanelController {
  private state: PanelState = EMPTY;
  private readonly listeners = new Set<(state: PanelState) => void>();

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

  /** 打开／重新读取权威快照。草稿与原因不被清空。 */
  async open(): Promise<void> {
    await this.load();
  }

  /**
   * 重连：递增连接代际后完整回读。
   * 旧代际的迟到答复因代际不符被丢弃；草稿保留。
   */
  async reconnect(): Promise<void> {
    this.patch({
      connection: { generation: this.state.connection.generation + 1, status: 'connected', error: null },
    });
    await this.load();
  }

  /** 连接失败：保留内容与草稿，只标离线。 */
  markOffline(reason: string): void {
    this.patch({ connection: { ...this.state.connection, status: 'offline', error: reason } });
  }

  /**
   * 轮询一次快照（R1 的失效检测）：带 `minStateRevision` 追读；受代际与修订守卫约束。
   * 失败只标离线，不清空树与草稿。
   */
  async poll(): Promise<IngestOutcome> {
    if (this.state.snapshot === null) return 'failed';
    const generation = this.state.connection.generation;
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
    this.patch({ selectedNodeId: nodeId });
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
      save: { status: 'idle', message: null },
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
      save: { status: 'idle', message: null },
    });
  }

  editDraft(patch: Partial<Pick<PanelDraft, 'goal' | 'title' | 'criteria'>>): void {
    const draft = this.state.draft;
    if (draft === null) return;
    this.patch({ draft: { ...draft, ...patch }, save: { status: 'idle', message: null } });
  }

  setReason(reason: string): void {
    this.patch({ reason, save: this.state.save.status === 'saved' ? { status: 'idle', message: null } : this.state.save });
  }

  discardDraft(): void {
    this.patch({ draft: null, reason: '', save: { status: 'idle', message: null } });
  }

  /** 保存：先规划命令，再（如有原因）追加记录。失败保留草稿且不标已保存。 */
  async save(): Promise<SaveStatus> {
    const draft = this.state.draft;
    if (this.state.snapshot === null) return 'failed';
    if (draft === null && this.state.reason.trim() === '') return 'idle';
    if (this.state.save.status === 'saving') return 'saving';
    const generation = this.state.connection.generation;
    this.patch({ save: { status: 'saving', message: null } });

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
        return this.fail('failed', `保存结果未知（${(error as Error).message}）；草稿已保留，请先核对后再重试`, true);
      }
      if (result.status === 'rejected') {
        const conflict = result.code === 'plan-conflict' || result.code === 'source-changed';
        return this.fail(
          conflict ? 'conflict' : 'failed',
          conflict ? '资料已被改动（规划冲突），草稿已保留；请对照后重新保存' : `${result.code}: ${result.message}`,
          true,
        );
      }
      if (result.status === 'pending-reconciliation') {
        return this.fail('pending', `发布结果待核对（${result.stage}）：${result.message}；草稿已保留`, true);
      }
      // 规划已提交：清草稿，再按需追加原因记录。
      this.patch({ draft: null });
      if (this.state.reason.trim() !== '') {
        const recorded = await this.appendReason(
          [draft.nodeId],
          result.planVersion,
          result.planRevision,
          result.sourceEpoch,
        );
        await this.reloadQuietly(generation);
        if (!recorded) {
          return this.fail('partial', '规划已保存，但变更原因记录未写入；原因已保留，可单独重试', false);
        }
        this.patch({ reason: '', save: { status: 'saved', message: null } });
        return 'saved';
      }
      await this.reloadQuietly(generation);
      this.patch({ save: { status: 'saved', message: null } });
      return 'saved';
    }

    // 只有变更原因：直接追加记录（用当前快照作为基线）。
    const snapshot = this.state.snapshot;
    const subjects = this.state.selectedNodeId ?? snapshot.tree[0]?.id;
    if (subjects === undefined) return this.fail('failed', '没有可关联的节点；原因未写入', false);
    const recorded = await this.appendReason([subjects], snapshot.planVersion, snapshot.planRevision, snapshot.sourceEpoch);
    await this.reloadQuietly(generation);
    if (!recorded) return this.fail('failed', '变更原因未写入；内容已保留', false);
    this.patch({ reason: '', save: { status: 'saved', message: null } });
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
  }

  private async load(): Promise<void> {
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
      result = await this.deps.transport.snapshot({ connectionGeneration: generation });
    } catch (error) {
      this.markOffline((error as Error).message);
      if (this.state.snapshot === null) this.patch({ phase: 'error', status, message: (error as Error).message });
      return;
    }
    if (result.status === 'snapshot') {
      this.patch({ status });
      this.ingest(result, generation);
      if (this.state.save.status === 'saved') this.patch({ save: { status: 'idle', message: null } });
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

  /** 重新读快照但不覆盖草稿；失败只更新连接提示。受同一代际与修订守卫约束。 */
  private async reloadQuietly(generation: number): Promise<void> {
    try {
      const result = await this.deps.transport.snapshot({ connectionGeneration: generation });
      this.ingest(result, generation);
    } catch (error) {
      this.markOffline((error as Error).message);
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

  private fail(status: SaveStatus, message: string, keepDraft: boolean): SaveStatus {
    this.patch({
      save: { status, message },
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

/** 草稿 → 规划命令；新节点 order 取同级最大值 +1（资料要求同级有序且不重复）。 */
function commandOf(draft: PanelDraft, snapshot: PanelSnapshot): Command {
  if (draft.kind === 'update-goal') {
    return { type: 'update-node', nodeId: draft.nodeId, patch: { goal: draft.goal } };
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
