// 规划命令的不可变变换（tasks 4.1）：输入不被修改，任何一步失败整体拒绝。
// 新节点身份由应用层生成后传入；命令不接受模型指定的新节点 id 来覆盖旧节点。

import { computePlanVersion } from './canonical/plan-fingerprint.js';
import { addNodes, setDependencies, splitNode } from './transforms.js';
import type {
  DependencyEdge,
  NodeStatus,
  Plan,
  ProjectDocument,
  RecordIndexEntry,
  Sha256Fn,
  TransformResult,
  ValidationIssue,
  WorkNode,
} from './types.js';
import { NODE_STATUSES } from './types.js';
import { validatePlanStructure, validateProjectDocument } from './validate.js';

function fail(...issues: ValidationIssue[]): TransformResult<never> {
  return { ok: false, issues };
}

/** 允许修改的节点字段：身份、父级与展示顺序不通过此命令改变。 */
export interface NodePatch {
  title?: string;
  goal?: string;
  completionCriteria?: string[];
}

/** 修改节点文本与完成条件；id、parentId、order、status 不在本命令范围内。 */
export function updateNode(plan: Plan, nodeId: string, patch: NodePatch): TransformResult<Plan> {
  const index = plan.nodes.findIndex((node) => node.id === nodeId);
  if (index === -1) {
    return fail({ code: 'node-not-found', path: '/plan/nodes', message: `节点 ${nodeId} 不存在` });
  }
  if (patch.title === undefined && patch.goal === undefined && patch.completionCriteria === undefined) {
    return fail({ code: 'empty-patch', path: '/plan/nodes', message: '修改命令未提供任何字段' });
  }
  const current = plan.nodes[index] as WorkNode;
  const updated: WorkNode = {
    ...current,
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.goal === undefined ? {} : { goal: patch.goal }),
    ...(patch.completionCriteria === undefined ? {} : { completionCriteria: [...patch.completionCriteria] }),
  };
  const nodes = plan.nodes.map((node, i) =>
    i === index ? updated : { ...node, completionCriteria: [...node.completionCriteria] },
  );
  const candidate: Plan = { nodes, dependencies: plan.dependencies.map((edge) => ({ ...edge })) };
  const issues = validatePlanStructure(candidate);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: candidate };
}

/** 显式改变节点状态；不因过程记录或子节点完成而推导。 */
export function setNodeStatus(plan: Plan, nodeId: string, status: NodeStatus): TransformResult<Plan> {
  if (!(NODE_STATUSES as readonly string[]).includes(status)) {
    return fail({ code: 'invalid-node-status', path: '/plan/nodes', message: `未知状态 ${String(status)}` });
  }
  const index = plan.nodes.findIndex((node) => node.id === nodeId);
  if (index === -1) {
    return fail({ code: 'node-not-found', path: '/plan/nodes', message: `节点 ${nodeId} 不存在` });
  }
  const nodes = plan.nodes.map((node, i) =>
    i === index
      ? { ...node, status, completionCriteria: [...node.completionCriteria] }
      : { ...node, completionCriteria: [...node.completionCriteria] },
  );
  const candidate: Plan = { nodes, dependencies: plan.dependencies.map((edge) => ({ ...edge })) };
  const issues = validatePlanStructure(candidate);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: candidate };
}

/** 追加公开记录索引：id 唯一，其余字段由后续完整校验核对。 */
export function appendRecordIndex(
  records: readonly RecordIndexEntry[],
  entry: RecordIndexEntry,
): TransformResult<RecordIndexEntry[]> {
  if (records.some((record) => record.id === entry.id)) {
    return fail({ code: 'duplicate-record-id', path: '/records', message: `记录 ${entry.id} 已存在` });
  }
  return { ok: true, value: [...records, entry] };
}

/** 规划命令：add-nodes / update-node / split-node / set-dependencies / set-node-status。 */
export type PlanCommand =
  | { type: 'add-nodes'; nodes: WorkNode[] }
  | { type: 'update-node'; nodeId: string; patch: NodePatch }
  | { type: 'split-node'; parentId: string; children: WorkNode[] }
  | { type: 'set-dependencies'; dependencies: DependencyEdge[] }
  | { type: 'set-node-status'; nodeId: string; status: NodeStatus };

/**
 * 应用规划命令并重算指纹；最后用完整文档校验兜底（含 done 完成条件、引用完整性）。
 * 输入 `doc` 不被修改。
 */
export function applyPlanCommand(
  doc: ProjectDocument,
  command: PlanCommand,
  sha256: Sha256Fn,
): { ok: true; doc: ProjectDocument } | { ok: false; issues: ValidationIssue[] } {
  let result: TransformResult<Plan>;
  switch (command.type) {
    case 'add-nodes':
      result = addNodes(doc.plan, command.nodes);
      break;
    case 'update-node':
      result = updateNode(doc.plan, command.nodeId, command.patch);
      break;
    case 'split-node':
      result = splitNode(doc.plan, command.parentId, command.children);
      break;
    case 'set-dependencies':
      result = setDependencies(doc.plan, command.dependencies);
      break;
    case 'set-node-status':
      result = setNodeStatus(doc.plan, command.nodeId, command.status);
      break;
    default: {
      const exhaustive: never = command;
      return { ok: false, issues: [{ code: 'unknown-command', path: '', message: String(exhaustive) }] };
    }
  }
  if (!result.ok) return { ok: false, issues: result.issues };

  const draft: ProjectDocument = {
    schemaVersion: doc.schemaVersion,
    project: doc.project,
    plan: result.value,
    planVersion: '',
    records: doc.records,
  };
  draft.planVersion = computePlanVersion(draft, sha256).planVersion;
  const validated = validateProjectDocument(draft, { sha256 });
  if (!validated.ok) return { ok: false, issues: validated.issues };
  return { ok: true, doc: validated.doc };
}
