// v1 公开资料格式的领域类型（design §3）。
// 本文件属于 src/domain：不依赖 Node、React、Cordis；内容哈希通过 Sha256Fn 注入。

/** SHA-256 散列函数端口：输入字节，返回小写 hex（不带 `sha256:` 前缀）。由宿主适配器注入。 */
export type Sha256Fn = (bytes: Uint8Array) => string;

/** `sha256:<lowercase-hex>` 形态的版本标识（planVersion、contentHash、observedHash）。 */
export type Sha256Ref = string;

export type NodeStatus = 'todo' | 'in-progress' | 'blocked' | 'done' | 'canceled';

export const NODE_STATUSES: readonly NodeStatus[] = ['todo', 'in-progress', 'blocked', 'done', 'canceled'];

export type RecordKind = 'plan-change' | 'analysis-note' | 'execution-note' | 'verification';

export const RECORD_KINDS: readonly RecordKind[] = ['plan-change', 'analysis-note', 'execution-note', 'verification'];

export type VerificationStatus = 'pass' | 'fail' | 'blocked' | 'untested';

export const VERIFICATION_STATUSES: readonly VerificationStatus[] = ['pass', 'fail', 'blocked', 'untested'];

export interface RepositoryDecl {
  id: string;
  label: string;
}

export interface WorkNode {
  id: string;
  parentId: string | null;
  order: number;
  title: string;
  goal: string;
  completionCriteria: string[];
  status: NodeStatus;
}

export interface DependencyEdge {
  nodeId: string;
  requiresNodeId: string;
}

export interface Plan {
  nodes: WorkNode[];
  dependencies: DependencyEdge[];
}

export interface ProjectMeta {
  id: string;
  title: string;
  goal: string;
  constraints: string[];
  repositories: RepositoryDecl[];
}

/** 记录来源：公开记录 id（字符串）或仓库相对路径引用。 */
export type RecordSource = string | RecordSourceRef;

export interface RecordSourceRef {
  repositoryId: string;
  relativePath: string;
  observedHash?: string;
}

export interface VerificationSubject {
  kind: 'node' | 'record';
  id: string;
}

export interface VerificationBlock {
  status: VerificationStatus;
  subject: VerificationSubject;
  /** 受检时版本（节点为 planVersion、记录为 contentHash，形态 `sha256:<hex>`）。 */
  subjectVersion?: string;
  /** 受检范围说明。 */
  scope?: string;
}

export interface RecordIndexEntry {
  id: string;
  kind: RecordKind;
  subjectNodeIds: string[];
  /** `records/<recordId>/<contentHash-hex>.md`。 */
  path: string;
  /** `sha256:<hex>`，覆盖正文实际字节。 */
  contentHash: string;
  summary: string;
  sources: RecordSource[];
  /** 仅 kind === 'verification' 时允许。 */
  verification?: VerificationBlock;
}

export interface ProjectDocument {
  schemaVersion: number;
  project: ProjectMeta;
  plan: Plan;
  planVersion: string;
  records: RecordIndexEntry[];
}

/** 领域校验问题：code 稳定、path 为 JSON Pointer 风格。 */
export interface ValidationIssue {
  code: string;
  path: string;
  message?: string;
}

export type ValidationResult =
  | { ok: true; doc: ProjectDocument }
  | { ok: false; issues: ValidationIssue[] };

/** 纯变换结果：批量操作整体接受或整体拒绝。 */
export type TransformResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };
