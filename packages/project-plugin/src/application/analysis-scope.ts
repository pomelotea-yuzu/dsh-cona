// 分析范围服务（tasks 3.1-3.5）：把实例的仓库映射、只读枚举、观察指纹、
// 限额、范围内读取与引用复核编排在一起。不接触 DSH 宿主，也不写文件。
//
// 信任边界：选择只由 Host 用 owner 确认的 instanceId/repositoryId/范围建立；
// 冻结的 mappingHash 由实例身份与映射当前 realpath 决定，路径或实例变化即失效。
// 读取凭证只按实际交付的文本片段生成；目录列举不产生凭证。

import {
  fingerprintObservation,
  isObservationComplete,
  resolveAnalysisLimits,
  scopeContainsPath,
  sliceText,
  textLineCount,
  type AnalysisLimits,
  type ObservationEntry,
  type ObservationExclusion,
  type ObservationIssue,
  type ReadBudget,
  type ScopeSelection,
} from '../domain/analysis.js';
import type { Sha256Fn } from '../domain/types.js';
import type { AnalysisEnumeration, AnalysisFileBytesResult, AnalysisFilesPort } from './ports.js';

/** 实例登记的本机仓库映射（只取分析需要的字段）。 */
export interface AnalysisRepositoryMapping {
  readonly repositoryId: string;
  readonly absolutePath: string;
  readonly updatedAt?: string;
}

/** 概览可选仓库：不可用映射保留并给出原因，不猜替代路径。 */
export interface AnalysisRepositoryView {
  readonly repositoryId: string;
  readonly absolutePath: string;
  readonly updatedAt?: string;
  readonly status: 'available' | 'unavailable';
  readonly reason?: string;
  readonly message?: string;
  readonly head?: string;
}

/** owner 确认后冻结的分析选择：实例、仓库、映射身份与范围。 */
export interface AnalysisSelection {
  readonly instanceId: string;
  readonly repositoryId: string;
  /** 映射当前 realpath；不是用户书写路径。 */
  readonly repositoryRoot: string;
  readonly mappingUpdatedAt?: string;
  readonly sourceGeneration: number;
  readonly mappingHash: string;
  readonly scope: ScopeSelection;
  readonly frozenAt: string;
}

export interface AnalysisObservation {
  readonly selection: AnalysisSelection;
  readonly entries: readonly ObservationEntry[];
  readonly exclusions: readonly ObservationExclusion[];
  readonly issues: readonly ObservationIssue[];
  readonly truncated: boolean;
  readonly complete: boolean;
  readonly fingerprint: string;
  readonly observedAt: string;
  readonly git: AnalysisEnumeration['git'];
  readonly limits: AnalysisLimits;
}

export type AnalysisPreviewResult =
  | ({ readonly status: 'ok' } & AnalysisObservation & { readonly repository: AnalysisRepositoryView })
  | { readonly status: 'rejected'; readonly code: string; readonly message: string };

export type AnalysisObservationResult =
  | ({ readonly status: 'ok' } & AnalysisObservation)
  | { readonly status: 'rejected'; readonly code: string; readonly message: string };

/** 一次实际交付形成的文件读取凭证；line 从 1 起、含首尾。 */
export interface FileReadCredential {
  readonly path: string;
  /** 读取时整份文件的字节哈希。 */
  readonly fullHash: string;
  /** 实际交付文本片段的哈希。 */
  readonly deliveredHash: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly deliveredBytes: number;
  /** 读取时整份文件的行数；用于判断是否完整读过。 */
  readonly totalLines: number;
  readonly truncated: boolean;
}

export type AnalysisReadResult =
  | {
      readonly status: 'ok';
      readonly text: string;
      readonly credential: FileReadCredential;
      readonly truncated: boolean;
      readonly reason?: 'lines' | 'bytes';
    }
  | { readonly status: 'rejected'; readonly code: string; readonly message: string };

/** 引用复核结论：不自动用当前内容替代历史凭证。 */
export type AnalysisCitationResult =
  | { readonly status: 'current' }
  | { readonly status: 'content-changed'; readonly currentHash: string }
  | { readonly status: 'missing' }
  | { readonly status: 'inaccessible'; readonly code: string; readonly message: string }
  | { readonly status: 'outside-scope' }
  | { readonly status: 'mapping-changed'; readonly reason: string };

export interface AnalysisScopeServiceDeps {
  readonly instanceId: string;
  readonly sourceGeneration: number;
  /**
   * 读取实例当前登记的全部仓库映射；按 repositoryId 使用，不跨实例查找。
   * 用函数而不是快照：登记映射可能在本机状态更新，Host 每次请求都取当前值。
   */
  readonly repositories: () => Promise<readonly AnalysisRepositoryMapping[]>;
  readonly files: AnalysisFilesPort;
  readonly sha256: Sha256Fn;
  readonly clock: () => string;
  readonly limits?: Partial<AnalysisLimits>;
}

/**
 * 每实例一个的分析范围服务。所有方法只读；read 需要调用方持有的 ReadBudget，
 * 由分析运行负责「一轮分析总读取上限」的跨调用累计。
 */
export class AnalysisScopeService {
  readonly limits: AnalysisLimits;
  private readonly deps: AnalysisScopeServiceDeps;

  constructor(deps: AnalysisScopeServiceDeps) {
    this.deps = deps;
    this.limits = resolveAnalysisLimits(deps.limits);
  }

  /** 列出可选逻辑仓库；不可用映射保留原因。顺序按 repositoryId 稳定。 */
  async listRepositories(): Promise<readonly AnalysisRepositoryView[]> {
    const views: AnalysisRepositoryView[] = [];
    for (const map of [...(await this.deps.repositories())].sort((left, right) =>
      left.repositoryId < right.repositoryId ? -1 : left.repositoryId > right.repositoryId ? 1 : 0)) {
      const inspected = await this.deps.files.inspectRepository(map.absolutePath);
      views.push(inspected.ok
        ? {
            repositoryId: map.repositoryId,
            absolutePath: inspected.root,
            ...(map.updatedAt === undefined ? {} : { updatedAt: map.updatedAt }),
            status: 'available',
            ...(inspected.git?.head === undefined ? {} : { head: inspected.git.head }),
          }
        : {
            repositoryId: map.repositoryId,
            absolutePath: map.absolutePath,
            ...(map.updatedAt === undefined ? {} : { updatedAt: map.updatedAt }),
            status: 'unavailable',
            reason: inspected.code,
            message: inspected.message,
          });
    }
    return views;
  }

  /**
   * 预览范围并冻结选择。先核对仓库映射当前可读，再枚举并计算指纹。
   * 冻结的映射身份只由 instanceId/repositoryId/realpath 决定，不以 updatedAt 变化误判。
   */
  async preview(request: { readonly repositoryId: string; readonly scope: ScopeSelection }): Promise<AnalysisPreviewResult> {
    const map = await this.findMap(request.repositoryId);
    if (map === undefined) {
      return { status: 'rejected', code: 'analysis-repository-missing', message: `实例没有仓库映射 ${request.repositoryId}` };
    }
    const inspected = await this.deps.files.inspectRepository(map.absolutePath);
    if (!inspected.ok) {
      return { status: 'rejected', code: inspected.code, message: inspected.message };
    }
    const enumerated = await this.deps.files.enumerate(inspected.root, request.scope, this.limits);
    if (!enumerated.ok) {
      return { status: 'rejected', code: enumerated.code, message: enumerated.message };
    }
    const selection: AnalysisSelection = {
      instanceId: this.deps.instanceId,
      repositoryId: map.repositoryId,
      repositoryRoot: inspected.root,
      ...(map.updatedAt === undefined ? {} : { mappingUpdatedAt: map.updatedAt }),
      sourceGeneration: this.deps.sourceGeneration,
      mappingHash: this.mappingHash(map.repositoryId, inspected.root),
      scope: request.scope,
      frozenAt: this.deps.clock(),
    };
    return {
      status: 'ok',
      ...this.observation(selection, enumerated.value),
      repository: {
        repositoryId: map.repositoryId,
        absolutePath: inspected.root,
        ...(map.updatedAt === undefined ? {} : { updatedAt: map.updatedAt }),
        status: 'available',
        ...(inspected.git?.head === undefined ? {} : { head: inspected.git.head }),
      },
    };
  }

  /** 按已冻结选择重新观察；映射/仓库根变化时拒绝，不静默切换来源。 */
  async observe(selection: AnalysisSelection): Promise<AnalysisObservationResult> {
    const checked = await this.checkSelection(selection);
    if (!checked.ok) return { status: 'rejected', code: checked.code, message: checked.message };
    const enumerated = await this.deps.files.enumerate(checked.repositoryRoot, selection.scope, this.limits);
    if (!enumerated.ok) return { status: 'rejected', code: enumerated.code, message: enumerated.message };
    return { status: 'ok', ...this.observation(selection, enumerated.value) };
  }

  /**
   * 读取范围内文件并按实际交付片段发凭证。只按整行交付；截断时凭证只覆盖
   * 实际交付的行。目录、范围外路径、超限或读取期间变化都拒绝。
   */
  async read(
    selection: AnalysisSelection,
    request: {
      readonly path: string;
      readonly startLine?: number;
      readonly maxLines?: number;
      readonly budget: ReadBudget;
    },
  ): Promise<AnalysisReadResult> {
    const checked = await this.checkSelection(selection);
    if (!checked.ok) return { status: 'rejected', code: checked.code, message: checked.message };
    if (!scopeContainsPath(selection.scope, request.path)) {
      return { status: 'rejected', code: 'analysis-scope-outside', message: '文件不在所选范围内' };
    }
    const remaining = Math.min(this.limits.readBytes, request.budget.remaining);
    if (remaining < 1) {
      return { status: 'rejected', code: 'analysis-read-budget-exhausted', message: '本轮分析读取额度已用尽' };
    }
    const read: AnalysisFileBytesResult = await this.deps.files.readBytes(checked.repositoryRoot, request.path, this.limits);
    if (!read.ok) return { status: 'rejected', code: read.code, message: read.message };
    const decoded = this.deps.files.decodeText(read.value.bytes);
    if (!decoded.ok) return { status: 'rejected', code: decoded.code, message: decoded.message };

    const sliced = sliceText(decoded.text, {
      ...(request.startLine === undefined ? {} : { startLine: request.startLine }),
      maxLines: Math.min(request.maxLines ?? this.limits.readLines, this.limits.readLines),
      maxBytes: remaining,
      fullFile: request.startLine === undefined && request.maxLines === undefined,
    });
    if (!sliced.ok) return { status: 'rejected', code: sliced.code, message: sliced.message };

    request.budget.consume(sliced.slice.bytes);
    const credential: FileReadCredential = {
      path: request.path,
      fullHash: read.value.fullHash,
      deliveredHash: this.deps.sha256(new TextEncoder().encode(sliced.slice.text)),
      startLine: sliced.slice.startLine,
      endLine: sliced.slice.endLine,
      deliveredBytes: sliced.slice.bytes,
      totalLines: textLineCount(decoded.text),
      truncated: sliced.slice.truncated,
    };
    return {
      status: 'ok',
      text: sliced.slice.text,
      credential,
      truncated: sliced.slice.truncated,
      ...(sliced.slice.reason === undefined ? {} : { reason: sliced.slice.reason }),
    };
  }

  /**
   * 复核一条历史引用：先核对映射身份，再按当前文件整份哈希判断。
   * 内容变化只返回历史状态，调用方不得把当前正文当作原引用。
   */
  async verifyCitation(selection: AnalysisSelection, credential: FileReadCredential): Promise<AnalysisCitationResult> {
    const checked = await this.checkSelection(selection);
    if (!checked.ok) return { status: 'mapping-changed', reason: checked.code };
    if (!scopeContainsPath(selection.scope, credential.path)) return { status: 'outside-scope' };
    const read = await this.deps.files.readBytes(checked.repositoryRoot, credential.path, this.limits);
    if (!read.ok) {
      if (read.code === 'scope-not-found') return { status: 'missing' };
      return { status: 'inaccessible', code: read.code, message: read.message };
    }
    if (read.value.fullHash !== credential.fullHash) {
      return { status: 'content-changed', currentHash: read.value.fullHash };
    }
    return { status: 'current' };
  }

  private async findMap(repositoryId: string): Promise<AnalysisRepositoryMapping | undefined> {
    const repositories = await this.deps.repositories();
    return repositories.find((map) => map.repositoryId === repositoryId);
  }

  private mappingHash(repositoryId: string, absolutePath: string): string {
    return this.deps.sha256(new TextEncoder().encode(JSON.stringify([this.deps.instanceId, repositoryId, absolutePath])));
  }

  private async checkSelection(selection: AnalysisSelection): Promise<
    | { readonly ok: true; readonly repositoryRoot: string }
    | { readonly ok: false; readonly code: string; readonly message: string }
  > {
    if (selection.instanceId !== this.deps.instanceId) {
      return { ok: false, code: 'analysis-instance-mismatch', message: '分析选择不属于当前实例' };
    }
    if (selection.sourceGeneration !== this.deps.sourceGeneration) {
      return { ok: false, code: 'analysis-source-changed', message: '资料源代际已变化，需重新预览' };
    }
    const map = await this.findMap(selection.repositoryId);
    if (map === undefined) {
      return { ok: false, code: 'analysis-mapping-changed', message: '仓库映射已被移除，需重新预览' };
    }
    const inspected = await this.deps.files.inspectRepository(map.absolutePath);
    if (!inspected.ok) {
      return { ok: false, code: 'analysis-mapping-changed', message: `仓库映射当前不可用：${inspected.message}` };
    }
    if (inspected.root !== selection.repositoryRoot
      || this.mappingHash(map.repositoryId, inspected.root) !== selection.mappingHash) {
      return { ok: false, code: 'analysis-mapping-changed', message: '仓库映射指向已变化，需重新预览' };
    }
    return { ok: true, repositoryRoot: inspected.root };
  }

  private observation(selection: AnalysisSelection, enumerated: AnalysisEnumeration): AnalysisObservation {
    const complete = isObservationComplete(enumerated);
    return {
      selection,
      entries: enumerated.entries,
      exclusions: enumerated.exclusions,
      issues: enumerated.issues,
      truncated: enumerated.truncated,
      complete,
      fingerprint: fingerprintObservation(enumerated.entries, this.deps.sha256),
      observedAt: this.deps.clock(),
      git: enumerated.git,
      limits: this.limits,
    };
  }
}
