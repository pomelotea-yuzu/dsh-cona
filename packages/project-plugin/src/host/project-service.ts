// `conaProject` Remote 服务（tasks 5.2，design §5）：面板的只读快照与统一命令入口。
//
// 准入：只有宿主真实生成的 owner invocation 才放行（`ctx.invocation` 存在、
// peer 主体 owner、`principalOf(invocation)` 为空）；缺 invocation 不降级为进程内 owner，
// 也不把业务参数当身份。Agent 工具入口不在本服务范围（第 6 段）。
//
// 边界：本文件只做准入、参数补齐与结果转交；一致性读取、命令序列、隔离与修订都在应用层。
// 运行时（实例 + 两个应用服务）由宿主在配置解析与资料打开后提供；未配置时面板得到明确码。

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { denyNonOwner, OWNER_CONTEXT, type OwnerDenial } from './owner-admission.js'
import type {
  Command,
  CommandEnvelope,
  CommandResult,
  ProjectCommandService,
  TrustedContext,
} from '../application/command-service.js'
import type { FollowResult } from '../application/snapshot.js'
import type { PresetDescriptor } from '../domain/presets.js'
import { FollowSessions, type FollowEventBatch, type FollowHandleView } from './follow-sessions.js'
import type { ConversationOutcome, ChatsView } from '../application/conversations.js'
import { ConversationService } from '../application/conversations.js'
import type {
  AdmissionResult,
  ContinueScopeRequest,
  WorkAction,
  WorkContext,
  WorkListView,
  WorkOutcome,
} from '../application/work.js'
import { WorkService } from '../application/work.js'
import type { ProjectSnapshotService, SnapshotResult } from '../application/snapshot.js'
import type { OpenedInstance } from './bootstrap.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    conaProject: ConaProjectService
  }
}

/** follow 建订阅结果（V32）：following 带句柄与 ready；拒绝带稳定码。 */
export type FollowOutcome<T> =
  | { status: 'following'; value: T }
  | { status: 'rejected'; code: string; message: string };

/** 面板启动信息：是否已配置、打开到哪个实例、位置显示与失败原因。 */
export interface ConaProjectStatus {
  configured: boolean;
  instanceId: string | null;
  projectId: string | null;
  sourceKind: string | null;
  sourceDisplay: string | null;
  localRootDisplay: string | null;
  created: boolean;
  error: { code: string; message: string } | null;
}

export interface ConaSnapshotRequest {
  /** 连接代际；面板重连后递增。缺省按 0 处理（无 follow 时不做过期判定）。 */
  connectionGeneration?: number;
  /** 订阅 ready 报出的最高修订。 */
  minStateRevision?: number;
}

export interface ConaExecuteRequest {
  operationId: string;
  command: Command;
  expectedPlanVersion: string;
  expectedPlanRevision: number;
  instanceId?: string;
  projectId?: string;
  sourceEpoch?: number;
}

/** 创建聊天请求：意图登记 + 宿主创建（可能复用空白会话）+ 落链接，一次调用内完成。 */
export interface ConaCreateChatRequest {
  operationId: string;
  nodeIds: string[];
  purpose: string;
  origin?: 'panel' | 'agent';
}

/** 认领（关联）请求：reconcile 候选确认，或直接关联已知会话。 */
export interface ConaLinkChatRequest extends ConaCreateChatRequest {
  sessionId: string;
}

export interface ConaUnlinkChatRequest {
  operationId: string;
  linkId: string;
  nodeIds?: string[];
}

/** 工作意图登记请求（tasks 6.2）：目标集合、允许动作、原因范围与确认时输入基线。 */
export interface ConaWorkPrepareRequest {
  workIntentId: string;
  nodeIds: string[];
  allowedActions: WorkAction[];
  reasonScope: 'public' | 'local';
  purpose: string;
  origin?: 'panel' | 'agent';
  baseline: { planVersion: string; planRevision: number; sourceEpoch: number };
  /** 3.3：根组重排许可（单独授予）。 */
  rootGroupAllowed?: boolean;
  /** 3.3：插入模板精确授权（内置版本／用户模板记录与哈希）。 */
  templates?: import('../application/local-state.js').WorkTemplateAuthorization[];
}

/** “开始工作”确认：登记期望消息来源（Client prompt requestId ＝ source.rpcId）。 */
export interface ConaWorkStartRequest {
  workIntentId: string;
  /** 期望消息 rpcId；面板不预知时可省略，改按 sessionId 匹配下一条用户消息。 */
  rpcId?: string;
  sessionId?: string;
}

/**
 * 消息准入观测（design §7 映射）：宿主真实事件经适配器转发。
 * queued＝agent/inbox/spliced target=next-turn（只登记）；consumed＝消息被消费（首次匹配启动 WorkRun）；
 * turn-end＝turn/end completed／aborted（真实终态；预告 stopping 不作数）。
 */
export interface ConaWorkObserveRequest {
  kind: 'queued' | 'consumed' | 'turn-end' | 'cancel';
  sessionId: string;
  /** queued／consumed 必填：期望或被消费消息的来源 id。 */
  rpcId?: string;
  /** consumed／turn-end 必填：消费或结束所在 turn。 */
  turn?: number;
  /** consumed 必填：消费点是否有实际 Agent 归属。 */
  agentPresent?: boolean;
  /** turn-end 必填：真实终态种类。 */
  endKind?: 'completed' | 'aborted';
}

/** 已打开实例 + 按路径读并核哈希的记录正文读取器。 */
export interface RecordBodyReader {
  /**
   * 按公开资料内的相对路径读记录正文并核对其 contentHash。
   * 返回 UTF-8 文本；不存在/越界/哈希不符时给稳定拒绝码，不返回半截内容。
   */
  readRecord(path: string, expectedHash: string): Promise<
    | { ok: true; body: string }
    | { ok: false; code: string; message: string }
  >;
}

/** 已打开的运行时：实例 + 四个应用服务 + 正文读取器。 */
export interface ConaProjectRuntime {
  instance: OpenedInstance;
  snapshot: ProjectSnapshotService;
  command: ProjectCommandService;
  chats: ConversationService;
  /** 接续聊天指针（3.3）：公开记录与本地聊天链接的私有结构。 */
  resumeChats: import('../application/resume-chat.js').ResumeChatService;
  work: WorkService;
  /** 接续卡片用；未装配读取器时 resumeCard 给明确拒绝码。 */
  recordReader?: RecordBodyReader;
  /** 每实例只读工作副本观察（3.2）；未配置该实例映射时返回 null。 */
  observeWorkCopy?: (instanceId: string) => import('../adapters/fs/work-copy.js').WorkCopyObservation | null;
  /** 每实例分析范围服务（3.1-3.5）：仓库映射、预览、观察、读取与引用复核。 */
  analysis?: import('../application/analysis-scope.js').AnalysisScopeService;
  /** 每实例分析 Session 生命周期（4.1-4.2）：本机记录、专用 preset 新建与关联登记。 */
  analysisSession?: import('../application/analysis-session.js').AnalysisSessionService;
}

export type RuntimeResult =
  | { ok: true; value: ConaProjectRuntime }
  | { ok: false; code: string; message: string };

export interface ConaProjectServiceDeps {
  /** 懒装配：首次调用时解析配置并打开资料；失败结果被记忆，不再重试。 */
  runtime: () => Promise<RuntimeResult>;
  localRootDisplay: (root: string) => string;
}

const OWNER: TrustedContext = OWNER_CONTEXT

/** `conaProject`：面板读取与保存的唯一 Remote 入口。 */
export class ConaProjectService extends TypertRemoteService {
  /** follow 订阅句柄表（V32）：HTTP Client 以句柄拉取失效事件，替代纯 snapshot 轮询。 */
  private readonly follows = new FollowSessions()

  constructor(
    ctx: Context,
    private readonly deps: ConaProjectServiceDeps,
  ) {
    super(ctx, 'conaProject')
  }

  /** 面板启动信息：只读，不含资料内容。 */
  @Remote('status')
  async status(): Promise<ConaProjectStatus> {
    const runtime = await this.deps.runtime()
    if (!runtime.ok) {
      return {
        configured: false,
        instanceId: null,
        projectId: null,
        sourceKind: null,
        sourceDisplay: null,
        localRootDisplay: null,
        created: false,
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

  /** 完整快照；未配置或资料不可读时返回稳定拒绝码，不返回半截内容。 */
  @Remote('snapshot')
  async snapshot(request: ConaSnapshotRequest): Promise<SnapshotResult> {
    const denied = this.deny()
    if (denied !== null) return denied
    const runtime = await this.deps.runtime()
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    const connectionGeneration = request.connectionGeneration ?? 0
    if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 0) {
      return { status: 'rejected', code: 'operation-mismatch', message: 'connectionGeneration 必须是非负整数' }
    }
    return runtime.value.snapshot.read(OWNER, {
      instanceId: runtime.value.instance.instanceId,
      connectionGeneration,
      ...(request.minStateRevision === undefined ? {} : { minStateRevision: request.minStateRevision }),
    })
  }

  /**
   * 建立失效订阅（V32）：先订阅再回读。返回 ready 与 subscriptionId；
   * 事件经 followEvents 拉取（HTTP unary 载体无法直接消费 typert stream 的 AsyncIterable）。
   * 新订阅由应用层 nextGeneration 关闭同实例旧订阅，句柄表同步标记旧句柄关闭。
   */
  @Remote('follow')
  async follow(request: { instanceId?: string; afterStateRevision?: number }): Promise<FollowOutcome<FollowHandleView>> {
    const denied = this.deny()
    if (denied !== null) return denied
    const runtime = await this.deps.runtime()
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    const instanceId = request.instanceId ?? runtime.value.instance.instanceId
    if (instanceId !== runtime.value.instance.instanceId) {
      return { status: 'rejected', code: 'forbidden', message: '订阅实例与已配置实例不一致' }
    }
    if (request.afterStateRevision !== undefined
      && (!Number.isSafeInteger(request.afterStateRevision) || request.afterStateRevision < 0)) {
      return { status: 'rejected', code: 'operation-mismatch', message: 'afterStateRevision 必须是非负整数' }
    }
    const result: FollowResult = await runtime.value.snapshot.follow(OWNER, {
      instanceId,
      ...(request.afterStateRevision === undefined ? {} : { afterStateRevision: request.afterStateRevision }),
    })
    if (result.status !== 'following') return result
    const subscriptionId = randomUUID()
    return { status: 'following', value: this.follows.start(subscriptionId, instanceId, result) }
  }

  /** 拉取订阅的新失效事件（含 ready 作为首事件）；无新事件返回空批，不阻塞。 */
  @Remote('followEvents')
  async followEvents(request: { subscriptionId: string }): Promise<FollowEventBatch | { status: 'rejected'; code: string; message: string }> {
    const denied = this.deny()
    if (denied !== null) return denied
    if (typeof request.subscriptionId !== 'string' || request.subscriptionId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少 subscriptionId' }
    }
    return this.follows.drain(request.subscriptionId)
  }

  /** 关闭订阅句柄（面板卸载／重连释放）；重复关闭返回 false。 */
  @Remote('followClose')
  async followClose(request: { subscriptionId: string }): Promise<{ closed: boolean } | { status: 'rejected'; code: string; message: string }> {
    const denied = this.deny()
    if (denied !== null) return denied
    if (typeof request.subscriptionId !== 'string' || request.subscriptionId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少 subscriptionId' }
    }
    return { closed: this.follows.dispose(request.subscriptionId) }
  }

  /** 读取随包流程预设：owner + 配置实例可读后返回当前安装包支持的版本。 */
  @Remote('treePresets')
  async treePresets(): Promise<
    | { status: 'listed'; presets: PresetDescriptor[] }
    | { status: 'rejected'; code: string; message: string }
    | OwnerDenial
  > {
    const denied = this.deny()
    if (denied !== null) return denied
    const runtime = await this.deps.runtime()
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    return { status: 'listed', presets: [...runtime.value.command.treePresets()] }
  }

  /** 统一命令入口：与 CLI 同一应用服务，面板不能绕过校验。 */
  @Remote('execute')
  async execute(request: ConaExecuteRequest): Promise<CommandResult> {
    const denied = this.deny()
    if (denied !== null) return denied
    const runtime = await this.deps.runtime()
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    const instance = runtime.value.instance
    if (request.instanceId !== undefined && request.instanceId !== instance.instanceId) {
      return { status: 'rejected', code: 'forbidden', message: '命令实例与已配置实例不一致' }
    }
    if (request.projectId !== undefined && request.projectId !== instance.projectId) {
      return { status: 'rejected', code: 'forbidden', message: '命令项目与已配置实例不一致' }
    }
    const envelope: CommandEnvelope = {
      operationId: request.operationId,
      projectId: instance.projectId,
      instanceId: instance.instanceId,
      sourceEpoch: request.sourceEpoch ?? instance.sourceEpoch,
      expectedPlanVersion: request.expectedPlanVersion,
      expectedPlanRevision: request.expectedPlanRevision,
      command: request.command,
    }
    return runtime.value.command.execute(OWNER, envelope)
  }

  /** 聊天关联列表（含失效检查与待核对意图）；只读。 */
  @Remote('chats')
  async chats(): Promise<ConversationOutcome<ChatsView>> {
    const denied = this.deny()
    if (denied !== null) return denied
    const runtime = await this.deps.runtime()
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    return runtime.value.chats.listChats()
  }

  /**
   * 创建聊天（tasks 6.1）：意图先落盘 → 宿主 create（可能复用空白会话）→ 核对实际返回身份 → 落链接。
   * 宿主结果未知时意图保留 pending，由 reconcileChats 核对；本入口绝不自动重试创建。
   */
  @Remote('createChat')
  async createChat(request: ConaCreateChatRequest): Promise<ConversationOutcome<{ sessionId: string; linkId: string; reusedBlank: boolean }>> {
    const denied = this.deny()
    if (denied !== null) return denied
    const runtime = await this.deps.runtime()
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    return runtime.value.chats.createChat({
      operationId: request.operationId,
      nodeIds: request.nodeIds,
      purpose: request.purpose,
      ...(request.origin === undefined ? {} : { origin: request.origin }),
    })
  }

  /** 关联已知会话（含 reconcile 候选的显式认领）；核对宿主列表中的实际身份后才落盘。 */
  @Remote('linkChat')
  async linkChat(request: ConaLinkChatRequest): Promise<ConversationOutcome<{ linkId: string; reused: boolean }>> {
    const denied = this.deny()
    if (denied !== null) return denied
    const runtime = await this.deps.runtime()
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    if (typeof request.sessionId !== 'string' || request.sessionId === '') {
      return { status: 'rejected', code: 'session-identity-missing', message: 'Session 身份缺失或为空' }
    }
    return runtime.value.chats.linkChat({
      operationId: request.operationId,
      sessionId: request.sessionId,
      nodeIds: request.nodeIds,
      purpose: request.purpose,
      ...(request.origin === undefined ? {} : { origin: request.origin }),
    })
  }

  /** 解除关联：缺省删除整条链接，给出 nodeIds 时只移除这些节点。 */
  @Remote('unlinkChat')
  async unlinkChat(request: ConaUnlinkChatRequest): Promise<ConversationOutcome<{ removed: boolean }>> {
    const denied = this.deny()
    if (denied !== null) return denied
    const runtime = await this.deps.runtime()
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    return runtime.value.chats.unlinkChat({
      operationId: request.operationId,
      linkId: request.linkId,
      ...(request.nodeIds === undefined ? {} : { nodeIds: request.nodeIds }),
    })
  }

  /** 待核对：对每个未决聊天意图给出宿主候选，不写链接、不再创建。 */
  @Remote('reconcileChats')
  async reconcileChats(): Promise<ConversationOutcome<ChatsView>> {
    const denied = this.deny()
    if (denied !== null) return denied
    const runtime = await this.deps.runtime()
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    return runtime.value.chats.reconcileChats()
  }

  /** 工作意图与运行列表（含生效性标注：重启后旧代际不再有写资格）；只读。 */
  @Remote('workList')
  async workList(): Promise<WorkOutcome<WorkListView>> {
    const denied = this.deny()
    if (denied !== null) return denied
    const runtime = await this.deps.runtime()
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    return runtime.value.work.listWork()
  }

  /** 登记工作意图（pending）：目标集合、允许动作、原因范围与输入基线；范围尚未生效。 */
  @Remote('workPrepare')
  async workPrepare(request: ConaWorkPrepareRequest): Promise<WorkOutcome<{ workIntentId: string; reused: boolean }>> {
    const denied = this.deny()
    if (denied !== null) return denied
    const runtime = await this.deps.runtime()
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    return runtime.value.work.prepareWork({
      workIntentId: request.workIntentId,
      nodeIds: request.nodeIds,
      allowedActions: request.allowedActions,
      reasonScope: request.reasonScope,
      purpose: request.purpose,
      baseline: request.baseline,
      ...(request.origin === undefined ? {} : { origin: request.origin }),
      ...(request.rootGroupAllowed === undefined ? {} : { rootGroupAllowed: request.rootGroupAllowed }),
      ...(request.templates === undefined ? {} : { templates: request.templates.map((item) => ({ ...item })) }),
    })
  }

  /** “开始工作”：确认具体范围并登记期望消息来源；基线过期拒绝，先刷新再确认。 */
  @Remote('workStart')
  async workStart(request: ConaWorkStartRequest): Promise<WorkOutcome<{ workIntentId: string; status: 'awaiting-message' }>> {
    const denied = this.deny()
    if (denied !== null) return denied
    const runtime = await this.deps.runtime()
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    return runtime.value.work.startWork({
      workIntentId: request.workIntentId,
      ...(request.rpcId === undefined ? {} : { rpcId: request.rpcId }),
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    })
  }

  /** 显式停止：立即停止新写准入；已进入发布的操作按提交恢复协议核对。 */
  @Remote('workStop')
  async workStop(request: { workRunId: string }): Promise<WorkOutcome<{ stopped: boolean }>> {
    const denied = this.deny()
    if (denied !== null) return denied
    const runtime = await this.deps.runtime()
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    if (typeof request.workRunId !== 'string' || request.workRunId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少 workRunId' }
    }
    return runtime.value.work.stopWork(request.workRunId)
  }

  /**
   * 有来源运行上下文（tasks 6.4）：owner 按运行当前状态读取目标／约束／基线／相关记录／
   * 聊天入口与三类条目（决定／建议／未核查）。上下文是背景信息，不替代程序化授权。
   */
  @Remote('workContext')
  async workContext(request: { workRunId: string }): Promise<WorkOutcome<WorkContext>> {
    const denied = this.deny()
    if (denied !== null) return denied
    const runtime = await this.deps.runtime()
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    if (typeof request.workRunId !== 'string' || request.workRunId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少 workRunId' }
    }
    return runtime.value.work.contextForRunRemote(request.workRunId)
  }

  /** 显式接续（tasks 6.4）：owner 把新目标纳入活动运行范围；版本 +1 并保留接续原因。 */
  @Remote('workContinue')
  async workContinue(request: Omit<ContinueScopeRequest, 'origin'>): Promise<WorkOutcome<{ workRunId: string; bindingVersion: number; addedTargets: string[]; includedSuggestions: number }>> {
    const denied = this.deny()
    if (denied !== null) return denied
    const runtime = await this.deps.runtime()
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    return runtime.value.work.continueScope({ ...request, origin: 'panel' })
  }

  /**
   * 消息准入观测：把宿主真实事件（排队／消费／终态）转发给 WorkService。
   * rpcId 不是授权令牌——工具提交时还会核对真实 ToolRunContext 的 agent.id 与会话；
   * owner 观测不替代消息消费与实际 Agent 在场核对（consumed 必须带 agentPresent）。
   */
  @Remote('workObserve')
  async workObserve(request: ConaWorkObserveRequest): Promise<AdmissionResult> {
    const denied = this.deny()
    if (denied !== null) return { status: 'rejected', code: denied.code, message: denied.message }
    const runtime = await this.deps.runtime()
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    const work = runtime.value.work
    if (request.kind === 'queued') {
      if (typeof request.rpcId !== 'string' || request.rpcId === '') {
        return { status: 'rejected', code: 'operation-mismatch', message: '排队事件缺少 rpcId' }
      }
      return work.observeQueued({ sessionId: request.sessionId, rpcId: request.rpcId })
    }
    if (request.kind === 'consumed') {
      if (typeof request.rpcId !== 'string' || request.rpcId === '') {
        return { status: 'rejected', code: 'operation-mismatch', message: '消费事件缺少 rpcId' }
      }
      return work.observeConsumed({
        sessionId: request.sessionId,
        rpcId: request.rpcId,
        turn: request.turn as number,
        agentPresent: request.agentPresent === true,
      })
    }
    if (request.kind === 'turn-end') {
      if (!Number.isSafeInteger(request.turn) || (request.turn as number) < 0
        || (request.endKind !== 'completed' && request.endKind !== 'aborted')) {
        return { status: 'rejected', code: 'operation-mismatch', message: '终态事件缺少有效 turn 与 endKind' }
      }
      return work.observeTurnEnd({
        sessionId: request.sessionId,
        turn: request.turn as number,
        kind: request.endKind as 'completed' | 'aborted',
      })
    }
    if (request.kind === 'cancel') {
      // 取消／steer abort（tasks 6.5）：立即停止新写准入；真实终态仍由 turn-end 确认。
      return work.observeCancel({
        sessionId: request.sessionId,
        ...(typeof request.turn === 'number' ? { turn: request.turn } : {}),
      })
    }
    return { status: 'rejected', code: 'operation-mismatch', message: '未知观测事件类型' }
  }

  /** 准入：缺 invocation、非 owner、或 `principalOf` 非空都拒绝，不降级。 */
  private deny(): OwnerDenial {
    return denyNonOwner(this.ctx)
  }
}

/** 供宿主日志使用的一行摘要，不含资料内容。 */
export function statusLine(status: ConaProjectStatus): string {
  if (!status.configured) {
    return `[dsh-cona-project] 未打开实例${status.error === null ? '' : `（${status.error.code}: ${status.error.message}）`}`
  }
  return `[dsh-cona-project] 实例 ${status.instanceId} @ ${status.sourceDisplay}（${status.sourceKind}）`
}
