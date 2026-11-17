// 宿主事件自动订阅接线（tasks 6.6，design §7）：把真实宿主的 inbox／turn 事件
// 映射到 WorkService 的 observe* 入口，取代 workObserve 仅靠 owner Remote 手工转发的状况。
//
// 边界：
// - 只按字符串事件名订阅、按最小结构读取 payload，不 import dsh-agent/dsh-session 的
//   静态类型（其 .d.ts 会与 vendored protocol 在同一 face program 触发 merge 错误，
//   前因见 host/index.ts 注）。运行时形态按 2.4 映射记录与 6.6 探路确认。
// - 事件转到当前装配实例的 WorkService，由其内部按 rpcId／sessionId／turn 匹配意图；
//   不匹配返回 unmatched，无副作用。R1 单实例装配；多实例事件路由属 R2。
// - 按 6.5 决定：turn-stopping 是预告，只有 signal.aborted 才算取消请求；真实终态
//   只由 turn/end 确认。工具 signal abort 的观测仍由 project-tools.maybeObserveAbort 覆盖。
// - 只处理带 rpcId 的 user 消息；系统注入（agent-instructions/runtime-context/skill-catalog
//   等）没有 rpcId，忽略，不把它们当作工作请求。

import type { Context } from '@deepseek-ai/cordis'
import type {
  AdmissionResult,
  ConsumedMessageEvent,
  QueuedMessageEvent,
  TurnEndEvent,
  WorkService,
} from '../application/work.js'
import type { RuntimeResult } from './project-service.js'

// ---------- 与宿主运行时形态对齐的最小结构 ----------

interface MessageSourceLike {
  readonly kind?: unknown
  readonly rpcId?: unknown
}
interface MessageLike {
  readonly source?: MessageSourceLike
}
interface AgentLike {
  readonly id?: unknown
}
interface InboxPayload {
  readonly agent?: AgentLike
  readonly message?: MessageLike
  readonly turn?: unknown
}
interface SessionLike {
  readonly id?: unknown
}
interface SessionEventLike {
  readonly type?: unknown
  readonly data?: {
    readonly turn?: unknown
    readonly reason?: { readonly kind?: unknown; readonly [key: string]: unknown }
  }
}
interface TurnStoppingPayload {
  readonly agent?: AgentLike
  readonly turn?: unknown
  readonly signal?: { readonly aborted?: unknown }
}

export type GetRuntime = () => Promise<RuntimeResult>

/** 从 user 消息取 rpcId；系统注入消息（无 rpcId 或非 user）返回 null。 */
export function messageRpcId(message: MessageLike | undefined): string | null {
  const source = message?.source
  if (source === undefined || source.kind !== 'user') return null
  const rpcId = source.rpcId
  return typeof rpcId === 'string' && rpcId !== '' ? rpcId : null
}

function sessionIdOf(entity: AgentLike | SessionLike | undefined): string | null {
  const id = entity?.id
  if (id === undefined || id === null) return null
  const value = String(id)
  return value !== '' ? value : null
}

function nonNegativeTurn(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** agent/inbox/inserted → queued：只登记排队事实，不改状态、不建绑定。 */
export function queuedFromInbox(payload: InboxPayload): QueuedMessageEvent | null {
  const rpcId = messageRpcId(payload.message)
  const sessionId = sessionIdOf(payload.agent)
  if (rpcId === null || sessionId === null) return null
  return { sessionId, rpcId }
}

/**
 * agent/inbox/claimed → consumed：消息在 open turn 中被真实 Agent 消费，首次匹配启动 WorkRun。
 * claimed 事件带 agent，故 agentPresent 为 true；缺 agent／turn 时不构造事件（保守拒绝建绑定）。
 */
export function consumedFromInbox(payload: InboxPayload): ConsumedMessageEvent | null {
  const rpcId = messageRpcId(payload.message)
  const sessionId = sessionIdOf(payload.agent)
  const turn = nonNegativeTurn(payload.turn)
  if (rpcId === null || sessionId === null || turn === null) return null
  return { sessionId, rpcId, turn, agentPresent: true }
}

/**
 * session/event 的 turn/end → turn-end（真实终态）。
 * 只有 reason.kind === 'completed' 记为 completed；aborted／error／其他一律按 aborted，
 * 不把异常终止误标为成功完成。
 */
export function turnEndFromSession(session: SessionLike, event: SessionEventLike): TurnEndEvent | null {
  if (event.type !== 'turn/end') return null
  const sessionId = sessionIdOf(session)
  const turn = nonNegativeTurn(event.data?.turn)
  if (sessionId === null || turn === null) return null
  const kind = event.data?.reason?.kind === 'completed' ? 'completed' : 'aborted'
  return { sessionId, turn, kind }
}

/** agent/turn-stopping → cancel：只认 signal.aborted（取消请求），预告本身不作数。 */
export function cancelFromTurnStopping(payload: TurnStoppingPayload): { sessionId: string; turn?: number } | null {
  if (payload.signal?.aborted !== true) return null
  const sessionId = sessionIdOf(payload.agent)
  if (sessionId === null) return null
  const turn = nonNegativeTurn(payload.turn)
  return turn === null ? { sessionId } : { sessionId, turn }
}

type ObserveCall = (work: WorkService) => Promise<AdmissionResult>

/**
 * 在插件 fiber 上注册宿主事件监听；cordis 在 fiber unload 时自动移除，返回的 disposer 供测试与显式清理。
 * 观察失败被吞掉（best-effort，不影响宿主事件流）；WorkService 内部已产出稳定拒绝／blocked 记录。
 */
export function attachWorkEventObservers(ctx: Context, getRuntime: GetRuntime): () => void {
  const dispatch = (observe: ObserveCall): void => {
    void getRuntime().then((result) => {
      if (!result.ok) return
      void observe(result.value.work).catch(() => {
        // 宿主事件观察是后台副作用；失败不改变事件流，也不传播为未处理拒绝。
      })
    }).catch(() => {
      // runtime 装配失败（未配置／隔离等）时，事件无可观察对象；由 status／diagnostics 反映。
    })
  }

  // ctx.on 的静态签名要求 name ∈ keyof Events；宿主的事件 augmentation 由 dsh-agent／dsh-session
  // 在运行时合并，本包不声明它们的静态类型（merge 风险，见 index.ts 注）。按 cordis 事件总线的
  // 运行时签名 on(string, listener) 窄化使用，事件名来自固定宿主 0.2.2-rc.2 的已确认词表。
  const on = ctx.on.bind(ctx) as (name: string, listener: (...args: any[]) => void) => (() => boolean) | undefined
  const offs: Array<(() => boolean) | undefined> = [
    on('agent/inbox/inserted', (payload: InboxPayload) => {
      const event = queuedFromInbox(payload)
      if (event !== null) dispatch((work) => work.observeQueued(event))
    }),
    on('agent/inbox/claimed', (payload: InboxPayload) => {
      const event = consumedFromInbox(payload)
      if (event !== null) dispatch((work) => work.observeConsumed(event))
    }),
    on('session/event', (session: SessionLike, event: SessionEventLike) => {
      const end = turnEndFromSession(session, event)
      if (end !== null) dispatch((work) => work.observeTurnEnd(end))
    }),
    on('agent/turn-stopping', (payload: TurnStoppingPayload) => {
      const cancel = cancelFromTurnStopping(payload)
      if (cancel !== null) dispatch((work) => work.observeCancel(cancel))
    }),
  ]
  console.log('[dsh-cona-project] work event observers attached: inbox/inserted, inbox/claimed, session/event(turn-end), turn-stopping(cancel)')
  return () => {
    for (const off of offs) off?.()
  }
}
