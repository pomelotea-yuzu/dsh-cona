// R2 任务 2.1：`conaOverview` Remote 服务——owner 专用的多实例概览入口（design §2）。
//
// 与 R1 `conaProject` 分离：既有 Remote 继续只面向配置实例、对非配置实例 forbidden；
// 本入口由 owner 显式使用，按 instanceId 路由到 InstanceRuntimeRegistry。
// 只做 owner 准入、实例登记核对与结果转交；一致性/队列/修订仍由应用层负责。

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { CommandEnvelope, CommandResult } from '../application/command-service.js'
import type { SnapshotResult } from '../application/snapshot.js'
import { denyNonOwner, OWNER_CONTEXT, type OwnerDenial } from './owner-admission.js'
import { parseResumeBody, selectResumeCandidate, type ResumePayload } from '../domain/resume.js'
import type { ResumeChatPointerView } from '../application/resume-chat.js'
import { FollowSessions, type FollowEventBatch, type FollowHandleView } from './follow-sessions.js'
import type { FollowResult } from '../application/snapshot.js'
import {
  InstanceRuntimeRegistry,
  type OverviewInstanceRow,
} from './instance-runtime-registry.js'
import type {
  ConaExecuteRequest,
  ConaProjectStatus,
  ConaSnapshotRequest,
  FollowOutcome,
} from './project-service.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    conaOverview: ConaOverviewService
  }
}

export interface ConaOverviewServiceDeps {
  registry: InstanceRuntimeRegistry;
  /** 本机根显示路径（home 折叠）；与 conaProject 同一实现。 */
  localRootDisplay: (root: string) => string;
}

export interface ConaOverviewSnapshotRequest extends ConaSnapshotRequest {
  instanceId: string;
}

export interface ConaOverviewExecuteRequest extends ConaExecuteRequest {
  instanceId: string;
}

export interface ConaOverviewFollowRequest {
  instanceId: string;
  afterStateRevision?: number;
}

/** 代码观察（3.2）：观察成功带 HEAD 与脏计数；未配置/不可观察给稳定状态。 */
export type CodeObservationView =
  | { status: 'observed'; head: string; dirtyCount: number }
  | { status: 'not-configured' }
  | { status: 'unavailable'; reason: string };

/** 接续卡片读取结果：卡片载荷、空态，或稳定诊断（不可读时不回退）。 */
export type ResumeCardResult =
  | {
      status: 'card';
      recordId: string;
      /** 候选正文哈希（索引级）；打开会话前按它复查记录版本。 */
      contentHash: string;
      path: string;
      payload: ResumePayload;
      codeObservation: CodeObservationView;
      /** 本机聊天指针投影（3.3）；本机状态不可读时不阻塞卡片。 */
      chat: ResumeChatPointerView;
    }
  | { status: 'empty' }
  | { status: 'rejected'; code: string; message: string }
  | OwnerDenial;

/** 保存表单的聊天选项：本实例的本机链接（用户明确选择其一，可不选）。 */
export interface ResumeChatChoiceView {
  linkId: string;
  sessionId: string;
  purpose: string;
  nodeIds: string[];
  /** 宿主列表可见性；null 表示目录不可用（未知，不冒充失效）。 */
  visible: boolean | null;
}

export type ResumeChatsResult =
  | { status: 'listed'; chats: ResumeChatChoiceView[] }
  | { status: 'unavailable'; reason: string }
  | { status: 'rejected'; code: string; message: string }
  | OwnerDenial;

export interface ConaResumeChatsRequest {
  instanceId: string;
}

export interface ConaLinkResumeRequest {
  instanceId: string;
  recordId: string;
  linkId: string;
}

export type ResumeLinkResult =
  | { status: 'linked'; recordId: string; linkId: string; contentHash: string; reused: boolean }
  | { status: 'rejected'; code: string; message: string }
  | OwnerDenial;

export interface ConaResumeChatTargetRequest {
  instanceId: string;
  recordId: string;
  contentHash: string;
  linkId: string;
}

export type ResumeChatTargetResult =
  | { status: 'ok'; sessionId: string }
  | { status: 'rejected'; code: string; message: string }
  | OwnerDenial;

export interface ConaResumeCandidateRequest {
  instanceId: string;
}

/** owner 概览实例列表结果。 */
export type OverviewListResult =
  | { status: 'listed'; instances: OverviewInstanceRow[] }
  | { status: 'unconfigured'; message: string }
  | OwnerDenial;

export class ConaOverviewService extends TypertRemoteService {
  private readonly follows = new FollowSessions()

  constructor(ctx: Context, private readonly deps: ConaOverviewServiceDeps) {
    super(ctx, 'conaOverview')
  }

  private deny(): OwnerDenial {
    return denyNonOwner(this.ctx)
  }

  /**
   * 定向实例准入 + 按需装配：未登记直接拒绝（不返回诊断），
   * 已登记则复用或懒打开其运行时。返回 undefined 表示未登记。
   */
  private async resolveInstance(instanceId: string): Promise<
    | { denied: { status: 'rejected'; code: string; message: string } }
    | { runtime: import('./project-service.js').RuntimeResult }
  > {
    const known = await this.deps.registry.knownInstanceIds()
    if (!known.has(instanceId)) {
      return { denied: { status: 'rejected', code: 'forbidden', message: '实例未登记' } }
    }
    const runtime = await this.deps.registry.openKnown(instanceId)
    if (runtime === undefined) {
      return { denied: { status: 'rejected', code: 'forbidden', message: '实例未登记' } }
    }
    return { runtime }
  }

  /** 校验 instanceId 非空；返回拒绝或 null。 */
  private requireId(instanceId: unknown): OwnerDenial {
    if (typeof instanceId !== 'string' || instanceId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少 instanceId' }
    }
    return null
  }

  /** 本机已登记实例，逐条标注可读/不可读诊断。 */
  @Remote('instances')
  async instances(): Promise<OverviewListResult> {
    const denied = this.deny()
    if (denied !== null) return denied
    const known = await this.deps.registry.knownInstanceIds()
    if (known.size === 0) {
      return { status: 'unconfigured', message: '没有已登记实例' }
    }
    return { status: 'listed', instances: await this.deps.registry.overviewRows() }
  }

  /** 按实例的面板启动信息，与 conaProject/status 同形，供同一 PanelController 使用。 */
  @Remote('status')
  async status(request: { instanceId: string }): Promise<ConaProjectStatus> {
    const denied = this.deny()
    if (denied !== null) {
      return {
        configured: false, instanceId: null, projectId: null, sourceKind: null,
        sourceDisplay: null, localRootDisplay: null, created: false,
        error: { code: denied.code, message: denied.message },
      }
    }
    const badId = this.requireId(request?.instanceId)
    if (badId !== null) {
      return {
        configured: false, instanceId: null, projectId: null, sourceKind: null,
        sourceDisplay: null, localRootDisplay: null, created: false, error: badId,
      }
    }
    const resolved = await this.resolveInstance(request.instanceId)
    if ('denied' in resolved) {
      return {
        configured: false, instanceId: null, projectId: null, sourceKind: null,
        sourceDisplay: null, localRootDisplay: null, created: false, error: resolved.denied,
      }
    }
    const runtime = resolved.runtime
    if (!runtime.ok) {
      return {
        configured: false, instanceId: null, projectId: null, sourceKind: null,
        sourceDisplay: null, localRootDisplay: null, created: false,
        error: { code: runtime.code, message: runtime.message },
      }
    }
    const instance = runtime.value.instance
    return {
      configured: true,
      instanceId: instance.instanceId,
      projectId: instance.projectId,
      sourceKind: instance.sourceKind,
      sourceDisplay: instance.sourceDisplay,
      localRootDisplay: this.deps.localRootDisplay(instance.localRoot),
      created: instance.created,
      error: null,
    }
  }

  /**
   * 接续卡片：从当前已接纳索引选唯一候选并读正文投影（design §3）。
   * 无候选→empty；候选不可读→稳定诊断且不回退；一次最多解码一条。
   */
  @Remote('resumeCandidate')
  async resumeCandidate(request: ConaResumeCandidateRequest): Promise<ResumeCardResult> {
    const denied = this.deny()
    if (denied !== null) return denied
    const badId = this.requireId(request?.instanceId)
    if (badId !== null) return badId
    const resolved = await this.resolveInstance(request.instanceId)
    if ('denied' in resolved) return resolved.denied
    const runtime = resolved.runtime
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    if (runtime.value.recordReader === undefined) {
      return { status: 'rejected', code: 'record-reader-unavailable', message: '此宿主未提供正文读取器' }
    }
    // 读完整快照（含已接纳的完整记录索引），不在 client 重复选取逻辑。
    const snap = await runtime.value.snapshot.read(OWNER_CONTEXT, {
      instanceId: request.instanceId,
      connectionGeneration: 0,
    })
    if (snap.status === 'rejected') return { status: 'rejected', code: snap.code, message: snap.message }
    if (snap.status === 'unsynced') {
      return { status: 'rejected', code: 'resume-unsynced', message: `资料未同步：${snap.reason}` }
    }
    const candidate = selectResumeCandidate(snap.snapshot.records)
    if (candidate === null) return { status: 'empty' }
    const read = await runtime.value.recordReader.readRecord(candidate.path, candidate.contentHash)
    if (!read.ok) return { status: 'rejected', code: read.code, message: read.message }
    const parsed = parseResumeBody(read.body)
    if (!parsed.ok) return { status: 'rejected', code: parsed.code, message: parsed.message }
    // 代码观察只读、失败不阻塞卡片；未配置该实例映射时如实显示"未配置"。
    const observed = runtime.value.observeWorkCopy?.(request.instanceId)
    const codeObservation: CodeObservationView =
      observed === null || observed === undefined
        ? { status: 'not-configured' }
        : observed.status === 'observed'
          ? { status: 'observed', head: observed.head, dirtyCount: observed.dirtyCount }
          : { status: 'unavailable', reason: observed.reason }
    // 本机聊天指针投影（3.3）：聚合不可读/隔离时不阻塞卡片，给 unavailable 原因。
    // savedAt 传入用于区分「记录来自其他环境（指针不在本机）」与「本机保存未关联」。
    const chat = await runtime.value.resumeChats.view(candidate.id, candidate.contentHash, parsed.payload.savedAt)
    return {
      status: 'card',
      recordId: candidate.id,
      contentHash: candidate.contentHash,
      path: candidate.path,
      payload: parsed.payload,
      codeObservation,
      chat,
    }
  }

  /** 保存表单的聊天选项：本实例的本机链接（含失效可见性）；本机状态不可读给 unavailable。 */
  @Remote('resumeChats')
  async resumeChats(request: ConaResumeChatsRequest): Promise<ResumeChatsResult> {
    const denied = this.deny()
    if (denied !== null) return denied
    const badId = this.requireId(request?.instanceId)
    if (badId !== null) return badId
    const resolved = await this.resolveInstance(request.instanceId)
    if ('denied' in resolved) return resolved.denied
    const runtime = resolved.runtime
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    const outcome = await runtime.value.chats.listChats()
    if (outcome.status !== 'committed') {
      // 本机聚合缺失（干净 profile）或隔离：选项不可用，保存仍可不关联聊天继续。
      return { status: 'unavailable', reason: `${outcome.code}: ${outcome.message}` }
    }
    return {
      status: 'listed',
      chats: outcome.value.links.map((link) => ({
        linkId: link.linkId,
        sessionId: link.sessionId,
        purpose: link.purpose,
        nodeIds: [...link.nodeIds],
        visible: link.visible,
      })),
    }
  }

  /** 保存接续后的聊天指针：幂等写本机聚合；失败不影响已保存的公开记录。 */
  @Remote('linkResume')
  async linkResume(request: ConaLinkResumeRequest): Promise<ResumeLinkResult> {
    const denied = this.deny()
    if (denied !== null) return denied
    const badId = this.requireId(request?.instanceId)
    if (badId !== null) return badId
    if (typeof request.recordId !== 'string' || request.recordId === ''
      || typeof request.linkId !== 'string' || request.linkId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: 'recordId 与 linkId 必须是非空字符串' }
    }
    const resolved = await this.resolveInstance(request.instanceId)
    if ('denied' in resolved) return resolved.denied
    const runtime = resolved.runtime
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    const outcome = await runtime.value.resumeChats.link({ recordId: request.recordId, linkId: request.linkId })
    if (outcome.status === 'committed') {
      return {
        status: 'linked',
        recordId: outcome.value.recordId,
        linkId: outcome.value.linkId,
        contentHash: outcome.value.contentHash,
        reused: outcome.value.reused,
      }
    }
    // unknown-state 与 rejected 都如实返回稳定码；公开记录数不变。
    return { status: 'rejected', code: outcome.code, message: outcome.message }
  }

  /** 打开原聊天前的复查：记录版本、指针、链接与宿主实际 Session；导航由 client 完成。 */
  @Remote('resumeChatTarget')
  async resumeChatTarget(request: ConaResumeChatTargetRequest): Promise<ResumeChatTargetResult> {
    const denied = this.deny()
    if (denied !== null) return denied
    const badId = this.requireId(request?.instanceId)
    if (badId !== null) return badId
    if (typeof request.recordId !== 'string' || request.recordId === ''
      || typeof request.contentHash !== 'string' || request.contentHash === ''
      || typeof request.linkId !== 'string' || request.linkId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: 'recordId/contentHash/linkId 必须是非空字符串' }
    }
    const resolved = await this.resolveInstance(request.instanceId)
    if ('denied' in resolved) return resolved.denied
    const runtime = resolved.runtime
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    const target = await runtime.value.resumeChats.resolveTarget({
      recordId: request.recordId,
      contentHash: request.contentHash,
      linkId: request.linkId,
    })
    if (target.status === 'ok') return { status: 'ok', sessionId: target.sessionId }
    return { status: 'rejected', code: target.code, message: target.message }
  }

  /** 按实例读完整快照；沿用 R1 的连接代际/源代际检查。 */
  @Remote('snapshot')
  async snapshot(request: ConaOverviewSnapshotRequest): Promise<SnapshotResult> {
    const denied = this.deny()
    if (denied !== null) return denied
    const badId = this.requireId(request.instanceId)
    if (badId !== null) return badId
    const resolved = await this.resolveInstance(request.instanceId)
    if ('denied' in resolved) return resolved.denied
    const runtime = resolved.runtime
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    const connectionGeneration = request.connectionGeneration ?? 0
    if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 0) {
      return { status: 'rejected', code: 'operation-mismatch', message: 'connectionGeneration 必须是非负整数' }
    }
    return runtime.value.snapshot.read(OWNER_CONTEXT, {
      instanceId: request.instanceId,
      connectionGeneration,
      ...(request.minStateRevision === undefined ? {} : { minStateRevision: request.minStateRevision }),
    })
  }

  /** 按实例建立失效订阅；句柄表与既有 conaProject 隔离，避免浏览切换误关对方订阅。 */
  @Remote('follow')
  async follow(request: ConaOverviewFollowRequest): Promise<FollowOutcome<FollowHandleView>> {
    const denied = this.deny()
    if (denied !== null) return denied
    const badId = this.requireId(request.instanceId)
    if (badId !== null) return badId
    const resolved = await this.resolveInstance(request.instanceId)
    if ('denied' in resolved) return resolved.denied
    const runtime = resolved.runtime
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    if (request.afterStateRevision !== undefined
      && (!Number.isSafeInteger(request.afterStateRevision) || request.afterStateRevision < 0)) {
      return { status: 'rejected', code: 'operation-mismatch', message: 'afterStateRevision 必须是非负整数' }
    }
    const result: FollowResult = await runtime.value.snapshot.follow(OWNER_CONTEXT, {
      instanceId: request.instanceId,
      ...(request.afterStateRevision === undefined ? {} : { afterStateRevision: request.afterStateRevision }),
    })
    if (result.status !== 'following') return result
    return { status: 'following', value: this.follows.start(randomUUID(), request.instanceId, result) }
  }

  @Remote('followEvents')
  async followEvents(request: { subscriptionId: string }): Promise<FollowEventBatch | OwnerDenial> {
    const denied = this.deny()
    if (denied !== null) return denied
    if (typeof request.subscriptionId !== 'string' || request.subscriptionId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少 subscriptionId' }
    }
    return this.follows.drain(request.subscriptionId)
  }

  @Remote('followClose')
  async followClose(request: { subscriptionId: string }): Promise<{ closed: boolean } | OwnerDenial> {
    const denied = this.deny()
    if (denied !== null) return denied
    if (typeof request.subscriptionId !== 'string' || request.subscriptionId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少 subscriptionId' }
    }
    return { closed: this.follows.dispose(request.subscriptionId) }
  }

  /** 按实例执行命令（owner 保存接续用）；实例身份由 envelope 与路由双重核对。 */
  @Remote('execute')
  async execute(request: ConaOverviewExecuteRequest): Promise<CommandResult> {
    const denied = this.deny()
    if (denied !== null) return denied
    const badId = this.requireId(request.instanceId)
    if (badId !== null) return badId
    const resolved = await this.resolveInstance(request.instanceId)
    if ('denied' in resolved) return resolved.denied
    const runtime = resolved.runtime
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    if (request.projectId !== undefined && request.projectId !== runtime.value.instance.projectId) {
      return { status: 'rejected', code: 'forbidden', message: '命令项目与实例不一致' }
    }
    const envelope: CommandEnvelope = {
      operationId: request.operationId,
      projectId: runtime.value.instance.projectId,
      instanceId: runtime.value.instance.instanceId,
      sourceEpoch: request.sourceEpoch ?? runtime.value.instance.sourceEpoch,
      expectedPlanVersion: request.expectedPlanVersion,
      expectedPlanRevision: request.expectedPlanRevision,
      command: request.command,
    }
    return runtime.value.command.execute(OWNER_CONTEXT, envelope)
  }
}
