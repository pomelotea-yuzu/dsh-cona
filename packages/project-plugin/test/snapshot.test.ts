// 完整快照与“先订阅再回读”协议测试（tasks 5.1）。
// 覆盖：完整小树／记录索引／摘要一致；读取中变更重读；混合资料拒绝；
// 已知最高修订追读与上限；先订阅再回读与源代际替换；隔离与访问判据。
// 临时目录放在包内 artifacts/。

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalStateService } from '../src/application/local-state.js';
import { readSourceBaseline } from '../src/application/baseline.js';
import {
  InMemoryChangeStream,
  notificationForCommit,
  notificationForRefresh,
} from '../src/application/change-stream.js';
import {
  ProjectSnapshotService,
  summarizePlan,
  type SnapshotResult,
  type StreamEventView,
} from '../src/application/snapshot.js';
import {
  ProjectCommandService,
  type Command,
  type CommandEnvelope,
  type TrustedContext,
} from '../src/application/command-service.js';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { createSourceFiles } from '../src/adapters/fs/source-files.js';
import { resolveLocalRoot, rootRelation } from '../src/adapters/fs/local-root.js';
import { inspectPrivateRoot } from '../src/adapters/fs/git-guard.js';
import { computePlanVersion } from '../src/domain/canonical/plan-fingerprint.js';
import type { ProjectDocument, Sha256Fn } from '../src/domain/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sample = path.join(packageRoot, 'formats', 'v1', 'sample-project.json');
const formatsDir = path.join(packageRoot, 'formats', 'v1');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');
const clock = (): string => new Date().toISOString();
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const ROOT_NODE = '00000000-0000-4000-8000-000000000002';
const OWNER: TrustedContext = { kind: 'remote-owner' };

interface Ctx {
  localRoot: string;
  source: string;
  instanceId: string;
  stream: InMemoryChangeStream;
  planVersion: () => string;
  envelope: (command: Command) => CommandEnvelope;
}

async function setup(name: string): Promise<Ctx> {
  const base = mkdtempSync(path.join(artifacts, name));
  const localRoot = path.join(base, 'local');
  const source = path.join(base, 'source');
  mkdirSync(source, { recursive: true });
  copyFileSync(sample, path.join(source, 'project.json'));

  const stream = new InMemoryChangeStream();
  const localState = new LocalStateService({
    resolver: { resolveLocal: resolveLocalRoot, relation: rootRelation },
    git: { inspect: inspectPrivateRoot },
    store: new LocalStateStore(),
    clock,
    newInstanceId: () => randomUUID(),
    notify: ({ entry, aggregate }) =>
      stream.publish(
        notificationForRefresh(
          {
            instanceId: entry.instanceId,
            projectId: entry.projectId,
            sourceEpoch: entry.sourceGeneration,
            stateRevision: aggregate.revisions.state,
            planRevision: aggregate.revisions.plan,
          },
          clock(),
        ),
      ),
  });
  const registered = await localState.register({
    localDataRoot: localRoot,
    sourceRoot: source,
    sourceKind: 'custom',
    projectId: PROJECT_ID,
  });
  if (!registered.ok) throw new Error('register failed');
  const instanceId = registered.entry.instanceId;
  return {
    localRoot,
    source,
    instanceId,
    stream,
    planVersion: () =>
      (JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as { planVersion: string }).planVersion,
    envelope: (command) => ({
      operationId: randomUUID(),
      projectId: PROJECT_ID,
      instanceId,
      sourceEpoch: registered.entry.sourceGeneration,
      expectedPlanVersion: (JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as {
        planVersion: string;
      }).planVersion,
      expectedPlanRevision: 0,
      command,
    }),
  };
}

function snapshots(ctx: Ctx): ProjectSnapshotService {
  return buildSnapshotService(ctx);
}

function buildSnapshotService(
  ctx: Ctx,
  hooks?: { beforeBaselineRead?: (attempt: number) => void | Promise<void>; beforeSecondAggregateRead?: (attempt: number) => void | Promise<void> },
  maxAttempts?: number,
): ProjectSnapshotService {
  return new ProjectSnapshotService({
    localRoot: ctx.localRoot,
    store: new LocalStateStore(),
    files: createSourceFiles(formatsDir, sha256),
    sha256,
    clock,
    stream: ctx.stream,
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
    ...(hooks === undefined ? {} : { hooks }),
  });
}

function commands(ctx: Ctx): ProjectCommandService {
  return new ProjectCommandService({
    localRoot: ctx.localRoot,
    store: new LocalStateStore(),
    files: createSourceFiles(formatsDir, sha256),
    sha256,
    clock,
    newNodeId: () => randomUUID(),
    newRecordId: () => randomUUID(),
    notify: (result, envelope) =>
      ctx.stream.publish(notificationForCommit({ instanceId: envelope.instanceId, projectId: envelope.projectId }, result, clock())),
  });
}

function expectSnapshot(result: SnapshotResult) {
  if (result.status !== 'snapshot') throw new Error(`期望快照，实际 ${JSON.stringify(result)}`);
  return result.snapshot;
}

/**
 * 模拟外部编辑：改写资料并重算规划指纹，保证资料仍合法。
 * 不重算指纹会被领域校验判 `plan-version-mismatch`，那是另一条路径。
 */
function rewriteSource(source: string, mutate: (doc: ProjectDocument) => void): void {
  const doc = JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as ProjectDocument;
  mutate(doc);
  const planVersion = computePlanVersion(doc, sha256).planVersion;
  writeFileSync(path.join(source, 'project.json'), JSON.stringify({ ...doc, planVersion }, null, 2) + '\n');
}

/** 读取流事件；超时视为失败，避免实现缺陷把测试挂死。 */
async function takeEvents(events: AsyncIterable<StreamEventView>, count: number): Promise<StreamEventView[]> {
  const out: StreamEventView[] = [];
  const iterator = events[Symbol.asyncIterator]();
  for (let index = 0; index < count; index += 1) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<StreamEventView>>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('订阅流等待超时')), 2000);
        timer.unref?.();
      }),
    ]);
    if (next.done === true) break;
    out.push(next.value);
  }
  return out;
}

test('快照包含完整小树、记录索引与同源摘要', async () => {
  const ctx = await setup('snap-basic-');
  const followed = await snapshots(ctx).follow(OWNER, { instanceId: ctx.instanceId });
  assert.equal(followed.status, 'following');
  if (followed.status !== 'following') return;
  assert.equal(followed.ready.kind, 'ready');
  assert.equal(followed.ready.sourceEpoch, 1);
  assert.equal(followed.ready.stateRevision, 0);

  // 先提交一条记录，用于核对索引与摘要计数同源。
  const appended = await commands(ctx).execute(
    OWNER,
    ctx.envelope({
      type: 'append-record',
      kind: 'analysis-note',
      subjectNodeIds: [ROOT_NODE],
      summary: '结论',
      sources: [],
      body: '# 正文\n',
    }),
  );
  assert.equal(appended.status, 'committed', JSON.stringify(appended));

  const bytesBefore = readFileSync(path.join(ctx.source, 'project.json'));
  const stateBefore = readFileSync(path.join(ctx.localRoot, 'instances', ctx.instanceId, 'state.json'));

  const snapshot = expectSnapshot(
    await snapshots(ctx).read(OWNER, {
      instanceId: ctx.instanceId,
      connectionGeneration: followed.connectionGeneration,
      minStateRevision: followed.ready.stateRevision,
    }),
  );

  assert.equal(snapshot.projectId, PROJECT_ID);
  assert.equal(snapshot.instanceId, ctx.instanceId);
  assert.equal(snapshot.sourceEpoch, 1);
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.planVersion, ctx.planVersion());
  assert.equal(snapshot.planRevision, 0, '记录命令不推进规划修订');
  assert.equal(snapshot.stateRevision, 1);
  assert.equal(snapshot.sync.status, 'synced');
  assert.equal(snapshot.sync.basis, 'local-observation', '提交后本机已有观察基线');
  assert.equal(snapshot.source.kind, 'custom');
  assert.equal(snapshot.source.displayPath, ctx.source, '缺省显示资料根绝对路径');
  assert.equal(snapshot.local.conversationCount, 0);
  assert.equal(snapshot.local.workRunCount, 0);

  assert.equal(snapshot.tree.length, 2);
  assert.equal(snapshot.tree[0]?.id, ROOT_NODE);
  assert.equal(snapshot.tree[1]?.parentId, ROOT_NODE, '父节点必须先于子节点');
  assert.equal(snapshot.tree[1]?.id, '00000000-0000-4000-8000-000000000003', 'DFS 顺序稳定');

  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0]?.kind, 'analysis-note');
  assert.match(snapshot.records[0]?.contentHash ?? '', /^sha256:[0-9a-f]{64}$/);

  // 摘要必须由同一份树与记录派生。
  assert.deepEqual(
    snapshot.summary,
    summarizePlan(snapshot.tree, snapshot.dependencies, snapshot.records),
    '摘要与快照同源',
  );
  assert.equal(snapshot.summary.nodeCount, snapshot.tree.length);
  assert.equal(snapshot.summary.rootCount, 1);
  assert.equal(snapshot.summary.maxDepth, 2);
  assert.equal(snapshot.summary.dependencyCount, 1);
  assert.equal(snapshot.summary.statusCounts['todo'], 2);
  assert.equal(snapshot.summary.recordCount, snapshot.records.length);
  assert.equal(snapshot.summary.recordsByKind['analysis-note'], 1);

  assert.deepEqual(readFileSync(path.join(ctx.source, 'project.json')), bytesBefore, '快照不得写资料');
  assert.deepEqual(
    readFileSync(path.join(ctx.localRoot, 'instances', ctx.instanceId, 'state.json')),
    stateBefore,
    '快照不得写聚合',
  );
  followed.close();
});

test('读取中提交：重读后返回单一版本，不混合新旧', async () => {
  const ctx = await setup('snap-concurrent-');
  const followed = await snapshots(ctx).follow(OWNER, { instanceId: ctx.instanceId });
  if (followed.status !== 'following') throw new Error('follow failed');

  let injected = 0;
  const service = buildSnapshotService(ctx, {
    beforeSecondAggregateRead: async (attempt) => {
      if (attempt !== 1) return;
      injected += 1;
      const result = await commands(ctx).execute(
        OWNER,
        ctx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '读取中提交的目标' } }),
      );
      assert.equal(result.status, 'committed', JSON.stringify(result));
    },
  });

  const snapshot = expectSnapshot(
    await service.read(OWNER, { instanceId: ctx.instanceId, connectionGeneration: followed.connectionGeneration }),
  );
  assert.equal(injected, 1);
  assert.equal(snapshot.stateRevision, 1, '返回提交后的修订，而不是起始修订');
  assert.equal(snapshot.planRevision, 1);
  assert.equal(snapshot.planVersion, ctx.planVersion(), 'planVersion 与磁盘一致');
  assert.equal(snapshot.tree[0]?.goal, '读取中提交的目标', '内容与修订来自同一版');
  assert.equal(snapshot.sync.status, 'synced');
  followed.close();
});

test('混合资料：正文被改写或 schema 未知时拒绝返回半截快照', async () => {
  const ctx = await setup('snap-mixed-');
  const appended = await commands(ctx).execute(
    OWNER,
    ctx.envelope({
      type: 'append-record',
      kind: 'analysis-note',
      subjectNodeIds: [ROOT_NODE],
      summary: '待改正文',
      sources: [],
      body: '# 原始正文\n',
    }),
  );
  assert.equal(appended.status, 'committed');
  const recordPath = appended.status === 'committed' ? appended.recordPath : undefined;
  assert.ok(recordPath);
  const bodyFile = path.join(ctx.source, recordPath as string);
  writeFileSync(bodyFile, '# 被外部改写\n');

  const mixed = await snapshots(ctx).read(OWNER, { instanceId: ctx.instanceId, connectionGeneration: 1 });
  assert.equal(mixed.status, 'rejected', JSON.stringify(mixed));
  assert.equal(mixed.status === 'rejected' ? mixed.code : '', 'body-hash-mismatch');

  // 恢复正文后改为未知 schema：仍拒绝，且码为 unsupported-format。
  writeFileSync(bodyFile, '# 原始正文\n');
  const head = JSON.parse(readFileSync(path.join(ctx.source, 'project.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(path.join(ctx.source, 'project.json'), JSON.stringify({ ...head, schemaVersion: 2 }, null, 2));
  const unsupported = await snapshots(ctx).read(OWNER, { instanceId: ctx.instanceId, connectionGeneration: 1 });
  assert.equal(unsupported.status, 'rejected', JSON.stringify(unsupported));
  assert.equal(unsupported.status === 'rejected' ? unsupported.code : '', 'unsupported-format');
});

test('已知最高修订追读：覆盖下限后才返回，追不上则明确未同步', async () => {
  const ctx = await setup('snap-catchup-');
  const followed = await snapshots(ctx).follow(OWNER, { instanceId: ctx.instanceId });
  if (followed.status !== 'following') throw new Error('follow failed');

  let attempts = 0;
  const service = buildSnapshotService(ctx, {
    beforeSecondAggregateRead: async (attempt) => {
      attempts = attempt;
      if (attempt !== 1) return;
      await commands(ctx).execute(OWNER, ctx.envelope({ type: 'set-node-status', nodeId: ROOT_NODE, status: 'in-progress' }));
    },
  });
  const snapshot = expectSnapshot(
    await service.read(OWNER, {
      instanceId: ctx.instanceId,
      connectionGeneration: followed.connectionGeneration,
      minStateRevision: 1,
    }),
  );
  assert.equal(attempts, 2, '第一次读到变更后重读');
  assert.ok(snapshot.stateRevision >= 1);
  assert.equal(snapshot.tree[0]?.status, 'in-progress');

  // 下限永远追不上：达到重试上限后返回 unsynced，而不是返回不满足下限的快照。
  const unsynced = await snapshots(ctx).read(OWNER, {
    instanceId: ctx.instanceId,
    connectionGeneration: followed.connectionGeneration,
    minStateRevision: 99,
  });
  assert.equal(unsynced.status, 'unsynced', JSON.stringify(unsynced));
  assert.equal(unsynced.status === 'unsynced' ? unsynced.reason : '', 'unstable');
  followed.close();
});

test('先订阅再回读：提交通知可读，刷新后代际替换并关闭旧流', async () => {
  const ctx = await setup('snap-follow-');
  const followed = await snapshots(ctx).follow(OWNER, { instanceId: ctx.instanceId });
  if (followed.status !== 'following') throw new Error('follow failed');

  const committed = await commands(ctx).execute(
    OWNER,
    ctx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { title: '订阅后改名' } }),
  );
  assert.equal(committed.status, 'committed');
  const events = await takeEvents(followed.events, 1);
  assert.equal(events[0]?.kind, 'committed');
  assert.equal(events[0]?.stateRevision, 1);
  assert.equal(events[0]?.connectionGeneration, followed.connectionGeneration);
  assert.equal(events[0]?.operationId, committed.status === 'committed' ? committed.operationId : '');

  // 快照回读覆盖通知水位。
  const snapshot = expectSnapshot(
    await snapshots(ctx).read(OWNER, {
      instanceId: ctx.instanceId,
      connectionGeneration: followed.connectionGeneration,
      minStateRevision: events[0]?.stateRevision ?? 0,
    }),
  );
  assert.equal(snapshot.stateRevision, 1);
  assert.equal(snapshot.tree[0]?.title, '订阅后改名');

  // 外部编辑 → 显式刷新 → 源代际替换：旧流收到 source-replaced 后结束。
  rewriteSource(ctx.source, (doc) => {
    doc.project.goal = '外部改写目标';
  });
  const files = createSourceFiles(formatsDir, sha256);
  const baseline = await readSourceBaseline(files, ctx.source, sha256, clock);
  assert.ok(baseline.ok);
  const localState = new LocalStateService({
    resolver: { resolveLocal: resolveLocalRoot, relation: rootRelation },
    git: { inspect: inspectPrivateRoot },
    store: new LocalStateStore(),
    clock,
    newInstanceId: () => randomUUID(),
    notify: ({ entry, aggregate }) =>
      ctx.stream.publish(
        notificationForRefresh(
          {
            instanceId: entry.instanceId,
            projectId: entry.projectId,
            sourceEpoch: entry.sourceGeneration,
            stateRevision: aggregate.revisions.state,
            planRevision: aggregate.revisions.plan,
          },
          clock(),
        ),
      ),
  });
  const refreshed = await localState.refresh({
    localDataRoot: ctx.localRoot,
    instanceId: ctx.instanceId,
    baseline: baseline.baseline,
  });
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed));

  const replaced = await takeEvents(followed.events, 2);
  assert.equal(replaced[0]?.kind, 'source-replaced', JSON.stringify(replaced));
  assert.equal(replaced[0]?.sourceEpoch, 2);
  assert.equal(replaced.length, 1, '旧流在换代后结束');

  // 重新订阅得到新代际；此后旧代际请求一律过期。
  const reFollowed = await snapshots(ctx).follow(OWNER, { instanceId: ctx.instanceId });
  if (reFollowed.status !== 'following') throw new Error('refollow failed');
  assert.equal(reFollowed.connectionGeneration, followed.connectionGeneration + 1);
  assert.equal(reFollowed.ready.sourceEpoch, 2);

  const stale = await snapshots(ctx).read(OWNER, {
    instanceId: ctx.instanceId,
    connectionGeneration: followed.connectionGeneration,
  });
  assert.equal(stale.status, 'rejected', JSON.stringify(stale));
  assert.equal(stale.status === 'rejected' ? stale.code : '', 'stale-connection');

  const after = expectSnapshot(
    await snapshots(ctx).read(OWNER, {
      instanceId: ctx.instanceId,
      connectionGeneration: reFollowed.connectionGeneration,
      minStateRevision: reFollowed.ready.stateRevision,
    }),
  );
  assert.equal(after.sourceEpoch, 2);
  assert.equal(after.project.goal, '外部改写目标');
  assert.equal(after.sync.status, 'synced');
  reFollowed.close();
});

test('访问判据、隔离与未知实例：快照不因只读而放宽', async () => {
  const ctx = await setup('snap-guard-');
  const anonymous = await snapshots(ctx).read(undefined, { instanceId: ctx.instanceId, connectionGeneration: 0 });
  assert.equal(anonymous.status, 'rejected');
  assert.equal(anonymous.status === 'rejected' ? anonymous.code : '', 'forbidden');

  const wrongBinding = await snapshots(ctx).read(
    { kind: 'agent-work', workRunId: 'run-1', bindingVersion: 1, instanceId: randomUUID() },
    { instanceId: ctx.instanceId, connectionGeneration: 0 },
  );
  assert.equal(wrongBinding.status, 'rejected');
  assert.equal(wrongBinding.status === 'rejected' ? wrongBinding.code : '', 'forbidden');

  const missing = await snapshots(ctx).read(OWNER, { instanceId: randomUUID(), connectionGeneration: 0 });
  assert.equal(missing.status, 'rejected');
  assert.equal(missing.status === 'rejected' ? missing.code : '', 'binding-expired');

  const store = new LocalStateStore();
  await store.quarantine(ctx.localRoot, {
    schemaVersion: 1,
    instanceId: ctx.instanceId,
    reason: 'unknown-state',
    stage: 'receipt',
    createdAt: clock(),
    requires: 'offline-review',
  });
  const quarantined = await snapshots(ctx).read(OWNER, { instanceId: ctx.instanceId, connectionGeneration: 0 });
  assert.equal(quarantined.status, 'rejected');
  assert.equal(quarantined.status === 'rejected' ? quarantined.code : '', 'unknown-state');
  const followBlocked = await snapshots(ctx).follow(OWNER, { instanceId: ctx.instanceId });
  assert.equal(followBlocked.status, 'rejected');
  assert.equal(followBlocked.status === 'rejected' ? followBlocked.code : '', 'unknown-state');
});

test('外部编辑未刷新：返回磁盘一致内容但明确标未同步', async () => {
  const ctx = await setup('snap-drift-');
  // 先提交一次，建立本机观察基线。
  const committed = await commands(ctx).execute(
    OWNER,
    ctx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '本机基线' } }),
  );
  assert.equal(committed.status, 'committed');

  rewriteSource(ctx.source, (doc) => {
    doc.project.goal = '外部直接改写';
  });

  const snapshot = expectSnapshot(
    await snapshots(ctx).read(OWNER, { instanceId: ctx.instanceId, connectionGeneration: 0 }),
  );
  assert.equal(snapshot.project.goal, '外部直接改写', '内容取当前磁盘');
  assert.equal(snapshot.sync.status, 'not-synced');
  assert.equal(snapshot.sync.reason, 'source-drift');
  assert.equal(snapshot.sync.requiresRefresh, true, '必须先刷新才能继续写入');
});
