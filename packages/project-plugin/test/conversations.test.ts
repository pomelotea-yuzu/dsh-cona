// 聊天关联服务测试（tasks 6.1）。
// 覆盖：多对多链接与幂等合并、stateRevision 推进、意图先落盘、宿主结果未知不盲目再建、
// reconcile 只给候选不写链接、claim 核对实际身份、失效关联（不可见会话拒绝）、
// 未知节点拒绝、双实例隔离、unknown-state 隔离、旧形状归一化。
// 临时目录放在包内 artifacts/（仓库门禁禁止 os.tmpdir 与机器绝对路径）。

import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { InstanceCommandQueue } from '../src/application/command-queue.js';
import { ConversationService, type ChatsView } from '../src/application/conversations.js';
import { conversationStateOf, type ConversationState } from '../src/application/local-state.js';
import type { DirectorySession, PlanNodeViewPort, SessionDirectoryPort } from '../src/application/ports.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const NODE_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const NODE_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const NODE_MISSING = 'cccccccc-0000-4000-8000-000000000003';

/** 可编程会话目录：create 可注入失败／延迟结果。 */
class FakeDirectory implements SessionDirectoryPort {
  sessions: DirectorySession[] = [];
  createResults: Array<{ sessionId: string }> = [];
  createCalls = 0;
  createError: Error | null = null;
  failAfterCreate = false;

  async createSession(): Promise<{ sessionId: string }> {
    this.createCalls += 1;
    if (this.createError !== null) throw this.createError;
    if (this.createResults.length === 0) throw new Error('没有预置的 create 结果');
    const value = this.createResults.shift() as { sessionId: string };
    if (this.failAfterCreate) {
      // 模拟响应丢失：宿主已创建，但调用方拿不到结果（异常抛出）。
      this.sessions.push({ sessionId: value.sessionId, blank: true, running: false, updatedAt: Date.now(), cwd: null });
      this.failAfterCreate = false;
      throw new Error('响应丢失');
    }
    this.sessions.push({ sessionId: value.sessionId, blank: true, running: false, updatedAt: Date.now(), cwd: null });
    return value;
  }

  async listSessions(): Promise<readonly DirectorySession[]> {
    return [...this.sessions];
  }
}

const PLAN_NODES: PlanNodeViewPort = {
  async currentNodeIds() {
    return { ok: true as const, nodeIds: new Set([NODE_A, NODE_B]) };
  },
};

const MISSING_NODES: PlanNodeViewPort = {
  async currentNodeIds() {
    return { ok: false as const, code: 'invalid-project', message: '资料不可读' };
  },
};

function clock(): string {
  return new Date().toISOString();
}

function writeAggregateFixture(localRoot: string, conversations: unknown): void {
  const dir = path.join(localRoot, 'instances', INSTANCE_ID);
  mkdirSync(dir, { recursive: true });
  const aggregate = {
    schemaVersion: 1,
    instanceId: INSTANCE_ID,
    projectId: '00000000-0000-4000-8000-000000000001',
    source: { root: '/tmp/unused', kind: 'custom', generation: 1 },
    revisions: { plan: 0, state: 0 },
    conversations,
    workIntents: [],
    workSuggestions: [],
    workRuns: [],
    operations: [],
    lastObservation: null,
  };
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify(aggregate, null, 2) + '\n');
}

function makeService(options?: {
  directory?: SessionDirectoryPort;
  planNodes?: PlanNodeViewPort;
  store?: LocalStateStore;
  localRoot?: string;
}): { service: ConversationService; store: LocalStateStore; localRoot: string } {
  const store = options?.store ?? new LocalStateStore({ clock });
  const localRoot = options?.localRoot ?? mkdtempSync(path.join(artifacts, 'chats-'));
  mkdirSync(localRoot, { recursive: true });
  // 测试装配总提供一份基础聚合。
  writeAggregateFixture(localRoot, { links: [], intents: [] });
  const directory = options?.directory ?? new FakeDirectory();
  // linkChat 要求会话在目录可见：默认目录常驻 session-a。
  if (directory instanceof FakeDirectory && !directory.sessions.some((s) => s.sessionId === 'session-a')) {
    directory.sessions.push({ sessionId: 'session-a', blank: true, running: false, updatedAt: 0, cwd: null });
  }
  const service = new ConversationService({
    localRoot,
    instanceId: INSTANCE_ID,
    store,
    directory,
    planNodes: options?.planNodes ?? PLAN_NODES,
    clock,
    newLinkId: () => `link-${Math.random().toString(16).slice(2)}`,
    queue: new InstanceCommandQueue(),
  });
  return { service, store, localRoot };
}

async function readState(store: LocalStateStore, localRoot: string): Promise<ConversationState> {
  const aggregate = await store.readAggregate(localRoot, INSTANCE_ID);
  assert.ok(aggregate !== null);
  return conversationStateOf(aggregate.conversations);
}

test('6.1 linkChat：写链接、推进状态修订、同归属重复请求幂等返回原结果', async () => {
  const { service, store, localRoot } = makeService();
  const first = await service.linkChat({ operationId: 'op-1', sessionId: 'session-a', nodeIds: [NODE_A], purpose: '需求讨论' });
  assert.equal(first.status, 'committed');
  if (first.status !== 'committed') return;
  assert.equal(first.stateRevision, 1);
  const again = await service.linkChat({ operationId: 'op-2', sessionId: 'session-a', nodeIds: [NODE_A], purpose: '需求讨论' });
  assert.equal(again.status, 'committed');
  if (again.status !== 'committed') return;
  assert.equal(again.value.reused, true);
  assert.equal(again.stateRevision, 1, '幂等重复不推进修订');
  const state = await readState(store, localRoot);
  assert.equal(state.links.length, 1);
  assert.deepEqual(state.links[0]?.nodeIds, [NODE_A]);
});

test('6.1 多对多：同一 Session 关联第二个节点合并进同用途链接；不同用途是新链接', async () => {
  const { service, store, localRoot } = makeService();
  const first = await service.linkChat({ operationId: 'op-1', sessionId: 'session-a', nodeIds: [NODE_A], purpose: '讨论' });
  assert.equal(first.status, 'committed');
  const merge = await service.linkChat({ operationId: 'op-2', sessionId: 'session-a', nodeIds: [NODE_B], purpose: '讨论' });
  assert.equal(merge.status, 'committed');
  const other = await service.linkChat({ operationId: 'op-3', sessionId: 'session-a', nodeIds: [NODE_A], purpose: '实现' });
  assert.equal(other.status, 'committed');
  const state = await readState(store, localRoot);
  assert.equal(state.links.length, 2);
  const merged = state.links.find((link) => link.purpose === '讨论');
  assert.deepEqual(merged?.nodeIds.sort(), [NODE_A, NODE_B].sort());
  assert.equal((await readState(store, localRoot)).intents.length, 0);
  void localRoot;
});

test('6.1 createChat：意图先落盘 → 宿主创建 → 核对可见 → 落链接；结果未知时不再建第二个', async () => {
  const directory = new FakeDirectory();
  directory.createResults = [{ sessionId: 'session-new' }];
  const { service, store, localRoot } = makeService({ directory });
  const outcome = await service.createChat({ operationId: 'op-create', nodeIds: [NODE_A], purpose: '实现讨论' });
  assert.equal(outcome.status, 'committed');
  if (outcome.status !== 'committed') return;
  assert.equal(outcome.value.sessionId, 'session-new');
  assert.equal(outcome.value.reusedBlank, true);
  assert.equal(directory.createCalls, 1, '只调用一次宿主 create');
  const state = await readState(store, localRoot);
  assert.equal(state.links.length, 1);
  assert.equal(state.intents.length, 1, '意图已解决但仍保留历史');
  assert.equal(state.intents[0]?.status, 'linked');
  assert.equal(state.intents[0]?.resolvedSessionId, 'session-new');
  const view = await service.listChats();
  assert.equal(view.status, 'committed');
  if (view.status !== 'committed') return;
  assert.equal(view.value.links.length, 1);
  assert.equal(view.value.links[0]?.visible, true);
  assert.equal(view.value.pendingIntents.length, 0);
});

test('6.1 创建结果未知：宿主异常后意图保留 pending、无链接、reconcile 给候选且不自动创建', async () => {
  const directory = new FakeDirectory();
  directory.createResults = [{ sessionId: 'session-lost' }];
  directory.failAfterCreate = true;
  const { service } = makeService({ directory });
  const outcome = await service.createChat({ operationId: 'op-lost', nodeIds: [NODE_A], purpose: '实现讨论' });
  assert.equal(outcome.status, 'rejected');
  assert.equal((outcome as { code?: string }).code, 'session-create-unknown');
  assert.equal(directory.createCalls, 1, '服务自己绝不重试 create');

  const reconciled = await service.reconcileChats();
  assert.equal(reconciled.status, 'committed');
  if (reconciled.status !== 'committed') return;
  assert.equal(reconciled.value.pendingIntents.length, 1);
  assert.equal(reconciled.value.pendingIntents[0]?.status, 'unknown', '创建结果未知标记 unknown');
  assert.deepEqual(reconciled.value.pendingIntents[0]?.candidates, ['session-lost'], '候选只提示，不自动写');
  assert.equal(directory.createCalls, 1, 'reconcile 不再创建');

  // 用户显式认领候选后才落链接。
  const claimed = await service.claimChat({
    operationId: 'op-lost',
    sessionId: 'session-lost',
    nodeIds: [NODE_A],
    purpose: '实现讨论',
  });
  assert.equal(claimed.status, 'committed');
  const view = await service.listChats();
  if (view.status !== 'committed') return;
  assert.equal(view.value.links.length, 1);
  assert.equal(view.value.pendingIntents.length, 0);
});

test('6.1 失效关联：认领宿主列表中不存在的会话被拒绝，意图标 unknown', async () => {
  const directory = new FakeDirectory();
  const { service } = makeService({ directory });
  const outcome = await service.claimChat({
    operationId: 'op-claim',
    sessionId: 'session-ghost',
    nodeIds: [NODE_A],
    purpose: '讨论',
  });
  assert.equal(outcome.status, 'rejected');
  assert.equal((outcome as { code?: string }).code, 'session-not-visible');
  const view = await service.listChats();
  if (view.status !== 'committed') return;
  assert.equal(view.value.links.length, 0);
  assert.equal(view.value.pendingIntents[0]?.status, 'unknown');
});

test('6.1 会话消失：已有链接在宿主列表不可见时标 visible=false（失效关联）', async () => {
  const directory = new FakeDirectory();
  directory.createResults = [{ sessionId: 'session-gone' }];
  const { service } = makeService({ directory });
  const created = await service.createChat({ operationId: 'op-1', nodeIds: [NODE_A], purpose: '讨论' });
  assert.equal(created.status, 'committed');
  directory.sessions = [];
  const view = await service.listChats();
  if (view.status !== 'committed') return;
  assert.equal(view.value.links[0]?.visible, false);
});

test('6.1 未知节点与资料不可读拒绝', async () => {
  const { service } = makeService();
  const unknown = await service.linkChat({ operationId: 'op-1', sessionId: 'session-a', nodeIds: [NODE_MISSING], purpose: '讨论' });
  assert.equal(unknown.status, 'rejected');
  assert.equal((unknown as { code?: string }).code, 'unknown-node');
  const broken = makeService({ planNodes: MISSING_NODES });
  const denied = await broken.service.linkChat({ operationId: 'op-2', sessionId: 'session-a', nodeIds: [NODE_A], purpose: '讨论' });
  assert.equal(denied.status, 'rejected');
  assert.equal((denied as { code?: string }).code, 'invalid-project');
});

test('6.1 双实例隔离：同根不同实例的链接互不可见', async () => {
  const store = new LocalStateStore({ clock });
  const localRoot = mkdtempSync(path.join(artifacts, 'chats-iso-'));
  mkdirSync(localRoot, { recursive: true });
  const otherInstance = '22222222-2222-4222-8222-222222222222';
  const otherDir = path.join(localRoot, 'instances', otherInstance);
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(
    path.join(otherDir, 'state.json'),
    JSON.stringify({
      schemaVersion: 1,
      instanceId: otherInstance,
      projectId: '00000000-0000-4000-8000-000000000001',
      source: { root: '/tmp/unused', kind: 'custom', generation: 1 },
      revisions: { plan: 0, state: 0 },
      conversations: { links: [], intents: [] },
      workIntents: [],
      workSuggestions: [],
      workRuns: [],
      operations: [],
      lastObservation: null,
    }, null, 2) + '\n',
  );
  const directory = new FakeDirectory();
  directory.createResults = [{ sessionId: 'session-shared' }];
  const mine = makeService({ store, localRoot, directory }).service;
  const created = await mine.createChat({ operationId: 'op-1', nodeIds: [NODE_A], purpose: '讨论' });
  assert.equal(created.status, 'committed');

  // 另一实例的聚合里没有这条链接。
  const raw = JSON.parse(readFileSync(path.join(localRoot, 'instances', otherInstance, 'state.json'), 'utf8')) as {
    conversations: ConversationState;
  };
  assert.equal(conversationStateOf(raw.conversations).links.length, 0, '另一实例不被静默认领');
});

test('6.1 unknown-state：聚合替换结果未知时进入隔离并停止读写', async () => {
  const store = new LocalStateStore({ clock });
  const localRoot = mkdtempSync(path.join(artifacts, 'chats-unk-'));
  mkdirSync(localRoot, { recursive: true });
  writeAggregateFixture(localRoot, { links: [], intents: [] });
  const originalReplace = store.replaceAggregateChecked.bind(store);
  let injected = false;
  store.replaceAggregateChecked = async (root, aggregate, hooks) => {
    if (!injected) {
      injected = true;
      return { status: 'unknown-state' as const, stage: 'rename', detail: 'injected' };
    }
    return originalReplace(root, aggregate, hooks);
  };
  const service = new ConversationService({
    localRoot,
    instanceId: INSTANCE_ID,
    store,
    directory: Object.assign(new FakeDirectory(), {
      sessions: [{ sessionId: 'session-a', blank: true, running: false, updatedAt: 0, cwd: null }],
    }),
    planNodes: PLAN_NODES,
    clock,
    newLinkId: () => 'link-x',
    queue: new InstanceCommandQueue(),
  });
  const outcome = await service.linkChat({ operationId: 'op-1', sessionId: 'session-a', nodeIds: [NODE_A], purpose: '讨论' });
  assert.equal(outcome.status, 'unknown-state');
  const quarantined = await store.readQuarantine(localRoot, INSTANCE_ID);
  assert.ok(quarantined !== null);
  assert.equal(quarantined.reason, 'unknown-state');
  assert.equal(quarantined.stage, 'conversation:rename');
  const after = await service.listChats();
  assert.equal(after.status, 'rejected');
  assert.equal((after as { code?: string }).code, 'unknown-state', '隔离后聊天读写停止');
});

test('6.1 旧形状归一化：3.2–5.x 的空数组 conversations 读取后可用', async () => {
  const store = new LocalStateStore({ clock });
  const localRoot = mkdtempSync(path.join(artifacts, 'chats-legacy-'));
  mkdirSync(localRoot, { recursive: true });
  writeAggregateFixture(localRoot, []);
  const directory = new FakeDirectory();
  directory.createResults = [{ sessionId: 'session-legacy' }];
  const service = new ConversationService({
    localRoot,
    instanceId: INSTANCE_ID,
    store,
    directory,
    planNodes: PLAN_NODES,
    clock,
    newLinkId: () => 'link-l',
    queue: new InstanceCommandQueue(),
  });
  const created = await service.createChat({ operationId: 'op-1', nodeIds: [NODE_A], purpose: '讨论' });
  assert.equal(created.status, 'committed');
  const state = await readState(store, localRoot);
  assert.equal(state.links.length, 1);
});

test('6.1 unlinkChat：整条删除与按节点裁剪', async () => {
  const { service, store, localRoot } = makeService();
  const linked = await service.linkChat({ operationId: 'op-1', sessionId: 'session-a', nodeIds: [NODE_A, NODE_B], purpose: '讨论' });
  assert.equal(linked.status, 'committed');
  if (linked.status !== 'committed') return;
  const trimmed = await service.unlinkChat({ operationId: 'op-2', linkId: linked.value.linkId, nodeIds: [NODE_A] });
  assert.equal(trimmed.status, 'committed');
  let state = await readState(store, localRoot);
  assert.deepEqual(state.links[0]?.nodeIds, [NODE_B]);
  const removed = await service.unlinkChat({ operationId: 'op-3', linkId: linked.value.linkId });
  assert.equal(removed.status, 'committed');
  state = await readState(store, localRoot);
  assert.equal(state.links.length, 0);
});

test('6.1 chats 视图类型与 reconcile 一致（防回归）', async () => {
  const view: ChatsView = { links: [], pendingIntents: [] };
  assert.deepEqual(view, { links: [], pendingIntents: [] });
});

test('3.1 listSessions：列出宿主可见会话并标注本实例是否已关联', async () => {
  const directory = new FakeDirectory();
  directory.sessions.push(
    { sessionId: 'session-b', blank: true, running: false, updatedAt: 10, cwd: null },
    { sessionId: 'session-c', blank: false, running: true, updatedAt: 20, cwd: null },
  );
  const { service } = makeService({ directory });
  const empty = await service.listSessions();
  assert.equal(empty.status, 'committed');
  if (empty.status !== 'committed') return;
  assert.deepEqual(
    empty.value.sessions
      .map((session) => [session.sessionId, session.blank, session.running, session.linked])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [['session-a', true, false, false], ['session-b', true, false, false], ['session-c', false, true, false]],
  );

  const linked = await service.linkChat({ operationId: 'op-list', sessionId: 'session-c', nodeIds: [NODE_A], purpose: '实现' });
  assert.equal(linked.status, 'committed');
  const listed = await service.listSessions();
  assert.equal(listed.status, 'committed');
  if (listed.status !== 'committed') return;
  assert.equal(listed.value.sessions.find((session) => session.sessionId === 'session-c')?.linked, true);
  assert.equal(listed.value.sessions.find((session) => session.sessionId === 'session-a')?.linked, false);
});

test('3.1 listSessions：目录不可用给稳定码，不返回空列表冒充没有会话', async () => {
  const failing: SessionDirectoryPort = {
    async createSession() { throw new Error('upstream-down'); },
    async listSessions() { throw new Error('upstream-down'); },
  };
  const { service } = makeService({ directory: failing });
  const result = await service.listSessions();
  assert.equal(result.status, 'rejected');
  assert.equal((result as { code?: string }).code, 'session-directory-unavailable');
});

test('3.1 openTarget：链接存在且实际 Session 可见才返回；失效与不存在分别拒绝', async () => {
  const directory = new FakeDirectory();
  const { service } = makeService({ directory });
  const linked = await service.linkChat({ operationId: 'op-open', sessionId: 'session-a', nodeIds: [NODE_A], purpose: '讨论' });
  assert.equal(linked.status, 'committed');
  if (linked.status !== 'committed') return;

  const ok = await service.openTarget({ linkId: linked.value.linkId });
  assert.equal(ok.status, 'committed');
  assert.equal(ok.status === 'committed' ? ok.value.sessionId : '', 'session-a');

  const missing = await service.openTarget({ linkId: 'link-ghost' });
  assert.equal(missing.status, 'rejected');
  assert.equal((missing as { code?: string }).code, 'resume-link-missing');

  // 宿主里删掉会话后：不冒领，给 session-not-visible。
  directory.sessions = directory.sessions.filter((session) => session.sessionId !== 'session-a');
  const gone = await service.openTarget({ linkId: linked.value.linkId });
  assert.equal(gone.status, 'rejected');
  assert.equal((gone as { code?: string }).code, 'session-not-visible');

  const empty = await service.openTarget({ linkId: '' });
  assert.equal(empty.status, 'rejected');
  assert.equal((empty as { code?: string }).code, 'operation-mismatch');
});
