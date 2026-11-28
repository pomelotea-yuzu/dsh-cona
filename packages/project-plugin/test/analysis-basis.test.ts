// 6.1-6.2 依据状态测试：保存起始依据，提交与回看分别核对；同 HEAD 内
// 增删改、行号移动、规划／映射／代际变化、验证记录变化与追加、范围外变化、
// 观察截断与工作副本失联。真实文件 + 真实 Git + 本机聚合。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { createAnalysisFiles } from '../src/adapters/fs/analysis-files.js';
import { InstanceCommandQueue } from '../src/application/command-queue.js';
import { AnalysisScopeService, type AnalysisReadResult } from '../src/application/analysis-scope.js';
import { AnalysisVerificationService } from '../src/application/analysis-verification.js';
import { AnalysisReportService, type SaveReportInput } from '../src/application/analysis-report.js';
import { AnalysisBasisService, basisSnapshotOf, compareObservationContents } from '../src/application/analysis-basis.js';
import { analysisRecordsOf, analysisReportsOf, type AnalysisRecord } from '../src/application/local-state.js';
import { DEFAULT_ANALYSIS_LIMITS, ReadBudget, type ScopeSelection } from '../src/domain/analysis.js';
import type { ProjectDocument } from '../src/domain/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });
const INSTANCE_ID = '66666666-6666-4666-8666-666666666666';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const clock = (): string => '2026-11-28T00:00:00.000Z';
const verificationBody = 'verified body\nsecond line\n';
const verificationHash = `sha256:${sha256(Buffer.from(verificationBody))}`;

function writeFile(root: string, relativePath: string, content: string): void {
  const absolute = path.join(root, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t.invalid', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: artifacts },
  });
}

function headOf(cwd: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: artifacts },
  }).trim();
}

function verificationRecord(id: string, contentHash: string): Record<string, unknown> {
  return {
    id,
    kind: 'verification',
    subjectNodeIds: ['node-1'],
    path: `records/${id}/body.md`,
    contentHash,
    summary: `verified ${id}`,
    sources: [],
    verification: {
      status: 'pass',
      subject: { kind: 'node', id: 'node-1' },
      subjectVersion: 'sha256:plan',
      scope: 'unit',
    },
  };
}

function writeAggregateFixture(localRoot: string, record: AnalysisRecord): void {
  const dir = path.join(localRoot, 'instances', INSTANCE_ID);
  mkdirSync(dir, { recursive: true });
  const aggregate = {
    schemaVersion: 1, instanceId: INSTANCE_ID, projectId: '00000000-0000-4000-8000-000000000066',
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
  basis: AnalysisBasisService;
  verification: AnalysisVerificationService;
  files: ReturnType<typeof createAnalysisFiles>;
  store: LocalStateStore;
  localRoot: string;
  repo: string;
  record: AnalysisRecord;
  reportId: string;
  planVersion: () => string;
  setPlanVersion: (value: string) => void;
  addVerification: (id: string) => void;
  setVerificationHash: (value: string) => void;
  setRepositories: (paths: string[]) => void;
  baseline: () => Promise<{ ok: true; doc: ProjectDocument }>;
  readCredential: (path: string) => Promise<AnalysisReadResult>;
  selection: ScopeSelection;
}

async function harness(options: { scope?: ScopeSelection; withGit?: boolean; noContents?: boolean; save?: boolean } = {}): Promise<Harness> {
  const localRoot = mkdtempSync(path.join(artifacts, 'basis-'));
  const repo = path.join(localRoot, 'repo');
  writeFile(repo, 'src/a.ts', 'one\ntwo\nthree\n');
  writeFile(repo, 'README.md', '# readme\n');
  if (options.withGit !== false) {
    git(repo, ['init', '--quiet']);
    git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    git(repo, ['add', '.']);
    git(repo, ['commit', '--quiet', '-m', 'c1']);
  }
  const head = options.withGit === false ? undefined : headOf(repo);

  let repositories = [repo];
  const files = createAnalysisFiles({ sha256, env: { GIT_CEILING_DIRECTORIES: artifacts } });
  const scope = new AnalysisScopeService({
    instanceId: INSTANCE_ID, sourceGeneration: 1,
    repositories: async () => repositories.map((absolutePath) => ({ repositoryId: 'repo', absolutePath })),
    files, sha256, clock,
  });
  const selectionOf = options.scope ?? { kind: 'root' as const };
  const preview = await scope.preview({ repositoryId: 'repo', scope: selectionOf });
  assert.equal(preview.status, 'ok');
  if (preview.status !== 'ok') throw new Error('preview failed');

  let planVersion = 'plan-v1';
  let verificationContentHash = verificationHash;
  const extras: string[] = [];
  const baseline = async (): Promise<{ ok: true; doc: ProjectDocument }> => ({
    ok: true,
    doc: {
      planVersion,
      plan: { nodes: [] },
      records: [verificationRecord('rec-1', verificationContentHash), ...extras.map((id) => verificationRecord(id, `sha256:${id}`))],
    } as unknown as ProjectDocument,
  });
  const verification = new AnalysisVerificationService({
    baseline,
    readRecord: async (_path, expectedHash) => {
      const actual = `sha256:${sha256(Buffer.from(verificationBody))}`;
      if (actual !== expectedHash) return { ok: false, code: 'body-hash-mismatch', message: 'hash mismatch' };
      return { ok: true, body: verificationBody };
    },
    sha256,
    limits: DEFAULT_ANALYSIS_LIMITS,
  });

  const record: AnalysisRecord = {
    analysisId: 'analysis-1', instanceId: INSTANCE_ID, repositoryId: 'repo',
    repositoryRoot: preview.selection.repositoryRoot, mappingHash: preview.selection.mappingHash,
    sourceGeneration: 1, scope: selectionOf, planVersion: 'plan-v1', planRevision: 1,
    observation: {
      fingerprint: preview.fingerprint, complete: preview.complete, observedAt: preview.observedAt,
      entries: preview.entries.length, issues: preview.issues.length,
      ...(options.noContents === true
        ? {}
        : { contents: preview.entries.map((entry) => ({ path: entry.path, kind: 'file' as const, hash: entry.hash })) }),
      ...(head === undefined ? {} : { git: { head } }),
    },
    requestId: 'rpc-1', sessionId: 'session-1', agentPreset: 'cona-project-analysis', status: 'running',
    binding: { persisted: true, protected: true, terminal: false, version: 1 },
    createdAt: '2026-11-28T00:00:00.000Z', updatedAt: '2026-11-28T00:00:00.000Z', sentAt: '2026-11-28T00:00:00.000Z',
  };
  writeAggregateFixture(localRoot, record);
  const store = new LocalStateStore({ clock });
  let counter = 0;
  const service = new AnalysisReportService({
    localRoot, instanceId: INSTANCE_ID, store, queue: new InstanceCommandQueue(),
    scope, verification, baseline, sha256, clock, newReportId: () => `report-${++counter}`,
  });
  const basis = new AnalysisBasisService({ scope, verification, baseline, clock });

  const read = await scope.read(preview.selection, { path: 'src/a.ts', budget: new ReadBudget(4096) });
  assert.equal(read.status, 'ok');
  if (read.status !== 'ok') throw new Error('read failed');
  const index = await verification.captureIndex();
  const verified = await verification.read(index.find((entry) => entry.recordId === 'rec-1')!, { budget: new ReadBudget(4096) });
  assert.equal(verified.status, 'ok');
  if (verified.status !== 'ok') throw new Error('verification read failed');
  const draft: SaveReportInput = {
    analysisId: record.analysisId, sessionId: 'session-1', requestId: 'save-1',
    summary: '依据测试摘要',
    facts: [
      { text: 'src/a.ts 的内容', files: [{ path: 'src/a.ts', startLine: 1, endLine: 3 }] },
      { text: '已有验证', verifications: [{ recordId: 'rec-1' }] },
      { text: '规划背景', plan: true },
    ],
    inferences: [], suggestions: [],
    evidence: { files: [read.credential], verifications: [verified.credential] },
  };
  let reportId = '';
  if (options.save !== false) {
    const saved = await service.save(draft);
    assert.equal(saved.status, 'saved');
    if (saved.status !== 'saved') throw new Error('save failed');
    reportId = saved.report.reportId;
  }

  return {
    service, scope, basis, verification, files, store, localRoot, repo, record,
    reportId,
    planVersion: () => planVersion,
    setPlanVersion: (value) => { planVersion = value; },
    addVerification: (id) => { extras.push(id); },
    setVerificationHash: (value) => { verificationContentHash = value; },
    setRepositories: (paths) => { repositories = paths; },
    baseline,
    selection: selectionOf,
    readCredential: async (filePath) => scope.read(preview.selection, { path: filePath, budget: new ReadBudget(4096) }),
  };
}

function kinds(status: { changes: readonly { kind: string }[] }): string[] {
  return status.changes.map((change) => change.kind);
}

test('6.1 报告冻结起始依据：源代际、映射、规划、范围指纹、逐条内容与 Git', async () => {
  const h = await harness();
  const detail = await h.service.get(h.reportId);
  assert.equal(detail.status, 'ok');
  if (detail.status !== 'ok') return;
  const basis = detail.report.basis;
  assert.ok(basis !== undefined);
  if (basis === undefined) return;
  assert.equal(basis.instanceId, INSTANCE_ID);
  assert.equal(basis.repositoryId, 'repo');
  assert.equal(basis.mappingHash, h.record.mappingHash);
  assert.equal(basis.sourceGeneration, 1);
  assert.equal(basis.planVersion, 'plan-v1');
  assert.equal(basis.fingerprint, h.record.observation.fingerprint);
  assert.deepEqual(basis.scope, { kind: 'root' });
  assert.equal(basis.entries.length, 2);
  assert.equal(basis.git?.head, h.record.observation.git?.head);
  assert.equal(detail.report.basisStatus?.state, 'current');
  assert.equal(detail.report.coverage.basis, 'current');

  const live = await h.service.evaluateBasis(h.reportId);
  assert.equal(live.status, 'ok');
  if (live.status === 'ok') {
    assert.equal(live.basis.state, 'current');
    assert.deepEqual(live.basis.changes, []);
    assert.equal(live.basis.git?.starting, basis.git?.head);
    assert.equal(live.basis.git?.current, basis.git?.head);
  }
  const list = await h.service.list();
  assert.equal(list[0]?.basisState, 'current');
});

test('6.1 逐条内容快照可分类比较；旧记录没有快照时只按指纹', () => {
  const diff = compareObservationContents(
    [{ path: 'a', kind: 'file', hash: 'h1' }, { path: 'b', kind: 'file', hash: 'h2' }, { path: 'c', kind: 'file', hash: 'h3' }],
    [
      { path: 'a', kind: 'file', bytes: 1, hash: 'h1' },
      { path: 'b', kind: 'file', bytes: 1, hash: 'h2x' },
      { path: 'd', kind: 'file', bytes: 1, hash: 'h4' },
    ],
    { currentComplete: true },
  );
  assert.deepEqual(diff, { added: ['d'], modified: ['b'], deleted: ['c'], uncomparable: [] });
  const truncated = compareObservationContents(
    [{ path: 'c', kind: 'file', hash: 'h3' }],
    [],
    { currentComplete: false },
  );
  assert.deepEqual(truncated.deleted, []);

  const legacy: AnalysisRecord = {
    analysisId: 'legacy', instanceId: INSTANCE_ID, repositoryId: 'repo', repositoryRoot: '/tmp/x',
    mappingHash: 'm', sourceGeneration: 1, scope: { kind: 'root' }, planVersion: 'p', planRevision: 1,
    observation: { fingerprint: 'f', complete: true, observedAt: 't', entries: 0, issues: 0 },
    requestId: 'r', sessionId: null, agentPreset: 'cona-project-analysis', status: 'completed', binding: null,
    createdAt: 't', updatedAt: 't',
  };
  const normalised = analysisRecordsOf([legacy]);
  assert.equal(normalised.length, 1);
  assert.equal(normalised[0]?.observation.contents, undefined);
  assert.deepEqual(basisSnapshotOf(normalised[0]!).entries, []);
});

test('6.2 同 HEAD 下修改／新增／删除与行号移动分别分类', async () => {
  const h = await harness();
  writeFile(h.repo, 'src/a.ts', 'one\nTWO\nthree\n');
  const modified = await h.service.evaluateBasis(h.reportId);
  assert.equal(modified.status, 'ok');
  if (modified.status === 'ok') {
    assert.equal(modified.basis.state, 'changed');
    assert.deepEqual(modified.basis.changes.find((change) => change.kind === 'files-modified')?.paths, ['src/a.ts']);
  }

  writeFile(h.repo, 'AAA.md', 'new\n');
  const added = await h.service.evaluateBasis(h.reportId);
  if (added.status === 'ok') {
    assert.equal(added.basis.state, 'changed');
    assert.deepEqual(added.basis.changes.find((change) => change.kind === 'files-added')?.paths, ['AAA.md']);
  }

  unlinkSync(path.join(h.repo, 'README.md'));
  const deleted = await h.service.evaluateBasis(h.reportId);
  if (deleted.status === 'ok') {
    assert.equal(deleted.basis.state, 'changed');
    assert.deepEqual(deleted.basis.changes.find((change) => change.kind === 'files-deleted')?.paths, ['README.md']);
  }

  writeFile(h.repo, 'README.md', '# readme\n');
  writeFile(h.repo, 'src/a.ts', 'zero\none\ntwo\nthree\n');
  const moved = await h.service.evaluateBasis(h.reportId);
  if (moved.status === 'ok') {
    assert.equal(moved.basis.state, 'changed');
    assert.equal(kinds(moved.basis).includes('files-modified'), true);
  }
  // 固定 HEAD：以上变化都未产生新提交。
  assert.equal(headOf(h.repo), h.record.observation.git?.head);
});

test('6.2 同路径删除后重建：内容一致保持当前，内容不同标已变', async () => {
  const h = await harness();
  unlinkSync(path.join(h.repo, 'src/a.ts'));
  writeFile(h.repo, 'src/a.ts', 'one\ntwo\nthree\n');
  const recreated = await h.service.evaluateBasis(h.reportId);
  assert.equal(recreated.status, 'ok');
  if (recreated.status === 'ok') {
    assert.equal(recreated.basis.state, 'current');
    assert.deepEqual(recreated.basis.changes, []);
  }

  unlinkSync(path.join(h.repo, 'src/a.ts'));
  writeFile(h.repo, 'src/a.ts', 'one\ntwo\nTHREE\n');
  const different = await h.service.evaluateBasis(h.reportId);
  if (different.status === 'ok') {
    assert.equal(different.basis.state, 'changed');
    assert.deepEqual(different.basis.changes.find((change) => change.kind === 'files-modified')?.paths, ['src/a.ts']);
  }
});

test('6.2 规划、映射、源代际与观察不可用的状态区分', async () => {
  const h = await harness();
  h.setPlanVersion('plan-v2');
  const plan = await h.service.evaluateBasis(h.reportId);
  if (plan.status === 'ok') {
    assert.equal(plan.basis.state, 'changed');
    assert.equal(kinds(plan.basis).includes('plan'), true);
  }
  h.setPlanVersion('plan-v1');

  h.setRepositories([]);
  const removed = await h.service.evaluateBasis(h.reportId);
  if (removed.status === 'ok') {
    assert.equal(removed.basis.state, 'changed');
    assert.equal(kinds(removed.basis).includes('mapping'), true);
  }
  h.setRepositories([h.repo]);

  const movedAway = path.join(h.localRoot, 'repo-moved-away');
  renameSync(h.repo, movedAway);
  const unavailable = await h.service.evaluateBasis(h.reportId);
  if (unavailable.status === 'ok') {
    assert.equal(unavailable.basis.state, 'uncheckable');
    assert.equal(kinds(unavailable.basis).includes('observation-gap'), true);
  }
  renameSync(movedAway, h.repo);

  const futureScope = new AnalysisScopeService({
    instanceId: INSTANCE_ID, sourceGeneration: 2,
    repositories: async () => [{ repositoryId: 'repo', absolutePath: h.repo }],
    files: h.files, sha256, clock,
  });
  const futureBasis = new AnalysisBasisService({ scope: futureScope, verification: h.verification, baseline: h.baseline, clock });
  const detail = await h.service.get(h.reportId);
  assert.equal(detail.status, 'ok');
  if (detail.status === 'ok') {
    const future = await futureBasis.evaluateReport(detail.report, h.record);
    assert.equal(future.state, 'changed');
    assert.equal(kinds(future).includes('source-generation'), true);
  }
});

test('6.2 已引用验证记录变化才影响依据；追加未引用记录保持当前', async () => {
  const h = await harness();
  h.addVerification('rec-2');
  const appended = await h.service.evaluateBasis(h.reportId);
  if (appended.status === 'ok') {
    assert.equal(appended.basis.state, 'current');
    assert.deepEqual(appended.basis.changes, []);
  }

  h.setVerificationHash('sha256:changed');
  const changed = await h.service.evaluateBasis(h.reportId);
  if (changed.status === 'ok') {
    assert.equal(changed.basis.state, 'changed');
    const verification = changed.basis.changes.find((change) => change.kind === 'verification');
    assert.deepEqual(verification?.recordIds, ['rec-1']);
  }
});

test('6.2 只改范围外路径保持当前；HEAD 变化只作附注', async () => {
  const h = await harness({ scope: { kind: 'directory', path: 'src' } });
  const startingHead = h.record.observation.git?.head;
  writeFile(h.repo, 'README.md', '# changed readme\n');
  git(h.repo, ['add', '.']);
  git(h.repo, ['commit', '--quiet', '-m', 'c2']);
  const currentHead = headOf(h.repo);
  assert.notEqual(currentHead, startingHead);

  const outside = await h.service.evaluateBasis(h.reportId);
  assert.equal(outside.status, 'ok');
  if (outside.status === 'ok') {
    assert.equal(outside.basis.state, 'current');
    assert.equal(outside.basis.git?.starting, startingHead);
    assert.equal(outside.basis.git?.current, currentHead);
  }

  writeFile(h.repo, 'src/a.ts', 'one\ntwo\nTHREE\n');
  const inside = await h.service.evaluateBasis(h.reportId);
  if (inside.status === 'ok') {
    assert.equal(inside.basis.state, 'changed');
    assert.deepEqual(inside.basis.changes.find((change) => change.kind === 'files-modified')?.paths, ['src/a.ts']);
  }
});

test('6.1 分析期间读到新内容后又改回：提交时按读取凭证标依据已变', async () => {
  const h = await harness({ save: false });
  const original = 'one\ntwo\nthree\n';
  writeFile(h.repo, 'src/a.ts', 'one\nTWO\nthree\n');
  const read = await h.readCredential('src/a.ts');
  assert.equal(read.status, 'ok');
  if (read.status !== 'ok') return;
  writeFile(h.repo, 'src/a.ts', original);

  const index = await h.verification.captureIndex();
  const verified = await h.verification.read(index.find((entry) => entry.recordId === 'rec-1')!, { budget: new ReadBudget(4096) });
  assert.equal(verified.status, 'ok');
  if (verified.status !== 'ok') return;
  const saved = await h.service.save({
    analysisId: h.record.analysisId, sessionId: 'session-1', requestId: 'save-after-revert',
    summary: '读后改回',
    facts: [{ text: '读取时的内容', files: [{ path: 'src/a.ts' }] }],
    inferences: [], suggestions: [],
    evidence: { files: [read.credential], verifications: [] },
  });
  assert.equal(saved.status, 'saved');
  if (saved.status !== 'saved') return;
  assert.equal(saved.report.coverage.basis, 'changed');
  assert.equal(saved.report.basisStatus?.state, 'changed');
  assert.deepEqual(
    saved.report.basisStatus?.changes.find((change) => change.kind === 'files-modified')?.paths,
    ['src/a.ts'],
  );
});

test('6.2 观察截断：只确认看到的变化，不判删除；无变化时 unable', async () => {
  const h = await harness();
  const limited = new AnalysisScopeService({
    instanceId: INSTANCE_ID, sourceGeneration: 1,
    repositories: async () => [{ repositoryId: 'repo', absolutePath: h.repo }],
    files: h.files, sha256, clock, limits: { scanEntries: 1 },
  });
  const limitedBasis = new AnalysisBasisService({ scope: limited, verification: h.verification, baseline: h.baseline, clock });
  const detail = await h.service.get(h.reportId);
  assert.equal(detail.status, 'ok');
  if (detail.status !== 'ok') return;
  const status = await limitedBasis.evaluateReport(detail.report, h.record);
  assert.equal(status.state, 'uncheckable');
  assert.equal(kinds(status).includes('observation-gap'), true);
  assert.equal(kinds(status).includes('files-deleted'), false);

  writeFile(h.repo, 'AAA.md', 'new\n');
  const withAddition = await limitedBasis.evaluateReport(detail.report, h.record);
  assert.equal(withAddition.state, 'changed');
  assert.equal(kinds(withAddition).includes('files-added'), true);
  assert.equal(kinds(withAddition).includes('observation-gap'), true);
});

test('6.1 报告持久化后旧记录仍可回读，依据快照不随回看改写', async () => {
  const h = await harness();
  const before = await h.service.evaluateBasis(h.reportId);
  assert.equal(before.status, 'ok');
  writeFile(h.repo, 'src/a.ts', 'one\ntwo\nthree\nfour\n');
  const after = await h.service.evaluateBasis(h.reportId);
  assert.equal(after.status, 'ok');
  const stored = await h.store.readAggregate(h.localRoot, INSTANCE_ID);
  assert.equal(analysisReportsOf(stored?.analysisReports).length, 1);
  assert.equal(analysisReportsOf(stored?.analysisReports)[0]?.basis?.fingerprint, h.record.observation.fingerprint);
  if (after.status === 'ok') assert.equal(after.basis.state, 'changed');
});
