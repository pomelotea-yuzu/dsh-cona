// v1-plan 规划指纹：独立第二实现（协议 §5 强制要求）。
// 独立性边界：不 import 主实现的任何序列化函数（encodeCanonical / quoteCanonical /
// utf16Compare / sortProjectionWhitelists）；仅共享 strict-json 解析、validate 领域校验、
// utf8 编码（标准算法）与注入的 Sha256Fn。比较器与引号编码逐码元手写，
// 与主实现的 code-point 迭代路径不同，用于交叉复算全部一致性向量。

import { utf8Encode } from './utf8.js';
import { validateProjectDocument } from '../validate.js';
import type { ProjectDocument, Sha256Fn } from '../types.js';
import { strictParse } from '../strict-json.js';
import type { StrictJson } from '../strict-json.js';

export class CanonicalEncodeErrorAlt extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalEncodeErrorAlt';
  }
}

/** 手写 UTF-16 码元比较：逐码元比较，相同前缀时短串在前。 */
function utf16CompareAlt(a: string, b: string): number {
  const aLen = a.length;
  const bLen = b.length;
  const common = aLen < bLen ? aLen : bLen;
  for (let i = 0; i < common; i += 1) {
    const ua = a.charCodeAt(i);
    const ub = b.charCodeAt(i);
    if (ua !== ub) {
      return ua < ub ? -1 : 1;
    }
  }
  if (aLen === bLen) return 0;
  return aLen < bLen ? -1 : 1;
}

const ESCAPE_MAP_ALT: { unit: number; text: string }[] = [
  { unit: 0x22, text: '\\"' },
  { unit: 0x5c, text: '\\\\' },
  { unit: 0x08, text: '\\b' },
  { unit: 0x09, text: '\\t' },
  { unit: 0x0a, text: '\\n' },
  { unit: 0x0c, text: '\\f' },
  { unit: 0x0d, text: '\\r' },
];

function hex4(unit: number): string {
  // 固定四位小写十六进制，手写转换。
  let out = '';
  let v = unit;
  for (let shift = 12; shift >= 0; shift -= 4) {
    const digit = (v >> shift) & 0xf;
    out += digit < 10 ? String.fromCharCode(0x30 + digit) : String.fromCharCode(0x61 + digit - 10);
  }
  return out;
}

/** 协议 §3 字符串编码（独立实现：逐码元扫描，手工配对代理）。 */
export function quoteCanonicalAlt(value: string): string {
  let out = '"';
  let pendingHigh = -1;
  const len = value.length;
  for (let i = 0; i < len; i += 1) {
    const unit = value.charCodeAt(i);
    if (pendingHigh !== -1) {
      if (unit >= 0xdc00 && unit <= 0xdfff) {
        // 合成补充字符：两个码元都原样输出。
        out += String.fromCharCode(pendingHigh, unit);
        pendingHigh = -1;
        continue;
      }
      throw new CanonicalEncodeErrorAlt('孤立的高代理字符不可编码');
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      pendingHigh = unit;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CanonicalEncodeErrorAlt('孤立的低代理字符不可编码');
    }
    let matched = false;
    for (const rule of ESCAPE_MAP_ALT) {
      if (rule.unit === unit) {
        out += rule.text;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (unit < 0x20) {
      out += '\\u' + hex4(unit);
    } else {
      out += String.fromCharCode(unit);
    }
  }
  if (pendingHigh !== -1) {
    throw new CanonicalEncodeErrorAlt('字符串以孤立的高代理字符结尾');
  }
  return out + '"';
}

function encodeNumberAlt(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new CanonicalEncodeErrorAlt('非安全整数');
  }
  if (value === 0) return '0';
  return String(value);
}

function isRecordAlt(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 协议 §4 独立编码路径：数组 chunk + join。 */
export function encodeCanonicalAlt(value: StrictJson): string {
  const chunks: string[] = [];
  encodeInto(value, chunks);
  return chunks.join('');
}

function encodeInto(value: StrictJson, chunks: string[]): void {
  if (value === null) {
    chunks.push('null');
    return;
  }
  if (typeof value === 'boolean') {
    chunks.push(value ? 'true' : 'false');
    return;
  }
  if (typeof value === 'number') {
    chunks.push(encodeNumberAlt(value));
    return;
  }
  if (typeof value === 'string') {
    chunks.push(quoteCanonicalAlt(value));
    return;
  }
  if (Array.isArray(value)) {
    chunks.push('[');
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) chunks.push(',');
      encodeInto(value[i] as StrictJson, chunks);
    }
    chunks.push(']');
    return;
  }
  if (isRecordAlt(value)) {
    const keys = Object.keys(value).sort(utf16CompareAlt);
    chunks.push('{');
    for (let i = 0; i < keys.length; i += 1) {
      if (i > 0) chunks.push(',');
      chunks.push(quoteCanonicalAlt(keys[i] as string));
      chunks.push(':');
      encodeInto(value[keys[i] as string] as StrictJson, chunks);
    }
    chunks.push('}');
    return;
  }
  throw new CanonicalEncodeErrorAlt('不支持序列化的值类型');
}

interface ProjectionAlt {
  schemaVersion: number;
  project: {
    id: string;
    title: string;
    goal: string;
    constraints: string[];
    repositories: { id: string; label: string }[];
  };
  plan: {
    nodes: ProjectDocument['plan']['nodes'];
    dependencies: ProjectDocument['plan']['dependencies'];
  };
}

/** 独立投影：显式重建全部字段（非深拷贝共享引用）。 */
function projectionAlt(doc: ProjectDocument): ProjectionAlt {
  return {
    schemaVersion: doc.schemaVersion,
    project: {
      id: doc.project.id,
      title: doc.project.title,
      goal: doc.project.goal,
      constraints: [...doc.project.constraints],
      repositories: doc.project.repositories.map((repo) => ({ id: repo.id, label: repo.label })),
    },
    plan: {
      nodes: doc.plan.nodes.map((node) => ({
        id: node.id,
        parentId: node.parentId,
        order: node.order,
        title: node.title,
        goal: node.goal,
        completionCriteria: [...node.completionCriteria],
        status: node.status,
      })),
      dependencies: doc.plan.dependencies.map((edge) => ({
        nodeId: edge.nodeId,
        requiresNodeId: edge.requiresNodeId,
      })),
    },
  };
}

function sortByIdAlt<T extends { id: string }>(items: readonly T[]): T[] {
  return items.slice().sort((a, b) => utf16CompareAlt(a.id, b.id));
}

/** 独立白名单排序：repositories/nodes 按 id，dependencies 按二元组。 */
function sortWhitelistsAlt(projection: ProjectionAlt): ProjectionAlt {
  return {
    schemaVersion: projection.schemaVersion,
    project: {
      ...projection.project,
      repositories: sortByIdAlt(projection.project.repositories),
    },
    plan: {
      ...projection.plan,
      nodes: sortByIdAlt(projection.plan.nodes),
      dependencies: projection.plan.dependencies.slice().sort((a, b) => {
        const first = utf16CompareAlt(a.nodeId, b.nodeId);
        if (first !== 0) return first;
        return utf16CompareAlt(a.requiresNodeId, b.requiresNodeId);
      }),
    },
  };
}

export interface PlanVersionComputationAlt {
  canonicalText: string;
  canonicalBytes: Uint8Array;
  planVersion: string;
}

/** 从已通过结构校验的文档计算规划指纹（独立实现）。 */
export function computePlanVersionAlt(doc: ProjectDocument, sha256: Sha256Fn): PlanVersionComputationAlt {
  const sorted = sortWhitelistsAlt(projectionAlt(doc));
  const canonicalText = encodeCanonicalAlt(sorted as unknown as StrictJson);
  const canonicalBytes = utf8Encode(canonicalText);
  return {
    canonicalText,
    canonicalBytes,
    planVersion: 'sha256:' + sha256(canonicalBytes),
  };
}

export interface PlanVersionFromTextResultAlt extends PlanVersionComputationAlt {
  issues: { code: string; path: string; message?: string }[];
}

/** 协议入口（独立实现）：StrictParse → ValidateV1 → 投影 → 规范化 → SHA-256。 */
export function planVersionFromJsonTextAlt(text: string, sha256: Sha256Fn): PlanVersionFromTextResultAlt {
  const parsed = strictParse(text);
  if (!parsed.ok) {
    return { canonicalText: '', canonicalBytes: new Uint8Array(), planVersion: '', issues: [{ code: parsed.error.code, path: '', message: parsed.error.message }] };
  }
  const validated = validateProjectDocument(parsed.value);
  if (!validated.ok) {
    return { canonicalText: '', canonicalBytes: new Uint8Array(), planVersion: '', issues: validated.issues };
  }
  const computed = computePlanVersionAlt(validated.doc, sha256);
  return { ...computed, issues: [] };
}
