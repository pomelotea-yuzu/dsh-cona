// 2.1 节点编辑、分组和拆分测试（design §2「批量编辑与结构化替代关系」）。
// 覆盖：完成条件保存与回读（复用 update-node）、分组变换（同父选择、相对顺序、
// 原子树 ID 与依赖保留、锚点定位、order 重编号）、拆分父节点不丢状态和条件、
// 空选择／不同父级／根节点／无效锚点／部分非法输入的整批拒绝、
// 端到端 owner-only 准入与「整批拒绝时头与修订不变」。

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProjectCommandService,
  type Command,
  type CommandEnvelope,
  type CommandResult,
  type TrustedContext,
} from '../src/application/command-service.js';
import { LocalStateService } from '../src/application/local-state.js';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { createSourceFiles } from '../src/adapters/fs/source-files.js';
import { resolveLocalRoot, rootRelation } from '../src/adapters/fs/local-root.js';
import { inspectPrivateRoot } from '../src/adapters/fs/git-guard.js';
import { applyPlanCommand } from '../src/domain/commands.js';
import type { Plan, ProjectDocument, Sha256Fn, WorkNode } from '../src/domain/types.js';
import { computePlanVersion } from '../src/domain/canonical/plan-fingerprint.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sample = path.join(packageRoot, 'formats', 'v1', 'sample-project.json');
const formatsDir = path.join(packageRoot, 'formats', 'v1');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const GROUP_ID = U(900);

function node(partial: Partial<WorkNode> & { id: string }): WorkNode {
  return {
    parentId: null,
    order: 0,
    title: '节点',
    goal: '目标',
    completionCriteria: [],
    status: 'todo',
    ...partial,
  };
}

/** 夹具：根组 [R1,R2]；R1 下 C1,C2,C3；C2 下 G1；依赖 C1→R2、C3→C1。 */
function fixturePlan(): Plan {
  return {
    nodes: [
      node({ id: U(1), title: 'R1', order: 0 }),
      node({ id: U(2), title: 'R2', order: 1 }),
      node({ id: U(3), parentId: U(1), title: 'C1', order: 0 }),
      node({ id: U(4), parentId: U(1), title: 'C2', order: 1 }),
      node({ id: U(5), parentId: U(1), title: 'C3', order: 2 }),
      node({ id: U(6), parentId: U(4), title: 'G1', order: 0 }),
    ],
    dependencies: [
      { nodeId: U(3), requiresNodeId: U(2) },
      { nodeId: U(5), requiresNodeId: U(3) },
    ],
  };
}

function docOf(plan: Plan): ProjectDocument {
  const draft: ProjectDocument = {
    schemaVersion: 1,
    project: { id: U(1), title: 'p', goal: 'g', constraints: [], repositories: [] },
    plan,
    planVersion: '',
    records: [],
  };
  draft.planVersion = computePlanVersion(draft, sha256).planVersion;
  return draft;
}

function apply(plan: Plan, command: Parameters<typeof applyPlanCommand>[1]): { ok: true; plan: Plan } | { ok: false; issues: { code: string }[] } {
  const result = applyPlanCommand(docOf(plan), command, sha256);
  if (!result.ok) return { ok: false, issues: result.issues.map((issue) => ({ code: issue.code })) };
  return { ok: true, plan: result.doc.plan };
}

function codesOf(result: { ok: boolean; issues?: { code: string }[] }): string[] {
  return result.ok ? [] : (result.issues ?? []).map((issue) => issue.code);
}

// ---- 完成条件保存与回读（复用 update-node）----

test('2.1 完成条件保存并回读：patch 只改目标字段，条件逐条保留', () => {
  const plan = fixturePlan();
  const result = apply(plan, {
    type: 'update-node',
    nodeId: U(4),
    patch: { completionCriteria: ['验收脚本通过', '日志无 ERROR'], goal: '新的目标' },
  });
  assert.equal(result.ok, true, JSON.stringify(result.ok === false ? result.issues : []));
  if (!result.ok) return;
  const updated = result.plan.nodes.find((n) => n.id === U(4))!;
  assert.deepEqual(updated.completionCriteria, ['验收脚本通过', '日志无 ERROR']);
  assert.equal(updated.goal, '新的目标');
  assert.equal(updated.title, 'C2');
  assert.equal(updated.status, 'todo');
  // 回读：候选文档中其他节点条件不变。
  const c1 = result.plan.nodes.find((n) => n.id === U(3))!;
  assert.deepEqual(c1.completionCriteria, []);
});

// ---- 分组变换 ----

test('2.1 分组成功：锚点定位、成员相对顺序与原子树 ID、依赖全部保留', () => {
  const plan = fixturePlan();
  // 请求乱序给出 [C3, C1]：分组按原同级顺序（C1,C3）排列，不按请求顺序。
  const result = apply(plan, {
    type: 'group-nodes',
    nodeIds: [U(5), U(3)],
    group: { title: '组节点', goal: '组目标', completionCriteria: ['组条件'] },
    anchorId: U(4),
    newGroupId: GROUP_ID,
  });
  assert.equal(result.ok, true, JSON.stringify(result.ok === false ? result.issues : []));
  if (!result.ok) return;
  const nodes = result.plan.nodes;

  const group = nodes.find((n) => n.id === GROUP_ID)!;
  assert.equal(group.parentId, U(1), '组节点挂在原父级下');
  assert.deepEqual(group.completionCriteria, ['组条件']);

  // R1 同级组：组节点在锚点 C2 之前 → [组, C2]。
  const siblings = nodes.filter((n) => n.parentId === U(1)).sort((a, b) => a.order - b.order);
  assert.deepEqual(siblings.map((n) => n.id), [GROUP_ID, U(4)]);
  assert.deepEqual(siblings.map((n) => n.order), [0, 1]);

  // 成员进组并保持原相对顺序 C1 → C3；原 ID、目标、条件、状态不变。
  const members = nodes.filter((n) => n.parentId === GROUP_ID).sort((a, b) => a.order - b.order);
  assert.deepEqual(members.map((n) => n.id), [U(3), U(5)]);
  assert.deepEqual(members.map((n) => n.order), [0, 1]);
  assert.equal(members[0]!.goal, '目标');
  assert.equal(members.find((n) => n.id === U(3))!.title, 'C1');

  // 后代 ID 与父级不变（G1 仍在 C2 下）。
  const g1 = nodes.find((n) => n.id === U(6))!;
  assert.equal(g1.parentId, U(4));
  assert.equal(g1.order, 0);

  // 显式依赖边全部保留（成员间 + 指向组外）。
  assert.deepEqual(result.plan.dependencies, [
    { nodeId: U(3), requiresNodeId: U(2) },
    { nodeId: U(5), requiresNodeId: U(3) },
  ]);

  // 根组不受影响。
  const roots = nodes.filter((n) => n.parentId === null).sort((a, b) => a.order - b.order);
  assert.deepEqual(roots.map((n) => n.id), [U(1), U(2)]);
});

test('2.1 拆分父节点不丢状态和条件：原节点身份与字段保留，新子节点有序', () => {
  const plan = fixturePlan();
  const withStatus: Plan = {
    nodes: plan.nodes.map((n) => (n.id === U(5) ? { ...n, status: 'in-progress' as const, completionCriteria: ['C3 条件'] } : n)),
    dependencies: plan.dependencies.map((edge) => ({ ...edge })),
  };
  const result = apply(withStatus, {
    type: 'split-node',
    parentId: U(5),
    children: [
      { id: U(21), parentId: U(5), order: 0, title: '子项一', goal: 'g1', completionCriteria: ['条件一'], status: 'todo' },
      { id: U(22), parentId: U(5), order: 1, title: '子项二', goal: 'g2', completionCriteria: [], status: 'todo' },
    ],
  });
  assert.equal(result.ok, true, JSON.stringify(result.ok === false ? result.issues : []));
  if (!result.ok) return;
  const parent = result.plan.nodes.find((n) => n.id === U(5))!;
  assert.equal(parent.status, 'in-progress', '拆分后父节点状态保留');
  assert.deepEqual(parent.completionCriteria, ['C3 条件'], '拆分后父节点条件保留');
  assert.equal(parent.parentId, U(1));
  const children = result.plan.nodes.filter((n) => n.parentId === U(5)).sort((a, b) => a.order - b.order);
  assert.deepEqual(children.map((n) => n.title), ['子项一', '子项二']);
  assert.deepEqual(children.map((n) => n.status), ['todo', 'todo']);
  assert.deepEqual(children.map((n) => n.completionCriteria), [['条件一'], []]);
});

// ---- 负例：整批拒绝 ----

test('2.1 负例整批拒绝：空选择、不同父级、根节点、无效锚点、部分非法', () => {
  const plan = fixturePlan();
  const content = { title: '组', goal: 'g', completionCriteria: [] };

  assert.deepEqual(codesOf(apply(plan, { type: 'group-nodes', nodeIds: [], group: content, anchorId: null, newGroupId: GROUP_ID })), ['empty-selection']);
  // 不同父级（C1 在 R1 下、G1 在 C2 下）。
  assert.deepEqual(codesOf(apply(plan, { type: 'group-nodes', nodeIds: [U(3), U(6)], group: content, anchorId: null, newGroupId: GROUP_ID })), ['cross-parent-selection']);
  // 含根节点。
  assert.deepEqual(codesOf(apply(plan, { type: 'group-nodes', nodeIds: [U(1), U(2)], group: content, anchorId: null, newGroupId: GROUP_ID })), ['root-in-selection']);
  // 锚点不存在。
  assert.deepEqual(codesOf(apply(plan, { type: 'group-nodes', nodeIds: [U(3), U(4)], group: content, anchorId: U(99), newGroupId: GROUP_ID })), ['invalid-anchor']);
  // 锚点不属于同级组（R2 是根）。
  assert.deepEqual(codesOf(apply(plan, { type: 'group-nodes', nodeIds: [U(3), U(4)], group: content, anchorId: U(2), newGroupId: GROUP_ID })), ['invalid-anchor']);
  // 锚点是被选节点之一。
  assert.deepEqual(codesOf(apply(plan, { type: 'group-nodes', nodeIds: [U(3), U(4)], group: content, anchorId: U(4), newGroupId: GROUP_ID })), ['invalid-anchor']);
  // 节点不存在。
  assert.deepEqual(codesOf(apply(plan, { type: 'group-nodes', nodeIds: [U(3), U(99)], group: content, anchorId: null, newGroupId: GROUP_ID })), ['node-not-found']);
  // 组 ID 与现有节点冲突 / 非法 UUID。
  assert.deepEqual(codesOf(apply(plan, { type: 'group-nodes', nodeIds: [U(3), U(4)], group: content, anchorId: null, newGroupId: U(2) })), ['duplicate-node-id']);
  assert.deepEqual(codesOf(apply(plan, { type: 'group-nodes', nodeIds: [U(3), U(4)], group: content, anchorId: null, newGroupId: 'not-a-uuid' })), ['invalid-uuid']);
});

test('2.1 整批拒绝保持输入不变：命令失败不改头、指纹与原节点', () => {
  const plan = fixturePlan();
  const doc = docOf(plan);
  const before = doc.planVersion;
  const result = applyPlanCommand(doc, {
    type: 'group-nodes',
    nodeIds: [U(3), U(99)],
    group: { title: '组', goal: 'g', completionCriteria: [] },
    anchorId: null,
    newGroupId: GROUP_ID,
  }, sha256);
  assert.equal(result.ok, false);
  // 输入文档未被修改：头与指纹原值、原节点未被改动（不可变变换）。
  assert.equal(doc.planVersion, before);
  assert.equal(doc.plan.nodes.length, 6);
  assert.equal(doc.plan.nodes.some((n) => n.id === GROUP_ID), false);
  assert.deepEqual(doc.plan.dependencies, [
    { nodeId: U(3), requiresNodeId: U(2) },
    { nodeId: U(5), requiresNodeId: U(3) },
  ]);
});

// ---- 端到端：owner-only 准入、单次修订与整批拒绝的修订不变 ----

interface Fixture {
  base: string;
  source: string;
  instanceId: string;
  service: ProjectCommandService;
  envelope: (command: Command) => CommandEnvelope;
  /** 提交成功后同步客户端持有的规划基线。 */
  baseline: (result: { planVersion: string; planRevision: number }) => void;
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
    clock: () => new Date().toISOString(),
    newInstanceId: () => randomUUID(),
  });
  const registered = await localState.register({
    localDataRoot: localRoot, sourceRoot: source, sourceKind: 'custom', projectId: U(1),
  });
  assert.equal(registered.ok, true, JSON.stringify(registered.ok === false ? registered.issues : {}));
  if (!registered.ok) throw new Error('register failed');
  const baselineRefresh = await localState.refresh({
    localDataRoot: localRoot,
    instanceId: registered.entry.instanceId,
    baseline: {
      projectId: U(1),
      planVersion: '',
      headHash: 'sha256:' + sha256(new Uint8Array(readFileSync(path.join(source, 'project.json')))),
      records: [],
      observedAt: new Date().toISOString(),
    },
    source,
  });
  assert.equal(baselineRefresh.ok, true, JSON.stringify(baselineRefresh.ok === false ? baselineRefresh.issues : {}));

  const service = new ProjectCommandService({
    localRoot, store, files, sha256,
    clock: () => new Date().toISOString(),
    newNodeId: randomUUID,
    newRecordId: randomUUID,
  });
  const rootDoc = JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as ProjectDocument;
  // 每次成功提交后由测试同步，模拟客户端持有当前规划基线。
  let currentPlanVersion = rootDoc.planVersion;
  let currentPlanRevision = 0;
  const envelope = (command: Command): CommandEnvelope => ({
    operationId: randomUUID(),
    projectId: U(1),
    instanceId: registered.entry.instanceId,
    // refresh 推进过源代际：以最新 entry 为基线（refresh 结果与注册表一致）。
    sourceEpoch: baselineRefresh.ok ? baselineRefresh.entry.sourceGeneration : registered.entry.sourceGeneration,
    expectedPlanVersion: currentPlanVersion,
    expectedPlanRevision: currentPlanRevision,
    command,
  });
  return {
    base,
    source,
    instanceId: registered.entry.instanceId,
    service,
    envelope,
    baseline: (result) => {
      currentPlanVersion = result.planVersion;
      currentPlanRevision = result.planRevision;
    },
  };
}

async function run(fixture: Fixture, ctx: TrustedContext, command: Command): Promise<CommandResult> {
  return fixture.service.execute(ctx, fixture.envelope(command));
}

test('2.1 端到端：owner 分组一次规划提交；agent 直达被拒；整批拒绝修订不变', async () => {
  const fixture = await setup('group-e2e-');
  // 先给根节点加两个普通子节点，再与既有子节点分组。
  const addA: Command = {
    type: 'add-nodes',
    nodes: [
      { parentId: U(2), order: 1, title: '成员A', goal: 'ga', completionCriteria: [] },
      { parentId: U(2), order: 2, title: '成员B', goal: 'gb', completionCriteria: [] },
    ],
  };
  const added = await run(fixture, { kind: 'remote-owner' }, addA);
  assert.equal(added.status, 'committed', JSON.stringify(added));
  if (added.status !== 'committed') return;
  fixture.baseline(added);
  const docAfterAdd = JSON.parse(readFileSync(path.join(fixture.source, 'project.json'), 'utf8')) as ProjectDocument;
  const memberIds = docAfterAdd.plan.nodes.filter((n) => n.title.startsWith('成员')).map((n) => n.id);

  // agent-work 直达：owner-only 结构命令在准入阶段拒绝。
  const agent = await run(fixture, { kind: 'agent-work', workRunId: 'w1', bindingVersion: 1, instanceId: fixture.instanceId }, {
    type: 'group-nodes', nodeIds: memberIds, group: { title: '组', goal: 'g', completionCriteria: [] }, anchorId: null,
  });
  assert.equal(agent.status, 'rejected');
  assert.equal((agent as { code: string }).code, 'forbidden');

  // owner 非法分组（锚点是被选节点）：rejected，磁盘头与规划修订都不变。
  const before = JSON.parse(readFileSync(path.join(fixture.source, 'project.json'), 'utf8')) as ProjectDocument;
  const aggregateBefore = await new LocalStateStore().readAggregate(path.join(fixture.base, 'local'), fixture.instanceId);
  const badAnchor = await run(fixture, { kind: 'remote-owner' }, {
    type: 'group-nodes', nodeIds: memberIds, group: { title: '组', goal: 'g', completionCriteria: [] }, anchorId: memberIds[0]!,
  });
  assert.equal(badAnchor.status, 'rejected');
  assert.equal((badAnchor as { code: string }).code, 'invalid-anchor');
  const aggregateAfter = await new LocalStateStore().readAggregate(path.join(fixture.base, 'local'), fixture.instanceId);
  assert.equal(aggregateAfter!.revisions.plan, aggregateBefore!.revisions.plan);
  const after = JSON.parse(readFileSync(path.join(fixture.source, 'project.json'), 'utf8')) as ProjectDocument;
  assert.equal(after.planVersion, before.planVersion);

  // owner 合法分组：锚 CHILD（0003，根节点既有子），成员相对顺序按原同级序。
  const committed = await run(fixture, { kind: 'remote-owner' }, {
    type: 'group-nodes', nodeIds: memberIds, group: { title: '组节点', goal: '组目标', completionCriteria: ['组条件'] }, anchorId: U(3),
  });
  assert.equal(committed.status, 'committed', JSON.stringify(committed));
  if (committed.status !== 'committed') return;
  assert.equal(committed.planRevision, added.planRevision + 1, '恰好推进一次规划修订');

  const doc = JSON.parse(readFileSync(path.join(fixture.source, 'project.json'), 'utf8')) as ProjectDocument;
  const groupNode = doc.plan.nodes.find((n) => n.title === '组节点');
  assert.ok(groupNode, '组节点已发布到公开资料');
  const members = doc.plan.nodes.filter((n) => n.parentId === groupNode!.id).sort((a, b) => a.order - b.order);
  assert.deepEqual(members.map((n) => n.title), ['成员A', '成员B']);
  // 既有子节点（阶段1.1）仍在根下，组节点在它之前。
  const rootSiblings = doc.plan.nodes.filter((n) => n.parentId === U(2)).sort((a, b) => a.order - b.order);
  assert.deepEqual(rootSiblings.map((n) => n.title), ['组节点', '阶段1.1']);
  // 依赖边保留：CHILD→ROOT 与成员的原有依赖不受分组影响。
  assert.ok(doc.plan.dependencies.some((edge) => edge.nodeId === U(3)));
});
