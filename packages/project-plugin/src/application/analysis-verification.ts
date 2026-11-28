// 验证记录索引与正文读取（tasks 5.1）：从分析开始捕获的公开快照索引出发，
// 读取时按记录 ID 重查当前索引、核对 contentHash／验证主体／subjectVersion，
// 再读取正文并核对实际字节哈希；只对实际交付的片段发凭证。

import { sliceText, textLineCount, type AnalysisLimits, type ReadBudget } from '../domain/analysis.js';
import type { ProjectDocument, RecordIndexEntry, Sha256Fn } from '../domain/types.js';

/** 启动时捕获的有界验证索引项。 */
export interface VerificationIndexEntry {
  readonly recordId: string;
  readonly summary: string;
  readonly contentHash: string;
  readonly subject: { readonly kind: 'node' | 'record'; readonly id: string };
  readonly subjectVersion?: string;
  readonly scope?: string;
}

/** 实际交付的验证记录正文凭证。 */
export interface VerificationReadCredential {
  readonly recordId: string;
  readonly contentHash: string;
  readonly subject: { readonly kind: 'node' | 'record'; readonly id: string };
  readonly subjectVersion?: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly deliveredHash: string;
  readonly deliveredBytes: number;
  readonly totalLines: number;
  readonly truncated: boolean;
}

export type AnalysisVerificationResult =
  | {
      readonly status: 'ok';
      readonly text: string;
      readonly credential: VerificationReadCredential;
      readonly truncated: boolean;
      readonly reason?: 'lines' | 'bytes';
    }
  | { readonly status: 'rejected'; readonly code: string; readonly message: string };

export interface AnalysisVerificationDeps {
  /** 当前已校对的公开资料文档（记录索引来源）。 */
  readonly baseline: () => Promise<
    { readonly ok: true; readonly doc: ProjectDocument } | { readonly ok: false; readonly code: string; readonly message: string }
  >;
  /** 按协议路径读取记录正文；实现方须核对 contentHash。 */
  readonly readRecord: (path: string, expectedHash: string) => Promise<
    { readonly ok: true; readonly body: string } | { readonly ok: false; readonly code: string; readonly message: string }
  >;
  readonly sha256: Sha256Fn;
  readonly limits: AnalysisLimits;
}

export class AnalysisVerificationService {
  constructor(private readonly deps: AnalysisVerificationDeps) {}

  /** 捕获验证记录索引：只保留 kind=verification 的公开索引项。 */
  async captureIndex(): Promise<readonly VerificationIndexEntry[]> {
    const baseline = await this.deps.baseline();
    if (!baseline.ok) return [];
    return baseline.doc.records
      .filter((record) => record.kind === 'verification' && record.verification !== undefined)
      .map((record) => toIndex(record))
      .sort((left, right) => (left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0));
  }

  /** 核对一条历史验证凭证是否仍与当前索引／正文一致。 */
  async verify(entry: VerificationIndexEntry): Promise<
    | { readonly status: 'current' }
    | { readonly status: 'missing' }
    | { readonly status: 'changed' }
    | { readonly status: 'inaccessible'; readonly code: string; readonly message: string }
  > {
    const baseline = await this.deps.baseline();
    if (!baseline.ok) return { status: 'inaccessible', code: baseline.code, message: baseline.message };
    const current = baseline.doc.records.find((record) => record.id === entry.recordId);
    if (current === undefined) return { status: 'missing' };
    if (current.kind !== 'verification' || current.verification === undefined) return { status: 'changed' };
    if (current.contentHash !== entry.contentHash
      || current.verification.subject.kind !== entry.subject.kind
      || current.verification.subject.id !== entry.subject.id
      || current.verification.subjectVersion !== entry.subjectVersion) return { status: 'changed' };
    const body = await this.deps.readRecord(current.path, current.contentHash);
    if (!body.ok) return { status: 'inaccessible', code: body.code, message: body.message };
    return { status: 'current' };
  }

  /** 读取一条捕获索引项的正文；索引或正文变化时拒绝，不拿新正文冒充当轮证据。 */
  async read(
    entry: VerificationIndexEntry,
    options: { readonly budget: ReadBudget; readonly startLine?: number; readonly maxLines?: number },
  ): Promise<AnalysisVerificationResult> {
    const baseline = await this.deps.baseline();
    if (!baseline.ok) return { status: 'rejected', code: baseline.code, message: baseline.message };
    const current = baseline.doc.records.find((record) => record.id === entry.recordId);
    if (current === undefined || current.kind !== 'verification' || current.verification === undefined) {
      return { status: 'rejected', code: 'analysis-verification-missing', message: '当前资料索引中没有该验证记录' };
    }
    if (current.contentHash !== entry.contentHash
      || current.verification.subject.kind !== entry.subject.kind
      || current.verification.subject.id !== entry.subject.id
      || current.verification.subjectVersion !== entry.subjectVersion) {
      return { status: 'rejected', code: 'analysis-verification-changed', message: '验证记录的索引或元数据已变化，只保留历史凭证' };
    }
    const body = await this.deps.readRecord(current.path, current.contentHash);
    if (!body.ok) {
      return { status: 'rejected', code: body.code, message: body.message };
    }
    const bytes = new TextEncoder().encode(body.body);
    if (bytes.length > this.deps.limits.fileBytes) {
      return {
        status: 'rejected',
        code: 'analysis-verification-too-large',
        message: `验证记录正文 ${bytes.length} 字节超过单文件上限 ${this.deps.limits.fileBytes}`,
      };
    }
    const remaining = Math.min(this.deps.limits.readBytes, options.budget.remaining);
    if (remaining < 1) {
      return { status: 'rejected', code: 'analysis-read-budget-exhausted', message: '本轮分析读取额度已用尽' };
    }
    const sliced = sliceText(body.body, {
      ...(options.startLine === undefined ? {} : { startLine: options.startLine }),
      maxLines: Math.min(options.maxLines ?? this.deps.limits.readLines, this.deps.limits.readLines),
      maxBytes: remaining,
      fullFile: options.startLine === undefined && options.maxLines === undefined,
    });
    if (!sliced.ok) return { status: 'rejected', code: sliced.code, message: sliced.message };
    options.budget.consume(sliced.slice.bytes);
    return {
      status: 'ok',
      text: sliced.slice.text,
      credential: {
        recordId: entry.recordId,
        contentHash: entry.contentHash,
        subject: { kind: entry.subject.kind, id: entry.subject.id },
        ...(entry.subjectVersion === undefined ? {} : { subjectVersion: entry.subjectVersion }),
        startLine: sliced.slice.startLine,
        endLine: sliced.slice.endLine,
        deliveredHash: this.deps.sha256(new TextEncoder().encode(sliced.slice.text)),
        deliveredBytes: sliced.slice.bytes,
        totalLines: textLineCount(body.body),
        truncated: sliced.slice.truncated,
      },
      truncated: sliced.slice.truncated,
      ...(sliced.slice.reason === undefined ? {} : { reason: sliced.slice.reason }),
    };
  }
}

function toIndex(record: RecordIndexEntry): VerificationIndexEntry {
  const verification = record.verification as NonNullable<RecordIndexEntry['verification']>;
  return {
    recordId: record.id,
    summary: record.summary,
    contentHash: record.contentHash,
    subject: { kind: verification.subject.kind, id: verification.subject.id },
    ...(verification.subjectVersion === undefined ? {} : { subjectVersion: verification.subjectVersion }),
    ...(verification.scope === undefined ? {} : { scope: verification.scope }),
  };
}
