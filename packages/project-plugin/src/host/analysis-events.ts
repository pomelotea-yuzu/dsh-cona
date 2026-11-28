// 分析终态事件接线（tasks 4.5）：把真实 session/event 的 turn/end 同步到本机分析记录。
//
// 只按字符串事件名订阅、按最小结构读取 payload，不 import dsh-agent/dsh-session 的静态类型
// （merge 风险见 host/index.ts 注）。观察失败被吞掉，不影响宿主事件流；记录状态由
// AnalysisSessionService 在实例队列内落盘。

import type { Context } from '@deepseek-ai/cordis'
import type { RuntimeResult } from './project-service.js'

interface SessionLike {
  readonly id?: unknown
}
interface SessionEventLike {
  readonly type?: unknown
  readonly data?: {
    readonly reason?: { readonly kind?: unknown }
  }
}

export type GetRuntime = () => Promise<RuntimeResult>

/** 订阅 turn/end；返回 disposer 供测试与显式清理。 */
export function attachAnalysisEventObservers(ctx: Context, getRuntime: GetRuntime): () => void {
  const on = ctx.on.bind(ctx) as (name: string, listener: (...args: any[]) => void) => (() => boolean) | undefined
  const off = on('session/event', (session: SessionLike, event: SessionEventLike) => {
    if (event.type !== 'turn/end') return
    const sessionId = typeof session.id === 'string' && session.id !== '' ? session.id : null
    if (sessionId === null) return
    const raw = event.data?.reason?.kind
    const kind = raw === 'completed' ? 'completed' : raw === 'error' ? 'error' : 'aborted'
    void getRuntime().then((result) => {
      if (!result.ok) return
      const service = result.value.analysisSession
      if (service === undefined) return
      void service.handleTurnEnd({ sessionId, kind }).catch(() => {
        // 后台观察失败不改变宿主事件流；记录诊断由下次读取反映。
      })
    }).catch(() => {
      // runtime 未装配时无可观察对象。
    })
  })
  return () => {
    off?.()
  }
}
