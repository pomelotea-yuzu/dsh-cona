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

/** 合并时一条受影响依赖的处置：保留原样、把来源端点重接到保留节点、或删除该边。 */
export interface MergeDependencyResolution {
  edge: { nodeId: string; requiresNodeId: string };
  action: 'keep' | 'reattach' | 'drop';
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

/**
 * 合并同级普通节点（tasks 2.2，design §2）：保留 keepNodeId，来源节点以原 ID
 * 保留为 canceled 与被替代（结构化替代记录由应用层按候选发布，不在变换内）。
 * - 选择必须非空、全部存在、同父级、互不重复，keep 不在来源中；
 * - 来源节点的后代移入保留节点（追加到其子级末尾，相对顺序保持）；
 * - 来源节点留在原父级原位置，状态改为 canceled，其余字段不变；
 * - 每条触及来源节点的依赖边必须显式处置：keep（原样保留）、reattach
 *   （来源端点改指保留节点）、drop（删除）。未处置的边按 unresolved-dependency
 *   整批拒绝；处置指向不存在的边按 dependency-not-found 拒绝；
 * - 保留节点可同时应用字段补丁（复用 update-node 语义，可省略）。
 */
export function mergeNodes(
  plan: Plan,
  keepNodeId: string,
  sourceNodeIds: readonly string[],
  patch: { title?: string; goal?: string; completionCriteria?: string[] } | undefined,
  resolutions: readonly MergeDependencyResolution[],
): TransformResult<Plan> {
  if (sourceNodeIds.length === 0) {
    return fail({ code: 'empty-selection', path: '/plan/nodes', message: '合并来源为空' });
  }
  const exists = plan.nodes.find((node) => node.id === keepNodeId);
  if (exists === undefined) {
    return fail({ code: 'node-not-found', path: '/plan/nodes', message: `保留节点 ${keepNodeId} 不存在` });
  }
  const sources: WorkNode[] = [];
  const seen = new Set<string>();
  for (const id of sourceNodeIds) {
    if (id === keepNodeId) {
      return fail({ code: 'invalid-merge-source', path: '/plan/nodes', message: '保留节点不得出现在来源数组中' });
    }
    const found = plan.nodes.find((node) => node.id === id);
    if (found === undefined) {
      return fail({ code: 'node-not-found', path: '/plan/nodes', message: `来源节点 ${id} 不存在` });
    }
    if (seen.has(id)) {
      return fail({ code: 'duplicate-merge-source', path: '/plan/nodes', message: `来源节点 ${id} 重复` });
    }
    seen.add(id);
    sources.push(found);
  }
  if (sources.some((node) => node.parentId !== exists.parentId)) {
    return fail({ code: 'cross-parent-selection', path: '/plan/nodes', message: '合并的来源与保留节点必须属于同一父级' });
  }

  // 每条触及来源节点的边都必须显式处置；处置的边必须真实存在且触及来源。
  const sourceIds = new Set(sourceNodeIds);
  const touched = plan.dependencies.filter(
    (edge) => sourceIds.has(edge.nodeId) || sourceIds.has(edge.requiresNodeId),
  );
  const edgeKey = (edge: { nodeId: string; requiresNodeId: string }): string => `${edge.nodeId}\u0000${edge.requiresNodeId}`;
  const touchedKeys = new Set(touched.map(edgeKey));
  const unresolved = touched.filter((edge) => !resolutions.some((item) => edgeKey(item.edge) === edgeKey(edge)));
  if (unresolved.length > 0) {
    const first = unresolved[0]!;
    return fail({
      code: 'unresolved-dependency',
      path: '/plan/dependencies',
      message: `依赖 ${first.nodeId}→${first.requiresNodeId} 触及来源节点，需要显式处置（keep／reattach／drop）`,
    });
  }
  const resolutionKeys = new Set(resolutions.map((item) => edgeKey(item.edge)));
  const foreign = resolutions.filter((item) => !touchedKeys.has(edgeKey(item.edge)));
  if (foreign.length > 0) {
    const first = foreign[0]!;
    return fail({
      code: 'dependency-not-found',
      path: '/plan/dependencies',
      message: `处置的依赖 ${first.edge.nodeId}→${first.edge.requiresNodeId} 不存在或不触及来源节点`,
    });
  }

  // 依赖重写：reattach 把来源端点改指保留节点；drop 删除；keep 原样。
  const nextDependencies: DependencyEdge[] = [];
  for (const edge of plan.dependencies) {
    const resolution = resolutions.find((item) => edgeKey(item.edge) === edgeKey(edge));
    if (resolution !== undefined) {
      if (resolution.action === 'keep') nextDependencies.push({ ...edge });
      if (resolution.action === 'reattach') {
        nextDependencies.push({
          nodeId: sourceIds.has(edge.nodeId) ? keepNodeId : edge.nodeId,
          requiresNodeId: sourceIds.has(edge.requiresNodeId) ? keepNodeId : edge.requiresNodeId,
        });
      }
      continue;
    }
    nextDependencies.push({ ...edge });
  }

  // 保留节点：应用字段补丁（title／goal／completionCriteria，与 update-node 同语义）。
  const basePlan: Plan =
    patch === undefined
      ? { nodes: plan.nodes.map((node) => ({ ...node, completionCriteria: [...node.completionCriteria] })), dependencies: plan.dependencies.map((edge) => ({ ...edge })) }
      : (() => {
          const patched = plan.nodes.map((node) => {
            if (node.id !== keepNodeId) return { ...node, completionCriteria: [...node.completionCriteria] };
            return {
              ...node,
              ...(patch.title === undefined ? {} : { title: patch.title }),
              ...(patch.goal === undefined ? {} : { goal: patch.goal }),
              ...(patch.completionCriteria === undefined ? {} : { completionCriteria: [...patch.completionCriteria] }),
            };
          });
          return { nodes: patched, dependencies: plan.dependencies.map((edge) => ({ ...edge })) };
        })();

  // 来源节点：状态 canceled（原 ID 原位置保留）；其子级移到保留节点末尾（按原相对顺序）。
  const keepChildren = basePlan.nodes.filter((node) => node.parentId === keepNodeId).sort((a, b) => a.order - b.order);
  const descendantsBySource = new Map<string, WorkNode[]>();
  for (const source of sources) {
    descendantsBySource.set(
      source.id,
      basePlan.nodes.filter((node) => node.parentId === source.id).sort((a, b) => a.order - b.order),
    );
  }

  // 来源的直接子级从原位置移除（稍后重挂到保留节点下），避免与重挂副本重复。
  const nodes = basePlan.nodes
    .filter((node) => node.parentId === null || !sourceIds.has(node.parentId))
    .map((node) => {
      if (sourceIds.has(node.id)) {
        return { ...node, status: 'canceled' as const, completionCriteria: [...node.completionCriteria] };
      }
      return { ...node, completionCriteria: [...node.completionCriteria] };
    });

  // 后代重挂：追加到保留节点子级末尾，保持每个来源子级内的相对顺序。
  let cursor = keepChildren.length;
  for (const source of sources) {
    for (const child of descendantsBySource.get(source.id) ?? []) {
      nodes.push({ ...child, parentId: keepNodeId, order: cursor, completionCriteria: [...child.completionCriteria] });
      cursor += 1;
    }
  }

  const candidate: Plan = { nodes, dependencies: nextDependencies };
  const issues = validatePlanStructure(candidate);
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: candidate };
}

/**
 * 复制子树（tasks 2.2，design §2）：源子树按 DFS 顺序映射到应用层分配的新 ID。
 * - 目标父节点必须存在（null 按 parent-not-found 拒绝，与模板插入一致）；
 * - 锚点必须属于目标同级组；`newIds` 数量与源子树节点数一致且全部为未用 UUID；
 * - 新节点保留标题、目标、完成条件与内部结构（parentId/order 按 DFS 键映射），
 *   一律从 todo 开始；内部依赖按两端映射到新 ID；
 * - 触及子树外节点的外部依赖默认不接入；请求明确列出的外部边按原端点映射
 *   （子树内端点 → 新 ID）接入，列出不存在或不触及子树的外部边整批拒绝。
 */
export function copySubtree(
  plan: Plan,
  nodeId: string,
  targetParentId: string | null,
  anchorId: string | null,
  newIds: readonly string[],
  externalDependencies: readonly { nodeId: string; requiresNodeId: string }[],
): TransformResult<Plan> {
  const root = plan.nodes.find((node) => node.id === nodeId);
  if (root === undefined) {
    return fail({ code: 'node-not-found', path: '/plan/nodes', message: `复制源节点 ${nodeId} 不存在` });
  }
  if (targetParentId === null || !plan.nodes.some((node) => node.id === targetParentId)) {
    return fail({ code: 'parent-not-found', path: '/plan/nodes', message: `目标父节点 ${String(targetParentId)} 不存在` });
  }
  if (anchorId !== null) {
    const anchor = plan.nodes.find((node) => node.id === anchorId);
    if (anchor === undefined || anchor.parentId !== targetParentId) {
      return fail({ code: 'invalid-anchor', path: '/plan/nodes', message: '锚点不属于目标同级组' });
    }
  }

  // DFS 收集源子树（保持父子与同级顺序）。
  const childrenOf = new Map<string | null, WorkNode[]>();
  for (const node of plan.nodes) {
    const list = childrenOf.get(node.parentId) ?? [];
    list.push(node);
    childrenOf.set(node.parentId, list);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.order - b.order);
  const subtree: WorkNode[] = [];
  const subtreeIds = new Set<string>();
  const walk = (id: string): void => {
    const node = plan.nodes.find((item) => item.id === id);
    if (node === undefined) return;
    subtree.push(node);
    subtreeIds.add(id);
    for (const child of childrenOf.get(id) ?? []) walk(child.id);
  };
  walk(nodeId);
  if (newIds.length !== subtree.length) {
    return fail({ code: 'copy-id-count-mismatch', path: '/newIds', message: `分配 ID 数量 ${newIds.length} 与源子树节点数 ${subtree.length} 不一致` });
  }
  const existingIds = new Set(plan.nodes.map((node) => node.id));
  const batchIds = new Set<string>();
  for (const [index, id] of newIds.entries()) {
    if (!UUID_RE.test(id)) {
      return fail({ code: 'invalid-uuid', path: `/newIds/${index}`, message: '新节点 ID 必须是 v4 UUID' });
    }
    if (existingIds.has(id) || batchIds.has(id)) {
      return fail({ code: 'duplicate-node-id', path: `/newIds/${index}`, message: `新节点 ID ${id} 冲突或批内重复` });
    }
    batchIds.add(id);
  }

  // 外部依赖处置：列出的边必须真实存在且恰好触及子树一端。
  for (const edge of externalDependencies) {
    const found = plan.dependencies.some(
      (item) => item.nodeId === edge.nodeId && item.requiresNodeId === edge.requiresNodeId,
    );
    if (!found) {
      return fail({ code: 'dependency-not-found', path: '/plan/dependencies', message: `接入的依赖 ${edge.nodeId}→${edge.requiresNodeId} 在源资料中不存在` });
    }
    const inSubtree = subtreeIds.has(edge.nodeId) !== subtreeIds.has(edge.requiresNodeId);
    if (!inSubtree) {
      return fail({ code: 'dependency-not-found', path: '/plan/dependencies', message: `依赖 ${edge.nodeId}→${edge.requiresNodeId} 不是源子树的外部依赖` });
    }
  }

  // 新节点：DFS 顺序映射新 ID；parentId 沿父子键映射（根映射到目标父）。
  const idMap = new Map<string, string>();
  subtree.forEach((node, index) => idMap.set(node.id, newIds[index] as string));
  const created: WorkNode[] = subtree.map((node, index) => ({
    id: newIds[index] as string,
    parentId: node.id === nodeId ? targetParentId : (idMap.get(node.parentId as string) as string),
    order: node.order,
    title: node.title,
    goal: node.goal,
    completionCriteria: [...node.completionCriteria],
    status: 'todo',
  }));

  // 内部依赖映射；外部依赖按确认接入（子树内端点 → 新 ID）。
  const internalDeps = plan.dependencies
    .filter((edge) => subtreeIds.has(edge.nodeId) && subtreeIds.has(edge.requiresNodeId))
    .map((edge) => ({ nodeId: idMap.get(edge.nodeId)!, requiresNodeId: idMap.get(edge.requiresNodeId)! }));
  const adoptedDeps = externalDependencies.map((edge) => ({
    nodeId: subtreeIds.has(edge.nodeId) ? (idMap.get(edge.nodeId) as string) : edge.nodeId,
    requiresNodeId: subtreeIds.has(edge.requiresNodeId) ? (idMap.get(edge.requiresNodeId) as string) : edge.requiresNodeId,
  }));

  const byParent = new Map<string | null, WorkNode[]>();
  for (const node of plan.nodes) {
    const list = byParent.get(node.parentId) ?? [];
    list.push({ ...node, completionCriteria: [...node.completionCriteria] });
    byParent.set(node.parentId, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.order - b.order);
  const targetList = byParent.get(targetParentId) ?? [];
  const insertAt = anchorId === null ? targetList.length : targetList.findIndex((item) => item.id === anchorId);
  const copyRoot = created[0]!;
  targetList.splice(insertAt, 0, copyRoot);
  if (!byParent.has(targetParentId)) byParent.set(targetParentId, targetList);
  for (const desc of created) {
    if (desc.id === copyRoot.id) continue;
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
    dependencies: [...plan.dependencies.map((edge) => ({ ...edge })), ...internalDeps, ...adoptedDeps],
  };
  const issues = validatePlanStructure(candidate);
  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: candidate };
}
