// 顶部「项目」入口与向下展开概览（R2 任务 2.2，design §1）。
// 注册在 root 作用域的 shell.overlay list slot：按钮在窗口顶部，概览在当前页面展开。
// 全部文案来自 dsh-cona.project 字典；实例原文（标题/路径/错误码）保持原样。

import { useEffect, useRef, useState } from 'react';
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { PanelState } from './panel-controller.js';
import type { LocaleKey } from './locales.js';
import type { ResumeChatPointerView } from '../application/resume-chat.js';
import { ProjectOverviewController, WORK_ACTION_OPTIONS, type OverviewRow, type OverviewState, type ResumeCardView as ResumeCardState } from './project-overview-controller.js';

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

  /** 4.4：目标视图定位节点——只切换树面板选择，不写资料、不启动执行。 */
  const locateNode = (nodeId: string): void => {
    const selected = state.selectedId;
    if (selected === null) return;
    const row = state.instances.find((item) => item.instanceId === selected);
    if (row === undefined || !row.readable) return;
    if (!controller.locateMilestoneNode(nodeId)) return;
    void onEnterTree(selected).then(() => controller.collapse());
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
                {row.configured === false ? (
                  <div data-cona-work-unavailable={row.instanceId} style={{ fontSize: 12, color: '#8a6d3b', marginTop: 4 }}>
                    {t(labelOf('workEntryUnavailable'))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          <ResumeCardView state={state.resumeCard} chatNotice={state.chatNotice} controller={controller} t={t} />
          <ChatSection controller={controller} state={state} t={t} />
          <WorkSection controller={controller} state={state} t={t} />
          <RoadmapSection controller={controller} state={state} t={t} onLocate={locateNode} />
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
  const [, force] = useState(0);
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
    return (
      <p style={lineStyle}>
        <span style={{ color: '#8a6d3b' }}>{t('resumeChatUnlinked')}</span>
        <button
          type="button"
          data-cona-resume-rebind="1"
          onClick={() => { controller.beginRebindResume(); force((n) => n + 1); }}
        >
          {t('resumeChatRebind')}
        </button>
      </p>
    );
  }
  return (
    <p style={lineStyle}>
      <span style={{ color: '#8a6d3b' }}>{t('resumeChatUnavailable')}：{chat.reason}</span>
      <button
        type="button"
        data-cona-resume-rebind="1"
        onClick={() => { controller.beginRebindResume(); force((n) => n + 1); }}
      >
        {t('resumeChatRebind')}
      </button>
    </p>
  );
}

/**
 * 3.1 本机聊天区：浏览实例也能创建、选择已有、关联、解绑与打开自己的聊天。
 * 导航只调宿主 openSession；重绑草稿存在时创建／关联改写为卡片指针重绑。
 */
function ChatSection(props: {
  controller: ProjectOverviewController;
  state: OverviewState;
  t: TopTranslate;
}): JSX.Element | null {
  const { controller, state, t } = props;
  const [purpose, setPurpose] = useState('');
  const [sessionId, setSessionId] = useState('');
  const chats = state.chats;
  if (state.selectedId === null) return null;
  if (chats.phase === 'idle') return null;
  if (chats.phase === 'loading') return <p style={rowStyle}>{t('loading')}</p>;
  if (chats.phase === 'unavailable') {
    return (
      <section data-cona-chats="1" style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--dsh-border, #eee)' }}>
        <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>{t('chatsTitle')}</h4>
        <p style={{ ...rowStyle, color: '#8a6d3b' }}>{t('chatsUnavailable', { reason: chats.reason ?? 'unknown' })}</p>
      </section>
    );
  }
  const rebind = state.rebindDraft;
  const busy = chats.busy;
  return (
    <section data-cona-chats="1" style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--dsh-border, #eee)' }}>
      <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>{t('chatsTitle')}</h4>
      {rebind !== null ? (
        <p data-cona-chat-rebind-banner="1" style={{ ...rowStyle, color: '#1b5e20' }}>
          {t('chatRebindActive')}
          <button type="button" onClick={() => { controller.cancelRebindResume(); }}>
            {t('chatRebindCancel')}
          </button>
        </p>
      ) : null}
      {chats.links.length === 0 ? <p style={rowStyle}>{t('chatNoLinks')}</p> : null}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {chats.links.map((link) => (
          <li key={link.linkId} data-cona-chat-link={link.linkId} style={rowStyle}>
            <span>{link.purpose} · {link.sessionId.slice(0, 8)}</span>
            {link.visible === false ? <span style={{ color: '#8a6d3b' }}>（{t('chatVisibleMissing')}）</span> : null}
            <button
              type="button"
              data-cona-chat-open={link.linkId}
              disabled={busy || link.visible === false}
              onClick={() => { void controller.openChatLink(link.linkId); }}
            >
              {t('chatOpen')}
            </button>
            <button
              type="button"
              data-cona-chat-unlink={link.linkId}
              disabled={busy}
              onClick={() => { void controller.unlinkChat(link.linkId); }}
            >
              {t('chatUnlink')}
            </button>
          </li>
        ))}
      </ul>
      {chats.pending.length > 0 ? (
        <div data-cona-chat-pending="1">
          <p style={{ ...rowStyle, marginBottom: 2 }}>{t('chatPendingTitle')}</p>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {chats.pending.map((pending) => (
              <li key={pending.operationId} style={rowStyle}>
                <span>{pending.purpose} · {pending.status}</span>
                {(pending.candidates ?? []).map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    data-cona-chat-claim={candidate}
                    disabled={busy}
                    onClick={() => { void controller.claimPending(pending, candidate); }}
                  >
                    {t('chatClaimCandidate')} {candidate.slice(0, 8)}
                  </button>
                ))}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <label style={{ ...rowStyle, display: 'block' }}>{t('chatPurposeLabel')}</label>
      <input
        data-cona-chat-purpose="1"
        style={fieldStyle}
        value={purpose}
        placeholder={t('chatPurposePlaceholder')}
        onChange={(e) => setPurpose(e.target.value)}
      />
      <button
        type="button"
        data-cona-chat-create="1"
        disabled={busy}
        onClick={() => { void controller.createChat(purpose); }}
      >
        {t('chatCreate')}
      </button>
      <label style={{ ...rowStyle, display: 'block', marginTop: 8 }}>{t('chatSelectLabel')}</label>
      {chats.sessions.length === 0 ? <p style={rowStyle}>{t('chatNoSessions')}</p> : null}
      <select
        data-cona-chat-session="1"
        style={fieldStyle}
        value={sessionId}
        onChange={(e) => setSessionId(e.target.value)}
      >
        <option value="">{t('chatSessionNone')}</option>
        {chats.sessions.map((session) => (
          <option key={session.sessionId} value={session.sessionId}>
            {session.sessionId.slice(0, 8)}{session.blank ? ` · ${t('chatSessionBlank')}` : ''}{session.linked ? ` · ${t('chatSessionLinked')}` : ''}
          </option>
        ))}
      </select>
      <button
        type="button"
        data-cona-chat-link-selected="1"
        disabled={busy || sessionId === ''}
        onClick={() => { void controller.linkSession(sessionId, purpose); }}
      >
        {t('chatLinkSelected')}
      </button>
      {chats.notice !== null ? (
        <p data-cona-chat-notice="1" style={{ ...rowStyle, color: '#b3261e' }}>
          {chats.notice.code}{chats.notice.message ? `: ${chats.notice.message}` : ''}
        </p>
      ) : null}
    </section>
  );
}

const WORK_ACTION_KEY: Record<string, LocaleKey> = {
  update: 'workActionUpdate',
  record: 'workActionRecord',
  status: 'workActionStatus',
  add: 'workActionAdd',
  split: 'workActionSplit',
  dependencies: 'workActionDependencies',
  move: 'workActionMove',
  insert: 'workActionInsert',
};

const ITEM_KIND_KEY: Record<string, LocaleKey> = {
  decision: 'workItemDecision',
  suggestion: 'workItemSuggestion',
  unverified: 'workItemUnverified',
};

/**
 * 3.2 配置实例的项目工作：从当前选择与会话起草范围 → 预览上下文 → 确认等待消息。
 * 浏览实例不渲染（实例行已提示入口不可用）。
 */
function WorkSection(props: {
  controller: ProjectOverviewController;
  state: OverviewState;
  t: TopTranslate;
}): JSX.Element | null {
  const { controller, state, t } = props;
  const row = state.instances.find((item) => item.instanceId === state.selectedId);
  if (state.selectedId === null || row === undefined || row.readable !== true || row.configured !== true) return null;
  const work = state.work;
  const draft = work.draft;

  if (work.started !== null) {
    return (
      <section data-cona-work="1" style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--dsh-border, #eee)' }}>
        <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>{t('workTitle')}</h4>
        <p data-cona-work-awaiting="1" style={rowStyle}>{t('workAwaitingMessage')}</p>
        <button type="button" data-cona-work-open-session="1" onClick={() => { controller.openWorkSession(); }}>
          {t('workOpenSession')}
        </button>
        <button type="button" onClick={() => { controller.cancelWork(); }}>
          {t('workClose')}
        </button>
      </section>
    );
  }

  return (
    <section data-cona-work="1" style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--dsh-border, #eee)' }}>
      <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>{t('workTitle')}</h4>
      {draft === null ? (
        <button type="button" data-cona-work-begin="1" onClick={() => { controller.beginWork(); }}>
          {t('workBegin')}
        </button>
      ) : (
        <>
          <p style={rowStyle}>{t('workTargets', { count: String(draft.nodeIds.length) })}</p>
          <label style={{ ...rowStyle, display: 'block' }}>{t('workSessionLabel')}</label>
          <select
            data-cona-work-session="1"
            style={fieldStyle}
            value={draft.sessionId}
            onChange={(e) => controller.patchWorkDraft({ sessionId: e.target.value })}
          >
            <option value="">{t('workSessionNone')}</option>
            {state.chats.sessions.map((session) => (
              <option key={session.sessionId} value={session.sessionId}>
                {session.sessionId.slice(0, 8)}{session.blank ? ` · ${t('chatSessionBlank')}` : ''}
              </option>
            ))}
          </select>
          <label style={{ ...rowStyle, display: 'block' }}>{t('workPurposeLabel')}</label>
          <input
            data-cona-work-purpose="1"
            style={fieldStyle}
            value={draft.purpose}
            onChange={(e) => controller.patchWorkDraft({ purpose: e.target.value })}
          />
          <div data-cona-work-actions="1" style={rowStyle}>
            {WORK_ACTION_OPTIONS.map((action) => (
              <label key={action} style={{ marginRight: 8 }}>
                <input
                  type="checkbox"
                  data-cona-work-action={action}
                  checked={draft.actions.includes(action)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...draft.actions, action]
                      : draft.actions.filter((item) => item !== action);
                    controller.patchWorkDraft({ actions: next });
                  }}
                />
                {t(WORK_ACTION_KEY[action] ?? 'workActionUpdate')}
              </label>
            ))}
          </div>
          <label style={{ ...rowStyle, display: 'block' }}>{t('workReasonScopeLabel')}</label>
          <select
            data-cona-work-reason-scope="1"
            style={fieldStyle}
            value={draft.reasonScope}
            onChange={(e) => controller.patchWorkDraft({ reasonScope: e.target.value === 'public' ? 'public' : 'local' })}
          >
            <option value="local">{t('workReasonScopeLocal')}</option>
            <option value="public">{t('workReasonScopePublic')}</option>
          </select>
          <div style={{ marginTop: 6 }}>
            <button
              type="button"
              data-cona-work-preview="1"
              disabled={work.phase === 'previewing' || work.phase === 'preparing'}
              onClick={() => { void controller.previewWork(); }}
            >
              {t('workPreview')}
            </button>
            <button
              type="button"
              data-cona-work-confirm="1"
              disabled={work.preview === null || work.phase === 'preparing'}
              onClick={() => { void controller.confirmWork(); }}
            >
              {t('workConfirm')}
            </button>
            <button type="button" onClick={() => { controller.cancelWork(); }}>
              {t('workCancel')}
            </button>
          </div>
        </>
      )}
      {work.preview !== null ? (
        <div data-cona-work-preview-panel="1" style={{ marginTop: 8 }}>
          <p style={rowStyle}>
            {t('workBaseline', {
              version: work.preview.baseline.planVersion.slice(0, 12),
              revision: String(work.preview.baseline.planRevision),
              epoch: String(work.preview.baseline.sourceEpoch),
            })}
          </p>
          {work.preview.targets.map((target) => (
            <div key={target.id} data-cona-work-target={target.id} style={rowStyle}>
              <strong>{target.title ?? target.id}</strong>
              {target.status !== undefined ? ` · ${target.status}` : ''}
              {target.goal !== undefined ? <div>{t('workGoal', { text: target.goal })}</div> : null}
              {target.completionCriteria !== undefined && target.completionCriteria.length > 0 ? (
                <div>{t('workCriteria', { text: target.completionCriteria.join('；') })}</div>
              ) : null}
              {target.dependsOn.length > 0 ? (
                <div>{t('workDependsOn', { text: target.dependsOn.map((dep) => dep.title ?? dep.id).join('、') })}</div>
              ) : null}
              {target.requiredBy.length > 0 ? (
                <div>{t('workRequiredBy', { text: target.requiredBy.map((dep) => dep.title ?? dep.id).join('、') })}</div>
              ) : null}
            </div>
          ))}
          {work.preview.publicRecords.length > 0 ? (
            <div style={rowStyle}>
              {t('workRecords', { count: String(work.preview.publicRecords.length) })}
              {work.preview.publicRecords.map((record) => (
                <div key={record.id} style={{ fontSize: 12 }}>· {record.kind}：{record.summary}</div>
              ))}
            </div>
          ) : null}
          {work.preview.backgroundNodeIds.length > 0 ? (
            <p data-cona-work-background="1" style={{ ...rowStyle, color: '#8a6d3b' }}>
              {t('workBackground', { count: String(work.preview.backgroundNodeIds.length) })}
            </p>
          ) : null}
          {work.preview.items.map((item) => (
            <p
              key={`${item.kind}:${item.source}`}
              data-cona-work-item={item.kind}
              style={{ ...rowStyle, color: item.kind === 'unverified' ? '#8a6d3b' : undefined }}
            >
              [{t(ITEM_KIND_KEY[item.kind] ?? 'workItemDecision')}] {item.text}
            </p>
          ))}
        </div>
      ) : null}
      {work.notice !== null ? (
        <p data-cona-work-notice="1" style={{ ...rowStyle, color: '#b3261e' }}>
          {work.notice.code}{work.notice.message ? `: ${work.notice.message}` : ''}
        </p>
      ) : null}
    </section>
  );
}

const ROADMAP_NOTICE_KEY: Record<string, LocaleKey> = {
  'preview-mismatch': 'roadmapPreviewStale',
  'roadmap-already-enabled': 'roadmapAlreadyEnabled',
  'roadmap-unavailable': 'roadmapUnavailable',
};

/** 4.2 路线图区：v1 空态给启用入口；启用预览展示版本、身份与历史验证影响，确认后显示已启用。 */
function RoadmapSection(props: {
  controller: ProjectOverviewController;
  state: OverviewState;
  t: TopTranslate;
  onLocate: (nodeId: string) => void;
}): JSX.Element | null {
  const { controller, state, t, onLocate } = props;
  const { roadmap } = state;
  if (state.selectedId === null) return null;
  const view = roadmap.view;
  const preview = roadmap.preview;
  const notice = roadmap.notice;
  const noticeText = notice === null
    ? ''
    : ROADMAP_NOTICE_KEY[notice.code] !== undefined
      ? t(ROADMAP_NOTICE_KEY[notice.code] as LocaleKey)
      : `${notice.code}${notice.message ? `: ${notice.message}` : ''}`;
  const currentCount = preview === null ? 0 : preview.impact.verifications.filter((item) => item.currentlyCurrent).length;
  return (
    <section data-cona-roadmap="1" style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--dsh-border, #eee)' }}>
      <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>{t('roadmapTitle')}</h4>
      {roadmap.phase === 'loading' ? <p style={rowStyle}>{t('loading')}</p> : null}
      {roadmap.phase === 'error' && notice !== null ? (
        <p data-cona-roadmap-notice={notice.code} style={{ ...rowStyle, color: '#b3261e' }}>{noticeText}</p>
      ) : null}
      {view !== null && view.enabled ? (
        <>
          <p data-cona-roadmap-enabled="1" style={rowStyle}>{t('roadmapEnabled', { count: String(view.milestones.length) })}</p>
          {view.milestones.length === 0 ? <p style={rowStyle}>{t('roadmapEnabledEmpty')}</p> : null}
          {view.milestones.map((milestone) => {
            const chats = state.chats.links.filter(
              (link) => link.nodeIds.includes(milestone.nodeId) && link.visible !== false,
            );
            const latest = milestone.progress[0];
            const completion = milestone.completions[0];
            const versionLabel = (value: string | null): string => (value ?? '').replace(/^sha256:/, '').slice(0, 12);
            return (
              <div
                key={milestone.nodeId}
                data-cona-roadmap-milestone={milestone.nodeId}
                style={{ marginTop: 8, paddingTop: 6, borderTop: '1px dashed var(--dsh-border, #eee)', fontSize: 12 }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <strong style={{ flex: 1 }}>{milestone.title || milestone.nodeId}</strong>
                  <span style={{ opacity: 0.75 }}>{milestone.status}</span>
                  <button type="button" data-cona-locate={milestone.nodeId} onClick={() => onLocate(milestone.nodeId)}>
                    {t('roadmapLocate')}
                  </button>
                </div>
                {milestone.goal !== '' ? <div>{t('roadmapGoal', { text: milestone.goal })}</div> : null}
                <div>
                  {milestone.completionCriteria.length === 0
                    ? t('roadmapCriteriaNone')
                    : t('roadmapCriteria', { text: milestone.completionCriteria.join('；') })}
                </div>

                <div style={{ marginTop: 4 }}><strong>{t('roadmapDeliveries')}</strong></div>
                {milestone.deliveries.length === 0 ? <div>{t('roadmapDeliveryNone')}</div> : null}
                {milestone.deliveries.map((delivery) => (
                  <div
                    key={`${delivery.kind}:${delivery.refId}`}
                    data-cona-delivery={delivery.refId}
                    style={{ color: delivery.diagnostic === null ? undefined : '#8a6d3b' }}
                  >
                    {delivery.kind === 'node'
                      ? t('roadmapDeliveryNode', {
                          title: delivery.title ?? delivery.refId,
                          status: delivery.status ?? 'unknown',
                        })
                      : t('roadmapDeliveryRecord', {
                          kind: delivery.recordKind ?? 'record',
                          summary: delivery.summary ?? delivery.refId,
                        })}
                    {delivery.diagnostic === null
                      ? null
                      : ` · ${t('roadmapDeliveryUnresolved', { code: delivery.diagnostic })}`}
                    {delivery.kind === 'record' && delivery.subjectNodeId !== null ? (
                      <button
                        type="button"
                        data-cona-check-record={delivery.refId}
                        onClick={() => onLocate(delivery.subjectNodeId as string)}
                      >
                        {t('roadmapCheckRecord')}
                      </button>
                    ) : null}
                  </div>
                ))}

                <div style={{ marginTop: 4 }}><strong>{t('roadmapDeps')}</strong></div>
                {milestone.dependsOn.length === 0 && milestone.requiredBy.length === 0 ? (
                  <div>{t('roadmapDepsNone')}</div>
                ) : null}
                {milestone.dependsOn.map((item) => (
                  <div key={`dep-${item.id}`}>
                    {t('roadmapDependsOn', { text: `${item.title || item.id}（${item.status}）` })}
                  </div>
                ))}
                {milestone.requiredBy.map((item) => (
                  <div key={`req-${item.id}`}>
                    {t('roadmapRequiredBy', { text: `${item.title || item.id}（${item.status}）` })}
                  </div>
                ))}

                <div style={{ marginTop: 4 }}><strong>{t('roadmapProgress')}</strong></div>
                {latest === undefined ? <div>{t('roadmapProgressNone')}</div> : (
                  <div data-cona-progress={latest.recordId}>
                    <div>{t('roadmapStoppedAt', { text: latest.stoppedAt })}</div>
                    {latest.outcome === null ? null : <div>{t('roadmapOutcome', { text: latest.outcome })}</div>}
                    <div>
                      {t('roadmapNextStep', {
                        kind: t(latest.nextStepKind === 'confirmed' ? 'roadmapNextStepConfirmed' : 'roadmapNextStepSuggested'),
                        text: latest.nextStep,
                      })}
                    </div>
                    {latest.openIssues === null ? null : (
                      <div style={{ color: '#8a6d3b' }}>{t('roadmapOpenIssues', { text: latest.openIssues })}</div>
                    )}
                  </div>
                )}

                <div style={{ marginTop: 4 }}><strong>{t('roadmapCompletionState')}</strong></div>
                {completion === undefined ? <div>{t('roadmapCompletionNone')}</div> : (
                  <div style={{ color: completion.current ? undefined : '#8a6d3b' }}>
                    {t('roadmapCompletionEntry', {
                      record: completion.recordId.slice(0, 8),
                      version: versionLabel(completion.subjectVersion),
                    })}
                    {completion.current ? null : ` · ${t('roadmapCompletionStale')}`}
                  </div>
                )}

                <div style={{ marginTop: 4 }}><strong>{t('roadmapOpenChat')}</strong></div>
                {chats.length === 0 ? <div>{t('roadmapChatNone')}</div> : null}
                {chats.map((link) => (
                  <div key={link.linkId} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ flex: 1 }}>{link.purpose}</span>
                    <button
                      type="button"
                      data-cona-milestone-chat={link.linkId}
                      onClick={() => { void controller.openChatLink(link.linkId); }}
                    >
                      {t('roadmapOpenChat')}
                    </button>
                  </div>
                ))}
              </div>
            );
          })}
        </>
      ) : null}
      {view !== null && !view.enabled ? (
        <>
          <p data-cona-roadmap-empty="1" style={rowStyle}>{t('roadmapV1Empty')}</p>
          {preview === null ? (
            <button
              type="button"
              data-cona-roadmap-preview="1"
              disabled={roadmap.busy}
              onClick={() => { void controller.beginRoadmapEnable(); }}
            >
              {t('roadmapEnable')}
            </button>
          ) : (
            <div data-cona-roadmap-impact="1" style={{ marginTop: 6 }}>
              <p style={rowStyle}>{t('roadmapImpactTitle')}</p>
              <p style={rowStyle}>
                {t('roadmapImpactVersion', {
                  from: preview.impact.current.planVersion.slice(0, 12),
                  to: preview.impact.target.planVersion.slice(0, 12),
                })}
              </p>
              <p style={rowStyle}>
                {t('roadmapImpactIdentity', {
                  nodes: String(preview.impact.identities.nodeCount),
                  records: String(preview.impact.identities.recordCount),
                })}
              </p>
              <p style={rowStyle}>
                {t('roadmapImpactVerifications', {
                  count: String(preview.impact.verifications.length),
                  current: String(currentCount),
                })}
              </p>
              {preview.impact.verifications.slice(0, 3).map((item) => (
                <div key={item.recordId} style={{ fontSize: 12, color: item.currentlyCurrent ? '#8a6d3b' : undefined }}>
                  · {item.status} {item.summary}
                </div>
              ))}
              <p style={{ margin: '6px 0', display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  data-cona-roadmap-confirm="1"
                  disabled={roadmap.busy}
                  onClick={() => { void controller.confirmRoadmapEnable(); }}
                >
                  {t('roadmapConfirm')}
                </button>
                <button
                  type="button"
                  data-cona-roadmap-cancel="1"
                  disabled={roadmap.busy}
                  onClick={() => controller.cancelRoadmapEnable()}
                >
                  {t('roadmapCancel')}
                </button>
              </p>
            </div>
          )}
        </>
      ) : null}
      {roadmap.phase !== 'error' && notice !== null ? (
        <p data-cona-roadmap-notice={notice.code} style={{ ...rowStyle, color: '#b3261e' }}>{noticeText}</p>
      ) : null}
    </section>
  );
}
