// 接续记录领域模块（R2 任务 3.1，design §3）：
// 在 R1 的 execution-note 之上定义可移植的「接着上次做」正文。
// 边界：本模块只做纯函数——构造正文/摘要、解析与校验、从索引选候选。
// 不读文件、不算哈希、不依赖 Node/DOM；哈希与正文完整性由应用层按 R1 规则核对。
//
// 协议（写入公开资料，v1）：
//   summary = "[cona:resume] " + 简短停点
//   正文首行独占 "<!-- cona:resume v1 -->"，下一行 ```json fenced block，
//   block 内是严格 JSON 的 ResumePayload，随后是同一输入生成的可读 Markdown。
// 不改 R1 索引字段与 schemaVersion（严格校验拒绝未知字段）。

import { strictParse, type StrictJson } from './strict-json.js'
import { utf8Encode } from './canonical/utf8.js'
import type { RecordIndexEntry, VerificationStatus } from './types.js'

/** summary 保留前缀（精确，含尾随空格）。 */
export const RESUME_SUMMARY_PREFIX = '[cona:resume] ';
/** 正文标记首行。 */
export const RESUME_BODY_MARKER = '<!-- cona:resume v1 -->';
/** 当前正文版本。 */
export const RESUME_VERSION = 1;
/** 单次投影最多解码的正文字节数（UTF-8）。 */
export const RESUME_MAX_BODY_BYTES = 64 * 1024;

export type NextStepKind = 'suggested' | 'confirmed';

/** 历史验证引用：只投影状态与标签，追溯到原记录 id。 */
export interface ResumeVerification {
  status: VerificationStatus;
  /** 原验证记录 id 或节点 id。 */
  subjectId: string;
  /** 可读标签（来自验证记录 subject）。 */
  label?: string;
}

/** 接续正文的结构化载荷（公开，可移植）。不含本机聊天指针/机器路径/授权。 */
export interface ResumePayload {
  version: 1;
  /** 停点（必填，trim 后非空）：上次做到哪里。 */
  stoppedAt: string;
  /** 下一步（必填，trim 后非空）。 */
  nextStep: string;
  /** 下一步是建议还是已确认安排。 */
  nextStepKind: NextStepKind;
  /** 保存时刻（UTC instant，由调用方提供）。 */
  savedAt: string;
  /** 可选：简短成果。 */
  outcome?: string;
  /** 可选：已有决定或约束。 */
  decisions?: string;
  /** 可选：未解决问题。 */
  openIssues?: string;
  /** 可选：历史验证引用（按实际状态渲染，不改成当前通过）。 */
  verifications?: ResumeVerification[];
}

export type BuildResumeResult =
  | { ok: true; summary: string; body: string; payload: ResumePayload }
  | { ok: false; code: string; message: string };

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

/** 校验载荷必填与形状；不在此处生成时间。 */
export function validateResumePayload(input: unknown): { ok: true; value: ResumePayload } | { ok: false; code: string; message: string } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'resume-shape', message: '接续正文必须是对象' }
  }
  const obj = input as Record<string, unknown>
  if (obj['version'] !== RESUME_VERSION) {
    return { ok: false, code: 'resume-version', message: `不支持的接续版本：${String(obj['version'])}` }
  }
  if (!nonEmpty(obj['stoppedAt'])) {
    return { ok: false, code: 'resume-required', message: '停点不能为空' }
  }
  if (!nonEmpty(obj['nextStep'])) {
    return { ok: false, code: 'resume-required', message: '下一步不能为空' }
  }
  if (obj['nextStepKind'] !== 'suggested' && obj['nextStepKind'] !== 'confirmed') {
    return { ok: false, code: 'resume-shape', message: '下一步类型必须是 suggested 或 confirmed' }
  }
  if (!nonEmpty(obj['savedAt'])) {
    return { ok: false, code: 'resume-required', message: '保存时刻不能为空' }
  }
  for (const key of ['outcome', 'decisions', 'openIssues'] as const) {
    const value = obj[key]
    if (value !== undefined && typeof value !== 'string') {
      return { ok: false, code: 'resume-shape', message: `${key} 必须是字符串` }
    }
  }
  if (obj['verifications'] !== undefined) {
    if (!Array.isArray(obj['verifications'])) {
      return { ok: false, code: 'resume-shape', message: 'verifications 必须是数组' }
    }
    for (const item of obj['verifications']) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        return { ok: false, code: 'resume-shape', message: '验证引用必须是对象' }
      }
      const v = item as Record<string, unknown>
      if (!['pass', 'fail', 'blocked', 'untested'].includes(String(v['status']))) {
        return { ok: false, code: 'resume-shape', message: '验证状态非法' }
      }
      if (!nonEmpty(v['subjectId'])) {
        return { ok: false, code: 'resume-shape', message: '验证引用缺少 subjectId' }
      }
      if (v['label'] !== undefined && typeof v['label'] !== 'string') {
        return { ok: false, code: 'resume-shape', message: '验证标签必须是字符串' }
      }
    }
  }
  const payload: ResumePayload = { version: RESUME_VERSION, stoppedAt: obj['stoppedAt'], nextStep: obj['nextStep'], nextStepKind: obj['nextStepKind'], savedAt: obj['savedAt'] }
  for (const key of ['outcome', 'decisions', 'openIssues'] as const) {
    const value = obj[key]
    if (typeof value === 'string') (payload as unknown as Record<string, unknown>)[key] = value
  }
  if (Array.isArray(obj['verifications'])) {
    payload.verifications = (obj['verifications'] as Record<string, unknown>[]).map((v) => {
      const out: ResumeVerification = { status: v['status'] as VerificationStatus, subjectId: v['subjectId'] as string }
      if (typeof v['label'] === 'string') out.label = v['label']
      return out
    })
  }
  return { ok: true, value: payload }
}

/** 由用户可编辑输入构造 payload 并校验必填。 */
export function buildPayload(input: Omit<ResumePayload, 'version'>): { ok: true; value: ResumePayload } | { ok: false; code: string; message: string } {
  return validateResumePayload({ ...input, version: RESUME_VERSION })
}

/** 生成带前缀 summary 与版本化正文。停点取 trim 后内容，前缀后只放简短可读停点。 */
export function buildResume(input: Omit<ResumePayload, 'version'>): BuildResumeResult {
  const checked = buildPayload(input)
  if (!checked.ok) return checked
  const payload = checked.value
  const json = JSON.stringify(payload, null, 2)
  const readable = readableMarkdown(payload)
  const body = `${RESUME_BODY_MARKER}\n\`\`\`json\n${json}\n\`\`\`\n\n${readable}\n`
  return { ok: true, summary: `${RESUME_SUMMARY_PREFIX}${payload.stoppedAt.trim()}`, body, payload }
}

/** 可读 Markdown：与结构化 JSON 由同一 payload 生成，便于人类核对。 */
function readableMarkdown(payload: ResumePayload): string {
  const lines: string[] = ['# 工作接续', '', `**停点**：${payload.stoppedAt.trim()}`, '', `**下一步（${payload.nextStepKind === 'confirmed' ? '已确认' : '建议'}）**：${payload.nextStep.trim()}`]
  if (payload.outcome !== undefined && payload.outcome.trim() !== '') lines.push('', `**成果**：${payload.outcome.trim()}`)
  if (payload.decisions !== undefined && payload.decisions.trim() !== '') lines.push('', `**已有决定**：${payload.decisions.trim()}`)
  if (payload.openIssues !== undefined && payload.openIssues.trim() !== '') lines.push('', `**未解决问题**：${payload.openIssues.trim()}`)
  if (payload.verifications !== undefined && payload.verifications.length > 0) {
    lines.push('', '**历史验证**（保留当时状态，不代表当前通过）：')
    for (const v of payload.verifications) lines.push(`- ${v.status}：${v.label ?? v.subjectId}`)
  }
  return lines.join('\n')
}

/** summary 是否带接续标记（索引级识别，无需读正文）。 */
export function hasResumePrefix(summary: string): boolean {
  return typeof summary === 'string' && summary.startsWith(RESUME_SUMMARY_PREFIX)
}

export type ParseResumeResult =
  | { ok: true; payload: ResumePayload }
  | { ok: false; code: string; message: string };

/**
 * 解析接续正文：只认 marker 首行 + 紧随的 ```json fenced block。
 * 严格 JSON（拒重复键/孤立代理/不安全整数），载荷再过 validateResumePayload。
 * 不在此处核内容哈希（应用层按 R1 路径/哈希核对）。
 */
export function parseResumeBody(body: string): ParseResumeResult {
  if (typeof body !== 'string') return { ok: false, code: 'resume-unreadable', message: '正文不是字符串' }
  const bytes = utf8Encode(body)
  if (bytes.length > RESUME_MAX_BODY_BYTES) {
    return { ok: false, code: 'resume-too-large', message: `正文超过 ${RESUME_MAX_BODY_BYTES} 字节上限` }
  }
  const lines = body.split('\n')
  if (lines[0] !== RESUME_BODY_MARKER) {
    return { ok: false, code: 'resume-marker', message: '缺少接续版本标记' }
  }
  // 跳过首行后的空行，找到 ```json 开栏
  let i = 1
  while (i < lines.length && lines[i]?.trim() === '') i++
  if (lines[i] !== '```json') {
    return { ok: false, code: 'resume-block', message: '缺少 JSON 代码块' }
  }
  i++
  const jsonLines: string[] = []
  while (i < lines.length && lines[i] !== '```') {
    jsonLines.push(lines[i] ?? '')
    i++
  }
  if (i >= lines.length) {
    return { ok: false, code: 'resume-block', message: 'JSON 代码块未闭合' }
  }
  const parsed = strictParse(jsonLines.join('\n'))
  if (!parsed.ok) {
    return { ok: false, code: 'resume-invalid-json', message: `接续 JSON 非法：${parsed.error.code}` }
  }
  const checked = validateResumePayload(parsed.value as StrictJson)
  if (!checked.ok) return checked
  return { ok: true, payload: checked.value }
}

/**
 * 从已接纳索引尾部向前选唯一候选：首个 kind==='execution-note' 且 summary 带前缀者。
 * 跳过普通记录与其他 kind；返回候选索引条目，未找到返回 null。
 * 选取本身不读正文，调用方最多解码该候选一条、失败即停止且不回退。
 */
export function selectResumeCandidate(records: readonly RecordIndexEntry[]): RecordIndexEntry | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]
    if (record === undefined) continue
    if (record.kind === 'execution-note' && hasResumePrefix(record.summary)) return record
  }
  return null
}
