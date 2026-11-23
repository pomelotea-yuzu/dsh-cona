// 里程碑完成记录正文（tasks 4.3，design §4「生命周期与完成证据」）。
// 首行版本标记 `<!-- cona:milestone-completion v1 -->`，紧接 `json` 围栏严格 JSON，
// 其后为可读 Markdown。结构：
//   {version:1, milestoneNodeId, inputPlanVersion, evidence:[{criterionIndex, criterionText, recordId, contentHash}]}
// 索引摘要前缀 `[cona:milestone-completion] `。本模块只处理正文与结构校验；
// 证据与索引/版本的核对由命令层与独立校验器承担。

import { strictParse } from './strict-json.js'
import { UUID_RE } from './validate-constants.js'
import type {
  MilestoneCompletionEvidence,
  ProjectDocument,
  RecordIndexEntry,
  Sha256Fn,
} from './types.js'

export type { MilestoneCompletionEvidence }

export const MILESTONE_COMPLETION_SUMMARY_PREFIX = '[cona:milestone-completion] '
export const MILESTONE_COMPLETION_VERSION_MARKER = '<!-- cona:milestone-completion v1 -->'

export interface MilestoneCompletionBody {
  version: 1
  milestoneNodeId: string
  /** 完成命令核对的输入规划指纹。 */
  inputPlanVersion: string
  evidence: MilestoneCompletionEvidence[]
}

export type MilestoneCompletionIssue = { code: string; message: string; path?: string }

function issue(code: string, message: string, path?: string): MilestoneCompletionIssue {
  return path === undefined ? { code, message } : { code, message, path }
}

const SHA256_REF = /^sha256:[0-9a-f]{64}$/
const TOP_KEYS = new Set(['version', 'milestoneNodeId', 'inputPlanVersion', 'evidence'])
const EVIDENCE_KEYS = new Set(['criterionIndex', 'criterionText', 'recordId', 'contentHash'])

/** 提取首个 ```json 围栏代码块；找不到返回 null。 */
function extractJsonFence(text: string): string | null {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trim() === '```json')
  if (start === -1) return null
  const end = lines.findIndex((line, index) => index > start && line.trim() === '```')
  if (end === -1) return null
  return lines.slice(start + 1, end).join('\n')
}

function isPlainObject(value: unknown): value is { [key: string]: unknown } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateShape(value: unknown): MilestoneCompletionBody | MilestoneCompletionIssue[] {
  if (!isPlainObject(value)) return [issue('completion-invalid', '完成正文必须是 JSON 对象')]
  if (value['version'] !== 1) {
    return [issue('completion-unknown-version', `不支持的完成正文版本 ${String(value['version'])}；当前支持 1`, '/version')]
  }
  const unknown = Object.keys(value).filter((key) => !TOP_KEYS.has(key))
  if (unknown.length > 0) {
    return [issue('completion-unknown-field', `完成正文不接受额外字段：${unknown.join('、')}`, `/${unknown[0]}`)]
  }
  const nodeId = value['milestoneNodeId']
  if (typeof nodeId !== 'string' || !UUID_RE.test(nodeId)) {
    return [issue('completion-invalid-field', 'milestoneNodeId 必须是节点 UUID', '/milestoneNodeId')]
  }
  const inputPlanVersion = value['inputPlanVersion']
  if (typeof inputPlanVersion !== 'string' || !SHA256_REF.test(inputPlanVersion)) {
    return [issue('completion-invalid-field', 'inputPlanVersion 必须是 sha256:<64 位小写十六进制>', '/inputPlanVersion')]
  }
  const evidence = value['evidence']
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return [issue('completion-evidence-empty', '逐项证据不能为空', '/evidence')]
  }
  const out: MilestoneCompletionEvidence[] = []
  for (const [index, raw] of evidence.entries()) {
    const path = `/evidence/${index}`
    if (!isPlainObject(raw)) return [issue('completion-invalid-field', '证据项必须是对象', path)]
    const extra = Object.keys(raw).filter((key) => !EVIDENCE_KEYS.has(key))
    if (extra.length > 0) {
      return [issue('completion-unknown-field', `证据项不接受额外字段：${extra.join('、')}`, `${path}/${extra[0]}`)]
    }
    if (!Number.isSafeInteger(raw['criterionIndex']) || (raw['criterionIndex'] as number) !== index) {
      return [issue('completion-evidence-order', `证据顺序必须从 0 连续（期望 ${index}）`, `${path}/criterionIndex`)]
    }
    const text = raw['criterionText']
    if (typeof text !== 'string' || text.trim() === '') {
      return [issue('completion-invalid-field', 'criterionText 必须是非空字符串', `${path}/criterionText`)]
    }
    const recordId = raw['recordId']
    if (typeof recordId !== 'string' || !UUID_RE.test(recordId)) {
      return [issue('completion-invalid-field', 'recordId 必须是记录 UUID', `${path}/recordId`)]
    }
    const contentHash = raw['contentHash']
    if (typeof contentHash !== 'string' || !SHA256_REF.test(contentHash)) {
      return [issue('completion-invalid-field', 'contentHash 必须是 sha256:<64 位小写十六进制>', `${path}/contentHash`)]
    }
    out.push({ criterionIndex: index, criterionText: text, recordId, contentHash })
  }
  return { version: 1, milestoneNodeId: nodeId, inputPlanVersion, evidence: out }
}

/** 构造完成正文：版本首行 + json 围栏 + 可读 Markdown（条件与证据逐项列出）。 */
export function buildMilestoneCompletionText(body: MilestoneCompletionBody): string {
  const json = JSON.stringify(
    {
      version: 1,
      milestoneNodeId: body.milestoneNodeId,
      inputPlanVersion: body.inputPlanVersion,
      evidence: body.evidence.map((item) => ({
        criterionIndex: item.criterionIndex,
        criterionText: item.criterionText,
        recordId: item.recordId,
        contentHash: item.contentHash,
      })),
    },
    null,
    2,
  )
  const rows = body.evidence
    .map((item) => `| ${item.criterionIndex} | ${item.criterionText} | ${item.recordId} | ${item.contentHash} |`)
    .join('\n')
  return [
    MILESTONE_COMPLETION_VERSION_MARKER,
    '',
    '```json',
    json,
    '```',
    '',
    '## 里程碑完成记录',
    '',
    `里程碑节点 **${body.milestoneNodeId}** 按以下逐项证据完成；输入规划 \`${body.inputPlanVersion}\`。`,
    '',
    '| 条件序号 | 完成条件 | 证据记录 | 正文哈希 |',
    '|---|---|---|---|',
    rows,
    '',
  ].join('\n')
}

export type ParsedMilestoneCompletion =
  | { ok: true; body: MilestoneCompletionBody }
  | { ok: false; issues: MilestoneCompletionIssue[] }

/** 解析并校验完成正文：首行标记 → json 围栏严格解析 → 形状与顺序校验。 */
export function parseMilestoneCompletionText(text: string): ParsedMilestoneCompletion {
  if (!text.startsWith(MILESTONE_COMPLETION_VERSION_MARKER)) {
    return {
      ok: false,
      issues: [issue('completion-version-marker', '正文首行不是完成记录版本标记 <!-- cona:milestone-completion v1 -->')],
    }
  }
  const fence = extractJsonFence(text)
  if (fence === null) return { ok: false, issues: [issue('completion-json-fence', '正文缺少 ```json 围栏代码块')] }
  const parsed = strictParse(fence)
  if (!parsed.ok) {
    return {
      ok: false,
      issues: [issue(parsed.error.code === 'duplicate-key' ? 'duplicate-key' : 'invalid-json', `完成正文 JSON 解析失败：${parsed.error.message}`)],
    }
  }
  const shape = validateShape(parsed.value)
  if (Array.isArray(shape)) return { ok: false, issues: shape }
  return { ok: true, body: shape }
}

// ---------- 独立核对（不依赖 DSH 与本机状态） ----------


export interface CompletionVerificationResult {
  ok: boolean
  issues: MilestoneCompletionIssue[]
  completions: { recordId: string; milestoneNodeId: string; evidenceCount: number }[]
}

/**
 * 从公开索引与正文独立核对完成记录（tasks 4.3）：
 * 记录身份与正文哈希 → 正文标记与结构 → 里程碑仍在且有条目 → 记录自身结论／主题 →
 * 每项证据的索引位置、结论、主题、受检版本与正文哈希（提供 `bodyHashOf` 时）。
 * 历史完成记录的条件原文按原记录保留，不与当前条件比较（当前性由版本判断）。
 */
export function verifyMilestoneCompletions(input: {
  doc: ProjectDocument
  /** 按记录 id 读正文；返回 null 表示不可读。 */
  textOf: (record: RecordIndexEntry) => string | null
  sha256: Sha256Fn
}): CompletionVerificationResult {
  const { doc, textOf, sha256 } = input
  const issues: MilestoneCompletionIssue[] = []
  const completions: { recordId: string; milestoneNodeId: string; evidenceCount: number }[] = []
  const indexOf = new Map<string, number>()
  doc.records.forEach((record, index) => indexOf.set(record.id, index))
  const markers = doc.plan.roadmap?.milestones.map((item) => item.nodeId) ?? []

  const bytesOf = (text: string): Uint8Array => {
    const out: number[] = []
    for (const ch of text) {
      const cp = ch.codePointAt(0)
      if (cp === undefined) continue
      if (cp < 0x80) out.push(cp)
      else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
      else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
      else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    }
    return new Uint8Array(out)
  }

  for (const [index, record] of doc.records.entries()) {
    if (record.kind !== 'verification' || !record.summary.startsWith(MILESTONE_COMPLETION_SUMMARY_PREFIX)) continue
    const path = `/records/${index}`
    const text = textOf(record)
    if (text === null) {
      issues.push(issue('completion-body-missing', `完成记录 ${record.id} 的正文不可读`, path))
      continue
    }
    const actualHash = 'sha256:' + sha256(bytesOf(text))
    if (actualHash !== record.contentHash) {
      issues.push(issue('completion-body-hash-mismatch', `完成记录 ${record.id} 的正文哈希与索引不一致`, path))
      continue
    }
    const parsed = parseMilestoneCompletionText(text)
    if (!parsed.ok) {
      issues.push(...parsed.issues.map((item) => ({ ...item, code: item.code })))
      continue
    }
    const body = parsed.body
    if (body.milestoneNodeId !== record.verification?.subject.id) {
      issues.push(issue('completion-subject-mismatch', `完成记录 ${record.id} 的索引主题与正文不一致`, path))
    }
    if (record.verification?.status !== 'pass') {
      issues.push(issue('completion-not-pass', `完成记录 ${record.id} 的索引结论不是 pass`, path))
    }
    if (!markers.includes(body.milestoneNodeId) && !doc.plan.nodes.some((node) => node.id === body.milestoneNodeId)) {
      issues.push(issue('completion-milestone-missing', `完成记录的里程碑节点 ${body.milestoneNodeId} 不在当前树中`, path))
    }
    for (const [evidenceIndex, item] of body.evidence.entries()) {
      const evidencePath = `${path}/evidence/${evidenceIndex}`
      const evidenceIndexInDoc = indexOf.get(item.recordId)
      if (evidenceIndexInDoc === undefined) {
        issues.push(issue('completion-evidence-record-missing', `证据记录 ${item.recordId} 不在索引中`, evidencePath))
        continue
      }
      if (evidenceIndexInDoc >= index) {
        issues.push(issue('completion-evidence-order', `证据记录 ${item.recordId} 必须早于完成记录发布`, evidencePath))
      }
      const evidence = doc.records[evidenceIndexInDoc]!;
      if (evidence.kind !== 'verification' || evidence.verification?.status !== 'pass') {
        issues.push(issue('completion-evidence-not-pass', `证据记录 ${item.recordId} 不是 pass 的验证记录`, evidencePath))
      }
      if (evidence.verification?.subject.id !== body.milestoneNodeId) {
        issues.push(issue('completion-evidence-subject', `证据记录 ${item.recordId} 的主题不是里程碑节点`, evidencePath))
      }
      if (evidence.verification?.subjectVersion !== body.inputPlanVersion) {
        issues.push(issue('completion-evidence-version', `证据记录 ${item.recordId} 的受检版本与输入规划不一致`, evidencePath))
      }
      if (evidence.contentHash !== item.contentHash) {
        issues.push(issue('completion-evidence-hash-mismatch', `证据记录 ${item.recordId} 的正文哈希与正文声明不一致`, evidencePath))
      } else {
        const evidenceText = textOf(evidence)
        if (evidenceText === null) {
          issues.push(issue('completion-evidence-body-missing', `证据记录 ${item.recordId} 的正文不可读`, evidencePath))
        } else if ('sha256:' + sha256(bytesOf(evidenceText)) !== evidence.contentHash) {
          issues.push(issue('completion-evidence-body-hash-mismatch', `证据记录 ${item.recordId} 的正文实际哈希与索引不一致`, evidencePath))
        }
      }
    }
    completions.push({ recordId: record.id, milestoneNodeId: body.milestoneNodeId, evidenceCount: body.evidence.length })
  }
  return { ok: issues.length === 0, issues, completions }
}
