// 计划纯变换（tasks 1.2）：批量操作整体接受或整体拒绝，不修改调用者输入。
// id 由应用层生成后传入；变换只做结构与领域校验。

import type { DependencyEdge, Plan, TransformResult, WorkNode } from './types.js';
import { validatePlanStructure } from './validate.js';
import { UUID_RE } from './validate-constants.js';

function fail(...codes: { code: string; path: string; message?: string }[]): TransformResult<never> {
  return { ok: false, issues: codes };
}

/**
 * 批量新增节点。任何一项非法（重复 id、非法父引用、同级 order 冲突等）时整批拒绝。
 * v1 允许多根森林（见协议向量），新节点 parentId 可为 null。
 */
export function addNodes(plan: Plan, newNodes: readonly WorkNode[]): TransformResult<Plan> {
  if (newNodes.length === 0) {
    return fail({ code: 'empty-batch', path: '/plan/nodes', message: '批量新增不能为空' });
  }
  const issues: { code: string; path: string; message?: string }[] = [];
  const existingIds = new Set(plan.nodes.map((node) => node.id));
  const batchIds = new Set<string>();
  newNodes.forEach((node, index) => {
    if (!UUID_RE.test(node.id)) {
      issues.push({ code: 'invalid-uuid', path: `/nodes/${index}/id` });
    } else {
      if (batchIds.has(node.id)) {
        issues.push({ code: 'duplicate-node-id', path: `/nodes/${index}/id`, message: '批内节点 id 重复' });
      }
      if (existingIds.has(node.id)) {
        issues.push({ code: 'duplicate-node-id', path: `/nodes/${index}/id`, message: '节点 id 与现有节点冲突' });
      }
      batchIds.add(node.id);
    }
    if (node.parentId !== null && !existingIds.has(node.parentId) && !batchIds.has(node.parentId)) {
      issues.push({ code: 'parent-not-found', path: `/nodes/${index}/parentId`, message: `父节点 ${node.parentId} 不存在` });
    }
  });
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  const merged: Plan = {
    nodes: [...plan.nodes, ...newNodes.map((node) => ({ ...node, completionCriteria: [...node.completionCriteria] }))],
    dependencies: plan.dependencies.map((edge) => ({ ...edge })),
  };
  const structureIssues = validatePlanStructure(merged);
  if (structureIssues.length > 0) {
    return { ok: false, issues: structureIssues };
  }
  return { ok: true, value: merged };
}

/**
 * 拆分节点：父节点保留原 id，一次给出全部新子节点（design §5 split-node）。
 * 新子节点的 parentId 必须为 null 或与目标一致（统一改写为目标），任何一项非法时整批拒绝。
 */
export function splitNode(plan: Plan, parentId: string, newChildren: readonly WorkNode[]): TransformResult<Plan> {
  if (newChildren.length === 0) {
    return fail({ code: 'empty-batch', path: '/plan/nodes', message: '拆分必须给出全部新子节点' });
  }
  const exists = plan.nodes.some((node) => node.id === parentId);
  if (!exists) {
    return fail({ code: 'parent-not-found', path: '/plan/nodes', message: `拆分目标 ${parentId} 不存在` });
  }
  const issues: { code: string; path: string; message?: string }[] = [];
  newChildren.forEach((child, index) => {
    if (child.parentId !== null && child.parentId !== parentId) {
      issues.push({ code: 'split-parent-mismatch', path: `/nodes/${index}/parentId`, message: '拆分子节点的 parentId 必须为 null 或拆分目标' });
    }
  });
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  const normalized = newChildren.map((child) => ({ ...child, parentId }));
  return addNodes(plan, normalized);
}

/**
 * 整体替换依赖集合。任何一条非法（缺节点、自依赖、重复、环）时整体拒绝。
 */
export function setDependencies(plan: Plan, dependencies: readonly DependencyEdge[]): TransformResult<Plan> {
  const candidate: Plan = {
    nodes: plan.nodes.map((node) => ({ ...node, completionCriteria: [...node.completionCriteria] })),
    dependencies: dependencies.map((edge) => ({ ...edge })),
  };
  const structureIssues = validatePlanStructure(candidate);
  if (structureIssues.length > 0) {
    return { ok: false, issues: structureIssues };
  }
  return { ok: true, value: candidate };
}
