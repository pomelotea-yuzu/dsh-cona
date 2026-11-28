// 7.1-7.3 概览分析区（controller A 层）：
// 仓库/范围预览、单次确认与同一操作号重试、发送未知不自动重发、
// 历史报告回看、当前文件显式查看、复盘预览与确认、切实例迟到响应、不可用诊断。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectOverviewController, type OverviewListResult } from '../src/client/project-overview-controller.js';
import type { PanelTransport } from '../src/client/api.js';
import type {
  AnalysisOverviewOutcome,
  AnalysisPreviewOutcome,
  AnalysisPreviewView,
  AnalysisReportOutcome,
  AnalysisStartOutcome,
  AnalysisSendOutcome,
  AnalysisReviewPreviewOutcome,
  AnalysisReviewStartOutcome,
} from '../src/host/overview-service.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function previewView(overrides: Partial<AnalysisPreviewView> = {}): AnalysisPreviewView {
  return {
    repositoryId: 'repo-1',
    scope: { kind: 'directory', path: 'src' },
    repository: { repositoryId: 'repo-1', absolutePath: '/repo/one', head: 'abc123' },
    observedFiles: 3,
    excluded: 1,
    unreadable: 0,
    truncated: false,
    complete: true,
    fingerprint: 'fp-1',
    planVersion: 'pv-1',
    ...overrides,
  };
}

function overview(): AnalysisOverviewOutcome {
  return {
    status: 'ok',
    repositories: [
      { repositoryId: 'repo-1', absolutePath: '/repo/one', status: 'available', head: 'abc123' },
      { repositoryId: 'repo-2', absolutePath: '/repo/missing', status: 'unavailable', reason: 'analysis-repository-missing', message: 'missing' },
    ],
    runs: [{
      analysisId: 'analysis-old',
      status: 'completed',
      createdAt: '2026-11-27T00:00:00.000Z',
      updatedAt: '2026-11-27T01:00:00.000Z',
      repositoryId: 'repo-1',
      scope: { kind: 'directory', path: 'src' },
      planVersion: 'pv-1',
      sessionId: 'session-old',
      reportId: 'report-old',
      reportSummary: '旧报告',
      coverage: null,
      basisState: 'current',
      endedAt: '2026-11-27T01:00:00.000Z',
      endReason: 'completed',
    }],
  };
}

function report(): AnalysisReportOutcome {
  return {
    status: 'ok',
    report: {
      reportId: 'report-old', analysisId: 'analysis-old', instanceId: A, repositoryId: 'repo-1',
      scope: { kind: 'directory', path: 'src' }, planVersion: 'pv-1', sourceGeneration: 1,
      requestId: 'save-1', payloadHash: 'h', createdAt: '2026-11-27T01:00:00.000Z',
      summary: '旧报告',
      facts: [{
        text: 'src/a.ts 内容',
        citations: [
          { kind: 'file', path: 'src/a.ts', fullHash: 'f', deliveredHash: 'd', startLine: 1, endLine: 2, deliveredBytes: 4, totalLines: 2, truncated: false },
          { kind: 'plan', planVersion: 'pv-1' },
        ],
      }],
      inferences: ['可能还有未读文件'], suggestions: [],
      coverage: {
        observedFiles: 3, readFiles: 1, completeFiles: 1, fragments: 0, onlyEnumerated: 2,
        unreadable: 0, excluded: 1, verificationRead: 0, truncated: false,
        observationComplete: true, basis: 'current', fingerprint: 'fp-1',
      },
    },
    basis: { state: 'changed', changes: [{ kind: 'files-modified', paths: ['src/a.ts'] }], checkedAt: '2026-11-28T00:00:00.000Z' },
    sources: [
      { citation: { kind: 'file', path: 'src/a.ts', fullHash: 'f', deliveredHash: 'd', startLine: 1, endLine: 2, deliveredBytes: 4, totalLines: 2, truncated: false }, state: 'content-changed' },
      { citation: { kind: 'plan', planVersion: 'pv-1' }, state: 'current' },
    ],
  };
}

interface Calls {
  previews: { instanceId: string; repositoryId: string; scope: unknown }[];
  starts: { instanceId: string; request: Record<string, unknown> }[];
  sends: { instanceId: string; analysisId: string; retry: boolean }[];
  stops: string[];
  reports: string[];
  reviews: string[];
  reviewStarts: { instanceId: string; request: Record<string, unknown> }[];
  sources: { instanceId: string; reportId: string; citationIndex: number }[];
  opened: string[];
}

function harness(options: {
  start?: () => AnalysisStartOutcome;
  send?: () => AnalysisSendOutcome;
  reviewStart?: () => AnalysisReviewStartOutcome;
  loadAnalysis?: (instanceId: string) => Promise<AnalysisOverviewOutcome>;
  withAnalysis?: boolean;
} = {}): { controller: ProjectOverviewController; calls: Calls } {
  const calls: Calls = { previews: [], starts: [], sends: [], stops: [], reports: [], reviews: [], reviewStarts: [], sources: [], opened: [] };
  let runs = overview().status === 'ok' ? overview() : null;
  const transport: PanelTransport = {
    status: async () => ({
      configured: true, instanceId: A, projectId: 'p', sourceKind: 'custom',
      sourceDisplay: '/x', localRootDisplay: '/l', created: false, error: null,
    }),
    snapshot: async () => ({ status: 'rejected', code: 'not-used', message: 'not-used' } as never),
    execute: async () => ({ status: 'rejected', code: 'not-used', message: 'not-used' } as never),
  };
  const list: OverviewListResult = {
    status: 'listed',
    instances: [
      { instanceId: A, projectId: 'pa', readable: true, sourceDisplay: '~/a', configured: true },
      { instanceId: B, projectId: 'pb', readable: true, sourceDisplay: '~/b', configured: false },
    ],
  };
  const withAnalysis = options.withAnalysis !== false;
  const controller = new ProjectOverviewController({
    listInstances: async () => list,
    readResumeCard: async () => ({ status: 'empty' }),
    listResumeChats: async () => ({ status: 'unavailable', reason: 'stub' }),
    linkResume: async () => ({ status: 'rejected', code: 'stub', message: 'stub' }),
    resolveChatTarget: async () => ({ status: 'rejected', code: 'stub', message: 'stub' }),
    openSession: (sessionId) => { calls.opened.push(sessionId); },
    transportFor: () => transport,
    newOperationId: (() => { let n = 0; return () => `op-${++n}`; })(),
    ...(withAnalysis ? {
      loadAnalysis: options.loadAnalysis ?? (async () => runs ?? overview()),
      previewAnalysis: async (instanceId: string, request: { repositoryId: string; scope: unknown }): Promise<AnalysisPreviewOutcome> => {
        calls.previews.push({ instanceId, repositoryId: request.repositoryId, scope: request.scope });
        return { status: 'ok', value: previewView() };
      },
      startAnalysis: async (instanceId: string, request: Record<string, unknown>): Promise<AnalysisStartOutcome> => {
        calls.starts.push({ instanceId, request });
        const result = options.start?.() ?? { status: 'committed', analysisId: 'analysis-new', reused: false, recordStatus: 'created' };
        if (result.status === 'committed' && runs !== null && runs.status === 'ok') {
          runs = {
            ...runs,
            runs: [{
              analysisId: result.analysisId, status: 'running', createdAt: '2026-11-28T00:00:00.000Z',
              updatedAt: '2026-11-28T00:00:00.000Z', repositoryId: 'repo-1', scope: { kind: 'directory', path: 'src' },
              planVersion: 'pv-1', sessionId: 'session-new', reportId: null, reportSummary: null, coverage: null, basisState: null,
            }, ...runs.runs],
          };
        }
        return result;
      },
      sendAnalysis: async (instanceId: string, request: { analysisId: string; retry?: boolean }): Promise<AnalysisSendOutcome> => {
        calls.sends.push({ instanceId, analysisId: request.analysisId, retry: request.retry === true });
        return options.send?.() ?? { status: 'committed', sent: true, recovered: false, reused: false };
      },
      stopAnalysis: async (_instanceId: string, request: { analysisId: string }) => {
        calls.stops.push(request.analysisId);
        return { status: 'committed' as const, requested: true, terminal: false };
      },
      readAnalysisReport: async (_instanceId: string, reportId: string): Promise<AnalysisReportOutcome> => {
        calls.reports.push(reportId);
        return report();
      },
      analysisSessionTarget: async () => ({ status: 'ok', sessionId: 'session-old', historical: true }),
      readAnalysisSource: async (instanceId: string, request: { reportId: string; citationIndex: number }) => {
        calls.sources.push({ instanceId, reportId: request.reportId, citationIndex: request.citationIndex });
        return { status: 'ok' as const, path: 'src/a.ts', text: 'current\ntext', startLine: 1, endLine: 2, truncated: false };
      },
      reviewAnalysis: async (_instanceId: string, reportId: string): Promise<AnalysisReviewPreviewOutcome> => {
        calls.reviews.push(reportId);
        return {
          status: 'ok', reportId, previousAnalysisId: 'analysis-old', repositoryId: 'repo-1',
          scope: { kind: 'directory', path: 'src' }, preview: previewView({ fingerprint: 'fp-2', planVersion: 'pv-2' }),
        };
      },
      startAnalysisReview: async (instanceId: string, request: Record<string, unknown>): Promise<AnalysisReviewStartOutcome> => {
        calls.reviewStarts.push({ instanceId, request });
        return options.reviewStart?.() ?? {
          status: 'committed', analysisId: 'analysis-review', reused: false,
          sourceReportId: 'report-old', previousAnalysisId: 'analysis-old', recordStatus: 'created',
        };
      },
    } : {}),
  });
  return { controller, calls };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('7.1 选中实例即读取仓库与历史分析；草稿默认第一个可用仓库', async () => {
  const { controller } = harness();
  await controller.load();
  await settle();
  controller.select(A);
  await settle();
  const analysis = controller.getState().analysis;
  assert.equal(analysis.phase, 'ready');
  assert.equal(analysis.repositories.length, 2);
  assert.equal(analysis.draft.repositoryId, 'repo-1');
  assert.equal(analysis.runs.length, 1);
  assert.equal(analysis.runs[0]?.reportId, 'report-old');
  assert.equal(analysis.phase === 'ready' ? analysis.runs[0]?.basisState : null, 'current');
});

test('7.1 预览 → 确认：一次创建请求 + 首条消息，预览随后清空', async () => {
  const { controller, calls } = harness();
  await controller.load();
  await settle();
  controller.patchAnalysisDraft({ kind: 'directory', path: 'src' });
  await controller.previewAnalysis();
  assert.deepEqual(calls.previews[0], { instanceId: A, repositoryId: 'repo-1', scope: { kind: 'directory', path: 'src' } });
  assert.equal(controller.getState().analysis.preview?.fingerprint, 'fp-1');

  // 同一轮渲染内的重复确认（键盘 Enter 连击）只发一次启动请求。
  await Promise.all([controller.startAnalysis(), controller.startAnalysis()]);
  assert.equal(calls.starts.length, 1);
  assert.deepEqual(calls.starts[0]?.request, {
    operationId: 'op-1',
    repositoryId: 'repo-1',
    scope: { kind: 'directory', path: 'src' },
    expectedFingerprint: 'fp-1',
    expectedPlanVersion: 'pv-1',
  });
  assert.deepEqual(calls.sends, [{ instanceId: A, analysisId: 'analysis-new', retry: false }]);
  assert.equal(controller.getState().analysis.preview, null);
  assert.equal(controller.getState().analysis.startOperationId, null);
});

test('7.1 取消预览不创建分析；启动结果未知时保留同一操作号重试', async () => {
  let attempt = 0;
  const { controller, calls } = harness({
    start: () => {
      attempt += 1;
      return attempt === 1
        ? { status: 'rejected', code: 'analysis-session-create-unknown', message: 'unknown' }
        : { status: 'committed', analysisId: 'analysis-new', reused: false, recordStatus: 'created' };
    },
  });
  await controller.load();
  await settle();
  controller.patchAnalysisDraft({ kind: 'directory', path: 'src' });
  await controller.previewAnalysis();
  controller.cancelAnalysisPreview();
  assert.equal(controller.getState().analysis.preview, null);
  assert.equal(calls.starts.length, 0);

  await controller.previewAnalysis();
  await controller.startAnalysis();
  assert.equal(controller.getState().analysis.notice?.code, 'analysis-session-create-unknown');
  assert.equal(controller.getState().analysis.preview !== null, true);
  const firstOperation = controller.getState().analysis.startOperationId;
  assert.equal(firstOperation, 'op-1');
  assert.equal(calls.sends.length, 0);

  await controller.startAnalysis();
  assert.equal(calls.starts.length, 2);
  assert.equal(calls.starts[1]?.request['operationId'], firstOperation);
  assert.equal(calls.sends.length, 1);
  assert.equal(controller.getState().analysis.preview, null);
});

test('7.1 明确拒绝（预览过期）要求重新预览；发送未知不自动重发，显式重试才复用', async () => {
  const { controller, calls } = harness({
    start: () => ({ status: 'rejected', code: 'analysis-preview-stale', message: 'stale' }),
  });
  await controller.load();
  await settle();
  controller.patchAnalysisDraft({ kind: 'directory', path: 'src' });
  await controller.previewAnalysis();
  await controller.startAnalysis();
  assert.equal(controller.getState().analysis.notice?.code, 'analysis-preview-stale');
  assert.equal(controller.getState().analysis.preview, null);
  assert.equal(controller.getState().analysis.startOperationId, null);
  assert.equal(calls.sends.length, 0);

  const second = harness({ send: () => ({ status: 'rejected', code: 'analysis-send-unconfirmed', message: 'unconfirmed' }) });
  await second.controller.load();
  await settle();
  second.controller.patchAnalysisDraft({ kind: 'directory', path: 'src' });
  await second.controller.previewAnalysis();
  await second.controller.startAnalysis();
  assert.equal(second.calls.sends.length, 1);
  assert.equal(second.calls.sends[0]?.retry, false);
  assert.equal(second.controller.getState().analysis.notice?.code, 'analysis-send-unconfirmed');
  await second.controller.retryAnalysisSend('analysis-new');
  assert.equal(second.calls.sends.length, 2);
  assert.equal(second.calls.sends[1]?.retry, true);
});

test('7.2 报告回看：详情、依据变化与显式查看当前文件', async () => {
  const { controller, calls } = harness();
  await controller.load();
  await settle();
  await controller.openAnalysisReport('report-old');
  const state = controller.getState().analysis;
  assert.equal(state.reportPhase, 'ready');
  assert.equal(state.detail?.basis.state, 'changed');
  assert.deepEqual(state.detail?.basis.changes[0], { kind: 'files-modified', paths: ['src/a.ts'] });
  assert.equal(state.detail?.sources[0]?.state, 'content-changed');

  await controller.viewAnalysisSource(0);
  assert.deepEqual(calls.sources, [{ instanceId: A, reportId: 'report-old', citationIndex: 0 }]);
  assert.equal(controller.getState().analysis.currentSource?.text, 'current\ntext');
  controller.closeAnalysisSource();
  assert.equal(controller.getState().analysis.currentSource, null);
  controller.closeAnalysisReport();
  assert.equal(controller.getState().analysis.detail, null);
});

test('7.2 打开历史会话只导航；会话不可用时保留报告并给稳定诊断', async () => {
  const { controller, calls } = harness();
  await controller.load();
  await settle();
  await controller.openAnalysisSession('analysis-old');
  assert.deepEqual(calls.opened, ['session-old']);

  const unavailable = harness();
  await unavailable.controller.load();
  await settle();
  // 用同一控制器替换 deps 不可行；直接验证下一段独立控制器的拒绝分支。
  const failing = new ProjectOverviewController({
    listInstances: async () => ({ status: 'listed', instances: [{ instanceId: A, projectId: 'p', readable: true, sourceDisplay: 'a', configured: true }] }),
    readResumeCard: async () => ({ status: 'empty' }),
    listResumeChats: async () => ({ status: 'unavailable', reason: 'stub' }),
    linkResume: async () => ({ status: 'rejected', code: 'stub', message: 'stub' }),
    resolveChatTarget: async () => ({ status: 'rejected', code: 'stub', message: 'stub' }),
    openSession: () => { throw new Error('must not open'); },
    transportFor: () => ({ status: async () => ({ configured: true, instanceId: A, projectId: 'p', sourceKind: 'custom', sourceDisplay: '/x', localRootDisplay: '/l', created: false, error: null }), snapshot: async () => ({ status: 'rejected', code: 'x', message: 'x' } as never), execute: async () => ({ status: 'rejected', code: 'x', message: 'x' } as never) }),
    newOperationId: () => 'op',
    loadAnalysis: async () => overview(),
    analysisSessionTarget: async () => ({ status: 'rejected', code: 'session-unavailable', message: 'gone' }),
  });
  await failing.load();
  await settle();
  await failing.openAnalysisSession('analysis-old');
  assert.equal(failing.getState().analysis.notice?.code, 'session-unavailable');
});

test('7.3 复盘预览与确认：新操作号、当前基线，原报告标识保留', async () => {
  const { controller, calls } = harness();
  await controller.load();
  await settle();
  await controller.beginAnalysisReview('report-old');
  const review = controller.getState().analysis.review;
  assert.equal(review?.previousAnalysisId, 'analysis-old');
  assert.equal(review?.preview.fingerprint, 'fp-2');
  assert.equal(review?.operationId, 'op-1');

  await controller.confirmAnalysisReview();
  assert.equal(calls.reviewStarts.length, 1);
  assert.deepEqual(calls.reviewStarts[0]?.request, {
    operationId: 'op-1',
    reportId: 'report-old',
    repositoryId: 'repo-1',
    scope: { kind: 'directory', path: 'src' },
    expectedFingerprint: 'fp-2',
    expectedPlanVersion: 'pv-2',
  });
  assert.deepEqual(calls.sends, [{ instanceId: A, analysisId: 'analysis-review', retry: false }]);
  assert.equal(controller.getState().analysis.review, null);
});

test('7.1 切实例丢弃旧分析并忽略迟到响应', async () => {
  let resolveA: ((value: AnalysisOverviewOutcome) => void) | null = null;
  const { controller } = harness({
    loadAnalysis: (instanceId) => instanceId === A
      ? new Promise<AnalysisOverviewOutcome>((resolve) => { resolveA = resolve; })
      : Promise.resolve({
          status: 'ok',
          repositories: [{ repositoryId: 'repo-b', absolutePath: '/repo/b', status: 'available' }],
          runs: [],
        }),
  });
  await controller.load();
  await settle();
  // 首次加载的 A 仍挂起；切到 B 后 B 立即返回。
  controller.select(B);
  await settle();
  assert.equal(controller.getState().analysis.draft.repositoryId, 'repo-b');
  assert.ok(resolveA !== null);
  (resolveA as unknown as (value: AnalysisOverviewOutcome) => void)({
    status: 'ok',
    repositories: [{ repositoryId: 'repo-old', absolutePath: '/old', status: 'available' }],
    runs: [],
  });
  await settle();
  assert.equal(controller.getState().analysis.draft.repositoryId, 'repo-b');
});

test('7.1 宿主未装配分析入口时给出不可用诊断，不调用其他服务', async () => {
  const { controller } = harness({ withAnalysis: false });
  await controller.load();
  await settle();
  const analysis = controller.getState().analysis;
  assert.equal(analysis.phase, 'error');
  assert.equal(analysis.notice?.code, 'analysis-unavailable');
  assert.deepEqual(analysis.repositories, []);
});
