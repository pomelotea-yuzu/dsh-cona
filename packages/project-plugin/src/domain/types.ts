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
  /** v2 扩展（schemaVersion 2 必填；v1 文档不得出现）。 */
  roadmap?: Roadmap;
}

/** v2 交付引用：同项目节点，或哈希精确匹配的已发布成果记录。 */
export type MilestoneDelivery =
  | { kind: 'node'; refId: string }
  | { kind: 'record'; refId: string; contentHash: Sha256Ref };

/** v2 里程碑：以树中一个稳定节点及其自身完成条件为准，每节点至多一个。 */
export interface Milestone {
  nodeId: string;
  deliveries: MilestoneDelivery[];
}

/** 4.3 里程碑完成证据：一项完成条件对应一条已发布验证记录。 */
export interface MilestoneCompletionEvidence {
  /** 完成条件索引，从 0 开始连续；顺序即证据顺序。 */
  criterionIndex: number;
  /** 完成条件原文（逐字，用于发现条件被改动）。 */
  criterionText: string;
  /** 已发布验证记录 id（必须在本条完成记录之前）。 */
  recordId: string;
  /** 该验证记录的正文哈希。 */
  contentHash: string;
}

/** v2 路线图扩展：只含里程碑集合（可为空），不表达执行依赖或完成状态。 */
export interface Roadmap {
  milestones: Milestone[];
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
  | {
      ok: true;
      doc: ProjectDocument;
      /**
       * 非致命诊断（tasks 4.3）：形状合法但引用当前不可核对的已保存交付。
       * 资料仍可读取；命令层对“新增／改变”的引用另行强制核对。
       */
      diagnostics: ValidationIssue[];
    }
  | { ok: false; issues: ValidationIssue[] };

/** 纯变换结果：批量操作整体接受或整体拒绝。 */
export type TransformResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };
