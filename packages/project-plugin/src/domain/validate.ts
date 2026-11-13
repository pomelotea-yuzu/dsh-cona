// v1 ProjectDocument 领域校验（design §3；tasks 1.2 / 1.4）。
// 规则：
// - 顶层固定为 schemaVersion / project / plan / planVersion / records，未知字段先拒绝；
// - id 为小写 RFC-4122 v4 形态 UUID（crypto.randomUUID 输出形态）；
// - 根节点 parentId 为 null，同级 order 从 0 连续；单根树；父子无环；
// - dependencies 为有向关系集合：两端存在、不自依赖、无重复、无环；
// - planVersion 形态 sha256:<lowercase-hex>；传入 sha256 时与重算指纹比对；
// - 节点 status === 'done' 必须有非空 completionCriteria，且存在指向该节点的
//   kind='verification' 且 verification.status === 'pass' 的记录（不按子节点推导）；
// - 记录索引：kind 白名单、path 与 contentHash 一致、subjectNodeIds 引用存在节点、
//   sources 只接受公开记录 id 或 {repositoryId, relativePath, observedHash?}；
//   verification 仅允许 kind='verification' 携带。

import type {
  DependencyEdge,
  ProjectDocument,
  RecordIndexEntry,
  RepositoryDecl,
  ValidationIssue,
  ValidationResult,
  WorkNode,
} from './types.js';
import { NODE_STATUSES, RECORD_KINDS, VERIFICATION_STATUSES } from './types.js';
import { computePlanVersion } from './canonical/plan-fingerprint.js';
import type { Sha256Fn } from './types.js';
import { UUID_RE } from './validate-constants.js';

const SHA256_REF_RE = /^sha256:[0-9a-f]{64}$/;
const RECORD_PATH_RE = /^records\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([0-9a-f]{64})\.md$/;

export const TOP_LEVEL_KEYS = ['plan', 'planVersion', 'project', 'records', 'schemaVersion'] as const;
const PROJECT_KEYS = ['constraints', 'goal', 'id', 'repositories', 'title'] as const;
const PLAN_KEYS = ['dependencies', 'nodes'] as const;
const NODE_KEYS = ['completionCriteria', 'goal', 'id', 'order', 'parentId', 'status', 'title'] as const;
const DEPENDENCY_KEYS = ['nodeId', 'requiresNodeId'] as const;
const REPOSITORY_KEYS = ['id', 'label'] as const;
const RECORD_KEYS = ['contentHash', 'id', 'kind', 'path', 'sources', 'subjectNodeIds', 'summary'] as const;
const RECORD_OPTIONAL_KEYS = ['verification'] as const;
const VERIFICATION_KEYS = ['status', 'subject'] as const;
const VERIFICATION_OPTIONAL_KEYS = ['scope', 'subjectVersion'] as const;
const SUBJECT_KEYS = ['id', 'kind'] as const;
const SOURCE_REF_KEYS = ['repositoryId', 'relativePath'] as const;
const SOURCE_REF_OPTIONAL_KEYS = ['observedHash'] as const;

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function add(issues: ValidationIssue[], code: string, path: string, message?: string): void {
  issues.push(message === undefined ? { code, path } : { code, path, message });
}

/** 未知字段先拒绝 + 缺失字段拒绝（可选键单独核对）。 */
function checkKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  path: string,
  issues: ValidationIssue[],
): value is { [key: string]: unknown } {
  if (!isRecord(value)) {
    add(issues, 'invalid-type', path, '必须是对象');
    return false;
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      add(issues, 'unknown-field', `${path}/${key}`, `未知字段：${key}`);
    }
  }
  for (const key of required) {
    if (!(key in value)) {
      add(issues, 'missing-field', `${path}/${key}`, `缺失字段：${key}`);
    }
  }
  return true;
}

function checkString(value: unknown, path: string, issues: ValidationIssue[]): value is string {
  if (typeof value !== 'string') {
    add(issues, 'invalid-type', path, '必须是字符串');
    return false;
  }
  return true;
}

function checkUuid(value: unknown, path: string, issues: ValidationIssue[], code = 'invalid-uuid'): value is string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    add(issues, code, path, '必须是 v4 形态小写 UUID');
    return false;
  }
  return true;
}

function checkStringArray(value: unknown, path: string, issues: ValidationIssue[]): value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    add(issues, 'invalid-type', path, '必须是字符串数组');
    return false;
  }
  return true;
}

function checkSha256Ref(value: unknown, path: string, issues: ValidationIssue[], code: string): value is string {
  if (typeof value !== 'string' || !SHA256_REF_RE.test(value)) {
    add(issues, code, path, '必须是 sha256:<lowercase-hex> 形态');
    return false;
  }
  return true;
}

function checkProject(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!checkKeys(value, PROJECT_KEYS, [], path, issues)) return;
  const project = value as { [key: string]: unknown };
  checkUuid(project['id'], `${path}/id`, issues, 'invalid-project-id');
  checkString(project['title'], `${path}/title`, issues);
  checkString(project['goal'], `${path}/goal`, issues);
  checkStringArray(project['constraints'], `${path}/constraints`, issues);
  const repositories = project['repositories'];
  if (!Array.isArray(repositories)) {
    add(issues, 'invalid-type', `${path}/repositories`, '必须是数组');
    return;
  }
  const seenRepoIds = new Set<string>();
  repositories.forEach((repo, index) => {
    const repoPath = `${path}/repositories/${index}`;
    if (!checkKeys(repo, REPOSITORY_KEYS, [], repoPath, issues)) return;
    const repoValue = repo as { [key: string]: unknown };
    const okId = checkUuid(repoValue['id'], `${repoPath}/id`, issues, 'invalid-repository-id');
    checkString(repoValue['label'], `${repoPath}/label`, issues);
    if (okId) {
      const id = repoValue['id'] as string;
      if (seenRepoIds.has(id)) {
        add(issues, 'duplicate-repository-id', `${repoPath}/id`, '仓库 id 重复');
      }
      seenRepoIds.add(id);
    }
  });
}

/** 结构校验（树、顺序、依赖），供文档校验与纯变换共用。 */
export function validatePlanStructure(plan: { nodes: WorkNode[]; dependencies: DependencyEdge[] }): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodes = plan.nodes;
  const nodeIds = new Set<string>();
  nodes.forEach((node, index) => {
    const nodePath = `/plan/nodes/${index}`;
    const okId = checkUuid(node.id, `${nodePath}/id`, issues);
    if (okId) {
      if (nodeIds.has(node.id as string)) {
        add(issues, 'duplicate-node-id', `${nodePath}/id`, '节点 id 重复');
      }
      nodeIds.add(node.id as string);
    }
    if (node.parentId !== null && (typeof node.parentId !== 'string' || !UUID_RE.test(node.parentId))) {
      add(issues, 'invalid-uuid', `${nodePath}/parentId`, 'parentId 必须是 null 或 v4 UUID');
    }
    if (typeof node.order !== 'number' || !Number.isSafeInteger(node.order) || node.order < 0) {
      add(issues, 'invalid-order', `${nodePath}/order`, 'order 必须是非负安全整数');
    }
    checkString(node.title, `${nodePath}/title`, issues);
    checkString(node.goal, `${nodePath}/goal`, issues);
    checkStringArray(node.completionCriteria, `${nodePath}/completionCriteria`, issues);
    if (!NODE_STATUSES.includes(node.status)) {
      add(issues, 'invalid-status', `${nodePath}/status`, 'status 必须是 todo/in-progress/blocked/done/canceled 之一');
    }
  });

  // 父节点存在 + 单根 + 父链无环（从每个节点向上走，重访即环）。
  const parentIdOf = new Map<string, string | null>();
  for (const node of nodes) {
    if (typeof node.id === 'string' && UUID_RE.test(node.id)) {
      parentIdOf.set(node.id, node.parentId);
    }
  }
  for (const [id, parentId] of parentIdOf) {
    if (parentId !== null) {
      if (!parentIdOf.has(parentId)) {
        add(issues, 'parent-not-found', `/plan/nodes`, `节点 ${id} 的父节点 ${parentId} 不存在`);
      }
    }
  }
  const rootIds = [...parentIdOf.entries()].filter(([, parent]) => parent === null).map(([id]) => id);
  // 协议向量（plan-zh-base）确认 v1 允许多根森林；仅拒绝父链环。
  if (rootIds.length === 0) {
    add(issues, 'root-count', '/plan/nodes', '至少需要一个根节点（parentId 为 null）');
  }
  for (const [startId] of parentIdOf) {
    const visited = new Set<string>();
    let cursor: string | null = startId;
    while (cursor !== null) {
      if (visited.has(cursor)) {
        add(issues, 'parent-cycle', '/plan/nodes', `父链存在环（经过 ${cursor}）`);
        break;
      }
      visited.add(cursor);
      cursor = parentIdOf.get(cursor) ?? null;
    }
  }

  // 同级 order 从 0 连续。
  const siblingsByParent = new Map<string | null, number[]>();
  for (const node of nodes) {
    if (typeof node.order !== 'number' || !Number.isSafeInteger(node.order) || node.order < 0) continue;
    const parentKey = node.parentId;
    const list = siblingsByParent.get(parentKey) ?? [];
    list.push(node.order);
    siblingsByParent.set(parentKey, list);
  }
  for (const [parent, orders] of siblingsByParent) {
    const sorted = [...orders].sort((a, b) => a - b);
    sorted.forEach((value, index) => {
      if (value !== index) {
        add(issues, 'sibling-order-gap', '/plan/nodes', `同级 order 必须从 0 连续（父节点 ${parent === null ? '<root>' : parent}）`);
      }
    });
  }

  // 依赖：两端存在、不自依赖、无重复、无环。
  const dependencies = plan.dependencies;
  const seenDeps = new Set<string>();
  dependencies.forEach((edge, index) => {
    const edgePath = `/plan/dependencies/${index}`;
    const okNode = checkUuid(edge.nodeId, `${edgePath}/nodeId`, issues);
    const okRequires = checkUuid(edge.requiresNodeId, `${edgePath}/requiresNodeId`, issues);
    if (okNode && okRequires) {
      if (edge.nodeId === edge.requiresNodeId) {
        add(issues, 'self-dependency', edgePath, '节点不能依赖自身');
      }
      if (!nodeIds.has(edge.nodeId)) {
        add(issues, 'dependency-node-not-found', `${edgePath}/nodeId`, `依赖的节点 ${edge.nodeId} 不存在`);
      }
      if (!nodeIds.has(edge.requiresNodeId)) {
        add(issues, 'dependency-node-not-found', `${edgePath}/requiresNodeId`, `被依赖的节点 ${edge.requiresNodeId} 不存在`);
      }
      const key = `${edge.nodeId}->${edge.requiresNodeId}`;
      if (seenDeps.has(key)) {
        add(issues, 'duplicate-dependency', edgePath, '同一有向依赖重复');
      }
      seenDeps.add(key);
    }
  });
  // 依赖环：三色 DFS。
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const edge of dependencies) {
    if (typeof edge.nodeId !== 'string' || typeof edge.requiresNodeId !== 'string') continue;
    const list = adjacency.get(edge.requiresNodeId) ?? [];
    list.push(edge.nodeId);
    adjacency.set(edge.requiresNodeId, list);
  }
  const reported = new Set<string>();
  const visit = (id: string, stack: string[]): void => {
    color.set(id, GRAY);
    for (const next of adjacency.get(id) ?? []) {
      if ((color.get(next) ?? WHITE) === GRAY && !reported.has(next)) {
        add(issues, 'dependency-cycle', '/plan/dependencies', `依赖存在环（经过 ${next}）`);
        reported.add(next);
      } else if ((color.get(next) ?? WHITE) === WHITE) {
        visit(next, [...stack, next]);
      }
    }
    color.set(id, BLACK);
  };
  for (const id of nodeIds) {
    if ((color.get(id) ?? WHITE) === WHITE) {
      visit(id, [id]);
    }
  }
  return issues;
}

function checkNodeShape(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!checkKeys(value, NODE_KEYS, [], path, issues)) return;
  const node = value as { [key: string]: unknown };
  checkUuid(node['id'], `${path}/id`, issues);
  if (node['parentId'] !== null) {
    checkUuid(node['parentId'], `${path}/parentId`, issues);
  }
  if (typeof node['order'] !== 'number' || !Number.isSafeInteger(node['order']) || node['order'] < 0) {
    add(issues, 'invalid-order', `${path}/order`, 'order 必须是非负安全整数');
  }
  checkString(node['title'], `${path}/title`, issues);
  checkString(node['goal'], `${path}/goal`, issues);
  checkStringArray(node['completionCriteria'], `${path}/completionCriteria`, issues);
  if (typeof node['status'] !== 'string' || !NODE_STATUSES.includes(node['status'] as WorkNode['status'])) {
    add(issues, 'invalid-status', `${path}/status`, 'status 必须是 todo/in-progress/blocked/done/canceled 之一');
  }
}

function checkRelativePath(value: unknown, path: string, issues: ValidationIssue[]): value is string {
  if (typeof value !== 'string') {
    add(issues, 'invalid-type', path, '必须是字符串');
    return false;
  }
  const segments = value.split('/');
  let bad = value === '' || value.includes('\\') || value.includes('\0');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      bad = true;
    }
  }
  if (bad) {
    add(issues, 'invalid-relative-path', path, 'relativePath 必须是 / 分段的相对路径，禁止 \\、空段、. 与 ..');
    return false;
  }
  return true;
}

function checkRecordEntry(
  entry: unknown,
  index: number,
  nodeIds: Set<string>,
  repositoryIds: Set<string>,
  issues: ValidationIssue[],
): void {
  const path = `/records/${index}`;
  if (!checkKeys(entry, RECORD_KEYS, RECORD_OPTIONAL_KEYS, path, issues)) return;
  const record = entry as { [key: string]: unknown };
  const okId = checkUuid(record['id'], `${path}/id`, issues, 'invalid-record-id');
  if (typeof record['kind'] !== 'string' || !RECORD_KINDS.includes(record['kind'] as RecordIndexEntry['kind'])) {
    add(issues, 'invalid-record-kind', `${path}/kind`, 'kind 必须是 plan-change/analysis-note/execution-note/verification 之一');
  }
  const subjectNodeIds = record['subjectNodeIds'];
  if (!Array.isArray(subjectNodeIds)) {
    add(issues, 'invalid-type', `${path}/subjectNodeIds`, '必须是数组');
  } else {
    subjectNodeIds.forEach((subjectId, subjectIndex) => {
      const subjectPath = `${path}/subjectNodeIds/${subjectIndex}`;
      const ok = checkUuid(subjectId, subjectPath, issues);
      if (ok && !nodeIds.has(subjectId as string)) {
        add(issues, 'subject-node-not-found', subjectPath, `引用的节点 ${subjectId} 不存在`);
      }
    });
  }
  checkString(record['summary'], `${path}/summary`, issues);

  // path 与 contentHash 一致：records/<recordId>/<hex64>.md。
  const okPath = checkString(record['path'], `${path}/path`, issues);
  let pathHex: string | null = null;
  if (okPath) {
    const match = RECORD_PATH_RE.exec(record['path'] as string);
    if (match === null) {
      add(issues, 'invalid-record-path', `${path}/path`, 'path 必须是 records/<recordId>/<64位小写hex>.md');
    } else {
      pathHex = match[2] ?? null;
      if (okId && match[1] !== record['id']) {
        add(issues, 'invalid-record-path', `${path}/path`, 'path 中的记录 id 与索引 id 不一致');
      }
    }
  }
  const okHash = checkSha256Ref(record['contentHash'], `${path}/contentHash`, issues, 'invalid-content-hash');
  if (okHash && pathHex !== null) {
    const hashHex = (record['contentHash'] as string).slice('sha256:'.length);
    if (hashHex !== pathHex) {
      add(issues, 'content-hash-path-mismatch', `${path}/contentHash`, 'contentHash 与 path 中携带的正文哈希不一致');
    }
  }

  // sources：公开记录 id 或仓库引用。
  const sources = record['sources'];
  if (!Array.isArray(sources)) {
    add(issues, 'invalid-type', `${path}/sources`, '必须是数组');
  } else {
    sources.forEach((source, sourceIndex) => {
      const sourcePath = `${path}/sources/${sourceIndex}`;
      if (typeof source === 'string') {
        const ok = checkUuid(source, sourcePath, issues, 'invalid-source-record-id');
        if (ok && okId && source === record['id']) {
          add(issues, 'self-source', sourcePath, '记录不能引用自身作为来源');
        }
      } else if (isRecord(source)) {
        if (!checkKeys(source, SOURCE_REF_KEYS, SOURCE_REF_OPTIONAL_KEYS, sourcePath, issues)) return;
        const ref = source as { [key: string]: unknown };
        const okRepo = checkUuid(ref['repositoryId'], `${sourcePath}/repositoryId`, issues, 'invalid-source-repository-id');
        if (okRepo && !repositoryIds.has(ref['repositoryId'] as string)) {
          add(issues, 'source-repository-not-found', `${sourcePath}/repositoryId`, `引用的仓库 ${ref['repositoryId']} 未在 project.repositories 声明`);
        }
        checkRelativePath(ref['relativePath'], `${sourcePath}/relativePath`, issues);
        if ('observedHash' in ref && ref['observedHash'] !== undefined) {
          checkSha256Ref(ref['observedHash'], `${sourcePath}/observedHash`, issues, 'invalid-observed-hash');
        }
      } else {
        add(issues, 'invalid-source', sourcePath, '来源必须是公开记录 id 或仓库引用对象');
      }
    });
  }

  // verification：仅 kind === 'verification' 携带。
  if ('verification' in record && record['verification'] !== undefined) {
    if (record['kind'] !== 'verification') {
      add(issues, 'invalid-verification', `${path}/verification`, '仅 kind=verification 的记录允许携带 verification');
      return;
    }
    const verification = record['verification'];
    if (!checkKeys(verification, VERIFICATION_KEYS, VERIFICATION_OPTIONAL_KEYS, `${path}/verification`, issues)) return;
    const block = verification as { [key: string]: unknown };
    if (typeof block['status'] !== 'string' || !VERIFICATION_STATUSES.includes(block['status'] as never)) {
      add(issues, 'invalid-verification', `${path}/verification/status`, 'status 必须是 pass/fail/blocked/untested 之一');
    }
    const subject = block['subject'];
    if (checkKeys(subject, SUBJECT_KEYS, [], `${path}/verification/subject`, issues)) {
      const subjectValue = subject as { [key: string]: unknown };
      const kind = subjectValue['kind'];
      if (kind !== 'node' && kind !== 'record') {
        add(issues, 'invalid-verification', `${path}/verification/subject/kind`, 'kind 必须是 node 或 record');
      }
      const okSubjectId = checkUuid(subjectValue['id'], `${path}/verification/subject/id`, issues);
      if (okSubjectId) {
        if (kind === 'node' && !nodeIds.has(subjectValue['id'] as string)) {
          add(issues, 'verification-subject-not-found', `${path}/verification/subject/id`, `受检节点 ${subjectValue['id']} 不存在`);
        }
        if (kind === 'record' && okId && subjectValue['id'] === record['id']) {
          add(issues, 'self-verification', `${path}/verification/subject/id`, '记录不能以自身为受检对象');
        }
      }
    }
    if ('subjectVersion' in block && block['subjectVersion'] !== undefined) {
      checkSha256Ref(block['subjectVersion'], `${path}/verification/subjectVersion`, issues, 'invalid-subject-version');
    }
    if ('scope' in block && block['scope'] !== undefined) {
      checkString(block['scope'], `${path}/verification/scope`, issues);
    }
  }
}

/** 校验完整文档。传入 sha256 时额外比对 planVersion 与重算指纹。 */
export function validateProjectDocument(value: unknown, options: { sha256?: Sha256Fn } = {}): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (!checkKeys(value, TOP_LEVEL_KEYS, [], '', issues)) {
    return { ok: false, issues };
  }
  const doc = value as { [key: string]: unknown };
  if (doc['schemaVersion'] !== 1 || typeof doc['schemaVersion'] !== 'number' || !Number.isSafeInteger(doc['schemaVersion'])) {
    add(issues, 'invalid-schema-version', '/schemaVersion', 'schemaVersion 必须是整数 1');
  }
  checkProject(doc['project'], '/project', issues);

  // plan：先核对形状，再做结构校验。
  if (!checkKeys(doc['plan'], PLAN_KEYS, [], '/plan', issues)) {
    return { ok: false, issues };
  }
  const plan = doc['plan'] as { [key: string]: unknown };
  if (!Array.isArray(plan['nodes'])) {
    add(issues, 'invalid-type', '/plan/nodes', '必须是数组');
    return { ok: false, issues };
  }
  if (!Array.isArray(plan['dependencies'])) {
    add(issues, 'invalid-type', '/plan/dependencies', '必须是数组');
    return { ok: false, issues };
  }
  plan['nodes'].forEach((node, index) => checkNodeShape(node, `/plan/nodes/${index}`, issues));
  plan['dependencies'].forEach((edge, index) => {
    if (!checkKeys(edge, DEPENDENCY_KEYS, [], `/plan/dependencies/${index}`, issues)) return;
    const edgeValue = edge as { [key: string]: unknown };
    checkUuid(edgeValue['nodeId'], `/plan/dependencies/${index}/nodeId`, issues);
    checkUuid(edgeValue['requiresNodeId'], `/plan/dependencies/${index}/requiresNodeId`, issues);
  });

  const candidate: ProjectDocument = doc as unknown as ProjectDocument;
  issues.push(...validatePlanStructure({ nodes: candidate.plan.nodes, dependencies: candidate.plan.dependencies }));

  const nodeIds = new Set(candidate.plan.nodes.map((node) => node.id));
  const repositoryIds = new Set(candidate.project.repositories.map((repo: RepositoryDecl) => repo.id));

  // records：id 唯一在最后核对；逐条形状与引用校验。
  if (!Array.isArray(doc['records'])) {
    add(issues, 'invalid-type', '/records', '必须是数组');
    return { ok: false, issues };
  }
  doc['records'].forEach((entry, index) => checkRecordEntry(entry, index, nodeIds, repositoryIds, issues));
  const seenRecordIds = new Set<string>();
  doc['records'].forEach((entry, index) => {
    const record = entry as { [key: string]: unknown };
    if (typeof record['id'] === 'string') {
      if (seenRecordIds.has(record['id'])) {
        add(issues, 'duplicate-record-id', `/records/${index}/id`, '记录 id 重复');
      }
      seenRecordIds.add(record['id']);
    }
  });
  // sources 引用的公开记录 id 必须存在于索引（前向引用也算存在）。
  const recordIds = new Set<string>();
  for (const entry of doc['records']) {
    const record = entry as { [key: string]: unknown };
    if (typeof record['id'] === 'string' && UUID_RE.test(record['id'])) {
      recordIds.add(record['id']);
    }
  }
  doc['records'].forEach((entry, index) => {
    const record = entry as { [key: string]: unknown };
    if (!Array.isArray(record['sources'])) return;
    record['sources'].forEach((source, sourceIndex) => {
      if (typeof source === 'string' && UUID_RE.test(source) && !recordIds.has(source)) {
        add(issues, 'source-record-not-found', `/records/${index}/sources/${sourceIndex}`, `引用的记录 ${source} 不在索引中`);
      }
      if (isRecord(source)) {
        const kind = record['kind'];
        const subject = record['verification'] as { subject?: { kind?: string; id?: string } } | undefined;
        void kind;
        void subject;
      }
    });
  });
  // kind='verification' 的受检对象若指向记录，记录必须存在。
  doc['records'].forEach((entry, index) => {
    const record = entry as { [key: string]: unknown };
    if (record['kind'] !== 'verification') return;
    const verification = record['verification'] as { subject?: { kind?: string; id?: string } } | undefined;
    const subject = verification?.subject;
    if (subject && subject.kind === 'record' && typeof subject.id === 'string' && !recordIds.has(subject.id)) {
      add(issues, 'verification-subject-not-found', `/records/${index}/verification/subject/id`, `受检记录 ${subject.id} 不在索引中`);
    }
  });

  // done 节点完成条件（1.4）：非空 criteria + 显式 pass 验证记录；不按子节点推导。
  const passVerifiedNodeIds = new Set<string>();
  for (const entry of doc['records']) {
    const record = entry as unknown as RecordIndexEntry;
    if (record.kind !== 'verification') continue;
    if (!record.verification || record.verification.status !== 'pass') continue;
    for (const nodeId of record.subjectNodeIds) {
      passVerifiedNodeIds.add(nodeId);
    }
  }
  for (const node of candidate.plan.nodes) {
    if (node.status !== 'done') continue;
    if (node.completionCriteria.length === 0) {
      add(issues, 'completion-no-criteria', `/plan/nodes/${node.id}/completionCriteria`, 'done 节点必须有非空完成条件');
    }
    if (!passVerifiedNodeIds.has(node.id)) {
      add(issues, 'completion-no-verification', `/plan/nodes/${node.id}`, 'done 节点必须存在 status=pass 且指向该节点的 verification 记录');
    }
  }

  // planVersion：格式 + （可选）与重算指纹等值。
  const okPlanVersion = checkSha256Ref(doc['planVersion'], '/planVersion', issues, 'invalid-plan-version-format');
  if (okPlanVersion && options.sha256) {
    const computed = computePlanVersion(candidate, options.sha256);
    if (computed.planVersion !== doc['planVersion']) {
      add(issues, 'plan-version-mismatch', '/planVersion', `自报指纹与重算值不一致（期望 ${computed.planVersion}）`);
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, doc: candidate };
}
