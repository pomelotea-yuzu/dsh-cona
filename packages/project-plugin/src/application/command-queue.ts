// 每实例提交队列（tasks 4.1，design §6）：同一实例串行，不同实例互不阻塞。
// 前一条命令失败不阻塞后续命令；队列只保证顺序，不保证幂等（幂等见 4.2）。

export class InstanceCommandQueue {
  private readonly tails = new Map<string, Promise<void>>();

  /** 前序任务失败也继续执行后一条；返回本次任务结果。 */
  run<T>(instanceId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(instanceId) ?? Promise.resolve();
    const current = previous.then(task, task);
    this.tails.set(
      instanceId,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );
    return current;
  }

  /** 诊断用：该实例是否有未完成命令。 */
  isBusy(instanceId: string): boolean {
    return this.tails.has(instanceId);
  }
}
