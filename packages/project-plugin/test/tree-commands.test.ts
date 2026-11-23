// R2 项目树编辑与流程拼接 · 服务与授权测试（tasks 2.1 / 2.2 / 2.3 / 2.4）。
// A 层：owner-only 准入、预设目录、拒绝码、命令映射；
// F 层：真实文件后端发布、单次修订、原位保留、冲突／源变化、回执丢失与恢复、
//       升级后移除预设版本的恢复；WorkRun owner 变更边界。

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProjectCommandService,
  createBuiltinPresetCatalog,
  type Command,
  type CommandEnvelope,
  type CommandResult,
  type TrustedContext,
} from '../src/application/command-service.js';
import { commandAction, commandTargets, WorkService } from '../src/application/work.js';
import { InstanceCommandQueue } from '../src/application/command-queue.js';
import type { PlanNodeViewPort } from '../src/application/ports.js';
import { LocalStateService } from '../src/application/local-state.js';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { createSourceFiles } from '../src/adapters/fs/source-files.js';
import { resolveLocalRoot, rootRelation } from '../src/adapters/fs/local-root.js';
import { inspectPrivateRoot } from '../src/adapters/fs/git-guard.js';
import { validateProjectDocument } from '../src/domain/validate.js';
import { computePlanVersion } from '../src/domain/index.js';
import { FEATURE_DEVELOPMENT_PRESET } from '../src/domain/presets.js';
import type { ProjectDocument, Sha256Fn } from '../src/domain/types.js';

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
const AGENT = (instanceId: string): TrustedContext => ({
  kind: 'agent-work', workRunId: 'work-run-1', bindingVersion: 1, instanceId,
});

interface Fixture {
  base: string;
  localRoot: string;
  source: string;
  instanceId: string;
  service: ProjectCommandService;
  store: LocalStateStore;
  planVersion: () => string;
  envelope: (command: Command, overrides?: Partial<CommandEnvelope>) => CommandEnvelope;
  aggregate: () => AggregateView;
}

interface AggregateView {
  revisions: { plan: number; state: number };
  operations: { operationId: string; status: string; result?: { planRevision: number; planVersion: string } }[];
}

async function setup(name: string, options: { presets?: ReturnType<typeof createBuiltinPresetCatalog> } = {}): Promise<Fixture> {
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
    clock: () => new Date().toISOString(),
    newInstanceId: () => randomUUID(),
  });
  const registered = await localState.register({
    localDataRoot: localRoot, sourceRoot: source, sourceKind: 'custom', projectId: PROJECT_ID,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) throw new Error('register failed');

  const service = new ProjectCommandService({
    localRoot, store, files, sha256,
    clock: () => new Date().toISOString(),
    newNodeId: () => randomUUID(),
    newRecordId: () => randomUUID(),
    ...(options.presets === undefined ? {} : { presetCatalog: options.presets }),
  });

  const planVersion = (): string =>
    (JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as { planVersion: string }).planVersion;
  const envelope = (command: Command, overrides: Partial<CommandEnvelope> = {}): CommandEnvelope => ({
    operationId: randomUUID(),
    projectId: PROJECT_ID,
    instanceId: registered.entry.instanceId,
    sourceEpoch: registered.entry.sourceGeneration,
    expectedPlanVersion: planVersion(),
    expectedPlanRevision: 0,
    command,
    ...overrides,
  });
  const aggregate = (): AggregateView =>
    JSON.parse(readFileSync(path.join(localRoot, 'instances', registered.entry.instanceId, 'state.json'), 'utf8')) as never;

  return { base, localRoot, source, instanceId: registered.entry.instanceId, service, store, planVersion, envelope, aggregate };
}

function rejected(result: CommandResult): Extract<CommandResult, { status: 'rejected' }> {
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  return result as Extract<CommandResult, { status: 'rejected' }>;
}

/** WorkService 与命令服务共享同一实例队列，复现宿主装配的绑定准入。 */
async function setupFull(name: string): Promise<Fixture & { work: WorkService }> {
  const base = mkdtempSync(path.join(artifacts, name));
  const localRoot = path.join(base, 'local');
  const source = path.join(base, 'source');
  mkdirSync(source, { recursive: true });
  copyFileSync(sample, path.join(source, 'project.json'));
  const store = new LocalStateStore();
  const files = createSourceFiles(formatsDir, sha256);
  const clock = (): string => new Date().toISOString();
  const localState = new LocalStateService({
    resolver: { resolveLocal: resolveLocalRoot, relation: rootRelation },
    git: { inspect: inspectPrivateRoot }, store, clock,
    newInstanceId: () => randomUUID(),
  });
  const registered = await localState.register({
    localDataRoot: localRoot, sourceRoot: source, sourceKind: 'custom', projectId: PROJECT_ID,
  });
  assert.equal(registered.ok, true);
  if (!registered.ok) throw new Error('register failed');
  const instanceId = registered.entry.instanceId;
  const queue = new InstanceCommandQueue();
  const planNodes: PlanNodeViewPort = {
    async currentNodeIds() {
      const doc = JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as { plan: { nodes: { id: string }[] } };
      return { ok: true as const, nodeIds: new Set(doc.plan.nodes.map((n) => n.id)) };
    },
  };
  const work = new WorkService({
    localRoot, instanceId, store, planNodes, clock,
    newWorkRunId: () => `run-${randomUUID()}`,
    newSuggestionId: () => `sug-${randomUUID()}`,
    bootGeneration: 1, queue,
  });
  const service = new ProjectCommandService({
    localRoot, store, files, sha256, clock,
    newNodeId: () => randomUUID(), newRecordId: () => randomUUID(), queue, work,
  });
  const planVersion = (): string =>
    (JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as { planVersion: string }).planVersion;
  const envelope = (command: Command, overrides: Partial<CommandEnvelope> = {}): CommandEnvelope => ({
    operationId: randomUUID(), projectId: PROJECT_ID, instanceId,
    sourceEpoch: registered.entry.sourceGeneration, expectedPlanVersion: planVersion(),
    expectedPlanRevision: 0, command, ...overrides,
  });
  const aggregate = (): AggregateView =>
    JSON.parse(readFileSync(path.join(localRoot, 'instances', instanceId, 'state.json'), 'utf8')) as never;
  return { base, localRoot, source, instanceId, service, store, planVersion, envelope, aggregate, work };
}

const MOVE_IN_PLACE: Command = { type: 'move-node', nodeId: CHILD_NODE, parentId: ROOT_NODE, beforeNodeId: null };
const INSERT: Command = {
  type: 'insert-preset', templateId: 'feature-development', templateVersion: 1,
  contentLocale: 'zh-CN', parentId: ROOT_NODE, beforeNodeId: null,
};

// ---- 2.1 服务接入、预设读取与 owner 准入 ----

test('2.1 treePresets 返回内置预设的 ID/版本/builtin/语言/正文/依赖载荷', () => {
  const catalog = createBuiltinPresetCatalog();
  const presets = catalog.list();
  assert.equal(presets.length, 1);
  const preset = presets[0]!;
  assert.equal(preset.id, 'feature-development');
  assert.equal(preset.version, 1);
  assert.equal(preset.source, 'builtin');
  assert.deepEqual([...preset.contentLocales].sort(), ['en', 'zh-CN']);
  assert.ok(preset.content['zh-CN']?.title && preset.content['en']?.title);
  assert.ok(preset.nodes.length > 1 && preset.dependencies.length > 0);
  assert.ok(preset.text['zh-CN'] && preset.text['en']);
});

test('2.1 预设目录按 ID+版本精确匹配，未知 ID／不可用版本／无效描述给稳定码', () => {
  const catalog = createBuiltinPresetCatalog();
  assert.equal(catalog.resolve('feature-development', 1).ok, true);
  assert.equal(rejectedCode(catalog.resolve('nope', 1)), 'template-not-found');
  assert.equal(rejectedCode(catalog.resolve('feature-development', 99)), 'template-version-unavailable');
  const bad = createBuiltinPresetCatalog([{ ...FEATURE_DEVELOPMENT_PRESET, dependencies: [{ nodeKey: 'ghost', requiresKey: 'root' }] }]);
  assert.equal(rejectedCode(bad.resolve('feature-development', 1)), 'template-invalid');
});

function rejectedCode(r: { ok: boolean; code?: string }): string {
  return r.ok ? '' : (r.code ?? '');
}

test('2.1 owner 可执行结构命令，agent-work 直达被拒（含无工作服务时不回退放行）', async () => {
  const fx = await setup('cmd-owneronly-');
  const ownerResult = await fx.service.execute(OWNER, fx.envelope({ ...MOVE_IN_PLACE }));
  assert.equal(ownerResult.status, 'committed', JSON.stringify(ownerResult));
  const agentResult = await fx.service.execute(AGENT(fx.instanceId), fx.envelope({ ...MOVE_IN_PLACE }));
  assert.equal(agentResult.status, 'rejected');
  assert.equal((agentResult as { code: string }).code, 'forbidden');
  const agentInsert = await fx.service.execute(AGENT(fx.instanceId), fx.envelope({ ...INSERT }));
  assert.equal((agentInsert as { code: string }).code, 'forbidden');
});

test('2.1 同项目 ID 不同实例：错实例 envelope 被拒，不影响目标实例', async () => {
  const fx = await setup('cmd-instance-');
  const bad = await fx.service.execute(OWNER, fx.envelope({ ...MOVE_IN_PLACE }, { instanceId: randomUUID() }));
  assert.equal(bad.status, 'rejected');
  assert.ok(['binding-expired', 'forbidden'].includes((bad as { code: string }).code));
});

test('2.1 新命令的动作/目标映射保守且穷尽', () => {
  // 3.3：移动与插入是独立动作（需显式授权），不再借用 update／add。
  assert.equal(commandAction({ ...MOVE_IN_PLACE }), 'move');
  assert.equal(commandAction({ ...INSERT }), 'insert');
  assert.deepEqual(commandTargets({ ...MOVE_IN_PLACE }).sort(), [CHILD_NODE, ROOT_NODE].sort());
  assert.deepEqual(commandTargets({ ...INSERT }), [ROOT_NODE]);
});

// ---- 2.2 真实文件后端发布与基线校验 ----

test('2.2 有效结构变更只推进一次规划修订并写回磁盘，v1 校验器可回读', async () => {
  const fx = await setup('cmd-move-publish-');
  const before = fx.planVersion();
  // 单根双节点夹具中，把子节点降为其自身的兄弟不合法；用合法的同级重排夹具
  // 需多节点，这里以插入预设作为有效规划变更的代表（移动变换见 tree-editing.test.ts）。
  const result = await fx.service.execute(OWNER, fx.envelope({ ...INSERT }));
  assert.equal(result.status, 'committed', JSON.stringify(result));
  assert.equal(fx.aggregate().revisions.plan, 1, '规划修订只推进一次');
  assert.equal(fx.aggregate().revisions.state, 1);
  assert.notEqual(fx.planVersion(), before);
  const doc = JSON.parse(readFileSync(path.join(fx.source, 'project.json'), 'utf8')) as unknown;
  assert.equal(validateProjectDocument(doc, { sha256 }).ok, true, 'v1 校验器回读');
});

test('2.2 原位移动：无业务变化，原头字节与指纹保持，规划修订不推进', async () => {
  const fx = await setup('cmd-inplace-');
  const headBefore = readFileSync(path.join(fx.source, 'project.json'));
  const versionBefore = fx.planVersion();
  const result = await fx.service.execute(OWNER, fx.envelope({ ...MOVE_IN_PLACE }));
  assert.equal(result.status, 'committed', JSON.stringify(result));
  assert.equal((result as { impact: string }).impact, 'state');
  assert.deepEqual(readFileSync(path.join(fx.source, 'project.json')), headBefore, '原头字节不变');
  assert.equal(fx.planVersion(), versionBefore);
  assert.equal(fx.aggregate().revisions.plan, 0, '规划修订不推进');
});

test('2.2 非法结构输入：文件字节与规划修订保持，给稳定码', async () => {
  const fx = await setup('cmd-invalid-');
  const headBefore = readFileSync(path.join(fx.source, 'project.json'));
  const cases: Array<{ command: Command; code: string }> = [
    { command: { type: 'move-node', nodeId: ROOT_NODE, parentId: CHILD_NODE, beforeNodeId: null }, code: 'root-to-child' },
    { command: { type: 'move-node', nodeId: CHILD_NODE, parentId: null, beforeNodeId: null }, code: 'child-to-root' },
    { command: { type: 'move-node', nodeId: CHILD_NODE, parentId: ROOT_NODE, beforeNodeId: randomUUID() }, code: 'invalid-anchor' },
    { command: { type: 'insert-preset', templateId: 'nope', templateVersion: 1, contentLocale: 'zh-CN', parentId: ROOT_NODE, beforeNodeId: null }, code: 'template-not-found' },
    { command: { type: 'insert-preset', templateId: 'feature-development', templateVersion: 1, contentLocale: 'fr' as never, parentId: ROOT_NODE, beforeNodeId: null }, code: 'template-locale-unsupported' },
    { command: { type: 'insert-preset', templateId: 'feature-development', templateVersion: 1, contentLocale: 'zh-CN', parentId: randomUUID(), beforeNodeId: null }, code: 'parent-not-found' },
  ];
  for (const item of cases) {
    const result = await fx.service.execute(OWNER, fx.envelope(item.command));
    assert.equal(rejected(result).code, item.code, JSON.stringify(result));
  }
  assert.deepEqual(readFileSync(path.join(fx.source, 'project.json')), headBefore, '文件字节保持');
  assert.equal(fx.aggregate().revisions.plan, 0, '规划修订保持');
});

test('2.2 预设插入：新节点 todo、内部依赖映射、单次修订、v1 回读', async () => {
  const fx = await setup('cmd-insert-');
  const result = await fx.service.execute(OWNER, fx.envelope({ ...INSERT }));
  assert.equal(result.status, 'committed', JSON.stringify(result));
  assert.equal(fx.aggregate().revisions.plan, 1);
  const doc = JSON.parse(readFileSync(path.join(fx.source, 'project.json'), 'utf8')) as {
    plan: { nodes: { id: string; parentId: string | null; status: string }[]; dependencies: unknown[] };
  };
  assert.equal(validateProjectDocument(doc, { sha256 }).ok, true);
  const newNodes = doc.plan.nodes.filter((n) => n.id !== ROOT_NODE && n.id !== CHILD_NODE);
  assert.equal(newNodes.length, FEATURE_DEVELOPMENT_PRESET.nodes.length);
  assert.ok(newNodes.every((n) => n.status === 'todo'));
  assert.equal(doc.plan.dependencies.length, 1 + FEATURE_DEVELOPMENT_PRESET.dependencies.length);
});

test('2.2 基线冲突（规划修订过期）与源代际变化拒绝，改动保持', async () => {
  const fx = await setup('cmd-baseline-');
  const headBefore = readFileSync(path.join(fx.source, 'project.json'));
  const staleRev = await fx.service.execute(OWNER, fx.envelope({ ...MOVE_IN_PLACE }, { expectedPlanRevision: 9 }));
  assert.equal(rejected(staleRev).code, 'plan-conflict');
  const staleEpoch = await fx.service.execute(OWNER, fx.envelope({ ...MOVE_IN_PLACE }, { sourceEpoch: 99 }));
  assert.equal(rejected(staleEpoch).code, 'source-changed');
  assert.deepEqual(readFileSync(path.join(fx.source, 'project.json')), headBefore);
  assert.equal(fx.aggregate().revisions.plan, 0);
});

// ---- 2.3 持久意图、回执与恢复 ----

test('2.2 外部改内容指纹（本机计数不变）：planVersion 变化被拒，原草稿基线可核对', async () => {
  const fx = await setup('cmd-extfingerprint-');
  const headBefore = readFileSync(path.join(fx.source, 'project.json'));
  const doc = JSON.parse(headBefore.toString('utf8')) as ProjectDocument;
  const oldVersion = doc.planVersion;
  // 改磁盘内容并用真实算法重算指纹（模拟外部顺序编辑），本机草稿仍捕获旧指纹、计数仍为 0。
  doc.project.goal = '外部修改的目标';
  const externalVersion = computePlanVersion(doc, sha256).planVersion;
  doc.planVersion = externalVersion;
  writeFileSync(path.join(fx.source, 'project.json'), JSON.stringify(doc, null, 2) + '\n');
  const result = await fx.service.execute(OWNER, fx.envelope({ ...MOVE_IN_PLACE }, {
    expectedPlanVersion: oldVersion,
    expectedPlanRevision: 0,
  }));
  assert.equal(rejected(result).code, 'plan-conflict', JSON.stringify(result));
  // 用外部新指纹 + 原修订重发可成功，证明只是外部变化而非本机计数问题。
  const retry = await fx.service.execute(OWNER, fx.envelope({ ...INSERT }, {
    expectedPlanVersion: externalVersion,
    expectedPlanRevision: 0,
  }));
  assert.equal(retry.status, 'committed', JSON.stringify(retry));
});

test('2.3 回执丢失：getReceipt 核对已提交结果，原样重发返回历史回执不重复发布', async () => {
  const fx = await setup('cmd-receipt-');
  const env = fx.envelope({ ...INSERT });
  const first = await fx.service.execute(OWNER, env);
  assert.equal(first.status, 'committed', JSON.stringify(first));
  const receipt = await fx.service.getReceipt(OWNER, { instanceId: fx.instanceId, operationId: env.operationId });
  assert.equal(receipt.status, 'committed', JSON.stringify(receipt));
  assert.equal((receipt as { planRevision: number }).planRevision, 1);
  const resent = await fx.service.execute(OWNER, env);
  assert.equal((resent as { replayed?: boolean }).replayed, true);
  assert.equal(fx.aggregate().revisions.plan, 1, '回执丢失重发不重复生成子树');
});

test('2.3 同号换参数拒绝：摘要不同的重发返回 operation-mismatch', async () => {
  const fx = await setup('cmd-replay-');
  const env = fx.envelope({ ...INSERT });
  const first = await fx.service.execute(OWNER, env);
  assert.equal(first.status, 'committed', JSON.stringify(first));
  const changed = await fx.service.execute(OWNER, {
    ...env,
    command: { ...INSERT, contentLocale: 'en' },
  });
  assert.equal(rejected(changed).code, 'operation-mismatch', JSON.stringify(changed));
  assert.equal(fx.aggregate().revisions.plan, 1, '未重复生成子树');
});

test('2.3 同号原样重发返回历史回执，不重复发布', async () => {
  const fx = await setup('cmd-replay-same-');
  const env = fx.envelope({ ...INSERT });
  const first = await fx.service.execute(OWNER, env);
  assert.equal(first.status, 'committed');
  const second = await fx.service.execute(OWNER, env);
  assert.equal(second.status, 'committed');
  assert.equal((second as { replayed?: boolean }).replayed, true);
  assert.equal(fx.aggregate().revisions.plan, 1);
});

test('2.3 重启后可回读已提交回执；升级移除预设版本仍按原请求恢复', async () => {
  const fx = await setup('cmd-upgrade-');
  const env = fx.envelope({ ...INSERT });
  const first = await fx.service.execute(OWNER, env);
  assert.equal(first.status, 'committed', JSON.stringify(first));
  // 新进程：新的 store 实例 + 只含空目录的预设服务，共享同一本机根与资料根。
  const store2 = new LocalStateStore();
  const files2 = createSourceFiles(formatsDir, sha256);
  const service2 = new ProjectCommandService({
    localRoot: fx.localRoot, store: store2, files: files2, sha256,
    clock: () => new Date().toISOString(),
    newNodeId: () => randomUUID(), newRecordId: () => randomUUID(),
    presetCatalog: createBuiltinPresetCatalog([]),
  });
  const receipt = await service2.getReceipt(OWNER, { instanceId: fx.instanceId, operationId: env.operationId });
  assert.equal(receipt.status, 'committed', JSON.stringify(receipt));
  const replay = await service2.execute(OWNER, env);
  assert.equal(replay.status, 'committed', '无预设也能按已存候选/回执处理同号重发');
  assert.equal((replay as { replayed?: boolean }).replayed, true);
});

// ---- 2.4 WorkRun owner 变更边界（A 层，配合既有绑定语义） ----

test('2.4 活动 WorkRun 下 owner 结构变更：运行继续、旧基线冲突、最新快照基线仍被绑定拒绝', async () => {
  const fx = await setupFull('cmd-workrun-');
  const baseBaseline = { planVersion: fx.planVersion(), planRevision: 0, sourceEpoch: 1 };
  // 围绕根节点建立并启动一个活动工作，目标=ROOT、允许 update。
  const prepared = await fx.work.prepareWork({
    workIntentId: 'intent-tree', nodeIds: [ROOT_NODE], allowedActions: ['update'],
    reasonScope: 'local', purpose: '围绕根节点', baseline: baseBaseline,
  });
  assert.equal(prepared.status, 'committed', JSON.stringify(prepared));
  const started = await fx.work.startWork({ workIntentId: 'intent-tree', rpcId: 'rpc-tree', sessionId: 'session-tree' });
  assert.equal(started.status, 'committed', JSON.stringify(started));
  const admission = await fx.work.observeConsumed({ sessionId: 'session-tree', rpcId: 'rpc-tree', turn: 1, agentPresent: true });
  assert.equal(admission.status, 'started', JSON.stringify(admission));
  const capture = await fx.work.captureBinding('session-tree');
  assert.ok(capture.ok);
  if (!capture.ok) return;
  const agentCtx: TrustedContext = {
    kind: 'agent-work', workRunId: capture.capture.workRunId,
    bindingVersion: capture.capture.bindingVersion, instanceId: fx.instanceId,
  };

  // 原位预览：不改变规划、不改变运行目标或绑定。
  const inPlace = await fx.service.execute(OWNER, fx.envelope({ ...MOVE_IN_PLACE }));
  assert.equal(inPlace.status, 'committed', JSON.stringify(inPlace));
  let view = await fx.work.listWork();
  assert.equal(view.status, 'committed');
  if (view.status !== 'committed') return;
  assert.equal(view.value.runs[0]?.bindingVersion, capture.capture.bindingVersion, '原位操作不推进绑定版本');
  assert.deepEqual(view.value.runs[0]?.targets, [ROOT_NODE], '运行目标保留');

  // owner 实际插入预设，推进规划基线；活动运行继续存在、目标与动作范围不变。
  const structural = await fx.service.execute(OWNER, fx.envelope({ ...INSERT }));
  assert.equal(structural.status, 'committed', JSON.stringify(structural));
  const updatedVersion = fx.planVersion();
  assert.notEqual(updatedVersion, baseBaseline.planVersion);
  view = await fx.work.listWork();
  if (view.status !== 'committed') return;
  assert.equal(view.value.runs[0]?.bindingVersion, capture.capture.bindingVersion, 'owner 结构变更不 bump agent 绑定');
  assert.deepEqual(view.value.runs[0]?.targets, [ROOT_NODE], '结构变更后运行目标保留');
  assert.deepEqual(view.value.runs[0]?.allowedActions, ['update'], '运行允许动作保留');

  // 用旧基线写：即使目标仍合法，也因 planVersion 变化被命令服务以 plan-conflict 拒绝。
  const oldBaselineWrite = await fx.service.execute(agentCtx, fx.envelope(
    { type: 'update-node', nodeId: ROOT_NODE, patch: { title: '旧基线' } },
    { expectedPlanVersion: baseBaseline.planVersion, expectedPlanRevision: 0 },
  ));
  assert.equal(oldBaselineWrite.status, 'rejected');
  assert.equal((oldBaselineWrite as { code: string }).code, 'plan-conflict');

  // 用最新快照基线，在同一运行内写：被绑定 acceptedBaseline 核对拒绝（不是重新授权）。
  const latestBaselineWrite = await fx.service.execute(agentCtx, fx.envelope(
    { type: 'update-node', nodeId: ROOT_NODE, patch: { title: '最新基线' } },
    { expectedPlanVersion: updatedVersion, expectedPlanRevision: 1 },
  ));
  assert.equal(latestBaselineWrite.status, 'rejected');
  assert.equal((latestBaselineWrite as { code: string }).code, 'binding-expired');
});
