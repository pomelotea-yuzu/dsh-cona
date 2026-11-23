// 项目面板（tasks 5.2／5.4）：小树、详情、目标编辑、节点新增、变更原因与位置展示。
//
// 渲染层只读控制器状态并调用其方法；保存规则、草稿保留与失败标记都在
// `panel-controller.ts` 里，可脱离浏览器测试。全部文案来自 `dsh-cona.project` 字典，
// 稳定错误码与项目原文不翻译。

import { useEffect, useState } from 'react';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { IPanelController, PanelState, SaveStatus } from './panel-controller.js';
import type { PanelSnapshot, PresetView } from './api.js';
import type { LocaleKey } from './locales.js';

export type ProjectPanelInjected = { controller: IPanelController };

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
  'committed-pending-sync': 'saveStatusCommittedPendingSync',
};

/** 结构预览标题：每种草稿对应一条字典文案，稳定码/原文不进字典。 */
const PREVIEW_TITLE: Record<
  'move' | 'insert' | 'group' | 'merge' | 'copy' | 'undo' | 'redo' | 'save-template' | 'insert-user-template',
  LocaleKey
> = {
  move: 'treeMoveNode',
  insert: 'treeInsertPreset',
  group: 'treeGroupTitle',
  merge: 'treeMergeTitle',
  copy: 'treeCopyTitle',
  undo: 'treeUndoTitle',
  redo: 'treeRedoTitle',
  'save-template': 'treeSaveTemplateTitle',
  'insert-user-template': 'treeInsertUserTemplateTitle',
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
        <TreeNav controller={controller} state={state} depths={depths} t={t} />
        <main style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {state.structurePreview !== null ? (
            <StructurePreviewView controller={controller} state={state} t={t} />
          ) : null}
          <PresetPanel controller={controller} state={state} t={t} />
          <TreeActions controller={controller} state={state} t={t} />
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

/**
 * 树导航（3.1）：拖放和键盘菜单都以 beginMove 进入同一份草稿，产生等价预览。
 * 拖放源节点记为 dataTransfer 文本；落点是目标节点，移动为「拖源 → 落点父组、落点之前」。
 */
function TreeNav(props: {
  controller: IPanelController;
  state: PanelState;
  depths: Map<string, number>;
  t: Translate;
}): JSX.Element {
  const { controller, state, depths, t } = props;
  const snapshot = state.snapshot as PanelSnapshot;
  const [dragId, setDragId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  return (
    <nav aria-label={t('treeMoveNode')} style={{ width: 260, borderRight: '1px solid var(--dsh-border, #e5e5e5)', overflowY: 'auto', padding: '8px 0' }}>
      {snapshot.tree.map((node) => (
        <div key={node.id}>
          <button
            type="button"
            data-cona-node={node.id}
            draggable
            aria-label={`${node.title} · ${t('treeDragHandle')}`}
            onClick={(event) => {
              // Ctrl/Cmd 或 Shift 点击加入/移出多选；普通点击单选（保留焦点语义）。
              if (event.ctrlKey || event.metaKey || event.shiftKey) controller.toggleSelect(node.id);
              else controller.select(node.id);
            }}
            onDragStart={(event) => {
              setDragId(node.id);
              event.dataTransfer.setData('text/plain', node.id);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const source = dragId ?? event.dataTransfer.getData('text/plain');
              if (source !== '' && source !== node.id) {
                controller.beginMove(source, node.parentId, node.id);
              }
              setDragId(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setMenuFor((current) => (current === node.id ? null : node.id));
              }
            }}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '6px 12px', paddingLeft: 12 + (depths.get(node.id) ?? 0) * 14,
              background: state.selectedNodeIds.includes(node.id) || node.id === state.selectedNodeId
                ? 'var(--dsh-bg-selected, #eef2f7)' : 'transparent',
              border: 'none', cursor: 'grab', fontSize: 13, color: 'inherit',
            }}
          >
            <span style={{ color: 'var(--dsh-text-secondary, #777)', marginRight: 6 }}>{node.order}</span>
            {node.title}
            <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--dsh-text-secondary, #777)' }}>{node.status}</span>
          </button>
          {menuFor === node.id ? (
            <label style={{ display: 'block', padding: '4px 12px 8px', fontSize: 11 }}>
              {t('treeMoveMenu')}
              <select
                aria-label={t('treeMoveMenu')}
                defaultValue=""
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === '') return;
                  const [parentId, beforeId] = value.split('|');
                  controller.beginMove(
                    node.id,
                    parentId === 'null' || parentId === undefined ? null : parentId,
                    beforeId === 'null' || beforeId === undefined ? null : beforeId,
                  );
                  setMenuFor(null);
                }}
                style={{ display: 'block', width: '100%', marginTop: 4, fontSize: 11 }}
              >
                <option value="">—</option>
                {snapshot.tree
                  .filter((item) => item.id !== node.id && !isDescendantOf(snapshot.tree, item.id, node.id))
                  .map((item) => (
                    <option key={`${String(item.parentId)}|${item.id}`} value={`${item.parentId ?? 'null'}|${item.id}`}>
                      {t('treeBefore', { node: item.title })}
                    </option>
                  ))}
                {snapshot.tree
                  .filter((item) => item.id !== node.id && !isDescendantOf(snapshot.tree, item.id, node.id) && item.parentId !== null)
                  .map((item) => (
                    <option key={`append-${item.id}`} value={`${item.id}|null`}>
                      {t('treeMoveTo', { parent: item.title })}
                    </option>
                  ))}
              </select>
            </label>
          ) : null}
        </div>
      ))}
    </nav>
  );
}

/** 结构预览（3.1/3.2）：同一形状覆盖拖放/键盘移动与预设插入；含活动工作条件句提示。 */
function StructurePreviewView(props: {
  controller: IPanelController;
  state: PanelState;
  t: Translate;
}): JSX.Element {
  const { controller, state, t } = props;
  const preview = state.structurePreview;
  if (preview === null) return <div />;
  const noChange = preview.noChange;
  return (
    <section aria-label={t('ariaTreePreview')} style={{ border: '1px solid var(--dsh-border, #e5e5e5)', padding: 12, marginBottom: 16 }}>
      <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>{t(PREVIEW_TITLE[preview.kind])}</h4>
      <ul style={{ margin: '0 0 8px 12px', padding: 0, fontSize: 12 }}>
        {preview.lines.map((line, index) => (
          <li key={index} style={{ marginLeft: line.depth * 14 }}>{line.title}</li>
        ))}
      </ul>
      {preview.preset === undefined ? null : (
        <div style={{ fontSize: 12, color: 'var(--dsh-text-secondary, #777)' }}>
          <p style={{ margin: '2px 0' }}>{t('treePresetSource', { source: preview.preset.source, version: preview.preset.version })}</p>
          <p style={{ margin: '2px 0' }}>{preview.preset.name} · {preview.preset.description}</p>
          <p style={{ margin: '2px 0' }}>{t('treePresetLocales', { locales: preview.preset.locales.join(', '), locale: preview.preset.contentLocale })}</p>
          <p style={{ margin: '2px 0' }}>{t('treePresetDeps', { deps: preview.preset.dependencies.map((d) => `${d.from} ← ${d.to}`).join(', ') })}</p>
        </div>
      )}
      {preview.sources === undefined ? null : (
        <p style={{ fontSize: 12 }}>
          {t('treeAffectedSources', { nodes: preview.sources.join('、') })}
        </p>
      )}
      {preview.externalDependencies === undefined ? null : (
        <p style={{ fontSize: 12 }}>
          {t('treeCopyExternalDeps', { deps: preview.externalDependencies.map((d) => `${d.from} ← ${d.to}`).join('、') })}
        </p>
      )}
      {preview.templateSource === undefined ? null : (
        <p style={{ fontSize: 12, color: 'var(--dsh-text-secondary, #777)' }}>
          {t('treeTemplateSource', {
            id: preview.templateSource.templateId,
            version: preview.templateSource.versionRecordId,
            language: preview.templateSource.bodyLanguage ?? 'und',
          })}
        </p>
      )}
      {noChange ? <p style={{ fontSize: 12, color: '#8a6d00' }}>{t('treeNoChange')}</p> : null}
      {preview.workNotice ? <p style={{ fontSize: 12, color: '#8a6d00' }}>{t('treeWorkNotice')}</p> : null}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" onClick={() => void controller.save()} disabled={noChange}>{t('treeConfirm')}</button>
        <button type="button" onClick={() => {
          const focusId = state.draft?.nodeId;
          controller.discardDraft();
          if (focusId !== undefined) {
            requestAnimationFrame(() => {
              document.querySelector<HTMLButtonElement>(`button[data-cona-node="${CSS.escape(focusId)}"]`)?.focus();
            });
          }
        }}>{t('treeCancelPreview')}</button>
        {state.save.status === 'committed-pending-sync' ? (
          <button type="button" onClick={() => void controller.retryRead()}>{t('refresh')}</button>
        ) : null}
      </div>
    </section>
  );
}

/** 随包预设列表（3.2）：显示来源、版本与可用正文语言；选用进入插入草稿（语言现冻结）。 */
function PresetPanel(props: {
  controller: IPanelController;
  state: PanelState;
  t: Translate;
}): JSX.Element {
  const { controller, state, t } = props;
  useEffect(() => {
    if (state.presetsStatus === 'idle') void controller.loadPresets();
  }, [controller, state.presetsStatus]);
  const parentId = state.selectedNodeId ?? state.snapshot?.tree[0]?.id;
  return (
    <section aria-label={t('ariaPresetList')} style={{ border: '1px solid var(--dsh-border, #e5e5e5)', padding: 12, marginBottom: 16 }}>
      <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>{t('treePresetsTitle')}</h4>
      {state.presetsStatus === 'rejected' ? (
        <p style={{ fontSize: 12, color: '#b3261e' }}>
          {t('treePresetsError', { code: state.presetsError?.code ?? 'unknown' })}
        </p>
      ) : state.presets.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--dsh-text-secondary, #777)' }}>{t('treePresetsEmpty')}</p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: 12 }}>
          {state.presets.map((preset) => (
            <PresetRow key={`${preset.id}@${preset.version}`} preset={preset} parentId={parentId ?? null} controller={controller} t={t} />
          ))}
        </ul>
      )}
    </section>
  );
}

function PresetRow(props: {
  preset: PresetView;
  parentId: string | null;
  controller: IPanelController;
  t: Translate;
}): JSX.Element {
  const { preset, parentId, controller, t } = props;
  const [locale, setLocale] = useState<string>(preset.contentLocales[0] ?? 'en');
  if (parentId === null) return <div />;
  return (
    <li style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
      <span>{preset.content[locale as 'zh-CN' | 'en']?.title ?? preset.id}</span>
      <span style={{ color: 'var(--dsh-text-secondary, #777)' }}>
        {t('treePresetSource', { source: preset.source, version: preset.version })}
      </span>
      <select value={locale} onChange={(event) => setLocale(event.target.value)} aria-label={t('treePresetLocales', { locales: '', locale: '' })}>
        {preset.contentLocales.map((l) => <option key={l} value={l}>{l}</option>)}
      </select>
      <button type="button" onClick={() => controller.beginInsertPreset(preset, locale, parentId, null)}>
        {t('treePresetUse')}
      </button>
    </li>
  );
}

/** 2.1–2.5 统一树编辑工具条：多选分组/合并、复制、撤销重做、用户模板目录与保存。 */
function TreeActions(props: {
  controller: IPanelController;
  state: PanelState;
  t: Translate;
}): JSX.Element {
  const { controller, state, t } = props;
  const [groupTitle, setGroupTitle] = useState('');
  const [templateTitle, setTemplateTitle] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const selectedIds = state.selectedNodeIds;
  const parentId = state.selectedNodeId ?? state.snapshot?.tree[0]?.id ?? null;

  useEffect(() => {
    if (state.undoHistory.status === 'idle') void controller.loadUndoHistory();
    if (state.userTemplates.status === 'idle') void controller.loadUserTemplates();
  }, [controller, state.undoHistory.status, state.userTemplates.status]);

  const beginGroup = (): void => {
    setActionError(null);
    if (selectedIds.length < 2) { setActionError(t('treeNeedMultiSelect')); return; }
    controller.beginGroup({ title: groupTitle || t('treeDefaultGroupTitle'), goal: '', completionCriteria: [] }, null);
  };
  const beginMerge = (): void => {
    setActionError(null);
    if (selectedIds.length < 2) { setActionError(t('treeNeedMultiSelect')); return; }
    controller.beginMerge(selectedIds[0]!, { goal: '', completionCriteria: [] }, []);
  };
  const beginCopy = (): void => {
    setActionError(null);
    if (parentId === null) { setActionError(t('treeNeedParent')); return; }
    controller.beginCopy(parentId, null, []);
  };
  const doUndo = async (operationId: string, direction: 'undo' | 'redo'): Promise<void> => {
    setActionError(null);
    const preview = await controller.previewUndoAction(operationId, direction);
    if (!preview.ok) { setActionError(`${preview.code}: ${preview.message}`); return; }
    controller.beginUndo(operationId, preview.previewDigest, direction);
  };
  const beginSaveTemplate = (): void => {
    setActionError(null);
    if (parentId === null) { setActionError(t('treeNeedParent')); return; }
    controller.beginSaveUserTemplate(crypto.randomUUID(), templateTitle || t('treeDefaultTemplateTitle'), 'und', parentId);
  };

  return (
    <section aria-label={t('treeActionsTitle')} style={{ border: '1px solid var(--dsh-border, #e5e5e5)', padding: 12, marginBottom: 16 }}>
      <h4 style={{ margin: '0 0 8px', fontSize: 13 }}>{t('treeActionsTitle')}</h4>
      <p style={{ fontSize: 12, color: 'var(--dsh-text-secondary, #777)' }}>
        {t('treeSelectedCount', { count: selectedIds.length })}
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={groupTitle} onChange={(e) => setGroupTitle(e.target.value)} placeholder={t('treeDefaultGroupTitle')} aria-label={t('treeDefaultGroupTitle')} />
        <button type="button" onClick={beginGroup}>{t('treeGroupTitle')}</button>
        <button type="button" onClick={beginMerge}>{t('treeMergeTitle')}</button>
        <button type="button" onClick={beginCopy}>{t('treeCopyTitle')}</button>
        <input value={templateTitle} onChange={(e) => setTemplateTitle(e.target.value)} placeholder={t('treeDefaultTemplateTitle')} aria-label={t('treeDefaultTemplateTitle')} />
        <button type="button" onClick={beginSaveTemplate}>{t('treeSaveTemplateTitle')}</button>
      </div>
      {actionError === null ? null : <p style={{ fontSize: 12, color: '#b3261e' }}>{actionError}</p>}
      <h5 style={{ margin: '12px 0 4px', fontSize: 12 }}>{t('treeUndoHistoryTitle')}</h5>
      {state.undoHistory.status === 'rejected' ? (
        <p style={{ fontSize: 12, color: '#b3261e' }}>
          {t('treeUndoHistoryError', { code: state.undoHistory.code ?? 'unknown' })}
        </p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: 12 }}>
          {state.undoHistory.entries.map((entry) => (
            <li key={entry.operationId} style={{ padding: '2px 0' }}>
              <span>{entry.commandType}</span>
              <button type="button" disabled={!entry.canUndo} onClick={() => void doUndo(entry.operationId, 'undo')}>
                {t('treeUndoTitle')}
              </button>
              <button type="button" disabled={!entry.canRedo} onClick={() => void doUndo(entry.operationId, 'redo')}>
                {t('treeRedoTitle')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <h5 style={{ margin: '12px 0 4px', fontSize: 12 }}>{t('treeUserTemplatesTitle')}</h5>
      {state.userTemplates.status === 'rejected' ? (
        <p style={{ fontSize: 12, color: '#b3261e' }}>
          {t('treeUserTemplatesError', { code: state.userTemplates.code ?? 'unknown' })}
        </p>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', fontSize: 12 }}>
          {state.userTemplates.templates.map((template) => (
            <li key={`${template.templateId}@${template.versionRecordId}`} style={{ padding: '2px 0' }}>
              <span>{template.title}</span>
              <button type="button" disabled={parentId === null} onClick={() => {
                if (parentId !== null) controller.beginInsertUserTemplate(template, parentId, null);
              }}>
                {t('treePresetUse')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 判断 cand 是否是 anc 的后代（沿 parentId 链向上）。 */
function isDescendantOf(nodes: PanelSnapshot['tree'], cand: string, anc: string): boolean {
  let cursor = nodes.find((n) => n.id === cand)?.parentId ?? null;
  const seen = new Set<string>();
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === anc) return true;
    seen.add(cursor);
    cursor = nodes.find((n) => n.id === cursor)?.parentId ?? null;
  }
  return false;
}

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
      {snapshot.local.lastOperationAt === null ? null : (
        <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--dsh-text-secondary, #777)' }}>
          {t('lastOperation', { time: formatInstant(snapshot.local.lastOperationAt) })}
        </p>
      )}
    </header>
  );
}

function NodeDetail(props: {
  controller: IPanelController;
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

function SaveBar(props: { controller: IPanelController; state: PanelState; t: Translate }): JSX.Element {
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

/**
 * 记录时间显示（design §9、tasks 5.5）：数据只存 UTC instant，这里按明确显示时区
 * （本机系统时区，取不到时回退 UTC）用 Intl 格式化，输出自带时区标记。
 * 格式随界面语言变化，但时刻与时区不随语言切换改变。
 */
function formatInstant(instant: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const locale = document.documentElement.lang || navigator.language || 'en';
  try {
    // 注意：dateStyle／timeStyle 不能与 timeZoneName 同用（会抛 RangeError），
    // 因此用显式日期时间分量选项。
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      timeZone,
      timeZoneName: 'short',
    }).format(date);
  } catch {
    return instant;
  }
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
