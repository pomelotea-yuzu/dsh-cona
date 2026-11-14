// 项目面板（tasks 5.2）：小树、详情、目标编辑、节点新增、变更原因与位置展示。
//
// 渲染层只读控制器状态并调用其方法；保存规则、草稿保留与失败标记都在
// `panel-controller.ts` 里，可脱离浏览器测试。文案固定中文，i18n 在 5.4 接。

import { useEffect, useState } from 'react';
import type { PanelController, PanelState } from './panel-controller.js';
import type { PanelSnapshot } from './api.js';

export interface ProjectPanelProps {
  controller: PanelController;
}

/** 面板根组件：订阅控制器状态。 */
export function ProjectPanel({ controller }: ProjectPanelProps): JSX.Element {
  const [state, setState] = useState<PanelState>(controller.getState());

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    void controller.open();
    return unsubscribe;
  }, [controller]);

  if (state.phase === 'loading' || state.phase === 'idle') {
    return <p style={{ padding: 16, color: 'var(--dsh-text-secondary, #666)' }}>正在读取项目…</p>;
  }
  if (state.phase === 'error' || state.snapshot === null) {
    return (
      <section style={{ padding: 16 }}>
        <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>项目</h2>
        <p style={{ color: '#b3261e', margin: '0 0 12px' }}>{state.message ?? '资料源不可用'}</p>
        <button type="button" onClick={() => void controller.open()}>
          重新读取
        </button>
      </section>
    );
  }

  const snapshot = state.snapshot;
  const selected = snapshot.tree.find((node) => node.id === state.selectedNodeId) ?? snapshot.tree[0];
  const depths = depthMap(snapshot);

  return (
    <section style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Header state={state} snapshot={snapshot} onRefresh={() => void controller.open()} />
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <nav style={{ width: 260, borderRight: '1px solid var(--dsh-border, #e5e5e5)', overflowY: 'auto', padding: '8px 0' }}>
          {snapshot.tree.map((node) => (
            <button
              key={node.id}
              type="button"
              onClick={() => controller.select(node.id)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '6px 12px',
                paddingLeft: 12 + (depths.get(node.id) ?? 0) * 14,
                background: node.id === selected?.id ? 'var(--dsh-bg-selected, #eef2f7)' : 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontSize: 13,
                color: 'inherit',
              }}
            >
              <span style={{ color: 'var(--dsh-text-secondary, #777)', marginRight: 6 }}>{node.order}</span>
              {node.title}
              <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--dsh-text-secondary, #777)' }}>{node.status}</span>
            </button>
          ))}
        </nav>
        <main style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {selected === undefined ? (
            <p>资料里没有节点。</p>
          ) : (
            <NodeDetail controller={controller} state={state} node={selected} />
          )}
        </main>
      </div>
      <footer style={{ borderTop: '1px solid var(--dsh-border, #e5e5e5)', padding: '8px 16px', fontSize: 12 }}>
        <SaveBar controller={controller} state={state} />
      </footer>
    </section>
  );
}

function Header(props: { state: PanelState; snapshot: PanelSnapshot; onRefresh: () => void }): JSX.Element {
  const { state, snapshot, onRefresh } = props;
  const sync = snapshot.sync.status === 'synced' ? '已同步' : '未同步（需刷新）';
  return (
    <header style={{ borderBottom: '1px solid var(--dsh-border, #e5e5e5)', padding: '10px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>{snapshot.project.title}</h2>
        <span style={{ fontSize: 12, color: 'var(--dsh-text-secondary, #777)' }}>{sync}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--dsh-text-secondary, #777)' }}>
          规划修订 {snapshot.planRevision} · 状态修订 {snapshot.stateRevision}
        </span>
        <button type="button" onClick={onRefresh}>
          刷新
        </button>
      </div>
      <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--dsh-text-secondary, #777)' }}>
        位置：{snapshot.source.displayPath}（{snapshot.source.kind}）
      </p>
      {state.status?.localRootDisplay === undefined || state.status?.localRootDisplay === null ? null : (
        <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--dsh-text-secondary, #777)' }}>
          本机数据：{state.status.localRootDisplay}
        </p>
      )}
    </header>
  );
}

function NodeDetail(props: { controller: PanelController; state: PanelState; node: PanelSnapshot['tree'][number] }): JSX.Element {
  const { controller, state, node } = props;
  const draft = state.draft;
  const draftGoal = draft !== null && draft.kind === 'update-goal' && draft.nodeId === node.id ? draft.goal : null;
  const adding = draft !== null && draft.kind === 'add-node' && draft.nodeId === node.id;
  const [goalText, setGoalText] = useState(node.goal);

  // 切换节点或权威目标变化时重置输入，但草稿优先（草稿不因刷新被清空）。
  useEffect(() => {
    setGoalText(draftGoal ?? node.goal);
  }, [node.id, node.goal, draftGoal]);

  return (
    <article>
      <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>{node.title}</h3>
      <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--dsh-text-secondary, #777)' }}>
        {node.status} · 顺序 {node.order} · {node.completionCriteria.length} 条完成条件
      </p>
      {node.completionCriteria.length === 0 ? null : (
        <ul style={{ margin: '0 0 12px 16px', padding: 0, fontSize: 12 }}>
          {node.completionCriteria.map((item, index) => (
            <li key={`${node.id}-criterion-${index}`}>{item}</li>
          ))}
        </ul>
      )}

      <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }} htmlFor="cona-goal">
        目标
      </label>
      <textarea
        id="cona-goal"
        value={draftGoal ?? goalText}
        onChange={(event) => {
          setGoalText(event.target.value);
          controller.editGoal(node.id, event.target.value);
        }}
        rows={3}
        style={{ width: '100%', boxSizing: 'border-box', fontSize: 13 }}
      />
      <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
        <button type="button" onClick={() => void controller.save()} disabled={!controller.isDirty()}>
          保存
        </button>
        <button type="button" onClick={() => controller.discardDraft()} disabled={draft === null && state.reason === ''}>
          放弃草稿
        </button>
        <button type="button" onClick={() => controller.beginAddNode(node.id)}>
          在此新增子节点
        </button>
      </div>

      <label style={{ display: 'block', fontSize: 12, margin: '12px 0 4px' }} htmlFor="cona-reason">
        变更原因（保存时追加为 plan-change 记录）
      </label>
      <input
        id="cona-reason"
        value={state.reason}
        onChange={(event) => controller.setReason(event.target.value)}
        style={{ width: '100%', boxSizing: 'border-box', fontSize: 13 }}
      />

      {adding ? (
        <section style={{ marginTop: 16, borderTop: '1px solid var(--dsh-border, #e5e5e5)', paddingTop: 12 }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>新增子节点（父节点：{node.title}）</h4>
          <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>
            标题
            <input
              value={draft.title ?? ''}
              onChange={(event) => controller.editDraft({ title: event.target.value })}
              style={{ display: 'block', width: '100%', boxSizing: 'border-box', fontSize: 13 }}
            />
          </label>
          <label style={{ display: 'block', fontSize: 12, margin: '8px 0 4px' }}>
            目标
            <input
              value={draft.goal}
              onChange={(event) => controller.editDraft({ goal: event.target.value })}
              style={{ display: 'block', width: '100%', boxSizing: 'border-box', fontSize: 13 }}
            />
          </label>
          <button type="button" style={{ marginTop: 8 }} onClick={() => void controller.save()}>
            保存新节点
          </button>
        </section>
      ) : null}
    </article>
  );
}

function SaveBar(props: { controller: PanelController; state: PanelState }): JSX.Element {
  const { controller, state } = props;
  const { status, message } = state.save;
  const label: Record<string, string> = {
    idle: controller.isDirty() ? '有未保存修改' : '无修改',
    saving: '保存中…',
    saved: '已保存',
    conflict: '冲突：草稿已保留',
    pending: '结果待核对：草稿已保留',
    failed: '保存失败：草稿已保留',
    partial: '部分保存：规划已保存，原因未写入',
  };
  const color = status === 'saved' ? '#1b5e20' : status === 'idle' ? '#666' : '#b3261e';
  return (
    <span style={{ color }}>
      {label[status] ?? status}
      {message === null ? '' : ` · ${message}`}
    </span>
  );
}

/** 由 parentId 计算缩进深度（数据已保证父节点存在）。 */
function depthMap(snapshot: PanelSnapshot): Map<string, number> {
  const byId = new Map(snapshot.tree.map((node) => [node.id, node]));
  const depths = new Map<string, number>();
  const depthOf = (id: string): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    const node = byId.get(id);
    if (node === undefined || node.parentId === null) {
      depths.set(id, 0);
      return 0;
    }
    const depth = depthOf(node.parentId) + 1;
    depths.set(id, depth);
    return depth;
  };
  for (const node of snapshot.tree) depthOf(node.id);
  return depths;
}
