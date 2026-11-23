// 规划命令的不可变变换（tasks 4.1）：输入不被修改，任何一步失败整体拒绝。
// 新节点身份由应用层生成后传入；命令不接受模型指定的新节点 id 来覆盖旧节点。

import { computePlanVersion } from './canonical/plan-fingerprint.js';
import {
  addNodes,
  copySubtree,
  groupNodes,
  instantiateTemplate,
  mergeNodes,
  moveNode,
  setDependencies,
  splitNode,
  type GroupContent,
  type MergeDependencyResolution,
} from './transforms.js';
import type { PresetContentLocale, PresetDescriptor } from './presets.js';
import { instantiateUserTemplate } from './user-template.js';
import type { UserTemplateBody } from './user-template.js';
import type {
  DependencyEdge,
  MilestoneDelivery,
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
import { removeMilestone, setMilestone } from './roadmap.js';

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

/** 规划命令：add-nodes / update-node / split-node / group-nodes / merge-nodes / copy-subtree / set-dependencies / set-node-status / move-node。 */
export type PlanCommand =
  | { type: 'add-nodes'; nodes: WorkNode[] }
  | { type: 'update-node'; nodeId: string; patch: NodePatch }
  | { type: 'split-node'; parentId: string; children: WorkNode[] }
  | { type: 'group-nodes'; nodeIds: string[]; group: GroupContent; anchorId: string | null; newGroupId: string }
  | { type: 'merge-nodes'; keepNodeId: string; sourceNodeIds: string[]; patch?: NodePatch; resolutions: MergeDependencyResolution[] }
  | { type: 'copy-subtree'; nodeId: string; targetParentId: string | null; anchorId: string | null; newIds: string[]; externalDependencies: { nodeId: string; requiresNodeId: string }[] }
  | { type: 'set-dependencies'; dependencies: DependencyEdge[] }
  | { type: 'set-node-status'; nodeId: string; status: NodeStatus }
  | { type: 'move-node'; nodeId: string; parentId: string | null; beforeNodeId: string | null }
  /** 4.3：只改目标里程碑的公开字段（整体替换 deliveries，空数组合法）。 */
  | { type: 'set-milestone'; nodeId: string; deliveries: MilestoneDelivery[] }
  | { type: 'remove-milestone'; nodeId: string }
  | {
      type: 'instantiate-template';
      preset: PresetDescriptor;
      contentLocale: PresetContentLocale;
      newIds: string[];
      parentId: string | null;
      beforeNodeId: string | null;
    }
  | {
      type: 'instantiate-user-template';
      body: UserTemplateBody;
      newIds: string[];
      parentId: string | null;
      beforeNodeId: string | null;
    };

/**
 * 应用规划命令并重算指纹；最后用完整文档校验兜底（含 done 完成条件、引用完整性）。
 * 输入 `doc` 不被修改。
 */
export function applyPlanCommand(
  doc: ProjectDocument,
  command: PlanCommand,
  sha256: Sha256Fn,
): { ok: true; doc: ProjectDocument } | { ok: false; issues: ValidationIssue[] } {
  // 里程碑完成只能走 complete-milestone（4.3）：普通状态命令、改条件、重新标记都要先重新打开。
  const guardedNodeId = command.type === 'set-node-status' || command.type === 'update-node' || command.type === 'set-milestone'
    ? command.nodeId
    : null;
  if (guardedNodeId !== null && doc.plan.roadmap?.milestones.some((item) => item.nodeId === guardedNodeId)) {
    const node = doc.plan.nodes.find((item) => item.id === guardedNodeId);
    if (node !== undefined) {
      if (command.type === 'set-node-status' && command.status === 'done') {
        return { ok: false, issues: [{ code: 'milestone-evidence-required', path: '/plan/nodes', message: '里程碑节点不能由普通状态命令完成；用 complete-milestone 提交逐项证据' }] };
      }
      if (node.status === 'done' && command.type === 'update-node' && command.patch.completionCriteria !== undefined) {
        return { ok: false, issues: [{ code: 'milestone-reopen-required', path: '/plan/nodes', message: '已完成里程碑的完成条件不能直接修改；先重新打开并补验' }] };
      }
      if (node.status === 'done' && command.type === 'set-milestone') {
        return { ok: false, issues: [{ code: 'milestone-reopen-required', path: '/plan/roadmap', message: '已完成里程碑的交付不能直接修改；先重新打开并补验' }] };
      }
    }
  }

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
    case 'group-nodes':
      result = groupNodes(doc.plan, command.nodeIds, command.group, command.newGroupId, command.anchorId);
      break;
    case 'merge-nodes':
      result = mergeNodes(doc.plan, command.keepNodeId, command.sourceNodeIds, command.patch, command.resolutions);
      break;
    case 'copy-subtree':
      result = copySubtree(doc.plan, command.nodeId, command.targetParentId, command.anchorId, command.newIds, command.externalDependencies);
      break;
    case 'set-dependencies':
      result = setDependencies(doc.plan, command.dependencies);
      break;
    case 'set-node-status':
      result = setNodeStatus(doc.plan, command.nodeId, command.status);
      break;
    case 'move-node':
      result = moveNode(doc.plan, command.nodeId, command.parentId, command.beforeNodeId);
      break;
    case 'set-milestone':
      result = setMilestone(doc.plan, command.nodeId, command.deliveries);
      break;
    case 'remove-milestone':
      result = removeMilestone(doc.plan, command.nodeId);
      break;
    case 'instantiate-template':
      result = instantiateTemplate(
        doc.plan,
        command.preset,
        command.contentLocale,
        command.newIds,
        command.parentId,
        command.beforeNodeId,
      );
      break;
    case 'instantiate-user-template':
      result = instantiateUserTemplate(
        doc.plan,
        command.body,
        command.newIds,
        command.parentId,
        command.beforeNodeId,
      );
      break;
    default: {
      const exhaustive: never = command;
      return { ok: false, issues: [{ code: 'unknown-command', path: '', message: String(exhaustive) }] };
    }
  }
  if (!result.ok) return { ok: false, issues: result.issues };

  // v2 roadmap 不属于普通变换的目标：结构编辑原样保留未编辑的里程碑扩展；
  // 里程碑专用命令的结果已带新 roadmap，不能被原值覆盖。
  const milestoneCommand = command.type === 'set-milestone' || command.type === 'remove-milestone';
  const transformed: Plan = doc.plan.roadmap === undefined || milestoneCommand
    ? result.value
    : { ...result.value, roadmap: doc.plan.roadmap };
  const draft: ProjectDocument = {
    schemaVersion: doc.schemaVersion,
    project: doc.project,
    plan: transformed,
    planVersion: '',
    records: doc.records,
  };
  draft.planVersion = computePlanVersion(draft, sha256).planVersion;
  const validated = validateProjectDocument(draft, { sha256 });
  if (!validated.ok) return { ok: false, issues: validated.issues };
  return { ok: true, doc: validated.doc };
}
