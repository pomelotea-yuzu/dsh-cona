// 面板控制器（5.2）：小树／详情／目标编辑／节点新增／变更原因的纯状态机。
//
// 规则（design §8、tasks 5.2）：
// - 草稿单独保存，权威快照刷新不清空草稿；
// - 保存失败或冲突时草稿保留，且**不标已保存**；
// - 结果未知（pending-reconciliation 或传输异常）时保留原 operationId，不换 id 重试；
// - 变更原因在规划命令成功之后追加为 `plan-change` 记录；记录失败如实标 partial，不谎报已保存。
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
  connectionGeneration: number;
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
  connectionGeneration: 1,
};

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

  /** 打开／重新读取权威快照。草稿与原因不被清空。 */
  async open(): Promise<void> {
    this.patch({ phase: this.state.snapshot === null ? 'loading' : this.state.phase, message: null });
    const status = await this.deps.transport.status();
    if (!status.configured) {
      this.patch({
        phase: 'error',
        status,
        message: status.error?.message ?? '未配置资料源',
      });
      return;
    }
    const result = await this.deps.transport.snapshot({ connectionGeneration: this.state.connectionGeneration });
    if (result.status === 'rejected') {
      this.patch({ phase: 'error', status, message: `${result.code}: ${result.message}` });
      return;
    }
    if (result.status === 'unsynced') {
      this.patch({
        phase: 'error',
        status,
        message: `快照未同步（${result.reason}）：${result.detail}`,
      });
      return;
    }
    const snapshot = result.snapshot;
    const selected =
      this.state.selectedNodeId !== null && snapshot.tree.some((node) => node.id === this.state.selectedNodeId)
        ? this.state.selectedNodeId
        : (snapshot.tree[0]?.id ?? null);
    this.patch({ phase: 'ready', status, snapshot, selectedNodeId: selected, message: null });
    // 打开成功后清掉“已保存”提示，避免把上一次结果当成当前状态。
    if (this.state.save.status === 'saved') this.patch({ save: { status: 'idle', message: null } });
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
        await this.reloadQuietly();
        if (!recorded) {
          return this.fail('partial', '规划已保存，但变更原因记录未写入；原因已保留，可单独重试', false);
        }
        this.patch({ reason: '', save: { status: 'saved', message: null } });
        return 'saved';
      }
      await this.reloadQuietly();
      this.patch({ save: { status: 'saved', message: null } });
      return 'saved';
    }

    // 只有变更原因：直接追加记录（用当前快照作为基线）。
    const snapshot = this.state.snapshot;
    const subjects = this.state.selectedNodeId ?? snapshot.tree[0]?.id;
    if (subjects === undefined) return this.fail('failed', '没有可关联的节点；原因未写入', false);
    const recorded = await this.appendReason([subjects], snapshot.planVersion, snapshot.planRevision, snapshot.sourceEpoch);
    await this.reloadQuietly();
    if (!recorded) return this.fail('failed', '变更原因未写入；内容已保留', false);
    this.patch({ reason: '', save: { status: 'saved', message: null } });
    return 'saved';
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

  /** 重新读快照但不覆盖草稿；失败只更新提示。 */
  private async reloadQuietly(): Promise<void> {
    try {
      const result = await this.deps.transport.snapshot({ connectionGeneration: this.state.connectionGeneration });
      if (result.status === 'snapshot') {
        const snapshot = result.snapshot;
        const selected =
          this.state.selectedNodeId !== null && snapshot.tree.some((node) => node.id === this.state.selectedNodeId)
            ? this.state.selectedNodeId
            : (snapshot.tree[0]?.id ?? null);
        this.patch({ snapshot, selectedNodeId: selected, phase: 'ready' });
      }
    } catch {
      // 回读失败不改“已提交”的事实；面板保留旧快照并等待下次刷新。
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
