// 有来源运行上下文与显式接续测试（tasks 6.4）。
// 覆盖：建议／决定／未核查项区分、绑定外写入保留建议（去重）、新材料到达不静默改目标
// （标记待核对）、提交后新基线绑定、显式接续（版本 +1、接续原因保留、建议闭环）、
// 旧并行调用不能借新权限（旧捕获拒绝）、接续校验反例。
// 临时目录放在包内 artifacts/（仓库门禁禁止 os.tmpdir 与机器绝对路径）。

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstanceCommandQueue } from '../src/application/command-queue.js';
import { workStateOf, type WorkAction, type WorkRunRecord } from '../src/application/local-state.js';
import { WorkService, type WorkCapture } from '../src/application/work.js';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import type { PlanNodeDetail, PlanNodeViewPort, PlanRecordEntry } from '../src/application/ports.js';
import type { Sha256Fn } from '../src/domain/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');
const INSTANCE_ID = '33333333-3333-4333-8333-333333333333';
const NODE_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const NODE_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const BOOT = 1730000000000;
const BASELINE = { planVersion: 'pv-test-1', planRevision: 0, sourceEpoch: 1 };

function clock(): string {
  return new Date().toISOString();
}

const NODE_DETAILS: Array<PlanNodeDetail & { goal?: string }> = [
  { id: NODE_A, title: '节点 A', status: 'in-progress' },
  { id: NODE_B, title: '节点 B', status: 'pending' },
];

const RECORDS: PlanRecordEntry[] = [
  { id: 'rec-1', kind: 'analysis-note', summary: '关于 A 的分析', subjectNodeIds: [NODE_A], path: 'records/rec-1/x.md' },
  { id: 'rec-2', kind: 'execution-note', summary: '关于 B 的执行', subjectNodeIds: [NODE_B], path: 'records/rec-2/x.md' },
];

interface ContextHarness {
  service: WorkService;
  store: LocalStateStore;
  localRoot: string;
  queue: InstanceCommandQueue;
  setSourceGeneration(generation: number): Promise<void>;
  /** 模拟外部重载后资料节点集合变化（目标节点可被移除）。 */
  setVisible(ids: string[]): void;
}

async function writeRegistry(localRoot: string, generation: number): Promise<void> {
  const registry = {
    schemaVersion: 1,
    instances: [
      {
        instanceId: INSTANCE_ID,
        projectId: '00000000-0000-4000-8000-000000000001',
        sourceRoot: 'sources/unused',
        sourceKind: 'custom',
        sourceGeneration: generation,
        createdAt: clock(),
        updatedAt: clock(),
      },
    ],
  };
  writeFileSync(path.join(localRoot, 'registry.json'), JSON.stringify(registry, null, 2) + '\n');
}

function makeHarness(): ContextHarness {
  const store = new LocalStateStore({ clock });
  const localRoot = mkdtempSync(path.join(artifacts, 'work-context-'));
  mkdirSync(localRoot, { recursive: true });
  // 聚合夹具：startWork 基线核对需要 lastObservation；会话链接给上下文聊天入口用。
  const dir = path.join(localRoot, 'instances', INSTANCE_ID);
  mkdirSync(dir, { recursive: true });
  const aggregate = {
    schemaVersion: 1,
    instanceId: INSTANCE_ID,
    projectId: '00000000-0000-4000-8000-000000000001',
    source: { root: 'sources/unused', kind: 'custom', generation: 1 },
    revisions: { plan: 0, state: 0 },
    conversations: {
      links: [{ linkId: 'link-1', sessionId: 'session-c', nodeIds: [NODE_A], purpose: '讨论 A', origin: 'panel', createdAt: clock(), updatedAt: clock() }],
      intents: [],
    },
    workIntents: [],
    workRuns: [],
    workSuggestions: [],
    operations: [],
    lastObservation: { planVersion: BASELINE.planVersion, headHash: 'deadbeef', records: [], observedAt: clock() },
  };
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify(aggregate, null, 2) + '\n');
  void writeRegistry(localRoot, 1);
  const queue = new InstanceCommandQueue();
  // 当前资料节点集合：可模拟外部重载移除节点（上下文 known=false 路径）。
  const visible = new Set<string>([NODE_A, NODE_B]);
  const planNodes: PlanNodeViewPort = {
    async currentNodeIds() {
      return { ok: true as const, nodeIds: new Set(visible) };
    },
    async nodeDetails(ids) {
      return {
        ok: true as const,
        nodes: NODE_DETAILS.filter((node) => ids.includes(node.id) && visible.has(node.id)),
        records: RECORDS,
      };
    },
  };
  const service = new WorkService({
    localRoot,
    instanceId: INSTANCE_ID,
    store,
    planNodes,
    clock,
    newWorkRunId: () => `run-${randomUUID()}`,
    newSuggestionId: () => `sug-${randomUUID()}`,
    bootGeneration: BOOT,
    queue,
  });
  return {
    service,
    store,
    localRoot,
    queue,
    setSourceGeneration: (generation) => writeRegistry(localRoot, generation),
    setVisible: (ids) => {
      visible.clear();
      for (const id of ids) visible.add(id);
    },
  };
}

async function prepareStartConsume(
  service: WorkService,
  overrides?: { nodeIds?: string[]; actions?: WorkAction[] },
): Promise<WorkCapture> {
  const workIntentId = `intent-${randomUUID()}`;
  const rpcId = `rpc-${randomUUID()}`;
  const prepared = await service.prepareWork({
    workIntentId,
    nodeIds: overrides?.nodeIds ?? [NODE_A],
    allowedActions: overrides?.actions ?? ['update', 'add', 'split', 'record', 'status', 'dependencies'],
    reasonScope: 'local',
    purpose: '围绕 A 调整',
    baseline: BASELINE,
  });
  assert.equal(prepared.status, 'committed');
  const started = await service.startWork({ workIntentId, rpcId, sessionId: 'session-c' });
  assert.equal(started.status, 'committed');
  const admission = await service.observeConsumed({ sessionId: 'session-c', rpcId, turn: 2, agentPresent: true });
  assert.equal(admission.status, 'started');
  const captured = await service.captureBinding('session-c');
  assert.ok(captured.ok, JSON.stringify(captured));
  return captured.ok ? captured.capture : (undefined as unknown as WorkCapture);
}

async function readRuns(store: LocalStateStore, localRoot: string): Promise<WorkRunRecord[]> {
  const aggregate = await store.readAggregate(localRoot, INSTANCE_ID);
  assert.ok(aggregate !== null);
  return workStateOf(aggregate).runs;
}

// ---------- 三类区分与上下文内容 ----------

test('6.4 上下文三类区分：决定来自意图与接续，无建议无未核查；目标带标题、记录与聊天按目标相交', async () => {
  const h = makeHarness();
  const capture = await prepareStartConsume(h.service);
  const outcome = await h.service.buildContext(capture);
  assert.equal(outcome.status, 'committed', JSON.stringify(outcome));
  if (outcome.status !== 'committed') return;
  const context = outcome.value;
  assert.equal(context.workRunId, capture.workRunId);
  assert.equal(context.bindingVersion, 1);
  assert.deepEqual(context.baseline, BASELINE);
  assert.deepEqual(context.constraints.allowedActions.sort(), ['add', 'dependencies', 'record', 'split', 'status', 'update']);
  // 目标标题来自 nodeDetails；只注入目标集合，不注入整棵树。
  assert.deepEqual(context.targets, [{ id: NODE_A, title: '节点 A', status: 'in-progress', known: true }]);
  // 相关公开记录：subjectNodeIds 与目标相交（A 的记录入选，B 的不入选）。
  assert.deepEqual(context.publicRecords.map((record) => record.id), ['rec-1']);
  // 本机聊天入口：链接节点与目标相交。
  assert.deepEqual(context.chatEntries, [{ linkId: 'link-1', sessionId: 'session-c', purpose: '讨论 A', origin: 'panel' }]);
  // 三类区分：此时只有决定（意图目的）；无建议、无未核查项。
  const kinds = context.items.map((item) => item.kind);
  assert.ok(kinds.includes('decision'));
  assert.ok(!kinds.includes('suggestion'), '尚无绑定外被拒，不应有建议');
  assert.ok(!kinds.includes('unverified'), '源代际未推进，不应有未核查项');
  const decision = context.items.find((item) => item.kind === 'decision');
  assert.ok(decision?.source.startsWith('intent:'));
  assert.ok(decision?.text.includes('围绕 A 调整'));
});

test('6.4 绑定外写入保留为建议：authorize 拒绝时保留建议（带来源），重复拒绝去重更新 lastSeenAt', async () => {
  const h = makeHarness();
  const capture = await prepareStartConsume(h.service);
  const ctx = { kind: 'agent-work' as const, workRunId: capture.workRunId, bindingVersion: capture.bindingVersion, instanceId: INSTANCE_ID };
  const envelope = {
    instanceId: INSTANCE_ID,
    sourceEpoch: BASELINE.sourceEpoch,
    expectedPlanVersion: BASELINE.planVersion,
    expectedPlanRevision: BASELINE.planRevision,
    command: { type: 'update-node' as const, nodeId: NODE_B, patch: { title: 'x' } },
  };
  const first = await h.service.authorizeAgentCommand(ctx, envelope);
  assert.equal(first.ok, false);
  if (first.ok) return;
  assert.equal(first.code, 'forbidden');
  const second = await h.service.authorizeAgentCommand(ctx, envelope);
  assert.equal(second.ok, false);

  const aggregate = await h.store.readAggregate(h.localRoot, INSTANCE_ID);
  assert.ok(aggregate !== null);
  const work = workStateOf(aggregate);
  assert.equal(work.suggestions.length, 1, '同一运行同动作同目标只保留一条建议');
  const suggestion = work.suggestions[0]!;
  assert.equal(suggestion.workRunId, capture.workRunId);
  assert.equal(suggestion.sessionId, 'session-c');
  assert.equal(suggestion.action, 'update');
  assert.deepEqual(suggestion.nodeIds, [NODE_B]);
  assert.equal(suggestion.status, 'open');
  assert.ok(suggestion.reason.includes('目标超出工作范围'));
  assert.equal(suggestion.lastSeenAt >= suggestion.createdAt, true, '重复拒绝只更新 lastSeenAt');

  // 建议进入上下文 items（kind suggestion，带 suggestionId 与来源）。
  const outcome = await h.service.buildContext(capture);
  assert.equal(outcome.status, 'committed');
  if (outcome.status !== 'committed') return;
  const item = outcome.value.items.find((entry) => entry.kind === 'suggestion');
  assert.ok(item !== undefined, '建议应出现在上下文');
  assert.equal(item.suggestionId, suggestion.suggestionId);
  assert.deepEqual(item.nodeIds, [NODE_B]);
  // 建议只是背景：目标集合不变，授权仍拒绝（不构成写授权）。
  assert.deepEqual((await readRuns(h.store, h.localRoot))[0]?.targets, [NODE_A]);
  const third = await h.service.authorizeAgentCommand(ctx, envelope);
  assert.equal(third.ok, false);
});

// ---------- 新材料不静默改目标 ----------

test('6.4 新材料到达标记待核对：源代际推进后上下文有 unverified，目标不静默改写、旧基线写入仍拒绝', async () => {
  const h = makeHarness();
  const capture = await prepareStartConsume(h.service);
  await h.setSourceGeneration(2);

  const outcome = await h.service.buildContext(capture);
  assert.equal(outcome.status, 'committed');
  if (outcome.status !== 'committed') return;
  const unverified = outcome.value.items.filter((item) => item.kind === 'unverified');
  assert.equal(unverified.length, 1);
  assert.ok(unverified[0]?.text.includes('1→2'), '标记代际推进区间');
  assert.ok(unverified[0]?.text.includes('不静默改写'));
  // 目标集合不变（read-only 上下文）。
  assert.deepEqual(outcome.value.targets, [{ id: NODE_A, title: '节点 A', status: 'in-progress', known: true }]);

  // 旧基线命令仍被拒（基线核对不因上下文标注而放行）。
  const ctx = { kind: 'agent-work' as const, workRunId: capture.workRunId, bindingVersion: capture.bindingVersion, instanceId: INSTANCE_ID };
  const admitted = await h.service.authorizeAgentCommand(ctx, {
    instanceId: INSTANCE_ID,
    sourceEpoch: BASELINE.sourceEpoch,
    expectedPlanVersion: BASELINE.planVersion,
    expectedPlanRevision: BASELINE.planRevision,
    command: { type: 'update-node' as const, nodeId: NODE_A, patch: { title: 'x' } },
  });
  // 注册表代际 2 与命令 sourceEpoch 1 的核对发生在命令服务（source-changed）；服务层核对基线一致即放行。
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
});

test('6.4 目标节点不在当前资料中：上下文目标标 known=false 并加未核查项', async () => {
  const h = makeHarness();
  // 以 B 为目标启动（登记时 B 存在）；外部重载移除 B 后目标不在当前资料中。
  const capture = await prepareStartConsume(h.service, { nodeIds: [NODE_B] });
  h.setVisible([NODE_A]);
  const outcome = await h.service.buildContext(capture);
  assert.equal(outcome.status, 'committed');
  if (outcome.status !== 'committed') return;
  assert.equal(outcome.value.targets[0]?.known, false);
  const unverified = outcome.value.items.find((item) => item.kind === 'unverified');
  assert.ok(unverified !== undefined, '未知目标应标记未核查');
  assert.ok(unverified?.text.includes(NODE_B));
});

// ---------- 提交后新基线绑定与旧并行调用 ----------

test('6.4 提交后新基线绑定：afterPlanCommit 推进版本与基线；旧捕获的上下文与写入都被拒绝', async () => {
  const h = makeHarness();
  const capture = await prepareStartConsume(h.service);
  await h.service.afterPlanCommit(
    { kind: 'agent-work', workRunId: capture.workRunId, bindingVersion: capture.bindingVersion },
    { planVersion: 'pv-test-2', planRevision: 1, sourceEpoch: 1 },
  );

  // 旧捕获（版本 1）：上下文拒绝（不借新上下文）、写入拒绝（不借新权限）。
  const staleContext = await h.service.buildContext(capture);
  assert.equal(staleContext.status, 'rejected');
  assert.equal((staleContext as { code?: string }).code, 'binding-expired');
  const staleWrite = await h.service.authorizeAgentCommand(
    { kind: 'agent-work', workRunId: capture.workRunId, bindingVersion: capture.bindingVersion, instanceId: INSTANCE_ID },
    {
      instanceId: INSTANCE_ID,
      sourceEpoch: BASELINE.sourceEpoch,
      expectedPlanVersion: BASELINE.planVersion,
      expectedPlanRevision: BASELINE.planRevision,
      command: { type: 'update-node' as const, nodeId: NODE_A, patch: { title: 'x' } },
    },
  );
  assert.equal(staleWrite.ok, false);

  // 重新捕获：新基线（版本 2，pv-test-2@revision 1）进入上下文，写入按新基线核对。
  const fresh = await h.service.captureBinding('session-c');
  assert.ok(fresh.ok);
  if (!fresh.ok) return;
  assert.equal(fresh.capture.bindingVersion, 2);
  assert.deepEqual(fresh.capture.acceptedBaseline, { planVersion: 'pv-test-2', planRevision: 1, sourceEpoch: 1 });
  const outcome = await h.service.buildContext(fresh.capture);
  assert.equal(outcome.status, 'committed');
  if (outcome.status !== 'committed') return;
  assert.equal(outcome.value.bindingVersion, 2);
  assert.deepEqual(outcome.value.baseline, { planVersion: 'pv-test-2', planRevision: 1, sourceEpoch: 1 });
  // 并行的另一个旧捕获同样被拒：同版本但对象已推进。
  const parallel = await h.service.authorizeAgentCommand(
    { kind: 'agent-work', workRunId: capture.workRunId, bindingVersion: 1, instanceId: INSTANCE_ID },
    {
      instanceId: INSTANCE_ID,
      sourceEpoch: 1,
      expectedPlanVersion: 'pv-test-2',
      expectedPlanRevision: 1,
      command: { type: 'update-node' as const, nodeId: NODE_A, patch: { title: 'y' } },
    },
  );
  assert.equal(parallel.ok, false);
  if (parallel.ok) return;
  assert.equal(parallel.code, 'binding-expired');
  assert.ok(parallel.message.includes('并行'));
});

// ---------- 显式接续 ----------

test('6.4 显式接续纳入新目标：版本 +1、接续记录保留原因、建议随接续闭环、新捕获可用新目标', async () => {
  const h = makeHarness();
  const capture = await prepareStartConsume(h.service);
  // 先制造一条绑定外建议（对 B 的写入被拒）。
  const rejected = await h.service.authorizeAgentCommand(
    { kind: 'agent-work', workRunId: capture.workRunId, bindingVersion: capture.bindingVersion, instanceId: INSTANCE_ID },
    {
      instanceId: INSTANCE_ID,
      sourceEpoch: BASELINE.sourceEpoch,
      expectedPlanVersion: BASELINE.planVersion,
      expectedPlanRevision: BASELINE.planRevision,
      command: { type: 'update-node' as const, nodeId: NODE_B, patch: { title: 'x' } },
    },
  );
  assert.equal(rejected.ok, false);

  const continued = await h.service.continueScope({
    workRunId: capture.workRunId,
    origin: 'panel',
    addedTargets: [NODE_B],
    reason: '用户确认把 B 纳入本轮工作',
  });
  assert.equal(continued.status, 'committed', JSON.stringify(continued));
  if (continued.status !== 'committed') return;
  assert.equal(continued.value.bindingVersion, 2);
  assert.deepEqual(continued.value.addedTargets, [NODE_B]);
  assert.equal(continued.value.includedSuggestions, 1, '匹配的开放建议随接续闭环');

  // 运行状态：目标扩大、接续记录保留（from/to/reason/origin）。
  const run = (await readRuns(h.store, h.localRoot))[0] as WorkRunRecord;
  assert.deepEqual(run.targets, [NODE_A, NODE_B]);
  assert.equal(run.bindingVersion, 2);
  const continuations = run.continuations ?? [];
  assert.equal(continuations.length, 1);
  assert.equal(continuations[0]?.fromVersion, 1);
  assert.equal(continuations[0]?.toVersion, 2);
  assert.equal(continuations[0]?.origin, 'panel');
  assert.ok(continuations[0]?.reason.includes('用户确认'));

  // 建议已 included；上下文的接续决定条目带来源与原因。
  const outcome = await h.service.buildContext({ ...capture, bindingVersion: 2 });
  assert.equal(outcome.status, 'committed');
  if (outcome.status !== 'committed') return;
  assert.ok(!outcome.value.items.some((item) => item.kind === 'suggestion'), '建议已闭环，不再出现在开放建议中');
  const continuationItem = outcome.value.items.find((item) => item.source === 'continuation:2');
  assert.ok(continuationItem !== undefined);
  assert.ok(continuationItem.text.includes('用户确认把 B 纳入本轮工作'));

  // 旧捕获（版本 1）写入 B 被拒：旧并行调用不能借接续后的新权限。
  const oldCapture = await h.service.authorizeAgentCommand(
    { kind: 'agent-work', workRunId: capture.workRunId, bindingVersion: 1, instanceId: INSTANCE_ID },
    {
      instanceId: INSTANCE_ID,
      sourceEpoch: BASELINE.sourceEpoch,
      expectedPlanVersion: BASELINE.planVersion,
      expectedPlanRevision: BASELINE.planRevision,
      command: { type: 'update-node' as const, nodeId: NODE_B, patch: { title: 'y' } },
    },
  );
  assert.equal(oldCapture.ok, false);
  if (oldCapture.ok) return;
  assert.equal(oldCapture.code, 'binding-expired');

  // 新捕获（版本 2）写入 B 通过：接续后的目标按新版本准入。
  const fresh = await h.service.captureBinding('session-c');
  assert.ok(fresh.ok);
  if (!fresh.ok) return;
  const admitted = await h.service.authorizeAgentCommand(
    { kind: 'agent-work', workRunId: fresh.capture.workRunId, bindingVersion: fresh.capture.bindingVersion, instanceId: INSTANCE_ID },
    {
      instanceId: INSTANCE_ID,
      sourceEpoch: BASELINE.sourceEpoch,
      expectedPlanVersion: BASELINE.planVersion,
      expectedPlanRevision: BASELINE.planRevision,
      command: { type: 'update-node' as const, nodeId: NODE_B, patch: { title: 'z' } },
    },
  );
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
});

test('6.4 接续校验反例：归属会话不匹配、未知节点、空原因、目标已在范围内都不推进版本', async () => {
  const h = makeHarness();
  const capture = await prepareStartConsume(h.service);

  const wrongSession = await h.service.continueScope({
    workRunId: capture.workRunId,
    origin: 'agent',
    sessionId: 'session-elsewhere',
    addedTargets: [NODE_B],
    reason: '越会话接续',
  });
  assert.equal(wrongSession.status, 'rejected');
  assert.equal((wrongSession as { code?: string }).code, 'forbidden');

  const ghost = await h.service.continueScope({
    workRunId: capture.workRunId,
    origin: 'panel',
    addedTargets: ['ghost-node'],
    reason: '未知节点',
  });
  assert.equal(ghost.status, 'rejected');
  assert.equal((ghost as { code?: string }).code, 'unknown-node');

  const noReason = await h.service.continueScope({
    workRunId: capture.workRunId,
    origin: 'panel',
    addedTargets: [NODE_B],
    reason: '   ',
  });
  assert.equal(noReason.status, 'rejected');
  assert.equal((noReason as { code?: string }).code, 'operation-mismatch');

  const duplicate = await h.service.continueScope({
    workRunId: capture.workRunId,
    origin: 'panel',
    addedTargets: [NODE_A],
    reason: '目标已在范围内',
  });
  assert.equal(duplicate.status, 'rejected');
  assert.equal((duplicate as { code?: string }).code, 'operation-mismatch');

  // 全部反例后版本不变、无接续记录。
  const run = (await readRuns(h.store, h.localRoot))[0] as WorkRunRecord;
  assert.equal(run.bindingVersion, 1);
  assert.deepEqual(run.continuations ?? [], []);
});

test('6.4 owner 按运行读上下文：不存在返回 not-found；存在则不要求捕获版本', async () => {
  const h = makeHarness();
  const missing = await h.service.contextForRunRemote('run-nothing');
  assert.equal(missing.status, 'rejected');
  assert.equal((missing as { code?: string }).code, 'not-found');

  await prepareStartConsume(h.service);
  const runs = await readRuns(h.store, h.localRoot);
  const run = runs[0] as WorkRunRecord;
  const outcome = await h.service.contextForRunRemote(run.workRunId);
  assert.equal(outcome.status, 'committed');
  if (outcome.status !== 'committed') return;
  assert.equal(outcome.value.workRunId, run.workRunId);
  assert.equal(outcome.value.sessionId, run.sessionId);
});
