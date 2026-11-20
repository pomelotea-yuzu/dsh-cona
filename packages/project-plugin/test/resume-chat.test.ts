// 接续聊天指针服务测试（R2 任务 3.3，design §3/§4）。
// 覆盖：指针幂等（同版本同链接不推进修订）、换链接替换、记录/链接复查、
// 索引不可读不冒充不存在、视图三态（linked/unlinked/unavailable）、
// 打开前复查（记录版本变化、链接缺失、会话不可见）。
// 临时目录放在包内 artifacts/（仓库门禁禁止 os.tmpdir 与机器绝对路径）。

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { InstanceCommandQueue } from '../src/application/command-queue.js';
import { ResumeChatService, type ResumeChatPointerView } from '../src/application/resume-chat.js';
import { resumePointersOf } from '../src/application/local-state.js';
import type { DirectorySession, SessionDirectoryPort } from '../src/application/ports.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const INSTANCE_ID = '33333333-3333-4333-8333-333333333333';
const RECORD_ID = 'record-1';
const RECORD_HASH = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LINK_A = 'link-a';
const LINK_B = 'link-b';
const SESSION_A = 'session-a';
const SESSION_B = 'session-b';

class FakeDirectory implements SessionDirectoryPort {
  sessions: DirectorySession[] = [];
  failList = false;

  async createSession(): Promise<{ sessionId: string }> {
    throw new Error('测试不创建会话');
  }

  async listSessions(): Promise<readonly DirectorySession[]> {
    if (this.failList) throw new Error('目录不可用');
    return [...this.sessions];
  }
}

function clock(): string {
  return new Date().toISOString();
}

interface FixtureOptions {
  links?: Array<{ linkId: string; sessionId: string; purpose?: string }>;
  pointers?: Array<{ recordId: string; contentHash: string; linkId: string }>;
  /** 不写聚合文件，模拟干净 profile／未登记实例。 */
  noAggregate?: boolean;
}

function makeService(options?: FixtureOptions & {
  directory?: FakeDirectory;
  findRecord?: (recordId: string) => Promise<{ contentHash: string } | null | 'unavailable'>;
}): { service: ResumeChatService; store: LocalStateStore; localRoot: string; directory: FakeDirectory } {
  const store = new LocalStateStore({ clock });
  const localRoot = mkdtempSync(path.join(artifacts, 'resume-chat-'));
  mkdirSync(localRoot, { recursive: true });
  if (options?.noAggregate !== true) {
    const dir = path.join(localRoot, 'instances', INSTANCE_ID);
    mkdirSync(dir, { recursive: true });
    const aggregate = {
      schemaVersion: 1,
      instanceId: INSTANCE_ID,
      projectId: '00000000-0000-4000-8000-000000000001',
      source: { root: '/tmp/unused', kind: 'custom', generation: 1 },
      revisions: { plan: 0, state: 0 },
      conversations: {
        links: (options?.links ?? [
          { linkId: LINK_A, sessionId: SESSION_A, purpose: '实现聊天' },
          { linkId: LINK_B, sessionId: SESSION_B, purpose: '需求聊天' },
        ]).map((link) => ({
          linkId: link.linkId,
          sessionId: link.sessionId,
          nodeIds: ['node-1'],
          purpose: link.purpose ?? '用途',
          origin: 'panel' as const,
          createdAt: clock(),
          updatedAt: clock(),
        })),
        intents: [],
      },
      workIntents: [],
      workSuggestions: [],
      workRuns: [],
      operations: [],
      lastObservation: null,
      ...(options?.pointers === undefined ? {} : { resumePointers: options.pointers }),
    };
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify(aggregate, null, 2) + '\n');
  }
  const directory = options?.directory ?? new FakeDirectory();
  if (directory.sessions.length === 0) {
    directory.sessions.push(
      { sessionId: SESSION_A, blank: false, running: false, updatedAt: 0, cwd: null },
      { sessionId: SESSION_B, blank: false, running: false, updatedAt: 0, cwd: null },
    );
  }
  const service = new ResumeChatService({
    localRoot,
    instanceId: INSTANCE_ID,
    store,
    queue: new InstanceCommandQueue(),
    clock,
    directory,
    findRecord: options?.findRecord ?? (async () => ({ contentHash: RECORD_HASH })),
  });
  return { service, store, localRoot, directory };
}

function readPointers(localRoot: string): Array<{ recordId: string; contentHash: string; linkId: string }> {
  const text = readFileSync(path.join(localRoot, 'instances', INSTANCE_ID, 'state.json'), 'utf8');
  return resumePointersOf(JSON.parse(text).resumePointers);
}

test('link 幂等：同记录同链接同版本重复请求不推进修订', async () => {
  const { service, localRoot } = makeService();
  const first = await service.link({ recordId: RECORD_ID, linkId: LINK_A });
  assert.equal(first.status, 'committed');
  if (first.status !== 'committed') return;
  assert.equal(first.value.reused, false);
  const second = await service.link({ recordId: RECORD_ID, linkId: LINK_A });
  assert.equal(second.status, 'committed');
  if (second.status !== 'committed') return;
  assert.equal(second.value.reused, true);
  assert.equal(second.stateRevision, first.stateRevision);
  const pointers = readPointers(localRoot);
  assert.equal(pointers.length, 1);
  assert.equal(pointers[0]?.linkId, LINK_A);
});

test('link 换链接：同记录重新关联即替换，不产生第二条指针', async () => {
  const { service, localRoot } = makeService({
    pointers: [{ recordId: RECORD_ID, contentHash: RECORD_HASH, linkId: LINK_A }],
  });
  const result = await service.link({ recordId: RECORD_ID, linkId: LINK_B });
  assert.equal(result.status, 'committed');
  const pointers = readPointers(localRoot);
  assert.equal(pointers.length, 1);
  assert.equal(pointers[0]?.linkId, LINK_B);
});

test('link 复查：记录不在当前已接纳索引时拒绝', async () => {
  const { service } = makeService({ findRecord: async () => null });
  const result = await service.link({ recordId: RECORD_ID, linkId: LINK_A });
  assert.equal(result.status, 'rejected');
  if (result.status !== 'rejected') return;
  assert.equal(result.code, 'record-not-found');
});

test('link 复查：索引不可读时拒绝且不冒充不存在', async () => {
  const { service } = makeService({ findRecord: async () => 'unavailable' });
  const result = await service.link({ recordId: RECORD_ID, linkId: LINK_A });
  assert.equal(result.status, 'rejected');
  if (result.status !== 'rejected') return;
  assert.equal(result.code, 'record-unknown');
});

test('link 复查：链接不存在（已解绑）时拒绝', async () => {
  const { service } = makeService({ links: [] });
  const result = await service.link({ recordId: RECORD_ID, linkId: LINK_A });
  assert.equal(result.status, 'rejected');
  if (result.status !== 'rejected') return;
  assert.equal(result.code, 'resume-link-missing');
});

test('view：指针与链接齐全且会话可见 → linked', async () => {
  const { service } = makeService({
    pointers: [{ recordId: RECORD_ID, contentHash: RECORD_HASH, linkId: LINK_A }],
  });
  const view = await service.view(RECORD_ID, RECORD_HASH);
  assert.equal(view.status, 'linked');
  if (view.status !== 'linked') return;
  assert.equal(view.sessionId, SESSION_A);
  assert.equal(view.visible, true);
});

test('view：目录不可用 → visible null（未知，不冒充失效）', async () => {
  const directory = new FakeDirectory();
  directory.failList = true;
  const { service } = makeService({
    directory,
    pointers: [{ recordId: RECORD_ID, contentHash: RECORD_HASH, linkId: LINK_A }],
  });
  const view = await service.view(RECORD_ID, RECORD_HASH);
  assert.equal(view.status, 'linked');
  if (view.status !== 'linked') return;
  assert.equal(view.visible, null);
});

test('view：无指针 → unlinked', async () => {
  const { service } = makeService();
  const view = await service.view(RECORD_ID, RECORD_HASH);
  assert.equal(view.status, 'unlinked');
});

test('view：指针版本与请求不一致 → unlinked（版本限定）', async () => {
  const { service } = makeService({
    pointers: [{ recordId: RECORD_ID, contentHash: 'sha256:other', linkId: LINK_A }],
  });
  const view = await service.view(RECORD_ID, RECORD_HASH);
  assert.equal(view.status, 'unlinked');
});

test('view：链接已删除 → unavailable（原聊天在此不可用）', async () => {
  const { service } = makeService({
    links: [],
    pointers: [{ recordId: RECORD_ID, contentHash: RECORD_HASH, linkId: LINK_A }],
  });
  const view = await service.view(RECORD_ID, RECORD_HASH);
  assert.deepEqual(view, { status: 'unavailable', reason: 'resume-link-missing' } satisfies ResumeChatPointerView);
});

test('view：聚合缺失（干净 profile）→ unavailable，卡片摘要不受影响', async () => {
  const { service } = makeService({ noAggregate: true });
  const view = await service.view(RECORD_ID, RECORD_HASH);
  assert.equal(view.status, 'unavailable');
  if (view.status !== 'unavailable') return;
  assert.equal(view.reason, 'binding-expired');
});

test('resolveTarget：齐全且会话可见 → ok 返回确切 Session', async () => {
  const { service } = makeService({
    pointers: [{ recordId: RECORD_ID, contentHash: RECORD_HASH, linkId: LINK_B }],
  });
  const result = await service.resolveTarget({ recordId: RECORD_ID, contentHash: RECORD_HASH, linkId: LINK_B });
  assert.equal(result.status, 'ok');
  if (result.status !== 'ok') return;
  assert.equal(result.sessionId, SESSION_B);
});

test('resolveTarget：记录版本已变化 → record-version-changed', async () => {
  const { service } = makeService({
    pointers: [{ recordId: RECORD_ID, contentHash: 'sha256:older', linkId: LINK_A }],
  });
  const result = await service.resolveTarget({ recordId: RECORD_ID, contentHash: RECORD_HASH, linkId: LINK_A });
  assert.equal(result.status, 'rejected');
  if (result.status !== 'rejected') return;
  assert.equal(result.code, 'record-version-changed');
});

test('resolveTarget：linkId 与指针不符 → resume-pointer-missing', async () => {
  const { service } = makeService({
    pointers: [{ recordId: RECORD_ID, contentHash: RECORD_HASH, linkId: LINK_A }],
  });
  const result = await service.resolveTarget({ recordId: RECORD_ID, contentHash: RECORD_HASH, linkId: LINK_B });
  assert.equal(result.status, 'rejected');
  if (result.status !== 'rejected') return;
  assert.equal(result.code, 'resume-pointer-missing');
});

test('resolveTarget：会话不可见（已删除）→ session-not-visible', async () => {
  const directory = new FakeDirectory();
  directory.sessions = [{ sessionId: SESSION_A, blank: false, running: false, updatedAt: 0, cwd: null }];
  const { service } = makeService({
    directory,
    pointers: [{ recordId: RECORD_ID, contentHash: RECORD_HASH, linkId: LINK_B }],
  });
  const result = await service.resolveTarget({ recordId: RECORD_ID, contentHash: RECORD_HASH, linkId: LINK_B });
  assert.equal(result.status, 'rejected');
  if (result.status !== 'rejected') return;
  assert.equal(result.code, 'session-not-visible');
});

test('link：旧聚合无 resumePointers 字段归一化为空', async () => {
  const { service, localRoot } = makeService();
  // 先删掉指针字段模拟旧聚合（fixture 默认不含 resumePointers）。
  const result = await service.link({ recordId: RECORD_ID, linkId: LINK_A });
  assert.equal(result.status, 'committed');
  const pointers = readPointers(localRoot);
  assert.equal(pointers.length, 1);
});

test('view：干净 profile（记录 savedAt 早于本机登记时刻）→ unavailable pointer-not-here', async () => {
  const { service, localRoot } = makeService({ noAggregate: true });
  // 干净 home 启动会自动登记新实例：registry.json 里有晚于记录保存时刻的 createdAt。
  mkdirSync(localRoot, { recursive: true });
  const createdAt = new Date(Date.now() + 60_000).toISOString();
  writeFileSync(path.join(localRoot, 'registry.json'), JSON.stringify({
    schemaVersion: 1,
    instances: [{ instanceId: INSTANCE_ID, projectId: 'p', sourceRoot: '/tmp/unused', sourceKind: 'custom', sourceGeneration: 1, createdAt, updatedAt: createdAt }],
  }, null, 2) + '\n');
  // 聚合缺失 → binding-expired 优先于 savedAt 判据（指针态无从谈起）。
  const view1 = await service.view(RECORD_ID, RECORD_HASH, '2026-11-20T00:00:00Z');
  assert.equal(view1.status, 'unavailable');
  // 有聚合但无指针、登记晚于保存 → 记录来自其他环境。
  const localRoot2 = mkdtempSync(path.join(artifacts, 'resume-chat-clean-'));
  mkdirSync(localRoot2, { recursive: true });
  const dir2 = path.join(localRoot2, 'instances', INSTANCE_ID);
  mkdirSync(dir2, { recursive: true });
  writeFileSync(path.join(dir2, 'state.json'), JSON.stringify({
    schemaVersion: 1, instanceId: INSTANCE_ID, projectId: 'p',
    source: { root: '/tmp/unused', kind: 'custom', generation: 1 },
    revisions: { plan: 0, state: 0 },
    conversations: { links: [], intents: [] },
    workIntents: [], workSuggestions: [], workRuns: [], operations: [], lastObservation: null,
  }, null, 2) + '\n');
  writeFileSync(path.join(localRoot2, 'registry.json'), JSON.stringify({
    schemaVersion: 1,
    instances: [{ instanceId: INSTANCE_ID, projectId: 'p', sourceRoot: '/tmp/unused', sourceKind: 'custom', sourceGeneration: 1, createdAt, updatedAt: createdAt }],
  }, null, 2) + '\n');
  const store2 = new LocalStateStore({ clock });
  const service2 = new ResumeChatService({
    localRoot: localRoot2, instanceId: INSTANCE_ID, store: store2,
    queue: new InstanceCommandQueue(), clock, directory: new FakeDirectory(),
    findRecord: async () => ({ contentHash: RECORD_HASH }),
  });
  const view2 = await service2.view(RECORD_ID, RECORD_HASH, '2026-11-20T00:00:00Z');
  assert.deepEqual(view2, { status: 'unavailable', reason: 'pointer-not-here' });
});

test('view：本机保存的记录（savedAt 晚于登记时刻）未选聊天 → unlinked', async () => {
  const { service, localRoot } = makeService();
  const createdAt = new Date(Date.now() - 600_000).toISOString();
  writeFileSync(path.join(localRoot, 'registry.json'), JSON.stringify({
    schemaVersion: 1,
    instances: [{ instanceId: INSTANCE_ID, projectId: 'p', sourceRoot: '/tmp/unused', sourceKind: 'custom', sourceGeneration: 1, createdAt, updatedAt: createdAt }],
  }, null, 2) + '\n');
  const view = await service.view(RECORD_ID, RECORD_HASH, new Date().toISOString());
  assert.equal(view.status, 'unlinked');
});
