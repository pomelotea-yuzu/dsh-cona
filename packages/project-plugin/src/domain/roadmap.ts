// v2 启用（tasks 4.2，design §4）：v1 → v2 只创建空里程碑集合，不动项目、节点、依赖与记录身份。
// 转换必须是纯函数：输入原文档与 sha256，输出候选文档与新指纹；调用方负责原子发布。

import { computePlanVersion } from './canonical/plan-fingerprint.js'
import { utf8Encode } from './canonical/utf8.js'
import { validateProjectDocument } from './validate.js'
import type {
  Milestone,
  MilestoneDelivery,
  Plan,
  ProjectDocument,
  RecordIndexEntry,
  Sha256Fn,
  TransformResult,
  ValidationIssue,
} from './types.js'

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

// ---------- 里程碑编辑（tasks 4.3） ----------

function fail(code: string, message: string, path = '/plan/roadmap'): { ok: false; issues: ValidationIssue[] } {
  return { ok: false, issues: [{ code, message, path }] }
}

/** 交付排序：kind 先、refId 次（UTF-16 码元序，与 canonical 排序一致）。 */
function compareDelivery(a: MilestoneDelivery, b: MilestoneDelivery): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1
  if (a.refId !== b.refId) return a.refId < b.refId ? -1 : 1
  return 0
}

/** 里程碑按 nodeId 排序，交付按 (kind, refId) 排序：写入顺序不影响指纹与 diff。 */
function sortMilestones(milestones: readonly Milestone[]): Milestone[] {
  return [...milestones]
    .map((milestone) => ({ nodeId: milestone.nodeId, deliveries: [...milestone.deliveries].sort(compareDelivery) }))
    .sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
}

export function milestoneOf(plan: Plan, nodeId: string): Milestone | null {
  return plan.roadmap?.milestones.find((item) => item.nodeId === nodeId) ?? null
}

/**
 * 设置（新建或整体替换）一个里程碑：只改目标节点的公开字段，其余里程碑原样保留。
 * 形状与自引用/重复在这里拒绝；引用能否解析由命令层按“新增／既有”区分（见 resolveDelivery）。
 */
export function setMilestone(
  plan: Plan,
  nodeId: string,
  deliveries: readonly MilestoneDelivery[],
): TransformResult<Plan> {
  if (plan.roadmap === undefined) {
    return fail('roadmap-not-enabled', '该规划未启用扩展（schemaVersion 1）；先显式启用 v2')
  }
  if (typeof nodeId !== 'string' || nodeId === '') {
    return fail('milestone-invalid-node', '缺少里程碑节点 id', '/plan/roadmap')
  }
  if (!plan.nodes.some((node) => node.id === nodeId)) {
    return fail('milestone-node-missing', `里程碑节点 ${nodeId} 不在当前树中`, '/plan/roadmap')
  }
  const seen = new Set<string>()
  for (const delivery of deliveries) {
    if (delivery.kind !== 'node' && delivery.kind !== 'record') {
      return fail('invalid-delivery-kind', "交付项 kind 必须是 'node' 或 'record'", '/plan/roadmap')
    }
    if (delivery.kind === 'node' && delivery.refId === nodeId) {
      return fail('milestone-self-delivery', '里程碑不能把自身作为交付', '/plan/roadmap')
    }
    const key = `${delivery.kind}\u0000${delivery.refId}`
    if (seen.has(key)) {
      return fail('duplicate-milestone-delivery', `交付项 ${delivery.kind}:${delivery.refId} 重复`, '/plan/roadmap')
    }
    seen.add(key)
  }
  const next: Milestone = { nodeId, deliveries: deliveries.map((item) => ({ ...item })) }
  const milestones = plan.roadmap.milestones.filter((item) => item.nodeId !== nodeId)
  return { ok: true, value: { ...plan, roadmap: { milestones: sortMilestones([...milestones, next]) } } }
}

/** 删除一个里程碑标记；不删除节点，也不改动任何执行依赖或状态。 */
export function removeMilestone(plan: Plan, nodeId: string): TransformResult<Plan> {
  if (plan.roadmap === undefined) {
    return fail('roadmap-not-enabled', '该规划未启用扩展（schemaVersion 1）')
  }
  if (!plan.roadmap.milestones.some((item) => item.nodeId === nodeId)) {
    return fail('milestone-not-found', `节点 ${nodeId} 没有里程碑条目`)
  }
  return {
    ok: true,
    value: {
      ...plan,
      roadmap: { milestones: plan.roadmap.milestones.filter((item) => item.nodeId !== nodeId) },
    },
  }
}

/**
 * 交付引用能否在当前规划中核对：节点在树中，或记录在索引中且哈希精确匹配。
 * 命令层只用它核对“新增或改变”的交付；既有失效引用保留为待核对。
 */
export function resolveDelivery(
  plan: Plan,
  records: readonly RecordIndexEntry[],
  delivery: MilestoneDelivery,
): { resolved: true } | { resolved: false; code: string; message: string } {
  if (delivery.kind === 'node') {
    return plan.nodes.some((node) => node.id === delivery.refId)
      ? { resolved: true }
      : {
          resolved: false,
          code: 'milestone-delivery-node-missing',
          message: `交付节点 ${delivery.refId} 不在当前树中`,
        }
  }
  const record = records.find((item) => item.id === delivery.refId)
  if (record === undefined) {
    return {
      resolved: false,
      code: 'milestone-delivery-record-missing',
      message: `交付记录 ${delivery.refId} 不在索引中`,
    }
  }
  if (record.contentHash !== delivery.contentHash) {
    return {
      resolved: false,
      code: 'milestone-delivery-hash-mismatch',
      message: `交付记录 ${delivery.refId} 的正文哈希与索引不一致`,
    }
  }
  return { resolved: true }
}

/** 同一 (kind, refId) 且记录哈希相同 → 视为“既有引用”，允许带着失效来源保留。 */
export function sameDelivery(a: MilestoneDelivery, b: MilestoneDelivery): boolean {
  if (a.kind !== b.kind || a.refId !== b.refId) return false
  if (a.kind === 'record' && b.kind === 'record') return a.contentHash === b.contentHash
  return true
}
