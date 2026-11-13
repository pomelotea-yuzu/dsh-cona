// 应用层端口草案（design §5 核心接口，tasks 1.1 仅落边界，签名随第 3–6 段任务细化）。
// 这些是插件内部契约，不宣称为 DSH 已有方法；实现分别在 adapters/（Node 侧）与 client/。

/** 资料源：选择、登记、读取与刷新公开资料根（第 3 段实现）。 */
export interface ProjectSourcePort {
  /** 生成新的源代际；接入时核对项目身份，不隐式迁移。 */
  open(rootDescriptor: unknown): Promise<unknown>;
  /** 重读完整资料基线并返回明确刷新结果（第 3.5 段）。 */
  refresh(instanceId: string): Promise<unknown>;
}

/** 本机运行数据后端：独立文件型 LocalStatePort（design §2 决定，不用 storageDomain）。 */
export interface LocalStatePort {
  /** 单实例聚合替换：回执与双修订一次落盘；结果为 saved / not-saved / unknown-state。 */
  replaceInstanceAggregate(instanceId: string, aggregate: unknown): Promise<unknown>;
  readInstanceAggregate(instanceId: string): Promise<unknown>;
}

/** 聊天：本机多对多关联与打开实际聊天（第 6 段实现）。 */
export interface ConversationPort {
  link(link: unknown): Promise<unknown>;
  open(conversationId: string): Promise<unknown>;
}

/** 可信执行上下文：入口处捕获的只读判别联合（remote-owner | agent-work）。 */
export interface ExecutionContextPort {
  capture(): unknown;
  verify(captured: unknown): boolean;
}

/** 失效通知：快照订阅的只读失效流（第 5 段实现）。 */
export interface ChangeNotificationPort {
  publish(notification: unknown): void;
  subscribe(listener: (notification: unknown) => void): () => void;
}
