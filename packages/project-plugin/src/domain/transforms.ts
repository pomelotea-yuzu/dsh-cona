// 计划纯变换（tasks 1.2）：批量操作整体接受或整体拒绝，不修改调用者输入。
// id 由应用层生成后传入；变换只做结构与领域校验。

import type { DependencyEdge, Plan, TransformResult, WorkNode } from './types.js';
import { validatePlanStructure } from './validate.js';
import { UUID_RE } from './validate-constants.js';
import type { PresetContentLocale, PresetDescriptor } from './presets.js';
import { validatePreset } from './presets.js';

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

/** 分组节点的组内容：标题、目标与完成条件由请求提供，身份由应用层分配。 */
export interface GroupContent {
  title: string;
  goal: string;
  completionCriteria: string[];
}

/**
 * 分组同级普通节点（tasks 2.1，design §2）：创建一个组节点并移动选中的原子树。
 * - 选择必须非空、全部存在且同父级；任一为根节点即拒绝（根降为组子节点违反 v1 父链规则）；
 * - 组节点挂在同一父级之下，`anchorId`（null=末尾）定位插入点；锚点不得是被选中节点；
 * - 新组 id 由应用层生成后传入（UUID、不与现有节点冲突）；
 * - 原子树 id、目标、完成条件、状态、显式依赖与记录引用保持原值；成员在组内保持
 *   原同级相对顺序；不产生新的依赖边。任何一项非法时整批拒绝。
 */
export function groupNodes(
  plan: Plan,
  nodeIds: readonly string[],
  content: GroupContent,
  newGroupId: string,
  anchorId: string | null,
): TransformResult<Plan> {
  if (nodeIds.length === 0) {
    return fail({ code: 'empty-selection', path: '/plan/nodes', message: '分组选择为空' });
  }
  if (!UUID_RE.test(newGroupId)) {
    return fail({ code: 'invalid-uuid', path: '/group/id', message: '组节点 ID 必须是 v4 UUID' });
  }
  const existingIds = new Set(plan.nodes.map((node) => node.id));
  if (existingIds.has(newGroupId)) {
    return fail({ code: 'duplicate-node-id', path: '/group/id', message: '组节点 ID 与现有节点冲突' });
  }

  const selected: WorkNode[] = [];
  for (const id of nodeIds) {
    const found = plan.nodes.find((node) => node.id === id);
    if (found === undefined) {
      return fail({ code: 'node-not-found', path: '/plan/nodes', message: `节点 ${id} 不存在` });
    }
    if (found.parentId === null) {
      return fail({ code: 'root-in-selection', path: '/plan/nodes', message: `根节点 ${id} 不能成为组节点的子节点` });
    }
    selected.push(found);
  }
  const parentId = selected[0]!.parentId;
  if (selected.some((node) => node.parentId !== parentId)) {
    return fail({ code: 'cross-parent-selection', path: '/plan/nodes', message: '分组选择必须属于同一父级' });
  }

  if (anchorId !== null) {
    const anchor = plan.nodes.find((node) => node.id === anchorId);
    if (anchor === undefined) {
      return fail({ code: 'invalid-anchor', path: '/plan/nodes', message: `锚点节点 ${anchorId} 不存在` });
    }
    if (anchor.parentId !== parentId) {
      return fail({ code: 'invalid-anchor', path: '/plan/nodes', message: '锚点不属于分组节点的同级组' });
    }
    if (nodeIds.includes(anchorId)) {
      return fail({ code: 'invalid-anchor', path: '/plan/nodes', message: '锚点不能是被分组的节点' });
    }
  }

  // 同级组按 order 排序；成员按原相对顺序取出（与请求 nodeIds 顺序无关）。
  const siblings = plan.nodes
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => a.order - b.order)
    .map((node) => ({ ...node, completionCriteria: [...node.completionCriteria] }));
  const selectedIds = new Set(nodeIds);
  const selectedInOrder = siblings.filter((node) => selectedIds.has(node.id));
  const rest = siblings.filter((node) => !selectedIds.has(node.id));

  const group: WorkNode = {
    id: newGroupId,
    parentId,
    order: 0,
    title: content.title,
    goal: content.goal,
    completionCriteria: [...content.completionCriteria],
    status: 'todo',
  };
  const insertAt = anchorId === null ? rest.length : rest.findIndex((node) => node.id === anchorId);
  const nextSiblings = [...rest.slice(0, insertAt), group, ...rest.slice(insertAt)];

  const members = selectedInOrder.map((node, index) => ({
    ...node,
    parentId: newGroupId,
    order: index,
  }));
  // 成员的后代保持原 parentId 与 order；分组不触及成员子树内部的次序。
  const untouched = plan.nodes
    .filter((node) => !selectedIds.has(node.id) && node.parentId !== parentId)
    .map((node) => ({ ...node, completionCriteria: [...node.completionCriteria] }));

  const nodes: WorkNode[] = [...untouched];
  nextSiblings.forEach((node, index) => {
    node.order = index;
    nodes.push(node);
  });
  nodes.push(...members);

  const candidate: Plan = {
    nodes,
    dependencies: plan.dependencies.map((edge) => ({ ...edge })),
  };
  const issues = validatePlanStructure(candidate);
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: candidate };
}

/**
 * 移动节点：以目标父节点 `parentId`（null 表示根组）和同级锚点 `beforeNodeId`
 * （null 表示追加到同级末尾）定位。先从原同级组取出节点，再插入目标组并重编号
 * 两个受影响的同级组。
 *
 * v1 允许多根森林：根节点只在根组内重排，非根节点以现有节点为目标父节点。
 * 根降为子节点、非根升为根、移到自身或后代之下、锚定自身、缺失节点或锚点
 * 不属于目标同级组均整体拒绝。节点 id、子树内部关系、目标、完成条件、状态、
 * 显式依赖与记录引用保持原值；不产生新的依赖边。
 */
export function moveNode(
  plan: Plan,
  nodeId: string,
  parentId: string | null,
  beforeNodeId: string | null,
): TransformResult<Plan> {
  const node = plan.nodes.find((item) => item.id === nodeId);
  if (node === undefined) {
    return fail({ code: 'node-not-found', path: '/plan/nodes', message: `节点 ${nodeId} 不存在` });
  }

  const isRoot = node.parentId === null;
  const targetIsRoot = parentId === null;
  if (isRoot && !targetIsRoot) {
    return fail({ code: 'root-to-child', path: '/plan/nodes', message: '根节点不能降为子节点' });
  }
  if (!isRoot && targetIsRoot) {
    return fail({ code: 'child-to-root', path: '/plan/nodes', message: '非根节点不能升为根' });
  }

  if (!targetIsRoot) {
    const targetParent = plan.nodes.find((item) => item.id === parentId);
    if (targetParent === undefined) {
      return fail({ code: 'parent-not-found', path: '/plan/nodes', message: `目标父节点 ${parentId} 不存在` });
    }
    // 目标父节点不能是被移动节点本身或其后代，否则会形成父链环。
    const seen = new Set<string>();
    let cursor: string | null = parentId;
    while (cursor !== null) {
      if (cursor === nodeId) {
        return fail({ code: 'invalid-parent', path: '/plan/nodes', message: '不能把节点移到自身或其后代之下' });
      }
      if (seen.has(cursor)) break;
      seen.add(cursor);
      cursor = plan.nodes.find((item) => item.id === cursor)?.parentId ?? null;
    }
  }

  if (beforeNodeId !== null) {
    if (beforeNodeId === nodeId) {
      return fail({ code: 'invalid-anchor', path: '/plan/nodes', message: '不能把节点锚定到自身' });
    }
    const anchor = plan.nodes.find((item) => item.id === beforeNodeId);
    if (anchor === undefined) {
      return fail({ code: 'invalid-anchor', path: '/plan/nodes', message: `锚点节点 ${beforeNodeId} 不存在` });
    }
    if (anchor.parentId !== parentId) {
      return fail({ code: 'invalid-anchor', path: '/plan/nodes', message: '锚点不属于目标同级组' });
    }
  }

  const sourceParentId = node.parentId;
  const byParent = new Map<string | null, WorkNode[]>();
  for (const item of plan.nodes) {
    const key = item.parentId;
    const list = byParent.get(key) ?? [];
    list.push({ ...item, completionCriteria: [...item.completionCriteria] });
    byParent.set(key, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.order - b.order);
  }

  const sourceList = byParent.get(sourceParentId) as WorkNode[];
  sourceList.splice(sourceList.findIndex((item) => item.id === nodeId), 1);

  let targetList = byParent.get(parentId);
  if (targetList === undefined) {
    targetList = [];
    byParent.set(parentId, targetList);
  }
  const insertAt = beforeNodeId === null ? targetList.length : targetList.findIndex((item) => item.id === beforeNodeId);
  targetList.splice(insertAt, 0, { ...node, parentId, completionCriteria: [...node.completionCriteria] });

  const nodes: WorkNode[] = [];
  for (const list of byParent.values()) {
    list.forEach((item, index) => {
      item.order = index;
      nodes.push(item);
    });
  }
  const candidate: Plan = {
    nodes,
    dependencies: plan.dependencies.map((edge) => ({ ...edge })),
  };
  const issues = validatePlanStructure(candidate);
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: candidate };
}

/**
 * 实例化内置流程预设：由应用层为每个模板节点分配一个新项目节点 ID（顺序与预设
 * nodes 一致），模板根的 parentId 用 `parentId`（须为现有节点，null 表示根组 —
 * 但插入要求现有父节点，故 null 以 parent-not-found 拒绝），`beforeNodeId` 定位同级
 * 插入点。模板本地键只映射本次父子与内部依赖；新节点从 todo 开始，既有节点与依赖
 * 原样保留。预设描述、语言、ID、位置任一非法时整体拒绝。
 */
export function instantiateTemplate(
  plan: Plan,
  preset: PresetDescriptor,
  contentLocale: PresetContentLocale,
  newIds: readonly string[],
  parentId: string | null,
  beforeNodeId: string | null,
): TransformResult<Plan> {
  const presetIssues = validatePreset(preset);
  if (presetIssues.length > 0) {
    return fail({ code: 'template-invalid', path: '/template', message: '预设描述无效' });
  }
  if (!preset.contentLocales.includes(contentLocale)) {
    return fail({ code: 'template-locale-unsupported', path: '/contentLocale', message: `不支持的正文语言 ${String(contentLocale)}` });
  }
  if (newIds.length !== preset.nodes.length) {
    return fail({ code: 'template-id-count-mismatch', path: '/newIds', message: '分配 ID 数量与模板节点数不一致' });
  }
  const existingIds = new Set(plan.nodes.map((node) => node.id));
  const batchIds = new Set<string>();
  for (const [index, id] of newIds.entries()) {
    if (!UUID_RE.test(id)) {
      return fail({ code: 'invalid-uuid', path: `/newIds/${index}`, message: '新节点 ID 必须是 v4 UUID' });
    }
    if (existingIds.has(id)) {
      return fail({ code: 'duplicate-node-id', path: `/newIds/${index}`, message: '新节点 ID 与现有节点冲突' });
    }
    if (batchIds.has(id)) {
      return fail({ code: 'duplicate-node-id', path: `/newIds/${index}`, message: '批内 ID 重复' });
    }
    batchIds.add(id);
  }

  if (parentId === null || !existingIds.has(parentId)) {
    return fail({ code: 'parent-not-found', path: '/plan/nodes', message: `目标父节点 ${String(parentId)} 不存在` });
  }
  if (beforeNodeId !== null) {
    const anchor = plan.nodes.find((node) => node.id === beforeNodeId);
    if (anchor === undefined || anchor.parentId !== parentId) {
      return fail({ code: 'invalid-anchor', path: '/plan/nodes', message: '锚点不属于目标同级组' });
    }
  }

  const keyToId = new Map<string, string>();
  preset.nodes.forEach((templateNode, index) => {
    keyToId.set(templateNode.key, newIds[index] as string);
  });

  const text = preset.text[contentLocale];
  const created: WorkNode[] = preset.nodes.map((templateNode, index) => {
    const localText = text[templateNode.key]!;
    const parentKey = templateNode.parentKey;
    return {
      id: newIds[index] as string,
      parentId: parentKey === null ? parentId : keyToId.get(parentKey)!,
      order: templateNode.order,
      title: localText.title,
      goal: localText.goal,
      completionCriteria: [...localText.completionCriteria],
      status: 'todo',
    };
  });
  const templateRoot = created.find((node) => node.id === keyToId.get(preset.nodes.find((n) => n.parentKey === null)!.key))!;

  const injectedDeps: DependencyEdge[] = preset.dependencies.map((edge) => ({
    nodeId: keyToId.get(edge.nodeKey)!,
    requiresNodeId: keyToId.get(edge.requiresKey)!,
  }));

  // 目标同级组：既有节点 + 模板根，按锚点插入并重编号。
  const byParent = new Map<string | null, WorkNode[]>();
  for (const item of plan.nodes) {
    const list = byParent.get(item.parentId) ?? [];
    list.push({ ...item, completionCriteria: [...item.completionCriteria] });
    byParent.set(item.parentId, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.order - b.order);
  const targetList = byParent.get(parentId) ?? [];
  const insertAt = beforeNodeId === null ? targetList.length : targetList.findIndex((item) => item.id === beforeNodeId);
  targetList.splice(insertAt, 0, templateRoot);
  if (!byParent.has(parentId)) byParent.set(parentId, targetList);

  // 模板根以外的节点按各自 parentId 挂到对应组；created 顺序即模板同级顺序，保持相对次序。
  for (const desc of created) {
    if (desc.id === templateRoot.id) continue;
    const list = byParent.get(desc.parentId) ?? [];
    list.push(desc);
    byParent.set(desc.parentId, list);
  }

  const nodes: WorkNode[] = [];
  for (const list of byParent.values()) {
    list.forEach((item, index) => {
      item.order = index;
      nodes.push(item);
    });
  }

  const candidate: Plan = {
    nodes,
    dependencies: [...plan.dependencies.map((edge) => ({ ...edge })), ...injectedDeps],
  };
  const issues = validatePlanStructure(candidate);
  if (issues.length > 0) {
    return { ok: false, issues: [{ code: 'template-invalid', path: '/template', message: '实例化结果未通过 v1 结构校验' }, ...issues] };
  }
  return { ok: true, value: candidate };
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
