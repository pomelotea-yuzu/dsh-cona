// R2 任务 2.1：`conaOverview` Remote 服务——owner 专用的多实例概览入口（design §2）。
//
// 与 R1 `conaProject` 分离：既有 Remote 继续只面向配置实例、对非配置实例 forbidden；
// 本入口由 owner 显式使用，按 instanceId 路由到 InstanceRuntimeRegistry。
// 只做 owner 准入、实例登记核对与结果转交；一致性/队列/修订仍由应用层负责。

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { BaselineResult } from '../application/baseline.js'
import type {
  CommandEnvelope,
  CommandResult,
  InversePreviewRequest,
  InversePreviewResult,
  UndoHistoryResult,
  UserTemplateListResult,
} from '../application/command-service.js'
import type { PresetDescriptor } from '../domain/presets.js'
import type { SnapshotResult } from '../application/snapshot.js'
import { denyNonOwner, OWNER_CONTEXT, type OwnerDenial } from './owner-admission.js'
import { parseResumeBody, selectResumeCandidate, type ResumePayload } from '../domain/resume.js'
import type { ResumeChatPointerView } from '../application/resume-chat.js'
import { FollowSessions, type FollowEventBatch, type FollowHandleView } from './follow-sessions.js'
import type { FollowResult } from '../application/snapshot.js'
import type {
  MigrationOutcome,
  MigrationPreviewResult,
  MigrationService,
} from '../application/migration.js'
import type { MigrationRecord } from '../application/local-state.js'
import type { LocationKind } from '../application/location.js'
import type { LocalStateService } from '../application/local-state.js'
import type {
  InstanceRuntimeRegistry,
  OverviewInstanceRow,
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
  /** 1.4：迁移服务（1.5 概览迁移操作；缺省时迁移入口返回 unavailable）。 */
  migration?: MigrationService;
  /** 1.4：本机运行数据根解析（迁移与登记写入的落点）。 */
  localDataRoot?: () => Promise<string | undefined>;
  /** 1.1：接入预览的资料基线读取（宿主装配；缺省时登记入口返回 unavailable）。 */
  readBaseline?: (root: string) => Promise<BaselineResult>;
  /** 1.1：显式登记入口（LocalStateService.register；缺省时登记入口返回 unavailable）。 */
  localState?: LocalStateService;
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

/** 随包预设读取结果：逐条含 ID／版本／builtin 来源／正文语言／各语言中英正文与结构。 */
export type TreePresetsResult =
  | { status: 'listed'; presets: PresetDescriptor[] }
  | { status: 'rejected'; code: string; message: string }
  | OwnerDenial;

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

/** 1.1：接入预览（位置／格式／项目身份／Git 状态），显式登记前只读。 */
export type RegisterPreviewResult =
  | {
      status: 'preview';
      sourceRoot: string;
      sourceDisplay: string;
      projectId: string;
      planVersion: string;
      headHash: string;
      recordCount: number;
      git: {
        available: boolean;
        headCommit?: string;
        branch?: string;
        dirty: boolean | 'unknown';
        unmerged: boolean | 'unknown';
      } | null;
    }
  | { status: 'rejected'; code: string; message: string }
  | OwnerDenial;

/** 1.1：显式登记结果；重复接入同一规范根回到既有实例。 */
export type RegisterSourceResult =
  | { status: 'registered'; instanceId: string; projectId: string; reused: boolean }
  | { status: 'rejected'; code: string; message: string }
  | OwnerDenial;

export interface ConaRegisterSourceRequest {
  sourceRoot: string;
  sourceKind: LocationKind;
  projectId: string;
  repositoryMaps?: { repositoryId: string; absolutePath: string }[];
}

export interface ConaMigrationRequest {
  instanceId: string;
  toRoot: string;
  toKind: LocationKind;
  operationId?: string;
}

export interface ConaMigrationRecoverRequest {
  instanceId: string;
  operationId: string;
  confirmDigest: string;
}

/** 1.5：概览迁移操作结果（application 层结果原样投影；未装配迁移服务给 unavailable）。 */
export type MigrationOpResult = MigrationOutcome | { status: 'unavailable'; message: string } | OwnerDenial;

export type MigrationPreviewOpResult = MigrationPreviewResult | { ok: false; issues: { code: string; message: string; path?: string }[] } | { status: 'unavailable'; message: string } | OwnerDenial;

export type MigrationListOpResult =
  | { ok: true; migrations: MigrationRecord[] }
  | { ok: false; issues: LocalIssueView[] }
  | { status: 'unavailable'; message: string }
  | OwnerDenial;

export interface LocalIssueView {
  code: string;
  message: string;
  path?: string;
}

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

  /** 读取随包流程预设：owner + 实例登记／可读性核对后，返回当前安装包支持的版本。 */
  @Remote('treePresets')
  async treePresets(request: { instanceId: string }): Promise<TreePresetsResult> {
    const denied = this.deny()
    if (denied !== null) return denied
    const badId = this.requireId(request?.instanceId)
    if (badId !== null) return badId
    const resolved = await this.resolveInstance(request.instanceId)
    if ('denied' in resolved) return resolved.denied
    const runtime = resolved.runtime
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    return { status: 'listed', presets: [...runtime.value.command.treePresets()] }
  }

  // ---------- 2.6：统一树编辑器的只读回读（撤销历史、用户模板目录与预览） ----------

  /** 撤销/重做历史：owner + 实例准入后从私有回执读取，不含公开资料之外的内容。 */
  @Remote('undoHistory')
  async undoHistory(request: { instanceId: string }): Promise<UndoHistoryResult> {
    const denied = this.deny()
    if (denied !== null) return { status: 'rejected', code: denied.code, message: denied.message }
    const badId = this.requireId(request?.instanceId)
    if (badId !== null) return { status: 'rejected', code: badId.code, message: badId.message }
    const resolved = await this.resolveInstance(request.instanceId)
    if ('denied' in resolved) return resolved.denied
    const runtime = resolved.runtime
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    return runtime.value.command.undoHistory(OWNER_CONTEXT, { instanceId: request.instanceId })
  }

  /** 用户模板目录：按实例读取已发布且正文有效的版本。 */
  @Remote('userTemplates')
  async userTemplates(request: { instanceId: string }): Promise<UserTemplateListResult> {
    const denied = this.deny()
    if (denied !== null) return { status: 'rejected', code: denied.code, message: denied.message }
    const badId = this.requireId(request?.instanceId)
    if (badId !== null) return { status: 'rejected', code: badId.code, message: badId.message }
    const resolved = await this.resolveInstance(request.instanceId)
    if ('denied' in resolved) return resolved.denied
    const runtime = resolved.runtime
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    return runtime.value.command.listUserTemplates(OWNER_CONTEXT, { instanceId: request.instanceId })
  }

  /** 撤销/重做预览：确认指纹与冲突对象由命令服务按当前基线重算。 */
  @Remote('previewUndo')
  async previewUndo(request: InversePreviewRequest): Promise<InversePreviewResult> {
    const denied = this.deny()
    if (denied !== null) return { status: 'unavailable', direction: request?.direction ?? 'undo', message: denied.message }
    const badId = this.requireId(request?.instanceId)
    if (badId !== null) return { status: 'unavailable', direction: request.direction, message: badId.message }
    const resolved = await this.resolveInstance(request.instanceId)
    if ('denied' in resolved) return { status: 'unavailable', direction: request.direction, message: resolved.denied.message }
    const runtime = resolved.runtime
    if (!runtime.ok) return { status: 'unavailable', direction: request.direction, message: runtime.message }
    return runtime.value.command.previewInverse(OWNER_CONTEXT, request)
  }

  /** 用户模板保存预览：从所选子树构造正文，不落盘。 */
  @Remote('previewUserTemplate')
  async previewUserTemplate(request: {
    instanceId: string; templateId: string; title: string; bodyLanguage: string; rootNodeId: string;
  }): Promise<
    | { status: 'available'; text: string; summary: string; nodeCount: number }
    | { status: 'rejected'; code: string; message: string }
  > {
    const denied = this.deny()
    if (denied !== null) return { status: 'rejected', code: denied.code, message: denied.message }
    const badId = this.requireId(request?.instanceId)
    if (badId !== null) return { status: 'rejected', code: badId.code, message: badId.message }
    const resolved = await this.resolveInstance(request.instanceId)
    if ('denied' in resolved) return resolved.denied
    const runtime = resolved.runtime
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    const result = await runtime.value.command.previewUserTemplate(OWNER_CONTEXT, request)
    if (result.status !== 'available') return { status: 'rejected', code: result.code, message: result.message }
    return { status: 'available', text: result.text, summary: result.summary, nodeCount: result.body.nodes.length }
  }

  // ---------- 1.1：接入预览与显式登记 ----------

  /** 接入预览：只读资料基线与 Git 观察，不登记、不写盘。 */
  @Remote('registerPreview')
  async registerPreview(request: { sourceRoot: string }): Promise<RegisterPreviewResult> {
    const denied = this.deny()
    if (denied !== null) return denied
    if (this.deps.readBaseline === undefined) {
      return { status: 'rejected', code: 'register-unavailable', message: '此宿主未装配资料基线读取；无法预览接入' }
    }
    if (typeof request?.sourceRoot !== 'string' || request.sourceRoot === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少 sourceRoot' }
    }
    const baseline = await this.deps.readBaseline(request.sourceRoot)
    if (!baseline.ok) {
      const first = baseline.issues[0]
      return {
        status: 'rejected',
        code: first?.code ?? 'invalid-project',
        message: baseline.issues.map((issue) => issue.message).join('；') || '资料根不可读',
      }
    }
    return {
      status: 'preview',
      sourceRoot: request.sourceRoot,
      sourceDisplay: this.deps.localRootDisplay(request.sourceRoot),
      projectId: baseline.baseline.projectId,
      planVersion: baseline.baseline.planVersion,
      headHash: baseline.baseline.headHash,
      recordCount: baseline.baseline.records.length,
      git: baseline.baseline.git ?? null,
    }
  }

  /** 显式登记：位置／Git 状态已预览后由 owner 确认；重复接入同一规范根回到既有实例。 */
  @Remote('registerSource')
  async registerSource(request: ConaRegisterSourceRequest): Promise<RegisterSourceResult> {
    const denied = this.deny()
    if (denied !== null) return denied
    if (this.deps.localState === undefined || this.deps.localDataRoot === undefined) {
      return { status: 'rejected', code: 'register-unavailable', message: '此宿主未装配本机登记服务；无法显式登记' }
    }
    if (typeof request?.sourceRoot !== 'string' || request.sourceRoot === ''
      || typeof request.projectId !== 'string' || request.projectId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: 'sourceRoot 与 projectId 必须是非空字符串' }
    }
    const localRoot = await this.deps.localDataRoot()
    if (localRoot === undefined) {
      return { status: 'rejected', code: 'local-root-missing', message: '无法确定本机运行数据根' }
    }
    const outcome = await this.deps.localState.register({
      localDataRoot: localRoot,
      sourceRoot: request.sourceRoot,
      sourceKind: request.sourceKind,
      projectId: request.projectId,
      ...(Array.isArray(request.repositoryMaps) && request.repositoryMaps.length > 0
        ? { repositoryMaps: request.repositoryMaps }
        : {}),
    })
    if (!outcome.ok) {
      const first = outcome.issues[0]
      return {
        status: 'rejected',
        code: first?.code ?? 'register-failed',
        message: outcome.issues.map((issue) => issue.message).join('；') || '登记失败',
      }
    }
    return {
      status: 'registered',
      instanceId: outcome.entry.instanceId,
      projectId: outcome.entry.projectId,
      reused: outcome.reused,
    }
  }

  // ---------- 1.5：概览迁移操作 ----------

  /** 迁移预览：位置／占用／工作守卫诊断进 checks，不落盘。 */
  @Remote('migrationPreview')
  async migrationPreview(request: ConaMigrationRequest): Promise<MigrationPreviewOpResult> {
    const denied = this.deny()
    if (denied !== null) return denied
    if (this.deps.migration === undefined || this.deps.localDataRoot === undefined) {
      return { status: 'unavailable', message: '此宿主未装配迁移服务' }
    }
    const badId = this.requireId(request?.instanceId)
    if (badId !== null) return badId
    if (typeof request.toRoot !== 'string' || request.toRoot === '') {
      return { ok: false, issues: [{ code: 'operation-mismatch', message: '缺少 toRoot' }] }
    }
    const localRoot = await this.deps.localDataRoot()
    if (localRoot === undefined) {
      return { ok: false, issues: [{ code: 'local-root-missing', message: '无法确定本机运行数据根' }] }
    }
    return this.deps.migration.preview({
      localDataRoot: localRoot,
      instanceId: request.instanceId,
      toRoot: request.toRoot,
      toKind: request.toKind,
    })
  }

  /** 迁移确认：事务化 prepared → 复制装入 → target-ready → 切换 → committed。 */
  @Remote('migrationRun')
  async migrationRun(request: ConaMigrationRequest): Promise<MigrationOpResult> {
    const denied = this.deny()
    if (denied !== null) return denied
    if (this.deps.migration === undefined || this.deps.localDataRoot === undefined) {
      return { status: 'unavailable', message: '此宿主未装配迁移服务' }
    }
    const badId = this.requireId(request?.instanceId)
    if (badId !== null) return badId
    if (typeof request.toRoot !== 'string' || request.toRoot === '') {
      return { ok: false, issues: [{ code: 'operation-mismatch', message: '缺少 toRoot' }] }
    }
    const localRoot = await this.deps.localDataRoot()
    if (localRoot === undefined) {
      return { ok: false, issues: [{ code: 'local-root-missing', message: '无法确定本机运行数据根' }] }
    }
    return this.deps.migration.migrate({
      localDataRoot: localRoot,
      instanceId: request.instanceId,
      toRoot: request.toRoot,
      toKind: request.toKind,
      ...(typeof request.operationId === 'string' ? { operationId: request.operationId } : {}),
    })
  }

  /** 迁移恢复（重启后继续／补齐）：确认摘要必须与登记的原请求摘要一致。 */
  @Remote('migrationRecover')
  async migrationRecover(request: ConaMigrationRecoverRequest): Promise<MigrationOpResult> {
    const denied = this.deny()
    if (denied !== null) return denied
    if (this.deps.migration === undefined || this.deps.localDataRoot === undefined) {
      return { status: 'unavailable', message: '此宿主未装配迁移服务' }
    }
    const badId = this.requireId(request?.instanceId)
    if (badId !== null) return badId
    if (typeof request.operationId !== 'string' || request.operationId === ''
      || typeof request.confirmDigest !== 'string' || request.confirmDigest === '') {
      return { ok: false, issues: [{ code: 'operation-mismatch', message: 'operationId 与 confirmDigest 必须是非空字符串' }] }
    }
    const localRoot = await this.deps.localDataRoot()
    if (localRoot === undefined) {
      return { ok: false, issues: [{ code: 'local-root-missing', message: '无法确定本机运行数据根' }] }
    }
    return this.deps.migration.recover({
      localDataRoot: localRoot,
      instanceId: request.instanceId,
      operationId: request.operationId,
      confirmDigest: request.confirmDigest,
    })
  }

  /** 迁移取消：未切换才可取消；只清理有所有权证据且内容核对过的候选。 */
  @Remote('migrationCancel')
  async migrationCancel(request: ConaMigrationRecoverRequest): Promise<MigrationOpResult> {
    const denied = this.deny()
    if (denied !== null) return denied
    if (this.deps.migration === undefined || this.deps.localDataRoot === undefined) {
      return { status: 'unavailable', message: '此宿主未装配迁移服务' }
    }
    const badId = this.requireId(request?.instanceId)
    if (badId !== null) return badId
    if (typeof request.operationId !== 'string' || request.operationId === ''
      || typeof request.confirmDigest !== 'string' || request.confirmDigest === '') {
      return { ok: false, issues: [{ code: 'operation-mismatch', message: 'operationId 与 confirmDigest 必须是非空字符串' }] }
    }
    const localRoot = await this.deps.localDataRoot()
    if (localRoot === undefined) {
      return { ok: false, issues: [{ code: 'local-root-missing', message: '无法确定本机运行数据根' }] }
    }
    return this.deps.migration.cancel({
      localDataRoot: localRoot,
      instanceId: request.instanceId,
      operationId: request.operationId,
      confirmDigest: request.confirmDigest,
    })
  }

  /** 迁移记录列表：诊断与恢复入口（requestDigest 用于重复确认核对）。 */
  @Remote('migrationList')
  async migrationList(): Promise<MigrationListOpResult> {
    const denied = this.deny()
    if (denied !== null) return denied
    if (this.deps.migration === undefined || this.deps.localDataRoot === undefined) {
      return { status: 'unavailable', message: '此宿主未装配迁移服务' }
    }
    const localRoot = await this.deps.localDataRoot()
    if (localRoot === undefined) {
      return { ok: false, issues: [{ code: 'local-root-missing', message: '无法确定本机运行数据根' }] }
    }
    const result = await this.deps.migration.listMigrations({ localDataRoot: localRoot })
    if (!result.ok) return { ok: false, issues: result.issues }
    return { ok: true, migrations: result.migrations }
  }

  /** 按实例执行命令（owner 保存接续用）；实例身份由 envelope 与路由双重核对。 */
  @Remote('execute')  async execute(request: ConaOverviewExecuteRequest): Promise<CommandResult> {
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
