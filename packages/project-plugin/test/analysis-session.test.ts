// 分析 Session 生命周期测试（tasks 4.1-4.2）。
// 覆盖：记录先落盘、旧聚合无 analyses 字段可读、同 operationId 幂等、
// 专用 preset 创建（不复用空白会话）、预览/规划过期拒绝、宿主结果未知保留中间态、
// 关联未落盘不返回可发送状态、preset 不符拒绝、隔离实例拒绝。
// 临时目录放在包内 artifacts/。

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { createAnalysisFiles } from '../src/adapters/fs/analysis-files.js';
import { InstanceCommandQueue } from '../src/application/command-queue.js';
import { AnalysisScopeService } from '../src/application/analysis-scope.js';
import { AnalysisSessionService, analysisSelectionOf, type AnalysisSessionServiceDeps } from '../src/application/analysis-session.js';
import { analysisRecordsOf, type InstanceAggregate } from '../src/application/local-state.js';
import type { AnalysisSessionPort, DirectorySession } from '../src/application/ports.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const clock = (): string => '2026-11-28T00:00:00.000Z';

class FakeAnalysisSession implements AnalysisSessionPort {
  calls: Array<{ cwd: string; agentPreset: string }> = [];
  results: Array<{ sessionId: string; agentPreset?: string }> = [];
  error: Error | null = null;

  async createAnalysisSession(input: { cwd: string; agentPreset: string }): Promise<{ sessionId: string; agentPreset?: string }> {
    this.calls.push(input);
    if (this.error !== null) throw this.error;
    const value = this.results.shift();
    return value ?? { sessionId: `session-analysis-${this.calls.length}`, agentPreset: input.agentPreset };
  }

  async listSessions(): Promise<readonly DirectorySession[]> {
    return [];
  }
}

function writeFile(root: string, relativePath: string, content: string): void {
  const absolute = path.join(root, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function writeAggregateFixture(localRoot: string, analyses?: unknown): void {
  const dir = path.join(localRoot, 'instances', INSTANCE_ID);
  mkdirSync(dir, { recursive: true });
  const aggregate: Record<string, unknown> = {
    schemaVersion: 1,
    instanceId: INSTANCE_ID,
    projectId: '00000000-0000-4000-8000-000000000001',
    source: { root: '/tmp/unused', kind: 'custom', generation: 1 },
    revisions: { plan: 3, state: 1 },
    conversations: { links: [], intents: [] },
    workIntents: [],
    workSuggestions: [],
    workRuns: [],
    operations: [],
    lastObservation: null,
    repositoryMaps: [],
  };
  if (analyses !== undefined) aggregate['analyses'] = analyses;
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify(aggregate, null, 2) + '\n');
}

interface Harness {
  service: AnalysisSessionService;
  scope: AnalysisScopeService;
  session: FakeAnalysisSession;
  store: LocalStateStore;
  localRoot: string;
  repo: string;
}

function makeHarness(options?: {
  planVersion?: string | (() => Promise<{ ok: true; planVersion: string } | { ok: false; code: string; message: string }>);
  analyses?: unknown;
  hooks?: AnalysisSessionServiceDeps['hooks'];
}): Harness {
  const localRoot = mkdtempSync(path.join(artifacts, 'analysis-session-'));
  const repo = path.join(localRoot, 'repo');
  writeFile(repo, 'src/a.ts', 'export const a = 1;\n');
  writeFile(repo, 'README.md', '# demo\n');
  writeAggregateFixture(localRoot, options?.analyses);
  const store = new LocalStateStore({ clock });
  const session = new FakeAnalysisSession();
  const scope = new AnalysisScopeService({
    instanceId: INSTANCE_ID,
    sourceGeneration: 1,
    repositories: async () => [{ repositoryId: 'repo', absolutePath: repo, updatedAt: '2026-11-28T00:00:00.000Z' }],
    files: createAnalysisFiles({ sha256, env: { GIT_CEILING_DIRECTORIES: artifacts } }),
    sha256,
    clock,
  });
  let counter = 0;
  const planVersion = options?.planVersion;
  const planBaseline = typeof planVersion === 'function'
    ? planVersion
    : async () => ({ ok: true as const, planVersion: planVersion ?? 'plan-v1' });
  const service = new AnalysisSessionService({
    localRoot,
    instanceId: INSTANCE_ID,
    store,
    queue: new InstanceCommandQueue(),
    scope,
    planBaseline,
    session,
    clock,
    newAnalysisId: () => `analysis-${++counter}`,
    agentPreset: 'cona-project-analysis',
    ...(options?.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  return { service, scope, session, store, localRoot, repo };
}

test('4.1 记录先落盘、旧聚合无 analyses 可读、首次保存推进状态修订', async () => {
  const h = makeHarness();
  // 旧聚合（无 analyses 字段）读为空，不因缺字段拒绝。
  assert.deepEqual(await h.service.list(), []);
  assert.equal((await h.service.get('missing')).status, 'rejected');

  const started = await h.service.start({ operationId: 'op-1', repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(started.status, 'committed');
  if (started.status !== 'committed') return;
  assert.equal(started.value.reused, false);
  const record = started.value.analysis;
  assert.equal(record.status, 'created');
  assert.equal(record.sessionId, 'session-analysis-1');
  assert.equal(record.agentPreset, 'cona-project-analysis');
  assert.equal(record.planVersion, 'plan-v1');
  assert.equal(record.planRevision, 3);
  assert.equal(record.binding?.persisted, true);
  assert.equal(record.binding?.protected, false);
  assert.equal(started.stateRevision, 4, 'prepared/creating/created 三次落盘');

  const reread = await h.store.readAggregate(h.localRoot, INSTANCE_ID);
  assert.equal(analysisRecordsOf(reread?.analyses).length, 1);
  assert.equal(reread?.revisions.state, 4);
  assert.equal(analysisSelectionOf(record).repositoryRoot, record.repositoryRoot);
});

test('4.1 同一 operationId 幂等：只建一个 Session，重复确认回到原记录', async () => {
  const h = makeHarness();
  const first = await h.service.start({ operationId: 'op-same', repositoryId: 'repo', scope: { kind: 'root' } });
  const second = await h.service.start({ operationId: 'op-same', repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(first.status, 'committed');
  assert.equal(second.status, 'committed');
  if (first.status !== 'committed' || second.status !== 'committed') return;
  assert.equal(second.value.reused, true);
  assert.equal(second.value.analysis.analysisId, first.value.analysis.analysisId);
  assert.equal(h.session.calls.length, 1);
});

test('4.2 用专用 preset 创建：不传空白会话、cwd 为冻结仓库根', async () => {
  const h = makeHarness();
  const started = await h.service.start({ operationId: 'op-create', repositoryId: 'repo', scope: { kind: 'directory', path: 'src' } });
  assert.equal(started.status, 'committed');
  if (started.status !== 'committed') return;
  assert.equal(h.session.calls.length, 1);
  assert.equal(h.session.calls[0]?.agentPreset, 'cona-project-analysis');
  assert.equal(h.session.calls[0]?.cwd, started.value.analysis.repositoryRoot);
  assert.equal(started.value.analysis.scope.kind, 'directory');
  assert.equal(h.session.calls[0]?.cwd, path.join(h.repo));
});

test('4.2 预览或规划过期：拒绝且不建记录、不建 Session', async () => {
  const h = makeHarness();
  const preview = await h.scope.preview({ repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(preview.status, 'ok');
  if (preview.status !== 'ok') return;
  writeFile(h.repo, 'src/a.ts', 'export const a = 2;\n');

  const stale = await h.service.start({
    operationId: 'op-stale', repositoryId: 'repo', scope: { kind: 'root' }, expectedFingerprint: preview.fingerprint,
  });
  assert.equal(stale.status, 'rejected');
  if (stale.status === 'rejected') assert.equal(stale.code, 'analysis-preview-stale');

  const plan = await h.service.start({
    operationId: 'op-plan', repositoryId: 'repo', scope: { kind: 'root' }, expectedPlanVersion: 'plan-old',
  });
  assert.equal(plan.status, 'rejected');
  if (plan.status === 'rejected') assert.equal(plan.code, 'analysis-plan-changed');

  assert.equal(h.session.calls.length, 0);
  assert.deepEqual(await h.service.list(), []);
});

test('4.2 宿主创建结果未知：保留中间态，不重试、不返回可发送状态', async () => {
  const h = makeHarness();
  h.session.error = new Error('response lost');
  const first = await h.service.start({ operationId: 'op-lost', repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(first.status, 'rejected');
  if (first.status === 'rejected') assert.equal(first.code, 'analysis-session-create-unknown');

  const records = await h.service.list();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.status, 'unknown');
  assert.equal(records[0]?.sessionId, null);

  const retry = await h.service.start({ operationId: 'op-lost', repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(retry.status, 'committed');
  if (retry.status === 'committed') assert.equal(retry.value.reused, true);
  assert.equal(h.session.calls.length, 1, '不自动再建第二个 Session');
});

test('4.2 关联未落盘：Session 已建但不返回可发送状态', async () => {
  let writes = 0;
  const h = makeHarness({
    hooks: {
      beforeAggregateReplace: {
        beforeTempWrite: () => {
          writes += 1;
          if (writes === 3) throw new Error('association write failed');
        },
      },
    },
  });
  const started = await h.service.start({ operationId: 'op-assoc', repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(started.status, 'rejected');
  if (started.status === 'rejected') assert.equal(started.code, 'analysis-association-unknown');
  assert.equal(h.session.calls.length, 1);
  const records = await h.service.list();
  assert.equal(records[0]?.status, 'creating');
  assert.equal(records[0]?.sessionId, null);
});

test('4.2 preset 不符与隔离实例：拒绝且不继续', async () => {
  const mismatch = makeHarness();
  mismatch.session.results.push({ sessionId: 'session-wrong', agentPreset: 'standard' });
  const wrong = await mismatch.service.start({ operationId: 'op-preset', repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(wrong.status, 'rejected');
  if (wrong.status === 'rejected') assert.equal(wrong.code, 'analysis-preset-mismatch');
  const failed = await mismatch.service.list();
  assert.equal(failed[0]?.status, 'failed');

  const quarantined = makeHarness();
  await quarantined.store.quarantine(quarantined.localRoot, {
    schemaVersion: 1,
    instanceId: INSTANCE_ID,
    reason: 'unknown-state',
    stage: 'probe',
    createdAt: clock(),
    requires: 'offline-review',
  });
  const denied = await quarantined.service.start({ operationId: 'op-q', repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(denied.status, 'rejected');
  if (denied.status === 'rejected') assert.equal(denied.code, 'unknown-state');
  assert.equal(quarantined.session.calls.length, 0);
});

test('4.1 analyses 损坏条目读取归一化：坏项被跳过，不影响其它记录', () => {
  const good = {
    analysisId: 'a-good', instanceId: INSTANCE_ID, repositoryId: 'repo', repositoryRoot: '/repo',
    mappingHash: 'hash', sourceGeneration: 1, scope: { kind: 'root' }, planVersion: 'v', planRevision: 0,
    observation: { fingerprint: 'f', complete: true, observedAt: 'now', entries: 0, issues: 0 },
    requestId: 'req', sessionId: null, agentPreset: 'cona-project-analysis', status: 'prepared',
    binding: null, createdAt: 'now', updatedAt: 'now',
  };
  const records = analysisRecordsOf([good, null, { analysisId: 'bad' }, { ...good, analysisId: 'a-bad-status', status: 'nope' }]);
  assert.deepEqual(records.map((record) => record.analysisId), ['a-good']);
  const aggregate: Pick<InstanceAggregate, 'analyses'> = { analyses: undefined };
  assert.deepEqual(analysisRecordsOf(aggregate.analyses), []);
});
