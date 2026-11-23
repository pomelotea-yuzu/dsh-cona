// 用户流程模板的可移植正文（tasks 2.4，design §2「用户模板目录与版本」）。
// 模板记录是 kind:"plan-change"，索引 summary 以精确前缀 `[cona:template] ` 开头，
// 正文首行 `<!-- cona:template v1 -->`，紧接标为 json 的围栏代码块（严格 JSON：
// 拒重复键、未知版本、未知字段、非安全整数），其后为可读 Markdown，UTF-8 无 BOM。
//
// 正文只含显式确认的标题、目标、完成条件、层级与内部依赖：
// - 节点用局部 key / parentKey（根为 null），绝不写入项目节点 UUID；
// - 依赖两端均为模板 key，对外依赖在抽取子树时省略，不带私有数据、聊天与授权。
// 本模块不依赖 Node／React／Cordis；发布与目录读取由应用层承担。

import { strictParse } from './strict-json.js';
import { UUID_RE } from './validate-constants.js';
import { validatePlanStructure } from './validate.js';
import type { DependencyEdge, Plan, TransformResult, ValidationIssue, WorkNode } from './types.js';

export const USER_TEMPLATE_SUMMARY_PREFIX = '[cona:template] ';
export const USER_TEMPLATE_VERSION_MARKER = '<!-- cona:template v1 -->';
export const USER_TEMPLATE_VERSION = 1 as const;

/** 单语言正文标签：明确语言标签或 und（未指定）；与宿主 UI 语言独立。 */
const LANGUAGE_RE = /^(?:[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*|und)$/;
/** 模板局部键：稳定小写连字符字符串，与项目节点 UUID 分开。 */
const KEY_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export interface UserTemplateNode {
  key: string;
  parentKey: string | null;
  order: number;
  title: string;
  goal: string;
  completionCriteria: string[];
}

export interface UserTemplateDependency {
  nodeKey: string;
  requiresKey: string;
}

/** 一次不可变发布的正文；templateId 沿用 UUID，title/bodyLanguage 为作者原文。 */
export interface UserTemplateBody {
  version: 1;
  templateId: string;
  title: string;
  bodyLanguage: string;
  nodes: UserTemplateNode[];
  dependencies: UserTemplateDependency[];
}

const BODY_KEYS = new Set(['version', 'templateId', 'title', 'bodyLanguage', 'nodes', 'dependencies']);
const NODE_KEYS = new Set(['key', 'parentKey', 'order', 'title', 'goal', 'completionCriteria']);
const DEP_KEYS = new Set(['nodeKey', 'requiresKey']);

/** 正文规模上限：防止超大描述进入公开资料。 */
export const USER_TEMPLATE_LIMITS = {
  maxNodes: 200,
  maxCriteriaPerNode: 50,
  maxTitleChars: 500,
  maxGoalChars: 2000,
  maxCriterionChars: 500,
  maxBodyChars: 200_000,
} as const;

function isPlainObject(value: unknown): value is { [key: string]: unknown } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function issue(code: string, path: string, message?: string): ValidationIssue {
  return message === undefined ? { code, path } : { code, path, message };
}

/** 从完整 Plan 抽取以 rootId 为根的子树模板描述：局部键、仅内部依赖、原 ID 不进正文。 */
export function extractSubtreeTemplate(plan: Plan, rootId: string): { nodes: UserTemplateNode[]; keyOf: Map<string, string> } {
  const children = new Map<string | null, WorkNode[]>();
  for (const node of plan.nodes) {
    const list = children.get(node.parentId) ?? [];
    list.push({ ...node, completionCriteria: [...node.completionCriteria] });
    children.set(node.parentId, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.order - b.order);
  const root = plan.nodes.find((node) => node.id === rootId);
  if (root === undefined) return { nodes: [], keyOf: new Map() };

  const nodes: UserTemplateNode[] = [];
  const keyOf = new Map<string, string>();
  let cursor = 0;
  const nextKey = (): string => `n${cursor++}`;
  const walk = (node: WorkNode, parentKey: string | null): void => {
    const key = nextKey();
    keyOf.set(node.id, key);
    nodes.push({
      key,
      parentKey,
      order: 0,
      title: node.title,
      goal: node.goal,
      completionCriteria: [...node.completionCriteria],
    });
    for (const child of children.get(node.id) ?? []) walk(child, key);
  };
  walk(root, null);

  // 同级 order 从 0 连续（按抽取顺序）。
  const byParent = new Map<string | null, UserTemplateNode[]>();
  for (const node of nodes) {
    const list = byParent.get(node.parentKey) ?? [];
    list.push(node);
    byParent.set(node.parentKey, list);
  }
  for (const list of byParent.values()) list.forEach((node, index) => { node.order = index; });
  return { nodes, keyOf };
}

/** 模板内依赖：两端都在给定节点集合才保留，对外依赖省略（不写入正文）。 */
export function internalDependencies(plan: Plan, keyOf: Map<string, string>): UserTemplateDependency[] {
  const seen = new Set<string>();
  const result: UserTemplateDependency[] = [];
  for (const edge of plan.dependencies) {
    const nodeKey = keyOf.get(edge.nodeId);
    const requiresKey = keyOf.get(edge.requiresNodeId);
    if (nodeKey === undefined || requiresKey === undefined) continue;
    const id = `${nodeKey}->${requiresKey}`;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ nodeKey, requiresKey });
  }
  return result.sort((a, b) => a.nodeKey.localeCompare(b.nodeKey) || a.requiresKey.localeCompare(b.requiresKey));
}

/** 校验解析后的模板正文结构（形状、键、树、依赖、规模）；返回稳定诊断码。 */
export function validateUserTemplateBody(value: unknown): { ok: true; body: UserTemplateBody } | { ok: false; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  if (!isPlainObject(value)) return { ok: false, issues: [issue('template-invalid', '/', '模板正文必须是 JSON 对象')] };
  const version = value['version'];
  if (version !== USER_TEMPLATE_VERSION) {
    issues.push(issue('template-unknown-version', '/version', `不支持的模板版本 ${String(version)}；当前支持 1`));
  }
  const keys = new Set(Object.keys(value));
  for (const unknown of [...keys].filter((key) => !BODY_KEYS.has(key))) {
    issues.push(issue('template-unknown-field', `/${unknown}`, `模板正文不接受额外字段 ${unknown}`));
  }
  if (typeof value['templateId'] !== 'string' || !UUID_RE.test(value['templateId'])) {
    issues.push(issue('template-invalid-field', '/templateId', 'templateId 必须是 UUID'));
  }
  if (typeof value['title'] !== 'string' || value['title'] === '' || value['title'].length > USER_TEMPLATE_LIMITS.maxTitleChars) {
    issues.push(issue('template-invalid-field', '/title', '标题必须是非空且不超过上限的字符串'));
  }
  if (typeof value['bodyLanguage'] !== 'string' || !LANGUAGE_RE.test(value['bodyLanguage'])) {
    issues.push(issue('template-invalid-language', '/bodyLanguage', '正文语言必须是明确语言标签或 und'));
  }
  if (!Array.isArray(value['nodes']) || value['nodes'].length === 0) {
    issues.push(issue('template-empty-nodes', '/nodes', '模板至少需要一个节点'));
    return { ok: false, issues };
  }
  if (value['nodes'].length > USER_TEMPLATE_LIMITS.maxNodes) {
    issues.push(issue('template-too-large', '/nodes', `节点数超过上限 ${USER_TEMPLATE_LIMITS.maxNodes}`));
  }

  const nodeKeys = new Set<string>();
  const nodeList = value['nodes'] as unknown[];
  nodeList.forEach((raw, index) => {
    const path = `/nodes/${index}`;
    if (!isPlainObject(raw)) {
      issues.push(issue('template-invalid-node', path, '节点必须是对象'));
      return;
    }
    const extra = Object.keys(raw).filter((key) => !NODE_KEYS.has(key));
    if (extra.length > 0) issues.push(issue('template-unknown-field', `${path}/${extra[0]}`, '节点不接受额外字段'));
    const key = raw['key'];
    if (typeof key !== 'string' || !KEY_RE.test(key)) {
      issues.push(issue('template-invalid-key', `${path}/key`, '节点键必须是小写连字符字符串'));
    } else if (nodeKeys.has(key)) {
      issues.push(issue('template-duplicate-key', `${path}/key`, `节点键 ${key} 重复`));
    }
    nodeKeys.add(key as string);
    if (raw['parentKey'] !== null && (typeof raw['parentKey'] !== 'string' || !KEY_RE.test(raw['parentKey']))) {
      issues.push(issue('template-invalid-parent', `${path}/parentKey`, '父键必须是键或 null'));
    }
    if (!Number.isSafeInteger(raw['order']) || (raw['order'] as number) < 0) {
      issues.push(issue('template-invalid-order', `${path}/order`, 'order 必须是非负安全整数'));
    }
    for (const field of ['title', 'goal'] as const) {
      const text = raw[field];
      const limit = field === 'title' ? USER_TEMPLATE_LIMITS.maxTitleChars : USER_TEMPLATE_LIMITS.maxGoalChars;
      if (typeof text !== 'string' || text === '' || text.length > limit) {
        issues.push(issue('template-invalid-field', `${path}/${field}`, `${field} 必须是非空且不超过上限的字符串`));
      }
    }
    const criteria = raw['completionCriteria'];
    if (!Array.isArray(criteria) || criteria.length > USER_TEMPLATE_LIMITS.maxCriteriaPerNode
      || criteria.some((c) => typeof c !== 'string' || c.length > USER_TEMPLATE_LIMITS.maxCriterionChars)) {
      issues.push(issue('template-invalid-field', `${path}/completionCriteria`, '完成条件必须是字符串数组且不超过上限'));
    }
  });

  // 根数量、父键存在、父子无环、同级连续。
  const roots = nodeList.filter((raw) => isPlainObject(raw) && raw['parentKey'] === null);
  if (roots.length !== 1) issues.push(issue('template-root-count', '/nodes', '模板必须是单根子树'));
  const parentOf = new Map<string, string | null>();
  for (const raw of nodeList) {
    if (isPlainObject(raw) && typeof raw['key'] === 'string') parentOf.set(raw['key'], raw['parentKey'] as string | null);
  }
  for (const [key, parentKey] of parentOf) {
    if (parentKey !== null && !nodeKeys.has(parentKey)) {
      issues.push(issue('template-invalid-parent', `/nodes/${key}`, `父键 ${parentKey} 不存在`));
    }
  }
  for (const start of nodeKeys) {
    const seen = new Set<string>();
    let cursor: string | null = start;
    while (cursor !== null) {
      if (seen.has(cursor)) { issues.push(issue('template-parent-cycle', '/nodes', '父子关系存在环')); break; }
      seen.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
  }
  const orders = new Map<string | null, number[]>();
  for (const raw of nodeList) {
    if (!isPlainObject(raw) || !Number.isSafeInteger(raw['order'])) continue;
    const parentKey = raw['parentKey'] as string | null;
    const list = orders.get(parentKey) ?? [];
    list.push(raw['order'] as number);
    orders.set(parentKey, list);
  }
  for (const list of orders.values()) {
    [...list].sort((a, b) => a - b).forEach((value, index) => {
      if (value !== index) issues.push(issue('template-sibling-order-gap', '/nodes', '同级 order 必须从 0 连续'));
    });
  }

  // 依赖：对象形状、两端存在、不自依赖、不重复、无环。
  const depSeen = new Set<string>();
  const adjacency = new Map<string, string[]>();
  if (!Array.isArray(value['dependencies'])) {
    issues.push(issue('template-invalid-field', '/dependencies', '依赖必须是数组'));
  } else {
    for (const [index, raw] of (value['dependencies'] as unknown[]).entries()) {
      const path = `/dependencies/${index}`;
      if (!isPlainObject(raw)) { issues.push(issue('template-invalid-dependency', path, '依赖必须是对象')); continue; }
      const extra = Object.keys(raw).filter((key) => !DEP_KEYS.has(key));
      if (extra.length > 0) issues.push(issue('template-unknown-field', `${path}/${extra[0]}`, '依赖不接受额外字段'));
      const nodeKey = raw['nodeKey'];
      const requiresKey = raw['requiresKey'];
      if (typeof nodeKey !== 'string' || !nodeKeys.has(nodeKey)) issues.push(issue('template-dependency-node-not-found', `${path}/nodeKey`, '依赖端点不存在'));
      if (typeof requiresKey !== 'string' || !nodeKeys.has(requiresKey)) issues.push(issue('template-dependency-node-not-found', `${path}/requiresKey`, '依赖端点不存在'));
      if (nodeKey === requiresKey) issues.push(issue('template-self-dependency', path, '节点不能依赖自身'));
      const id = `${String(nodeKey)}->${String(requiresKey)}`;
      if (depSeen.has(id)) issues.push(issue('template-duplicate-dependency', path, '有向依赖重复'));
      depSeen.add(id);
      if (typeof nodeKey === 'string' && typeof requiresKey === 'string') {
        adjacency.set(requiresKey, [...(adjacency.get(requiresKey) ?? []), nodeKey]);
      }
    }
  }
  const WHITE = 0; const GRAY = 1; const BLACK = 2;
  const color = new Map<string, number>();
  let cycleReported = false;
  const visit = (key: string): void => {
    color.set(key, GRAY);
    for (const next of adjacency.get(key) ?? []) {
      if ((color.get(next) ?? WHITE) === GRAY && !cycleReported) {
        issues.push(issue('template-dependency-cycle', '/dependencies', '依赖存在环'));
        cycleReported = true;
      } else if ((color.get(next) ?? WHITE) === WHITE) visit(next);
    }
    color.set(key, BLACK);
  };
  for (const key of nodeKeys) if ((color.get(key) ?? WHITE) === WHITE) visit(key);

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    body: {
      version: USER_TEMPLATE_VERSION,
      templateId: value['templateId'] as string,
      title: value['title'] as string,
      bodyLanguage: value['bodyLanguage'] as string,
      nodes: (nodeList as UserTemplateNode[]).map((node) => ({ ...node, completionCriteria: [...node.completionCriteria] })),
      dependencies: ((value['dependencies'] ?? []) as UserTemplateDependency[]).map((edge) => ({ ...edge })),
    },
  };
}

/** 构造正文（版本首行 + json 围栏 + 可读 Markdown）；调用前先 validateUserTemplateBody。 */
export function buildUserTemplateText(body: UserTemplateBody): string {
  const json = JSON.stringify({
    version: 1,
    templateId: body.templateId,
    title: body.title,
    bodyLanguage: body.bodyLanguage,
    nodes: body.nodes.map((node) => ({
      key: node.key,
      parentKey: node.parentKey,
      order: node.order,
      title: node.title,
      goal: node.goal,
      completionCriteria: [...node.completionCriteria],
    })),
    dependencies: body.dependencies.map((edge) => ({ ...edge })),
  }, null, 2);
  const lines = body.nodes.map((node) => `- ${node.key}（父：${node.parentKey ?? '根'}）：${node.title}`).join('\n');
  return [
    USER_TEMPLATE_VERSION_MARKER,
    '',
    '```json',
    json,
    '```',
    '',
    '## 用户流程模板',
    '',
    `标题：${body.title}（正文语言 ${body.bodyLanguage}）`,
    '',
    lines,
    '',
  ].join('\n');
}

/** 解析并校验模板正文：首行版本标记 → json 围栏严格解析 → 结构校验。 */
export function parseUserTemplateText(text: string): { ok: true; body: UserTemplateBody } | { ok: false; issues: ValidationIssue[] } {
  if (text.length > USER_TEMPLATE_LIMITS.maxBodyChars) {
    return { ok: false, issues: [issue('template-too-large', '/', '模板正文超过大小上限')] };
  }
  if (!text.startsWith(USER_TEMPLATE_VERSION_MARKER)) {
    return { ok: false, issues: [issue('template-version-marker', '/', '正文首行不是 <!-- cona:template v1 -->')] };
  }
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === '```json');
  const end = start === -1 ? -1 : lines.findIndex((line, index) => index > start && line.trim() === '```');
  if (start === -1 || end === -1) {
    return { ok: false, issues: [issue('template-json-fence', '/', '正文缺少 ```json 围栏代码块')] };
  }
  const parsed = strictParse(lines.slice(start + 1, end).join('\n'));
  if (!parsed.ok) {
    return { ok: false, issues: [issue(parsed.error.code === 'duplicate-key' ? 'duplicate-key' : 'invalid-json', '/', `模板 JSON 解析失败：${parsed.error.message}`)] };
  }
  return validateUserTemplateBody(parsed.value);
}

/**
 * 实例化用户模板（tasks 2.5）：按模板节点顺序分配新项目 ID，用单语言原文创建
 * todo 节点，按局部键映射父子与内部依赖；对外依赖不进入模板，故不注入。
 * 目标 parentId 必须是现有节点（null 以 parent-not-found 拒绝），beforeNodeId 为同级锚点。
 * 输入 Plan 与正文不被修改；任一步失败整体拒绝。
 */
export function instantiateUserTemplate(
  plan: Plan,
  body: UserTemplateBody,
  newIds: readonly string[],
  parentId: string | null,
  beforeNodeId: string | null,
): TransformResult<Plan> {
  const validated = validateUserTemplateBody(body);
  if (!validated.ok) return { ok: false, issues: validated.issues };
  if (newIds.length !== body.nodes.length) {
    return { ok: false, issues: [issue('template-id-count-mismatch', '/newIds', '分配 ID 数量与模板节点数不一致')] };
  }
  const existingIds = new Set(plan.nodes.map((node) => node.id));
  const batch = new Set<string>();
  for (const [index, id] of newIds.entries()) {
    if (!UUID_RE.test(id)) return { ok: false, issues: [issue('invalid-uuid', `/newIds/${index}`, '新节点 ID 必须是 v4 UUID')] };
    if (existingIds.has(id) || batch.has(id)) {
      return { ok: false, issues: [issue('duplicate-node-id', `/newIds/${index}`, '新节点 ID 与现有节点或批内重复')] };
    }
    batch.add(id);
  }
  if (parentId === null || !existingIds.has(parentId)) {
    return { ok: false, issues: [issue('parent-not-found', '/plan/nodes', `目标父节点 ${String(parentId)} 不存在`)] };
  }
  if (beforeNodeId !== null) {
    const anchor = plan.nodes.find((node) => node.id === beforeNodeId);
    if (anchor === undefined || anchor.parentId !== parentId) {
      return { ok: false, issues: [issue('invalid-anchor', '/plan/nodes', '锚点不属于目标同级组')] };
    }
  }

  const keyToId = new Map<string, string>();
  body.nodes.forEach((node, index) => keyToId.set(node.key, newIds[index] as string));
  const created: WorkNode[] = body.nodes.map((node, index) => ({
    id: newIds[index] as string,
    parentId: node.parentKey === null ? parentId : (keyToId.get(node.parentKey) ?? parentId),
    order: node.order,
    title: node.title,
    goal: node.goal,
    completionCriteria: [...node.completionCriteria],
    status: 'todo',
  }));
  const templateRootKey = body.nodes.find((node) => node.parentKey === null)!.key;
  const templateRoot = created.find((node) => node.id === keyToId.get(templateRootKey))!;

  // 目标同级组：既有节点 + 模板根，按锚点插入并重编号；其余创建节点挂到模板内父键映射。
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
  byParent.set(parentId, targetList);
  for (const node of created) {
    if (node.id === templateRoot.id) continue;
    const list = byParent.get(node.parentId) ?? [];
    list.push(node);
    byParent.set(node.parentId, list);
  }

  const nodes: WorkNode[] = [];
  for (const list of byParent.values()) {
    list.forEach((node, index) => { node.order = index; nodes.push(node); });
  }
  const injected: DependencyEdge[] = body.dependencies.map((edge) => ({
    nodeId: keyToId.get(edge.nodeKey)!,
    requiresNodeId: keyToId.get(edge.requiresKey)!,
  }));
  const candidate: Plan = {
    nodes,
    dependencies: [...plan.dependencies.map((edge) => ({ ...edge })), ...injected],
  };
  const issues = validatePlanStructure(candidate);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: candidate };
}
