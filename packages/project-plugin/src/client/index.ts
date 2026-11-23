// Client 入口（R1 5.2 面板 + R2 2.2 顶部概览）：
// - 侧栏「项目」入口 + 主区域 `main` keyed 面板（R1 既有树编辑器）；
// - 窗口顶部 shell.overlay「项目」按钮 + 向下展开的多实例概览（R2）。
// 树面板通过委托控制器显示概览当前选中实例；草稿/选择/代际按实例隔离。
// 构建脚本把它包成宿主 loader 所需的 closure factory。

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ConaPanelIcon } from './PanelIcon.js'
import { NS, dictionaries } from './locales.js'
import { createHttpTransport } from './http-transport.js'
import { ProjectPanel } from './ProjectPanel.js'
import { ProjectTopBar } from './ProjectTopBar.js'
import {
  ProjectOverviewController,
  DelegatingPanelController,
  type OverviewListResult,
  type ResumeCardView,
  type CodeObservationView,
  type ChatMutationView,
  type WorkPreviewView,
} from './project-overview-controller.js'
import type { PanelTransport } from './api.js'
import type { ResumePayload } from '../domain/resume.js'
import type { ResumeChatPointerView } from '../application/resume-chat.js'
import type {
  ResumeChatTargetResult,
  ResumeChatsResult,
  ResumeLinkResult,
  OverviewChatsResult,
  OverviewChatSessionsResult,
  RebindResumeChatResult,
} from '../host/overview-service.js'

import type {
  RegisterPreviewResult,
  RegisterSourceResult,
  MigrationOpResult,
  MigrationPreviewOpResult,
  MigrationListOpResult,
} from '../host/overview-service.js'
import type { LocationKind } from '../application/location.js'
import type { RoadmapEnableImpact, RoadmapStateView } from '../application/command-service.js'

/** client 侧结果：OwnerDenial 的 null 在 callOverview 归一为 rejected，不进入控制器。 */
type ResumeChatsView = Exclude<ResumeChatsResult, null>
type ResumeLinkView = Exclude<ResumeLinkResult, null>
type ResumeChatTargetView = Exclude<ResumeChatTargetResult, null>
type RegisterPreviewView = Exclude<RegisterPreviewResult, null>
type RegisterSourceView = Exclude<RegisterSourceResult, null>
type MigrationOpView = Exclude<MigrationOpResult, null>
type MigrationPreviewOpView = Exclude<MigrationPreviewOpResult, null>
type MigrationListView = Exclude<MigrationListOpResult, null>

export const name = 'dsh-cona-project.client'

/** `slots` 服务就绪后注册；顶部入口另需 `layout` 导航到既有树面板、`uiWorkspace` 打开原聊天。 */
export const inject: readonly string[] = ['slots', 'locale', 'layout', 'uiWorkspace']

/** 面板 id：同时作为侧栏入口与主区域 keyed slot 的键。 */
const PANEL_ID = 'cona-project'

/** 读取 owner 概览实例列表（conaOverview/instances）。 */
async function listInstances(): Promise<OverviewListResult> {
  const response = await fetch('/api/conaOverview/instances', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `cona-overview-${globalThis.crypto.randomUUID()}`,
      method: 'conaOverview/instances',
      payload: { args: {} },
    }),
  })
  if (!response.ok) return { status: 'rejected', code: 'transport-http', message: `HTTP ${response.status}` }
  const body = await response.json() as {
    result?: { ok: true; value: OverviewListResult } | { ok: false; error: { code: string; message: string } }
  }
  if (body.result === undefined) return { status: 'rejected', code: 'transport-parse', message: '响应缺少结果' }
  if (!body.result.ok) {
    return { status: 'rejected', code: body.result.error.code, message: body.result.error.message }
  }
  return body.result.value
}

/** 读取所选实例的接续卡片（conaOverview/resumeCandidate）。 */
async function readResumeCandidate(instanceId: string): Promise<ResumeCardView> {
  const response = await fetch('/api/conaOverview/resumeCandidate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `cona-resume-${globalThis.crypto.randomUUID()}`,
      method: 'conaOverview/resumeCandidate',
      payload: { args: { request: { instanceId } } },
    }),
  })
  if (!response.ok) return { status: 'diagnostic', code: 'transport-http', message: `HTTP ${response.status}` }
  const body = await response.json() as {
    result?: { ok: true; value: { status: string; payload?: unknown; code?: string; message?: string; contentHash?: string; codeObservation?: { status: string; head?: string; dirtyCount?: number; reason?: string }; chat?: { status: string; linkId?: string; sessionId?: string; purpose?: string; visible?: boolean | null; reason?: string } } }
      | { ok: false; error: { code: string; message: string } }
  }
  if (body.result === undefined) return { status: 'diagnostic', code: 'transport-parse', message: '响应缺少结果' }
  if (!body.result.ok) return { status: 'diagnostic', code: body.result.error.code, message: body.result.error.message }
  const value = body.result.value
  if (value.status === 'card' && value.payload !== undefined) {
    const raw = value.codeObservation
    const codeObservation: CodeObservationView =
      raw === undefined || raw.status === 'not-configured'
        ? { status: 'not-configured' }
        : raw.status === 'observed' && typeof raw.head === 'string' && typeof raw.dirtyCount === 'number'
          ? { status: 'observed', head: raw.head, dirtyCount: raw.dirtyCount }
          : { status: 'unavailable', reason: String(raw.reason ?? 'unknown') }
    const rawChat = value.chat
    const chat: ResumeChatPointerView =
      rawChat === undefined || rawChat.status === 'unavailable'
        ? { status: 'unavailable', reason: String(rawChat?.reason ?? 'unknown') }
        : rawChat.status === 'linked' && typeof rawChat.linkId === 'string' && typeof rawChat.sessionId === 'string'
          ? { status: 'linked', linkId: rawChat.linkId, sessionId: rawChat.sessionId, purpose: String(rawChat.purpose ?? ''), visible: rawChat.visible === null ? null : rawChat.visible === true }
          : { status: 'unlinked' }
    return {
      status: 'card',
      recordId: String((value as { recordId?: string }).recordId ?? ''),
      contentHash: String(value.contentHash ?? ''),
      payload: value.payload as ResumePayload,
      codeObservation,
      chat,
    }
  }
  if (value.status === 'empty') return { status: 'empty' }
  if (value.status === 'rejected' || value.status === 'forbidden') {
    return { status: 'diagnostic', code: value.code ?? value.status, message: value.message ?? '不可读' }
  }
  return { status: 'unread' }
}

/** conaOverview 带 request 的通用 POST（ok:false 与 OwnerDenial null 都归一为 rejected 形状）。 */
async function callOverview<T extends { status: string; code?: string; message?: string }>(
  method: string,
  request: Record<string, unknown>,
  onHttpFail: (code: string, message: string) => T,
): Promise<T> {
  const response = await fetch(`/api/conaOverview/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `cona-overview-${globalThis.crypto.randomUUID()}`,
      method: `conaOverview/${method}`,
      payload: { args: { request } },
    }),
  })
  if (!response.ok) return onHttpFail('transport-http', `HTTP ${response.status}`)
  const body = await response.json() as {
    result?: { ok: true; value: T | null } | { ok: false; error: { code: string; message: string } }
  }
  if (body.result === undefined) return onHttpFail('transport-parse', '响应缺少结果')
  if (!body.result.ok) return onHttpFail(body.result.error.code, body.result.error.message)
  const value = body.result.value
  // OwnerDenial 的 null（非 owner）与形状不合法的响应统一转 rejected，不进入控制器。
  if (value === null || typeof value !== 'object' || typeof value.status !== 'string') {
    return onHttpFail('forbidden', '非 owner 或响应形状不合法')
  }
  return value
}

/** 保存表单的聊天选项（conaOverview/resumeChats）。 */
function listResumeChats(instanceId: string): Promise<ResumeChatsView> {
  return callOverview<ResumeChatsView>(
    'resumeChats',
    { instanceId },
    (code, message) => ({ status: 'rejected', code, message }),
  )
}

/** 保存聊天指针（conaOverview/linkResume）；失败不影响已提交的公开记录。 */
function linkResume(instanceId: string, recordId: string, linkId: string): Promise<ResumeLinkView> {
  return callOverview<ResumeLinkView>(
    'linkResume',
    { instanceId, recordId, linkId },
    (code, message) => ({ status: 'rejected', code, message }),
  )
}

/** 打开原聊天前复查（conaOverview/resumeChatTarget）。 */
function resolveChatTarget(instanceId: string, recordId: string, contentHash: string, linkId: string): Promise<ResumeChatTargetView> {
  return callOverview<ResumeChatTargetView>(
    'resumeChatTarget',
    { instanceId, recordId, contentHash, linkId },
    (code, message) => ({ status: 'rejected', code, message }),
  )
}

// ---------- 3.1：概览按实例的本机聊天读写 ----------

type OverviewChatsView = Exclude<OverviewChatsResult, null>
type OverviewChatSessionsView = Exclude<OverviewChatSessionsResult, null>
type RebindResumeView = Exclude<RebindResumeChatResult, null>

function overviewChats(instanceId: string): Promise<OverviewChatsView> {
  return callOverview<OverviewChatsView>('chats', { instanceId }, (code, message) => ({ status: 'rejected', code, message }))
}

function overviewChatSessions(instanceId: string): Promise<OverviewChatSessionsView> {
  return callOverview<OverviewChatSessionsView>('chatSessions', { instanceId }, (code, message) => ({ status: 'rejected', code, message }))
}

function chatCreate(instanceId: string, operationId: string, nodeIds: string[], purpose: string): Promise<ChatMutationView<{ sessionId: string; linkId: string; reusedBlank: boolean }>> {
  return callOverview(
    'chatCreate',
    { instanceId, operationId, nodeIds, purpose },
    (code, message) => ({ status: 'rejected' as const, code, message }),
  )
}

function chatLink(instanceId: string, operationId: string, sessionId: string, nodeIds: string[], purpose: string): Promise<ChatMutationView<{ linkId: string; reused: boolean }>> {
  return callOverview(
    'chatLink',
    { instanceId, operationId, sessionId, nodeIds, purpose },
    (code, message) => ({ status: 'rejected' as const, code, message }),
  )
}

function chatClaim(instanceId: string, operationId: string, sessionId: string, nodeIds: string[], purpose: string): Promise<ChatMutationView<{ linkId: string; reusedBlank: boolean }>> {
  return callOverview(
    'chatClaim',
    { instanceId, operationId, sessionId, nodeIds, purpose },
    (code, message) => ({ status: 'rejected' as const, code, message }),
  )
}

function chatUnlink(instanceId: string, operationId: string, linkId: string): Promise<ChatMutationView<{ removed: boolean }>> {
  return callOverview(
    'chatUnlink',
    { instanceId, operationId, linkId },
    (code, message) => ({ status: 'rejected' as const, code, message }),
  )
}

function chatTarget(instanceId: string, linkId: string): Promise<ChatMutationView<{ sessionId: string }>> {
  return callOverview(
    'chatTarget',
    { instanceId, linkId },
    (code, message) => ({ status: 'rejected' as const, code, message }),
  )
}

function chatRebindResume(request: {
  instanceId: string; recordId: string; contentHash: string;
  mode: 'create' | 'link'; sessionId?: string; purpose: string;
}): Promise<RebindResumeView> {
  return callOverview<RebindResumeView>(
    'chatRebindResume',
    { ...request },
    (code, message) => ({ status: 'rejected', code, message }),
  )
}

// ---------- 3.2：配置实例上的项目工作 ----------

function workPreview(request: Parameters<NonNullable<import('./project-overview-controller.js').OverviewControllerDeps['workPreview']>>[0]): Promise<ChatMutationView<WorkPreviewView> | { status: 'rejected'; code: string; message: string }> {
  return callOverview(
    'workPreview',
    { ...request },
    (code, message) => ({ status: 'rejected' as const, code, message }),
  )
}

function workPrepare(request: Parameters<NonNullable<import('./project-overview-controller.js').OverviewControllerDeps['workPrepare']>>[0]): Promise<ChatMutationView<{ workIntentId: string; reused: boolean }>> {
  return callOverview(
    'workPrepare',
    { ...request },
    (code, message) => ({ status: 'rejected' as const, code, message }),
  )
}

function workStart(request: { instanceId: string; workIntentId: string; sessionId: string }): Promise<ChatMutationView<{ workIntentId: string; status: 'awaiting-message' }>> {
  return callOverview(
    'workStart',
    { ...request },
    (code, message) => ({ status: 'rejected' as const, code, message }),
  )
}

/** 4.2：路线图状态（v1 空态／v2 里程碑节点）。 */
function roadmapRead(instanceId: string) {
  return callOverview<{ status: 'ok'; roadmap: RoadmapStateView } | { status: 'rejected'; code: string; message: string }>(
    'roadmap',
    { instanceId },
    (code, message) => ({ status: 'rejected' as const, code, message }),
  )
}

/** 4.2：启用扩展规划预览（只读，返回确认摘要）。 */
function roadmapPreview(instanceId: string) {
  return callOverview<
    { status: 'available'; impact: RoadmapEnableImpact } | { status: 'rejected'; code: string; message: string }
  >(
    'roadmapPreview',
    { instanceId },
    (code, message) => ({ status: 'rejected' as const, code, message }),
  )
}

/**
 * 迁移/登记的通用 POST（1.4/1.5）：结果形状是 `{ ok }` 或 `{ status }` 的并集，
 * 与 callOverview 的 status 约束不同。HTTP 失败／形状不合法／OwnerDenial null
 * 都归一为 `{ ok: false, issues: [...] }`，控制器按稳定码诊断。
 */
async function callMigration<T>(method: string, request: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/api/conaOverview/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `cona-overview-${globalThis.crypto.randomUUID()}`,
      method: `conaOverview/${method}`,
      payload: { args: { request } },
    }),
  })
  const denied = (code: string, message: string) => ({ ok: false, issues: [{ code, message }] }) as T
  if (!response.ok) return denied('transport-http', `HTTP ${response.status}`)
  const body = await response.json() as {
    result?: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }
  }
  if (body.result === undefined) return denied('transport-parse', '响应缺少结果')
  if (!body.result.ok) return denied(body.result.error.code, body.result.error.message)
  const value = body.result.value
  if (value === null || typeof value !== 'object') return denied('forbidden', '非 owner 或响应形状不合法')
  return value as T
}

/** 1.5：迁移预览（conaOverview/migrationPreview）。 */
function migrationPreview(instanceId: string, toRoot: string, toKind: LocationKind): Promise<MigrationPreviewOpView> {
  return callMigration<MigrationPreviewOpView>('migrationPreview', { instanceId, toRoot, toKind })
}

/** 1.5：迁移确认（conaOverview/migrationRun）。 */
function migrationRun(instanceId: string, toRoot: string, toKind: LocationKind, operationId?: string): Promise<MigrationOpView> {
  return callMigration<MigrationOpView>('migrationRun', { instanceId, toRoot, toKind, operationId })
}

/** 1.5：迁移恢复（conaOverview/migrationRecover）。 */
function migrationRecover(instanceId: string, operationId: string, confirmDigest: string): Promise<MigrationOpView> {
  return callMigration<MigrationOpView>('migrationRecover', { instanceId, operationId, confirmDigest })
}

/** 1.5：迁移取消（conaOverview/migrationCancel）。 */
function migrationCancel(instanceId: string, operationId: string, confirmDigest: string): Promise<MigrationOpView> {
  return callMigration<MigrationOpView>('migrationCancel', { instanceId, operationId, confirmDigest })
}

/** 1.5：迁移记录列表（conaOverview/migrationList）。 */
function migrationList(): Promise<MigrationListView> {
  return callMigration<MigrationListView>('migrationList', {})
}

/** 1.1：接入预览（conaOverview/registerPreview）。 */
function registerPreview(sourceRoot: string): Promise<RegisterPreviewView> {
  return callOverview<RegisterPreviewView>(
    'registerPreview',
    { sourceRoot },
    (code, message) => ({ status: 'rejected', code, message }),
  )
}

/** 1.1：显式登记（conaOverview/registerSource）。 */
function registerSource(request: { sourceRoot: string; sourceKind: LocationKind; projectId: string }): Promise<RegisterSourceView> {
  return callOverview<RegisterSourceView>(
    'registerSource',
    { ...request },
    (code, message) => ({ status: 'rejected', code, message }),
  )
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-cona-project: dictionaries')
  const t = ctx.locale.bind(NS)
  const newOperationId = (): string => globalThis.crypto.randomUUID()

  const overview = new ProjectOverviewController({
    listInstances,
    readResumeCard: readResumeCandidate,
    listResumeChats,
    linkResume,
    resolveChatTarget,
    // 1.5：迁移操作（宿主未装配时 conaOverview 返回 unavailable，控制器显示稳定码）。
    migrationPreview,
    migrationRun,
    migrationRecover,
    migrationCancel,
    migrationList,
    // 1.1：接入预览与显式登记。
    registerPreview,
    registerSource,
    // 3.1：按实例的本机聊天读写（创建／关联／认领／解绑／打开／重绑）。
    listChats: overviewChats,
    listChatSessions: overviewChatSessions,
    createChat: (request) => chatCreate(request.instanceId, request.operationId, request.nodeIds, request.purpose),
    linkChat: (request) => chatLink(request.instanceId, request.operationId, request.sessionId, request.nodeIds, request.purpose),
    claimChat: (request) => chatClaim(request.instanceId, request.operationId, request.sessionId, request.nodeIds, request.purpose),
    unlinkChat: (request) => chatUnlink(request.instanceId, request.operationId, request.linkId),
    resolveChatLinkTarget: chatTarget,
    rebindResumeChat: chatRebindResume,
    // 3.2：配置实例上的项目工作（预览 → 登记意图 → 确认等待消息）。
    workPreview,
    workPrepare,
    workStart,
    // 4.2：路线图状态与启用预览（确认经 conaOverview/execute 发布 v2）。
    readRoadmap: roadmapRead,
    previewRoadmapEnable: roadmapPreview,
    // 1.1 探针实证：fiber 注入 uiWorkspace 后 openSession(id) 落到指定 Session。
    // 宿主生成的类型不随插件分发，这里按探针实证的最小结构访问。
    openSession: (sessionId) => {
      const workspace = (ctx as unknown as { uiWorkspace?: { openSession: (id: string) => unknown } }).uiWorkspace
      if (workspace === undefined) {
        console.warn('[dsh-cona-project] uiWorkspace 未注入；无法打开原聊天')
        return
      }
      void workspace.openSession(sessionId)
    },
    // 所有实例（含配置实例）统一走 conaOverview：它按 instanceId 路由并覆盖已登记实例。
    // 若误用 conaProject，请求会落到配置实例，浏览 B 时错误显示 A 的资料。
    transportFor: (instanceId): PanelTransport =>
      createHttpTransport({ namespace: 'conaOverview', instanceId }),
    newOperationId,
  })
  const delegate = new DelegatingPanelController(overview)
  ctx.effect(() => () => delegate.dispose(), 'dsh-cona-project: overview delegate')

  // 既有 R1 树面板：注入委托控制器，显示概览当前选中实例。
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      { name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ controller: delegate }) },
      ProjectPanel,
    ),
  )

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 40, locale: NS, label: () => t('panel') },
      ConaPanelIcon,
    ),
  )

  // 顶部窗口级入口：按钮 + 折叠概览（design §1）。
  const onEnterTree = async (instanceId: string): Promise<void> => {
    if (!overview.select(instanceId)) return
    const controller = overview.panelController(instanceId)
    await controller.open()
    // 1.1 探针约束：selectPanel 检查实时 main 注册表；面板在 apply 早期已注册，
    // 用微任务让本轮 slots 注册/commit 完成再导航，避免 "main panel not registered"。
    await Promise.resolve()
    const panelId = PANEL_ID as Parameters<typeof ctx.layout.selectPanel>[0]
    ctx.layout.selectPanel(panelId)
  }
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'cona-project-top',
        locale: NS,
        inject: () => ({ controller: overview, onEnterTree }),
      },
      ProjectTopBar,
    ),
  )
}
