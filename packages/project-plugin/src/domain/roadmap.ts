// v2 启用（tasks 4.2，design §4）：v1 → v2 只创建空里程碑集合，不动项目、节点、依赖与记录身份。
// 转换必须是纯函数：输入原文档与 sha256，输出候选文档与新指纹；调用方负责原子发布。

import { computePlanVersion } from './canonical/plan-fingerprint.js'
import { utf8Encode } from './canonical/utf8.js'
import { validateProjectDocument } from './validate.js'
import type { ProjectDocument, Sha256Fn, ValidationIssue } from './types.js'

export type RoadmapConversionResult =
  | { ok: true; doc: ProjectDocument; fromPlanVersion: string; toPlanVersion: string }
  | { ok: false; code: string; message: string; issues?: ValidationIssue[] }

/**
 * 启用扩展规划：schemaVersion 1 → 2，`plan.roadmap.milestones` 为空数组。
 * 节点顺序、依赖、记录索引与全部 id 原样保留；v2 投影含 schemaVersion 与 roadmap，
 * 因此指纹必然变化——这正是“启用即产生新规划版本”的语义。
 */
export function convertToRoadmap(doc: ProjectDocument, sha256: Sha256Fn): RoadmapConversionResult {
  if (doc.schemaVersion === 2) {
    return { ok: false, code: 'roadmap-already-enabled', message: '该规划已启用扩展（schemaVersion 2）' }
  }
  if (doc.schemaVersion !== 1) {
    return { ok: false, code: 'unsupported-format', message: `未知的 schemaVersion ${String(doc.schemaVersion)}` }
  }
  const draft: ProjectDocument = {
    schemaVersion: 2,
    project: doc.project,
    plan: {
      nodes: doc.plan.nodes,
      dependencies: doc.plan.dependencies,
      roadmap: { milestones: [] },
    },
    planVersion: '',
    records: doc.records,
  }
  draft.planVersion = computePlanVersion(draft, sha256).planVersion
  const validated = validateProjectDocument(draft, { sha256 })
  if (!validated.ok) {
    return {
      ok: false,
      code: 'invalid-project',
      message: '启用扩展后的候选未通过领域校验',
      issues: validated.issues,
    }
  }
  return { ok: true, doc: validated.doc, fromPlanVersion: doc.planVersion, toPlanVersion: validated.doc.planVersion }
}

/**
 * 启用确认摘要：绑定预览时看到的资料字节与规划版本。
 * 预览后外部改写（排版变化也算）会改变 headHash，从而拒绝按旧预览发布。
 */
export function roadmapEnableDigest(
  input: { schemaVersion: number; planVersion: string; headHash: string },
  sha256: Sha256Fn,
): string {
  const text = ['cona:enable-roadmap', String(input.schemaVersion), input.planVersion, input.headHash].join('\n')
  return 'sha256:' + sha256(utf8Encode(text))
}
