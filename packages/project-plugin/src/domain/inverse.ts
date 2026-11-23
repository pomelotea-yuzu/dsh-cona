// 规划编辑的可核查逆向信息（tasks 2.3，design §2「撤销与重做」）。
// 本模块只处理领域内的 Plan 差异：从「操作前」「操作后」两个快照生成字段级变更集，
// 并在当前 Plan 上按 undo／redo 方向核对状态、应用逆向或正向变换。
// 不依赖 Node／React／Cordis；公开记录、聊天、WorkRun 与源代际等引用核对由应用层承担。
//
// 关键约定：
// - inverse 描述的是「如何把操作后的状态恢复到操作前」，即 after→before 方向。
// - `undo-plan-edit` 应用 after→before；`redo-plan-edit` 应用 before→after，两者都以原操作为 target。
// - 字段级变更让无关编辑保留：只回滚原操作触及的字段，其余字段保持当前值。
// - 节点身份在生成批次中固定：undo 删除生成节点，redo 复用同一批 ID 与快照。

import type { DependencyEdge, Milestone, Plan, TransformResult, WorkNode } from './types.js';
import { UUID_RE } from './validate-constants.js';
import { validatePlanStructure } from './validate.js';

export const PLAN_INVERSE_VERSION = 1 as const;

/** 原操作可回滚的字段。身份字段 id 不回滚；parentId/order 在结构变换中按快照恢复。 */
export const INVERSE_FIELDS = ['title', 'goal', 'completionCriteria', 'status', 'parentId', 'order'] as const;
export type InverseField = (typeof INVERSE_FIELDS)[number];
export type InverseFieldValue = string | number | string[] | null;

export interface InverseFieldChange {
  nodeId: string;
  field: InverseField;
  before: InverseFieldValue;
  after: InverseFieldValue;
}

export interface InverseDependencyChange {
  edge: DependencyEdge;
  /** added：原操作新增；removed：原操作删除。 */
  direction: 'added' | 'removed';
}

/** 里程碑条目的前后值（tasks 4.5）：null 表示该节点当时没有里程碑。 */
export interface InverseRoadmapChange {
  nodeId: string;
  before: Milestone | null;
  after: Milestone | null;
}

/** merge 发布的结构化替代记录，撤销追加 clear、重做产生新 replace。 */
export interface InverseReplacement {
  recordId: string;
  sourceNodeIds: string[];
  replacementNodeId: string;
}

/** 一条规划操作的可核查逆向信息；随原回执一起留在本机，不进入公开资料。 */
export interface PlanInverse {
  version: 1;
  /** 原操作 id（与所属 OperationRecord.operationId 一致）。 */
  operationId: string;
  /** 原命令类型（update-node／move-node／merge-nodes／insert-preset 等）。 */
  commandType: string;
  /** 原操作提交时的源代际；换源后撤销/重做须重新核对。 */
  sourceEpoch: number;
  /** 操作前／后的公开规划指纹，用于方向核对与历史查询。 */
  beforePlanVersion: string;
  afterPlanVersion: string;
  /** 字段级前后值；撤销把这些字段恢复到 before，重做恢复到 after。 */
  fieldChanges: InverseFieldChange[];
  /** 原操作生成的节点；撤销删除、重做复用同一批身份与快照。 */
  generatedNodes: WorkNode[];
  /** 原操作移除的节点（当前规划命令通常不产生，保留契约完整性）。 */
  removedNodes: WorkNode[];
  /** 依赖边的前后差集。 */
  dependencyChanges: InverseDependencyChange[];
  /** 受影响节点范围（字段、生成/移除、依赖两端及其父节点）。 */
  affectedNodeIds: string[];
  /** merge 发布的结构化替代记录。 */
  replacement?: InverseReplacement;
  /** 里程碑条目变化（仅在 set-milestone／remove-milestone 出现）。 */
  roadmapChanges?: InverseRoadmapChange[];
}

export type InverseDirection = 'undo' | 'redo';

export interface InverseConflict {
  kind: 'field' | 'generated-node' | 'removed-node' | 'dependency' | 'invalid-inverse';
  code: string;
  message: string;
  nodeId?: string;
  field?: InverseField;
  expected?: unknown;
  actual?: unknown;
}

function fail(...issues: { code: string; path: string; message?: string }[]): TransformResult<never> {
  return { ok: false, issues };
}

function fieldValue(node: WorkNode, field: InverseField): InverseFieldValue {
  const value = (node as unknown as Record<string, unknown>)[field];
  if (field === 'completionCriteria') return [...(value as string[])];
  if (field === 'order') return value as number;
  return value as string | null;
}

function fieldEqual(a: InverseFieldValue, b: unknown): boolean {
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, index) => item === b[index]);
  }
  return a === b;
}

function edgeKey(edge: DependencyEdge): string {
  return `${edge.nodeId}\u0000${edge.requiresNodeId}`;
}

function validMilestoneSide(value: Milestone | null): boolean {
  if (value === null) return true;
  if (typeof value !== 'object' || !Array.isArray(value.deliveries)) return false;
  if (!UUID_RE.test(value.nodeId)) return false;
  return value.deliveries.every((delivery) =>
    delivery !== null && typeof delivery === 'object' && UUID_RE.test(delivery.refId)
    && (delivery.kind === 'node' || delivery.kind === 'record'));
}

function sameMilestone(a: Milestone | null, b: Milestone | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.nodeId !== b.nodeId || a.deliveries.length !== b.deliveries.length) return false;
  return a.deliveries.every((delivery, index) => {
    const other = b.deliveries[index];
    if (other === undefined || other.kind !== delivery.kind || other.refId !== delivery.refId) return false;
    if (delivery.kind === 'record' && other.kind === 'record') return delivery.contentHash === other.contentHash;
    return true;
  });
}

function validInverseFieldChange(change: InverseFieldChange): boolean {
  return typeof change.nodeId === 'string' && UUID_RE.test(change.nodeId)
    && (INVERSE_FIELDS as readonly string[]).includes(change.field);
}

/** 校验反序列化后的逆向信息形状；旧回执缺字段时视为无逆向信息。 */
export function validatePlanInverse(value: unknown): PlanInverse | null {
  if (value === null || typeof value !== 'object') return null;
  const raw = value as Partial<PlanInverse>;
  if (raw.version !== PLAN_INVERSE_VERSION) return null;
  if (typeof raw.operationId !== 'string' || !UUID_RE.test(raw.operationId)) return null;
  if (typeof raw.commandType !== 'string' || typeof raw.sourceEpoch !== 'number') return null;
  if (typeof raw.beforePlanVersion !== 'string' || typeof raw.afterPlanVersion !== 'string') return null;
  if (!Array.isArray(raw.fieldChanges) || !Array.isArray(raw.generatedNodes)
    || !Array.isArray(raw.removedNodes) || !Array.isArray(raw.dependencyChanges)
    || !Array.isArray(raw.affectedNodeIds)) return null;
  if (!raw.fieldChanges.every((item) => validInverseFieldChange(item))) return null;
  if (raw.roadmapChanges !== undefined) {
    if (!Array.isArray(raw.roadmapChanges)) return null;
    if (!raw.roadmapChanges.every((item) =>
      item !== null && typeof item === 'object'
      && typeof (item as InverseRoadmapChange).nodeId === 'string'
      && UUID_RE.test((item as InverseRoadmapChange).nodeId)
      && validMilestoneSide((item as InverseRoadmapChange).before)
      && validMilestoneSide((item as InverseRoadmapChange).after))) return null;
  }
  return raw as PlanInverse;
}

/** 从操作前后快照生成字段级逆向前值/后值、生成/移除节点、依赖差集与受影响范围。 */
export function buildPlanInverse(params: {
  operationId: string;
  commandType: string;
  sourceEpoch: number;
  before: Plan;
  after: Plan;
  beforePlanVersion: string;
  afterPlanVersion: string;
  replacement?: InverseReplacement;
}): PlanInverse {
  const beforeNodes = new Map(params.before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(params.after.nodes.map((node) => [node.id, node]));
  const fieldChanges: InverseFieldChange[] = [];
  const generatedNodes: WorkNode[] = [];
  const removedNodes: WorkNode[] = [];
  const affected = new Set<string>();

  for (const node of params.after.nodes) {
    const beforeNode = beforeNodes.get(node.id);
    if (beforeNode === undefined) {
      generatedNodes.push({ ...node, completionCriteria: [...node.completionCriteria] });
      affected.add(node.id);
      if (node.parentId !== null) affected.add(node.parentId);
      continue;
    }
    for (const field of INVERSE_FIELDS) {
      const beforeValue = fieldValue(beforeNode, field);
      const afterValue = fieldValue(node, field);
      if (!fieldEqual(beforeValue, afterValue)) {
        fieldChanges.push({ nodeId: node.id, field, before: beforeValue, after: afterValue });
        affected.add(node.id);
        if (field === 'parentId' && typeof afterValue === 'string') affected.add(afterValue);
        if (field === 'parentId' && typeof beforeValue === 'string') affected.add(beforeValue);
      }
    }
  }
  for (const node of params.before.nodes) {
    if (afterNodes.has(node.id)) continue;
    removedNodes.push({ ...node, completionCriteria: [...node.completionCriteria] });
    affected.add(node.id);
    if (node.parentId !== null) affected.add(node.parentId);
  }

  // 里程碑条目：只记录被编辑节点条目的前后值（未触及的条目保持现状）。
  const beforeMilestones = new Map((params.before.roadmap?.milestones ?? []).map((item) => [item.nodeId, item] as const));
  const afterMilestones = new Map((params.after.roadmap?.milestones ?? []).map((item) => [item.nodeId, item] as const));
  const roadmapChanges: InverseRoadmapChange[] = [];
  for (const nodeId of new Set([...beforeMilestones.keys(), ...afterMilestones.keys()])) {
    const before = beforeMilestones.get(nodeId) ?? null;
    const after = afterMilestones.get(nodeId) ?? null;
    if (sameMilestone(before, after)) continue;
    roadmapChanges.push({ nodeId, before: cloneMilestone(before), after: cloneMilestone(after) });
    affected.add(nodeId);
  }

  const beforeEdges = new Map(params.before.dependencies.map((edge) => [edgeKey(edge), edge]));
  const afterEdges = new Map(params.after.dependencies.map((edge) => [edgeKey(edge), edge]));
  const dependencyChanges: InverseDependencyChange[] = [];
  for (const [key, edge] of afterEdges) {
    if (beforeEdges.has(key)) continue;
    dependencyChanges.push({ edge: { ...edge }, direction: 'added' });
    affected.add(edge.nodeId);
    affected.add(edge.requiresNodeId);
  }
  for (const [key, edge] of beforeEdges) {
    if (afterEdges.has(key)) continue;
    dependencyChanges.push({ edge: { ...edge }, direction: 'removed' });
    affected.add(edge.nodeId);
    affected.add(edge.requiresNodeId);
  }

  return {
    version: PLAN_INVERSE_VERSION,
    operationId: params.operationId,
    commandType: params.commandType,
    sourceEpoch: params.sourceEpoch,
    beforePlanVersion: params.beforePlanVersion,
    afterPlanVersion: params.afterPlanVersion,
    fieldChanges,
    generatedNodes,
    removedNodes,
    dependencyChanges,
    affectedNodeIds: [...affected].sort(),
    ...(params.replacement === undefined ? {} : { replacement: params.replacement }),
    ...(roadmapChanges.length === 0 ? {} : { roadmapChanges }),
  };
}

function cloneMilestone(value: Milestone | null): Milestone | null {
  if (value === null) return null;
  return {
    nodeId: value.nodeId,
    deliveries: value.deliveries.map((delivery) =>
      delivery.kind === 'record'
        ? { kind: delivery.kind, refId: delivery.refId, contentHash: delivery.contentHash }
        : { kind: delivery.kind, refId: delivery.refId }),
  };
}

/** 当前状态是否处于所选方向的输入侧：undo 要求仍为操作后，redo 要求已回到操作前。 */
export function checkInverseState(
  current: Plan,
  inverse: PlanInverse,
  direction: InverseDirection,
): { ok: true } | { ok: false; conflicts: InverseConflict[] } {
  const conflicts: InverseConflict[] = [];
  const nodes = new Map(current.nodes.map((node) => [node.id, node]));
  const expectedSide = direction === 'undo' ? 'after' : 'before';

  for (const change of inverse.fieldChanges) {
    const node = nodes.get(change.nodeId);
    const expected = change[expectedSide];
    if (node === undefined) {
      conflicts.push({
        kind: 'field', code: 'inverse-node-missing', message: `受影响节点 ${change.nodeId} 已不存在`,
        nodeId: change.nodeId, field: change.field, expected,
      });
      continue;
    }
    const actual = fieldValue(node, change.field);
    if (!fieldEqual(expected, actual)) {
      conflicts.push({
        kind: 'field', code: 'inverse-field-changed',
        message: `节点 ${change.nodeId} 的 ${change.field} 已被后续编辑改动`,
        nodeId: change.nodeId, field: change.field, expected, actual,
      });
    }
  }

  for (const node of inverse.generatedNodes) {
    const exists = nodes.has(node.id);
    if (direction === 'undo' && !exists) {
      conflicts.push({ kind: 'generated-node', code: 'inverse-node-missing', message: `原生成节点 ${node.id} 已不存在`, nodeId: node.id });
    }
    if (direction === 'redo' && exists) {
      conflicts.push({ kind: 'generated-node', code: 'inverse-id-taken', message: `原生成身份 ${node.id} 已被占用`, nodeId: node.id });
    }
  }
  for (const node of inverse.removedNodes) {
    const exists = nodes.has(node.id);
    if (direction === 'undo' && exists) {
      conflicts.push({ kind: 'removed-node', code: 'inverse-id-taken', message: `待恢复身份 ${node.id} 已被占用`, nodeId: node.id });
    }
    if (direction === 'redo' && !exists) {
      conflicts.push({ kind: 'removed-node', code: 'inverse-node-missing', message: `原移除节点 ${node.id} 已不存在`, nodeId: node.id });
    }
  }

  const currentMilestones = new Map((current.roadmap?.milestones ?? []).map((item) => [item.nodeId, item] as const));
  for (const change of inverse.roadmapChanges ?? []) {
    const expected = change[expectedSide];
    const actual = currentMilestones.get(change.nodeId) ?? null;
    if (!sameMilestone(expected, actual)) {
      conflicts.push({
        kind: 'invalid-inverse', code: 'inverse-roadmap-changed',
        message: `里程碑 ${change.nodeId} 的交付已被后续编辑改动`,
        nodeId: change.nodeId,
      });
    }
  }

  const currentEdges = new Set(current.dependencies.map(edgeKey));
  for (const change of inverse.dependencyChanges) {
    const present = currentEdges.has(edgeKey(change.edge));
    const expected = (change.direction === 'added') === (direction === 'undo');
    if (present !== expected) {
      conflicts.push({
        kind: 'dependency', code: 'inverse-dependency-changed',
        message: `依赖 ${change.edge.nodeId}→${change.edge.requiresNodeId} 已被后续编辑改动`,
      });
    }
  }

  return conflicts.length === 0 ? { ok: true } : { ok: false, conflicts };
}

/** 在核对通过后应用逆向（after→before）或重做（before→after），输入 Plan 不被修改。 */
export function applyPlanInverse(current: Plan, inverse: PlanInverse, direction: InverseDirection): TransformResult<Plan> {
  const checked = checkInverseState(current, inverse, direction);
  if (!checked.ok) return fail(...checked.conflicts.map((item) => ({ code: item.code, path: '/plan', message: item.message })));

  const restoring = direction === 'undo';
  const nodes = current.nodes.map((node) => ({ ...node, completionCriteria: [...node.completionCriteria] }));
  const byId = new Map(nodes.map((node) => [node.id, node]));

  for (const change of inverse.fieldChanges) {
    const node = byId.get(change.nodeId);
    if (node === undefined) continue;
    const value = change[restoring ? 'before' : 'after'];
    const assigned: InverseFieldValue = Array.isArray(value) ? [...value] : value;
    (node as unknown as Record<string, unknown>)[change.field] = assigned;
  }

  if (restoring) {
    for (const node of inverse.generatedNodes) {
      const index = nodes.findIndex((item) => item.id === node.id);
      if (index >= 0) nodes.splice(index, 1);
    }
    for (const node of inverse.removedNodes) {
      nodes.push({ ...node, completionCriteria: [...node.completionCriteria] });
    }
  } else {
    for (const node of inverse.generatedNodes) {
      nodes.push({ ...node, completionCriteria: [...node.completionCriteria] });
    }
    for (const node of inverse.removedNodes) {
      const index = nodes.findIndex((item) => item.id === node.id);
      if (index >= 0) nodes.splice(index, 1);
    }
  }
  byId.clear();
  for (const node of nodes) byId.set(node.id, node);

  const edges = current.dependencies.map((edge) => ({ ...edge }));
  const edgeSet = new Set(edges.map(edgeKey));
  // undo：移除原操作 added 边、恢复 removed 边；redo 相反。
  const desiredPresent = (change: InverseDependencyChange): boolean =>
    (change.direction === 'added') !== restoring;
  for (const change of inverse.dependencyChanges) {
    const key = edgeKey(change.edge);
    const present = edgeSet.has(key);
    if (desiredPresent(change) && !present) {
      edges.push({ ...change.edge });
      edgeSet.add(key);
    } else if (!desiredPresent(change) && present) {
      const index = edges.findIndex((edge) => edgeKey(edge) === key);
      if (index >= 0) edges.splice(index, 1);
      edgeSet.delete(key);
    }
  }

  // 同级 order 从 0 连续：按当前父级分组、稳定排序后重编号（节点身份与相对顺序不变）。
  const groups = new Map<string | null, WorkNode[]>();
  for (const node of nodes) {
    const key = node.parentId;
    const list = groups.get(key) ?? [];
    list.push(node);
    groups.set(key, list);
  }
  const ordered: WorkNode[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.order - b.order);
    list.forEach((node, index) => {
      node.order = index;
      ordered.push(node);
    });
  }
  let milestones = current.roadmap?.milestones.map((item) => cloneMilestone(item) as Milestone);
  if (current.roadmap !== undefined) {
    milestones = milestones ?? [];
    for (const change of inverse.roadmapChanges ?? []) {
      const target = change[restoring ? 'before' : 'after'];
      milestones = milestones.filter((item) => item.nodeId !== change.nodeId);
      if (target !== null) milestones.push(cloneMilestone(target) as Milestone);
    }
    milestones.sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  }
  const candidate: Plan = {
    nodes: ordered,
    dependencies: edges,
    ...(current.roadmap === undefined ? {} : { roadmap: { milestones: milestones ?? [] } }),
  };
  const issues = validatePlanStructure(candidate);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: candidate };
}
