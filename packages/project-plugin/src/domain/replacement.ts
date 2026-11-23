// 结构化替代记录（tasks 2.2，design §2「两类公开记录的正文与互操作」）。
// 替代正文：UTF-8、无 BOM；首行版本标记 `<!-- cona:replacement v1 -->`，
// 紧接一个 `json` 围栏代码块（严格 JSON：拒绝重复键、未知版本、未知字段、
// 非安全整数），其后为可读 Markdown。两个互斥形状：
//   replace：{version, kind:"replace", sourceNodeIds, replacementNodeId}
//   clear  ：{version, kind:"clear", clearsRecordId}
// 索引摘要前缀 `[cona:replacement] `。本模块只处理正文与结构校验；
// 发布、索引与命令原子性由应用层承担，链式投影由独立校验器承担。

import { strictParse } from './strict-json.js';
import { UUID_RE } from './validate-constants.js';

export const REPLACEMENT_SUMMARY_PREFIX = '[cona:replacement] ';
export const REPLACEMENT_VERSION_MARKER = '<!-- cona:replacement v1 -->';

export interface ReplacementReplaceBody {
  version: 1;
  kind: 'replace';
  /** 非空且不重复的来源节点 UUID。 */
  sourceNodeIds: string[];
  /** 保留节点 UUID；不得出现在来源数组中。 */
  replacementNodeId: string;
}

export interface ReplacementClearBody {
  version: 1;
  kind: 'clear';
  /** 解除目标的记录 UUID；必须已发布且在当前索引中更早。 */
  clearsRecordId: string;
}

export type ReplacementBody = ReplacementReplaceBody | ReplacementClearBody;

export type ReplacementIssue = { code: string; message: string; path?: string };

function issue(code: string, message: string, path?: string): ReplacementIssue {
  return path === undefined ? { code, message } : { code, message, path };
}

const REPLACE_KEYS = new Set(['version', 'kind', 'sourceNodeIds', 'replacementNodeId']);
const CLEAR_KEYS = new Set(['version', 'kind', 'clearsRecordId']);

/** 从正文中提取首个 ```json 围栏代码块；找不到返回 null。 */
function extractJsonFence(text: string): string | null {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === '```json');
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && line.trim() === '```');
  if (end === -1) return null;
  return lines.slice(start + 1, end).join('\n');
}

function isPlainObject(value: unknown): value is { [key: string]: unknown } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uuidIssue(value: unknown, path: string): ReplacementIssue | null {
  return typeof value === 'string' && UUID_RE.test(value) ? null : issue('replacement-invalid-field', '必须是节点 UUID', path);
}

/** 校验解析后的对象形状：互斥、精确字段集、UUID 与引用约束。 */
function validateBodyShape(value: unknown): ReplacementBody | ReplacementIssue[] {
  if (!isPlainObject(value)) {
    return [issue('replacement-invalid', '替代正文必须是 JSON 对象')];
  }
  const version = value['version'];
  const kind = value['kind'];
  if (version !== 1) {
    return [issue('replacement-unknown-version', `不支持的替代正文版本 ${String(version)}；当前支持 1`, '/version')];
  }
  const keys = new Set(Object.keys(value));
  if (kind === 'replace') {
    const unknown = [...keys].filter((key) => !REPLACE_KEYS.has(key));
    if (unknown.length > 0) {
      return [issue('replacement-unknown-field', `replace 形状不接受额外字段：${unknown.join('、')}`, `/${unknown[0]}`)];
    }
    const sources = value['sourceNodeIds'];
    if (!Array.isArray(sources) || sources.length === 0) {
      return [issue('replacement-invalid-field', 'sourceNodeIds 必须是非空数组', '/sourceNodeIds')];
    }
    const seen = new Set<string>();
    for (const [index, id] of sources.entries()) {
      const uuidIssueResult = uuidIssue(id, `/sourceNodeIds/${index}`);
      if (uuidIssueResult !== null) return [uuidIssueResult];
      if (seen.has(id as string)) {
        return [issue('replacement-invalid-field', `来源节点 ${String(id)} 重复`, `/sourceNodeIds/${index}`)];
      }
      seen.add(id as string);
    }
    const replacement = value['replacementNodeId'];
    const replacementIssue = uuidIssue(replacement, '/replacementNodeId');
    if (replacementIssue !== null) return [replacementIssue];
    if (seen.has(replacement as string)) {
      return [issue('replacement-self-referential', '保留节点不得出现在来源数组中', '/replacementNodeId')];
    }
    return {
      version: 1,
      kind: 'replace',
      sourceNodeIds: sources as string[],
      replacementNodeId: replacement as string,
    };
  }
  if (kind === 'clear') {
    const unknown = [...keys].filter((key) => !CLEAR_KEYS.has(key));
    if (unknown.length > 0) {
      return [issue('replacement-unknown-field', `clear 形状不接受额外字段：${unknown.join('、')}`, `/${unknown[0]}`)];
    }
    const target = value['clearsRecordId'];
    const targetIssue = uuidIssue(target, '/clearsRecordId');
    if (targetIssue !== null) return [targetIssue];
    return { version: 1, kind: 'clear', clearsRecordId: target as string };
  }
  return [issue('replacement-invalid-kind', `未知替代正文 kind ${String(kind)}；只支持 replace 与 clear`, '/kind')];
}

/** 构造替代正文（replace 形状）：版本首行 + json 围栏 + 可读 Markdown。 */
export function buildReplacementReplaceText(body: ReplacementReplaceBody): string {
  const json = JSON.stringify(
    { version: 1, kind: 'replace', sourceNodeIds: [...body.sourceNodeIds], replacementNodeId: body.replacementNodeId },
    null,
    2,
  );
  const sources = body.sourceNodeIds.map((id) => `- ${id}`).join('\n');
  return [
    REPLACEMENT_VERSION_MARKER,
    '',
    '```json',
    json,
    '```',
    '',
    `## 节点替代记录`,
    '',
    `来源节点已合并到保留节点 **${body.replacementNodeId}**，来源以原 ID 保留为已取消状态：`,
    '',
    sources,
    '',
  ].join('\n');
}

/** 构造解除正文（clear 形状）。 */
export function buildReplacementClearText(body: ReplacementClearBody): string {
  const json = JSON.stringify({ version: 1, kind: 'clear', clearsRecordId: body.clearsRecordId }, null, 2);
  return [
    REPLACEMENT_VERSION_MARKER,
    '',
    '```json',
    json,
    '```',
    '',
    '## 替代关系解除记录',
    '',
    `解除记录 ${body.clearsRecordId} 建立的全部替代关系；原替代正文继续保留。`,
    '',
  ].join('\n');
}

export type ParsedReplacement =
  | { ok: true; body: ReplacementBody }
  | { ok: false; issues: ReplacementIssue[] };

/** 解析并校验替代正文：首行版本标记 → json 围栏严格解析 → 形状校验。 */
export function parseReplacementText(text: string): ParsedReplacement {
  if (!text.startsWith(REPLACEMENT_VERSION_MARKER)) {
    return { ok: false, issues: [issue('replacement-version-marker', '正文首行不是替代记录版本标记 <!-- cona:replacement v1 -->')] };
  }
  const fence = extractJsonFence(text);
  if (fence === null) {
    return { ok: false, issues: [issue('replacement-json-fence', '正文缺少 ```json 围栏代码块')] };
  }
  const parsed = strictParse(fence);
  if (!parsed.ok) {
    return { ok: false, issues: [issue(parsed.error.code === 'duplicate-key' ? 'duplicate-key' : 'invalid-json', `替代正文 JSON 解析失败：${parsed.error.message}`)] };
  }
  const body = validateBodyShape(parsed.value);
  if (Array.isArray(body)) return { ok: false, issues: body };
  return { ok: true, body };
}
