// 2.2 合并与复制的候选测试（design §2「批量编辑与结构化替代关系」「两类公开记录的正文与互操作」）。
// 覆盖：合并变换（来源 canceled 原 ID、后代移入、依赖三处置、未处置/环拒绝）、
// 复制变换（新子树 todo、内部依赖映射、外部依赖按确认接入、ID 数量与位置校验）、
// 端到端 owner 原子发布（替代记录一次权威头 + 同号幂等）、独立校验器（正例、
// 解除、重复解除、引用错误、成环）。

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
import { buildReplacementClearText, parseReplacementText, REPLACEMENT_SUMMARY_PREFIX } from '../src/domain/replacement.js';
import type { Plan, ProjectDocument, Sha256Fn, WorkNode } from '../src/domain/types.js';
import { computePlanVersion } from '../src/domain/canonical/plan-fingerprint.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sample = path.join(packageRoot, 'formats', 'v1', 'sample-project.json');
const formatsDir = path.join(packageRoot, 'formats', 'v1');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

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

/** 夹具：根组 [R1,R2]；R1 下 C1,C2,C3；C2 下 G1、G2；依赖 C1→R2、C3→C1、G1→G2。 */
function fixturePlan(): Plan {
  return {
    nodes: [
      node({ id: U(1), title: 'R1', order: 0 }),
      node({ id: U(2), title: 'R2', order: 1 }),
      node({ id: U(3), parentId: U(1), title: 'C1', order: 0 }),
      node({ id: U(4), parentId: U(1), title: 'C2', order: 1 }),
      node({ id: U(5), parentId: U(1), title: 'C3', order: 2 }),
      node({ id: U(6), parentId: U(4), title: 'G1', order: 0 }),
      node({ id: U(7), parentId: U(4), title: 'G2', order: 1 }),
    ],
    dependencies: [
      { nodeId: U(3), requiresNodeId: U(2) },
      { nodeId: U(5), requiresNodeId: U(3) },
      { nodeId: U(6), requiresNodeId: U(7) },
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

// ---- 合并变换 ----

test('2.2 合并成功：来源 canceled 原 ID、后代移入保留节点、补丁与依赖三处置', () => {
  const plan = fixturePlan();
  // 合并 C1、C3 到 C2：C1 的后代无、C3 无后代；G1/G2 是 C2 的原有子级。
  const result = apply(plan, {
    type: 'merge-nodes',
    keepNodeId: U(4),
    sourceNodeIds: [U(3), U(5)],
    patch: { goal: '合并后的目标', completionCriteria: ['合并条件'] },
    resolutions: [
      { edge: { nodeId: U(3), requiresNodeId: U(2) }, action: 'reattach' }, // C1→R2 变 C2→R2
      { edge: { nodeId: U(5), requiresNodeId: U(3) }, action: 'drop' },     // 来源间依赖删除
    ],
  });
  assert.equal(result.ok, true, JSON.stringify(result.ok === false ? result.issues : []));
  if (!result.ok) return;
  const nodes = result.plan.nodes;

  // 来源以原 ID 保留为 canceled，原父级原位置不变。
  const c1 = nodes.find((n) => n.id === U(3))!;
  const c3 = nodes.find((n) => n.id === U(5))!;
  assert.equal(c1.status, 'canceled');
  assert.equal(c3.status, 'canceled');
  assert.equal(c1.parentId, U(1));
  assert.equal(c1.title, 'C1');
  assert.deepEqual(c1.completionCriteria, []);

  // 保留节点应用补丁。
  const keep = nodes.find((n) => n.id === U(4))!;
  assert.equal(keep.goal, '合并后的目标');
  assert.deepEqual(keep.completionCriteria, ['合并条件']);
  assert.equal(keep.status, 'todo');

  // 依赖处置：C1→R2 重接为 C2→R2，来源间依赖删除；不触及来源的 G1→G2 原样保留。
  assert.deepEqual(result.plan.dependencies, [
    { nodeId: U(4), requiresNodeId: U(2) },
    { nodeId: U(6), requiresNodeId: U(7) },
  ]);

  // R1 同级次序不变（来源留在原位）。
  const siblings = nodes.filter((n) => n.parentId === U(1)).sort((a, b) => a.order - b.order);
  assert.deepEqual(siblings.map((n) => n.id), [U(3), U(4), U(5)]);
});

test('2.2 合并把来源后代移入保留节点：相对顺序保持，追加到保留节点子级末尾', () => {
  const plan = fixturePlan();
  // 把 C2 并入 C1：C2 的后代 G1、G2 移到 C1 下（C1 无子级 → order 0/1）。
  const result = apply(plan, {
    type: 'merge-nodes',
    keepNodeId: U(3),
    sourceNodeIds: [U(4)],
    resolutions: [],
  });
  assert.equal(result.ok, true, JSON.stringify(result.ok === false ? result.issues : []));
  if (!result.ok) return;
  const moved = result.plan.nodes.filter((n) => n.parentId === U(3)).sort((a, b) => a.order - b.order);
  assert.deepEqual(moved.map((n) => n.id), [U(6), U(7)]);
  assert.deepEqual(moved.map((n) => n.order), [0, 1]);
  assert.equal(moved[0]!.status, 'todo', '后代字段不变');
  const c2 = result.plan.nodes.find((n) => n.id === U(4))!;
  assert.equal(c2.status, 'canceled');
  // keep 依赖原样保留。
  assert.ok(result.plan.dependencies.some((edge) => edge.nodeId === U(6) && edge.requiresNodeId === U(7)));
});

test('2.2 合并负例：未处置依赖、外部处置、跨父级、来源含保留、重复、自依赖环', () => {
  const plan = fixturePlan();
  // 未处置：C1→R2 没有给出处置。
  assert.deepEqual(codesOf(apply(plan, {
    type: 'merge-nodes', keepNodeId: U(4), sourceNodeIds: [U(3), U(5)], resolutions: [],
  })), ['unresolved-dependency']);
  // 处置了不触及来源的边。
  assert.deepEqual(codesOf(apply(plan, {
    type: 'merge-nodes', keepNodeId: U(4), sourceNodeIds: [U(3), U(5)],
    resolutions: [
      { edge: { nodeId: U(3), requiresNodeId: U(2) }, action: 'reattach' },
      { edge: { nodeId: U(5), requiresNodeId: U(3) }, action: 'drop' },
      { edge: { nodeId: U(6), requiresNodeId: U(7) }, action: 'keep' },
    ],
  })), ['dependency-not-found']);
  // 跨父级（G1 在 C2 下）。
  assert.deepEqual(codesOf(apply(plan, {
    type: 'merge-nodes', keepNodeId: U(4), sourceNodeIds: [U(6)], resolutions: [],
  })), ['cross-parent-selection']);
  // 保留节点出现在来源中。
  assert.deepEqual(codesOf(apply(plan, {
    type: 'merge-nodes', keepNodeId: U(3), sourceNodeIds: [U(3), U(5)],
    resolutions: [
      { edge: { nodeId: U(3), requiresNodeId: U(2) }, action: 'drop' },
      { edge: { nodeId: U(5), requiresNodeId: U(3) }, action: 'drop' },
    ],
  })), ['invalid-merge-source']);
  // 来源重复。
  assert.deepEqual(codesOf(apply(plan, {
    type: 'merge-nodes', keepNodeId: U(4), sourceNodeIds: [U(3), U(3)],
    resolutions: [
      { edge: { nodeId: U(3), requiresNodeId: U(2) }, action: 'reattach' },
      { edge: { nodeId: U(5), requiresNodeId: U(3) }, action: 'drop' },
    ],
  })), ['duplicate-merge-source']);
  // 重接成自依赖：C2 requires C3 存在时把两端都重接到 keep 会形成自依赖。
  const cyclic: Plan = {
    nodes: plan.nodes,
    dependencies: [
      ...plan.dependencies,
      { nodeId: U(4), requiresNodeId: U(3) },
    ],
  };
  assert.deepEqual(
    codesOf(apply(cyclic, {
      type: 'merge-nodes', keepNodeId: U(4), sourceNodeIds: [U(3)],
      resolutions: [
        { edge: { nodeId: U(3), requiresNodeId: U(2) }, action: 'reattach' },
        { edge: { nodeId: U(5), requiresNodeId: U(3) }, action: 'reattach' },
        { edge: { nodeId: U(4), requiresNodeId: U(3) }, action: 'reattach' },
      ],
    })).filter((code) => code === 'dependency-cycle' || code === 'self-dependency'),
    ['self-dependency', 'dependency-cycle'],
  );
});

// ---- 复制变换 ----

test('2.2 复制成功：新子树 todo、内部依赖映射、外部依赖按确认接入、原树不动', () => {
  const plan = fixturePlan();
  // 复制 C2 子树（C2、G1、G2 共 3 节点）到 R1 下、锚 C1 之前；接入 C2 的外部边（C1→R2 不触及 C2 子树；G1→G2 是内部）。
  const result = apply(plan, {
    type: 'copy-subtree',
    nodeId: U(4),
    targetParentId: U(1),
    anchorId: U(3),
    newIds: [U(31), U(32), U(33)],
    externalDependencies: [],
  });
  assert.equal(result.ok, true, JSON.stringify(result.ok === false ? result.issues : []));
  if (!result.ok) return;
  const nodes = result.plan.nodes;
  // 新子树：根复制节点在锚点前，成员结构映射。
  const copyRoot = nodes.find((n) => n.id === U(31))!;
  assert.equal(copyRoot.parentId, U(1));
  assert.equal(copyRoot.title, 'C2');
  assert.equal(copyRoot.status, 'todo');
  const g1 = nodes.find((n) => n.id === U(32))!;
  const g2 = nodes.find((n) => n.id === U(33))!;
  assert.equal(g1.parentId, U(31));
  assert.equal(g2.parentId, U(31));
  assert.deepEqual(g1.completionCriteria, [], '复制保留目标与条件');
  // 内部依赖映射到新 ID。
  assert.ok(result.plan.dependencies.some((edge) => edge.nodeId === U(32) && edge.requiresNodeId === U(33)));
  // 原树不动：原 C2/G1/G2 仍在且依赖边保留。
  assert.ok(nodes.some((n) => n.id === U(4) && n.parentId === U(1)));
  assert.ok(result.plan.dependencies.some((edge) => edge.nodeId === U(6) && edge.requiresNodeId === U(7)));
  // R1 同级：复制根在 C1 前。
  const siblings = nodes.filter((n) => n.parentId === U(1)).sort((a, b) => a.order - b.order);
  assert.deepEqual(siblings.map((n) => n.id), [U(31), U(3), U(4), U(5)]);
});

test('2.2 复制外部依赖按确认接入；未列出的不接入', () => {
  const plan = fixturePlan();
  // G1 的内部边 G1→G2 保持；接入外部边 C1→R2 到副本？C1 不在 C2 子树——外部边必须触及子树一端。
  // 用外部边：C1→R2 不触及 C2 子树 → 拒绝；构造触及：G1 requires C1（外部）。
  const withExternal: Plan = {
    nodes: plan.nodes,
    dependencies: [...plan.dependencies, { nodeId: U(6), requiresNodeId: U(3) }],
  };
  // 未列出：副本无该边。
  const none = apply(withExternal, {
    type: 'copy-subtree', nodeId: U(4), targetParentId: U(1), anchorId: null,
    newIds: [U(41), U(42), U(43)], externalDependencies: [],
  });
  assert.equal(none.ok, true);
  if (none.ok) {
    assert.ok(!none.plan.dependencies.some((edge) => edge.nodeId === U(42) && edge.requiresNodeId === U(3)));
  }
  // 列出：副本接入 G1'→C1。
  const adopted = apply(withExternal, {
    type: 'copy-subtree', nodeId: U(4), targetParentId: U(1), anchorId: null,
    newIds: [U(41), U(42), U(43)], externalDependencies: [{ nodeId: U(6), requiresNodeId: U(3) }],
  });
  assert.equal(adopted.ok, true, JSON.stringify(adopted.ok === false ? adopted.issues : []));
  if (adopted.ok) {
    assert.ok(adopted.plan.dependencies.some((edge) => edge.nodeId === U(42) && edge.requiresNodeId === U(3)));
  }
  // 两端都在子树内的边不是外部依赖 → 拒绝。
  assert.deepEqual(codesOf(apply(withExternal, {
    type: 'copy-subtree', nodeId: U(4), targetParentId: U(1), anchorId: null,
    newIds: [U(41), U(42), U(43)], externalDependencies: [{ nodeId: U(6), requiresNodeId: U(7) }],
  })), ['dependency-not-found']);
});

test('2.2 复制负例：ID 数量不符、目标父缺失、锚点无效、源缺失', () => {
  const plan = fixturePlan();
  assert.deepEqual(codesOf(apply(plan, {
    type: 'copy-subtree', nodeId: U(4), targetParentId: U(1), anchorId: null,
    newIds: [U(41), U(42)], externalDependencies: [],
  })), ['copy-id-count-mismatch']);
  assert.deepEqual(codesOf(apply(plan, {
    type: 'copy-subtree', nodeId: U(4), targetParentId: null, anchorId: null,
    newIds: [U(41), U(42), U(43)], externalDependencies: [],
  })), ['parent-not-found']);
  assert.deepEqual(codesOf(apply(plan, {
    type: 'copy-subtree', nodeId: U(4), targetParentId: U(1), anchorId: U(6),
    newIds: [U(41), U(42), U(43)], externalDependencies: [],
  })), ['invalid-anchor']);
  assert.deepEqual(codesOf(apply(plan, {
    type: 'copy-subtree', nodeId: U(99), targetParentId: U(1), anchorId: null,
    newIds: [U(41)], externalDependencies: [],
  })), ['node-not-found']);
});

// ---- 端到端：原子发布替代记录 + 幂等 + 独立校验器 ----

const PROJECT_ID = U(1);
const ROOT_NODE = U(2);
const CHILD_NODE = U(3);

interface Fixture {
  base: string;
  source: string;
  instanceId: string;
  service: ProjectCommandService;
  envelope: (command: Command) => CommandEnvelope;
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
    localDataRoot: localRoot, sourceRoot: source, sourceKind: 'custom', projectId: PROJECT_ID,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered.ok === false ? registered.issues : {}));
  if (!registered.ok) throw new Error('register failed');
  const baselineRefresh = await localState.refresh({
    localDataRoot: localRoot,
    instanceId: registered.entry.instanceId,
    baseline: {
      projectId: PROJECT_ID,
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
  let currentPlanVersion = rootDoc.planVersion;
  let currentPlanRevision = 0;
  const envelope = (command: Command): CommandEnvelope => ({
    operationId: randomUUID(),
    projectId: PROJECT_ID,
    instanceId: registered.entry.instanceId,
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

const OWNER: TrustedContext = { kind: 'remote-owner' };

test('2.2 端到端：合并原子发布替代记录；同号幂等；agent 直达拒绝', async () => {
  const fixture = await setup('merge-e2e-');
  // 先加第二个普通子节点，再把两个子节点并入既有 CHILD（…0003）。
  const added = await fixture.service.execute(OWNER, fixture.envelope({
    type: 'add-nodes',
    nodes: [{ parentId: ROOT_NODE, order: 1, title: '成员A', goal: 'ga', completionCriteria: [] }],
  }));
  assert.equal(added.status, 'committed', JSON.stringify(added));
  if (added.status !== 'committed') return;
  fixture.baseline(added);
  const docAfterAdd = JSON.parse(readFileSync(path.join(fixture.source, 'project.json'), 'utf8')) as ProjectDocument;
  const memberId = docAfterAdd.plan.nodes.find((n) => n.title === '成员A')!.id;

  // agent 直达：owner-only。
  const agent = await fixture.service.execute({ kind: 'agent-work', workRunId: 'w1', bindingVersion: 1, instanceId: fixture.instanceId }, fixture.envelope({
    type: 'merge-nodes', keepNodeId: CHILD_NODE, sourceNodeIds: [memberId], resolutions: [],
  }));
  assert.equal(agent.status, 'rejected');
  assert.equal((agent as { code: string }).code, 'forbidden');

  const mergeEnvelope = fixture.envelope({
    type: 'merge-nodes',
    keepNodeId: CHILD_NODE,
    sourceNodeIds: [memberId],
    resolutions: [],
  });
  const merged = await fixture.service.execute(OWNER, mergeEnvelope);
  assert.ok(merged.status === 'committed', JSON.stringify(merged));
  if (merged.status !== 'committed') return;
  fixture.baseline(merged);
  assert.ok(merged.recordId !== undefined, '回执携带替代记录 id');

  const doc = JSON.parse(readFileSync(path.join(fixture.source, 'project.json'), 'utf8')) as ProjectDocument;
  const record = doc.records.find((item) => item.id === merged.recordId)!;
  assert.equal(record.kind, 'plan-change');
  assert.ok(record.summary.startsWith(REPLACEMENT_SUMMARY_PREFIX), '摘要前缀精确');
  assert.deepEqual(record.subjectNodeIds, [CHILD_NODE, memberId]);
  const bodyText = readFileSync(path.join(fixture.source, ...record.path.split('/')), 'utf8');
  const parsed = parseReplacementText(bodyText);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.ok === false ? parsed.issues : []));
  if (parsed.ok && parsed.body.kind === 'replace') {
    assert.deepEqual(parsed.body.sourceNodeIds, [memberId]);
    assert.equal(parsed.body.replacementNodeId, CHILD_NODE);
  }
  const sourceNode = doc.plan.nodes.find((n) => n.id === memberId)!;
  assert.equal(sourceNode.status, 'canceled', '来源以原 ID 保留为 canceled');

  // 同号重试：返回原回执，不重复执行（替代记录仍只有一条）。
  // 同号重试必须原样重发原请求（含提交时的旧基线），只复用 operationId。
  const retry = await fixture.service.execute(OWNER, { ...mergeEnvelope, operationId: (merged as { operationId: string }).operationId });
  assert.equal(retry.status, 'committed');
  assert.equal((retry as { replayed?: boolean }).replayed, true);
  const docAfterRetry = JSON.parse(readFileSync(path.join(fixture.source, 'project.json'), 'utf8')) as ProjectDocument;
  assert.equal(docAfterRetry.records.filter((item) => item.summary.startsWith(REPLACEMENT_SUMMARY_PREFIX)).length, 1);

  // 独立校验器对已发布资料通过。
  const output = execFileSync(process.execPath, [
    path.join(packageRoot, 'lib', 'cli', 'validate-replacement.js'),
    '--source', fixture.source,
  ], { encoding: 'utf8' });
  assert.ok(output.includes('replacement 校验通过'), output);
});

test('2.2 独立校验器：解除通过；重复解除与引用错误拒绝', async () => {
  const base = mkdtempSync(path.join(artifacts, 'repl-validator-'));
  const source = path.join(base, 'source');
  mkdirSync(source, { recursive: true });
  copyFileSync(sample, path.join(source, 'project.json'));

  // 手工构造：加两个子节点 + replace 记录 + clear 记录，逐条写公开资料。
  const doc = JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as ProjectDocument;
  const memberA = randomUUID();
  const memberB = randomUUID();
  doc.plan.nodes.push(
    { id: memberA, parentId: ROOT_NODE, order: 1, title: '成员A', goal: 'ga', completionCriteria: [], status: 'canceled' },
    { id: memberB, parentId: ROOT_NODE, order: 2, title: '成员B', goal: 'gb', completionCriteria: [], status: 'todo' },
  );
  doc.planVersion = computePlanVersion(doc, sha256).planVersion;

  const replaceRecordId = randomUUID();
  const clearRecordId = randomUUID();
  const replaceBody = JSON.stringify({
    version: 1, kind: 'replace',
    sourceNodeIds: [memberA],
    replacementNodeId: CHILD_NODE,
  }, null, 2);
  const replaceText = ['<!-- cona:replacement v1 -->', '', '```json', replaceBody, '```', '', '## 节点替代记录', ''].join('\n');
  const replaceBytes = new TextEncoder().encode(replaceText);
  const replaceHash = 'sha256:' + sha256(replaceBytes);
  const replacePath = `records/${replaceRecordId}/${replaceHash.slice('sha256:'.length)}.md`;
  mkdirSync(path.join(source, 'records', replaceRecordId), { recursive: true });
  writeFileSync(path.join(source, ...replacePath.split('/')), replaceText);
  doc.records.push({
    id: replaceRecordId, kind: 'plan-change', subjectNodeIds: [CHILD_NODE, memberA],
    path: replacePath, contentHash: replaceHash, summary: `${REPLACEMENT_SUMMARY_PREFIX}1 个来源并入 ${CHILD_NODE}`, sources: [],
  });

  // 反例：clear 引用不存在的记录 → 校验器失败。
  const badClearBody = JSON.stringify({ version: 1, kind: 'clear', clearsRecordId: randomUUID() }, null, 2);
  const badClearText = ['<!-- cona:replacement v1 -->', '', '```json', badClearBody, '```', '', '## 解除', ''].join('\n');
  const badBytes = new TextEncoder().encode(badClearText);
  const badHash = 'sha256:' + sha256(badBytes);
  const badPath = `records/${clearRecordId}/${badHash.slice('sha256:'.length)}.md`;
  mkdirSync(path.join(source, 'records', clearRecordId), { recursive: true });
  writeFileSync(path.join(source, ...badPath.split('/')), badClearText);
  doc.records.push({
    id: clearRecordId, kind: 'plan-change', subjectNodeIds: [CHILD_NODE],
    path: badPath, contentHash: badHash, summary: `${REPLACEMENT_SUMMARY_PREFIX}解除`, sources: [],
  });
  doc.planVersion = computePlanVersion(doc, sha256).planVersion;
  writeFileSync(path.join(source, 'project.json'), JSON.stringify(doc, null, 2) + '\n');

  const validator = path.join(packageRoot, 'lib', 'cli', 'validate-replacement.js');
  let failed = '';
  try {
    execFileSync(process.execPath, [validator, '--source', source, '--quiet'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    failed = (error as { stderr?: string }).stderr ?? '';
  }
  assert.ok(failed.includes('clear 指向不存在'), `应为引用错误：${failed}`);

  // 修正：clear 指向真实 replace → 通过；再加一条重复 clear → 失败。
  const goodClearText = ['<!-- cona:replacement v1 -->', '', '```json', JSON.stringify({ version: 1, kind: 'clear', clearsRecordId: replaceRecordId }, null, 2), '```', '', '## 解除', ''].join('\n');
  const goodBytes = new TextEncoder().encode(goodClearText);
  const goodHash = 'sha256:' + sha256(goodBytes);
  const goodPath = `records/${clearRecordId}/${goodHash.slice('sha256:'.length)}.md`;
  writeFileSync(path.join(source, ...goodPath.split('/')), goodClearText);
  doc.records = doc.records.map((item) => (item.id === clearRecordId ? { ...item, path: goodPath, contentHash: goodHash } : item));
  doc.planVersion = computePlanVersion(doc, sha256).planVersion;
  writeFileSync(path.join(source, 'project.json'), JSON.stringify(doc, null, 2) + '\n');
  const output = execFileSync(process.execPath, [validator, '--source', source], { encoding: 'utf8' });
  assert.ok(output.includes('replacement 校验通过'), output);

  const dupClearId = randomUUID();
  const dupText = buildReplacementClearText({ version: 1, kind: 'clear', clearsRecordId: replaceRecordId });
  const dupBytes = new TextEncoder().encode(dupText);
  const dupHash = 'sha256:' + sha256(dupBytes);
  const dupPath = `records/${dupClearId}/${dupHash.slice('sha256:'.length)}.md`;
  mkdirSync(path.join(source, 'records', dupClearId), { recursive: true });
  writeFileSync(path.join(source, ...dupPath.split('/')), dupText);
  doc.records.push({
    id: dupClearId, kind: 'plan-change', subjectNodeIds: [CHILD_NODE],
    path: dupPath, contentHash: dupHash, summary: `${REPLACEMENT_SUMMARY_PREFIX}解除`, sources: [],
  });
  doc.planVersion = computePlanVersion(doc, sha256).planVersion;
  writeFileSync(path.join(source, 'project.json'), JSON.stringify(doc, null, 2) + '\n');
  let dupFailed = '';
  try {
    execFileSync(process.execPath, [validator, '--source', source, '--quiet'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    dupFailed = (error as { stderr?: string }).stderr ?? '';
  }
  assert.ok(dupFailed.includes('重复解除'), `应为重复解除：${dupFailed}`);
});
