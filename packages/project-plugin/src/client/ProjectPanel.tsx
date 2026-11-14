// 项目面板（tasks 5.2／5.4）：小树、详情、目标编辑、节点新增、变更原因与位置展示。
//
// 渲染层只读控制器状态并调用其方法；保存规则、草稿保留与失败标记都在
// `panel-controller.ts` 里，可脱离浏览器测试。全部文案来自 `dsh-cona.project` 字典，
// 稳定错误码与项目原文不翻译。

import { useEffect, useState } from 'react';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { PanelController, PanelState, SaveStatus } from './panel-controller.js';
import type { PanelSnapshot } from './api.js';
import type { LocaleKey } from './locales.js';

export type ProjectPanelInjected = { controller: PanelController };

export type ProjectPanelProps = PropsRuntime<'main'>
  & InjectFace<ProjectPanelInjected>
  & PropsLocale<'dsh-cona.project'>;

const SAVE_LABEL: Record<SaveStatus, LocaleKey> = {
  idle: 'saveStatusIdle',
  saving: 'saveStatusSaving',
  saved: 'saveStatusSaved',
  conflict: 'saveStatusConflict',
  pending: 'saveStatusPending',
  failed: 'saveStatusFailed',
  partial: 'saveStatusPartial',
};

/** 面板根组件：订阅控制器状态。 */
export function ProjectPanel(props: ProjectPanelProps): JSX.Element {
  const { controller, t } = props;
  const [state, setState] = useState<PanelState>(controller.getState());

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    void controller.open();
    // R1 的失效检测：定时轮询并按修订单调过滤；断线只标离线，不清草稿。
    const timer = setInterval(() => {
      void controller.poll();
    }, 5000);
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [controller]);

  if (state.phase === 'loading' || state.phase === 'idle') {
    return <p style={{ padding: 16, color: 'var(--dsh-text-secondary, #666)' }}>{t('loading')}</p>;
  }
  if (state.phase === 'error' || state.snapshot === null) {
    return (
      <section style={{ padding: 16 }}>
        <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>{t('title')}</h2>
        <p style={{ color: '#b3261e', margin: '0 0 12px' }}>{state.message ?? t('loadError')}</p>
        <button type="button" onClick={() => void controller.open()}>
          {t('retry')}
        </button>
      </section>
    );
  }

  const snapshot = state.snapshot;
  const selected = snapshot.tree.find((node) => node.id === state.selectedNodeId) ?? snapshot.tree[0];
  const depths = depthMap(snapshot);

  return (
    <section style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Header
        state={state}
        snapshot={snapshot}
        t={t}
        onRefresh={() => void controller.open()}
        onReconnect={() => void controller.reconnect()}
      />
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
                background: node.id === state.selectedNodeId ? 'var(--dsh-bg-selected, #eef2f7)' : 'transparent',
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
            <p>{t('noNodes')}</p>
          ) : (
            <NodeDetail controller={controller} state={state} node={selected} t={t} />
          )}
        </main>
      </div>
      <footer style={{ borderTop: '1px solid var(--dsh-border, #e5e5e5)', padding: '8px 16px', fontSize: 12 }}>
        <SaveBar controller={controller} state={state} t={t} />
      </footer>
    </section>
  );
}

type Translate = ProjectPanelProps['t'];

function Header(props: {
  state: PanelState;
  snapshot: PanelSnapshot;
  t: Translate;
  onRefresh: () => void;
  onReconnect: () => void;
}): JSX.Element {
  const { state, snapshot, t, onRefresh, onReconnect } = props;
  const sync = snapshot.sync.status === 'synced' ? t('syncOk') : t('syncDrift');
  const online = state.connection.status === 'connected';
  return (
    <header style={{ borderBottom: '1px solid var(--dsh-border, #e5e5e5)', padding: '10px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 15 }}>{snapshot.project.title}</h2>
        <span style={{ fontSize: 12, color: 'var(--dsh-text-secondary, #777)' }}>{sync}</span>
        <span style={{ fontSize: 12, color: online ? 'var(--dsh-text-secondary, #777)' : '#b3261e' }}>
          {online ? t('connected') : t('offline')}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--dsh-text-secondary, #777)' }}>
          {t('revisions', {
            plan: snapshot.planRevision,
            state: snapshot.stateRevision,
            generation: state.connection.generation,
          })}
        </span>
        <button type="button" onClick={onRefresh}>
          {t('refresh')}
        </button>
        <button type="button" onClick={onReconnect}>
          {t('reconnect')}
        </button>
      </div>
      <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--dsh-text-secondary, #777)' }}>
        {t('location', { path: snapshot.source.displayPath, kind: snapshot.source.kind })}
      </p>
      {state.status?.localRootDisplay === undefined || state.status?.localRootDisplay === null ? null : (
        <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--dsh-text-secondary, #777)' }}>
          {t('localData', { path: state.status.localRootDisplay })}
        </p>
      )}
    </header>
  );
}

function NodeDetail(props: {
  controller: PanelController;
  state: PanelState;
  node: PanelSnapshot['tree'][number];
  t: Translate;
}): JSX.Element {
  const { controller, state, node, t } = props;
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
        {t('nodeMeta', { status: node.status, order: node.order, count: node.completionCriteria.length })}
      </p>
      {node.completionCriteria.length === 0 ? null : (
        <ul style={{ margin: '0 0 12px 16px', padding: 0, fontSize: 12 }}>
          {node.completionCriteria.map((item, index) => (
            <li key={`${node.id}-criterion-${index}`}>{item}</li>
          ))}
        </ul>
      )}

      <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }} htmlFor="cona-goal">
        {t('goal')}
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
          {t('save')}
        </button>
        <button type="button" onClick={() => controller.discardDraft()} disabled={draft === null && state.reason === ''}>
          {t('discard')}
        </button>
        <button type="button" onClick={() => controller.beginAddNode(node.id)}>
          {t('addChild')}
        </button>
      </div>

      {controller.isDraftBaselineStale() ? (
        <p style={{ margin: '8px 0 0', fontSize: 12, color: '#8a6d00' }}>{t('staleDraft')}</p>
      ) : null}

      <label style={{ display: 'block', fontSize: 12, margin: '12px 0 4px' }} htmlFor="cona-reason">
        {t('reason')}
      </label>
      <input
        id="cona-reason"
        value={state.reason}
        onChange={(event) => controller.setReason(event.target.value)}
        style={{ width: '100%', boxSizing: 'border-box', fontSize: 13 }}
      />

      {adding ? (
        <section style={{ marginTop: 16, borderTop: '1px solid var(--dsh-border, #e5e5e5)', paddingTop: 12 }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>{t('addNodeTitle', { parent: node.title })}</h4>
          <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>
            {t('titleField')}
            <input
              value={draft.title ?? ''}
              onChange={(event) => controller.editDraft({ title: event.target.value })}
              style={{ display: 'block', width: '100%', boxSizing: 'border-box', fontSize: 13 }}
            />
          </label>
          <label style={{ display: 'block', fontSize: 12, margin: '8px 0 4px' }}>
            {t('goalField')}
            <input
              value={draft.goal}
              onChange={(event) => controller.editDraft({ goal: event.target.value })}
              style={{ display: 'block', width: '100%', boxSizing: 'border-box', fontSize: 13 }}
            />
          </label>
          <button type="button" style={{ marginTop: 8 }} onClick={() => void controller.save()}>
            {t('saveNewNode')}
          </button>
        </section>
      ) : null}
    </article>
  );
}

function SaveBar(props: { controller: PanelController; state: PanelState; t: Translate }): JSX.Element {
  const { controller, state, t } = props;
  const { status, code, message } = state.save;
  const key: LocaleKey = status === 'idle' && controller.isDirty() ? 'saveStatusDirty' : SAVE_LABEL[status];
  const color = status === 'saved' ? '#1b5e20' : status === 'idle' ? '#666' : '#b3261e';
  return (
    <span style={{ color }}>
      {t(key)}
      {message === null || message === '' ? '' : ` · ${message}`}
      {code === null ? '' : ` · ${t('errorCode', { code })}`}
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
