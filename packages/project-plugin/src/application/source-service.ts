// 资料位置与基础接入（tasks 3.1）：选择位置、预览实际路径、创建或接入同一公开格式。
// 边界：本文件不登记本机实例（注册表与单实例聚合在 3.2）、不写回执、不执行 Git 写操作。
// 命令封套（幂等、回执、双修订）在 3.4；此处只提供文件层原语，供后续命令层复用。

import { computePlanVersion } from '../domain/canonical/plan-fingerprint.js';
import type { ProjectDocument } from '../domain/types.js';
import { planLocation } from './location.js';
import type {
  GitStateView,
  LocationKind,
  LocationRequest,
  LocationView,
  RootInspection,
  SourceServiceDeps,
} from './ports.js';

export interface SourceIssue {
  code: string;
  message: string;
  /** 可选定位线索：资料根或相对文件，不含机器私有状态。 */
  path?: string;
}

export interface SourcePreviewResult {
  ok: true;
  location: LocationView;
  inspection: RootInspection;
  /** 根尚不存在时无从判断，返回 null 而不是伪造 “未跟踪”。 */
  git: GitStateView | null;
}

export interface SourceCreateResult {
  ok: true;
  location: LocationView;
  project: { id: string; title: string };
  nodeIds: string[];
  planVersion: string;
  created: string[];
  git: GitStateView | null;
}

export interface SourceAttachResult {
  ok: true;
  location: LocationView;
  project: { id: string; title: string };
  nodeIds: string[];
  planVersion: string;
  recordCount: number;
  git: GitStateView | null;
  /** 本机实例登记尚未持久化（3.2）；接入只读取公开资料，不导入旧授权或回执。 */
  instance: { projectId: string; root: string; registry: 'pending-3.2' };
}

export interface SourceCreateRequest extends LocationRequest {
  /** 未指定时由 deps.newProjectId 生成；接入既有资料不得改写项目 id。 */
  projectId?: string;
  /** 初始根节点 id；未指定时由 deps.newNodeId 生成（命令层可据此保持幂等）。 */
  rootNodeId?: string;
  title: string;
  goal?: string;
  constraints?: string[];
}

/** 随包格式资源相对资料根的落点（与 formats/v1 的协议约定一致）。 */
const FORMAT_ASSETS = ['README.md', 'project.json', 'schema/project-v1.schema.json', 'protocol/plan-canonicalization.md', 'protocol/plan-vectors.json', 'records/'];

export class SourceService {
  constructor(private readonly deps: SourceServiceDeps) {}

  /** 预览实际位置与现有内容；不创建目录、不写文件。 */
  async preview(request: LocationRequest & { projectId?: string }): Promise<SourcePreviewResult | { ok: false; issues: SourceIssue[] }> {
    const planned = planLocation(request, request.projectId);
    if (!planned.ok) return { ok: false, issues: planned.issues };
    const resolved = this.deps.location.resolve(planned.plan);
    if (!resolved.ok) return { ok: false, issues: resolved.issues };
    const { location } = resolved;
    const inspection = await this.deps.files.inspect(location.root);
    return {
      ok: true,
      location,
      inspection,
      git: inspection.exists && inspection.isDirectory ? this.deps.git.read(location.root) : null,
    };
  }

  /**
   * 创建同格式资料根：拒绝覆盖非空目标与已有 project.json，避免把别人的资料当成新项目。
   * 空目录或不存在目录才允许创建；本项目不自动执行 Git 提交。
   */
  async create(request: SourceCreateRequest): Promise<SourceCreateResult | { ok: false; issues: SourceIssue[] }> {
    const issues: SourceIssue[] = [];
    if (typeof request.title !== 'string' || request.title.trim() === '') {
      issues.push({ code: 'source-title-required', message: '创建项目需要非空标题' });
    }
    const projectId = request.projectId ?? this.deps.newProjectId();
    const planned = planLocation(request, projectId);
    if (!planned.ok) return { ok: false, issues: planned.issues };
    const resolved = this.deps.location.resolve(planned.plan);
    if (!resolved.ok) return { ok: false, issues: resolved.issues };
    const { location } = resolved;

    const inspection = await this.deps.files.inspect(location.root);
    if (inspection.exists && !inspection.isDirectory) {
      return {
        ok: false,
        issues: [{ code: 'source-root-not-directory', message: '目标已存在但不是目录，拒绝写入', path: location.root }],
      };
    }
    if (inspection.exists && (inspection.hasProjectJson || inspection.entries.length > 0)) {
      return {
        ok: false,
        issues: [
          {
            code: 'source-not-empty',
            message: `目标已有内容，拒绝覆盖（${inspection.entries.slice(0, 5).join(', ')}${inspection.entries.length > 5 ? ' …' : ''}）；请另选位置或改用接入`,
            path: location.root,
          },
        ],
      };
    }
    if (issues.length > 0) return { ok: false, issues };

    const doc = this.initialProject(
      projectId,
      request.title,
      request.goal ?? '',
      request.constraints ?? [],
      request.rootNodeId ?? this.deps.newNodeId(),
    );
    await this.deps.files.copyFormatAssets(location.root);
    const written = await this.deps.files.writeDocument(location.root, doc);
    if (!written.ok) {
      return {
        ok: false,
        issues: written.issues.map((issue) => ({
          code: issue.code,
          message: issue.message ?? '写入公开资料失败',
          path: issue.path,
        })),
      };
    }
    // 回读核对：写入成功不等于资料可读，身份与指纹必须与刚写入的一致。
    const reread = await this.deps.files.readDocument(location.root);
    if (!reread.ok) {
      return {
        ok: false,
        issues: reread.issues.map((issue) => ({
          code: issue.code,
          message: issue.message ?? '回读公开资料失败',
          path: issue.path,
        })),
      };
    }
    if (reread.doc.project.id !== doc.project.id || reread.doc.planVersion !== doc.planVersion) {
      return {
        ok: false,
        issues: [{ code: 'source-reread-mismatch', message: '回读的项目身份或规划指纹与写入值不一致', path: location.root }],
      };
    }

    return {
      ok: true,
      location,
      project: { id: doc.project.id, title: doc.project.title },
      nodeIds: doc.plan.nodes.map((node) => node.id),
      planVersion: doc.planVersion,
      created: FORMAT_ASSETS,
      git: this.deps.git.read(location.root),
    };
  }

  /**
   * 接入既有公开资料：沿用原项目／节点 id，不重建项目、不要求原数据库，
   * 也不导入原机器的授权或回执（本机实例与回执登记在 3.2／3.4）。
   */
  async attach(root: string, kind?: LocationKind): Promise<SourceAttachResult | { ok: false; issues: SourceIssue[] }> {
    const inspection = await this.deps.files.inspect(root);
    if (!inspection.exists) {
      return { ok: false, issues: [{ code: 'source-not-found', message: '资料根不存在', path: root }] };
    }
    if (!inspection.isDirectory) {
      return { ok: false, issues: [{ code: 'source-root-not-directory', message: '资料根不是目录', path: root }] };
    }
    if (!inspection.hasProjectJson) {
      return {
        ok: false,
        issues: [{ code: 'source-missing-project-file', message: '资料根缺少 project.json，无法接入', path: root }],
      };
    }
    const read = await this.deps.files.readDocument(root);
    if (!read.ok) {
      return {
        ok: false,
        issues: read.issues.map((issue) => ({
          code: issue.code,
          message: issue.message ?? '公开资料校验失败',
          path: issue.path,
        })),
      };
    }
    const location: LocationView = this.deps.location.describe(root);
    if (kind !== undefined) location.kind = kind;
    return {
      ok: true,
      location,
      project: { id: read.doc.project.id, title: read.doc.project.title },
      nodeIds: read.doc.plan.nodes.map((node) => node.id),
      planVersion: read.doc.planVersion,
      recordCount: read.doc.records.length,
      git: this.deps.git.read(root),
      instance: { projectId: read.doc.project.id, root, registry: 'pending-3.2' },
    };
  }

  /**
   * 初始规划：只有不存在权威头时才允许创建（design §5 空规划哨兵）。
   * v1 校验要求至少一个根节点，故创建即生成项目根节点；它承载项目目标，
   * 不是“推导出的完成状态”，后续拆分保留其 id。
   */
  private initialProject(
    projectId: string,
    title: string,
    goal: string,
    constraints: string[],
    rootNodeId: string,
  ): ProjectDocument {
    const draft: ProjectDocument = {
      schemaVersion: 1,
      project: { id: projectId, title, goal, constraints: [...constraints], repositories: [] },
      plan: {
        nodes: [
          {
            id: rootNodeId,
            parentId: null,
            order: 0,
            title,
            goal,
            completionCriteria: [],
            status: 'todo',
          },
        ],
        dependencies: [],
      },
      planVersion: '',
      records: [],
    };
    draft.planVersion = computePlanVersion(draft, this.deps.sha256).planVersion;
    return draft;
  }
}
