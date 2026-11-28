// 分析范围观察与读取的纯规则（tasks 3.2-3.5，design「文件范围、枚举和读取凭证」）。
//
// 本文件属于 src/domain：不依赖 Node、React、Cordis，也不做文件系统访问。
// 它只定义：范围选择、观察条目/指纹、集中限额、按行/字节切分实际交付文本、
// 单轮读取预算，以及范围包含判定。枚举、Git 排除与真实读取在 adapters/fs
// 和分析服务中完成。

import type { Sha256Fn } from './types.js';

/** 分析观察与读取的集中限额；测试通过构造参数注入更小值。 */
export interface AnalysisLimits {
  /** 一轮观察最多计入的目录项（文件、链接、特殊文件）。 */
  readonly scanEntries: number;
  /** 单个文件允许取得内容指纹/正文的字节上限。 */
  readonly fileBytes: number;
  /** 一轮分析交付给 Agent 的文本总字节上限。 */
  readonly readBytes: number;
  /** 单次读取交付的最大行数。 */
  readonly readLines: number;
}

export const DEFAULT_ANALYSIS_LIMITS: AnalysisLimits = Object.freeze({
  scanEntries: 2000,
  fileBytes: 512 * 1024,
  readBytes: 256 * 1024,
  readLines: 4000,
});

/** 合并并校验限额：缺省取默认值，非法值直接拒绝，避免静默放宽。 */
export function resolveAnalysisLimits(input: Partial<AnalysisLimits> = {}): AnalysisLimits {
  const pick = (key: keyof AnalysisLimits, fallback: number): number => {
    const value = input[key];
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < 1) {
      throw new RangeError(`analysis limit ${key} must be a positive integer`);
    }
    return Math.floor(value);
  };
  return {
    scanEntries: pick('scanEntries', DEFAULT_ANALYSIS_LIMITS.scanEntries),
    fileBytes: pick('fileBytes', DEFAULT_ANALYSIS_LIMITS.fileBytes),
    readBytes: pick('readBytes', DEFAULT_ANALYSIS_LIMITS.readBytes),
    readLines: pick('readLines', DEFAULT_ANALYSIS_LIMITS.readLines),
  };
}

/** 用户选择的范围：仓库根、一个文件或一个目录（相对仓库根，`/` 分段）。 */
export type ScopeSelection =
  | { readonly kind: 'root' }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'directory'; readonly path: string };

/** 观察到的常规文件；hash 为 null 表示本次没有取得内容指纹（超限或不可读）。 */
export interface ObservationEntry {
  readonly path: string;
  readonly kind: 'file';
  readonly bytes: number;
  readonly hash: string | null;
}

/** 参与范围但不进入观察内容的条目及原因。 */
export type ExclusionReason = 'git-internal' | 'git-ignored' | 'symlink' | 'special-file';

export interface ObservationExclusion {
  readonly path: string;
  readonly reason: ExclusionReason;
}

/** 观察缺口；path 为 null 表示范围级问题。 */
export interface ObservationIssue {
  readonly path: string | null;
  readonly code: string;
  readonly message: string;
}

/** 范围是否包含某个仓库相对路径（`/` 分段，逐段语义）。 */
export function scopeContainsPath(scope: ScopeSelection, relativePath: string): boolean {
  if (scope.kind === 'root') return true;
  if (scope.kind === 'file') return relativePath === scope.path;
  return relativePath === scope.path || relativePath.startsWith(`${scope.path}/`);
}

/**
 * 有序观察指纹：按路径排序后对 `path\0kind\0hash` 取哈希。
 * 输入次序不影响结果；内容、增删或类型变化都会改变指纹。
 */
export function fingerprintObservation(
  entries: readonly ObservationEntry[],
  sha256: Sha256Fn,
): string {
  const sorted = [...entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const canonical = sorted
    .map((entry) => `${entry.path}\u0000${entry.kind}\u0000${entry.hash ?? ''}`)
    .join('\n');
  return sha256(utf8Bytes(canonical));
}

/** 观察是否完整：没有截断、没有缺口，且每个条目都取得了内容指纹。 */
export function isObservationComplete(input: {
  readonly entries: readonly ObservationEntry[];
  readonly issues: readonly ObservationIssue[];
  readonly truncated: boolean;
}): boolean {
  return !input.truncated
    && input.issues.length === 0
    && input.entries.every((entry) => entry.hash !== null);
}

/** 纯 UTF-8 编码（domain 不依赖 TextEncoder）；只用于哈希与字节计数。 */
function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index) as number;
    if (codePoint > 0xffff) index += 1;
    if (codePoint < 0x80) {
      out.push(codePoint);
    } else if (codePoint < 0x800) {
      out.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      out.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      out.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

function byteLength(text: string): number {
  return utf8Bytes(text).length;
}

/** 一次读取实际交付的文本片段与行范围（1 起、含首尾）。 */
export interface TextSlice {
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly reason?: 'lines' | 'bytes';
}

export type TextSliceResult =
  | { readonly ok: true; readonly slice: TextSlice }
  | { readonly ok: false; readonly code: 'analysis-line-out-of-range' | 'analysis-read-budget-exceeded'; readonly message: string };

/**
 * 从完整文本中切出实际交付的片段。只按整行交付：某行放不进预算时，
 * 之前已选中的行照常交付并标记按字节截断；首行就放不进则不交付。
 */
export function sliceText(
  text: string,
  options: {
    readonly startLine?: number;
    readonly maxLines: number;
    readonly maxBytes: number;
    /** true 表示未指定行范围、按整份文件读取；只有这种读取把行数上限视为截断。 */
    readonly fullFile?: boolean;
  },
): TextSliceResult {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) {
    return { ok: true, slice: { text: '', startLine: 1, endLine: 1, bytes: 0, truncated: false } };
  }
  const start = options.startLine === undefined ? 1 : Math.floor(options.startLine);
  if (!Number.isFinite(start) || start < 1 || start > lines.length) {
    return {
      ok: false,
      code: 'analysis-line-out-of-range',
      message: `起始行 ${String(options.startLine)} 超出文件行数 ${lines.length}`,
    };
  }
  if (!Number.isFinite(options.maxLines) || options.maxLines < 1 || !Number.isFinite(options.maxBytes) || options.maxBytes < 1) {
    return { ok: false, code: 'analysis-read-budget-exceeded', message: '读取行数或字节预算必须为正数' };
  }

  const lastIndex = Math.min(lines.length, start + Math.floor(options.maxLines) - 1);
  const selected: string[] = [];
  let bytes = 0;
  for (let index = start - 1; index < lastIndex; index += 1) {
    const line = lines[index] as string;
    const cost = byteLength(line) + (selected.length > 0 ? 1 : 0);
    if (bytes + cost > options.maxBytes) {
      if (selected.length === 0) {
        return {
          ok: false,
          code: 'analysis-read-budget-exceeded',
          message: `剩余读取预算 ${options.maxBytes} 字节不足以交付第 ${start} 行`,
        };
      }
      return {
        ok: true,
        slice: {
          text: selected.join('\n'),
          startLine: start,
          endLine: start + selected.length - 1,
          bytes,
          truncated: true,
          reason: 'bytes',
        },
      };
    }
    selected.push(line);
    bytes += cost;
  }

  const endLine = start + selected.length - 1;
  const truncated = options.fullFile === true && endLine < lines.length;
  return {
    ok: true,
    slice: {
      text: selected.join('\n'),
      startLine: start,
      endLine,
      bytes,
      truncated,
      ...(truncated ? { reason: 'lines' as const } : {}),
    },
  };
}

/** 一轮分析的累计读取预算；由分析运行持有，读取服务消费。 */
export class ReadBudget {
  private consumed = 0;

  constructor(readonly limit: number) {
    if (!Number.isFinite(limit) || limit < 0) throw new RangeError('read budget limit must be non-negative');
  }

  get used(): number {
    return this.consumed;
  }

  get remaining(): number {
    return Math.max(0, Math.floor(this.limit) - this.consumed);
  }

  /** 记账实际交付字节；超出剩余额度说明调用方未先检查，直接拒绝。 */
  consume(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError('consumed bytes must be non-negative');
    if (bytes > this.remaining) throw new RangeError('read budget exhausted');
    this.consumed += Math.floor(bytes);
  }
}
