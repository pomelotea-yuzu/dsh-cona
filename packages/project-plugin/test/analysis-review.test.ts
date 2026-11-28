// 6.3 复盘测试：从历史报告重新预览同一范围，经同一发起通路建立新分析、
// 新 Session 与当前基线；旧报告与旧绑定保持独立。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { createAnalysisFiles } from '../src/adapters/fs/analysis-files.js';
import { InstanceCommandQueue } from '../src/application/command-queue.js';
import { AnalysisScopeService } from '../src/application/analysis-scope.js';
import { AnalysisVerificationService } from '../src/application/analysis-verification.js';
import { AnalysisReportService } from '../src/application/analysis-report.js';
import { AnalysisSessionService, analysisSelectionOf } from '../src/application/analysis-session.js';
import { AnalysisReviewService } from '../src/application/analysis-review.js';
import { analysisRecordsOf, type AnalysisRecord, type AnalysisReportRecord } from '../src/application/local-state.js';
import type { AnalysisExecutionPort, AnalysisSessionPort, DirectorySession } from '../src/application/ports.js';
import { DEFAULT_ANALYSIS_LIMITS, ReadBudget } from '../src/domain/analysis.js';
import type { ProjectDocument } from '../src/domain/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });
const INSTANCE_ID = '77777777-7777-4777-8777-777777777777';
const OTHER_INSTANCE = '88888888-8888-4888-8888-888888888888';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const clock = (): string => '2026-11-28T00:00:00.000Z';

function writeFile(root: string, relativePath: string, content: string): void {
  const absolute = path.join(root, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

class FakeAnalysisSession implements AnalysisSessionPort {
  calls: Array<{ cwd: string; agentPreset: string }> = [];
  promptCalls: Array<{ sessionId: string; requestId: string; text: string }> = [];
  async createAnalysisSession(input: { cwd: string; agentPreset: string }): Promise<{ sessionId: string; agentPreset?: string }> {
    this.calls.push(input);
    return { sessionId: `session-analysis-${this.calls.length}`, agentPreset: input.agentPreset };
  }
  async listSessions(): Promise<readonly DirectorySession[]> { return []; }
  async promptFirstMessage(input: { sessionId: string; requestId: string; text: string }): Promise<{ accepted: true }> {
    this.promptCalls.push(input);
    return { accepted: true };
  }
  async cancelSession(): Promise<{ accepted: true }> { return { accepted: true }; }
}

class FakeExecution implements AnalysisExecutionPort {
  async prepare(): Promise<{ ready: true }> { return { ready: true }; }
  async promptAccepted(): Promise<boolean | 'unknown'> { return false; }
}

function writeAggregateFixture(localRoot: string, analyses: AnalysisRecord[], reports: AnalysisReportRecord[]): void {
  const dir = path.join(localRoot, 'instances', INSTANCE_ID);
  mkdirSync(dir, { recursive: true });
  const aggregate = {
    schemaVersion: 1, instanceId: INSTANCE_ID, projectId: '00000000-0000-4000-8000-000000000077',
    source: { root: '/tmp/unused', kind: 'custom', generation: 1 },
    revisions: { plan: 1, state: 1 }, conversations: { links: [], intents: [] },
    workIntents: [], workSuggestions: [], workRuns: [], operations: [], lastObservation: null,
    repositoryMaps: [], analyses, analysisReports: reports,
  };
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify(aggregate, null, 2) + '\n');
}

function verificationDoc(): ProjectDocument {
  return {
    planVersion: 'plan-v1',
    plan: { nodes: [] },
    records: [],
  } as unknown as ProjectDocument;
}

interface Harness {
  review: AnalysisReviewService;
  sessionService: AnalysisSessionService;
  reports: AnalysisReportService;
  scope: AnalysisScopeService;
  fakeSession: FakeAnalysisSession;
  store: LocalStateStore;
  localRoot: string;
  repo: string;
  sourceReportId: string;
  sourceAnalysisId: string;
}

async function harness(): Promise<Harness> {
  const localRoot = mkdtempSync(path.join(artifacts, 'review-'));
  const repo = path.join(localRoot, 'repo');
  writeFile(repo, 'src/a.ts', 'one\ntwo\nthree\n');
  writeFile(repo, 'README.md', '# readme\n');
  const scope = new AnalysisScopeService({
    instanceId: INSTANCE_ID, sourceGeneration: 1,
    repositories: async () => [{ repositoryId: 'repo', absolutePath: repo }],
    files: createAnalysisFiles({ sha256, env: { GIT_CEILING_DIRECTORIES: artifacts } }),
    sha256, clock,
  });
  const preview = await scope.preview({ repositoryId: 'repo', scope: { kind: 'directory', path: 'src' } });
  assert.equal(preview.status, 'ok');
  if (preview.status !== 'ok') throw new Error('preview failed');

  const sourceAnalysis: AnalysisRecord = {
    analysisId: 'analysis-old', instanceId: INSTANCE_ID, repositoryId: 'repo',
    repositoryRoot: preview.selection.repositoryRoot, mappingHash: preview.selection.mappingHash,
    sourceGeneration: 1, scope: { kind: 'directory', path: 'src' }, planVersion: 'plan-v1', planRevision: 1,
    observation: {
      fingerprint: preview.fingerprint, complete: preview.complete, observedAt: preview.observedAt,
      entries: preview.entries.length, issues: preview.issues.length,
      contents: preview.entries.map((entry) => ({ path: entry.path, kind: 'file' as const, hash: entry.hash })),
    },
    requestId: 'rpc-old', sessionId: 'session-old', agentPreset: 'cona-project-analysis', status: 'completed',
    binding: { persisted: true, protected: true, terminal: true, version: 2 },
    createdAt: '2026-11-27T00:00:00.000Z', updatedAt: '2026-11-27T00:00:00.000Z',
    endedAt: '2026-11-27T01:00:00.000Z', endReason: 'completed',
  };
  const sourceReport: AnalysisReportRecord = {
    reportId: 'report-old', analysisId: 'analysis-old', instanceId: INSTANCE_ID, repositoryId: 'repo',
    scope: { kind: 'directory', path: 'src' }, planVersion: 'plan-v1', sourceGeneration: 1,
    requestId: 'save-old', payloadHash: 'payload-old', createdAt: '2026-11-27T01:00:00.000Z',
    summary: '旧报告',
    facts: [{ text: 'src/a.ts 内容', citations: [{ kind: 'plan', planVersion: 'plan-v1' }] }],
    inferences: [], suggestions: [],
    coverage: {
      observedFiles: 1, readFiles: 1, completeFiles: 1, fragments: 0, onlyEnumerated: 0,
      unreadable: 0, excluded: 0, verificationRead: 0, truncated: false, observationComplete: true,
      basis: 'current', fingerprint: preview.fingerprint,
    },
  };
  writeAggregateFixture(localRoot, [sourceAnalysis], [sourceReport]);

  const store = new LocalStateStore({ clock });
  const queue = new InstanceCommandQueue();
  const baseline = async () => ({ ok: true as const, doc: verificationDoc() });
  const verification = new AnalysisVerificationService({
    baseline,
    readRecord: async () => ({ ok: false as const, code: 'body-missing', message: 'missing' }),
    sha256,
    limits: DEFAULT_ANALYSIS_LIMITS,
  });
  const reports = new AnalysisReportService({
    localRoot, instanceId: INSTANCE_ID, store, queue, scope, verification, baseline, sha256, clock,
    newReportId: () => 'report-new',
  });
  const fakeSession = new FakeAnalysisSession();
  let counter = 0;
  const sessionService = new AnalysisSessionService({
    localRoot, instanceId: INSTANCE_ID, store, queue, scope,
    planBaseline: async () => ({ ok: true as const, planVersion: 'plan-v1' }),
    session: fakeSession,
    execution: new FakeExecution(),
    clock,
    newAnalysisId: () => `analysis-new-${++counter}`,
    agentPreset: 'cona-project-analysis',
  });
  const review = new AnalysisReviewService({ reports, sessions: sessionService, scope });
  return {
    review, sessionService, reports, scope, fakeSession, store, localRoot, repo,
    sourceReportId: 'report-old', sourceAnalysisId: 'analysis-old',
  };
}

test('6.3 复盘预览沿用原报告范围，确认后用当前基线新建分析', async () => {
  const h = await harness();
  const preview = await h.review.preview(h.sourceReportId);
  assert.equal(preview.status, 'ok');
  if (preview.status !== 'ok') return;
  assert.equal(preview.value.previousAnalysisId, 'analysis-old');
  assert.equal(preview.value.repositoryId, 'repo');
  assert.deepEqual(preview.value.scope, { kind: 'directory', path: 'src' });
  assert.equal(preview.value.preview.status, 'ok');

  const started = await h.review.reanalyze({ operationId: 'review-op-1', reportId: h.sourceReportId });
  assert.equal(started.status, 'committed');
  if (started.status !== 'committed') return;
  assert.equal(started.value.previousAnalysisId, 'analysis-old');
  assert.equal(started.value.sourceReportId, 'report-old');
  assert.equal(started.value.reused, false);
  assert.equal(started.value.analysis.analysisId, 'analysis-new-1');
  assert.equal(started.value.analysis.sessionId, 'session-analysis-1');
  assert.equal(started.value.analysis.previousAnalysisId, 'analysis-old');
  assert.equal(started.value.analysis.planVersion, 'plan-v1');
  assert.deepEqual(started.value.analysis.scope, { kind: 'directory', path: 'src' });
  assert.equal(h.fakeSession.calls.length, 1);
  assert.equal(h.fakeSession.calls[0]?.cwd, h.repo);
  assert.equal(h.fakeSession.calls[0]?.agentPreset, 'cona-project-analysis');

  const aggregate = await h.store.readAggregate(h.localRoot, INSTANCE_ID);
  const records = analysisRecordsOf(aggregate?.analyses);
  assert.equal(records.length, 2);
  assert.equal(records.find((record) => record.analysisId === 'analysis-old')?.status, 'completed');
  const fresh = records.find((record) => record.analysisId === 'analysis-new-1');
  assert.equal(fresh?.sessionId, 'session-analysis-1');
  assert.equal(fresh?.observation.fingerprint, preview.value.preview.status === 'ok' ? preview.value.preview.fingerprint : '');
  assert.equal(fresh?.observation.git, undefined);

  // 旧报告仍可查，且仍绑定旧分析。
  const oldReport = await h.reports.get(h.sourceReportId);
  assert.equal(oldReport.status, 'ok');
  if (oldReport.status === 'ok') assert.equal(oldReport.report.analysisId, 'analysis-old');

  // 同 operationId 重试回到同一条新分析，不再建 Session。
  const retry = await h.review.reanalyze({ operationId: 'review-op-1', reportId: h.sourceReportId });
  assert.equal(retry.status, 'committed');
  if (retry.status === 'committed') {
    assert.equal(retry.value.reused, true);
    assert.equal(retry.value.analysis.analysisId, 'analysis-new-1');
  }
  assert.equal(h.fakeSession.calls.length, 1);
});

test('6.3 二次分析绑定独立；旧记录不被改写', async () => {
  const h = await harness();
  const first = await h.review.reanalyze({ operationId: 'review-op-a', reportId: h.sourceReportId });
  assert.equal(first.status, 'committed');
  const second = await h.review.reanalyze({ operationId: 'review-op-b', reportId: h.sourceReportId });
  assert.equal(second.status, 'committed');
  if (first.status !== 'committed' || second.status !== 'committed') return;
  assert.notEqual(first.value.analysis.analysisId, second.value.analysis.analysisId);
  assert.notEqual(first.value.analysis.sessionId, second.value.analysis.sessionId);
  assert.equal(h.fakeSession.calls.length, 2);

  const aggregate = await h.store.readAggregate(h.localRoot, INSTANCE_ID);
  const records = analysisRecordsOf(aggregate?.analyses);
  assert.equal(records.length, 3);
  for (const id of ['analysis-old', first.value.analysis.analysisId, second.value.analysis.analysisId]) {
    assert.equal(records.filter((record) => record.analysisId === id).length, 1);
  }
});

test('6.3 复盘后两轮报告各自可查、各自核对依据', async () => {
  const h = await harness();
  const started = await h.review.reanalyze({ operationId: 'review-op-two-reports', reportId: h.sourceReportId });
  assert.equal(started.status, 'committed');
  if (started.status !== 'committed') return;
  const newId = started.value.analysis.analysisId;

  const sent = await h.sessionService.sendFirstMessage(newId);
  assert.equal(sent.status, 'committed');
  const detail = await h.sessionService.get(newId);
  assert.equal(detail.status, 'ok');
  if (detail.status !== 'ok') return;
  assert.equal(detail.analysis.status, 'running');
  const selection = analysisSelectionOf(detail.analysis);
  const read = await h.scope.read(selection, { path: 'src/a.ts', budget: new ReadBudget(4096) });
  assert.equal(read.status, 'ok');
  if (read.status !== 'ok') return;

  const saved = await h.reports.save({
    analysisId: newId,
    sessionId: detail.analysis.sessionId ?? '',
    requestId: 'save-new',
    summary: '复盘报告',
    facts: [{ text: 'src/a.ts 内容', files: [{ path: 'src/a.ts' }] }, { text: '规划背景', plan: true }],
    inferences: [], suggestions: [],
    evidence: { files: [read.credential], verifications: [] },
  });
  assert.equal(saved.status, 'saved');
  if (saved.status !== 'saved') return;
  assert.notEqual(saved.report.reportId, h.sourceReportId);
  assert.equal(saved.report.analysisId, newId);
  assert.equal(saved.report.basis?.sourceGeneration, 1);

  const list = await h.reports.list();
  assert.equal(list.length, 2);
  assert.equal(new Set(list.map((item) => item.analysisId)).size, 2);

  for (const reportId of [h.sourceReportId, saved.report.reportId]) {
    const basis = await h.reports.evaluateBasis(reportId);
    assert.equal(basis.status, 'ok');
    if (basis.status === 'ok') {
      assert.equal(basis.basis.state, 'current');
      assert.equal(basis.report.reportId, reportId);
    }
  }

  writeFile(h.repo, 'src/a.ts', 'one\ntwo\nTHREE\n');
  for (const reportId of [h.sourceReportId, saved.report.reportId]) {
    const basis = await h.reports.evaluateBasis(reportId);
    assert.equal(basis.status, 'ok');
    if (basis.status === 'ok') {
      assert.equal(basis.basis.state, 'changed');
      assert.deepEqual(basis.basis.changes.find((change) => change.kind === 'files-modified')?.paths, ['src/a.ts']);
    }
  }
});

test('6.3 原分析未结束、报告不存在、预览过期与跨实例均拒绝且不派发', async () => {
  const h = await harness();
  const aggregate = await h.store.readAggregate(h.localRoot, INSTANCE_ID);
  assert.ok(aggregate !== null);
  if (aggregate === null) return;
  // 把原分析改成仍在运行：复盘必须等报告完成后才可发起。
  await h.store.writeAggregate(h.localRoot, {
    ...aggregate,
    analyses: (aggregate.analyses ?? []).map((record) => ({
      ...record,
      status: 'running' as const,
      binding: { persisted: true, protected: true, terminal: false, version: 1 },
    })),
  });
  const active = await h.review.reanalyze({ operationId: 'review-op-active', reportId: h.sourceReportId });
  assert.equal(active.status, 'rejected');
  if (active.status === 'rejected') assert.equal(active.code, 'analysis-source-active');
  assert.equal(h.fakeSession.calls.length, 0);

  await h.store.writeAggregate(h.localRoot, aggregate);
  const missing = await h.review.reanalyze({ operationId: 'review-op-missing', reportId: 'report-missing' });
  assert.equal(missing.status, 'rejected');
  if (missing.status === 'rejected') assert.equal(missing.code, 'report-not-found');

  const stale = await h.review.reanalyze({
    operationId: 'review-op-stale', reportId: h.sourceReportId, expectedFingerprint: 'not-the-current-fingerprint',
  });
  assert.equal(stale.status, 'rejected');
  if (stale.status === 'rejected') assert.equal(stale.code, 'analysis-preview-stale');
  assert.equal(h.fakeSession.calls.length, 0);

  // 复用首轮启动操作号不能把旧分析当成新一轮复盘。
  const reusedOperation = await h.review.reanalyze({ operationId: 'rpc-old', reportId: h.sourceReportId });
  assert.equal(reusedOperation.status, 'rejected');
  if (reusedOperation.status === 'rejected') assert.equal(reusedOperation.code, 'review-operation-conflict');
  assert.equal(h.fakeSession.calls.length, 0);

  const other = new AnalysisReportService({
    localRoot: h.localRoot, instanceId: OTHER_INSTANCE, store: h.store, queue: new InstanceCommandQueue(),
    scope: h.scope, verification: new AnalysisVerificationService({
      baseline: async () => ({ ok: true as const, doc: verificationDoc() }),
      readRecord: async () => ({ ok: false as const, code: 'body-missing', message: 'missing' }),
      sha256, limits: DEFAULT_ANALYSIS_LIMITS,
    }),
    baseline: async () => ({ ok: true as const, doc: verificationDoc() }),
    sha256, clock, newReportId: () => 'x',
  });
  const foreign = new AnalysisReviewService({ reports: other, sessions: h.sessionService, scope: h.scope });
  const denied = await foreign.reanalyze({ operationId: 'review-op-foreign', reportId: h.sourceReportId });
  assert.equal(denied.status, 'rejected');
  if (denied.status === 'rejected') assert.match(denied.code, /report-not-found|binding-expired/);
  assert.equal(h.fakeSession.calls.length, 0);
});
