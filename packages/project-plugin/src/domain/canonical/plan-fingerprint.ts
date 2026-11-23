// v1-plan 规划指纹：主实现（协议 §2–§4）。
// 独立第二实现见 plan-fingerprint-alt.ts；两者不得共享序列化代码路径。
// 散列通过 Sha256Fn 注入，domain 不依赖 Node crypto。

import { utf8Encode } from './utf8.js';
import { validateProjectDocument } from '../validate.js';
import type { ProjectDocument, Sha256Fn, ValidationIssue } from '../types.js';
import { strictParse } from '../strict-json.js';
import type { StrictJson } from '../strict-json.js';

export class CanonicalEncodeError extends Error {
  constructor(
    public readonly code:
      | 'unsupported-value'
      | 'non-integer'
      | 'unpaired-surrogate',
    message: string,
  ) {
    super(message);
    this.name = 'CanonicalEncodeError';
  }
}

const CONTROL_ESCAPES = new Map<number, string>([
  [0x08, '\\b'],
  [0x09, '\\t'],
  [0x0a, '\\n'],
  [0x0c, '\\f'],
  [0x0d, '\\r'],
]);

/** 协议 §3 唯一字符串编码。逐码点处理；控制字符固定四位小写十六进制；其余原样。 */
export function quoteCanonical(value: string): string {
  let out = '"';
  for (const ch of value) {
    const cp = ch.codePointAt(0) as number;
    if (cp >= 0xd800 && cp <= 0xdfff) {
      throw new CanonicalEncodeError('unpaired-surrogate', '孤立代理字符不可编码');
    }
    if (cp === 0x22) {
      out += '\\"';
    } else if (cp === 0x5c) {
      out += '\\\\';
    } else if (cp < 0x20) {
      const simple = CONTROL_ESCAPES.get(cp);
      out += simple ?? `\\u${cp.toString(16).padStart(4, '0')}`;
    } else {
      out += ch;
    }
  }
  return out + '"';
}

function isPlainObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 协议 §4：逐键写入，键按 UTF-16 码元序（不插入普通对象后整体 stringify）。 */
export function encodeCanonical(value: StrictJson): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalEncodeError('non-integer', `非安全整数：${String(value)}`);
    }
    // String(-0) === '0'，负零归一由上游解析完成，此处双保险。
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (typeof value === 'string') return quoteCanonical(value);
  if (Array.isArray(value)) {
    return '[' + value.map((item) => encodeCanonical(item)).join(',') + ']';
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const parts: string[] = [];
    for (const key of keys) {
      parts.push(quoteCanonical(key) + ':' + encodeCanonical(value[key] as StrictJson));
    }
    return '{' + parts.join(',') + '}';
  }
  throw new CanonicalEncodeError('unsupported-value', '不支持序列化的值类型');
}

/** UTF-16 码元字典序比较器（协议 §2）。JS 的 < 即码元序，显式写出以固定语义。 */
export function utf16Compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortByPredicate<T>(items: readonly T[], compare: (a: T, b: T) => number): T[] {
  return [...items].sort(compare);
}

/** 规划投影：仅提取 {schemaVersion, project, plan}，排除 planVersion 与 records。 */
export function planProjection(doc: ProjectDocument): { schemaVersion: number; project: ProjectDocument['project']; plan: ProjectDocument['plan'] } {
  return {
    schemaVersion: doc.schemaVersion,
    project: doc.project,
    plan: doc.plan,
  };
}

/** v2 路线图排序：里程碑按 nodeId，里程碑内交付按 (kind, refId) 的 UTF-16 序。 */
function sortRoadmap(roadmap: NonNullable<ProjectDocument['plan']['roadmap']>): NonNullable<ProjectDocument['plan']['roadmap']> {
  return {
    milestones: sortByPredicate(roadmap.milestones, (a, b) => utf16Compare(a.nodeId, b.nodeId)).map((milestone) => ({
      nodeId: milestone.nodeId,
      deliveries: sortByPredicate(milestone.deliveries, (a, b) => {
        const byKind = utf16Compare(a.kind, b.kind);
        if (byKind !== 0) return byKind;
        return utf16Compare(a.refId, b.refId);
      }).map((delivery) => (delivery.kind === 'record'
        ? { kind: 'record' as const, refId: delivery.refId, contentHash: delivery.contentHash }
        : { kind: 'node' as const, refId: delivery.refId })),
    })),
  };
}

/** 三条白名单集合按协议 §2 排序（副本排序，不修改调用者输入）；v2 另排 roadmap。 */
export function sortProjectionWhitelists<
  P extends { project: { repositories: { id: string }[] }; plan: { nodes: { id: string }[]; dependencies: { nodeId: string; requiresNodeId: string }[]; roadmap?: ProjectDocument['plan']['roadmap'] } },
>(projection: P): P {
  const roadmap = projection.plan.roadmap;
  return {
    ...projection,
    project: {
      ...projection.project,
      repositories: sortByPredicate(projection.project.repositories, (a, b) => utf16Compare(a.id, b.id)),
    },
    plan: {
      ...projection.plan,
      nodes: sortByPredicate(projection.plan.nodes, (a, b) => utf16Compare(a.id, b.id)),
      dependencies: sortByPredicate(projection.plan.dependencies, (a, b) => {
        const byNode = utf16Compare(a.nodeId, b.nodeId);
        if (byNode !== 0) return byNode;
        return utf16Compare(a.requiresNodeId, b.requiresNodeId);
      }),
      ...(roadmap === undefined ? {} : { roadmap: sortRoadmap(roadmap) }),
    },
  } as P;
}

export interface PlanVersionComputation {
  canonicalText: string;
  canonicalBytes: Uint8Array;
  planVersion: string;
}

/** 从已通过结构校验的文档计算规划指纹。 */
export function computePlanVersion(doc: ProjectDocument, sha256: Sha256Fn): PlanVersionComputation {
  const projection = sortProjectionWhitelists(planProjection(doc));
  const canonicalText = encodeCanonical(projection as unknown as StrictJson);
  const canonicalBytes = utf8Encode(canonicalText);
  return {
    canonicalText,
    canonicalBytes,
    planVersion: 'sha256:' + sha256(canonicalBytes),
  };
}

export interface PlanVersionFromTextResult extends PlanVersionComputation {
  issues: ValidationIssue[];
  /** 非致命诊断（4.3）：已保存但当前不可核对的交付引用；不影响指纹。 */
  diagnostics: ValidationIssue[];
}

/**
 * 协议入口：StrictParse → ValidateV1（完整文档；未知字段先拒绝）→ 投影 → 规范化 → SHA-256。
 * planVersion 字段的格式在 ValidateV1 中核对；其与重算值的等值比较由调用方完成。
 */
export function planVersionFromJsonText(text: string, sha256: Sha256Fn): PlanVersionFromTextResult {
  const parsed = strictParse(text);
  if (!parsed.ok) {
    return {
      canonicalText: '', canonicalBytes: new Uint8Array(), planVersion: '',
      issues: [{ code: parsed.error.code, path: '', message: parsed.error.message }], diagnostics: [],
    };
  }
  const validated = validateProjectDocument(parsed.value);
  if (!validated.ok) {
    return { canonicalText: '', canonicalBytes: new Uint8Array(), planVersion: '', issues: validated.issues, diagnostics: [] };
  }
  const computed = computePlanVersion(validated.doc, sha256);
  return { ...computed, issues: [], diagnostics: validated.diagnostics };
}
