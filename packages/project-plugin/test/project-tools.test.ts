// 项目 Agent 工具适配器测试（tasks 6.3）。
// 覆盖：真实工具调用路径（exec.agent.id → captureBinding → 统一命令服务）、
// 伪造参数反例（Session／WorkRun／授权字段无效、未知参数拒绝、绑定外写入拒绝）、
// 输出 schema 契约（committed／rejected／pending 形状）、receipt 按 origin 隔离、
// 规划提交后绑定版本推进与旧捕获拒绝。
// 临时目录放在包内 artifacts/（仓库门禁禁止 os.tmpdir 与机器绝对路径）。

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstanceCommandQueue } from '../src/application/command-queue.js';
import { LocalStateService } from '../src/application/local-state.js';
import { WorkService } from '../src/application/work.js';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { createSourceFiles } from '../src/adapters/fs/source-files.js';
import { resolveLocalRoot, rootRelation } from '../src/adapters/fs/local-root.js';
import { inspectPrivateRoot } from '../src/adapters/fs/git-guard.js';
import { ProjectSnapshotService } from '../src/application/snapshot.js';
import { ProjectCommandService } from '../src/application/command-service.js';
import { InMemoryChangeStream } from '../src/application/change-stream.js';
import { ProjectToolAdapter, type ConaToolExec } from '../src/host/project-tools.js';
import type { OpenedInstance } from '../src/host/bootstrap.js';
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
const BOOT = 1730000000000;
/** 复用同一 operationId 的重试用例（envelope 要求 UUID v4）。 */
const RECORD_OP = '44444444-4444-4444-8444-444444444444';
const RECEIPT_OP = '55555555-5555-4555-8555-555555555555';

function clock(): string {
  return new Date().toISOString();
}

interface Fixture {
  base: string;
  source: string;
  instance: OpenedInstance;
  adapter: ProjectToolAdapter;
  work: WorkService;
  command: ProjectCommandService;
  planVersion: () => string;
  rpcId: string;
  sessionId: string;
  /** 以真实工具执行上下文形态（agent.id = sessionId）捕获绑定。 */
  exec: () => ConaToolExec;
}

async function setup(name: string): Promise<Fixture> {
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
  const registered = await localState.register({ localDataRoot: localRoot, sourceRoot: source, sourceKind: 'custom', projectId: PROJECT_ID });
  assert.ok(registered.ok);
  if (!registered.ok) throw new Error('register failed');

  const stream = new InMemoryChangeStream();
  const queue = new InstanceCommandQueue();
  const planNodes = {
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
  const snapshot = new ProjectSnapshotService({
    localRoot,
    store,
    files,
    sha256,
    clock,
    stream,
  });
  const instance: OpenedInstance = {
    instanceId: registered.entry.instanceId,
    projectId: PROJECT_ID,
    sourceRoot: source,
    sourceKind: 'custom',
    sourceDisplay: source,
    sourceEpoch: registered.entry.sourceGeneration,
    localRoot,
    created: false,
    baselineEstablished: true,
  };
  const runtime = { ok: true as const, value: { instance, snapshot, command, chats: {} as never, work } };
  const adapter = new ProjectToolAdapter({ runtime: async () => runtime });

  const sessionId = `session-${randomUUID().slice(0, 8)}`;
  const rpcId = `rpc-${randomUUID().slice(0, 8)}`;
  const prepared = await work.prepareWork({
    workIntentId: `intent-${randomUUID().slice(0, 8)}`,
    nodeIds: [ROOT_NODE],
    allowedActions: ['update', 'record', 'add', 'split'],
    reasonScope: 'local',
    purpose: '围绕根节点工作',
    baseline: { planVersion: planVersionOf(source), planRevision: 0, sourceEpoch: registered.entry.sourceGeneration },
  });
  assert.equal(prepared.status, 'committed');
  const started = await work.startWork({ workIntentId: prepared.status === 'committed' ? prepared.value.workIntentId : '', rpcId, sessionId });
  assert.equal(started.status, 'committed');
  const admission = await work.observeConsumed({ sessionId, rpcId, turn: 1, agentPresent: true });
  assert.equal(admission.status, 'started');

  return {
    base,
    source,
    instance,
    adapter,
    work,
    command,
    planVersion: () => planVersionOf(source),
    rpcId,
    sessionId,
    exec: () => ({ agent: { id: sessionId }, callId: 'call-test' }),
  };
}

function planVersionOf(source: string): string {
  return (JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as { planVersion: string }).planVersion;
}

// ---------- project_read ----------

test('6.3 project_read：真实 exec 捕获绑定后读取快照，输出含基线、绑定范围与小树', async () => {
  const fx = await setup('tools-read-');
  const output = (await fx.adapter.read({}, fx.exec())) as Record<string, unknown>;
  assert.equal(output['status'], 'read', JSON.stringify(output));
  assert.equal(output['instanceId'], fx.instance.instanceId);
  assert.equal(output['projectId'], PROJECT_ID);
  assert.equal(output['planVersion'], fx.planVersion());
  assert.equal(output['planRevision'], 0);
  const binding = output['binding'] as { workRunId: string; bindingVersion: number; targets: string[]; allowedActions: string[] };
  assert.equal(binding.bindingVersion, 1);
  assert.deepEqual(binding.targets, [ROOT_NODE]);
  const nodes = output['nodes'] as Array<{ id: string; title: string; completionCriteria: string[] }>;
  assert.ok(nodes.length >= 2);
  assert.ok(nodes.every((node) => typeof node.id === 'string' && Array.isArray(node.completionCriteria)));
  const deps = output['dependencies'] as unknown[];
  assert.ok(Array.isArray(deps));
});

test('6.3 project_read：agent 缺失或无绑定会话 → 稳定拒绝，不降级不泄露资料', async () => {
  const fx = await setup('tools-nobind-');
  const noAgent = (await fx.adapter.read({}, {})) as { status: string; code: string };
  assert.equal(noAgent.status, 'rejected');
  assert.equal(noAgent.code, 'agent-missing');
  const otherSession = (await fx.adapter.read({}, { agent: { id: 'session-stranger' } })) as { status: string; code: string };
  assert.equal(otherSession.status, 'rejected');
  assert.equal(otherSession.code, 'binding-expired', '无绑定会话不因缺 invocation 授权，也不读资料');
});

test('6.3 project_read：伪造参数（session/workRun/authorization 字段）未知参数拒绝', async () => {
  const fx = await setup('tools-forge-read-');
  const forged = (await fx.adapter.read(
    { sessionId: fx.sessionId, workRunId: 'run-forged', authorization: 'owner' },
    fx.exec(),
  )) as { status: string; code: string };
  assert.equal(forged.status, 'rejected');
  assert.equal(forged.code, 'operation-mismatch');
});

// ---------- project_apply ----------

test('6.3 project_apply：范围内提交成功，规划提交后绑定版本推进并在输出中给出新版本', async () => {
  const fx = await setup('tools-apply-');
  const output = (await fx.adapter.apply(
    {
      operationId: randomUUID(),
      command: { type: 'update-node', nodeId: ROOT_NODE, patch: { title: '工具内修改' } },
      expectedPlanVersion: fx.planVersion(),
      expectedPlanRevision: 0,
      sourceEpoch: fx.instance.sourceEpoch,
    },
    fx.exec(),
  )) as Record<string, unknown>;
  assert.equal(output['status'], 'committed', JSON.stringify(output));
  assert.equal(output['impact'], 'plan');
  assert.equal(output['planRevision'], 1);
  assert.equal(output['newBindingVersion'], 2, '绑定版本已推进，下次调用需重新捕获');

  // 旧捕获（本次 exec 的绑定版本 1）在提交后已被推进——再用同一 exec 提交须以新基线捕获新版本。
  const stale = (await fx.adapter.apply(
    {
      operationId: randomUUID(),
      command: { type: 'update-node', nodeId: ROOT_NODE, patch: { title: '迟到' } },
      expectedPlanVersion: fx.planVersion(),
      expectedPlanRevision: 0,
      sourceEpoch: fx.instance.sourceEpoch,
    },
    fx.exec(),
  )) as { status: string; code: string };
  // exec 每次重新捕获 → 版本已是 2；但命令基线仍是旧 revision 0 → 绑定基线核对拒绝。
  assert.equal(stale.status, 'rejected');
  assert.equal(stale.code, 'binding-expired', JSON.stringify(stale));
});

test('6.3 project_apply：绑定外目标（子节点）与根级新增拒绝；伪造 workRunId 参数拒绝', async () => {
  const fx = await setup('tools-scope-');
  const outside = (await fx.adapter.apply(
    {
      operationId: randomUUID(),
      command: { type: 'update-node', nodeId: CHILD_NODE, patch: { title: '越界' } },
      expectedPlanVersion: fx.planVersion(),
      expectedPlanRevision: 0,
      sourceEpoch: fx.instance.sourceEpoch,
    },
    fx.exec(),
  )) as { status: string; code: string };
  assert.equal(outside.status, 'rejected');
  assert.equal(outside.code, 'forbidden', JSON.stringify(outside));

  const rootAdd = (await fx.adapter.apply(
    {
      operationId: randomUUID(),
      command: { type: 'add-nodes', nodes: [{ parentId: null, order: 99, title: '根级新节点', goal: '越权', completionCriteria: [] }] },
      expectedPlanVersion: fx.planVersion(),
      expectedPlanRevision: 0,
      sourceEpoch: fx.instance.sourceEpoch,
    },
    fx.exec(),
  )) as { status: string; code: string };
  assert.equal(rootAdd.status, 'rejected');
  assert.equal(rootAdd.code, 'forbidden', '工具不获得根级新增资格');

  const forgedRun = (await fx.adapter.apply(
    {
      operationId: randomUUID(),
      workRunId: 'run-other',
      bindingVersion: 9,
      command: { type: 'update-node', nodeId: ROOT_NODE, patch: { title: '伪造归属' } },
      expectedPlanVersion: fx.planVersion(),
      expectedPlanRevision: 0,
      sourceEpoch: fx.instance.sourceEpoch,
    },
    fx.exec(),
  )) as { status: string; code: string };
  assert.equal(forgedRun.status, 'rejected');
  assert.equal(forgedRun.code, 'operation-mismatch', 'workRunId／bindingVersion 是身份字段，出现在参数中即拒绝');
});

test('6.3 project_apply：command.type 非法与缺基线参数在参数层拒绝；记录类型指向 project_record', async () => {
  const fx = await setup('tools-shape-');
  const badType = (await fx.adapter.apply(
    {
      operationId: randomUUID(),
      command: { type: 'append-record' },
      expectedPlanVersion: fx.planVersion(),
      expectedPlanRevision: 0,
      sourceEpoch: fx.instance.sourceEpoch,
    },
    fx.exec(),
  )) as { status: string; code: string; message: string };
  assert.equal(badType.status, 'rejected');
  assert.equal(badType.code, 'operation-mismatch');
  assert.ok(badType.message.includes('project_record'));

  const noBaseline = (await fx.adapter.apply(
    { operationId: randomUUID(), command: { type: 'update-node', nodeId: ROOT_NODE, patch: { title: 'x' } } },
    fx.exec(),
  )) as { status: string; code: string };
  assert.equal(noBaseline.status, 'rejected');
  assert.equal(noBaseline.code, 'operation-mismatch');
});

// ---------- project_record ----------

test('6.3 project_record：绑定基线追加记录成功，state 影响、正文落盘、不推进绑定版本', async () => {
  const fx = await setup('tools-record-');
  const output = (await fx.adapter.record(
    {
      operationId: RECORD_OP,
      kind: 'execution-note',
      subjectNodeIds: [ROOT_NODE],
      summary: '工具路径追加的执行记录',
      sources: [{ repositoryId: '00000000-0000-4000-8000-000000000005', relativePath: 'src/a.ts' }],
      body: '# 记录\n来自 project_record 的正文。',
    },
    fx.exec(),
  )) as Record<string, unknown>;
  assert.equal(output['status'], 'committed', JSON.stringify(output));
  assert.equal(output['impact'], 'state');
  assert.ok(typeof output['recordId'] === 'string');
  assert.ok(typeof output['recordPath'] === 'string' && (output['recordPath'] as string).startsWith('records/'));
  assert.equal(output['newBindingVersion'], undefined, '记录不推进绑定版本');

  const read = (await fx.adapter.read({}, fx.exec())) as { binding: { bindingVersion: number }; recordCount: number };
  assert.equal(read.binding.bindingVersion, 1, '绑定版本不变');
  assert.equal(read.recordCount, 1);

  // 幂等重试：同 operationId 返回历史结果。
  const replay = (await fx.adapter.record(
    {
      operationId: RECORD_OP,
      kind: 'execution-note',
      subjectNodeIds: [ROOT_NODE],
      summary: '工具路径追加的执行记录',
      sources: [{ repositoryId: '00000000-0000-4000-8000-000000000005', relativePath: 'src/a.ts' }],
      body: '# 记录\n来自 project_record 的正文。',
    },
    fx.exec(),
  )) as Record<string, unknown>;
  assert.equal(replay['status'], 'committed');
  assert.equal(replay['recordId'], output['recordId'], '原样重试返回原回执');
});

test('6.3 project_record：越界主题节点与非法 kind 拒绝', async () => {
  const fx = await setup('tools-record-scope-');
  const outside = (await fx.adapter.record(
    {
      operationId: randomUUID(),
      kind: 'analysis-note',
      subjectNodeIds: [CHILD_NODE],
      summary: '越界主题',
      sources: [{ repositoryId: 'r', relativePath: 'x.ts' }],
      body: '正文',
    },
    fx.exec(),
  )) as { status: string; code: string };
  assert.equal(outside.status, 'rejected');
  assert.equal(outside.code, 'forbidden', JSON.stringify(outside));

  const badKind = (await fx.adapter.record(
    {
      operationId: randomUUID(),
      kind: 'gossip',
      subjectNodeIds: [ROOT_NODE],
      summary: '非法类型',
      sources: [{ repositoryId: 'r', relativePath: 'x.ts' }],
      body: '正文',
    },
    fx.exec(),
  )) as { status: string; code: string };
  assert.equal(badKind.status, 'rejected');
  assert.equal(badKind.code, 'operation-mismatch');
});

// ---------- project_receipt ----------

test('6.3 project_receipt：同归属可查原回执；其他 WorkRun／伪造归属不可读', async () => {
  const fx = await setup('tools-receipt-');
  const committed = (await fx.adapter.apply(
    {
      operationId: RECEIPT_OP,
      command: { type: 'update-node', nodeId: ROOT_NODE, patch: { goal: 'receipt 目标' } },
      expectedPlanVersion: fx.planVersion(),
      expectedPlanRevision: 0,
      sourceEpoch: fx.instance.sourceEpoch,
    },
    fx.exec(),
  )) as Record<string, unknown>;
  assert.equal(committed['status'], 'committed');

  const receipt = (await fx.adapter.receipt({ operationId: RECEIPT_OP }, fx.exec())) as Record<string, unknown>;
  assert.equal(receipt['status'], 'committed', JSON.stringify(receipt));
  assert.equal(receipt['operationId'], RECEIPT_OP);
  assert.equal(receipt['replayed'], true);

  const missing = (await fx.adapter.receipt({ operationId: randomUUID() }, fx.exec())) as { status: string; code: string };
  assert.equal(missing.status, 'rejected');
  assert.equal(missing.code, 'not-found');

  const forged = (await fx.adapter.receipt(
    { operationId: RECEIPT_OP, workRunId: 'run-elsewhere' },
    fx.exec(),
  )) as { status: string; code: string };
  assert.equal(forged.status, 'rejected');
  assert.equal(forged.code, 'operation-mismatch');
});

// ---------- runtime 不可用 ----------

test('6.3 runtime 不可用：四个工具都以稳定拒绝码返回，不抛裸异常', async () => {
  const adapter = new ProjectToolAdapter({ runtime: async () => ({ ok: false, code: 'binding-expired', message: '实例未打开' }) });
  const exec: ConaToolExec = { agent: { id: 'session-x' } };
  for (const [name, run] of [
    ['read', () => adapter.read({}, exec)],
    ['apply', () => adapter.apply({ operationId: 'op', command: { type: 'update-node', nodeId: 'n', patch: {} }, expectedPlanVersion: 'v', expectedPlanRevision: 0, sourceEpoch: 1 }, exec)],
    ['record', () => adapter.record({ operationId: 'op', kind: 'analysis-note', subjectNodeIds: ['n'], summary: 's', sources: [], body: 'b' }, exec)],
    ['receipt', () => adapter.receipt({ operationId: 'op' }, exec)],
  ] as const) {
    const output = (await run()) as { status: string; code: string };
    assert.equal(output.status, 'rejected', `${name} 应稳定拒绝`);
    assert.equal(output.code, 'binding-expired', `${name} 应透传 runtime 拒绝码`);
  }
});
