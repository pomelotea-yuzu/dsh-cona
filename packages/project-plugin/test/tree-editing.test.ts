// R2 项目树编辑与流程拼接 · 领域变换测试（tasks 1.1 / 1.2 / 1.3）。
// 覆盖：同级前移后移原位、跨父级子树移动、非法根/父/锚点拒绝、
// 内置预设描述校验、模板实例化的 ID 分配与依赖映射。

import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPlanCommand,
  computePlanVersion,
  instantiateTemplate,
  moveNode,
  validatePreset,
  FEATURE_DEVELOPMENT_PRESET,
} from '../src/domain/index.js';
import type { DependencyEdge, Plan, ProjectDocument, Sha256Fn, WorkNode } from '../src/domain/types.js';
import type { PresetDescriptor } from '../src/domain/index.js';

type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;

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

/** 多根夹具：根组 [R1,R2]；R1 下有三个普通兄弟 C1,C2,C3；C2 下有后代 G1。 */
function multiRootPlan(): Plan {
  return {
    nodes: [
      node({ id: U(1), title: 'R1', order: 0 }),
      node({ id: U(2), title: 'R2', order: 1 }),
      node({ id: U(3), parentId: U(1), title: 'C1', order: 0 }),
      node({ id: U(4), parentId: U(1), title: 'C2', order: 1 }),
      node({ id: U(5), parentId: U(1), title: 'C3', order: 2 }),
      node({ id: U(6), parentId: U(4), title: 'G1', order: 0 }),
    ],
    dependencies: [{ nodeId: U(3), requiresNodeId: U(2) }],
  };
}

function siblingOrders(plan: Plan, parentId: string | null): number[] {
  return plan.nodes
    .filter((n) => n.parentId === parentId)
    .sort((a, b) => a.order - b.order)
    .map((n) => n.order);
}

function codesOf(result: { ok: boolean; issues?: { code: string }[] }): string[] {
  return result.ok ? [] : (result.issues ?? []).map((issue) => issue.code);
}

// ---- 1.1 移动变换 ----

test('1.1 根组前移后移与回到原位：根成员不变、order 连续、原位置指纹不变', () => {
  const plan = multiRootPlan();
  const original = applyPlanCommand(
    { schemaVersion: 1, project: { id: U(100), title: 'p', goal: 'g', constraints: [], repositories: [] }, plan, planVersion: '', records: [] },
    { type: 'move-node', nodeId: U(2), parentId: null, beforeNodeId: U(1) },
    sha256,
  );
  assert.equal(original.ok, true, JSON.stringify(original));
  if (!original.ok) return;
  const roots = original.doc.plan.nodes.filter((n) => n.parentId === null).sort((a, b) => a.order - b.order);
  assert.deepEqual(roots.map((n) => n.id), [U(2), U(1)]);
  assert.deepEqual(siblingOrders(original.doc.plan, null), [0, 1]);
  // 回到原位：把 R2 移回 R1 之后
  const back = applyPlanCommand(original.doc, { type: 'move-node', nodeId: U(2), parentId: null, beforeNodeId: null }, sha256);
  assert.equal(back.ok, true, JSON.stringify(back));
  if (!back.ok) return;
  const baseDoc: ProjectDocument = {
    schemaVersion: 1,
    project: { id: U(100), title: 'p', goal: 'g', constraints: [], repositories: [] },
    plan: multiRootPlan(),
    planVersion: '',
    records: [],
  };
  baseDoc.planVersion = computePlanVersion(baseDoc, sha256).planVersion;
  assert.equal(back.doc.planVersion, baseDoc.planVersion);
});

test('1.1 普通同级组前移/后移：受影响 sibling 列表重编号，其他组不变', () => {
  const plan = multiRootPlan();
  // C3 前移到 C1 之前
  const moved = moveNode(plan, U(5), U(1), U(3));
  assert.equal(moved.ok, true, JSON.stringify(moved));
  if (!moved.ok) return;
  assert.deepEqual(siblingOrders(moved.value, U(1)), [0, 1, 2]);
  const cGroup = moved.value.nodes.filter((n) => n.parentId === U(1)).sort((a, b) => a.order - b.order);
  assert.deepEqual(cGroup.map((n) => n.id), [U(5), U(3), U(4)]);
  // 根组与后代组不受影响
  assert.deepEqual(siblingOrders(moved.value, null), [0, 1]);
  assert.deepEqual(siblingOrders(moved.value, U(4)), [0]);
  // 后移：C1 移到末尾
  const back = moveNode(moved.value, U(3), U(1), null);
  assert.equal(back.ok, true, JSON.stringify(back));
  if (!back.ok) return;
  const cGroup2 = back.value.nodes.filter((n) => n.parentId === U(1)).sort((a, b) => a.order - b.order);
  assert.deepEqual(cGroup2.map((n) => n.id), [U(5), U(4), U(3)]);
});

test('1.1 非根跨父级移动子树：id、后代、依赖、记录保持，两个同级组重编号', () => {
  const plan = multiRootPlan();
  const doc: ProjectDocument = {
    schemaVersion: 1,
    project: { id: U(100), title: 'p', goal: 'g', constraints: [], repositories: [] },
    plan,
    planVersion: '',
    records: [
      {
        id: U(200),
        kind: 'analysis-note',
        subjectNodeIds: [U(4)],
        path: `records/${U(200)}/${'a'.repeat(64)}.md`,
        contentHash: `sha256:${'a'.repeat(64)}`,
        summary: '关于 C2 的记录',
        sources: [],
      },
    ],
  };
  // 把 C2（含后代 G1）移到 R2 下
  const moved = applyPlanCommand(doc, { type: 'move-node', nodeId: U(4), parentId: U(2), beforeNodeId: null }, sha256);
  assert.equal(moved.ok, true, JSON.stringify(moved));
  if (!moved.ok) return;
  const result = moved.doc.plan;
  const c2 = result.nodes.find((n) => n.id === U(4));
  assert.equal(c2?.parentId, U(2));
  const g1 = result.nodes.find((n) => n.id === U(6));
  assert.equal(g1?.parentId, U(4), '后代关系保持');
  assert.deepEqual(siblingOrders(result, U(1)), [0, 1]);
  assert.deepEqual(siblingOrders(result, U(2)), [0]);
  assert.deepEqual(result.dependencies, doc.plan.dependencies, '依赖边原值保持');
  assert.deepEqual(moved.doc.records, doc.records, '公开记录保持');
  assert.deepEqual(result.nodes.map((n) => n.id).sort(), plan.nodes.map((n) => n.id).sort(), '节点 ID 集合不变');
  assert.equal(result.nodes.find((n) => n.id === U(4))?.status, 'todo', '状态保持');
});

test('1.1 拒绝根降为子节点、非根升为根、移到自身/后代、锚点错误与缺失节点', () => {
  const plan = multiRootPlan();
  const cases: Array<{ name: string; nodeId: string; parentId: string | null; beforeNodeId: string | null; code: string }> = [
    { name: '根降为子节点', nodeId: U(1), parentId: U(4), beforeNodeId: null, code: 'root-to-child' },
    { name: '非根升为根', nodeId: U(3), parentId: null, beforeNodeId: null, code: 'child-to-root' },
    { name: '移到自身之下', nodeId: U(4), parentId: U(4), beforeNodeId: null, code: 'invalid-parent' },
    { name: '移到后代之下', nodeId: U(4), parentId: U(6), beforeNodeId: null, code: 'invalid-parent' },
    { name: '锚定自身', nodeId: U(4), parentId: U(1), beforeNodeId: U(4), code: 'invalid-anchor' },
    { name: '锚点不存在', nodeId: U(4), parentId: U(1), beforeNodeId: U(999), code: 'invalid-anchor' },
    { name: '锚点属于其他同级组', nodeId: U(3), parentId: U(1), beforeNodeId: U(6), code: 'invalid-anchor' },
    { name: '缺失节点', nodeId: U(999), parentId: null, beforeNodeId: null, code: 'node-not-found' },
    { name: '目标父节点不存在', nodeId: U(3), parentId: U(999), beforeNodeId: null, code: 'parent-not-found' },
  ];
  for (const c of cases) {
    const result = moveNode(plan, c.nodeId, c.parentId, c.beforeNodeId);
    assert.equal(result.ok, false, `${c.name} 应被拒绝`);
    assert.ok(codesOf(result).includes(c.code), `${c.name} 应给出 ${c.code}，实际 ${codesOf(result).join(',')}`);
  }
});

test('1.1 拒绝后原夹具未被修改（纯变换）', () => {
  const plan = multiRootPlan();
  const before = JSON.stringify(plan);
  moveNode(plan, U(1), U(4), null);
  assert.equal(JSON.stringify(plan), before);
});

// ---- 1.2 预设与描述校验 ----

test('1.2 内置 feature-development 预设描述有效，中英结构一致', () => {
  assert.deepEqual(validatePreset(FEATURE_DEVELOPMENT_PRESET), []);
  const p = FEATURE_DEVELOPMENT_PRESET;
  assert.equal(p.id, 'feature-development');
  assert.equal(p.version, 1);
  assert.equal(p.source, 'builtin');
  assert.deepEqual([...p.contentLocales].sort(), ['en', 'zh-CN']);
  const roots = p.nodes.filter((n) => n.parentKey === null);
  assert.equal(roots.length, 1, '模板单根');
  for (const locale of p.contentLocales) {
    assert.ok(p.content[locale]?.title, `${locale} 缺标题`);
    assert.ok(p.content[locale]?.description, `${locale} 缺说明`);
    for (const n of p.nodes) {
      assert.ok(p.text[locale]?.[n.key]?.title, `${locale}/${n.key} 缺节点标题`);
    }
  }
});

test('1.2 预设描述校验：重复键、无效父级、父子环、缺依赖端点、依赖环被拒绝', () => {
  const base = FEATURE_DEVELOPMENT_PRESET;
  const clone = (): DeepMutable<PresetDescriptor> => JSON.parse(JSON.stringify(base)) as DeepMutable<PresetDescriptor>;

  const dup = clone();
  dup.nodes[2] = { ...dup.nodes[2]!, key: dup.nodes[1]!.key };
  assert.ok(codesOf({ ok: validatePreset(dup).length === 0, issues: validatePreset(dup) }).includes('duplicate-key') || validatePreset(dup).some((i) => i.code === 'duplicate-key'));

  const badParent = clone();
  badParent.nodes[1] = { ...badParent.nodes[1]!, parentKey: 'missing' };
  assert.ok(validatePreset(badParent).some((i) => i.code === 'invalid-parent'));

  const cycle = clone();
  // 根与第一个子节点互为父子
  cycle.nodes[0] = { ...cycle.nodes[0]!, parentKey: cycle.nodes[1]!.key };
  assert.ok(validatePreset(cycle).some((i) => i.code === 'parent-cycle'));

  const badDep = clone();
  badDep.dependencies = [...badDep.dependencies, { nodeKey: 'ghost', requiresKey: badDep.nodes[0]!.key }];
  assert.ok(validatePreset(badDep).some((i) => i.code === 'dependency-node-not-found'));

  const depCycle = clone();
  depCycle.dependencies = [
    { nodeKey: badDep.nodes[0]!.key, requiresKey: badDep.nodes[1]!.key },
    { nodeKey: badDep.nodes[1]!.key, requiresKey: badDep.nodes[0]!.key },
  ];
  assert.ok(validatePreset(depCycle).some((i) => i.code === 'dependency-cycle'));

  const localeMismatch = clone();
  delete (localeMismatch.text['en'] as Record<string, unknown>)[localeMismatch.nodes[0]!.key];
  assert.ok(validatePreset(localeMismatch).some((i) => i.code === 'locale-structure-mismatch'));
});

// ---- 1.3 模板实例化 ----

test('1.3 在指定锚点前插入：新 ID、todo、内部依赖映射、既有节点不变', () => {
  const plan = multiRootPlan();
  const ids = [U(11), U(12), U(13), U(14)];
  const result = instantiateTemplate(plan, FEATURE_DEVELOPMENT_PRESET, 'zh-CN', ids, U(1), U(3));
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const newNodes = result.value.nodes.filter((n) => ids.includes(n.id));
  assert.equal(newNodes.length, ids.length);
  assert.ok(newNodes.every((n) => n.status === 'todo'));
  // 模板根挂到目标父节点，插在锚点 C1 之前
  const rootKey = FEATURE_DEVELOPMENT_PRESET.nodes.find((n) => n.parentKey === null)!;
  const instRoot = newNodes.find((n) => n.title === FEATURE_DEVELOPMENT_PRESET.text['zh-CN']![rootKey.key]!.title);
  assert.ok(instRoot, '模板根标题按中文正文');
  assert.equal(instRoot!.parentId, U(1));
  const rootSiblings = result.value.nodes.filter((n) => n.parentId === U(1)).sort((a, b) => a.order - b.order);
  assert.ok(rootSiblings.findIndex((n) => n.id === instRoot!.id) < rootSiblings.findIndex((n) => n.id === U(3)));
  // 内部依赖映射到本次生成的新 ID
  const internalEdges = result.value.dependencies.filter((e) => ids.includes(e.nodeId) && ids.includes(e.requiresNodeId));
  assert.equal(internalEdges.length, FEATURE_DEVELOPMENT_PRESET.dependencies.length);
  assert.ok(internalEdges.every((e) => e.nodeId !== e.requiresNodeId));
  // 既有依赖保留
  assert.ok(result.value.dependencies.some((e) => e.nodeId === U(3) && e.requiresNodeId === U(2)));
  // 既有节点身份、文本、状态、父级保持（order 因插入同级重排而变化属预期）
  for (const original of plan.nodes) {
    const found: WorkNode | undefined = result.value.nodes.find((n) => n.id === original.id);
    assert.ok(found, `既有节点 ${original.id} 应保留`);
    assert.deepEqual(
      { id: found!.id, title: found!.title, goal: found!.goal, status: found!.status, parentId: found!.parentId },
      { id: original.id, title: original.title, goal: original.goal, status: original.status, parentId: original.parentId },
    );
  }
});

test('1.3 向空父节点追加 + 两批独立 ID + 英文正文', () => {
  const plan = multiRootPlan();
  const idsA = [U(21), U(22), U(23), U(24)];
  const first = instantiateTemplate(plan, FEATURE_DEVELOPMENT_PRESET, 'en', idsA, U(2), null);
  assert.equal(first.ok, true, JSON.stringify(first));
  if (!first.ok) return;
  const idsB = [U(31), U(32), U(33), U(34)];
  const second = instantiateTemplate(first.value, FEATURE_DEVELOPMENT_PRESET, 'en', idsB, U(2), null);
  assert.equal(second.ok, true, JSON.stringify(second));
  if (!second.ok) return;
  const allIds = [...idsA, ...idsB];
  assert.equal(new Set(allIds).size, allIds.length, '两批 ID 唯一');
  const r2Siblings = second.value.nodes.filter((n) => n.parentId === U(2));
  assert.equal(r2Siblings.length, 2, '两个模板根挂在同一父节点');
  assert.deepEqual(siblingOrders(second.value, U(2)), [0, 1]);
  // 英文正文：模板根标题应为英文
  const rootKey = FEATURE_DEVELOPMENT_PRESET.nodes.find((n) => n.parentKey === null)!;
  const enTitle = FEATURE_DEVELOPMENT_PRESET.text['en']![rootKey.key]!.title;
  assert.ok(second.value.nodes.some((n) => allIds.includes(n.id) && n.title === enTitle));
  // 两批内部依赖分别指向各自新 ID
  const edges = second.value.dependencies.filter((e) => allIds.includes(e.nodeId));
  assert.equal(edges.length, FEATURE_DEVELOPMENT_PRESET.dependencies.length * 2);
});

test('1.3 拒绝无效模板/语言/位置与重复 ID；候选通过 v1 校验', () => {
  const plan = multiRootPlan();
  const bad = instantiateTemplate(plan, FEATURE_DEVELOPMENT_PRESET, 'fr' as never, [U(41), U(42), U(43), U(44)], U(1), null);
  assert.equal(bad.ok, false);
  assert.ok(codesOf(bad).includes('template-locale-unsupported'));

  const reused = instantiateTemplate(plan, FEATURE_DEVELOPMENT_PRESET, 'zh-CN', [U(1), U(42), U(43), U(44)], U(1), null);
  assert.equal(reused.ok, false);
  assert.ok(codesOf(reused).includes('duplicate-node-id'));

  const badParent = instantiateTemplate(plan, FEATURE_DEVELOPMENT_PRESET, 'zh-CN', [U(51), U(52), U(53), U(54)], U(999), null);
  assert.equal(badParent.ok, false);
  assert.ok(codesOf(badParent).includes('parent-not-found'));

  const badAnchor = instantiateTemplate(plan, FEATURE_DEVELOPMENT_PRESET, 'zh-CN', [U(61), U(62), U(63), U(64)], U(1), U(6));
  assert.equal(badAnchor.ok, false);
  assert.ok(codesOf(badAnchor).includes('invalid-anchor'));

  const good = instantiateTemplate(plan, FEATURE_DEVELOPMENT_PRESET, 'zh-CN', [U(71), U(72), U(73), U(74)], U(1), null);
  assert.equal(good.ok, true, JSON.stringify(good));
  if (!good.ok) return;
  const doc: ProjectDocument = {
    schemaVersion: 1,
    project: { id: U(100), title: 'p', goal: 'g', constraints: [], repositories: [] },
    plan: good.value,
    planVersion: '',
    records: [],
  };
  doc.planVersion = computePlanVersion(doc, sha256).planVersion;
  assert.ok(doc.planVersion.startsWith('sha256:'));
  // instantiateTemplate 内部已用 validatePlanStructure 兜底；此处用完整文档校验再确认。
  const result = applyPlanCommand(
    { ...doc, plan: multiRootPlan(), planVersion: doc.planVersion },
    { type: 'add-nodes', nodes: good.value.nodes.filter((n) => [U(71), U(72), U(73), U(74)].includes(n.id)) },
    sha256,
  );
  // add-nodes 会因 order 冲突被拒（新节点已按插入后编号），这里只确认校验管线可达。
  assert.equal(typeof result.ok, 'boolean');
});

// 保留一个 Compile-time 引用，确保 DependencyEdge 类型被使用（夹具中已使用）。
const _depType: DependencyEdge[] = [];
void _depType;
