// 结束、取消、卸载与 Host 重启的绑定失效测试（tasks 6.5）。
// 覆盖：取消请求立即停止新写准入（等真实终态）、turn/end 确认、在途发布不动与重复取消幂等、
// 卸载（注册表移除）失效、Client 断线不取消 Host、失去链路的 active 意图记 blocked、
// 工具 abort 观测接线（signal 中止 → 新写准入停止）。
// 临时目录放在包内 artifacts/（仓库门禁禁止 os.tmpdir 与机器绝对路径）。

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstanceCommandQueue } from '../src/application/command-queue.js';
import { LocalStateService, workStateOf, type WorkAction, type WorkIntent, type WorkRunRecord } from '../src/application/local-state.js';
import { WorkService, type WorkCapture } from '../src/application/work.js';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { createSourceFiles } from '../src/adapters/fs/source-files.js';
import { resolveLocalRoot, rootRelation } from '../src/adapters/fs/local-root.js';
import { inspectPrivateRoot } from '../src/adapters/fs/git-guard.js';
import { ProjectCommandService } from '../src/application/command-service.js';
import { InMemoryChangeStream } from '../src/application/change-stream.js';
import { ProjectToolAdapter, type ConaToolExec } from '../src/host/project-tools.js';
import type { OpenedInstance } from '../src/host/bootstrap.js';
import type { PlanNodeViewPort } from '../src/application/ports.js';
import type { Sha256Fn } from '../src/domain/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sample = path.join(packageRoot, 'formats', 'v1', 'sample-project.json');
const formatsDir = path.join(packageRoot, 'formats', 'v1');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');
const INSTANCE_ID = '55555555-5555-4555-8555-555555555555';
const NODE_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const NODE_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const BOOT = 1730000000000;
const BASELINE = { planVersion: 'pv-test-1', planRevision: 0, sourceEpoch: 1 };

function clock(): string {
  return new Date().toISOString();
}

const PLAN_NODES: PlanNodeViewPort = {
  async currentNodeIds() {
    return { ok: true as const, nodeIds: new Set([NODE_A, NODE_B]) };
  },
};

interface LifecycleHarness {
  service: WorkService;
  store: LocalStateStore;
  localRoot: string;
  registryPath: string;
  removeRegistry(): void;
}

function makeHarness(): LifecycleHarness {
  const store = new LocalStateStore({ clock });
  const localRoot = mkdtempSync(path.join(artifacts, 'work-lifecycle-'));
  const dir = path.join(localRoot, 'instances', INSTANCE_ID);
  mkdirSync(dir, { recursive: true });
  const aggregate = {
    schemaVersion: 1,
    instanceId: INSTANCE_ID,
    projectId: '00000000-0000-4000-8000-000000000001',
    source: { root: 'sources/unused', kind: 'custom', generation: 1 },
    revisions: { plan: 0, state: 0 },
    conversations: { links: [], intents: [] },
    workIntents: [],
    workRuns: [],
    workSuggestions: [],
    operations: [],
    lastObservation: { planVersion: BASELINE.planVersion, headHash: 'deadbeef', records: [], observedAt: clock() },
  };
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify(aggregate, null, 2) + '\n');
  const registryPath = path.join(localRoot, 'registry.json');
  const writeRegistry = (generation: number): void => {
    writeFileSync(
      registryPath,
      JSON.stringify(
        {
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
        },
        null,
        2,
      ) + '\n',
    );
  };
  writeRegistry(1);
  const service = new WorkService({
    localRoot,
    instanceId: INSTANCE_ID,
    store,
    planNodes: PLAN_NODES,
    clock,
    newWorkRunId: () => `run-${randomUUID()}`,
    newSuggestionId: () => `sug-${randomUUID()}`,
    bootGeneration: BOOT,
    queue: new InstanceCommandQueue(),
  });
  return { service, store, localRoot, registryPath, removeRegistry: () => rmSync(registryPath) };
}

async function prepareStartConsume(service: WorkService): Promise<WorkCapture> {
  const workIntentId = `intent-${randomUUID()}`;
  const rpcId = `rpc-${randomUUID()}`;
  const prepared = await service.prepareWork({
    workIntentId,
    nodeIds: [NODE_A],
    allowedActions: ['update', 'add', 'record'] satisfies WorkAction[],
    reasonScope: 'local',
    purpose: '围绕 A 工作',
    baseline: BASELINE,
  });
  assert.equal(prepared.status, 'committed');
  const started = await service.startWork({ workIntentId, rpcId, sessionId: 'session-l' });
  assert.equal(started.status, 'committed');
  const admission = await service.observeConsumed({ sessionId: 'session-l', rpcId, turn: 1, agentPresent: true });
  assert.equal(admission.status, 'started');
  const captured = await service.captureBinding('session-l');
  assert.ok(captured.ok);
  return captured.ok ? captured.capture : (undefined as unknown as WorkCapture);
}

function authorizeCtx(capture: WorkCapture) {
  return { kind: 'agent-work' as const, workRunId: capture.workRunId, bindingVersion: capture.bindingVersion, instanceId: INSTANCE_ID };
}

function authorizeEnvelope(nodeId: string) {
  return {
    instanceId: INSTANCE_ID,
    sourceEpoch: BASELINE.sourceEpoch,
    expectedPlanVersion: BASELINE.planVersion,
    expectedPlanRevision: BASELINE.planRevision,
    command: { type: 'update-node' as const, nodeId, patch: { title: 'x' } },
  };
}

// ---------- 取消请求与真实终态 ----------

test('6.5 取消请求立即停止新写准入：authorize 拒绝、绑定仍活着等真实终态、status 保持 active', async () => {
  const h = makeHarness();
  const capture = await prepareStartConsume(h.service);
  // 取消前准入通过。
  const before = await h.service.authorizeAgentCommand(authorizeCtx(capture), authorizeEnvelope(NODE_A));
  assert.equal(before.ok, true, JSON.stringify(before));

  const cancelled = await h.service.observeCancel({ sessionId: 'session-l', turn: 1 });
  assert.equal(cancelled.status, 'cancelling', JSON.stringify(cancelled));
  if (cancelled.status !== 'cancelling') return;
  assert.equal(cancelled.workRunId, capture.workRunId);

  // 取消后：新写准入立即停止；绑定未终结（capture 仍可读上下文，等真实终态）。
  const after = await h.service.authorizeAgentCommand(authorizeCtx(capture), authorizeEnvelope(NODE_A));
  assert.equal(after.ok, false);
  if (after.ok) return;
  assert.equal(after.code, 'binding-expired');
  assert.ok(after.message.includes('取消'));
  const captureAgain = await h.service.captureBinding('session-l');
  assert.ok(captureAgain.ok, '取消未确认终态前绑定仍活着');
  const aggregate = await h.store.readAggregate(h.localRoot, INSTANCE_ID);
  assert.ok(aggregate !== null);
  const run = workStateOf(aggregate).runs[0] as WorkRunRecord;
  assert.equal(run.status, 'active', '状态保持 active，等 turn/end 确认');
  assert.ok(run.admissionStoppedAt !== undefined);
});

test('6.5 取消后真实终态确认：turn/end aborted 才进入 ended，意图标 stopped', async () => {
  const h = makeHarness();
  await prepareStartConsume(h.service);
  const cancelled = await h.service.observeCancel({ sessionId: 'session-l', turn: 1 });
  assert.equal(cancelled.status, 'cancelling');
  // 预告不作数：没有 turn/end 前 status 不变（上面已断言）。

  const ended = await h.service.observeTurnEnd({ sessionId: 'session-l', turn: 1, kind: 'aborted' });
  assert.equal(ended.status, 'ended');
  if (ended.status !== 'ended') return;
  assert.equal(ended.kind, 'aborted');
  const aggregate = await h.store.readAggregate(h.localRoot, INSTANCE_ID);
  assert.ok(aggregate !== null);
  const work = workStateOf(aggregate);
  assert.equal((work.runs[0] as WorkRunRecord).status, 'ended');
  assert.equal((work.runs[0] as WorkRunRecord).endKind, 'aborted');
  assert.equal(work.intents[0]?.status, 'stopped');
});

test('6.5 在途发布不动：取消不回滚已准入的操作记录；重复取消幂等', async () => {
  const h = makeHarness();
  const capture = await prepareStartConsume(h.service);
  // 取消前操作记录为空；准入判定已通过（模拟在途）。
  const admitted = await h.service.authorizeAgentCommand(authorizeCtx(capture), authorizeEnvelope(NODE_A));
  assert.equal(admitted.ok, true);
  const before = await h.store.readAggregate(h.localRoot, INSTANCE_ID);
  assert.ok(before !== null);
  const operationsBefore = JSON.stringify(before.operations);

  const first = await h.service.observeCancel({ sessionId: 'session-l' });
  assert.equal(first.status, 'cancelling');
  // 已准入的操作记录不被取消改写（在途按提交恢复协议处理）。
  const after = await h.store.readAggregate(h.localRoot, INSTANCE_ID);
  assert.ok(after !== null);
  assert.equal(JSON.stringify(after.operations), operationsBefore);

  // 重复取消幂等：同一运行，不重复推进。
  const second = await h.service.observeCancel({ sessionId: 'session-l' });
  assert.equal(second.status, 'cancelling');
  if (second.status !== 'cancelling') return;
  assert.equal(second.workRunId, (first as { status: 'cancelling'; workRunId: string }).workRunId);
});

// ---------- 卸载与断线 ----------

test('6.5 卸载失效：注册表条目移除后不建立新捕获、不接受写入', async () => {
  const h = makeHarness();
  const capture = await prepareStartConsume(h.service);
  h.removeRegistry();

  const captureAfter = await h.service.captureBinding('session-l');
  assert.equal(captureAfter.ok, false);
  if (!captureAfter.ok) {
    assert.equal(captureAfter.code, 'binding-expired');
    assert.ok(captureAfter.message.includes('卸载'));
  }
  const writeAfter = await h.service.authorizeAgentCommand(authorizeCtx(capture), authorizeEnvelope(NODE_A));
  assert.equal(writeAfter.ok, false);
  if (!writeAfter.ok) assert.ok(writeAfter.message.includes('卸载'));
});

test('6.5 Client 断线不取消 Host：无生命周期事件时绑定与写资格保持', async () => {
  const h = makeHarness();
  const capture = await prepareStartConsume(h.service);
  // 模拟断线—重连：中间只发生只读查询，无任何取消／停止事件。
  const view = await h.service.listWork();
  assert.equal(view.status, 'committed');
  const captureAgain = await h.service.captureBinding('session-l');
  assert.ok(captureAgain.ok, '断线不撤销仍在宿主活动的绑定');
  if (!captureAgain.ok) return;
  assert.equal(captureAgain.capture.bindingVersion, capture.bindingVersion);
  const admitted = await h.service.authorizeAgentCommand(authorizeCtx(capture), authorizeEnvelope(NODE_A));
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
});

test('6.5 失去链路的 active 意图记 blocked：取消事件无生效运行时清理为 blocked（lifecycle-unattributable）', async () => {
  const h = makeHarness();
  // 造一个 active 意图但无生效运行（模拟链路丢失：意图活跃、运行缺失）。
  const dir = path.join(h.localRoot, 'instances', INSTANCE_ID);
  const aggregate = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')) as { workIntents: WorkIntent[] };
  aggregate.workIntents.push({
    workIntentId: 'intent-lost',
    nodeIds: [NODE_A],
    allowedActions: ['update'],
    reasonScope: 'local',
    purpose: '链路丢失的工作',
    origin: 'panel',
    baseline: BASELINE,
    status: 'active',
    sessionId: 'session-lost',
    createdAt: clock(),
    updatedAt: clock(),
  });
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify(aggregate, null, 2) + '\n');

  const result = await h.service.observeCancel({ sessionId: 'session-lost' });
  assert.equal(result.status, 'blocked', JSON.stringify(result));
  if (result.status !== 'blocked') return;
  assert.equal(result.reason, 'lifecycle-unattributable');
  assert.deepEqual(result.workIntentIds, ['intent-lost']);
  const after = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')) as { workIntents: WorkIntent[] };
  assert.equal(after.workIntents[0]?.status, 'blocked');
  assert.equal(after.workIntents[0]?.blockedReason, 'lifecycle-unattributable');
});

test('6.5 无归属的取消与非法事件：无运行无意图返回 unmatched；缺 sessionId 拒绝', async () => {
  const h = makeHarness();
  const unmatched = await h.service.observeCancel({ sessionId: 'session-ghost' });
  assert.equal(unmatched.status, 'unmatched');
  const invalid = await h.service.observeCancel({ sessionId: '' });
  assert.equal(invalid.status, 'rejected');
  assert.equal((invalid as { code?: string }).code, 'operation-mismatch');
});

// ---------- 工具 abort 观测接线（真实适配器路径） ----------

test('6.5 工具 abort 观测接线：signal 中止的写操作完成后新写准入立即停止', async () => {
  const base = mkdtempSync(path.join(artifacts, 'work-lifecycle-adapter-'));
  const localRoot = path.join(base, 'local');
  const source = path.join(base, 'source');
  mkdirSync(source, { recursive: true });
  copyFileSync(sample, path.join(source, 'project.json'));
  const store = new LocalStateStore({ clock });
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
  if (!registered.ok) return;
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
  const instance: OpenedInstance = {
    instanceId: registered.entry.instanceId,
    projectId: registered.entry.projectId,
    sourceRoot: source,
    sourceKind: 'custom',
    sourceDisplay: source,
    sourceEpoch: registered.entry.sourceGeneration,
    localRoot,
    created: false,
    baselineEstablished: true,
    repositoryMaps: [],
  };
  const adapter = new ProjectToolAdapter({ runtime: async () => ({ ok: true as const, value: { instance, snapshot: {} as never, command, chats: {} as never, resumeChats: {} as never, work } }) });

  const sessionId = 'session-abort';
  const rpcId = 'rpc-abort';
  const planVersion = (JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as { planVersion: string }).planVersion;
  const prepared = await work.prepareWork({
    workIntentId: 'intent-abort',
    nodeIds: ['00000000-0000-4000-8000-000000000002'],
    allowedActions: ['update', 'record'],
    reasonScope: 'local',
    purpose: 'abort 观测',
    baseline: { planVersion, planRevision: 0, sourceEpoch: registered.entry.sourceGeneration },
  });
  assert.equal(prepared.status, 'committed');
  await work.startWork({ workIntentId: 'intent-abort', rpcId, sessionId });
  await work.observeConsumed({ sessionId, rpcId, turn: 1, agentPresent: true });

  // exec.signal 已中止（真实 cancel／steer 场景）：写操作本身完成（已提交），abort 被观测。
  const abortedExec: ConaToolExec = { agent: { id: sessionId }, callId: 'call-1', signal: { aborted: true } };
  const output = (await adapter.record(
    {
      operationId: randomUUID(),
      kind: 'execution-note',
      subjectNodeIds: ['00000000-0000-4000-8000-000000000002'],
      summary: 'abort 场景的记录',
      sources: [],
      body: '# abort',
    },
    abortedExec,
  )) as Record<string, unknown>;
  assert.equal(output['status'], 'committed', JSON.stringify(output));

  // 新写准入已停止：同会话下一次 apply 拒绝。
  const rejected = (await adapter.apply(
    {
      operationId: randomUUID(),
      command: { type: 'update-node', nodeId: '00000000-0000-4000-8000-000000000002', patch: { title: 'y' } },
      expectedPlanVersion: planVersion,
      expectedPlanRevision: 0,
      sourceEpoch: registered.entry.sourceGeneration,
    },
    { agent: { id: sessionId }, callId: 'call-2', signal: { aborted: false } },
  )) as Record<string, unknown>;
  assert.equal(rejected['status'], 'rejected', JSON.stringify(rejected));
  assert.equal(rejected['code'], 'binding-expired');
  assert.ok(String(rejected['message']).includes('取消'));

  // 未中止的信号不触发取消：新会话流程不受影响（幂等核对：直接看运行状态）。
  const aggregate = await store.readAggregate(localRoot, registered.entry.instanceId);
  assert.ok(aggregate !== null);
  const run = workStateOf(aggregate).runs[0] as WorkRunRecord;
  assert.equal(run.status, 'active', '取消只停准入，运行等真实终态');
  assert.ok(run.admissionStoppedAt !== undefined);
  assert.equal(aggregate.operations.length, 1, '被中止信号伴随的写操作本身已提交（在途完成）');
});
