// 顶部「项目」入口与向下展开概览（R2 任务 2.2，design §1）。
// 注册在 root 作用域的 shell.overlay list slot：按钮在窗口顶部，概览在当前页面展开。
// 全部文案来自 dsh-cona.project 字典；实例原文（标题/路径/错误码）保持原样。

import { useEffect, useRef, useState } from 'react';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { PanelState } from './panel-controller.js';
import type { LocaleKey } from './locales.js';
import { ProjectOverviewController, type OverviewRow, type OverviewState, type ResumeCardView as ResumeCardState } from './project-overview-controller.js';

export interface ProjectTopBarInjected {
  controller: ProjectOverviewController;
  /** 进入所选实例的既有树编辑器；由 client/index.ts 提供（持有 ctx.layout）。 */
  onEnterTree: (instanceId: string) => Promise<void>;
}

export type ProjectTopBarProps = PropsRuntime<'shell.overlay'>
  & InjectFace<ProjectTopBarInjected>
  & PropsLocale<'dsh-cona.project'>;

const labelOf = (key: LocaleKey): LocaleKey => key;

/** 顶部入口组件：按钮 + 折叠概览。 */
export function ProjectTopBar(props: ProjectTopBarProps): JSX.Element {
  const { controller, onEnterTree, t } = props;
  const [state, setState] = useState<OverviewState>(controller.getState());
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => controller.subscribe(setState), [controller]);

  const onButtonClick = (): void => {
    void controller.toggle();
  };
  const onButtonKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === 'Escape') {
      controller.collapse();
      buttonRef.current?.focus();
    }
  };
  const onPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      controller.collapse();
      buttonRef.current?.focus();
    }
  };

  const enterTree = (row: OverviewRow): void => {
    if (!row.readable) return;
    if (!controller.select(row.instanceId)) return;
    void onEnterTree(row.instanceId).then(() => controller.collapse());
  };

  return (
    <div data-cona-top="1" style={{ position: 'fixed', left: 8, top: 6, zIndex: 1000 }}>
      <button
        ref={buttonRef}
        type="button"
        data-cona-top-button="1"
        aria-expanded={state.expanded}
        onClick={onButtonClick}
        onKeyDown={onButtonKeyDown}
        style={{ cursor: 'pointer' }}
      >
        {t(labelOf('panel'))}
      </button>
      {state.expanded ? (
        <div
          data-cona-overview="1"
          role="dialog"
          aria-label={t(labelOf('overviewTitle'))}
          onKeyDown={onPanelKeyDown}
          style={{
            position: 'absolute', left: 0, top: '100%', marginTop: 4,
            minWidth: 260, maxWidth: 360, padding: 12,
            background: 'var(--dsh-surface, #fff)', color: 'var(--dsh-text, #222)',
            border: '1px solid var(--dsh-border, #ccc)', borderRadius: 8,
            boxShadow: '0 6px 24px rgba(0,0,0,.18)',
          }}
        >
          <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>{t(labelOf('overviewTitle'))}</h3>
          {state.phase === 'loading' ? <p style={{ margin: 0 }}>{t(labelOf('loading'))}</p> : null}
          {state.phase === 'error' ? (
            <p style={{ margin: 0, color: '#b3261e' }}>
              {state.code !== null ? `${state.code}: ` : ''}{state.message ?? t(labelOf('loadError'))}
            </p>
          ) : null}
          {state.phase === 'ready' && state.instances.length === 0 ? (
            <p style={{ margin: 0 }}>{t(labelOf('noInstances'))}</p>
          ) : null}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {state.instances.map((row) => (
              <li
                key={row.instanceId}
                data-cona-instance={row.instanceId}
                style={{ padding: '6px 0', borderTop: '1px solid var(--dsh-border, #eee)' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="radio"
                    name="cona-instance"
                    checked={state.selectedId === row.instanceId}
                    disabled={!row.readable}
                    onChange={() => controller.select(row.instanceId)}
                  />
                  <span style={{ flex: 1, opacity: row.readable ? 1 : 0.6 }}>
                    {row.sourceDisplay ?? row.instanceId}
                  </span>
                  <button
                    type="button"
                    data-cona-enter-tree={row.instanceId}
                    disabled={!row.readable}
                    onClick={() => enterTree(row)}
                    title={row.readable ? t(labelOf('enterTree')) : `${row.code ?? 'unreadable'}`}
                  >
                    {t(labelOf('enterTree'))}
                  </button>
                </div>
                {!row.readable ? (
                  <div style={{ fontSize: 12, color: '#b3261e', marginTop: 4 }}>
                    {row.code ?? 'unreadable'}{row.message ? `: ${row.message}` : ''}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          <ResumeCardView state={state.resumeCard} t={t} />
          <ResumeSaveSection controller={controller} state={state} t={t} />
        </div>
      ) : null}
    </div>
  );
}

type TopTranslate = ProjectTopBarProps['t'];

const fieldStyle = { width: '100%', boxSizing: 'border-box' as const, fontSize: 12, padding: '4px 6px' };
const rowStyle = { margin: '6px 0', fontSize: 12 };

/** 接续保存区：入口按钮 + 表单 + 共享内容预览 + 保存回执状态。 */
function ResumeSaveSection(props: { controller: ProjectOverviewController; state: OverviewState; t: TopTranslate }): JSX.Element | null {
  const { controller, state, t } = props;
  const [, force] = useState(0);
  if (state.selectedId === null) return null;
  const draft = state.resumeDraft;
  if (draft === null) {
    return (
      <p style={{ margin: '10px 0 0', display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          data-cona-resume-edit="1"
          onClick={() => { controller.editResume(); force((n) => n + 1); }}
        >
          {t('resumeEdit')}
        </button>
        {state.resumeSave.status === 'saved' ? (
          <span data-cona-resume-saved="1" style={{ fontSize: 12, color: '#1b5e20' }}>{t('resumeSaved')}</span>
        ) : null}
        {state.resumeSave.status === 'pending' ? (
          <span style={{ fontSize: 12, color: '#b3261e' }}>{t('resumeSavePending')}</span>
        ) : null}
      </p>
    );
  }
  const save = state.resumeSave;
  const preview = controller.resumePreview();
  const statusLine = save.status === 'saving'
    ? t('resumeSaving')
    : save.status === 'saved'
      ? t('resumeSaved')
      : save.status === 'conflict'
        ? t('resumeSaveConflict')
        : save.status === 'pending'
          ? t('resumeSavePending')
          : save.status === 'failed'
            ? `${t('resumeSaveFailed')}${save.code === 'missing-required' ? `：${t('resumeMissingRequired')}` : save.code !== null ? `：${save.code}` : ''}`
            : null;
  return (
    <section data-cona-resume-form="1" style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--dsh-border, #eee)' }}>
      <div style={rowStyle}>
        <label>{t('resumeEditStop')}</label>
        <input
          data-cona-resume-stopped="1"
          value={draft.stoppedAt}
          style={fieldStyle}
          onChange={(e) => { controller.patchResumeDraft({ stoppedAt: e.target.value }); force((n) => n + 1); }}
        />
      </div>
      <div style={rowStyle}>
        <label>{t('resumeEditNext')}</label>
        <input
          data-cona-resume-next="1"
          value={draft.nextStep}
          style={fieldStyle}
          onChange={(e) => { controller.patchResumeDraft({ nextStep: e.target.value }); force((n) => n + 1); }}
        />
        <span style={{ marginLeft: 8 }}>
          <label style={{ marginRight: 8 }}>
            <input
              type="radio"
              name="cona-resume-kind"
              checked={draft.nextStepKind === 'suggested'}
              onChange={() => { controller.patchResumeDraft({ nextStepKind: 'suggested' }); force((n) => n + 1); }}
            />
            {t('nextSuggested')}
          </label>
          <label>
            <input
              type="radio"
              name="cona-resume-kind"
              checked={draft.nextStepKind === 'confirmed'}
              onChange={() => { controller.patchResumeDraft({ nextStepKind: 'confirmed' }); force((n) => n + 1); }}
            />
            {t('nextConfirmed')}
          </label>
        </span>
      </div>
      <div style={rowStyle}>
        <label>{t('resumeEditOutcome')}</label>
        <textarea value={draft.outcome} style={fieldStyle} rows={2}
          onChange={(e) => { controller.patchResumeDraft({ outcome: e.target.value }); force((n) => n + 1); }} />
      </div>
      <div style={rowStyle}>
        <label>{t('resumeEditDecisions')}</label>
        <textarea value={draft.decisions} style={fieldStyle} rows={2}
          onChange={(e) => { controller.patchResumeDraft({ decisions: e.target.value }); force((n) => n + 1); }} />
      </div>
      <div style={rowStyle}>
        <label>{t('resumeEditOpenIssues')}</label>
        <textarea value={draft.openIssues} style={fieldStyle} rows={2}
          onChange={(e) => { controller.patchResumeDraft({ openIssues: e.target.value }); force((n) => n + 1); }} />
      </div>
      <div style={{ ...rowStyle, whiteSpace: 'pre-wrap', background: 'var(--dsh-surface, #f7f7f7)', padding: 6 }}>
        <strong>{t('resumePreviewTitle')}</strong>
        {preview.ok ? (
          <pre style={{ margin: '4px 0 0', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{preview.summary}</pre>
        ) : (
          <span style={{ color: '#b3261e' }}> {preview.code}</span>
        )}
      </div>
      {statusLine !== null ? <p style={{ ...rowStyle, color: save.status === 'saved' ? '#1b5e20' : '#b3261e' }}>{statusLine}</p> : null}
      <p style={{ margin: '8px 0 0', display: 'flex', gap: 8 }}>
        <button
          type="button"
          data-cona-resume-save="1"
          disabled={save.status === 'saving'}
          onClick={() => { void controller.saveResume().then(() => force((n) => n + 1)); }}
        >
          {t('resumeSave')}
        </button>
        <button type="button" data-cona-resume-cancel="1" onClick={() => { controller.discardResumeDraft(); force((n) => n + 1); }}>
          {t('resumeCancel')}
        </button>
      </p>
    </section>
  );
}

/** 接续卡片：从已核对的公开正文投影，区分历史验证状态并保留空态/诊断。 */
function ResumeCardView(props: { state: ResumeCardState | null; t: TopTranslate }): JSX.Element | null {
  const { state, t } = props;
  if (state === null) return <p style={{ margin: '8px 0 0', fontSize: 12 }}>{t('resumeLoading')}</p>;
  if (state.status === 'empty') return <p style={{ margin: '8px 0 0', fontSize: 12 }}>{t('noResume')}</p>;
  if (state.status === 'unread') {
    return <p style={{ margin: '8px 0 0', fontSize: 12, color: '#b3261e' }}>{t('resumeUnread')}</p>;
  }
  if (state.status === 'diagnostic') {
    return <p style={{ margin: '8px 0 0', fontSize: 12, color: '#b3261e' }}>
      {t('resumeDiagnostic', { code: state.code, message: state.message })}
    </p>;
  }
  const p = state.payload;
  return (
    <section data-cona-resume-card="1" style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--dsh-border, #eee)' }}>
      <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>{t('resumeTitle')}</h4>
      <p style={{ margin: '2px 0', fontSize: 12 }}>{t('resumeStopped', { text: p.stoppedAt })}</p>
      <p style={{ margin: '2px 0', fontSize: 12 }}>
        {t('resumeNext', { kind: p.nextStepKind === 'confirmed' ? t('nextConfirmed') : t('nextSuggested'), text: p.nextStep })}
      </p>
      {p.outcome ? <p style={{ margin: '2px 0', fontSize: 12 }}>{t('resumeOutcome', { text: p.outcome })}</p> : null}
      {p.decisions ? <p style={{ margin: '2px 0', fontSize: 12 }}>{t('resumeDecisions', { text: p.decisions })}</p> : null}
      {p.openIssues ? <p style={{ margin: '2px 0', fontSize: 12 }}>{t('resumeOpenIssues', { text: p.openIssues })}</p> : null}
      {p.verifications?.map((v, i) => (
        <p key={i} style={{ margin: '2px 0', fontSize: 12 }}>
          {t('resumeVerification', { status: v.status, label: v.label ?? v.subjectId })}
        </p>
      ))}
    </section>
  );
}
