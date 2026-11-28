// 分析依据状态（tasks 6.1-6.2）：保存时冻结起始依据，提交与回看都在当前来源上
// 重算「依据是否仍当前」。确认变化与无法核对分开表达；范围外变化与未被引用的
// 追加记录不影响依据。本文件不写文件、不依赖 DSH 宿主。
//
// 信任边界：报告只按自己保存的起始快照判断；不拿当前内容替代历史凭证，也不把
// 「无法核对」当成「当前」。

import type { ObservationEntry } from '../domain/analysis.js';
import type { ProjectDocument } from '../domain/types.js';
import type {
  AnalysisObservationSnapshot,
  AnalysisRecord,
  AnalysisReportRecord,
  ReportBasisChange,
  ReportBasisSnapshot,
  ReportBasisStatus,
  ReportCitation,
} from './local-state.js';
import type {
  AnalysisObservation,
  AnalysisObservationResult,
  AnalysisScopeService,
  AnalysisSelection,
  FileReadCredential,
} from './analysis-scope.js';
import type { AnalysisVerificationService, VerificationIndexEntry } from './analysis-verification.js';

export interface AnalysisBasisDeps {
  readonly scope: AnalysisScopeService;
  readonly verification: AnalysisVerificationService;
  readonly baseline: () => Promise<
    { readonly ok: true; readonly doc: ProjectDocument } | { readonly ok: false; readonly code: string; readonly message: string }
  >;
  readonly clock: () => string;
}

/** 起始观察逐条内容快照；报告依据只比较路径与内容指纹。 */
export function observationContentsOf(entries: readonly ObservationEntry[]): AnalysisObservationSnapshot[] {
  return entries.map((entry) => ({ path: entry.path, kind: 'file' as const, hash: entry.hash }));
}

/** 从本机分析记录冻结报告依据；旧记录没有逐条快照时 entries 为空。 */
export function basisSnapshotOf(record: AnalysisRecord): ReportBasisSnapshot {
  return {
    instanceId: record.instanceId,
    repositoryId: record.repositoryId,
    repositoryRoot: record.repositoryRoot,
    mappingHash: record.mappingHash,
    sourceGeneration: record.sourceGeneration,
    planVersion: record.planVersion,
    planRevision: record.planRevision,
    scope: record.scope,
    fingerprint: record.observation.fingerprint,
    complete: record.observation.complete,
    issues: record.observation.issues,
    entries: record.observation.contents ?? [],
    ...(record.observation.git === undefined ? {} : { git: record.observation.git }),
  };
}

/**
 * 依据快照 → 范围服务使用的冻结选择。`frozenAt` 只作视图字段；
 * 身份核对由 scope.checkSelection 按实例、代际与映射 realpath 完成。
 */
export function selectionOfBasis(basis: ReportBasisSnapshot, frozenAt = ''): AnalysisSelection {
  return {
    instanceId: basis.instanceId,
    repositoryId: basis.repositoryId,
    repositoryRoot: basis.repositoryRoot,
    mappingHash: basis.mappingHash,
    sourceGeneration: basis.sourceGeneration,
    scope: basis.scope,
    frozenAt,
  };
}

export interface ObservationDiff {
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  /** 任一侧没有内容指纹（超限或不可读），不能判定。 */
  readonly uncomparable: readonly string[];
}

/**
 * 比较起始快照与当前观察。当前观察不完整时只确认「看见的新增／修改」，
 * 不把可能因截断或读失败而缺失的路径判成删除。
 */
export function compareObservationContents(
  basis: readonly AnalysisObservationSnapshot[],
  current: readonly ObservationEntry[],
  options: { readonly currentComplete: boolean },
): ObservationDiff {
  const before = new Map(basis.map((entry) => [entry.path, entry.hash]));
  const after = new Map(current.map((entry) => [entry.path, entry.hash]));
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const uncomparable: string[] = [];
  for (const entry of current) {
    if (!before.has(entry.path)) {
      added.push(entry.path);
      continue;
    }
    const previous = before.get(entry.path) ?? null;
    if (previous === null || entry.hash === null) {
      if (previous !== entry.hash) uncomparable.push(entry.path);
      continue;
    }
    if (previous !== entry.hash) modified.push(entry.path);
  }
  if (options.currentComplete) {
    for (const entry of basis) {
      if (!after.has(entry.path)) deleted.push(entry.path);
    }
  }
  return {
    added: added.sort(),
    modified: modified.sort(),
    deleted: deleted.sort(),
    uncomparable: uncomparable.sort(),
  };
}

/** 收集报告全部引用（事实里的文件／验证记录／规划）。 */
export function citationsOf(report: AnalysisReportRecord): ReportCitation[] {
  return report.facts.flatMap((fact) => [...fact.citations]);
}

/**
 * 依据状态服务：保存与回看共用同一判定；保存时传入已经取得的观察结果，
 * 回看时重新观察。一个实例一个服务。
 */
export class AnalysisBasisService {
  constructor(private readonly deps: AnalysisBasisDeps) {}

  /** 回看：按报告自己的起始依据与当前来源重算；旧报告无 basis 时从记录重建。 */
  async evaluateReport(report: AnalysisReportRecord, record?: AnalysisRecord): Promise<ReportBasisStatus> {
    const saved = usableBasis(report.basis) ? report.basis : undefined;
    const basis = saved ?? (record === undefined ? null : basisSnapshotOf(record));
    if (basis === null) {
      return this.status('uncheckable', [{ kind: 'basis-missing', detail: '报告没有可核对的起始依据快照' }], undefined, undefined);
    }
    const observed = await this.deps.scope.observe(selectionOfBasis(basis, report.createdAt));
    return this.evaluate({ basis, citations: citationsOf(report), observed });
  }

  /**
   * 判定依据：先核对源代际与映射，再比较范围内观察、规划与已引用凭证。
   * 当前观察不完整时删除类变化不成立；只有确认变化才算 changed。
   */
  async evaluate(input: {
    readonly basis: ReportBasisSnapshot;
    readonly citations: readonly ReportCitation[];
    readonly observed: AnalysisObservationResult;
  }): Promise<ReportBasisStatus> {
    const { basis, citations, observed } = input;
    const confirmed: ReportBasisChange[] = [];
    const gaps: ReportBasisChange[] = [];
    const selection = selectionOfBasis(basis);
    let currentObservation: AnalysisObservation | null = null;

    if (observed.status === 'rejected') {
      if (observed.code === 'analysis-source-changed') {
        confirmed.push({ kind: 'source-generation', detail: observed.message });
      } else if (observed.code === 'analysis-mapping-changed' || observed.code === 'analysis-instance-mismatch') {
        confirmed.push({ kind: 'mapping', detail: observed.message });
      } else {
        gaps.push({ kind: 'observation-gap', detail: `${observed.code}: ${observed.message}` });
      }
    } else {
      currentObservation = observed;
      if (basis.entries.length > 0) {
        const diff = compareObservationContents(basis.entries, observed.entries, { currentComplete: observed.complete });
        if (diff.added.length > 0) confirmed.push({ kind: 'files-added', paths: diff.added });
        if (diff.modified.length > 0) confirmed.push({ kind: 'files-modified', paths: diff.modified });
        if (diff.deleted.length > 0) confirmed.push({ kind: 'files-deleted', paths: diff.deleted });
        if (diff.uncomparable.length > 0) {
          gaps.push({ kind: 'observation-gap', paths: diff.uncomparable, detail: '部分条目没有可比的内容指纹' });
        }
      } else if (observed.fingerprint !== basis.fingerprint) {
        confirmed.push({ kind: 'observation-fingerprint', detail: '起始记录没有逐条快照，只能确认范围指纹已变化' });
      }
      if (!observed.complete) {
        gaps.push({
          kind: 'observation-gap',
          detail: observed.truncated ? '范围枚举被截断，未观察到的路径不判为删除' : '范围观察存在不可读或未取得指纹的条目',
        });
      }
    }

    const baseline = await this.deps.baseline();
    if (!baseline.ok) {
      gaps.push({ kind: 'plan-unavailable', detail: `${baseline.code}: ${baseline.message}` });
    } else if (baseline.doc.planVersion !== basis.planVersion) {
      confirmed.push({
        kind: 'plan',
        detail: `规划版本从 ${basis.planVersion || '（空）'} 变为 ${baseline.doc.planVersion}`,
      });
    }

    // 只核对报告已引用的验证记录；索引里追加未引用记录不改变依据。
    for (const citation of uniqueVerificationCitations(citations)) {
      const entry: VerificationIndexEntry = {
        recordId: citation.recordId,
        summary: '',
        contentHash: citation.contentHash,
        subject: { kind: citation.subject.kind, id: citation.subject.id },
        ...(citation.subjectVersion === undefined ? {} : { subjectVersion: citation.subjectVersion }),
      };
      const verified = await this.deps.verification.verify(entry);
      if (verified.status === 'changed' || verified.status === 'missing') {
        confirmed.push({
          kind: 'verification',
          recordIds: [citation.recordId],
          detail: verified.status === 'missing' ? '已引用的验证记录已不存在' : '已引用的验证记录正文或元数据已变化',
        });
      } else if (verified.status === 'inaccessible') {
        gaps.push({
          kind: 'verification-unavailable',
          recordIds: [citation.recordId],
          detail: `${verified.code}: ${verified.message}`,
        });
      }
    }

    // 已引用的文件除范围比较外再按凭证重核：读取后又被改回的情形只有凭证能发现。
    // 范围观察已经不可用时不做逐文件核对，保留「无法核对」原因，不硬判变化。
    const seenFiles = new Set<string>();
    if (currentObservation !== null) {
      for (const citation of citations) {
        if (citation.kind !== 'file' || seenFiles.has(citation.path)) continue;
        seenFiles.add(citation.path);
        const credential: FileReadCredential = {
          path: citation.path,
          fullHash: citation.fullHash,
          deliveredHash: citation.deliveredHash,
          startLine: citation.startLine,
          endLine: citation.endLine,
          deliveredBytes: citation.deliveredBytes,
          totalLines: citation.totalLines,
          truncated: citation.truncated,
        };
        const verified = await this.deps.scope.verifyCitation(selection, credential);
        if (verified.status === 'content-changed') {
          confirmed.push({ kind: 'files-modified', paths: [citation.path], detail: '已引用的读取凭证与当前文件不一致' });
        } else if (verified.status === 'missing') {
          confirmed.push({ kind: 'files-deleted', paths: [citation.path], detail: '已引用的文件已不存在' });
        } else if (verified.status === 'outside-scope') {
          gaps.push({ kind: 'observation-gap', paths: [citation.path], detail: '已引用文件不在当前范围' });
        } else if (verified.status === 'inaccessible') {
          gaps.push({ kind: 'observation-gap', paths: [citation.path], detail: `${verified.code}: ${verified.message}` });
        } else if (verified.status === 'mapping-changed') {
          confirmed.push({ kind: 'mapping', detail: verified.reason });
        }
      }
    }

    const confirmedChanges = mergeBasisChanges(confirmed);
    if (confirmedChanges.length > 0) {
      return this.status('changed', mergeBasisChanges([...confirmed, ...gaps]), basis, currentObservation);
    }
    const gapChanges = mergeBasisChanges(gaps);
    if (gapChanges.length > 0) return this.status('uncheckable', gapChanges, basis, currentObservation);
    return this.status('current', [], basis, currentObservation);
  }

  private status(
    state: ReportBasisStatus['state'],
    changes: readonly ReportBasisChange[],
    basis: ReportBasisSnapshot | undefined,
    current: AnalysisObservation | null | undefined,
  ): ReportBasisStatus {
    const starting = basis?.git?.head;
    const currentHead = current !== null && current !== undefined && current.git.status === 'observed'
      ? current.git.head
      : undefined;
    const git = starting === undefined && currentHead === undefined
      ? undefined
      : {
          ...(starting === undefined ? {} : { starting }),
          ...(currentHead === undefined ? {} : { current: currentHead }),
        };
    return {
      state,
      changes,
      checkedAt: this.deps.clock(),
      ...(git === undefined ? {} : { git }),
    };
  }
}

/** 报告依据快照必须是完整形状；损坏时按旧报告处理，不拼半份基线。 */
export function usableBasis(value: unknown): value is ReportBasisSnapshot {
  if (value === null || typeof value !== 'object') return false;
  const basis = value as Partial<ReportBasisSnapshot>;
  if (typeof basis.instanceId !== 'string' || basis.instanceId === '') return false;
  if (typeof basis.repositoryId !== 'string' || basis.repositoryId === '') return false;
  if (typeof basis.repositoryRoot !== 'string' || basis.repositoryRoot === '') return false;
  if (typeof basis.mappingHash !== 'string' || basis.mappingHash === '') return false;
  if (typeof basis.sourceGeneration !== 'number') return false;
  if (typeof basis.planVersion !== 'string') return false;
  if (typeof basis.planRevision !== 'number') return false;
  if (typeof basis.fingerprint !== 'string') return false;
  if (typeof basis.complete !== 'boolean') return false;
  if (typeof basis.issues !== 'number') return false;
  if (!Array.isArray(basis.entries)) return false;
  for (const entry of basis.entries) {
    if (entry === null || typeof entry !== 'object') return false;
    if (typeof entry.path !== 'string' || entry.path === '') return false;
    if (entry.kind !== 'file') return false;
    if (entry.hash !== null && typeof entry.hash !== 'string') return false;
  }
  const scope = basis.scope;
  if (scope === null || typeof scope !== 'object') return false;
  if (scope.kind !== 'root' && scope.kind !== 'file' && scope.kind !== 'directory') return false;
  if (scope.kind !== 'root' && (typeof scope.path !== 'string' || scope.path === '')) return false;
  return true;
}

const CHANGE_ORDER: readonly ReportBasisChange['kind'][] = [
  'source-generation',
  'mapping',
  'plan',
  'files-added',
  'files-modified',
  'files-deleted',
  'verification',
  'observation-fingerprint',
  'basis-missing',
  'observation-gap',
  'plan-unavailable',
  'verification-unavailable',
];

/** 合并同类变化：路径与记录 ID 去重排序，说明去重拼接，输出顺序稳定。 */
export function mergeBasisChanges(changes: readonly ReportBasisChange[]): ReportBasisChange[] {
  const merged = new Map<ReportBasisChange['kind'], { paths: Set<string>; recordIds: Set<string>; details: Set<string> }>();
  for (const change of changes) {
    let bucket = merged.get(change.kind);
    if (bucket === undefined) {
      bucket = { paths: new Set(), recordIds: new Set(), details: new Set() };
      merged.set(change.kind, bucket);
    }
    for (const path of change.paths ?? []) bucket.paths.add(path);
    for (const recordId of change.recordIds ?? []) bucket.recordIds.add(recordId);
    if (change.detail !== undefined && change.detail !== '') bucket.details.add(change.detail);
  }
  const out: ReportBasisChange[] = [];
  for (const kind of CHANGE_ORDER) {
    const bucket = merged.get(kind);
    if (bucket === undefined) continue;
    out.push({
      kind,
      ...(bucket.paths.size === 0 ? {} : { paths: [...bucket.paths].sort() }),
      ...(bucket.recordIds.size === 0 ? {} : { recordIds: [...bucket.recordIds].sort() }),
      ...(bucket.details.size === 0 ? {} : { detail: [...bucket.details].join('；') }),
    });
  }
  return out;
}

function uniqueVerificationCitations(citations: readonly ReportCitation[]): Array<Extract<ReportCitation, { kind: 'verification' }>> {
  const seen = new Set<string>();
  const out: Array<Extract<ReportCitation, { kind: 'verification' }>> = [];
  for (const citation of citations) {
    if (citation.kind !== 'verification' || seen.has(citation.recordId)) continue;
    seen.add(citation.recordId);
    out.push(citation);
  }
  return out;
}
