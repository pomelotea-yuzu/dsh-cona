// 工作意图、消息准入映射与活动 WorkRun 测试（tasks 6.2）。
// 覆盖（依据 2.4 映射结论构造事件序列）：排队消息不覆盖当前目标、浏览 B 不改变 A、
// 同轮归属不唯一拒绝绑定、agent 缺失拒绝新绑定、无 invocation 但绑定有效按有限范围准入（2.4b(i)）、
// 绑定版本推进与旧捕获拒绝、私有授权不随公开资料导入、显式停止与真实终态、重启失效。
// 临时目录放在包内 artifacts/（仓库门禁禁止 os.tmpdir 与机器绝对路径）。

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProjectCommandService,
  type CommandEnvelope,
  type TrustedContext,
} from '../src/application/command-service.js';
import { InstanceCommandQueue } from '../src/application/command-queue.js';
import { LocalStateService } from '../src/application/local-state.js';
import { workStateOf, type InstanceAggregate, type WorkAction, type WorkIntent, type WorkRunRecord } from '../src/application/local-state.js';
import { WorkService } from '../src/application/work.js';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { createSourceFiles } from '../src/adapters/fs/source-files.js';
import { resolveLocalRoot, rootRelation } from '../src/adapters/fs/local-root.js';
import { inspectPrivateRoot } from '../src/adapters/fs/git-guard.js';
import type { PlanNodeViewPort } from '../src/application/ports.js';
import type { Sha256Fn } from '../src/domain/types.js';
import type { LocalStateStorePort } from '../src/application/ports.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sample = path.join(packageRoot, 'formats', 'v1', 'sample-project.json');
const formatsDir = path.join(packageRoot, 'formats', 'v1');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');
const INSTANCE_ID = '22222222-2222-4222-8222-222222222222';
const NODE_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const NODE_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const ROOT_NODE = '00000000-0000-4000-8000-000000000002';
const BOOT = 1730000000000;
const BASELINE = { planVersion: 'pv-test-1', planRevision: 0, sourceEpoch: 1 };

function clock(): string {
  return new Date().toISOString();
}

const PLAN_NODES: PlanNodeViewPort = {
  async currentNodeIds() {
    return { ok: true as const, nodeIds: new Set([NODE_A, NODE_B, ROOT_NODE]) };
  },
};

/** 聚合夹具：lastObservation 与 startWork 的基线核对一致（revision 0 / epoch 1 / pv-test-1）。 */
function writeAggregateFixture(
  localRoot: string,
  extra?: { intents?: WorkIntent[]; runs?: WorkRunRecord[]; lastObservation?: unknown },
): void {
  const dir = path.join(localRoot, 'instances', INSTANCE_ID);
  mkdirSync(dir, { recursive: true });
  const aggregate = {
    schemaVersion: 1,
    instanceId: INSTANCE_ID,
    projectId: '00000000-0000-4000-8000-000000000001',
    source: { root: '/tmp/unused', kind: 'custom', generation: 1 },
    revisions: { plan: 0, state: 0 },
    conversations: { links: [], intents: [] },
    workIntents: extra?.intents ?? [],
    workRuns: extra?.runs ?? [],
    operations: [],
    lastObservation: extra?.lastObservation ?? {
      planVersion: BASELINE.planVersion,
      headHash: 'deadbeef',
      records: [],
      observedAt: clock(),
    },
  };
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify(aggregate, null, 2) + '\n');
}

interface WorkHarness {
  service: WorkService;
  store: LocalStateStore;
  localRoot: string;
  queue: InstanceCommandQueue;
}

function makeWorkService(options?: {
  store?: LocalStateStore;
  localRoot?: string;
  bootGeneration?: number;
  planNodes?: PlanNodeViewPort;
  queue?: InstanceCommandQueue;
}): WorkHarness {
  const store = options?.store ?? new LocalStateStore({ clock });
  const localRoot = options?.localRoot ?? mkdtempSync(path.join(artifacts, 'work-'));
  mkdirSync(localRoot, { recursive: true });
  if (options?.store === undefined) writeAggregateFixture(localRoot);
  const queue = options?.queue ?? new InstanceCommandQueue();
  const service = new WorkService({
    localRoot,
    instanceId: INSTANCE_ID,
    store,
    planNodes: options?.planNodes ?? PLAN_NODES,
    clock,
    newWorkRunId: () => `run-${randomUUID()}`,
    newSuggestionId: () => `sug-${randomUUID()}`,
    bootGeneration: options?.bootGeneration ?? BOOT,
    queue,
  });
  return { service, store, localRoot, queue };
}

async function readWork(store: LocalStateStore, localRoot: string): Promise<{ intents: WorkIntent[]; runs: WorkRunRecord[] }> {
  const aggregate = await store.readAggregate(localRoot, INSTANCE_ID);
  assert.ok(aggregate !== null);
  return workStateOf(aggregate);
}

async function prepareAndStart(
  service: WorkService,
  overrides?: { rpcId?: string; nodeIds?: string[]; actions?: WorkAction[] },
): Promise<{ workIntentId: string; rpcId: string }> {
  const workIntentId = `intent-${randomUUID()}`;
  const rpcId = overrides?.rpcId ?? `rpc-${randomUUID()}`;
  const prepared = await service.prepareWork({
    workIntentId,
    nodeIds: overrides?.nodeIds ?? [NODE_A],
    allowedActions: overrides?.actions ?? ['update', 'add', 'split', 'record', 'status', 'dependencies'],
    reasonScope: 'local',
    purpose: '围绕 A 调整',
    baseline: BASELINE,
  });
  assert.equal(prepared.status, 'committed');
  const started = await service.startWork({ workIntentId, rpcId, sessionId: 'session-w' });
  assert.equal(started.status, 'committed');
  return { workIntentId, rpcId };
}

// ---------- 意图登记与确认 ----------

test('6.2 prepareWork：意图落盘 pending；startWork 确认后 awaiting-message 并登记期望 rpcId', async () => {
  const { service, store, localRoot } = makeWorkService();
  const prepared = await service.prepareWork({
    workIntentId: 'intent-1',
    nodeIds: [NODE_A],
    allowedActions: ['update', 'add'],
    reasonScope: 'local',
    purpose: '围绕 A 调整',
    baseline: BASELINE,
  });
  assert.equal(prepared.status, 'committed');
  if (prepared.status !== 'committed') return;
  assert.equal(prepared.value.reused, false);
  let work = await readWork(store, localRoot);
  assert.equal(work.intents[0]?.status, 'pending');
  assert.equal(work.intents[0]?.expectedRpcId, undefined);

  const started = await service.startWork({ workIntentId: 'intent-1', rpcId: 'rpc-1', sessionId: 'session-w' });
  assert.equal(started.status, 'committed');
  work = await readWork(store, localRoot);
  assert.equal(work.intents[0]?.status, 'awaiting-message');
  assert.equal(work.intents[0]?.expectedRpcId, 'rpc-1');
  assert.equal(work.runs.length, 0, '确认只等消息消费，不启动运行');

  const again = await service.prepareWork({
    workIntentId: 'intent-1',
    nodeIds: [NODE_A],
    allowedActions: ['update', 'add'],
    reasonScope: 'local',
    purpose: '围绕 A 调整',
    baseline: BASELINE,
  });
  assert.equal(again.status, 'committed');
  if (again.status !== 'committed') return;
  assert.equal(again.value.reused, true, '同范围重复登记幂等');
  const conflict = await service.prepareWork({
    workIntentId: 'intent-1',
    nodeIds: [NODE_B],
    allowedActions: ['update'],
    reasonScope: 'local',
    purpose: '改范围',
    baseline: BASELINE,
  });
  assert.equal(conflict.status, 'rejected');
  assert.equal((conflict as { code?: string }).code, 'operation-mismatch');
});

test('6.2 startWork 基线过期拒绝：意图基线与本机已知基线不一致时不确认范围', async () => {
  const { service } = makeWorkService();
  await service.prepareWork({
    workIntentId: 'intent-stale',
    nodeIds: [NODE_A],
    allowedActions: ['update'],
    reasonScope: 'local',
    purpose: '围绕 A',
    baseline: { planVersion: 'pv-old', planRevision: 7, sourceEpoch: 3 },
  });
  const started = await service.startWork({ workIntentId: 'intent-stale', rpcId: 'rpc-x' });
  assert.equal(started.status, 'rejected');
  assert.equal((started as { code?: string }).code, 'baseline-stale');
});

test('6.2 未知节点拒绝登记；准备范围不含当前资料的节点', async () => {
  const { service } = makeWorkService();
  const outcome = await service.prepareWork({
    workIntentId: 'intent-ghost',
    nodeIds: ['ghost-node'],
    allowedActions: ['update'],
    reasonScope: 'local',
    purpose: '越界',
    baseline: BASELINE,
  });
  assert.equal(outcome.status, 'rejected');
  assert.equal((outcome as { code?: string }).code, 'unknown-node');
});

// ---------- 消息准入映射 ----------

test('6.2 消费匹配启动 WorkRun：身份键＝(bootGeneration, sessionId, turn)，绑定版本 1，基线取意图', async () => {
  const { service, store, localRoot } = makeWorkService();
  const { rpcId } = await prepareAndStart(service);
  const admission = await service.observeConsumed({ sessionId: 'session-w', rpcId, turn: 3, agentPresent: true });
  assert.equal(admission.status, 'started');
  if (admission.status !== 'started') return;
  assert.equal(admission.sessionId, 'session-w');
  assert.equal(admission.turn, 3);
  assert.equal(admission.bindingVersion, 1);
  const work = await readWork(store, localRoot);
  assert.equal(work.runs.length, 1);
  const run = work.runs[0] as WorkRunRecord;
  assert.equal(run.bootGeneration, BOOT);
  assert.equal(run.status, 'active');
  assert.deepEqual(run.acceptedBaseline, BASELINE);
  assert.deepEqual(run.targets, [NODE_A]);
  assert.equal(work.intents[0]?.status, 'active');
  assert.equal(run.rpcId, rpcId);
});

test('6.2 排队消息不覆盖当前目标：A 活动时 B 的消息入队只登记，A 绑定与 B 意图都不变', async () => {
  const { service, store, localRoot } = makeWorkService();
  const a = await prepareAndStart(service, { rpcId: 'rpc-a' });
  await service.observeConsumed({ sessionId: 'session-w', rpcId: a.rpcId, turn: 1, agentPresent: true });
  const b = await prepareAndStart(service, { rpcId: 'rpc-b', nodeIds: [NODE_B] });

  // B 的请求排队（2.4：target=next-turn，未消费）——只登记，不改绑定、不改状态。
  const queued = await service.observeQueued({ sessionId: 'session-w', rpcId: 'rpc-b' });
  assert.equal(queued.status, 'queued');
  if (queued.status !== 'queued') return;
  assert.equal(queued.matched, 1);
  let work = await readWork(store, localRoot);
  const runA = work.runs[0] as WorkRunRecord;
  assert.equal(runA.targets.join(','), NODE_A, 'A 的绑定目标不变');
  assert.equal(runA.bindingVersion, 1);
  assert.equal(runA.turn, 1);
  const intentB = work.intents.find((intent) => intent.workIntentId === b.workIntentId) as WorkIntent;
  assert.equal(intentB.status, 'awaiting-message', 'B 保留为待执行意图');
  assert.ok(intentB.queuedAt !== undefined, '排队事实已登记');

  // A 的工具调用仍只对应 A：A 目标通过，B 目标拒绝。
  const capture = await service.captureBinding('session-w');
  assert.ok(capture.ok);
  if (!capture.ok) return;
  const admittedA = await service.authorizeAgentCommand(
    { kind: 'agent-work', workRunId: capture.capture.workRunId, bindingVersion: 1, instanceId: INSTANCE_ID },
    { instanceId: INSTANCE_ID, sourceEpoch: 1, expectedPlanVersion: BASELINE.planVersion, expectedPlanRevision: 0, command: { type: 'update-node', nodeId: NODE_A, patch: { title: 'A 内修改' } } },
  );
  assert.deepEqual(admittedA, { ok: true });
  const rejectedB = await service.authorizeAgentCommand(
    { kind: 'agent-work', workRunId: capture.capture.workRunId, bindingVersion: 1, instanceId: INSTANCE_ID },
    { instanceId: INSTANCE_ID, sourceEpoch: 1, expectedPlanVersion: BASELINE.planVersion, expectedPlanRevision: 0, command: { type: 'update-node', nodeId: NODE_B, patch: { title: '越界改 B' } } },
  );
  assert.equal(rejectedB.ok, false);
  if (!rejectedB.ok) assert.equal(rejectedB.code, 'forbidden');
  void store; void localRoot;
});

test('6.2 浏览 B 不改变 A：活动运行绑定 A；对 B 的写请求拒绝、无浏览入口改变绑定', async () => {
  const { service, store, localRoot } = makeWorkService();
  const { rpcId } = await prepareAndStart(service, { rpcId: 'rpc-a', nodeIds: [NODE_A] });
  await service.observeConsumed({ sessionId: 'session-w', rpcId, turn: 1, agentPresent: true });
  const before = await service.listWork();
  assert.equal(before.status, 'committed');

  // 「浏览」= 面板选中 B：工作状态没有任何写路径会被浏览触发。
  // 结构断言：没有 API 能从 NODE_B 改变 A 的运行；再次列表逐字节一致。
  const after = await service.listWork();
  assert.ok(after.status === 'committed' && before.status === 'committed');
  const snap = (): string =>
    JSON.stringify(before.status === 'committed' && after.status === 'committed'
      ? { runs: after.value.runs, intents: after.value.intents }
      : null);
  const snapBefore = (): string =>
    JSON.stringify(before.status === 'committed'
      ? { runs: before.value.runs, intents: before.value.intents }
      : null);
  assert.equal(snap(), snapBefore());

  // 同一聊天还关联 B 也不授予写资格：B 目标越界。
  const capture = await service.captureBinding('session-w');
  assert.ok(capture.ok);
  if (!capture.ok) return;
  assert.deepEqual(capture.capture.targets, [NODE_A]);
  const rejected = await service.authorizeAgentCommand(
    { kind: 'agent-work', workRunId: capture.capture.workRunId, bindingVersion: capture.capture.bindingVersion, instanceId: INSTANCE_ID },
    { instanceId: INSTANCE_ID, sourceEpoch: 1, expectedPlanVersion: BASELINE.planVersion, expectedPlanRevision: 0, command: { type: 'set-node-status', nodeId: NODE_B, status: 'done' } },
  );
  assert.equal(rejected.ok, false);
  void store; void localRoot;
});

test('6.2 同轮归属不唯一（同 rpcId 多意图）：拒绝绑定并记 blocked，不产生运行', async () => {
  const { service, store, localRoot } = makeWorkService();
  await service.prepareWork({
    workIntentId: 'intent-x1',
    nodeIds: [NODE_A],
    allowedActions: ['update'],
    reasonScope: 'local',
    purpose: '意图一',
    baseline: BASELINE,
  });
  await service.prepareWork({
    workIntentId: 'intent-x2',
    nodeIds: [NODE_B],
    allowedActions: ['update'],
    reasonScope: 'local',
    purpose: '意图二（同 rpcId，归属歧义）',
    baseline: BASELINE,
  });
  await service.startWork({ workIntentId: 'intent-x1', rpcId: 'rpc-dup' });
  await service.startWork({ workIntentId: 'intent-x2', rpcId: 'rpc-dup' });

  const admission = await service.observeConsumed({ sessionId: 'session-w', rpcId: 'rpc-dup', turn: 1, agentPresent: true });
  assert.equal(admission.status, 'blocked');
  if (admission.status !== 'blocked') return;
  assert.equal(admission.reason, 'ambiguous-intent');
  assert.equal(admission.workIntentIds.length, 2);
  const work = await readWork(store, localRoot);
  assert.equal(work.runs.length, 0, '归属不唯一不建立绑定');
  for (const intent of work.intents) {
    assert.equal(intent.status, 'blocked');
    assert.ok(intent.blockedReason?.includes('归属不唯一'));
  }
});

test('6.2 同会话已有活动绑定时另一消息消费：意图保留待执行（deferred），不建立第二个绑定', async () => {
  const { service, store, localRoot } = makeWorkService();
  const a = await prepareAndStart(service, { rpcId: 'rpc-a' });
  await service.observeConsumed({ sessionId: 'session-w', rpcId: a.rpcId, turn: 1, agentPresent: true });
  const b = await prepareAndStart(service, { rpcId: 'rpc-b', nodeIds: [NODE_B] });

  // steer／同轮输入（2.4：target=next-step，同 turn 消费）不能覆盖当前绑定。
  const admission = await service.observeConsumed({ sessionId: 'session-w', rpcId: 'rpc-b', turn: 1, agentPresent: true });
  assert.equal(admission.status, 'deferred');
  if (admission.status !== 'deferred') return;
  assert.equal(admission.reason, 'session-busy');
  const work = await readWork(store, localRoot);
  assert.equal(work.runs.length, 1, '只有一个生效绑定');
  const intentB = work.intents.find((intent) => intent.workIntentId === b.workIntentId) as WorkIntent;
  assert.equal(intentB.status, 'awaiting-message', 'B 保留待执行，直到可信边界显式建立新绑定');
});

test('6.2 agent 缺失拒绝新绑定（2.4b i）：消费事件无 Agent 归属记 blocked；captureBinding(null) 拒绝', async () => {
  const { service, store, localRoot } = makeWorkService();
  const { rpcId } = await prepareAndStart(service, { rpcId: 'rpc-noagent' });
  const admission = await service.observeConsumed({ sessionId: 'session-w', rpcId, turn: 1, agentPresent: false });
  assert.equal(admission.status, 'blocked');
  if (admission.status !== 'blocked') return;
  assert.equal(admission.reason, 'agent-missing');
  const work = await readWork(store, localRoot);
  assert.equal(work.runs.length, 0, '不建立绑定');
  assert.equal(work.intents[0]?.status, 'blocked');
  assert.ok(work.intents[0]?.blockedReason?.includes('agent 缺失'));

  const capture = await service.captureBinding(null);
  assert.equal(capture.ok, false);
  if (!capture.ok) assert.equal(capture.code, 'agent-missing');
});

test('6.2 无 invocation 但绑定有效按有限范围准入（2.4b i）：真实会话捕获后范围内通过、范围外拒绝', async () => {
  const { service } = makeWorkService();
  const { rpcId } = await prepareAndStart(service, { rpcId: 'rpc-ok', nodeIds: [NODE_A, NODE_B], actions: ['update', 'record'] });
  await service.observeConsumed({ sessionId: 'session-w', rpcId, turn: 2, agentPresent: true });

  // 工具上下文没有 invocation 是正常情况：按会话捕获绑定并核对有限范围。
  const capture = await service.captureBinding('session-w');
  assert.ok(capture.ok);
  if (!capture.ok) return;
  assert.equal(capture.capture.turn, 2);
  const ctx = { kind: 'agent-work' as const, workRunId: capture.capture.workRunId, bindingVersion: capture.capture.bindingVersion, instanceId: INSTANCE_ID };
  const inScope = await service.authorizeAgentCommand(ctx, {
    instanceId: INSTANCE_ID, sourceEpoch: 1, expectedPlanVersion: BASELINE.planVersion, expectedPlanRevision: 0,
    command: { type: 'update-node', nodeId: NODE_B, patch: { goal: '范围内' } },
  });
  assert.deepEqual(inScope, { ok: true });

  const wrongAction = await service.authorizeAgentCommand(ctx, {
    instanceId: INSTANCE_ID, sourceEpoch: 1, expectedPlanVersion: BASELINE.planVersion, expectedPlanRevision: 0,
    command: { type: 'set-dependencies', dependencies: [{ nodeId: NODE_A, requiresNodeId: NODE_B }] },
  });
  assert.equal(wrongAction.ok, false);
  if (!wrongAction.ok) assert.equal(wrongAction.code, 'forbidden');

  const noBinding = await service.captureBinding('session-other');
  assert.equal(noBinding.ok, false);
  if (!noBinding.ok) assert.equal(noBinding.code, 'binding-expired', '无绑定会话不因缺 invocation 授权');
});

test('6.2 绑定版本推进与旧捕获拒绝：本运行规划提交成功后 +1，旧版本迟到调用拒绝', async () => {
  const { service, store, localRoot } = makeWorkService();
  const { rpcId } = await prepareAndStart(service, { rpcId: 'rpc-bump', nodeIds: [NODE_A], actions: ['update'] });
  await service.observeConsumed({ sessionId: 'session-w', rpcId, turn: 1, agentPresent: true });
  const capture = await service.captureBinding('session-w');
  assert.ok(capture.ok);
  if (!capture.ok) return;
  const ctx = { kind: 'agent-work' as const, workRunId: capture.capture.workRunId, bindingVersion: 1, instanceId: INSTANCE_ID };

  await service.afterPlanCommit(ctx, { planVersion: 'pv-test-2', planRevision: 1, sourceEpoch: 1 });
  const work = await readWork(store, localRoot);
  const run = work.runs[0] as WorkRunRecord;
  assert.equal(run.bindingVersion, 2);
  assert.deepEqual(run.acceptedBaseline, { planVersion: 'pv-test-2', planRevision: 1, sourceEpoch: 1 });
  assert.deepEqual(run.targets, [NODE_A], '范围不自动扩大');

  // 旧捕获（版本 1 / 旧基线）的迟到调用被拒绝。
  const stale = await service.authorizeAgentCommand(ctx, {
    instanceId: INSTANCE_ID, sourceEpoch: 1, expectedPlanVersion: 'pv-test-2', expectedPlanRevision: 1,
    command: { type: 'update-node', nodeId: NODE_A, patch: { title: '迟到' } },
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, 'binding-expired');

  // 新可信执行边界取得新版本后通过（基线也必须用最新）。
  const fresh = await service.captureBinding('session-w');
  assert.ok(fresh.ok);
  if (!fresh.ok) return;
  assert.equal(fresh.capture.bindingVersion, 2);
  const okNew = await service.authorizeAgentCommand(
    { kind: 'agent-work', workRunId: fresh.capture.workRunId, bindingVersion: fresh.capture.bindingVersion, instanceId: INSTANCE_ID },
    { instanceId: INSTANCE_ID, sourceEpoch: 1, expectedPlanVersion: 'pv-test-2', expectedPlanRevision: 1, command: { type: 'update-node', nodeId: NODE_A, patch: { title: '接续' } } },
  );
  assert.deepEqual(okNew, { ok: true });

  // 外部基线漂移：命令基线与已接受基线不一致 → 拒绝，不沿用旧授权。
  const drift = await service.authorizeAgentCommand(
    { kind: 'agent-work', workRunId: fresh.capture.workRunId, bindingVersion: fresh.capture.bindingVersion, instanceId: INSTANCE_ID },
    { instanceId: INSTANCE_ID, sourceEpoch: 2, expectedPlanVersion: 'pv-test-2', expectedPlanRevision: 1, command: { type: 'update-node', nodeId: NODE_A, patch: { title: '外部' } } },
  );
  assert.equal(drift.ok, false);
  if (!drift.ok) assert.equal(drift.code, 'binding-expired');
});

test('6.2 私有授权不随公开资料导入：新实例无意图无运行；旧形状聚合归一化为空授权', async () => {
  // 外部 v1 资料接入新实例：聚合是全新空授权（导入路径不复制任何私有授权）。
  const base = mkdtempSync(path.join(artifacts, 'work-import-'));
  const localRoot = path.join(base, 'local');
  const source = path.join(base, 'source');
  mkdirSync(source, { recursive: true });
  copyFileSync(sample, path.join(source, 'project.json'));
  const store = new LocalStateStore();
  const localState = new LocalStateService({
    resolver: { resolveLocal: resolveLocalRoot, relation: rootRelation },
    git: { inspect: inspectPrivateRoot },
    store,
    clock,
    newInstanceId: () => INSTANCE_ID,
  });
  const registered = await localState.register({ localDataRoot: localRoot, sourceRoot: source, sourceKind: 'custom', projectId: '00000000-0000-4000-8000-000000000001' });
  assert.ok(registered.ok);
  if (!registered.ok) return;
  const aggregate = await store.readAggregate(localRoot, INSTANCE_ID);
  assert.ok(aggregate !== null);
  const work = workStateOf(aggregate);
  assert.equal(work.intents.length, 0, '导入公开资料不带来任何工作意图');
  assert.equal(work.runs.length, 0, '导入公开资料不带来任何运行或写资格');

  // 公开资料头（sample project.json）不含任何私有授权字段。
  const head = JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(head['work'], undefined);
  assert.equal(head['workRuns'], undefined);
  assert.equal(head['workIntents'], undefined);

  // 旧形状聚合（workRuns 占位、无 workIntents／workSuggestions）读取归一化为空授权，不冒充历史绑定。
  const legacy = { workRuns: [] as unknown[], workIntents: undefined, workSuggestions: undefined } as unknown as Pick<InstanceAggregate, 'workIntents' | 'workRuns' | 'workSuggestions'>;
  assert.deepEqual(workStateOf(legacy), { intents: [], runs: [], suggestions: [] });

  // 空授权实例上 agent-work 调用一律拒绝。
  const harness = makeWorkService({ store, localRoot, bootGeneration: BOOT });
  const capture = await harness.service.captureBinding('session-w');
  assert.equal(capture.ok, false);
  if (!capture.ok) assert.equal(capture.code, 'binding-expired');
});

test('6.2 显式停止与真实终态：stopWork 立即停止写准入；turn/end 后意图进入终态', async () => {
  const { service, store, localRoot } = makeWorkService();
  const { rpcId } = await prepareAndStart(service, { rpcId: 'rpc-stop' });
  const started = await service.observeConsumed({ sessionId: 'session-w', rpcId, turn: 1, agentPresent: true });
  assert.equal(started.status, 'started');
  if (started.status !== 'started') return;

  const stopped = await service.stopWork(started.workRunId);
  assert.equal(stopped.status, 'committed');
  if (stopped.status !== 'committed') return;
  assert.equal(stopped.value.stopped, true);
  let capture = await service.captureBinding('session-w');
  assert.equal(capture.ok, false, '停止后无生效绑定');
  let work = await readWork(store, localRoot);
  assert.equal(work.runs[0]?.status, 'stopped');
  assert.equal(work.runs[0]?.endKind, 'stopped');
  assert.equal(work.intents[0]?.status, 'stopped');

  // 真实终态观测（2.4：turn/end completed）。
  const { rpcId: rpc2 } = await prepareAndStart(service, { rpcId: 'rpc-end' });
  const again = await service.observeConsumed({ sessionId: 'session-w', rpcId: rpc2, turn: 2, agentPresent: true });
  assert.equal(again.status, 'started');
  const ended = await service.observeTurnEnd({ sessionId: 'session-w', turn: 2, kind: 'completed' });
  assert.equal(ended.status, 'ended');
  work = await readWork(store, localRoot);
  assert.equal(work.runs[1]?.status, 'ended');
  assert.equal(work.runs[1]?.endKind, 'completed');
  assert.equal(work.intents[1]?.status, 'completed');
  capture = await service.captureBinding('session-w');
  assert.equal(capture.ok, false);
  void localRoot;
});

test('6.2 重启失效：新代际服务下旧运行不再有写资格，重启不恢复授权', async () => {
  const { service, store, localRoot, queue } = makeWorkService();
  const { rpcId } = await prepareAndStart(service, { rpcId: 'rpc-reboot' });
  await service.observeConsumed({ sessionId: 'session-w', rpcId, turn: 1, agentPresent: true });

  // 宿主重启：新进程 bootGeneration 不同。
  const rebooted = makeWorkService({ store, localRoot, bootGeneration: BOOT + 1, queue }).service;
  const capture = await rebooted.captureBinding('session-w');
  assert.equal(capture.ok, false);
  if (!capture.ok) assert.equal(capture.code, 'binding-expired');

  const view = await rebooted.listWork();
  assert.equal(view.status, 'committed');
  if (view.status !== 'committed') return;
  assert.equal(view.value.runs[0]?.effective, false, '旧代际运行标注失效');
  assert.equal(view.value.runs[0]?.status, 'active', '历史记录保留（重启只恢复历史）');

  // 新代际也不复活：意图已 active，startWork 拒绝，需要新的真实请求边界。
  const restart = await rebooted.startWork({ workIntentId: (await readWork(store, localRoot)).intents[0]?.workIntentId ?? '', rpcId: 'rpc-new' });
  assert.equal(restart.status, 'rejected');
});

// ---------- 命令服务集成（work 准入 + 提交后 bump） ----------

interface FullFixture {
  base: string;
  localRoot: string;
  source: string;
  instanceId: string;
  command: ProjectCommandService;
  work: WorkService;
  store: LocalStateStore;
  planVersion: () => string;
  envelope: (command: import('../src/application/command-service.js').Command, overrides?: Partial<CommandEnvelope>) => CommandEnvelope;
}

async function setupFull(name: string): Promise<FullFixture> {
  const base = mkdtempSync(path.join(artifacts, name));
  const localRoot = path.join(base, 'local');
  const source = path.join(base, 'source');
  mkdirSync(source, { recursive: true });
  copyFileSync(sample, path.join(source, 'project.json'));

  const store = new LocalStateStore();
  const files = createSourceFiles(formatsDir, sha256);
  const localState = new LocalStateService({
    resolver: { resolveLocal: resolveLocalRoot, relation: rootRelation },
    git: { inspect: inspectPrivateRoot },
    store,
    clock,
    newInstanceId: () => randomUUID(),
  });
  const registered = await localState.register({ localDataRoot: localRoot, sourceRoot: source, sourceKind: 'custom', projectId: '00000000-0000-4000-8000-000000000001' });
  assert.ok(registered.ok);
  if (!registered.ok) throw new Error('register failed');

  const queue = new InstanceCommandQueue();
  const planNodes: PlanNodeViewPort = {
    async currentNodeIds() {
      const doc = JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as { plan?: { nodes?: Array<{ id: string }> } };
      return { ok: true as const, nodeIds: new Set((doc.plan?.nodes ?? []).map((node) => node.id)) };
    },
  };
  const work = new WorkService({
    localRoot,
    instanceId: registered.entry.instanceId,
    store,
    planNodes,
    clock,
    newWorkRunId: () => `run-${randomUUID()}`,
    newSuggestionId: () => `sug-${randomUUID()}`,
    bootGeneration: BOOT,
    queue,
  });
  const command = new ProjectCommandService({
    localRoot,
    store,
    files,
    sha256,
    clock,
    newNodeId: () => randomUUID(),
    newRecordId: () => randomUUID(),
    queue,
    work,
  });
  const planVersion = (): string =>
    (JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as { planVersion: string }).planVersion;
  const instanceId = registered.entry.instanceId;
  const envelope = (cmd: import('../src/application/command-service.js').Command, overrides: Partial<CommandEnvelope> = {}): CommandEnvelope => ({
    operationId: randomUUID(),
    projectId: '00000000-0000-4000-8000-000000000001',
    instanceId,
    sourceEpoch: registered.entry.sourceGeneration,
    expectedPlanVersion: planVersion(),
    expectedPlanRevision: 0,
    command: cmd,
    ...overrides,
  });
  return { base, localRoot, source, instanceId, command, work, store, planVersion, envelope };
}

test('6.2 命令服务集成：agent-work 有限范围准入、范围外拒绝、提交后绑定版本推进、旧捕获拒绝', async () => {
  const fx = await setupFull('work-cmd-');
  const rootBaseline = { planVersion: fx.planVersion(), planRevision: 0, sourceEpoch: 1 };
  const prepared = await fx.work.prepareWork({
    workIntentId: 'intent-cmd',
    nodeIds: [ROOT_NODE],
    allowedActions: ['update'],
    reasonScope: 'local',
    purpose: '围绕根节点调整',
    baseline: rootBaseline,
  });
  assert.equal(prepared.status, 'committed');
  const started = await fx.work.startWork({ workIntentId: 'intent-cmd', rpcId: 'rpc-cmd', sessionId: 'session-cmd' });
  assert.equal(started.status, 'committed');
  const admission = await fx.work.observeConsumed({ sessionId: 'session-cmd', rpcId: 'rpc-cmd', turn: 1, agentPresent: true });
  assert.equal(admission.status, 'started');
  if (admission.status !== 'started') return;

  // 工具捕获（无 invocation 正常）：越界目标（子节点不在范围内）拒绝。
  const capture = await fx.work.captureBinding('session-cmd');
  assert.ok(capture.ok);
  if (!capture.ok) return;
  const ctx: TrustedContext = { kind: 'agent-work', workRunId: capture.capture.workRunId, bindingVersion: capture.capture.bindingVersion, instanceId: fx.instanceId };
  const childNode = '00000000-0000-4000-8000-000000000003';
  const outside = await fx.command.execute(ctx, fx.envelope({ type: 'update-node', nodeId: childNode, patch: { title: '越界' } }));
  assert.equal(outside.status, 'rejected');
  assert.equal((outside as { code?: string }).code, 'forbidden');

  // 范围内提交成功；提交后绑定版本 +1、已接受基线推进（真实命令路径）。
  const inScope = await fx.command.execute(ctx, fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { title: '范围内修改' } }));
  assert.equal(inScope.status, 'committed', JSON.stringify(inScope));
  const view = await fx.work.listWork();
  assert.equal(view.status, 'committed');
  if (view.status !== 'committed') return;
  assert.equal(view.value.runs[0]?.bindingVersion, 2, '规划提交成功后绑定版本推进');
  assert.equal(view.value.runs[0]?.acceptedBaseline.planRevision, 1);
  assert.equal(view.value.runs[0]?.acceptedBaseline.planVersion, fx.planVersion());

  // 旧捕获（版本 1）的迟到调用被拒绝；新捕获 + 新基线可继续。
  const stale = await fx.command.execute(ctx, fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { title: '迟到' } }));
  assert.equal(stale.status, 'rejected');
  assert.equal((stale as { code?: string }).code, 'binding-expired');
  const fresh = await fx.work.captureBinding('session-cmd');
  assert.ok(fresh.ok);
  if (!fresh.ok) return;
  assert.equal(fresh.capture.bindingVersion, 2);
  const continued = await fx.command.execute(
    { kind: 'agent-work', workRunId: fresh.capture.workRunId, bindingVersion: fresh.capture.bindingVersion, instanceId: fx.instanceId },
    fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '接续修改' } }, { expectedPlanRevision: 1 }),
  );
  assert.equal(continued.status, 'committed', JSON.stringify(continued));

  // remote-owner 路径不走工作绑定：owner 直接提交仍按原有 owner 准入（两条入口判据独立）。
  const owner = await fx.command.execute({ kind: 'remote-owner' }, fx.envelope({ type: 'update-node', nodeId: childNode, patch: { title: 'owner 修改' } }, { expectedPlanRevision: 2 }));
  assert.equal(owner.status, 'committed', JSON.stringify(owner));
});
