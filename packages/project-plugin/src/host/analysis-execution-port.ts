// 分析执行保护端口（tasks 4.3-4.4）的宿主侧装配。
//
// 4.3 只落地「保护未就绪不派发」的占位与事件查询；四个分析能力与真正的
// verifyAnalysisExecution 接入属 4.4／第 5 组。占位实现不会把未保护的消息发出去。

import type { Context } from '@deepseek-ai/cordis'
import type { AnalysisExecutionPort } from '../application/ports.js'

interface AgentEventLike {
  readonly type?: unknown
  readonly data?: {
    readonly source?: { readonly kind?: unknown; readonly rpcId?: unknown }
    readonly inserted?: ReadonlyArray<{ readonly source?: { readonly kind?: unknown; readonly rpcId?: unknown } }>
  }
}
interface AgentLike {
  readonly session?: { snapshotEvents?(): ReadonlyArray<AgentEventLike> }
}
interface AgentsLike {
  get(sessionId: string): AgentLike | undefined
}

/** 保护链路尚未接入时的端口：拒绝派发，查询保持未知。 */
export function unavailableAnalysisExecutionPort(message: string): AnalysisExecutionPort {
  return {
    async prepare() {
      return { ready: false as const, code: 'analysis-execution-unavailable', message }
    },
    async promptAccepted() {
      return 'unknown' as const
    },
  }
}

/**
 * 按实际 Agent 的事件核对 requestId 是否已作为 user 消息进入会话。
 * 活动 Agent 缺失或事件快照不可用时返回 'unknown'，调用方不得自动重发。
 */
export function agentPromptAccepted(ctx: Context): (sessionId: string, requestId: string) => Promise<boolean | 'unknown'> {
  const context = ctx as Context & { get?: <T>(name: string) => T | undefined }
  const agents = typeof context.get === 'function' ? context.get<AgentsLike>('agents') : undefined
  const agentsFromProps = (ctx as Context & { agents?: AgentsLike }).agents
  const service = agents ?? agentsFromProps
  return async (sessionId, requestId) => {
    if (service === undefined) return 'unknown'
    const agent = service.get(sessionId)
    const events = agent?.session?.snapshotEvents?.()
    if (events === undefined) return 'unknown'
    for (const event of events) {
      const source = event.data?.source
      if (source?.kind === 'user' && source.rpcId === requestId) return true
      for (const inserted of event.data?.inserted ?? []) {
        if (inserted.source?.kind === 'user' && inserted.source.rpcId === requestId) return true
      }
    }
    return false
  }
}
