// 宿主事件自动订阅接线测试（tasks 6.6）：
// 覆盖：四类事件映射（queued/consumed/turn-end/cancel）对真实 payload 的处理、
// 系统注入消息（无 rpcId）忽略、异常终态按 aborted、turn-stopping 预告不作取消、
// 以及 attach 后事件经适配转到 WorkService 的 observe*，runtime 不可用／观察失败被吞掉。

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { WorkService } from '../src/application/work.js';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { InstanceCommandQueue } from '../src/application/command-queue.js';
import type { PlanNodeViewPort } from '../src/application/ports.js';
import type { Sha256Fn } from '../src/domain/types.js';
import {
  attachWorkEventObservers,
  cancelFromTurnStopping,
  consumedFromInbox,
  messageRpcId,
  queuedFromInbox,
  turnEndFromSession,
} from '../src/host/work-events.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });
const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');
const BOOT = 1730000000000;
const INSTANCE_ID = '66666666-6666-4666-8666-666666666666';
const NODE_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SESSION = 'session-c9f906b2-575b-4191-b7cb-04b631f0ff09';
const RPC = 'PROBE-RPC-5f434a3e';

const userMessage = { source: { kind: 'user', rpcId: RPC }, role: 'user', content: [{ type: 'text', text: 'x' }] };

function planNodes(): PlanNodeViewPort {
  return { async currentNodeIds() { return { ok: true as const, nodeIds: new Set([NODE_A]) }; } };
}

function makeWork(): WorkService {
  const store = new LocalStateStore({ clock: () => new Date().toISOString() });
  const localRoot = mkdtempSync(path.join(artifacts, 'work-events-'));
  const now = () => new Date().toISOString();
  const dir = path.join(localRoot, 'instances', INSTANCE_ID);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
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
    lastObservation: { planVersion: 'pv-test-1', headHash: 'deadbeef', records: [], observedAt: now() },
  }, null, 2) + '\n');
  writeFileSync(path.join(localRoot, 'registry.json'), JSON.stringify({
    schemaVersion: 1,
    instances: [{
      instanceId: INSTANCE_ID,
      projectId: '00000000-0000-4000-8000-000000000001',
      sourceRoot: 'sources/unused',
      sourceKind: 'custom',
      sourceGeneration: 1,
      createdAt: now(),
      updatedAt: now(),
    }],
  }, null, 2) + '\n');
  return new WorkService({
    localRoot,
    instanceId: INSTANCE_ID,
    store,
    planNodes: planNodes(),
    clock: () => new Date().toISOString(),
    newWorkRunId: () => randomUUID(),
    newSuggestionId: () => randomUUID(),
    bootGeneration: BOOT,
    queue: new InstanceCommandQueue(),
  });
}

// ---------- 映射纯函数 ----------

test('messageRpcId 只取 user 消息的 rpcId，系统注入忽略', () => {
  assert.equal(messageRpcId(userMessage), RPC);
  assert.equal(messageRpcId({ source: { kind: 'agent-instructions' } }), null);
  assert.equal(messageRpcId({ source: { kind: 'runtime-context' } }), null);
  assert.equal(messageRpcId({ source: { kind: 'user' } }), null);
  assert.equal(messageRpcId(undefined), null);
});

test('queuedFromInbox: agent/inbox/inserted → queued（sessionId + rpcId）', () => {
  assert.deepEqual(
    queuedFromInbox({ agent: { id: SESSION }, message: userMessage }),
    { sessionId: SESSION, rpcId: RPC },
  );
  assert.equal(queuedFromInbox({ agent: { id: SESSION }, message: { source: { kind: 'skill-catalog' } } }), null);
  assert.equal(queuedFromInbox({ message: userMessage }), null);
});

test('consumedFromInbox: agent/inbox/claimed → consumed（turn + agentPresent）', () => {
  assert.deepEqual(
    consumedFromInbox({ agent: { id: SESSION }, message: userMessage, turn: 1 }),
    { sessionId: SESSION, rpcId: RPC, turn: 1, agentPresent: true },
  );
  // 缺 turn 或缺 agent 不构造事件，保守拒绝建绑定
  assert.equal(consumedFromInbox({ agent: { id: SESSION }, message: userMessage }), null);
  assert.equal(consumedFromInbox({ message: userMessage, turn: 1 }), null);
  assert.equal(consumedFromInbox({ agent: { id: SESSION }, message: userMessage, turn: -1 }), null);
});

test('turnEndFromSession: turn/end 映射，只有 completed 记 completed', () => {
  assert.deepEqual(
    turnEndFromSession({ id: SESSION }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }),
    { sessionId: SESSION, turn: 2, kind: 'completed' },
  );
  assert.deepEqual(
    turnEndFromSession({ id: SESSION }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'aborted', reason: 'user' } } }),
    { sessionId: SESSION, turn: 2, kind: 'aborted' },
  );
  assert.deepEqual(
    turnEndFromSession({ id: SESSION }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'error' } } }),
    { sessionId: SESSION, turn: 2, kind: 'aborted' },
  );
  assert.equal(turnEndFromSession({ id: SESSION }, { type: 'step/start', data: { turn: 2 } }), null);
  assert.equal(turnEndFromSession({ id: SESSION }, { type: 'turn/end', data: { reason: { kind: 'completed' } } }), null);
});

test('cancelFromTurnStopping: 只认 signal.aborted，预告不作取消', () => {
  assert.deepEqual(
    cancelFromTurnStopping({ agent: { id: SESSION }, turn: 3, signal: { aborted: true } }),
    { sessionId: SESSION, turn: 3 },
  );
  assert.deepEqual(
    cancelFromTurnStopping({ agent: { id: SESSION }, turn: 3, signal: { aborted: false } }),
    null,
  );
  assert.deepEqual(
    cancelFromTurnStopping({ agent: { id: SESSION }, turn: 3, signal: undefined }),
    null,
  );
  assert.deepEqual(
    cancelFromTurnStopping({ agent: { id: SESSION }, turn: 3, signal: { aborted: true } }),
    { sessionId: SESSION, turn: 3 },
  );
});

// ---------- 接线转调 ----------

interface FakeCtx {
  ctx: Context;
  handlers: Map<string, Array<(...args: any[]) => void>>;
}

function fakeCtx(): FakeCtx {
  const handlers = new Map<string, Array<(...args: any[]) => void>>();
  const ctx = {
    on(name: string, listener: (...args: any[]) => void) {
      const list = handlers.get(name) ?? [];
      list.push(listener);
      handlers.set(name, list);
      return () => true;
    },
  } as unknown as Context;
  return { ctx, handlers };
}

function emit(h: FakeCtx, name: string, ...args: unknown[]): void {
  for (const listener of h.handlers.get(name) ?? []) listener(...args);
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

test('attach: inserted → observeQueued，claimed → observeConsumed，turn/end → observeTurnEnd', async () => {
  const work = makeWork();
  const runtime = { ok: true as const, value: { work } as unknown as import('../src/host/project-service.js').ConaProjectRuntime };
  const h = fakeCtx();
  attachWorkEventObservers(h.ctx, async () => runtime);

  // 先登记意图并确认，令 queued/consumed 可匹配
  const prep = await work.prepareWork({
    workIntentId: randomUUID(),
    nodeIds: [NODE_A],
    allowedActions: ['split'],
    reasonScope: 'public',
    purpose: 'test',
    baseline: { planVersion: 'pv-test-1', planRevision: 0, sourceEpoch: 1 },
  });
  assert.equal(prep.status, 'committed');
  const intentId = prep.value.workIntentId;
  await work.startWork({ workIntentId: intentId, rpcId: RPC });

  emit(h, 'agent/inbox/inserted', { agent: { id: SESSION }, message: userMessage });
  await settle();
  let workState = (await work.listWork()).status === 'committed' ? await work.listWork() : null;
  assert.ok(workState && workState.status === 'committed');
  assert.ok(workState.value.intents.some((i) => i.workIntentId === intentId && i.queuedAt !== undefined), 'queued 应登记 queuedAt');

  emit(h, 'agent/inbox/claimed', { agent: { id: SESSION }, message: userMessage, turn: 1 });
  await settle();
  workState = (await work.listWork()).status === 'committed' ? await work.listWork() : null;
  assert.ok(workState && workState.status === 'committed');
  assert.ok(workState.value.runs.some((r) => r.sessionId === SESSION && r.turn === 1 && r.status === 'active'), 'claimed 应启动活动 WorkRun');

  emit(h, 'session/event', { id: SESSION }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await settle();
  workState = (await work.listWork()).status === 'committed' ? await work.listWork() : null;
  assert.ok(workState && workState.status === 'committed');
  assert.ok(workState.value.runs.some((r) => r.sessionId === SESSION && r.turn === 1 && r.status === 'ended'), 'turn/end 应结束 WorkRun');
});

test('attach: runtime 不可用与观察失败被吞掉（不抛未处理拒绝）', async () => {
  const h = fakeCtx();
  attachWorkEventObservers(h.ctx, async () => ({ ok: false, code: 'binding-expired', message: 'not configured' }));
  assert.doesNotThrow(() => {
    emit(h, 'agent/inbox/inserted', { agent: { id: SESSION }, message: userMessage });
    emit(h, 'session/event', { id: SESSION }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  });
  await settle();
});
