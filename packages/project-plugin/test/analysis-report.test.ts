// 5.2-5.4 报告测试：凭证校验、覆盖、依据状态、幂等/冲突、列表/详情与来源复核。
// 真实文件范围服务 + 假验证索引/正文 + 本机聚合。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { createAnalysisFiles } from '../src/adapters/fs/analysis-files.js';
import { InstanceCommandQueue } from '../src/application/command-queue.js';
import { AnalysisScopeService, type FileReadCredential } from '../src/application/analysis-scope.js';
import { AnalysisVerificationService, type VerificationReadCredential } from '../src/application/analysis-verification.js';
import { AnalysisReportService, type SaveReportInput } from '../src/application/analysis-report.js';
import type { AnalysisSessionServiceDeps } from '../src/application/analysis-session.js';
import { analysisRecordsOf, analysisReportsOf, type AnalysisRecord } from '../src/application/local-state.js';
import { createAnalysisCapabilityPort } from '../src/host/analysis-capabilities.js';
import { ANALYSIS_TOOL_NAMES } from '../src/host/analysis-guard.js';
import { DEFAULT_ANALYSIS_LIMITS, ReadBudget } from '../src/domain/analysis.js';
import type { ProjectDocument } from '../src/domain/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });
const INSTANCE_ID = '44444444-4444-4444-8444-444444444444';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const clock = (): string => '2026-11-28T00:00:00.000Z';
const verificationBody = 'verified body\nsecond line\n';
const verificationHash = `sha256:${sha256(Buffer.from(verificationBody))}`;

function writeFile(root: string, relativePath: string, content: string): void {
  const absolute = path.join(root, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function doc(overrides: { contentHash?: string; planVersion?: string; subjectVersion?: string } = {}): ProjectDocument {
  return {
    planVersion: overrides.planVersion ?? 'plan-v1',
    plan: { nodes: [] },
    records: [
      {
        id: 'rec-1', kind: 'verification', subjectNodeIds: ['node-1'],
        path: 'records/rec-1/body.md', contentHash: overrides.contentHash ?? verificationHash,
        summary: 'verified', sources: [],
        verification: { status: 'pass', subject: { kind: 'node', id: 'node-1' }, subjectVersion: overrides.subjectVersion ?? 'sha256:plan', scope: 'unit' },
      },
    ],
  } as unknown as ProjectDocument;
}

function writeAggregateFixture(localRoot: string, record: AnalysisRecord): void {
  const dir = path.join(localRoot, 'instances', INSTANCE_ID);
  mkdirSync(dir, { recursive: true });
  const aggregate = {
    schemaVersion: 1, instanceId: INSTANCE_ID, projectId: '00000000-0000-4000-8000-000000000011',
    source: { root: '/tmp/unused', kind: 'custom', generation: 1 },
    revisions: { plan: 1, state: 1 }, conversations: { links: [], intents: [] },
    workIntents: [], workSuggestions: [], workRuns: [], operations: [], lastObservation: null,
    repositoryMaps: [], analyses: [record],
  };
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify(aggregate, null, 2) + '\n');
}

interface Harness {
  service: AnalysisReportService;
  scope: AnalysisScopeService;
  verification: AnalysisVerificationService;
  store: LocalStateStore;
  localRoot: string;
  repo: string;
  sessionId: string;
  analysisId: string;
  record: AnalysisRecord;
  setPlanVersion: (value: string) => void;
  setVerificationHash: (value: string) => void;
  setRepositories: (paths: string[]) => void;
}

async function harness(options: { hooks?: AnalysisSessionServiceDeps['hooks'] } = {}): Promise<Harness> {
  const localRoot = mkdtempSync(path.join(artifacts, 'report-'));
  const repo = path.join(localRoot, 'repo');
  writeFile(repo, 'src/a.ts', 'one\ntwo\nthree\n');
  writeFile(repo, 'README.md', '# readme\n');
  let repositories = [repo];
  const scope = new AnalysisScopeService({
    instanceId: INSTANCE_ID, sourceGeneration: 1,
    repositories: async () => repositories.map((absolutePath) => ({ repositoryId: 'repo', absolutePath })),
    files: createAnalysisFiles({ sha256, env: { GIT_CEILING_DIRECTORIES: artifacts } }),
    sha256, clock,
  });
  const preview = await scope.preview({ repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(preview.status, 'ok');
  if (preview.status !== 'ok') throw new Error('preview failed');
  let currentPlanVersion = 'plan-v1';
  let currentVerificationHash = verificationHash;
  const verification = new AnalysisVerificationService({
    baseline: async () => ({ ok: true, doc: doc({ planVersion: currentPlanVersion, contentHash: currentVerificationHash }) }),
    readRecord: async (_path, expectedHash) => {
      const actual = `sha256:${sha256(Buffer.from(verificationBody))}`;
      if (actual !== expectedHash) return { ok: false, code: 'body-hash-mismatch', message: 'hash mismatch' };
      return { ok: true, body: verificationBody };
    },
    sha256,
    limits: DEFAULT_ANALYSIS_LIMITS,
  });
  const sessionId = 'session-1';
  const record: AnalysisRecord = {
    analysisId: 'analysis-1', instanceId: INSTANCE_ID, repositoryId: 'repo',
    repositoryRoot: preview.selection.repositoryRoot, mappingHash: preview.selection.mappingHash,
    sourceGeneration: 1, scope: { kind: 'root' }, planVersion: 'plan-v1', planRevision: 1,
    observation: {
      fingerprint: preview.fingerprint, complete: preview.complete, observedAt: preview.observedAt,
      entries: preview.entries.length, issues: preview.issues.length,
    },
    requestId: 'rpc-1', sessionId, agentPreset: 'cona-project-analysis', status: 'running',
    binding: { persisted: true, protected: true, terminal: false, version: 1 },
    createdAt: '2026-11-28T00:00:00.000Z', updatedAt: '2026-11-28T00:00:00.000Z', sentAt: '2026-11-28T00:00:00.000Z',
  };
  writeAggregateFixture(localRoot, record);
  const store = new LocalStateStore({ clock });
  let reportCounter = 0;
  const service = new AnalysisReportService({
    localRoot, instanceId: INSTANCE_ID, store, queue: new InstanceCommandQueue(),
    scope, verification,
    baseline: async () => ({ ok: true, doc: doc({ planVersion: currentPlanVersion, contentHash: currentVerificationHash }) }),
    sha256, clock, newReportId: () => `report-${++reportCounter}`,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  return {
    service, scope, verification, store, localRoot, repo, sessionId, analysisId: 'analysis-1', record,
    setPlanVersion: (value) => { currentPlanVersion = value; },
    setVerificationHash: (value) => { currentVerificationHash = value; },
    setRepositories: (paths) => { repositories = paths; },
  };
}

async function evidence(h: Harness): Promise<{ files: FileReadCredential[]; verifications: VerificationReadCredential[] }> {
  const preview = await h.scope.preview({ repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(preview.status, 'ok');
  if (preview.status !== 'ok') throw new Error('preview');
  const read = await h.scope.read(preview.selection, { path: 'src/a.ts', budget: new ReadBudget(1024) });
  assert.equal(read.status, 'ok');
  if (read.status !== 'ok') throw new Error('read');
  const index = await h.verification.captureIndex();
  const verified = await h.verification.read(index[0]!, { budget: new ReadBudget(1024) });
  assert.equal(verified.status, 'ok');
  if (verified.status !== 'ok') throw new Error('verification');
  return { files: [read.credential], verifications: [verified.credential] };
}

function draft(h: Harness, files: FileReadCredential[], verifications: VerificationReadCredential[]): SaveReportInput {
  return {
    analysisId: h.analysisId, sessionId: h.sessionId, requestId: 'save-1',
    summary: '范围分析摘要',
    facts: [
      { text: 'src/a.ts 有三行', files: [{ path: 'src/a.ts', startLine: 1, endLine: 3 }] },
      { text: '已有验证通过', verifications: [{ recordId: 'rec-1' }] },
      { text: '规划版本可引用', plan: true },
    ],
    inferences: ['可能还有未读文件'],
    suggestions: ['补充 README 阅读'],
    evidence: { files, verifications },
  };
}

test('5.2 保存报告：凭证校验、覆盖与依据当前', async () => {
  const h = await harness();
  const ev = await evidence(h);
  const saved = await h.service.save(draft(h, ev.files, ev.verifications));
  assert.equal(saved.status, 'saved');
  if (saved.status !== 'saved') return;
  assert.equal(saved.reused, false);
  assert.equal(saved.report.facts.length, 3);
  assert.deepEqual(
    { read: saved.report.coverage.readFiles, complete: saved.report.coverage.completeFiles, only: saved.report.coverage.onlyEnumerated, verification: saved.report.coverage.verificationRead, basis: saved.report.coverage.basis },
    { read: 1, complete: 1, only: 1, verification: 1, basis: 'current' },
  );
  const stored = await h.store.readAggregate(h.localRoot, INSTANCE_ID);
  assert.equal(analysisReportsOf(stored?.analysisReports).length, 1);

  const again = await h.service.save(draft(h, ev.files, ev.verifications));
  assert.equal(again.status, 'saved');
  if (again.status === 'saved') assert.equal(again.reused, true);

  const different = { ...draft(h, ev.files, ev.verifications), summary: '另一份摘要' };
  const conflict = await h.service.save(different);
  assert.equal(conflict.status, 'rejected');
  if (conflict.status === 'rejected') assert.equal(conflict.code, 'report-already-saved');
});

test('5.2 未交付凭证、未引用事实、非运行状态与映射变化均拒绝', async () => {
  const h = await harness();
  const ev = await evidence(h);
  const unbacked = await h.service.save({
    ...draft(h, ev.files, ev.verifications),
    facts: [{ text: '未读内容', files: [{ path: 'README.md' }] }],
  });
  assert.equal(unbacked.status, 'rejected');
  if (unbacked.status === 'rejected') assert.equal(unbacked.code, 'report-citation-unbacked');

  const uncited = await h.service.save({ ...draft(h, ev.files, ev.verifications), facts: [{ text: '无引用' }] });
  assert.equal(uncited.status, 'rejected');
  if (uncited.status === 'rejected') assert.equal(uncited.code, 'report-fact-uncited');

  const wrongSession = await h.service.save({ ...draft(h, ev.files, ev.verifications), sessionId: 'session-other' });
  assert.equal(wrongSession.status, 'rejected');
  if (wrongSession.status === 'rejected') assert.equal(wrongSession.code, 'analysis-session-mismatch');

  h.setRepositories([path.join(h.localRoot, 'other')]);
  const moved = await h.service.save(draft(h, ev.files, ev.verifications));
  assert.equal(moved.status, 'rejected');
  if (moved.status === 'rejected') assert.equal(moved.code, 'report-basis-uncheckable');
});

test('5.2 依据已变：观察后文件变化仍保存但覆盖标 changed；片段计入 fragments', async () => {
  const h = await harness();
  writeFile(h.repo, 'src/a.ts', 'one\nTWO\nthree\n');
  const ev = await evidence(h);
  const preview = await h.scope.preview({ repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(preview.status, 'ok');
  if (preview.status !== 'ok') return;
  const partial = await h.scope.read(preview.selection, { path: 'src/a.ts', maxLines: 1, budget: new ReadBudget(1024) });
  assert.equal(partial.status, 'ok');
  if (partial.status !== 'ok') return;
  const saved = await h.service.save({
    ...draft(h, [partial.credential], []),
    facts: [{ text: '只读了第一行', files: [{ path: 'src/a.ts', startLine: 1, endLine: 1 }] }],
  });
  assert.equal(saved.status, 'saved');
  if (saved.status !== 'saved') return;
  assert.equal(saved.report.coverage.basis, 'changed');
  assert.equal(saved.report.coverage.fragments, 1);
  assert.equal(saved.report.coverage.completeFiles, 0);
  assert.equal(ev.files.length, 1);
});

test('5.3 报告列表/详情按实例隔离；来源复核区分当前与变化', async () => {
  const h = await harness();
  const ev = await evidence(h);
  const saved = await h.service.save(draft(h, ev.files, ev.verifications));
  assert.equal(saved.status, 'saved');
  if (saved.status !== 'saved') return;
  const reportId = saved.report.reportId;

  const list = await h.service.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.reportId, reportId);
  const detail = await h.service.get(reportId);
  assert.equal(detail.status, 'ok');

  const current = await h.service.verifySources(reportId);
  assert.equal(current.status, 'ok');
  if (current.status === 'ok') {
    assert.equal(current.sources.some((item) => item.state !== 'current'), false);
  }

  writeFile(h.repo, 'src/a.ts', 'one\nTWO\nthree\n');
  const changed = await h.service.verifySources(reportId);
  assert.equal(changed.status, 'ok');
  if (changed.status === 'ok') {
    assert.equal(changed.sources.some((item) => item.citation.kind === 'file' && item.state === 'content-changed'), true);
  }
  unlinkSync(path.join(h.repo, 'src/a.ts'));
  const missing = await h.service.verifySources(reportId);
  assert.equal(missing.status, 'ok');
  if (missing.status === 'ok') {
    assert.equal(missing.sources.some((item) => item.citation.kind === 'file' && item.state === 'missing'), true);
  }

  h.setVerificationHash('sha256:changed');
  const verificationChanged = await h.service.verifySources(reportId);
  assert.equal(verificationChanged.status, 'ok');
  if (verificationChanged.status === 'ok') {
    assert.equal(verificationChanged.sources.some((item) => item.citation.kind === 'verification' && item.state === 'content-changed'), true);
  }

  h.setRepositories([path.join(h.localRoot, 'moved-away')]);
  const mappingChanged = await h.service.verifySources(reportId);
  assert.equal(mappingChanged.status, 'ok');
  if (mappingChanged.status === 'ok') {
    assert.equal(mappingChanged.sources.some((item) => item.citation.kind === 'file' && item.state === 'mapping-changed'), true);
  }

  h.setPlanVersion('plan-v2');
  const planChanged = await h.service.verifySources(reportId);
  assert.equal(planChanged.status, 'ok');
  if (planChanged.status === 'ok') {
    assert.equal(planChanged.sources.some((item) => item.citation.kind === 'plan' && item.state === 'content-changed'), true);
  }

  const otherInstance = new AnalysisReportService({
    localRoot: h.localRoot, instanceId: '55555555-5555-4555-8555-555555555555', store: h.store,
    queue: new InstanceCommandQueue(), scope: h.scope, verification: h.verification,
    baseline: async () => ({ ok: true, doc: doc() }), sha256, clock, newReportId: () => 'x',
  });
  assert.deepEqual(await otherInstance.list(), []);
  const denied = await otherInstance.get(reportId);
  assert.equal(denied.status, 'rejected');
  if (denied.status === 'rejected') assert.match(denied.code, /report-not-found|binding-expired/);
});

test('5.2 旧聚合无 analysisReports 可读，报告读取归一化', () => {
  assert.deepEqual(analysisReportsOf(undefined), []);
  assert.deepEqual(analysisReportsOf([{ reportId: 'bad' }]), []);
  assert.equal(analysisRecordsOf(undefined).length, 0);
});

interface FakeToolDefinition {
  name: string;
  execute(args: unknown, exec: { agent?: { id?: unknown } }): Promise<Record<string, unknown>>;
}

async function capabilityHarness() {
  const h = await harness();
  const registered: FakeToolDefinition[] = [];
  const agent = {
    ctx: {
      tools: {
        register(definition: FakeToolDefinition) {
          registered.push(definition);
          return () => {};
        },
      },
    },
  };
  const port = createAnalysisCapabilityPort({
    scope: h.scope,
    verification: h.verification,
    reports: h.service,
    baseline: async () => ({ ok: true, doc: doc() }),
    sha256,
    limits: DEFAULT_ANALYSIS_LIMITS,
  });
  const result = await port.register({ agent, record: h.record });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(registered.map((item) => item.name), [
    ANALYSIS_TOOL_NAMES.background,
    ANALYSIS_TOOL_NAMES.scopeFiles,
    ANALYSIS_TOOL_NAMES.verification,
    ANALYSIS_TOOL_NAMES.saveReport,
  ]);
  const call = (name: string, args: unknown) => {
    const definition = registered.find((item) => item.name === name);
    assert.ok(definition !== undefined);
    return definition!.execute(args, { agent: { id: h.sessionId } });
  };
  return { h, registered, call, port, agent };
}

test('5.1-5.4 四个分析工具：背景、范围读取、验证记录与报告保存', async () => {
  const { h, call } = await capabilityHarness();

  const background = await call(ANALYSIS_TOOL_NAMES.background, {});
  assert.equal(background['status'], 'ok');
  assert.equal(background['analysisId'], h.analysisId);
  assert.equal(Array.isArray(background['verificationIndex']), true);

  const list = await call(ANALYSIS_TOOL_NAMES.scopeFiles, { action: 'list' });
  assert.equal(list['status'], 'ok');
  assert.equal(Array.isArray(list['entries']), true);

  const fileRead = await call(ANALYSIS_TOOL_NAMES.scopeFiles, { action: 'read', path: 'src/a.ts' });
  assert.equal(fileRead['status'], 'ok');
  assert.equal(fileRead['text'], 'one\ntwo\nthree');

  const verificationList = await call(ANALYSIS_TOOL_NAMES.verification, { action: 'list' });
  assert.equal(verificationList['status'], 'ok');
  assert.equal((verificationList['records'] as unknown[]).length, 1);
  const verificationRead = await call(ANALYSIS_TOOL_NAMES.verification, { action: 'read', recordId: 'rec-1' });
  assert.equal(verificationRead['status'], 'ok');
  assert.equal(verificationRead['text'], 'verified body\nsecond line');

  const saved = await call(ANALYSIS_TOOL_NAMES.saveReport, {
    requestId: 'tool-save-1',
    summary: '工具侧报告',
    facts: [
      { text: '文件内容', files: [{ path: 'src/a.ts', startLine: 1, endLine: 3 }] },
      { text: '验证记录', verifications: [{ recordId: 'rec-1' }] },
      { text: '规划背景', plan: true },
    ],
    inferences: ['推断'],
    suggestions: ['建议'],
  });
  assert.equal(saved['status'], 'ok');
  const reportId = saved['reportId'];
  assert.equal(typeof reportId, 'string');
  const detail = await h.service.get(reportId as string);
  assert.equal(detail.status, 'ok');
  if (detail.status === 'ok') {
    assert.equal(detail.report.facts.length, 3);
    assert.equal(detail.report.coverage.readFiles, 1);
    assert.equal(detail.report.coverage.verificationRead, 1);
  }
});

test('5.1-5.4 工具身份与参数边界：错误 Session、未知字段、未交付引用都拒绝', async () => {
  const { h, registered, call } = await capabilityHarness();
  const definition = registered[0]!;
  const wrong = await definition.execute({}, { agent: { id: 'session-other' } });
  assert.equal(wrong['status'], 'rejected');
  assert.equal(wrong['code'], 'analysis-session-mismatch');

  const unknownKey = await call(ANALYSIS_TOOL_NAMES.scopeFiles, { action: 'list', sessionId: h.sessionId });
  assert.equal(unknownKey['status'], 'rejected');
  assert.equal(unknownKey['code'], 'analysis-args-invalid');

  const unbacked = await call(ANALYSIS_TOOL_NAMES.saveReport, {
    requestId: 'tool-save-2',
    summary: '未读',
    facts: [{ text: '无凭证', files: [{ path: 'README.md' }] }],
  });
  assert.equal(unbacked['status'], 'rejected');
  assert.equal(unbacked['code'], 'report-citation-unbacked');
});

test('5.1-5.4 能力注册在缺少 scoped tools 时明确失败', async () => {
  const h = await harness();
  const port = createAnalysisCapabilityPort({
    scope: h.scope, verification: h.verification, reports: h.service,
    baseline: async () => ({ ok: true, doc: doc() }), sha256, limits: DEFAULT_ANALYSIS_LIMITS,
  });
  const result = await port.register({ agent: {}, record: h.record });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'analysis-agent-tools-missing');
});


test('5.2 持久化失败与停止请求：报告不落盘、状态不假装完成', async () => {
  let writes = 0;
  const h = await harness({ hooks: { beforeAggregateReplace: { beforeTempWrite: () => { writes += 1; throw new Error('disk full'); } } } });
  const ev = await evidence(h);
  const failed = await h.service.save(draft(h, ev.files, ev.verifications));
  assert.equal(failed.status, 'rejected');
  if (failed.status === 'rejected') assert.equal(failed.code, 'persistence-failed');
  assert.ok(writes > 0);
  assert.deepEqual(await h.service.list(), []);

  const h2 = await harness();
  const ev2 = await evidence(h2);
  const aggregate = await h2.store.readAggregate(h2.localRoot, INSTANCE_ID);
  assert.ok(aggregate !== null);
  if (aggregate === null) return;
  await h2.store.writeAggregate(h2.localRoot, {
    ...aggregate,
    analyses: (aggregate.analyses ?? []).map((item) => ({ ...item, stopRequestedAt: clock() })),
  });
  const stopping = await h2.service.save(draft(h2, ev2.files, ev2.verifications));
  assert.equal(stopping.status, 'rejected');
  if (stopping.status === 'rejected') assert.equal(stopping.code, 'analysis-stopping');
});

test('5.2 资料源代际变化：报告依据无法核对时不保存', async () => {
  const h = await harness();
  const ev = await evidence(h);
  const futureScope = new AnalysisScopeService({
    instanceId: INSTANCE_ID, sourceGeneration: 2,
    repositories: async () => [{ repositoryId: 'repo', absolutePath: h.repo }],
    files: createAnalysisFiles({ sha256, env: { GIT_CEILING_DIRECTORIES: artifacts } }),
    sha256, clock,
  });
  const service = new AnalysisReportService({
    localRoot: h.localRoot, instanceId: INSTANCE_ID, store: h.store, queue: new InstanceCommandQueue(),
    scope: futureScope, verification: h.verification,
    baseline: async () => ({ ok: true, doc: doc() }), sha256, clock, newReportId: () => 'report-future',
  });
  const result = await service.save(draft(h, ev.files, ev.verifications));
  assert.equal(result.status, 'rejected');
  if (result.status === 'rejected') assert.equal(result.code, 'report-basis-uncheckable');
});
