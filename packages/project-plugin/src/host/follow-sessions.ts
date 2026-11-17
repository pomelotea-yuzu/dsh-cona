// follow 订阅句柄（tasks V32，design §8）：把应用层 follow 返回的 AsyncIterable 事件流
// 缓冲成可通过普通 HTTP Remote 轮询的句柄，供自定义 HTTP Client 面板“重新订阅”使用。
//
// 背景：typert 原生 stream Remote 的传输由宿主 client loader 提供；本面板走手写 /api JSON RPC，
// 无法直接消费 AsyncIterable。这里在 Host 内把流泵入有界缓冲，Client 用 followEvents 拉取，
// 仍是“先订阅 → ready → 完整回读 → 事件驱动失效”的语义，不是纯 snapshot 定时轮询。
//
// 边界：只缓冲失效事件（不含权威内容）；代际／源代际／单调修订的判定仍在 client panel-controller。
// 句柄有数量与容量上限，超限丢弃最旧句柄，避免被遗弃的面板累积泄漏。

import type { FollowResult, StreamEventView } from '../application/snapshot.js'

export interface FollowHandleView {
  subscriptionId: string;
  connectionGeneration: number;
  ready: StreamEventView;
}

export interface FollowEventBatch {
  status: 'events' | 'closed' | 'not-found';
  /** 自 index 起的事件（含 ready 作为 index 0）。 */
  events: StreamEventView[];
  /** 下一批应从这里开始。 */
  nextIndex: number;
  /** 流已终结（源代际替换或显式关闭）；client 应重新 follow。 */
  closed: boolean;
}

interface FollowHandle {
  id: string;
  instanceId: string;
  generation: number;
  events: StreamEventView[];
  cursor: number;
  closed: boolean;
  close: () => void;
}

export const FOLLOW_LIMITS = { maxHandles: 16, maxEventsPerHandle: 512 } as const

export class FollowSessions {
  private readonly handles = new Map<string, FollowHandle>()

  /**
   * 从一次成功 follow 建立句柄，立即把 ready 作为首事件入缓冲，并后台泵事件。
   * 同一实例的新句柄会使旧句柄失效（应用层 nextGeneration 已关闭旧订阅，这里同步标记）。
   */
  start(subscriptionId: string, instanceId: string, result: FollowResult & { status: 'following' }): FollowHandleView {
    for (const existing of this.handles.values()) {
      if (existing.instanceId === instanceId && !existing.closed) {
        existing.closed = true
        existing.close()
      }
    }
    if (this.handles.size >= FOLLOW_LIMITS.maxHandles) {
      const oldest = this.handles.keys().next().value as string | undefined
      if (oldest !== undefined) this.dispose(oldest)
    }
    const handle: FollowHandle = {
      id: subscriptionId,
      instanceId,
      generation: result.connectionGeneration,
      events: [result.ready],
      cursor: 0,
      closed: false,
      close: result.close,
    }
    this.handles.set(subscriptionId, handle)
    // 后台消费事件流；任何异常都标记关闭，让 client 重新订阅而不是永久等待。
    void this.pump(handle, result.events).catch(() => {
      handle.closed = true
    })
    return { subscriptionId, connectionGeneration: result.connectionGeneration, ready: result.ready }
  }

  /** 拉取新事件；不阻塞（HTTP unary），无新事件时返回空批。 */
  drain(subscriptionId: string): FollowEventBatch {
    const handle = this.handles.get(subscriptionId)
    if (handle === undefined) return { status: 'not-found', events: [], nextIndex: 0, closed: true }
    const events = handle.events.slice(handle.cursor)
    handle.cursor = handle.events.length
    return {
      status: 'events',
      events,
      nextIndex: handle.cursor,
      closed: handle.closed,
    }
  }

  /** 显式关闭句柄（面板卸载／重连前释放）。 */
  dispose(subscriptionId: string): boolean {
    const handle = this.handles.get(subscriptionId)
    if (handle === undefined) return false
    handle.closed = true
    handle.close()
    this.handles.delete(subscriptionId)
    return true
  }

  /** 诊断用：当前句柄数。 */
  get size(): number {
    return this.handles.size
  }

  private async pump(handle: FollowHandle, events: AsyncIterable<StreamEventView>): Promise<void> {
    for await (const event of events) {
      if (handle.closed || handle.events.length >= FOLLOW_LIMITS.maxEventsPerHandle) break
      handle.events.push(event)
    }
    handle.closed = true
  }
}
