// 领域规则测试（tasks 1.2 / 1.4）：
// 重复 id、缺失父节点、树环、依赖环、批量拆分整体拒绝；
// 孤立正文不发布、子节点完成不推导父完成、外部验证不冒充本机复测、失效引用。

import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addNodes,
  classifyVerificationSource,
  findOrphanBodies,
  referencedBodyPaths,
  setDependencies,
  splitNode,
  validatePlanStructure,
  validateProjectDocument,
} from '../src/domain/index.js';
import type { DependencyEdge, ProjectDocument, RecordIndexEntry, Sha256Fn, WorkNode } from '../src/domain/types.js';

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

function baseDoc(): ProjectDocument {
  return {
    schemaVersion: 1,
    project: {
      id: U(1),
      title: '示例项目',
      goal: '目标',
      constraints: [],
      repositories: [{ id: U(5), label: '代码' }],
    },
    plan: {
      nodes: [
        node({ id: U(2) }),
        node({ id: U(3), parentId: U(2), order: 0 }),
      ],
      dependencies: [{ nodeId: U(3), requiresNodeId: U(2) }],
    },
    planVersion: 'sha256:' + '0'.repeat(64),
    records: [],
  };
}

function codesOf(result: { ok: boolean; issues?: { code: string }[] }): string[] {
  return result.ok ? [] : (result.issues ?? []).map((issue) => issue.code);
}

test('1.2 重复节点 id 拒绝', () => {
  const doc = baseDoc();
  doc.plan.nodes.push(node({ id: U(2), order: 1 }));
  const result = validateProjectDocument(doc);
  assert.ok(!result.ok);
  assert.ok(codesOf(result).includes('duplicate-node-id'));
});

test('1.2 缺失父节点（parentId 指向不存在节点）拒绝', () => {
  const doc = baseDoc();
  doc.plan.nodes.push(node({ id: U(9), parentId: U(8) }));
  const result = validateProjectDocument(doc);
  assert.ok(!result.ok);
  assert.ok(codesOf(result).includes('parent-not-found'));
});

test('1.2 树环拒绝（互为父子）', () => {
  const structure = {
    nodes: [
      node({ id: U(2) }),
      node({ id: U(3), parentId: U(4), order: 0 }),
      node({ id: U(4), parentId: U(3), order: 0 }),
    ],
    dependencies: [] as DependencyEdge[],
  };
  const issues = validatePlanStructure(structure);
  assert.ok(issues.some((issue) => issue.code === 'parent-cycle'));
});

test('1.2 依赖环拒绝', () => {
  const structure = {
    nodes: [
      node({ id: U(2) }),
      node({ id: U(3), parentId: U(2), order: 0 }),
      node({ id: U(4), parentId: U(2), order: 1 }),
    ],
    dependencies: [
      { nodeId: U(3), requiresNodeId: U(4) },
      { nodeId: U(4), requiresNodeId: U(3) },
    ],
  };
  const issues = validatePlanStructure(structure);
  assert.ok(issues.some((issue) => issue.code === 'dependency-cycle'));
});

test('1.2 重复有向依赖拒绝', () => {
  const structure = {
    nodes: [
      node({ id: U(2) }),
      node({ id: U(3), parentId: U(2), order: 0 }),
    ],
    dependencies: [
      { nodeId: U(3), requiresNodeId: U(2) },
      { nodeId: U(3), requiresNodeId: U(2) },
    ],
  };
  const issues = validatePlanStructure(structure);
  assert.ok(issues.some((issue) => issue.code === 'duplicate-dependency'));
});

test('1.2 同级 order 不连续拒绝', () => {
  const structure = {
    nodes: [
      node({ id: U(2) }),
      node({ id: U(3), parentId: U(2), order: 0 }),
      node({ id: U(4), parentId: U(2), order: 2 }),
    ],
    dependencies: [],
  };
  const issues = validatePlanStructure(structure);
  assert.ok(issues.some((issue) => issue.code === 'sibling-order-gap'));
});

test('1.2 未知顶层字段拒绝', () => {
  const doc = baseDoc() as unknown as { [key: string]: unknown };
  doc['futureField'] = {};
  const result = validateProjectDocument(doc);
  assert.ok(!result.ok);
  assert.ok(codesOf(result).includes('unknown-field'));
});

test('1.2 未知节点字段拒绝', () => {
  const doc = baseDoc();
  (doc.plan.nodes[0] as unknown as { [key: string]: unknown })['extra'] = 1;
  const result = validateProjectDocument(doc);
  assert.ok(!result.ok);
  assert.ok(codesOf(result).includes('unknown-field'));
});

test('1.2 批量新增：一项非法整批拒绝，原计划不被修改', () => {
  const plan = baseDoc().plan;
  const before = JSON.stringify(plan);
  const batch = [
    node({ id: U(6), parentId: U(2), order: 1 }),
    node({ id: U(2), parentId: U(2), order: 2 }), // 与现有 id 冲突
  ];
  const result = addNodes(plan, batch);
  assert.ok(!result.ok);
  assert.equal(JSON.stringify(plan), before, '调用者输入不得被修改');
  assert.ok(codesOf(result).includes('duplicate-node-id'));
});

test('1.2 批量拆分：一项非法整批拒绝', () => {
  const plan = baseDoc().plan;
  const batch = [
    node({ id: U(7), parentId: U(2), order: 1 }),
    node({ id: U(8), parentId: U(99), order: 2 }), // split 统一改父，但 order 造成同级不连续
  ];
  const result = splitNode(plan, U(2), batch);
  assert.ok(!result.ok);
  assert.ok(codesOf(result).includes('sibling-order-gap') || codesOf(result).includes('split-parent-mismatch'));
});

test('1.2 setDependencies：环整体拒绝', () => {
  const plan = baseDoc().plan;
  const result = setDependencies(plan, [
    { nodeId: U(3), requiresNodeId: U(2) },
    { nodeId: U(2), requiresNodeId: U(3) },
  ]);
  assert.ok(!result.ok);
  assert.ok(codesOf(result).includes('dependency-cycle'));
});

test('1.4 done 节点无完成条件拒绝', () => {
  const doc = baseDoc();
  doc.plan.nodes[0] = { ...doc.plan.nodes[0]!, status: 'done' };
  const result = validateProjectDocument(doc);
  assert.ok(!result.ok);
  assert.ok(codesOf(result).includes('completion-no-criteria'));
});

test('1.4 done 节点无 pass 验证记录拒绝', () => {
  const doc = baseDoc();
  doc.plan.nodes[0] = { ...doc.plan.nodes[0]!, status: 'done', completionCriteria: ['记录结果'] };
  const result = validateProjectDocument(doc);
  assert.ok(!result.ok);
  assert.ok(codesOf(result).includes('completion-no-verification'));
});

test('1.4 done 节点有 pass 验证记录通过；子节点完成不推导父完成', () => {
  const doc = baseDoc();
  doc.plan.nodes[0] = { ...doc.plan.nodes[0]!, status: 'done', completionCriteria: ['记录结果'] };
  doc.plan.nodes[1] = { ...doc.plan.nodes[1]!, status: 'done', completionCriteria: ['记录结果'] };
  doc.records.push({
    id: U(10),
    kind: 'verification',
    subjectNodeIds: [U(3)],
    path: `records/${U(10)}/${'a'.repeat(64)}.md`,
    contentHash: 'sha256:' + 'a'.repeat(64),
    summary: '子节点验证通过',
    sources: [],
    verification: { status: 'pass', subject: { kind: 'node', id: U(3) } },
  });
  // 父节点 done 无验证记录 → 拒绝（不从子节点推导）。
  const result = validateProjectDocument(doc);
  assert.ok(!result.ok);
  assert.ok(codesOf(result).includes('completion-no-verification'));
  // 父节点补上自己的验证记录 → 通过。
  doc.records.push({
    id: U(11),
    kind: 'verification',
    subjectNodeIds: [U(2)],
    path: `records/${U(11)}/${'b'.repeat(64)}.md`,
    contentHash: 'sha256:' + 'b'.repeat(64),
    summary: '父节点验证通过',
    sources: [],
    verification: { status: 'pass', subject: { kind: 'node', id: U(2) } },
  });
  assert.ok(validateProjectDocument(doc).ok);
});

test('1.4 失效引用：subjectNodeIds 指向不存在节点拒绝', () => {
  const doc = baseDoc();
  doc.records.push({
    id: U(12),
    kind: 'analysis-note',
    subjectNodeIds: [U(77)],
    path: `records/${U(12)}/${'c'.repeat(64)}.md`,
    contentHash: 'sha256:' + 'c'.repeat(64),
    summary: '坏引用',
    sources: [],
  });
  const result = validateProjectDocument(doc);
  assert.ok(!result.ok);
  assert.ok(codesOf(result).includes('subject-node-not-found'));
});

test('1.4 记录 path 与 contentHash 不一致拒绝', () => {
  const doc = baseDoc();
  doc.records.push({
    id: U(13),
    kind: 'analysis-note',
    subjectNodeIds: [],
    path: `records/${U(13)}/${'d'.repeat(64)}.md`,
    contentHash: 'sha256:' + 'e'.repeat(64),
    summary: '哈希与路径不符',
    sources: [],
  });
  const result = validateProjectDocument(doc);
  assert.ok(!result.ok);
  assert.ok(codesOf(result).includes('content-hash-path-mismatch'));
});

test('1.4 sources 引用不存在记录拒绝；自身引用拒绝', () => {
  const doc = baseDoc();
  doc.records.push({
    id: U(14),
    kind: 'analysis-note',
    subjectNodeIds: [],
    path: `records/${U(14)}/${'f'.repeat(64)}.md`,
    contentHash: 'sha256:' + 'f'.repeat(64),
    summary: '来源失效',
    sources: [U(99)],
  });
  assert.ok(codesOf(validateProjectDocument(doc)).includes('source-record-not-found'));

  const doc2 = baseDoc();
  doc2.records.push({
    id: U(15),
    kind: 'analysis-note',
    subjectNodeIds: [],
    path: `records/${U(15)}/${'1'.repeat(64)}.md`,
    contentHash: 'sha256:' + '1'.repeat(64),
    summary: '自身引用',
    sources: [U(15)],
  });
  assert.ok(codesOf(validateProjectDocument(doc2)).includes('self-source'));
});

test('1.4 sources 仓库引用未声明拒绝', () => {
  const doc = baseDoc();
  doc.records.push({
    id: U(16),
    kind: 'analysis-note',
    subjectNodeIds: [],
    path: `records/${U(16)}/${'2'.repeat(64)}.md`,
    contentHash: 'sha256:' + '2'.repeat(64),
    summary: '未知仓库',
    sources: [{ repositoryId: U(88), relativePath: 'docs/x.md' }],
  });
  assert.ok(codesOf(validateProjectDocument(doc)).includes('source-repository-not-found'));
});

test('1.4 verification 仅允许 kind=verification 携带', () => {
  const doc = baseDoc();
  doc.records.push({
    id: U(17),
    kind: 'analysis-note',
    subjectNodeIds: [U(2)],
    path: `records/${U(17)}/${'3'.repeat(64)}.md`,
    contentHash: 'sha256:' + '3'.repeat(64),
    summary: '错误携带',
    sources: [],
    verification: { status: 'pass', subject: { kind: 'node', id: U(2) } },
  });
  assert.ok(codesOf(validateProjectDocument(doc)).includes('invalid-verification'));
});

test('1.4 孤立正文不发布：未被索引引用的正文被识别', () => {
  const doc = baseDoc();
  const record: RecordIndexEntry = {
    id: U(18),
    kind: 'analysis-note',
    subjectNodeIds: [],
    path: `records/${U(18)}/${'4'.repeat(64)}.md`,
    contentHash: 'sha256:' + '4'.repeat(64),
    summary: '已索引正文',
    sources: [],
  };
  doc.records.push(record);
  assert.deepEqual(referencedBodyPaths(doc.records), new Set([record.path]));
  const orphans = findOrphanBodies(
    [record.path, `records/${U(19)}/${'5'.repeat(64)}.md`],
    doc.records,
  );
  assert.deepEqual(orphans, [`records/${U(19)}/${'5'.repeat(64)}.md`]);
});

test('1.4 外部验证不冒充本机复测：分类明确标注外部来源', () => {
  const external: RecordIndexEntry = {
    id: U(20),
    kind: 'verification',
    subjectNodeIds: [U(2)],
    path: `records/${U(20)}/${'6'.repeat(64)}.md`,
    contentHash: 'sha256:' + '6'.repeat(64),
    summary: '外部仓库观察',
    sources: [{ repositoryId: U(5), relativePath: 'README.md' }],
    verification: { status: 'pass', subject: { kind: 'node', id: U(2) } },
  };
  assert.equal(classifyVerificationSource(external), 'external-observation');
  const chained: RecordIndexEntry = { ...external, sources: [U(21)] };
  assert.equal(classifyVerificationSource(chained), 'public-chain');
  const unsourced: RecordIndexEntry = { ...external, sources: [] };
  assert.equal(classifyVerificationSource(unsourced), 'unsourced');
});

test('planVersion 自报值与重算指纹比对（传入 sha256）', () => {
  const doc = baseDoc();
  const result = validateProjectDocument(doc, { sha256 });
  assert.ok(!result.ok);
  assert.ok(codesOf(result).includes('plan-version-mismatch'));
});
