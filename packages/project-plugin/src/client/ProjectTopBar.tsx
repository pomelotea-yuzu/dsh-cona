// 顶部「项目」入口与向下展开概览（R2 任务 2.2，design §1）。
// 注册在 root 作用域的 shell.overlay list slot：按钮在窗口顶部，概览在当前页面展开。
// 全部文案来自 dsh-cona.project 字典；实例原文（标题/路径/错误码）保持原样。

import { useEffect, useRef, useState } from 'react';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { PanelState } from './panel-controller.js';
import type { LocaleKey } from './locales.js';
import type { ResumeChatPointerView } from '../application/resume-chat.js';
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
          <ResumeCardView state={state.resumeCard} chatNotice={state.chatNotice} controller={controller} t={t} />
          <ResumeSaveSection controller={controller} state={state} t={t} />
          <MigrationSection controller={controller} state={state} t={t} />
          <RegisterSection controller={controller} state={state} t={t} />
        </div>
      ) : null}
    </div>
  );
}

type TopTranslate = ProjectTopBarProps['t'];

const fieldStyle = { width: '100%', boxSizing: 'border-box' as const, fontSize: 12, padding: '4px 6px' };
const rowStyle = { margin: '6px 0', fontSize: 12 };

const MIG_STATUS_KEY: Record<string, LocaleKey> = {
  prepared: 'migStatusPrepared',
  'target-ready': 'migStatusTargetReady',
  switched: 'migStatusSwitched',
  committed: 'migStatusCommitted',
  canceled: 'migStatusCanceled',
};

const KIND_OPTIONS = ['project-directory', 'dsh-data', 'custom'] as const;

/** 1.5 迁移区：预览 → 确认；中断记录提供恢复／取消（确认摘要核对原操作）。 */
function MigrationSection(props: { controller: ProjectOverviewController; state: OverviewState; t: TopTranslate }): JSX.Element | null {
  const { controller, state, t } = props;
  const [, force] = useState(0);
  const [toRoot, setToRoot] = useState('');
  const [toKind, setToKind] = useState<(typeof KIND_OPTIONS)[number]>('custom');
  const migration = state.migration;
  if (state.selectedId === null) return null;
  const refresh = () => { void controller.loadMigrations().then(() => force((n) => n + 1)); };
  const preview = migration.preview;
  const checks = preview !== null && 'checks' in preview ? preview.checks : [];
  const open = preview !== null && 'openMigration' in preview && preview.openMigration !== undefined ? preview.openMigration : null;
  return (
    <section data-cona-migration="1" style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--dsh-border, #eee)' }}>
      <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>{t('migTitle')}</h4>
      {migration.phase === 'error' && migration.code !== null ? (
        <p style={{ ...rowStyle, color: '#b3261e' }}>{migration.code}{migration.message ? `: ${migration.message}` : ''}</p>
      ) : null}
      {migration.record !== null ? (
        <p style={rowStyle}>
          {t(MIG_STATUS_KEY[migration.record.status] ?? 'migStatusPrepared')} · {migration.record.operationId.slice(0, 8)}
        </p>
      ) : null}
      <div style={rowStyle}>
        <input
          data-cona-mig-target="1"
          value={toRoot}
          placeholder={t('migTo', { root: '' }).replace(/[:：]\s*$/, '')}
          style={fieldStyle}
          onChange={(e) => setToRoot(e.target.value)}
        />
        <select value={toKind} style={{ ...fieldStyle, marginTop: 4 }} onChange={(e) => setToKind(e.target.value as (typeof KIND_OPTIONS)[number])}>
          {KIND_OPTIONS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
        </select>
      </div>
      <p style={{ margin: '6px 0', display: 'flex', gap: 8 }}>
        <button
          type="button"
          data-cona-mig-preview="1"
          disabled={toRoot.trim() === '' || migration.phase === 'busy'}
          onClick={() => { void controller.previewMigration(toRoot.trim(), toKind).then(() => force((n) => n + 1)); }}
        >
          {t('migPreview')}
        </button>
        <button
          type="button"
          data-cona-mig-run="1"
          disabled={toRoot.trim() === '' || migration.phase === 'busy' || (preview !== null && 'checks' in preview && preview.checks.length > 0)}
          onClick={() => { void controller.runMigration(toRoot.trim(), toKind).then(() => force((n) => n + 1)); }}
        >
          {t('migRun')}
        </button>
        <button type="button" data-cona-mig-list="1" onClick={refresh}>{t('migList')}</button>
      </p>
      {open !== null ? <p style={{ ...rowStyle, color: '#8a6d3b' }}>{t('migOpenNotice', { operationId: open.operationId })}</p> : null}
      {checks.length > 0 ? (
        <div style={{ ...rowStyle, color: '#b3261e' }}>
          <strong>{t('migChecks')}</strong>
          {checks.map((check, i) => <div key={i}>{check.code}{check.message ? `: ${check.message}` : ''}</div>)}
        </div>
      ) : null}
      {migration.migrations.length > 0 ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: 12 }}>
          {migration.migrations.map((record) => {
            const openStatus = record.status === 'prepared' || record.status === 'target-ready' || record.status === 'switched';
            return (
              <li key={record.operationId} style={{ margin: '4px 0' }}>
                <span>{t(MIG_STATUS_KEY[record.status] ?? 'migStatusPrepared')} · {record.from.root} → {record.to.root}</span>
                {openStatus ? (
                  <span style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                    <button
                      type="button"
                      data-cona-mig-recover={record.operationId}
                      onClick={() => { void controller.recoverMigration(record.operationId, record.requestDigest).then(() => force((n) => n + 1)); }}
                    >
                      {t('migRecover')}
                    </button>
                    {record.status !== 'switched' ? (
                      <button
                        type="button"
                        data-cona-mig-cancel={record.operationId}
                        onClick={() => { void controller.cancelMigration(record.operationId, record.requestDigest).then(() => force((n) => n + 1)); }}
                      >
                        {t('migCancel')}
                      </button>
                    ) : null}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <p style={{ ...rowStyle, color: '#8a6d3b' }}>{t('migOldRootKept')}</p>
    </section>
  );
}

/** 1.1 接入区：预览（位置／Git／项目 ID／版本）→ 显式登记。 */
function RegisterSection(props: { controller: ProjectOverviewController; state: OverviewState; t: TopTranslate }): JSX.Element | null {
  const { controller, state, t } = props;
  const [, force] = useState(0);
  const [sourceRoot, setSourceRoot] = useState('');
  const [kind, setKind] = useState<(typeof KIND_OPTIONS)[number]>('custom');
  const register = state.register;
  if (state.selectedId === null) return null;
  const preview = register.preview;
  const gitLine = preview !== null && preview.status === 'preview' && preview.git !== null
    ? preview.git.available
      ? t('regGitAvailable', { head: (preview.git.headCommit ?? '').slice(0, 7), branch: preview.git.branch ?? '' })
          + (preview.git.dirty === true ? t('regGitDirty') : '')
      : t('regGitUnavailable', { reason: '' })
    : null;
  return (
    <section data-cona-register="1" style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--dsh-border, #eee)' }}>
      <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>{t('regTitle')}</h4>
      {register.phase === 'error' && register.code !== null ? (
        <p style={{ ...rowStyle, color: '#b3261e' }}>{register.code}{register.message ? `: ${register.message}` : ''}</p>
      ) : null}
      <div style={rowStyle}>
        <input
          data-cona-reg-source="1"
          value={sourceRoot}
          style={fieldStyle}
          onChange={(e) => setSourceRoot(e.target.value)}
        />
      </div>
      <p style={{ margin: '6px 0', display: 'flex', gap: 8 }}>
        <button
          type="button"
          data-cona-reg-preview="1"
          disabled={sourceRoot.trim() === '' || register.phase === 'busy'}
          onClick={() => { void controller.previewRegister(sourceRoot.trim()).then(() => force((n) => n + 1)); }}
        >
          {t('regPreview')}
        </button>
      </p>
      {preview !== null && preview.status === 'preview' ? (
        <div style={{ ...rowStyle, whiteSpace: 'pre-wrap' }}>
          <div>{t('regProject', { projectId: preview.projectId })}</div>
          <div>{t('regVersion', { planVersion: preview.planVersion.slice(0, 12) })}</div>
          <div>{t('regRecords', { count: String(preview.recordCount) })}</div>
          {gitLine !== null ? <div>{gitLine}</div> : null}
          <div style={{ marginTop: 4, display: 'flex', gap: 8, alignItems: 'center' }}>
            <select value={kind} onChange={(e) => setKind(e.target.value as (typeof KIND_OPTIONS)[number])}>
              {KIND_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
            <button
              type="button"
              data-cona-reg-confirm="1"
              onClick={() => { void controller.confirmRegister(preview.sourceRoot, kind, preview.projectId).then(() => force((n) => n + 1)); }}
            >
              {t('regConfirm')}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

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
      : save.status === 'partial'
        ? t('resumePartialSaved') + (save.code !== null ? `：${save.code}` : '')
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
      {state.resumeChats.phase === 'ready' && state.resumeChats.chats.length > 0 ? (
        <div style={rowStyle}>
          <label>{t('resumeChatLabel')}</label>
          <select
            data-cona-resume-chat="1"
            value={draft.chatLinkId ?? ''}
            style={fieldStyle}
            onChange={(e) => {
              controller.patchResumeDraft({ chatLinkId: e.target.value === '' ? null : e.target.value });
              force((n) => n + 1);
            }}
          >
            <option value="">{t('resumeChatNone')}</option>
            {state.resumeChats.chats.map((chat) => (
              <option key={chat.linkId} value={chat.linkId} disabled={chat.visible === false}>
                {chat.purpose} · {chat.sessionId.slice(0, 8)}{chat.visible === false ? `（${t('resumeChatUnavailable')}）` : ''}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {state.resumeChats.phase === 'unavailable' ? (
        <p style={{ ...rowStyle, color: '#8a6d3b' }}>{t('resumeChatsUnavailable')}</p>
      ) : null}
      <div style={{ ...rowStyle, whiteSpace: 'pre-wrap', background: 'var(--dsh-surface, #f7f7f7)', padding: 6 }}>
        <strong>{t('resumePreviewTitle')}</strong>
        {preview.ok ? (
          <pre style={{ margin: '4px 0 0', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{preview.summary}</pre>
        ) : (
          <span style={{ color: '#b3261e' }}> {preview.code}</span>
        )}
      </div>
      {statusLine !== null ? <p style={{ ...rowStyle, color: save.status === 'saved' || save.status === 'partial' ? '#8a6d3b' : '#b3261e' }}>{statusLine}</p> : null}
      {save.status === 'partial' && state.resumePartial !== null ? (
        <p style={{ margin: '8px 0 0', display: 'flex', gap: 8 }}>
          <button
            type="button"
            data-cona-resume-retry-link="1"
            onClick={() => { void controller.retryResumeChatLink().then(() => force((n) => n + 1)); }}
          >
            {t('resumeChatRetry')}
          </button>
        </p>
      ) : null}
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
function ResumeCardView(props: {
  state: ResumeCardState | null;
  chatNotice: { code: string; message: string } | null;
  controller: ProjectOverviewController;
  t: TopTranslate;
}): JSX.Element | null {
  const { state, chatNotice, controller, t } = props;
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
  const obs = state.codeObservation;
  const chat = state.chat;
  const worktree = obs.status === 'observed'
    ? (obs.dirtyCount === 0 ? t('worktreeClean') : t('worktreeDirty', { count: String(obs.dirtyCount) }))
    : '';
  const obsLine = obs.status === 'observed'
    ? t('codeObserved', { head: obs.head.slice(0, 7), worktree })
    : obs.status === 'not-configured'
      ? t('codeNotConfigured')
      : t('codeUnavailable', { reason: obs.reason });
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
      <p style={{ margin: '2px 0', fontSize: 12, color: obs.status === 'observed' ? undefined : '#8a6d3b' }}>{obsLine}</p>
      <ResumeChatLine chat={chat} chatNotice={chatNotice} controller={controller} t={t} />
    </section>
  );
}

/** 卡片的聊天行：指针三态呈现；linked 且未确认失效时提供打开（点击前 Host 再复查）。 */
function ResumeChatLine(props: {
  chat: ResumeChatPointerView;
  chatNotice: { code: string; message: string } | null;
  controller: ProjectOverviewController;
  t: TopTranslate;
}): JSX.Element | null {
  const { chat, chatNotice, controller, t } = props;
  const lineStyle = { margin: '2px 0', fontSize: 12 } as const;
  if (chat.status === 'linked') {
    if (chat.visible === false) {
      return <p style={{ ...lineStyle, color: '#8a6d3b' }}>{t('resumeChatUnavailable')}</p>;
    }
    return (
      <p style={lineStyle}>
        <button type="button" data-cona-resume-open-chat="1" onClick={() => { void controller.openResumeChat(); }}>
          {t('resumeChatOpen')}
        </button>
        {chatNotice !== null ? (
          <span style={{ color: '#b3261e' }}> {chatNotice.code}{chatNotice.message ? `: ${chatNotice.message}` : ''}</span>
        ) : null}
      </p>
    );
  }
  if (chat.status === 'unlinked') {
    return <p style={{ ...lineStyle, color: '#8a6d3b' }}>{t('resumeChatUnlinked')}</p>;
  }
  return <p style={{ ...lineStyle, color: '#8a6d3b' }}>{t('resumeChatUnavailable')}：{chat.reason}</p>;
}
