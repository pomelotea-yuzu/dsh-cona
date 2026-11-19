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
  | { status: 'card'; recordId: string; path: string; payload: ResumePayload; codeObservation: CodeObservationView }
  | { status: 'empty' }
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
    return { status: 'card', recordId: candidate.id, path: candidate.path, payload: parsed.payload, codeObservation }
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
