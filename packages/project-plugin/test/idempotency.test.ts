// 幂等意图与回执测试（tasks 4.2）。
// 覆盖：响应丢失后原样重试、同 id 不同参数／归属、未授权回执查询、无业务变化、
// 重启后原样重试、未决意图不重跑、意图持久化失败不发布。
// 临时目录放在包内 artifacts/。

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalStateService } from '../src/application/local-state.js';
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
import type { Sha256Fn } from '../src/domain/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sample = path.join(packageRoot, 'formats', 'v1', 'sample-project.json');
const formatsDir = path.join(packageRoot, 'formats', 'v1');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const ROOT_NODE = '00000000-0000-4000-8000-000000000002';
const CHILD_NODE = '00000000-0000-4000-8000-000000000003';

const OWNER: TrustedContext = { kind: 'remote-owner' };
const agent = (instanceId: string, workRunId = 'run-1'): TrustedContext => ({
  kind: 'agent-work',
  workRunId,
  bindingVersion: 1,
  instanceId,
});

interface Fixture {
  localRoot: string;
  source: string;
  instanceId: string;
  service: ProjectCommandService;
  planVersion: () => string;
  envelope: (command: Command, overrides?: Partial<CommandEnvelope>) => CommandEnvelope;
  bytes: () => Buffer;
}

function build(localRoot: string, source: string, instanceId: string): { service: ProjectCommandService; store: LocalStateStore } {
  const store = new LocalStateStore();
  const service = new ProjectCommandService({
    localRoot,
    store,
    files: createSourceFiles(formatsDir, sha256),
    sha256,
    clock: () => new Date().toISOString(),
    newNodeId: () => randomUUID(),
    newRecordId: () => randomUUID(),
  });
  return { service, store };
}

async function setup(name: string): Promise<Fixture> {
  const base = mkdtempSync(path.join(artifacts, name));
  const localRoot = path.join(base, 'local');
  const source = path.join(base, 'source');
  mkdirSync(source, { recursive: true });
  copyFileSync(sample, path.join(source, 'project.json'));

  const store = new LocalStateStore();
  const localState = new LocalStateService({
    resolver: { resolveLocal: resolveLocalRoot, relation: rootRelation },
    git: { inspect: inspectPrivateRoot },
    store,
    clock: () => new Date().toISOString(),
    newInstanceId: () => randomUUID(),
  });
  const registered = await localState.register({
    localDataRoot: localRoot,
    sourceRoot: source,
    sourceKind: 'custom',
    projectId: PROJECT_ID,
  });
  if (!registered.ok) throw new Error('register failed');
  const instanceId = registered.entry.instanceId;
  const { service } = build(localRoot, source, instanceId);

  const planVersion = (): string =>
    (JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as { planVersion: string }).planVersion;
  const bytes = (): Buffer => readFileSync(path.join(source, 'project.json'));

  const envelope = (command: Command, overrides: Partial<CommandEnvelope> = {}): CommandEnvelope => ({
    operationId: randomUUID(),
    projectId: PROJECT_ID,
    instanceId,
    sourceEpoch: registered.entry.sourceGeneration,
    expectedPlanVersion: planVersion(),
    expectedPlanRevision: 0,
    command,
    ...overrides,
  });

  return { localRoot, source, instanceId, service, planVersion, envelope, bytes };
}

function aggregateOf(fx: Fixture): {
  revisions: { plan: number; state: number };
  operations: {
    operationId: string;
    status: string;
    requestDigest: string;
    baseline: { expectedPlanVersion: string; expectedPlanRevision: number; sourceEpoch: number };
    generated: { recordId?: string; nodeIds?: string[] };
  }[];
} {
  return JSON.parse(
    readFileSync(path.join(fx.localRoot, 'instances', fx.instanceId, 'state.json'), 'utf8'),
  ) as never;
}

test('响应丢失后原样重试：返回历史结果，不重复执行、不推进修订', async () => {
  const fx = await setup('idem-retry-');
  const envelope = fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '第一次' } });

  const first = await fx.service.execute(OWNER, envelope);
  assert.equal(first.status, 'committed', JSON.stringify(first));
  if (first.status !== 'committed') return;
  const bytesAfterFirst = fx.bytes();
  const aggregateAfterFirst = aggregateOf(fx);

  const retry = await fx.service.execute(OWNER, envelope);
  assert.equal(retry.status, 'committed', JSON.stringify(retry));
  if (retry.status !== 'committed') return;
  assert.equal(retry.replayed, true);
  assert.equal(retry.planRevision, first.planRevision);
  assert.equal(retry.stateRevision, first.stateRevision);
  assert.deepEqual(fx.bytes(), bytesAfterFirst, '重试不得再次写资料');
  assert.deepEqual(aggregateOf(fx).revisions, aggregateAfterFirst.revisions);
  assert.equal(aggregateOf(fx).operations.length, 1);
});

test('同 id 不同参数：拒绝为 operation-mismatch，且不执行', async () => {
  const fx = await setup('idem-mismatch-');
  const envelope = fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '原参数' } });
  const first = await fx.service.execute(OWNER, envelope);
  assert.equal(first.status, 'committed');
  const bytes = fx.bytes();

  const changed = { ...envelope, command: { type: 'update-node' as const, nodeId: ROOT_NODE, patch: { goal: '换了参数' } } };
  const result = await fx.service.execute(OWNER, changed);
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  if (result.status !== 'rejected') return;
  assert.equal(result.code, 'operation-mismatch');
  assert.deepEqual(fx.bytes(), bytes, '参数不一致时不得写入');
});

test('同 id 不同归属：拒绝，且回执不泄露给另一主体', async () => {
  const fx = await setup('idem-origin-');
  const envelope = fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '工具写入' } });
  const viaAgent = await fx.service.execute(agent(fx.instanceId), envelope);
  assert.equal(viaAgent.status, 'committed', JSON.stringify(viaAgent));

  // 同一 operationId 由 owner 重放：摘要相同但归属不同。
  const viaOwner = await fx.service.execute(OWNER, envelope);
  assert.equal(viaOwner.status, 'rejected');
  assert.equal(viaOwner.status === 'rejected' ? viaOwner.code : '', 'forbidden');

  // 回执查询按归属隔离。
  const ownReceipt = await fx.service.getReceipt(agent(fx.instanceId), {
    instanceId: fx.instanceId,
    operationId: envelope.operationId,
  });
  assert.equal(ownReceipt.status, 'committed');
  assert.equal(ownReceipt.status === 'committed' ? ownReceipt.replayed : false, true);

  const otherAgent = await fx.service.getReceipt(agent(fx.instanceId, 'run-2'), {
    instanceId: fx.instanceId,
    operationId: envelope.operationId,
  });
  assert.equal(otherAgent.status, 'rejected');
  assert.equal(otherAgent.status === 'rejected' ? otherAgent.code : '', 'forbidden');

  const ownerReceipt = await fx.service.getReceipt(OWNER, {
    instanceId: fx.instanceId,
    operationId: envelope.operationId,
  });
  assert.equal(ownerReceipt.status, 'rejected', 'owner 也不能读取其他归属的回执');

  const missing = await fx.service.getReceipt(OWNER, { instanceId: fx.instanceId, operationId: randomUUID() });
  assert.equal(missing.status, 'not-found');

  const noContext = await fx.service.getReceipt(undefined, { instanceId: fx.instanceId, operationId: envelope.operationId });
  assert.equal(noContext.status, 'rejected');
  assert.equal(noContext.status === 'rejected' ? noContext.code : '', 'forbidden');
});

test('无业务变化：只保存回执并推进状态修订，不重写资料', async () => {
  const fx = await setup('idem-noop-');
  const doc = JSON.parse(readFileSync(path.join(fx.source, 'project.json'), 'utf8')) as {
    plan: { nodes: { id: string; title: string }[] };
  };
  const currentTitle = doc.plan.nodes[0]?.title ?? '';
  const before = fx.bytes();

  const envelope = fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { title: currentTitle } });
  const result = await fx.service.execute(OWNER, envelope);
  assert.equal(result.status, 'committed', JSON.stringify(result));
  if (result.status !== 'committed') return;
  assert.equal(result.impact, 'state');
  assert.equal(result.planRevision, 0, '无业务变化不推进规划修订');
  assert.equal(result.stateRevision, 1);
  assert.deepEqual(fx.bytes(), before, '无业务变化不得重写资料头');

  const retry = await fx.service.execute(OWNER, envelope);
  assert.equal(retry.status, 'committed');
  assert.equal(retry.status === 'committed' ? retry.replayed : false, true);
  assert.equal(retry.status === 'committed' ? retry.stateRevision : -1, 1, '重试不再推进修订');
});

test('重启后原样重试：从磁盘读回执，不重新执行', async () => {
  const fx = await setup('idem-restart-');
  const envelope = fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '重启前' } });
  const first = await fx.service.execute(OWNER, envelope);
  assert.equal(first.status, 'committed');
  const bytes = fx.bytes();

  // 新进程语义：新建 store 与服务实例，只共享本机根与资料根。
  const restarted = build(fx.localRoot, fx.source, fx.instanceId).service;
  const retry = await restarted.execute(OWNER, envelope);
  assert.equal(retry.status, 'committed', JSON.stringify(retry));
  assert.equal(retry.status === 'committed' ? retry.replayed : false, true);
  assert.deepEqual(fx.bytes(), bytes);

  const receipt = await restarted.getReceipt(OWNER, { instanceId: fx.instanceId, operationId: envelope.operationId });
  assert.equal(receipt.status, 'committed');
});

test('未决意图：头结果未知后重试仍待核对，不重复发布', async () => {
  const fx = await setup('idem-pending-');
  const store = new LocalStateStore();
  const failing = new ProjectCommandService({
    localRoot: fx.localRoot,
    store,
    files: createSourceFiles(formatsDir, sha256),
    sha256,
    clock: () => new Date().toISOString(),
    newNodeId: () => randomUUID(),
    newRecordId: () => randomUUID(),
    hooks: {
      publish: {
        afterRename: () => {
          throw new Error('injected-head-unknown');
        },
      },
    },
  });
  const envelope = fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '未知结果' } });
  const unknown = await failing.execute(OWNER, envelope);
  assert.equal(unknown.status, 'pending-reconciliation', JSON.stringify(unknown));
  const bytesAfterUnknown = fx.bytes();
  assert.equal(aggregateOf(fx).operations[0]?.status, 'pending');

  // 正常服务重试同一 operationId：应返回待核对，而不是再发布一次。
  const retry = await fx.service.execute(OWNER, envelope);
  assert.equal(retry.status, 'pending-reconciliation', JSON.stringify(retry));
  assert.equal(retry.status === 'pending-reconciliation' ? retry.stage : '', 'intent');
  assert.deepEqual(fx.bytes(), bytesAfterUnknown, '不得重复发布');
});

test('意图持久化失败：不发布资料，返回 persistence-failed', async () => {
  const fx = await setup('idem-intent-fail-');
  const before = fx.bytes();
  const failing = new ProjectCommandService({
    localRoot: fx.localRoot,
    store: new LocalStateStore(),
    files: createSourceFiles(formatsDir, sha256),
    sha256,
    clock: () => new Date().toISOString(),
    newNodeId: () => randomUUID(),
    newRecordId: () => randomUUID(),
    hooks: {
      state: {
        beforeTempWrite: () => {
          throw new Error('injected-intent-failure');
        },
      },
    },
  });
  const result = await failing.execute(OWNER, fx.envelope({ type: 'add-nodes', nodes: [] }));
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  assert.equal(result.status === 'rejected' ? result.code : '', 'persistence-failed');
  assert.deepEqual(fx.bytes(), before, '意图未保存时不得发布资料');
});

test('稳定生成 id：记录 id 在意图中固定并与回执一致', async () => {
  const fx = await setup('idem-generated-');
  const envelope = fx.envelope({
    type: 'append-record',
    kind: 'analysis-note',
    subjectNodeIds: [CHILD_NODE],
    summary: '固定 id',
    sources: [],
    body: '# 正文\n',
  });
  const result = await fx.service.execute(OWNER, envelope);
  assert.equal(result.status, 'committed', JSON.stringify(result));
  const recordId = result.status === 'committed' ? result.recordId : undefined;
  assert.ok(recordId !== undefined);
  const intent = aggregateOf(fx).operations[0];
  assert.equal(intent?.generated.recordId, recordId);
  // 原请求基线必须可回取，否则响应丢失后无法“原样重发”。
  assert.match(intent?.baseline.expectedPlanVersion ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.equal(intent?.baseline.expectedPlanRevision, 0);
  assert.equal(intent?.baseline.sourceEpoch, 1);

  const retry = await fx.service.execute(OWNER, envelope);
  assert.equal(retry.status === 'committed' ? retry.recordId : '', recordId, '重试返回同一生成 id');
});
