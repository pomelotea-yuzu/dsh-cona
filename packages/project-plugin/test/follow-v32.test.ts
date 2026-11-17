// V32 follow 订阅测试：Host 句柄缓冲 + Client 先订阅再回读、事件驱动失效、重连重新订阅。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FollowSessions, FOLLOW_LIMITS } from '../src/host/follow-sessions.js';
import type { FollowResult, StreamEventView } from '../src/application/snapshot.js';
import { PanelController } from '../src/client/panel-controller.js';
import type { ConaProjectStatus, FollowHandle, PanelSnapshot, PanelTransport, SnapshotResult, StreamEventView as ClientEvent } from '../src/client/api.js';

const INSTANCE = '11111111-1111-4111-8111-111111111111';
const PROJECT = '00000000-0000-4000-8000-000000000001';

function event(overrides: Partial<StreamEventView> = {}): StreamEventView {
  return {
    kind: 'committed', instanceId: INSTANCE, projectId: PROJECT, sourceEpoch: 2,
    stateRevision: 1, planRevision: 1, connectionGeneration: 1,
    at: '2026-11-17T00:00:00.000Z', ...overrides,
  };
}

function asyncEvents(items: StreamEventView[]): AsyncIterable<StreamEventView> {
  return { async *[Symbol.asyncIterator]() { for (const item of items) yield item; } };
}

// ---------- Host 句柄 ----------

test('follow-sessions：ready 入首事件，事件按批拉取不重复，关闭后 closed', async () => {
  const sessions = new FollowSessions();
  const ready = event({ kind: 'ready', stateRevision: 0 });
  const e1 = event({ stateRevision: 1 });
  const e2 = event({ stateRevision: 2 });
  const result: FollowResult & { status: 'following' } = {
    status: 'following', connectionGeneration: 1, ready,
    events: asyncEvents([e1, e2]), close: () => {},
  };
  const view = sessions.start('sub-1', INSTANCE, result);
  assert.equal(view.subscriptionId, 'sub-1');
  assert.equal(view.connectionGeneration, 1);
  assert.deepEqual(view.ready, ready);

  // 泵异步完成
  await new Promise((r) => setTimeout(r, 20));
  const first = sessions.drain('sub-1');
  assert.equal(first.status, 'events');
  assert.deepEqual(first.events.map((e) => e.stateRevision), [0, 1, 2]);
  assert.equal(first.nextIndex, 3);
  const second = sessions.drain('sub-1');
  assert.deepEqual(second.events, []);
  assert.equal(second.closed, true); // AsyncIterable 已耗尽 → 流终结，client 应重订阅
  assert.equal(sessions.drain('missing').status, 'not-found');
});

test('follow-sessions：同实例新订阅关闭旧句柄；数量上限淘汰最旧', async () => {
  const sessions = new FollowSessions();
  const make = (id: string, gen: number): FollowResult & { status: 'following' } => ({
    status: 'following', connectionGeneration: gen,
    ready: event({ kind: 'ready', stateRevision: gen, connectionGeneration: gen }),
    events: asyncEvents([]), close: () => {},
  });
  sessions.start('a', INSTANCE, make('a', 1));
  sessions.start('b', INSTANCE, make('b', 2));
  assert.equal(sessions.drain('a').closed, true, '同实例新代际应关闭旧订阅');
  assert.equal(sessions.drain('b').status, 'events');

  for (let i = 0; i < FOLLOW_LIMITS.maxHandles + 2; i++) {
    sessions.start(`h${i}`, `instance-${i}`, make(`h${i}`, i + 1));
  }
  assert.ok(sessions.size <= FOLLOW_LIMITS.maxHandles, `句柄数应受上限约束，实际 ${sessions.size}`);
});

// ---------- Client 控制器 ----------

function snap(stateRevision: number, planRevision = 1): PanelSnapshot {
  return {
    projectId: PROJECT, instanceId: INSTANCE, sourceEpoch: 2, schemaVersion: 1,
    planVersion: 'sha256:' + 'a'.repeat(64), planRevision, stateRevision, connectionGeneration: 1,
    sync: { status: 'synced', requiresRefresh: false, basis: 'local-observation' },
    source: { kind: 'custom', displayPath: '~/p' },
    project: { id: PROJECT, title: '示例', goal: '目标', constraints: [], repositories: [] },
    tree: [{ id: 'root', parentId: null, order: 0, title: '阶段1', goal: 'g', completionCriteria: [], status: 'todo' }],
    dependencies: [], records: [],
    summary: { nodeCount: 1, rootCount: 1, maxDepth: 1, statusCounts: { todo: 1 }, dependencyCount: 0, recordCount: 0, recordsByKind: {} },
    local: { conversationCount: 0, workRunCount: 0, lastOperationAt: null, quarantined: null },
    readAt: '2026-11-17T00:00:00.000Z',
  };
}

const STATUS: ConaProjectStatus = {
  configured: true, instanceId: INSTANCE, projectId: PROJECT, sourceKind: 'custom',
  sourceDisplay: '~/p', localRootDisplay: '~/l', created: false, error: null,
};

interface FollowScript {
  readyRevision?: number;
  events: ClientEvent[];
  afterDrain?: (index: number) => ClientEvent[];
}

/** 带 follow 的假传输：记录 follow/重订阅/回读次数与 minStateRevision。 */
function followTransport(script: FollowScript): PanelTransport & {
  followCount: number; closeCount: number; minRevisions: Array<number | undefined>; generationSeen: number[];
} {
  let revision = 1;
  // 直接扩展 log 对象，让闭包内修改与调用方断言读的是同一对象（避免展开拷贝导致计数不同步）。
  const transport = {
    followCount: 0, closeCount: 0,
    minRevisions: [] as Array<number | undefined>, generationSeen: [] as number[],
    status: async () => STATUS,
    snapshot: async (req: { connectionGeneration: number; minStateRevision?: number }): Promise<SnapshotResult> => {
      transport.minRevisions.push(req.minStateRevision);
      transport.generationSeen.push(req.connectionGeneration);
      return { status: 'snapshot', snapshot: snap(revision) };
    },
    execute: async (): Promise<never> => { throw new Error('not used'); },
    follow: async () => {
      transport.followCount += 1;
      const handle: FollowHandle = {
        subscriptionId: `sub-${transport.followCount}`, connectionGeneration: transport.followCount,
        ready: event({ kind: 'ready', stateRevision: script.readyRevision ?? 1, connectionGeneration: transport.followCount }) as ClientEvent,
      };
      return { status: 'following' as const, value: handle };
    },
    followEvents: async () => {
      const items = script.afterDrain !== undefined ? script.afterDrain(transport.followCount) : script.events;
      return { status: 'events' as const, events: items, nextIndex: items.length, closed: false };
    },
    followClose: async () => { transport.closeCount += 1; return { closed: true }; },
  };
  return transport;
}

test('open 先订阅再回读：snapshot 带 ready 的 minStateRevision', async () => {
  const t = followTransport({ readyRevision: 7, events: [] });
  const panel = new PanelController({ transport: t, newOperationId: () => 'op' });
  await panel.open();
  assert.equal(t.followCount, 1);
  assert.equal(t.minRevisions[0], 7, '回读应至少覆盖 ready 水位');
  assert.equal(panel.getState().phase, 'ready');
});

test('poll 有更高修订才回读；无新事件不重复回读', async () => {
  let drained = false;
  const t = followTransport({
    readyRevision: 1, events: [],
    afterDrain: () => {
      if (drained) return [];
      drained = true;
      return [event({ stateRevision: 5 }) as ClientEvent];
    },
  });
  const panel = new PanelController({ transport: t, newOperationId: () => 'op' });
  await panel.open();
  const readsAfterOpen = t.minRevisions.length;
  const outcome = await panel.poll();
  assert.equal(outcome, 'applied');
  assert.equal(t.minRevisions.length, readsAfterOpen + 1, '有新事实时回读一次');
  const outcome2 = await panel.poll();
  assert.equal(outcome2, 'stale-revision');
  assert.equal(t.minRevisions.length, readsAfterOpen + 1, '无新事实不回读');
});

test('reconnect 释放旧订阅并重新订阅，代际递增且草稿保留', async () => {
  const t = followTransport({ readyRevision: 1, events: [] });
  const panel = new PanelController({ transport: t, newOperationId: () => 'op' });
  await panel.open();
  panel.editGoal('root', '未保存草稿');
  assert.equal(panel.getState().connection.generation, 1);
  await panel.reconnect();
  assert.equal(panel.getState().connection.generation, 2);
  assert.equal(t.followCount, 2, '重连应重新订阅（真实 follow）');
  assert.ok(t.closeCount >= 1, '旧订阅应释放');
  assert.equal(panel.getState().draft?.goal, '未保存草稿', '草稿跨重连保留');
  assert.equal(t.generationSeen[t.generationSeen.length - 1], 2);
});

test('无 follow 的旧宿主回退到 snapshot 轮询，行为不变', async () => {
  const t = {
    status: async () => STATUS,
    snapshot: async () => ({ status: 'snapshot' as const, snapshot: snap(2) } as SnapshotResult),
    execute: async () => { throw new Error('not used'); },
  };
  const panel = new PanelController({ transport: t, newOperationId: () => 'op' });
  await panel.open();
  assert.equal((await panel.poll()), 'applied'); // 旧宿主回退：snapshot 读取按原语义 ingest
});
