// R2 收尾 3.2：工作预览与会话边界启动（A 层）。
// 覆盖：预览目标条件／依赖／约束／基线／记录／聊天入口；目标集合外的同会话节点只作背景；
// 源代际与基线变化记为待核对；预览不落盘、不建绑定；按会话确认后由真实消费边界建立绑定；
// 同会话多个待执行意图不唯一时拒绝；显式 rpcId 路径保持原语义。

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstanceCommandQueue } from '../src/application/command-queue.js';
import { WorkService, type WorkAction } from '../src/application/work.js';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import type { PlanNodeTarget, PlanNodeViewPort } from '../src/application/ports.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const INSTANCE_ID = '44444444-4444-4444-8444-444444444444';
const NODE_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const NODE_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const NODE_C = 'cccccccc-0000-4000-8000-000000000003';
const NODE_D = 'dddddddd-0000-4000-8000-000000000004';
const SESSION = 'session-work';
const BOOT = 1730000000000;
const BASELINE = { planVersion: 'pv-preview-1', planRevision: 2, sourceEpoch: 1 };

function clock(): string {
  return new Date().toISOString();
}

const NODES: PlanNodeTarget[] = [
  { id: NODE_A, title: '节点 A', status: 'in-progress', goal: '完成 A 的能力', completionCriteria: ['条件 1', '条件 2'], parentId: null },
  { id: NODE_B, title: '节点 B', status: 'todo', goal: '支撑 B', completionCriteria: [], parentId: null },
  { id: NODE_C, title: '节点 C', status: 'todo', goal: '被 A 依赖', completionCriteria: [], parentId: null },
  { id: NODE_D, title: '节点 D', status: 'todo', goal: '依赖 A', completionCriteria: [], parentId: null },
];

const EDGES = [
  { nodeId: NODE_A, requiresNodeId: NODE_C },
  { nodeId: NODE_B, requiresNodeId: NODE_A },
  { nodeId: NODE_D, requiresNodeId: NODE_A },
];

const RECORDS = [
  { id: 'rec-a', kind: 'verification', summary: 'A 的验证', subjectNodeIds: [NODE_A], path: 'records/rec-a/x.md' },
  { id: 'rec-c', kind: 'analysis-note', summary: 'C 的分析', subjectNodeIds: [NODE_C], path: 'records/rec-c/x.md' },
];

interface Harness {
  service: WorkService;
  store: LocalStateStore;
  localRoot: string;
  setSourceGeneration(generation: number): void;
  readWork(): { intents: unknown[]; runs: unknown[]; stateRevision: number };
}

function makeHarness(): Harness {
  const store = new LocalStateStore({ clock });
  const localRoot = mkdtempSync(path.join(artifacts, 'work-preview-'));
  const dir = path.join(localRoot, 'instances', INSTANCE_ID);
  mkdirSync(dir, { recursive: true });
  const aggregate = {
    schemaVersion: 1,
    instanceId: INSTANCE_ID,
    projectId: '00000000-0000-4000-8000-000000000001',
    source: { root: 'sources/unused', kind: 'custom', generation: 1 },
    revisions: { plan: 2, state: 3 },
    conversations: {
      links: [
        { linkId: 'link-a', sessionId: SESSION, nodeIds: [NODE_A], purpose: '讨论 A', origin: 'panel', createdAt: clock(), updatedAt: clock() },
        { linkId: 'link-bc', sessionId: SESSION, nodeIds: [NODE_B, NODE_C], purpose: '讨论 B/C', origin: 'panel', createdAt: clock(), updatedAt: clock() },
        { linkId: 'link-d', sessionId: 'session-other', nodeIds: [NODE_D], purpose: '别处讨论 D', origin: 'panel', createdAt: clock(), updatedAt: clock() },
      ],
      intents: [],
    },
    workIntents: [],
    workRuns: [],
    workSuggestions: [],
    operations: [],
    lastObservation: { planVersion: BASELINE.planVersion, headHash: 'deadbeef', records: [], observedAt: clock() },
  };
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify(aggregate, null, 2) + '\n');
  const writeRegistry = (generation: number): void => {
    writeFileSync(
      path.join(localRoot, 'registry.json'),
      JSON.stringify({
        schemaVersion: 1,
        instances: [{
          instanceId: INSTANCE_ID,
          projectId: '00000000-0000-4000-8000-000000000001',
          sourceRoot: 'sources/unused',
          sourceKind: 'custom',
          sourceGeneration: generation,
          createdAt: clock(),
          updatedAt: clock(),
        }],
      }, null, 2) + '\n',
    );
  };
  writeRegistry(1);
  const planNodes: PlanNodeViewPort = {
    async currentNodeIds() {
      return { ok: true as const, nodeIds: new Set([NODE_A, NODE_B, NODE_C, NODE_D]) };
    },
    async nodeDetails(ids) {
      return {
        ok: true as const,
        nodes: NODES.filter((node) => ids.includes(node.id)).map((node) => ({ id: node.id, title: node.title, status: node.status })),
        records: RECORDS,
      };
    },
    async planTargets(ids) {
      return {
        ok: true as const,
        nodes: NODES.filter((node) => ids.includes(node.id)),
        dependencies: EDGES,
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
    queue: new InstanceCommandQueue(),
  });
  return {
    service, store, localRoot,
    setSourceGeneration: writeRegistry,
    readWork: () => {
      const file = JSON.parse(
        readFileSync(path.join(localRoot, 'instances', INSTANCE_ID, 'state.json'), 'utf8'),
      ) as { workIntents: unknown[]; workRuns: unknown[]; revisions: { state: number } };
      return { intents: file.workIntents, runs: file.workRuns, stateRevision: file.revisions.state };
    },
  };
}

const scope = (overrides: Partial<{
  sessionId: string; nodeIds: string[]; allowedActions: WorkAction[]; reasonScope: 'public' | 'local'; purpose: string;
  baseline: { planVersion: string; planRevision: number; sourceEpoch: number };
}> = {}) => ({
  sessionId: SESSION,
  nodeIds: [NODE_A, NODE_B],
  allowedActions: ['update', 'record'] as WorkAction[],
  reasonScope: 'local' as const,
  purpose: '推进 A 与 B',
  baseline: BASELINE,
  ...overrides,
});

test('3.2 预览上下文：目标条件、直接依赖、约束、基线、公开记录与聊天入口同源', async () => {
  const h = makeHarness();
  const outcome = await h.service.previewWork(scope());
  assert.equal(outcome.status, 'committed', JSON.stringify(outcome));
  if (outcome.status !== 'committed') return;
  const preview = outcome.value;

  assert.equal(preview.sessionId, SESSION);
  assert.deepEqual(preview.constraints, { allowedActions: ['update', 'record'], reasonScope: 'local' });
  assert.deepEqual(preview.baseline, BASELINE);
  assert.equal(preview.sourceEpoch, 1);

  const a = preview.targets.find((target) => target.id === NODE_A);
  assert.ok(a !== undefined);
  assert.equal(a.title, '节点 A');
  assert.equal(a.status, 'in-progress');
  assert.equal(a.goal, '完成 A 的能力');
  assert.deepEqual(a.completionCriteria, ['条件 1', '条件 2']);
  // 依赖只列目标集合外的端点（C 在目标外 → 列出并带标题；B 在目标内 → 不重复列）。
  assert.deepEqual(a.dependsOn, [{ id: NODE_C, known: true, title: '节点 C' }]);
  assert.deepEqual(a.requiredBy, [{ id: NODE_D, known: true, title: '节点 D' }]);

  // 记录只取与目标相交的：rec-a 入选，rec-c（C）不入选。
  assert.deepEqual(preview.publicRecords.map((record) => record.id), ['rec-a']);
  // 聊天入口按目标相交：link-a、link-bc；link-d 的会话无目标交集。
  assert.deepEqual(preview.chatEntries.map((entry) => entry.linkId).sort(), ['link-a', 'link-bc']);
  // 决定条目来自预览范围本身；同会话背景节点另以建议条目出现。
  const kinds = preview.items.map((item) => item.kind);
  assert.ok(kinds.includes('decision'));
  assert.ok(kinds.includes('suggestion'), '目标外的同会话节点以背景建议出现');
  assert.ok(!kinds.includes('unverified'), '源代际与基线一致时不应有待核对项');
});

test('3.2 同一会话的第三节点只在背景：不进目标集合，也不进写范围', async () => {
  const h = makeHarness();
  const outcome = await h.service.previewWork(scope({ nodeIds: [NODE_A, NODE_B] }));
  assert.equal(outcome.status, 'committed');
  if (outcome.status !== 'committed') return;
  const preview = outcome.value;

  assert.deepEqual(preview.targets.map((target) => target.id).sort(), [NODE_A, NODE_B].sort());
  assert.deepEqual(preview.backgroundNodeIds, [NODE_C], 'C 在同一会话有关联，但只作背景');
  const background = preview.items.find((item) => item.kind === 'suggestion');
  assert.ok(background !== undefined, '背景节点以建议条目呈现');
  assert.deepEqual(background.nodeIds, [NODE_C]);
  assert.ok(!preview.chatEntries.some((entry) => entry.linkId === 'link-d'), '另一会话的链接不进入');
});

test('3.2 源代际推进或基线不一致：预览标记待核对，不静默改写目标', async () => {
  const h = makeHarness();
  h.setSourceGeneration(3);
  const outcome = await h.service.previewWork(scope({ baseline: { ...BASELINE, planVersion: 'pv-old' } }));
  assert.equal(outcome.status, 'committed');
  if (outcome.status !== 'committed') return;
  const sources = outcome.value.items.map((item) => item.source);
  assert.ok(sources.some((source) => source.startsWith('source-generation:3')), '源代际推进待核对');
  assert.ok(sources.some((source) => source.startsWith('plan-baseline:')), '基线不一致待核对');
  assert.equal(outcome.value.sourceEpoch, 3);
  // 目标原样保留，不被旧基线覆盖。
  assert.deepEqual(outcome.value.targets.map((target) => target.id).sort(), [NODE_A, NODE_B].sort());
});

test('3.2 预览只读：不登记意图、不建运行、不推进修订', async () => {
  const h = makeHarness();
  const before = h.readWork();
  const outcome = await h.service.previewWork(scope());
  assert.equal(outcome.status, 'committed');
  const after = h.readWork();
  assert.deepEqual(after, before, '预览不得留下任何本机状态变化');
});

test('3.2 预览拒绝：缺会话／未知节点／空动作集不产生上下文', async () => {
  const h = makeHarness();
  const noSession = await h.service.previewWork(scope({ sessionId: '' }));
  assert.equal(noSession.status, 'rejected');
  assert.equal(noSession.status === 'rejected' ? noSession.code : '', 'session-identity-missing');

  const unknown = await h.service.previewWork(scope({ nodeIds: [randomUUID()] }));
  assert.equal(unknown.status, 'rejected');
  assert.equal(unknown.status === 'rejected' ? unknown.code : '', 'unknown-node');

  const noActions = await h.service.previewWork(scope({ allowedActions: [] }));
  assert.equal(noActions.status, 'rejected');
  assert.equal(noActions.status === 'rejected' ? noActions.code : '', 'operation-mismatch');
});

test('3.2 按会话确认：不预知 rpcId，由该会话下一条消息消费建立唯一绑定', async () => {
  const h = makeHarness();
  const workIntentId = `intent-${randomUUID()}`;
  const prepared = await h.service.prepareWork({
    workIntentId, nodeIds: [NODE_A, NODE_B], allowedActions: ['update', 'record'],
    reasonScope: 'local', purpose: '推进 A 与 B', baseline: BASELINE,
  });
  assert.equal(prepared.status, 'committed', JSON.stringify(prepared));

  const started = await h.service.startWork({ workIntentId, sessionId: SESSION });
  assert.equal(started.status, 'committed', JSON.stringify(started));

  // 排队事件只登记：按会话匹配，不改绑定。
  const queued = await h.service.observeQueued({ sessionId: SESSION, rpcId: 'rpc-any' });
  assert.equal(queued.status, 'queued', JSON.stringify(queued));

  // 真实消费边界：消息 rpcId 由宿主产生，与确认动作无关。
  const consumed = await h.service.observeConsumed({ sessionId: SESSION, rpcId: 'rpc-any', turn: 4, agentPresent: true });
  assert.equal(consumed.status, 'started', JSON.stringify(consumed));
  if (consumed.status !== 'started') return;
  assert.deepEqual([...consumed.sessionId].length > 0, true);

  const capture = await h.service.captureBinding(SESSION);
  assert.equal(capture.ok, true);
  if (!capture.ok) return;
  assert.deepEqual(capture.capture.targets, [NODE_A, NODE_B], '绑定范围就是确认的目标集合');
  assert.deepEqual(capture.capture.allowedActions, ['update', 'record']);

  // 运行建立后的其他消息不再改写绑定。
  const other = await h.service.observeConsumed({ sessionId: SESSION, rpcId: 'rpc-later', turn: 5, agentPresent: true });
  assert.equal(other.status, 'unmatched');
  const recaptured = await h.service.captureBinding(SESSION);
  assert.equal(recaptured.ok && recaptured.capture.bindingVersion, 1);
});

test('3.2 同会话多个待执行意图不唯一：拒绝建立绑定并记 blocked', async () => {
  const h = makeHarness();
  for (const target of ['one', 'two'] as const) {
    const workIntentId = `intent-${target}-${randomUUID()}`;
    const prepared = await h.service.prepareWork({
      workIntentId, nodeIds: target === 'one' ? [NODE_A] : [NODE_B],
      allowedActions: ['update'], reasonScope: 'local', purpose: `范围 ${target}`, baseline: BASELINE,
    });
    assert.equal(prepared.status, 'committed');
    const started = await h.service.startWork({ workIntentId, sessionId: SESSION });
    assert.equal(started.status, 'committed');
  }
  const consumed = await h.service.observeConsumed({ sessionId: SESSION, rpcId: 'rpc-shared', turn: 1, agentPresent: true });
  assert.equal(consumed.status, 'blocked', JSON.stringify(consumed));
  assert.equal(consumed.status === 'blocked' ? consumed.reason : '', 'ambiguous-intent');
  assert.equal(h.readWork().runs.length, 0, '归属不唯一不得建立运行');
});

test('3.2 按会话确认不能跨会话生效：别的会话的消费不匹配', async () => {
  const h = makeHarness();
  const workIntentId = `intent-${randomUUID()}`;
  await h.service.prepareWork({
    workIntentId, nodeIds: [NODE_A], allowedActions: ['update'],
    reasonScope: 'local', purpose: '只在本会话', baseline: BASELINE,
  });
  await h.service.startWork({ workIntentId, sessionId: SESSION });
  const other = await h.service.observeConsumed({ sessionId: 'session-other', rpcId: 'rpc-x', turn: 1, agentPresent: true });
  assert.equal(other.status, 'unmatched');
  const own = await h.service.observeConsumed({ sessionId: SESSION, rpcId: 'rpc-y', turn: 1, agentPresent: true });
  assert.equal(own.status, 'started');
});
