// 分析报告校验与保存（tasks 5.2-5.4）：只接受本轮实际交付过凭证的事实引用，
// 按当前范围观察计算覆盖与依据状态；报告只存本机聚合，一个分析至多一个终稿。

import { InstanceCommandQueue } from './command-queue.js';
import { analysisRecordsOf, analysisReportsOf, type AnalysisRecord, type AnalysisReportRecord, type InstanceAggregate, type ReportCitation, type ReportCoverage, type ReportFact, type ReportFileCitation, type ReportVerificationCitation } from './local-state.js';
import { analysisSelectionOf } from './analysis-session.js';
import type { AnalysisScopeService, FileReadCredential } from './analysis-scope.js';
import type { AnalysisVerificationService, VerificationIndexEntry, VerificationReadCredential } from './analysis-verification.js';
import type { LocalStateStorePort, PublishHooksPort } from './ports.js';
import type { ProjectDocument, Sha256Fn } from '../domain/types.js';
import type { ScopeSelection } from '../domain/analysis.js';

export interface ReportFileRefInput {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
}
export interface ReportVerificationRefInput {
  readonly recordId: string;
  readonly startLine?: number;
  readonly endLine?: number;
}
export interface ReportFactInput {
  readonly text: string;
  readonly files?: readonly ReportFileRefInput[];
  readonly verifications?: readonly ReportVerificationRefInput[];
  /** 引用启动时冻结的规划背景。 */
  readonly plan?: boolean;
}

export interface SaveReportInput {
  readonly analysisId: string;
  /** 真实工具上下文里的 Agent.id；必须等于记录的实际 Session。 */
  readonly sessionId: string;
  readonly requestId: string;
  readonly summary: string;
  readonly facts: readonly ReportFactInput[];
  readonly inferences: readonly string[];
  readonly suggestions: readonly string[];
  /** 本轮实际交付的读取凭证（由工具处理器给出，不接受模型参数）。 */
  readonly evidence: {
    readonly files: readonly FileReadCredential[];
    readonly verifications: readonly VerificationReadCredential[];
  };
}

export type SaveReportOutcome =
  | { readonly status: 'saved'; readonly report: AnalysisReportRecord; readonly reused: boolean; readonly stateRevision: number }
  | { readonly status: 'rejected'; readonly code: string; readonly message: string }
  | { readonly status: 'unknown-state'; readonly code: string; readonly message: string; readonly stage: string };

export interface ReportSummary {
  readonly reportId: string;
  readonly analysisId: string;
  readonly createdAt: string;
  readonly summary: string;
  readonly planVersion: string;
  readonly coverage: ReportCoverage;
}

export interface AnalysisReportServiceDeps {
  readonly localRoot: string;
  readonly instanceId: string;
  readonly store: LocalStateStorePort;
  readonly queue: InstanceCommandQueue;
  readonly scope: AnalysisScopeService;
  readonly verification: AnalysisVerificationService;
  readonly baseline: () => Promise<
    { readonly ok: true; readonly doc: ProjectDocument } | { readonly ok: false; readonly code: string; readonly message: string }
  >;
  readonly sha256: Sha256Fn;
  readonly clock: () => string;
  readonly newReportId: () => string;
  readonly hooks?: { readonly beforeAggregateReplace?: PublishHooksPort };
}

const MAX_FACTS = 200;
const MAX_ITEMS = 200;
const MAX_TEXT = 20000;

export class AnalysisReportService {
  constructor(private readonly deps: AnalysisReportServiceDeps) {}

  /** 保存终稿：校验分析状态、载荷、引用凭证与覆盖；同号同载荷幂等，异载荷冲突。 */
  async save(input: SaveReportInput): Promise<SaveReportOutcome> {
    const shape = validateDraft(input);
    if (shape !== null) return { status: 'rejected', code: 'report-invalid', message: shape };
    return this.deps.queue.run(this.deps.instanceId, async () => {
      const read = await this.readAggregate();
      if ('outcome' in read) return read.outcome;
      const records = analysisRecordsOf(read.aggregate.analyses);
      const record = records.find((item) => item.analysisId === input.analysisId);
      if (record === undefined) return { status: 'rejected', code: 'analysis-not-found', message: '本机没有该分析记录' };
      if (record.sessionId !== input.sessionId) {
        return { status: 'rejected', code: 'analysis-session-mismatch', message: '报告保存调用不属于该分析 Session' };
      }
      if (record.status !== 'running' || record.binding === null || !record.binding.persisted || !record.binding.protected || record.binding.terminal) {
        return { status: 'rejected', code: 'analysis-not-running', message: '分析不在受保护运行状态，不能保存报告' };
      }
      if (record.stopRequestedAt !== undefined) {
        return { status: 'rejected', code: 'analysis-stopping', message: '分析已收到停止请求，不再接受报告' };
      }

      const payloadHash = this.payloadHash(input);
      const reports = analysisReportsOf(read.aggregate.analysisReports);
      const existing = reports.find((report) => report.analysisId === record.analysisId);
      if (existing !== undefined) {
        if (existing.requestId === input.requestId && existing.payloadHash === payloadHash) {
          return { status: 'saved' as const, report: existing, reused: true, stateRevision: read.aggregate.revisions.state };
        }
        return { status: 'rejected' as const, code: 'report-already-saved', message: '该分析已有终稿；同号异载荷或重复提交被拒绝' };
      }

      const current = await this.deps.scope.observe(analysisSelectionOf(record));
      if (current.status === 'rejected') {
        return { status: 'rejected', code: 'report-basis-uncheckable', message: current.message };
      }
      const citations = this.resolveCitations(input, record.planVersion);
      if ('code' in citations) return { status: 'rejected', code: citations.code, message: citations.message };
      const coverage = this.coverage(record, current, input.evidence);
      const report: AnalysisReportRecord = {
        reportId: this.deps.newReportId(),
        analysisId: record.analysisId,
        instanceId: this.deps.instanceId,
        repositoryId: record.repositoryId,
        scope: record.scope,
        planVersion: record.planVersion,
        sourceGeneration: record.sourceGeneration,
        requestId: input.requestId,
        payloadHash,
        createdAt: this.deps.clock(),
        summary: input.summary,
        facts: citations.facts,
        inferences: [...input.inferences],
        suggestions: [...input.suggestions],
        coverage,
      };
      const saved = await this.persist(read.aggregate, [...reports, report]);
      if (saved.status === 'unknown-state') return saved;
      if (saved.status === 'rejected') return { status: 'rejected', code: saved.code, message: saved.message };
      return { status: 'saved' as const, report, reused: false, stateRevision: saved.stateRevision };
    });
  }

  /** 本实例报告列表（新到旧），只给摘要。 */
  async list(): Promise<readonly ReportSummary[]> {
    const read = await this.readAggregate();
    if ('outcome' in read) return [];
    return analysisReportsOf(read.aggregate.analysisReports)
      .filter((report) => report.instanceId === this.deps.instanceId)
      .slice()
      .sort((left, right) => (left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0))
      .map((report) => ({
        reportId: report.reportId,
        analysisId: report.analysisId,
        createdAt: report.createdAt,
        summary: report.summary,
        planVersion: report.planVersion,
        coverage: report.coverage,
      }));
  }

  /** 报告详情；另一实例的 reportId 取不到。 */
  async get(reportId: string): Promise<{ status: 'ok'; report: AnalysisReportRecord } | { status: 'rejected'; code: string; message: string }> {
    if (typeof reportId !== 'string' || reportId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少 reportId' };
    }
    const read = await this.readAggregate();
    if ('outcome' in read) {
      const outcome = read.outcome;
      return { status: 'rejected', code: outcome.code, message: outcome.message };
    }
    const report = analysisReportsOf(read.aggregate.analysisReports)
      .find((item) => item.reportId === reportId && item.instanceId === this.deps.instanceId);
    if (report === undefined) return { status: 'rejected', code: 'report-not-found', message: '本机没有该报告' };
    return { status: 'ok', report };
  }

  /** 来源复核（tasks 5.4）：逐条引用按当前映射／正文／验证索引重新核对。 */
  async verifySources(reportId: string): Promise<
    | { readonly status: 'ok'; readonly report: AnalysisReportRecord; readonly sources: readonly { readonly citation: ReportCitation; readonly state: 'current' | 'content-changed' | 'missing' | 'inaccessible' | 'outside-scope' | 'mapping-changed' }[] }
    | { readonly status: 'rejected'; readonly code: string; readonly message: string }
  > {
    const detail = await this.get(reportId);
    if (detail.status !== 'ok') return detail;
    const report = detail.report;
    const read = await this.readAggregate();
    if ('outcome' in read) return { status: 'rejected', code: 'report-read-failed', message: '读取分析记录失败' };
    const record = analysisRecordsOf(read.aggregate.analyses).find((item) => item.analysisId === report.analysisId);
    if (record === undefined) return { status: 'rejected', code: 'analysis-not-found', message: '报告对应的分析记录不存在' };
    const selection = analysisSelectionOf(record);
    const sources: Array<{ citation: ReportCitation; state: 'current' | 'content-changed' | 'missing' | 'inaccessible' | 'outside-scope' | 'mapping-changed' }> = [];
    for (const fact of report.facts) {
      for (const citation of fact.citations) {
        if (citation.kind === 'file') {
          const verified = await this.deps.scope.verifyCitation(selection, {
            path: citation.path,
            fullHash: citation.fullHash,
            deliveredHash: citation.deliveredHash,
            startLine: citation.startLine,
            endLine: citation.endLine,
            deliveredBytes: citation.deliveredBytes,
            totalLines: citation.totalLines,
            truncated: citation.truncated,
          });
          sources.push({
            citation,
            state: verified.status === 'content-changed' ? 'content-changed'
              : verified.status === 'missing' ? 'missing'
                : verified.status === 'inaccessible' ? 'inaccessible'
                  : verified.status === 'outside-scope' ? 'outside-scope'
                    : verified.status === 'mapping-changed' ? 'mapping-changed' : 'current',
          });
        } else if (citation.kind === 'verification') {
          const entry: VerificationIndexEntry = {
            recordId: citation.recordId,
            summary: '',
            contentHash: citation.contentHash,
            subject: citation.subject,
            ...(citation.subjectVersion === undefined ? {} : { subjectVersion: citation.subjectVersion }),
          };
          const verified = await this.deps.verification.verify(entry);
          sources.push({
            citation,
            state: verified.status === 'current' ? 'current'
              : verified.status === 'missing' ? 'missing'
                : verified.status === 'changed' ? 'content-changed' : 'inaccessible',
          });
        } else {
          const baseline = await this.deps.baseline();
          if (!baseline.ok) {
            sources.push({ citation, state: 'inaccessible' });
          } else {
            sources.push({ citation, state: baseline.doc.planVersion === citation.planVersion ? 'current' : 'content-changed' });
          }
        }
      }
    }
    return { status: 'ok', report, sources };
  }

  private resolveCitations(input: SaveReportInput, planVersion: string): { facts: ReportFact[] } | { code: string; message: string } {
    const facts: ReportFact[] = [];
    for (const fact of input.facts) {
      const citations: ReportCitation[] = [];
      if (fact.plan === true) citations.push({ kind: 'plan', planVersion });
      for (const ref of fact.files ?? []) {
        const resolved = resolveFile(ref, input.evidence.files);
        if (resolved === null) return { code: 'report-citation-unbacked', message: `事实引用的文件片段没有本轮读取凭证：${ref.path}` };
        citations.push({ kind: 'file', ...resolved });
      }
      for (const ref of fact.verifications ?? []) {
        const resolved = resolveVerification(ref, input.evidence.verifications);
        if (resolved === null) return { code: 'report-citation-unbacked', message: `事实引用的验证记录没有本轮交付凭证：${ref.recordId}` };
        citations.push({ kind: 'verification', ...resolved });
      }
      if (citations.length === 0) return { code: 'report-fact-uncited', message: '每条事实必须引用本轮文件读取、验证记录或规划背景' };
      facts.push({ text: fact.text, citations });
    }
    return { facts };
  }

  private coverage(
    record: AnalysisRecord,
    current: { entries: readonly { path: string }[]; issues: readonly unknown[]; exclusions: readonly unknown[]; truncated: boolean; complete: boolean; fingerprint: string },
    evidence: SaveReportInput['evidence'],
  ): ReportCoverage {
    const readPaths = new Set(evidence.files.map((item) => item.path));
    let completeFiles = 0;
    let fragments = 0;
    for (const path of readPaths) {
      const credentials = evidence.files.filter((item) => item.path === path);
      if (credentials.some((item) => item.startLine === 1 && item.endLine === item.totalLines && !item.truncated)) {
        completeFiles += 1;
      } else {
        fragments += 1;
      }
    }
    const onlyEnumerated = current.entries.filter((entry) => !readPaths.has(entry.path)).length;
    const basis = current.fingerprint === record.observation.fingerprint ? 'current' as const : 'changed' as const;
    return {
      observedFiles: current.entries.length,
      readFiles: readPaths.size,
      completeFiles,
      fragments,
      onlyEnumerated,
      unreadable: current.issues.length,
      excluded: current.exclusions.length,
      verificationRead: new Set(evidence.verifications.map((item) => item.recordId)).size,
      truncated: current.truncated
        || evidence.files.some((item) => item.truncated)
        || evidence.verifications.some((item) => item.truncated),
      observationComplete: current.complete,
      basis,
      fingerprint: current.fingerprint,
    };
  }

  private payloadHash(input: SaveReportInput): string {
    const canonical = JSON.stringify({
      summary: input.summary,
      facts: input.facts.map((fact) => ({
        text: fact.text,
        plan: fact.plan === true,
        files: (fact.files ?? []).map((ref) => ({ path: ref.path, startLine: ref.startLine ?? null, endLine: ref.endLine ?? null })),
        verifications: (fact.verifications ?? []).map((ref) => ({ recordId: ref.recordId, startLine: ref.startLine ?? null, endLine: ref.endLine ?? null })),
      })),
      inferences: input.inferences,
      suggestions: input.suggestions,
    });
    return this.deps.sha256(new TextEncoder().encode(canonical));
  }

  private async readAggregate(): Promise<{ aggregate: InstanceAggregate } | { outcome: { status: 'rejected'; code: string; message: string } }> {
    const quarantined = await this.deps.store.readQuarantine(this.deps.localRoot, this.deps.instanceId);
    if (quarantined !== null) {
      return { outcome: { status: 'rejected', code: 'unknown-state', message: `该实例已隔离（${quarantined.reason}）；报告读写停止` } };
    }
    const aggregate = await this.deps.store.readAggregate(this.deps.localRoot, this.deps.instanceId);
    if (aggregate === null) return { outcome: { status: 'rejected', code: 'binding-expired', message: '本机注册表中没有该实例' } };
    return { aggregate };
  }

  private async persist(
    aggregate: InstanceAggregate,
    reports: AnalysisReportRecord[],
  ): Promise<
    { status: 'committed'; stateRevision: number } | { status: 'rejected'; code: string; message: string } | { status: 'unknown-state'; code: string; message: string; stage: string }
  > {
    const next: InstanceAggregate = {
      ...aggregate,
      analysisReports: reports,
      revisions: { ...aggregate.revisions, state: aggregate.revisions.state + 1 },
    };
    const result = await this.deps.store.replaceAggregateChecked(this.deps.localRoot, next, this.deps.hooks?.beforeAggregateReplace);
    if (result.status === 'saved') return { status: 'committed', stateRevision: next.revisions.state };
    if (result.status === 'not-saved') {
      return { status: 'rejected', code: 'persistence-failed', message: `本机聚合未保存（阶段 ${result.stage}）：${result.detail ?? ''}` };
    }
    await this.deps.store.quarantine(this.deps.localRoot, {
      schemaVersion: 1,
      instanceId: aggregate.instanceId,
      reason: 'unknown-state',
      stage: `report:${result.stage}`,
      createdAt: this.deps.clock(),
      detail: result.detail,
      requires: 'offline-review',
    });
    return { status: 'unknown-state', code: 'unknown-state', message: `本机聚合写入结果未知（阶段 ${result.stage}）；实例已隔离`, stage: result.stage };
  }
}

function validateDraft(input: SaveReportInput): string | null {
  if (typeof input.analysisId !== 'string' || input.analysisId === '') return '缺少 analysisId';
  if (typeof input.sessionId !== 'string' || input.sessionId === '') return '缺少 sessionId';
  if (typeof input.requestId !== 'string' || input.requestId === '') return '缺少 requestId';
  if (typeof input.summary !== 'string' || input.summary.trim() === '') return 'summary 不能为空';
  if (input.summary.length > MAX_TEXT) return 'summary 超过长度上限';
  if (!Array.isArray(input.facts) || input.facts.length > MAX_FACTS) return 'facts 必须是不超过上限的数组';
  if (!Array.isArray(input.inferences) || input.inferences.length > MAX_ITEMS) return 'inferences 必须是不超过上限的数组';
  if (!Array.isArray(input.suggestions) || input.suggestions.length > MAX_ITEMS) return 'suggestions 必须是不超过上限的数组';
  for (const fact of input.facts) {
    if (typeof fact.text !== 'string' || fact.text.trim() === '' || fact.text.length > MAX_TEXT) return '每条事实都需要非空且不超长的 text';
  }
  for (const item of [...input.inferences, ...input.suggestions]) {
    if (typeof item !== 'string' || item.trim() === '' || item.length > MAX_TEXT) return '推断与建议条目需要非空且不超长';
  }
  return null;
}

function resolveFile(ref: ReportFileRefInput, evidence: readonly FileReadCredential[]): ReportFileCitation | null {
  for (const credential of evidence) {
    if (credential.path !== ref.path) continue;
    const startLine = ref.startLine ?? credential.startLine;
    const endLine = ref.endLine ?? credential.endLine;
    if (startLine < credential.startLine || endLine > credential.endLine || endLine < startLine) continue;
    return {
      path: credential.path,
      fullHash: credential.fullHash,
      deliveredHash: credential.deliveredHash,
      startLine,
      endLine,
      deliveredBytes: credential.deliveredBytes,
      totalLines: credential.totalLines,
      truncated: credential.truncated,
    };
  }
  return null;
}

function resolveVerification(ref: ReportVerificationRefInput, evidence: readonly VerificationReadCredential[]): ReportVerificationCitation | null {
  for (const credential of evidence) {
    if (credential.recordId !== ref.recordId) continue;
    const startLine = ref.startLine ?? credential.startLine;
    const endLine = ref.endLine ?? credential.endLine;
    if (startLine < credential.startLine || endLine > credential.endLine || endLine < startLine) continue;
    return {
      recordId: credential.recordId,
      contentHash: credential.contentHash,
      subject: credential.subject,
      ...(credential.subjectVersion === undefined ? {} : { subjectVersion: credential.subjectVersion }),
      startLine,
      endLine,
      deliveredHash: credential.deliveredHash,
      deliveredBytes: credential.deliveredBytes,
      truncated: credential.truncated,
    };
  }
  return null;
}
