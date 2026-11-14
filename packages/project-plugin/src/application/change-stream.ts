// 失效通知流（tasks 5.1，design §8）：快照订阅的只读失效通道。
// 边界：本文件只维护内存水位、连接代际与订阅者，不读磁盘、不写文件、不做授权。
// 通知只说明“哪个实例的哪个修订已变化”，不携带权威内容；内容一律由订阅者再回读快照。

import type { CommittedCommand } from './command-service.js';

export type ChangeKind = 'committed' | 'rejected' | 'refreshed' | 'source-replaced';

/**
 * 一条失效通知。`sourceEpoch` 变化是替换边界：客户端不得比较其大小，
 * 只能关闭旧流并按新描述符重新订阅。
 */
export interface ChangeNotification {
  kind: ChangeKind;
  instanceId: string;
  projectId: string;
  sourceEpoch: number;
  /** 该实例在本代际内已知的最高 stateRevision。 */
  stateRevision: number;
  planRevision: number;
  operationId?: string;
  at: string;
  detail?: string;
}

/** 交给订阅者的事件：与通知同形，另带本连接代际（用于丢弃迟到响应前先核对代际）。 */
export interface StreamEvent extends ChangeNotification {
  connectionGeneration: number;
}

/** 已知水位：同一实例、同一源代际内的最高修订。 */
export interface ChangeWatermark {
  sourceEpoch: number;
  stateRevision: number;
  planRevision: number;
}

/** 订阅者由快照服务实现，流只负责分发与关闭。 */
export interface ChangeSubscriber {
  generation: number;
  sourceEpoch: number;
  lastRevision: number;
  push(event: StreamEvent): void;
  close(): void;
}

/** 快照服务只需要这几项能力；实现可以替换为跨进程通道而不改快照逻辑。 */
export interface ChangeStreamPort {
  /** 已知水位；从未收到通知时为 null（此时只能以本机聚合为准）。 */
  highestKnown(instanceId: string): ChangeWatermark | null;
  /** 该实例最新连接代际；从未订阅过为 null。 */
  latestGeneration(instanceId: string): number | null;
  /** 分配并返回新的连接代际（同一实例单调递增）。 */
  nextGeneration(instanceId: string): number;
  /** 注册订阅，返回取消函数；同一实例的新代际订阅会先关闭旧代际。 */
  subscribe(instanceId: string, subscriber: ChangeSubscriber): () => void;
}

type Subscriber = ChangeSubscriber;

/**
 * 进程内不可靠失效流（R1 单进程、单写者）。
 *
 * - 通知可能丢失（进程重启、订阅前发生），因此协议要求“先订阅再回读”：
 *   收到 ready 后必须回读快照，而不能把通知当成内容来源。
 * - 水位只增不减；代际替换（`sourceEpoch` 变化）时先发 `source-replaced` 再关闭旧订阅，
 *   客户端按新代际重新订阅，不拿新旧代际的修订数比较大小。
 * - 新代际订阅会关闭同实例的旧代际订阅；旧代际快照请求由 `latestGeneration` 判为过期。
 */
export class InMemoryChangeStream implements ChangeStreamPort {
  private readonly watermarks = new Map<string, ChangeWatermark>();
  private readonly generations = new Map<string, number>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  highestKnown(instanceId: string): ChangeWatermark | null {
    return this.watermarks.get(instanceId) ?? null;
  }

  latestGeneration(instanceId: string): number | null {
    return this.generations.get(instanceId) ?? null;
  }

  nextGeneration(instanceId: string): number {
    const next = (this.generations.get(instanceId) ?? 0) + 1;
    this.generations.set(instanceId, next);
    // 新代际是替换边界：旧代际订阅立即关闭，避免两代订阅同时收到事件。
    for (const subscriber of this.subscribers.get(instanceId) ?? []) {
      if (subscriber.generation < next) {
        this.drop(instanceId, subscriber);
        subscriber.close();
      }
    }
    return next;
  }

  /** 提升水位并分发；同一代际内按 stateRevision 单调过滤重复事件。 */
  publish(notification: ChangeNotification): void {
    const previous = this.watermarks.get(notification.instanceId);
    if (previous === undefined || notification.sourceEpoch > previous.sourceEpoch) {
      // 代际变大才是替换边界；代际变小说明发送方基线过期，直接忽略。
      if (previous !== undefined && notification.sourceEpoch < previous.sourceEpoch) return;
      this.watermarks.set(notification.instanceId, {
        sourceEpoch: notification.sourceEpoch,
        stateRevision: notification.stateRevision,
        planRevision: notification.planRevision,
      });
    } else if (notification.sourceEpoch === previous.sourceEpoch) {
      this.watermarks.set(notification.instanceId, {
        sourceEpoch: previous.sourceEpoch,
        stateRevision: Math.max(previous.stateRevision, notification.stateRevision),
        planRevision: Math.max(previous.planRevision, notification.planRevision),
      });
    } else {
      return;
    }

    for (const subscriber of [...(this.subscribers.get(notification.instanceId) ?? [])]) {
      if (subscriber.sourceEpoch !== notification.sourceEpoch) {
        // 源代际替换：通知新描述符后关闭；不比较两个代际的修订大小。
        subscriber.push({
          kind: 'source-replaced',
          instanceId: notification.instanceId,
          projectId: notification.projectId,
          sourceEpoch: notification.sourceEpoch,
          stateRevision: notification.stateRevision,
          planRevision: notification.planRevision,
          connectionGeneration: subscriber.generation,
          at: notification.at,
          detail: '源代际已替换；关闭旧流并按新描述符重新订阅',
        });
        this.drop(notification.instanceId, subscriber);
        subscriber.close();
        continue;
      }
      if (notification.stateRevision <= subscriber.lastRevision && notification.kind !== 'rejected') continue;
      subscriber.lastRevision = Math.max(subscriber.lastRevision, notification.stateRevision);
      subscriber.push({ ...notification, connectionGeneration: subscriber.generation });
    }
  }

  /** 注册订阅；同一实例的新代际已由 nextGeneration 关闭旧订阅。 */
  subscribe(instanceId: string, subscriber: Subscriber): () => void {
    const set = this.subscribers.get(instanceId) ?? new Set<Subscriber>();
    set.add(subscriber);
    this.subscribers.set(instanceId, set);
    return () => {
      this.drop(instanceId, subscriber);
    };
  }

  /** 当前订阅数（诊断与测试用，不参与协议）。 */
  subscriberCount(instanceId: string): number {
    return this.subscribers.get(instanceId)?.size ?? 0;
  }

  private drop(instanceId: string, subscriber: Subscriber): void {
    this.subscribers.get(instanceId)?.delete(subscriber);
  }
}

/** 提交成功后的失效通知：只带修订与操作 id，不带内容。 */
export function notificationForCommit(
  target: { instanceId: string; projectId: string },
  result: Pick<CommittedCommand, 'stateRevision' | 'planRevision' | 'sourceEpoch' | 'operationId'>,
  at: string,
): ChangeNotification {
  return {
    kind: 'committed',
    instanceId: target.instanceId,
    projectId: target.projectId,
    sourceEpoch: result.sourceEpoch,
    stateRevision: result.stateRevision,
    planRevision: result.planRevision,
    operationId: result.operationId,
    at,
  };
}

/** 显式刷新（源代际推进）后的替换通知。 */
export function notificationForRefresh(
  target: { instanceId: string; projectId: string; sourceEpoch: number; stateRevision: number; planRevision: number },
  at: string,
): ChangeNotification {
  return {
    kind: 'refreshed',
    instanceId: target.instanceId,
    projectId: target.projectId,
    sourceEpoch: target.sourceEpoch,
    stateRevision: target.stateRevision,
    planRevision: target.planRevision,
    at,
  };
}
