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
import type { AnalysisExecutionPort, AnalysisSessionPort, DirectorySession } from '../src/application/ports.js';
import type { AnalysisRecord } from '../src/application/local-state.js';

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
  sessions: DirectorySession[] = [];
  promptCalls: Array<{ sessionId: string; requestId: string; text: string }> = [];
  promptError: Error | null = null;
  cancelCalls: string[] = [];
  cancelError: Error | null = null;

  async createAnalysisSession(input: { cwd: string; agentPreset: string }): Promise<{ sessionId: string; agentPreset?: string }> {
    this.calls.push(input);
    if (this.error !== null) throw this.error;
    const value = this.results.shift();
    return value ?? { sessionId: `session-analysis-${this.calls.length}`, agentPreset: input.agentPreset };
  }

  async listSessions(): Promise<readonly DirectorySession[]> {
    return this.sessions;
  }

  async promptFirstMessage(input: { sessionId: string; requestId: string; text: string }): Promise<{ accepted: true }> {
    this.promptCalls.push(input);
    if (this.promptError !== null) throw this.promptError;
    return { accepted: true };
  }

  async cancelSession(input: { sessionId: string }): Promise<{ accepted: true }> {
    this.cancelCalls.push(input.sessionId);
    if (this.cancelError !== null) throw this.cancelError;
    return { accepted: true };
  }
}

class FakeExecution implements AnalysisExecutionPort {
  ready = true;
  accepted: boolean | 'unknown' = false;
  prepareCalls = 0;

  async prepare(_record: AnalysisRecord): Promise<{ ready: true } | { ready: false; code: string; message: string }> {
    this.prepareCalls += 1;
    return this.ready ? { ready: true as const } : { ready: false as const, code: 'analysis-execution-unavailable', message: 'not ready' };
  }

  async promptAccepted(): Promise<boolean | 'unknown'> {
    return this.accepted;
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
  execution: FakeExecution;
  store: LocalStateStore;
  localRoot: string;
  repo: string;
}

function makeHarness(options?: {
  planVersion?: string | (() => Promise<{ ok: true; planVersion: string } | { ok: false; code: string; message: string }>);
  analyses?: unknown;
  hooks?: AnalysisSessionServiceDeps['hooks'];
  onTerminal?: AnalysisSessionServiceDeps['onTerminal'];
}): Harness {
  const localRoot = mkdtempSync(path.join(artifacts, 'analysis-session-'));
  const repo = path.join(localRoot, 'repo');
  writeFile(repo, 'src/a.ts', 'export const a = 1;\n');
  writeFile(repo, 'README.md', '# demo\n');
  writeAggregateFixture(localRoot, options?.analyses);
  const store = new LocalStateStore({ clock });
  const session = new FakeAnalysisSession();
  const execution = new FakeExecution();
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
    execution,
    clock,
    newAnalysisId: () => `analysis-${++counter}`,
    agentPreset: 'cona-project-analysis',
    ...(options?.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(options?.onTerminal === undefined ? {} : { onTerminal: options.onTerminal }),
  });
  return { service, scope, session, execution, store, localRoot, repo };
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

test('4.3 首消息：保护通过后用 operationId 作 rpcId 并落 running', async () => {
  const h = makeHarness();
  const started = await h.service.start({ operationId: 'op-send', repositoryId: 'repo', scope: { kind: 'directory', path: 'src' } });
  assert.equal(started.status, 'committed');
  if (started.status !== 'committed') return;
  const analysisId = started.value.analysis.analysisId;

  const sent = await h.service.sendFirstMessage(analysisId);
  assert.equal(sent.status, 'committed');
  if (sent.status !== 'committed') return;
  assert.equal(sent.value.sent, true);
  assert.equal(h.session.promptCalls.length, 1);
  assert.equal(h.session.promptCalls[0]?.requestId, 'op-send');
  assert.match(h.session.promptCalls[0]?.text ?? '', /src/);
  const record = (await h.service.get(analysisId));
  assert.equal(record.status, 'ok');
  if (record.status !== 'ok') return;
  assert.equal(record.analysis.status, 'running');
  assert.equal(record.analysis.binding?.protected, true);
  assert.equal(typeof record.analysis.sentAt, 'string');

  // 已 running：重复调用回读，不重复发送。
  const again = await h.service.sendFirstMessage(analysisId);
  assert.equal(again.status, 'committed');
  if (again.status === 'committed') assert.equal(again.value.reused, true);
  assert.equal(h.session.promptCalls.length, 1);
});

test('4.3 保护未就绪：不发送，记录保持 created', async () => {
  const h = makeHarness();
  h.execution.ready = false;
  const started = await h.service.start({ operationId: 'op-unprotected', repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(started.status, 'committed');
  if (started.status !== 'committed') return;
  const sent = await h.service.sendFirstMessage(started.value.analysis.analysisId);
  assert.equal(sent.status, 'rejected');
  if (sent.status === 'rejected') assert.equal(sent.code, 'analysis-execution-unavailable');
  assert.equal(h.session.promptCalls.length, 0);
  const record = await h.service.get(started.value.analysis.analysisId);
  assert.equal(record.status, 'ok');
  if (record.status === 'ok') assert.equal(record.analysis.status, 'created');
});

test('4.3 发送异常且查询未接受：unknown 不自动重发；显式 retry 复用同号', async () => {
  const h = makeHarness();
  const started = await h.service.start({ operationId: 'op-lost-send', repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(started.status, 'committed');
  if (started.status !== 'committed') return;
  const analysisId = started.value.analysis.analysisId;
  h.session.promptError = new Error('response lost');
  h.execution.accepted = false;

  const first = await h.service.sendFirstMessage(analysisId);
  assert.equal(first.status, 'rejected');
  if (first.status === 'rejected') assert.equal(first.code, 'analysis-send-unknown');
  assert.equal(h.session.promptCalls.length, 1);

  const automatic = await h.service.sendFirstMessage(analysisId);
  assert.equal(automatic.status, 'rejected');
  if (automatic.status === 'rejected') assert.equal(automatic.code, 'analysis-send-unconfirmed');
  assert.equal(h.session.promptCalls.length, 1, '未查清不自动重发');

  h.session.promptError = null;
  const retry = await h.service.sendFirstMessage(analysisId, { retry: true });
  assert.equal(retry.status, 'committed');
  assert.equal(h.session.promptCalls.length, 2);
  assert.equal(h.session.promptCalls[1]?.requestId, 'op-lost-send', '重试复用同一请求标识');
  const record = await h.service.get(analysisId);
  assert.equal(record.status, 'ok');
  if (record.status === 'ok') assert.equal(record.analysis.status, 'running');
});

test('4.3 发送异常但宿主已接受：核对回读为 running，不重发', async () => {
  const h = makeHarness();
  const started = await h.service.start({ operationId: 'op-recover', repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(started.status, 'committed');
  if (started.status !== 'committed') return;
  const analysisId = started.value.analysis.analysisId;
  h.session.promptError = new Error('response lost');
  h.execution.accepted = true;

  const sent = await h.service.sendFirstMessage(analysisId);
  assert.equal(sent.status, 'committed');
  if (sent.status === 'committed') assert.equal(sent.value.recovered, true);
  assert.equal(h.session.promptCalls.length, 1);
  const record = await h.service.get(analysisId);
  assert.equal(record.status, 'ok');
  if (record.status === 'ok') assert.equal(record.analysis.status, 'running');
});

test('4.3 启动未知核对：唯一候选收养，多候选需选择，无候选不猜', async () => {
  const h = makeHarness();
  h.session.error = new Error('create response lost');
  const lost = await h.service.start({ operationId: 'op-reconcile-create', repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(lost.status, 'rejected');
  const records = await h.service.list();
  const record = records[0];
  assert.ok(record !== undefined);
  if (record === undefined) return;
  const createdAt = Date.parse(record.createdAt);

  h.session.sessions = [
    { sessionId: 'cand-1', blank: true, running: false, updatedAt: createdAt + 1, cwd: record.repositoryRoot },
  ];
  const adopted = await h.service.reconcile(record.analysisId);
  assert.equal(adopted.status, 'adopted');
  if (adopted.status === 'adopted') assert.equal(adopted.analysis.sessionId, 'cand-1');

  const h2 = makeHarness();
  h2.session.error = new Error('create response lost');
  const lost2 = await h2.service.start({ operationId: 'op-reconcile-multi', repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(lost2.status, 'rejected');
  const record2 = (await h2.service.list())[0]!;
  const created2 = Date.parse(record2.createdAt);
  h2.session.sessions = [
    { sessionId: 'cand-a', blank: true, running: false, updatedAt: created2 + 1, cwd: record2.repositoryRoot },
    { sessionId: 'cand-b', blank: true, running: false, updatedAt: created2 + 2, cwd: record2.repositoryRoot },
  ];
  const choice = await h2.service.reconcile(record2.analysisId);
  assert.equal(choice.status, 'needs-choice');
  if (choice.status === 'needs-choice') assert.deepEqual(choice.candidates, ['cand-a', 'cand-b']);

  const h3 = makeHarness();
  h3.session.error = new Error('create response lost');
  await h3.service.start({ operationId: 'op-reconcile-none', repositoryId: 'repo', scope: { kind: 'root' } });
  const record3 = (await h3.service.list())[0]!;
  const none = await h3.service.reconcile(record3.analysisId);
  assert.equal(none.status, 'not-found');
  assert.equal(h3.session.calls.length, 1, '核对不自动再建 Session');
});

test('4.3 发送未知核对：已接受转 running，未接受退回 created', async () => {
  const h = makeHarness();
  const started = await h.service.start({ operationId: 'op-reconcile-send', repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(started.status, 'committed');
  if (started.status !== 'committed') return;
  const analysisId = started.value.analysis.analysisId;
  h.session.promptError = new Error('response lost');
  h.execution.accepted = false;
  await h.service.sendFirstMessage(analysisId);

  h.execution.accepted = true;
  const running = await h.service.reconcile(analysisId);
  assert.equal(running.status, 'running');
  const record = await h.service.get(analysisId);
  assert.equal(record.status, 'ok');
  if (record.status === 'ok') assert.equal(record.analysis.status, 'running');

  const h2 = makeHarness();
  const started2 = await h2.service.start({ operationId: 'op-reconcile-send-2', repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(started2.status, 'committed');
  if (started2.status !== 'committed') return;
  h2.session.promptError = new Error('response lost');
  h2.execution.accepted = false;
  await h2.service.sendFirstMessage(started2.value.analysis.analysisId);
  const rolled = await h2.service.reconcile(started2.value.analysis.analysisId);
  assert.equal(rolled.status, 'created');
  const record2 = await h2.service.get(started2.value.analysis.analysisId);
  assert.equal(record2.status, 'ok');
  if (record2.status === 'ok') assert.equal(record2.analysis.status, 'created');
});

test('4.3 终态或未持久化绑定时拒绝发送', async () => {
  const h = makeHarness();
  const started = await h.service.start({ operationId: 'op-terminal', repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(started.status, 'committed');
  if (started.status !== 'committed') return;
  const analysisId = started.value.analysis.analysisId;
  // 直接改写记录为终态，模拟宿主已结束。
  const aggregate = await h.store.readAggregate(h.localRoot, INSTANCE_ID);
  assert.ok(aggregate !== null);
  if (aggregate === null) return;
  const analyses = (aggregate.analyses ?? []).map((item) =>
    item.analysisId === analysisId ? { ...item, status: 'completed' as const } : item);
  await h.store.writeAggregate(h.localRoot, { ...aggregate, analyses });
  const denied = await h.service.sendFirstMessage(analysisId);
  assert.equal(denied.status, 'rejected');
  if (denied.status === 'rejected') assert.equal(denied.code, 'analysis-terminal');
  assert.equal(h.session.promptCalls.length, 0);
});

test('4.5 停止请求只落请求并交给宿主；真实终态前不再接受新提交', async () => {
  const h = makeHarness();
  const started = await h.service.start({ operationId: 'op-stop', repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(started.status, 'committed');
  if (started.status !== 'committed') return;
  const analysisId = started.value.analysis.analysisId;
  await h.service.sendFirstMessage(analysisId);

  const stopped = await h.service.stop(analysisId);
  assert.equal(stopped.status, 'committed');
  if (stopped.status !== 'committed') return;
  assert.equal(stopped.value.requested, true);
  assert.deepEqual(h.session.cancelCalls, [started.value.analysis.sessionId]);
  const record = await h.service.get(analysisId);
  assert.equal(record.status, 'ok');
  if (record.status === 'ok') {
    assert.equal(typeof record.analysis.stopRequestedAt, 'string');
    assert.equal(record.analysis.status, 'running', '停止请求不假装已结束');
  }

  const again = await h.service.stop(analysisId);
  assert.equal(again.status, 'committed');
  if (again.status === 'committed') assert.equal(again.value.requested, false);
  assert.equal(h.session.cancelCalls.length, 1);

  const denied = await h.service.sendFirstMessage(analysisId);
  assert.equal(denied.status, 'rejected');
  if (denied.status === 'rejected') assert.equal(denied.code, 'analysis-stopping');
});

test('4.5 turn/end 同步：完成记 completed，异常记 interrupted，终态释放绑定', async () => {
  const terminals: string[] = [];
  const h = makeHarness({ onTerminal: (record) => terminals.push(record.analysisId) });
  const started = await h.service.start({ operationId: 'op-end', repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(started.status, 'committed');
  if (started.status !== 'committed') return;
  const analysisId = started.value.analysis.analysisId;
  await h.service.sendFirstMessage(analysisId);

  const ended = await h.service.handleTurnEnd({ sessionId: started.value.analysis.sessionId!, kind: 'completed' });
  assert.equal(ended.status, 'terminal');
  if (ended.status === 'terminal') {
    assert.equal(ended.analysis.status, 'completed');
    assert.equal(ended.analysis.endReason, 'completed');
    assert.equal(ended.analysis.binding?.terminal, true);
    assert.equal(typeof ended.analysis.endedAt, 'string');
  }
  assert.deepEqual(terminals, [analysisId]);

  const repeat = await h.service.handleTurnEnd({ sessionId: started.value.analysis.sessionId!, kind: 'completed' });
  assert.equal(repeat.status, 'terminal');
  assert.equal(terminals.length, 1, '重复终态不再触发副作用');

  const denied = await h.service.sendFirstMessage(analysisId);
  assert.equal(denied.status, 'rejected');
  if (denied.status === 'rejected') assert.equal(denied.code, 'analysis-terminal');

  const h2 = makeHarness();
  const started2 = await h2.service.start({ operationId: 'op-end-err', repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(started2.status, 'committed');
  if (started2.status !== 'committed') return;
  const interrupted = await h2.service.handleTurnEnd({ sessionId: started2.value.analysis.sessionId!, kind: 'error' });
  assert.equal(interrupted.status, 'terminal');
  if (interrupted.status === 'terminal') {
    assert.equal(interrupted.analysis.status, 'interrupted');
    assert.equal(interrupted.analysis.endReason, 'error');
  }
});

test('4.5 停止后的 turn/end 记 stopped；未知 Session 忽略', async () => {
  const h = makeHarness();
  const started = await h.service.start({ operationId: 'op-stop-end', repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(started.status, 'committed');
  if (started.status !== 'committed') return;
  await h.service.stop(started.value.analysis.analysisId);
  const ended = await h.service.handleTurnEnd({ sessionId: started.value.analysis.sessionId!, kind: 'aborted' });
  assert.equal(ended.status, 'terminal');
  if (ended.status === 'terminal') {
    assert.equal(ended.analysis.status, 'interrupted');
    assert.equal(ended.analysis.endReason, 'stopped');
  }
  assert.deepEqual(await h.service.handleTurnEnd({ sessionId: 'session-unknown', kind: 'completed' }), { status: 'ignored' });
});


test('4.6 恢复：有 Session 的未终态记录转中断并标历史，无 Session 的草稿保留', async () => {
  const h = makeHarness();
  const started = await h.service.start({ operationId: 'op-recover-1', repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(started.status, 'committed');
  if (started.status !== 'committed') return;
  const analysisId = started.value.analysis.analysisId;
  await h.service.sendFirstMessage(analysisId);

  // 手工插入一条没有 Session 的 prepared 草稿。
  const aggregate = await h.store.readAggregate(h.localRoot, INSTANCE_ID);
  assert.ok(aggregate !== null);
  if (aggregate === null) return;
  const draft: AnalysisRecord = {
    ...started.value.analysis,
    analysisId: 'analysis-draft',
    requestId: 'op-draft',
    sessionId: null,
    status: 'prepared',
  };
  await h.store.writeAggregate(h.localRoot, { ...aggregate, analyses: [...(aggregate.analyses ?? []), draft] });

  const terminals: string[] = [];
  const recovered = new AnalysisSessionService({
    localRoot: h.localRoot,
    instanceId: INSTANCE_ID,
    store: h.store,
    queue: new InstanceCommandQueue(),
    scope: h.scope,
    planBaseline: async () => ({ ok: true, planVersion: 'plan-v1' }),
    session: new FakeAnalysisSession(),
    execution: new FakeExecution(),
    clock,
    newAnalysisId: () => 'analysis-next',
    agentPreset: 'cona-project-analysis',
    onTerminal: (record) => terminals.push(record.analysisId),
  });
  const result = await recovered.recover();
  assert.deepEqual(result, { interrupted: 1, historical: 1 });
  assert.deepEqual(terminals, [analysisId]);

  const interrupted = await recovered.get(analysisId);
  assert.equal(interrupted.status, 'ok');
  if (interrupted.status === 'ok') {
    assert.equal(interrupted.analysis.status, 'interrupted');
    assert.equal(interrupted.analysis.endReason, 'aborted');
    assert.equal(interrupted.analysis.binding?.terminal, true);
  }
  const keptDraft = await recovered.get('analysis-draft');
  assert.equal(keptDraft.status, 'ok');
  if (keptDraft.status === 'ok') assert.equal(keptDraft.analysis.status, 'prepared');

  // 已终态记录只标历史，不再重复中断。
  await recovered.handleTurnEnd({ sessionId: started.value.analysis.sessionId!, kind: 'completed' });
  const again = await recovered.recover();
  assert.deepEqual(again, { interrupted: 0, historical: 1 });
});
