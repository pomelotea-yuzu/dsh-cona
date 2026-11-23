// 聊天关联服务（tasks 6.1，design §7）：本机多对多关联 + 创建／认领的真实会话流程。
//
// 规则（design §7、spec project-conversation-context）：
// - 链接只表达背景关系，不构成写授权（写绑定属 6.2 的 WorkRun）；
// - 新建聊天是文件协议以外的动作：先持久登记意图，再调宿主，写回实际返回 id；
//   结果未知时保留 pending，由显式 reconcile 核对候选，绝不自动再建第二个聊天；
// - 认领／关联必须核对宿主列表中的实际 Session 身份，不把预期 id 或其他执行聊天写入关系；
// - 单纯打开已有聊天不激活写绑定；
// - 关联与意图变更只推进 stateRevision，不写公开资料（project-command-commit：单独关联只推状态修订）。
//
// 本文件不依赖宿主、Node 或 React：宿主会话目录与规划节点视图经端口注入。

import type {
  LocalStateStorePort,
  PlanNodeViewPort,
  PublishHooksPort,
  SessionDirectoryPort,
} from './ports.js';
import { InstanceCommandQueue } from './command-queue.js';
import {
  conversationStateOf,
  type ConversationIntent,
  type ConversationLink,
  type InstanceAggregate,
} from './local-state.js';

export type ConversationOrigin = 'panel' | 'agent';

export interface AddLinkRequest {
  operationId: string;
  sessionId: string;
  nodeIds: string[];
  purpose: string;
  origin?: ConversationOrigin;
}

export interface RemoveLinkRequest {
  operationId: string;
  linkId: string;
  /** 缺省删除整条链接；给出时只从该链接移除这些节点（链接无节点时整条删除）。 */
  nodeIds?: string[];
}

export interface PrepareChatRequest {
  operationId: string;
  nodeIds: string[];
  purpose: string;
  origin?: ConversationOrigin;
}

export interface ClaimChatRequest {
  operationId: string;
  sessionId: string;
  nodeIds: string[];
  purpose: string;
  origin?: ConversationOrigin;
}

export interface LinkView extends ConversationLink {
  /** 宿主列表中可见；false 表示关联已失效（会话不可见）。 */
  visible: boolean;
  blank: boolean | null;
}

export interface ChatsView {
  links: LinkView[];
  /** 待核对意图（pending／unknown），含 reconcile 候选。 */
  pendingIntents: Array<ConversationIntent & { candidates?: string[] }>;
}

/** 宿主可见会话（选择已有）：只读投影，不含 Agent 内容。 */
export interface SessionChoice {
  sessionId: string;
  blank: boolean;
  running: boolean;
  updatedAt: number;
  /** 本实例已有链接指向该会话（多用途时为多条链接）。 */
  linked: boolean;
}

/** 会话目录视图：目录不可用时给稳定码，不冒充空列表。 */
export type SessionsOutcome = ConversationOutcome<{ sessions: SessionChoice[] }>;

export type ConversationOutcome<S> =
  | { status: 'committed'; value: S; stateRevision: number }
  | { status: 'rejected'; code: string; message: string }
  | { status: 'unknown-state'; code: string; message: string; stage: string };

interface ConversationServiceDeps {
  localRoot: string;
  /** 本服务绑定的单一实例；host 每实例装配，测试显式指定。 */
  instanceId: string;
  store: LocalStateStorePort;
  directory: SessionDirectoryPort;
  planNodes: PlanNodeViewPort;
  clock: () => string;
  newLinkId: () => string;
  /** 与规划命令共享的每实例队列，保证聊天写与命令提交在实例内串行。 */
  queue: InstanceCommandQueue;
  /** 测试故障注入；生产不传。 */
  hooks?: { beforeAggregateReplace?: PublishHooksPort };
}

interface MutationResult {
  aggregate: InstanceAggregate;
  /** 本次是否真的改动了聚合（幂等重复不推进修订）。 */
  changed: boolean;
}

/** 聊天关联：创建／认领／链接／解除与待核对 reconcile。 */
export class ConversationService {
  private readonly deps: ConversationServiceDeps;

  constructor(deps: ConversationServiceDeps) {
    this.deps = deps;
  }

  /** 直接关联一个已知 Session（多对多；同一 Session 多用途是多条链接）。 */
  async linkChat(request: AddLinkRequest): Promise<ConversationOutcome<{ linkId: string; reused: boolean }>> {
    const guard = await this.guardRequest(request.operationId, request.sessionId, request.nodeIds);
    if (guard !== null) return guard;
    return this.deps.queue.run(this.mutationInstanceId(), async () => {
      const read = await this.readAggregate();
      if ('outcome' in read) return read.outcome;
      // 核查实际关联：宿主列表中不可见的会话不得被认领（失效／另一实例的会话不静默写入）。
      let directory: Awaited<ReturnType<SessionDirectoryPort['listSessions']>>;
      try {
        directory = await this.deps.directory.listSessions();
      } catch (error) {
        return { status: 'rejected' as const, code: 'session-directory-unavailable', message: (error as Error).message };
      }
      if (!directory.some((session) => session.sessionId === request.sessionId)) {
        return {
          status: 'rejected' as const,
          code: 'session-not-visible',
          message: '宿主会话列表中没有该 Session；不写入关联',
        };
      }
      const state = conversationStateOf(read.aggregate.conversations);
      // 同 Session + 同用途 = 一条链接（合并节点）；不同用途是多条链接（多对多，不用唯一 Session 字段替代）。
      const existing = state.links.find(
        (link) => link.sessionId === request.sessionId && link.purpose === request.purpose,
      );
      if (existing !== undefined && sameMembership(existing, request)) {
        // 相同归属的重复请求返回原结果（幂等），不推进修订。
        return { status: 'committed' as const, value: { linkId: existing.linkId, reused: true }, stateRevision: read.aggregate.revisions.state };
      }
      const now = this.deps.clock();
      const link: ConversationLink = existing !== undefined
        ? { ...existing, nodeIds: mergeIds(existing.nodeIds, request.nodeIds), updatedAt: now }
        : {
            linkId: this.deps.newLinkId(),
            sessionId: request.sessionId,
            nodeIds: [...new Set(request.nodeIds)],
            purpose: request.purpose,
            origin: request.origin ?? 'panel',
            createdAt: now,
            updatedAt: now,
          };
      const links = existing !== undefined
        ? state.links.map((item) => (item.linkId === existing.linkId ? link : item))
        : [...state.links, link];
      const outcome = await this.persist(read.aggregate, { links, intents: state.intents });
      if (outcome.status !== 'committed') return outcome;
      return { status: 'committed' as const, value: { linkId: link.linkId, reused: false }, stateRevision: outcome.stateRevision };
    });
  }

  async unlinkChat(request: RemoveLinkRequest): Promise<ConversationOutcome<{ removed: boolean }>> {
    return this.deps.queue.run(this.mutationInstanceId(), async () => {
      const read = await this.readAggregate();
      if ('outcome' in read) return read.outcome;
      const state = conversationStateOf(read.aggregate.conversations);
      const existing = state.links.find((link) => link.linkId === request.linkId);
      if (existing === undefined) {
        return { status: 'committed' as const, value: { removed: false }, stateRevision: read.aggregate.revisions.state };
      }
      const remaining =
        request.nodeIds === undefined
          ? null
          : existing.nodeIds.filter((id) => !request.nodeIds?.includes(id));
      const links = remaining === null || remaining.length === 0
        ? state.links.filter((link) => link.linkId !== request.linkId)
        : state.links.map((link) =>
            link.linkId === request.linkId ? { ...link, nodeIds: remaining, updatedAt: this.deps.clock() } : link,
          );
      const outcome = await this.persist(read.aggregate, { links, intents: state.intents });
      if (outcome.status !== 'committed') return outcome;
      return { status: 'committed' as const, value: { removed: true }, stateRevision: outcome.stateRevision };
    });
  }

  /**
   * 创建聊天：先落意图，再调宿主，写回实际返回 id。
   * 宿主调用异常时意图保留 pending（结果未知），由 reconcileChats 核对；本方法绝不重试 create。
   */
  async createChat(
    request: PrepareChatRequest,
  ): Promise<ConversationOutcome<{ sessionId: string; linkId: string; reusedBlank: boolean }>> {
    const guard = await this.guardRequest(request.operationId, null, request.nodeIds);
    if (guard !== null) return guard;
    // 步骤 1：意图先落盘（每次都推进修订，意图登记本身是本机状态变化）。
    const prepared = await this.prepareIntent({ ...request, action: 'create' });
    if (prepared.status !== 'committed') return prepared;

    // 步骤 2：调宿主；异常 = 结果未知（意图保留 pending），不盲目再建。
    let sessionId: string;
    try {
      const created = await this.deps.directory.createSession();
      sessionId = created.sessionId;
    } catch (error) {
      await this.markIntent(request.operationId, 'unknown', `宿主创建结果未知：${(error as Error).message}`);
      return { status: 'rejected', code: 'session-create-unknown', message: (error as Error).message };
    }
    if (typeof sessionId !== 'string' || sessionId === '') {
      await this.markIntent(request.operationId, 'unknown', '宿主返回的 Session 身份为空');
      return { status: 'rejected', code: 'session-identity-missing', message: '宿主未返回有效 Session id' };
    }

    // 步骤 3：核对实际返回身份并写链接（认领走同一落盘路径）。
    const claimed = await this.settleSession({
      operationId: request.operationId,
      sessionId,
      nodeIds: request.nodeIds,
      purpose: request.purpose,
      origin: request.origin ?? 'panel',
    });
    if (claimed.status !== 'committed') return claimed;
    return {
      status: 'committed',
      value: { sessionId, linkId: claimed.value.linkId, reusedBlank: claimed.value.reusedBlank },
      stateRevision: claimed.stateRevision,
    };
  }

  /** 显式认领（reconcile 之后由用户／上层确认）：先落意图，再核对宿主实际身份后落链接。 */
  async claimChat(request: ClaimChatRequest): Promise<ConversationOutcome<{ linkId: string; reusedBlank: boolean }>> {
    const guard = await this.guardRequest(request.operationId, request.sessionId, request.nodeIds);
    if (guard !== null) return guard;
    const prepared = await this.prepareIntent({ ...request, action: 'claim' });
    if (prepared.status !== 'committed') return prepared;
    return this.settleSession({
      operationId: request.operationId,
      sessionId: request.sessionId,
      nodeIds: request.nodeIds,
      purpose: request.purpose,
      origin: request.origin ?? 'panel',
    });
  }

  /**
   * 待核对：对每个 create／claim 的 pending 意图给出宿主列表候选（空白且晚于意图登记时间的会话），
   * 不写链接、不再创建。候选只供显式 claimChat 确认。
   */
  async reconcileChats(): Promise<ConversationOutcome<ChatsView>> {
    type ReconcileRead =
      | { outcome: ConversationOutcome<never> }
      | { view: { links: LinkView[]; pendingIntents: Array<ConversationIntent & { candidates?: string[] }> } };
    const read = await this.deps.queue.run(this.mutationInstanceId(), async (): Promise<ReconcileRead> => {
      const read = await this.readAggregate();
      if ('outcome' in read) return { outcome: read.outcome };
      const state = conversationStateOf(read.aggregate.conversations);
      let directory: Awaited<ReturnType<SessionDirectoryPort['listSessions']>>;
      try {
        directory = await this.deps.directory.listSessions();
      } catch (error) {
        return { outcome: { status: 'rejected' as const, code: 'session-directory-unavailable', message: (error as Error).message } };
      }
      const known = new Set(state.links.map((link) => link.sessionId));
      const pendingIntents = state.intents
        .filter((intent) => intent.status !== 'linked')
        .map((intent) => {
          const createdMs = Date.parse(intent.createdAt);
          const candidates = intent.action === 'create'
            ? directory
                .filter(
                  (session) =>
                    session.blank &&
                    !known.has(session.sessionId) &&
                    Number.isFinite(createdMs) && session.updatedAt >= createdMs,
                )
                .map((session) => session.sessionId)
            : [];
          return { ...intent, ...(candidates.length > 0 ? { candidates } : {}) };
        });
      return { view: { links: withVisibility(state.links, directory), pendingIntents } };
    });
    if ('outcome' in read) return read.outcome;
    return { status: 'committed', value: read.view, stateRevision: -1 };
  }

  /** 关联列表（含失效检查）；只读。 */
  async listChats(): Promise<ConversationOutcome<ChatsView>> {
    type ListRead =
      | { outcome: ConversationOutcome<never> }
      | { view: { links: LinkView[]; pendingIntents: ConversationIntent[] } };
    const read = await this.deps.queue.run(this.mutationInstanceId(), async (): Promise<ListRead> => {
      const read = await this.readAggregate();
      if ('outcome' in read) return { outcome: read.outcome };
      const state = conversationStateOf(read.aggregate.conversations);
      let directory: Awaited<ReturnType<SessionDirectoryPort['listSessions']>>;
      try {
        directory = await this.deps.directory.listSessions();
      } catch {
        // 目录不可用时照常返回链接；visible 记 null（未知，不冒充失效）。
        return {
          view: {
            links: state.links.map((link) => ({ ...link, visible: null as unknown as boolean, blank: null })),
            pendingIntents: [...state.intents],
          },
        };
      }
      const pendingIntents = state.intents.filter((intent) => intent.status !== 'linked');
      return { view: { links: withVisibility(state.links, directory), pendingIntents } };
    });
    if ('outcome' in read) return read.outcome;
    return { status: 'committed', value: read.view, stateRevision: -1 };
  }

  /**
   * 宿主可见会话（tasks 3.1「选择已有」）：只读列举，标注本实例是否已有链接。
   * 目录不可用给稳定码，不返回空列表冒充「没有会话」。
   */
  async listSessions(): Promise<SessionsOutcome> {
    type SessionsRead =
      | { outcome: ConversationOutcome<never> }
      | { sessions: SessionChoice[] };
    const read = await this.deps.queue.run(this.mutationInstanceId(), async (): Promise<SessionsRead> => {
      const current = await this.readAggregate();
      if ('outcome' in current) return { outcome: current.outcome };
      const state = conversationStateOf(current.aggregate.conversations);
      const linked = new Set(state.links.map((link) => link.sessionId));
      let directory: Awaited<ReturnType<SessionDirectoryPort['listSessions']>>;
      try {
        directory = await this.deps.directory.listSessions();
      } catch (error) {
        return {
          outcome: { status: 'rejected' as const, code: 'session-directory-unavailable', message: (error as Error).message },
        };
      }
      return {
        sessions: directory.map((session) => ({
          sessionId: session.sessionId,
          blank: session.blank,
          running: session.running,
          updatedAt: session.updatedAt,
          linked: linked.has(session.sessionId),
        })),
      };
    });
    if ('outcome' in read) return read.outcome;
    return { status: 'committed', value: { sessions: read.sessions }, stateRevision: -1 };
  }

  /**
   * 打开前复查（tasks 3.1「按实际 Session 打开」）：链接仍存在、宿主列表可见。
   * 只验证身份；导航由 client 用宿主能力完成，不建立任何执行绑定。
   */
  async openTarget(request: { linkId: string }): Promise<ConversationOutcome<{ sessionId: string }>> {
    if (typeof request?.linkId !== 'string' || request.linkId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少 linkId' };
    }
    const read = await this.deps.queue.run(this.mutationInstanceId(), async () => {
      const current = await this.readAggregate();
      if ('outcome' in current) return current;
      const state = conversationStateOf(current.aggregate.conversations);
      const link = state.links.find((item) => item.linkId === request.linkId);
      if (link === undefined) {
        return {
          outcome: { status: 'rejected' as const, code: 'resume-link-missing', message: '本机聊天链接不存在（可能已解除关联）' },
        };
      }
      let directory: Awaited<ReturnType<SessionDirectoryPort['listSessions']>>;
      try {
        directory = await this.deps.directory.listSessions();
      } catch (error) {
        return {
          outcome: { status: 'rejected' as const, code: 'session-directory-unavailable', message: (error as Error).message },
        };
      }
      if (!directory.some((session) => session.sessionId === link.sessionId)) {
        return {
          outcome: { status: 'rejected' as const, code: 'session-not-visible', message: '该会话在宿主中不可见（可能已删除）' },
        };
      }
      return { sessionId: link.sessionId };
    });
    if ('outcome' in read) return read.outcome;
    return { status: 'committed', value: { sessionId: read.sessionId }, stateRevision: -1 };
  }

  // ---------- 内部 ----------

  private mutationInstanceId(): string {
    return this.deps.instanceId;
  }

  private async guardRequest(
    operationId: string,
    sessionId: string | null,
    nodeIds: string[],
  ): Promise<ConversationOutcome<never> | null> {
    if (typeof operationId !== 'string' || operationId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少 operationId' };
    }
    if (sessionId !== null && (typeof sessionId !== 'string' || sessionId === '')) {
      return { status: 'rejected', code: 'session-identity-missing', message: 'Session 身份缺失或为空' };
    }
    const ids = validNodeIds(nodeIds);
    if (ids === null) {
      return { status: 'rejected', code: 'operation-mismatch', message: 'nodeIds 必须是非空字符串数组' };
    }
    const nodes = await this.deps.planNodes.currentNodeIds();
    if (!nodes.ok) {
      return { status: 'rejected', code: nodes.code, message: nodes.message };
    }
    const missing = ids.filter((id) => !nodes.nodeIds.has(id));
    if (missing.length > 0) {
      return {
        status: 'rejected',
        code: 'unknown-node',
        message: `节点不存在于当前资料：${missing.join(', ')}`,
      };
    }
    return null;
  }

  private async readAggregate(): Promise<
    { aggregate: InstanceAggregate } | { outcome: ConversationOutcome<never> }
  > {
    const quarantined = await this.deps.store.readQuarantine(this.deps.localRoot, this.deps.instanceId);
    if (quarantined !== null) {
      return {
        outcome: {
          status: 'rejected',
          code: 'unknown-state',
          message: `该实例已隔离（${quarantined.reason}，阶段 ${quarantined.stage}）；聊天读写停止`,
        },
      };
    }
    const aggregate = await this.deps.store.readAggregate(this.deps.localRoot, this.deps.instanceId);
    if (aggregate === null) {
      return { outcome: { status: 'rejected', code: 'binding-expired', message: '本机注册表中没有该实例' } };
    }
    return { aggregate };
  }

  private async prepareIntent(
    request: PrepareChatRequest & { action: 'create' | 'claim' },
  ): Promise<ConversationOutcome<{ operationId: string }>> {
    return this.deps.queue.run(this.mutationInstanceId(), async () => {
      const read = await this.readAggregate();
      if ('outcome' in read) return read.outcome;
      const state = conversationStateOf(read.aggregate.conversations);
      const intent: ConversationIntent = {
        operationId: request.operationId,
        action: request.action,
        nodeIds: [...new Set(request.nodeIds)],
        purpose: request.purpose,
        origin: request.origin ?? 'panel',
        createdAt: this.deps.clock(),
        status: 'pending',
      };
      const outcome = await this.persist(read.aggregate, {
        links: state.links,
        intents: [...state.intents.filter((item) => item.operationId !== intent.operationId), intent],
      });
      if (outcome.status !== 'committed') return outcome;
      return { status: 'committed' as const, value: { operationId: request.operationId }, stateRevision: outcome.stateRevision };
    });
  }

  /** 意图状态就地修改（不推进修订；结果未知标记随意图本身落盘由 persist 统一处理）。 */
  private async markIntent(operationId: string, status: 'unknown', detail: string): Promise<void> {
    await this.deps.queue.run(this.mutationInstanceId(), async () => {
      const read = await this.readAggregate();
      if ('outcome' in read) return;
      const state = conversationStateOf(read.aggregate.conversations);
      const intents = state.intents.map((intent) =>
        intent.operationId === operationId && intent.status === 'pending' ? { ...intent, status, detail } : intent,
      );
      await this.persist(read.aggregate, { links: state.links, intents });
    });
  }

  private async settleSession(request: {
    operationId: string;
    sessionId: string;
    nodeIds: string[];
    purpose: string;
    origin: ConversationOrigin;
  }): Promise<ConversationOutcome<{ linkId: string; reusedBlank: boolean }>> {
    return this.deps.queue.run(this.mutationInstanceId(), async () => {
      const read = await this.readAggregate();
      if ('outcome' in read) return read.outcome;
      // 核对宿主实际身份：不在可见列表中的会话不得被认领（失效／另一实例的会话不静默认领）。
      let directory: Awaited<ReturnType<SessionDirectoryPort['listSessions']>>;
      try {
        directory = await this.deps.directory.listSessions();
      } catch (error) {
        // 已在队列任务内：就地标记，不嵌套入队。
        const state = conversationStateOf(read.aggregate.conversations);
        const intents = state.intents.map((intent) =>
          intent.operationId === request.operationId && intent.status === 'pending'
            ? { ...intent, status: 'unknown' as const, detail: `宿主列表不可用：${(error as Error).message}` }
            : intent,
        );
        await this.persist(read.aggregate, { links: state.links, intents });
        return { status: 'rejected' as const, code: 'session-directory-unavailable', message: (error as Error).message };
      }
      const actual = directory.find((session) => session.sessionId === request.sessionId);
      if (actual === undefined) {
        // 已在队列任务内：就地标记意图为 unknown，不嵌套入队（死锁）。
        const state = conversationStateOf(read.aggregate.conversations);
        const intents = state.intents.map((intent) =>
          intent.operationId === request.operationId && intent.status === 'pending'
            ? { ...intent, status: 'unknown' as const, detail: `宿主列表中没有 ${request.sessionId}` }
            : intent,
        );
        await this.persist(read.aggregate, { links: state.links, intents });
        return {
          status: 'rejected' as const,
          code: 'session-not-visible',
          message: '宿主会话列表中没有该 Session；不写入关联',
        };
      }
      const state = conversationStateOf(read.aggregate.conversations);
      const now = this.deps.clock();
      // 同 Session + 同用途 = 一条链接；不同用途是多条链接（多对多）。
      const existing = state.links.find(
        (link) => link.sessionId === request.sessionId && link.purpose === request.purpose,
      );
      const link: ConversationLink = existing !== undefined && sameMembership(existing, request)
        ? existing
        : existing !== undefined
          ? { ...existing, nodeIds: mergeIds(existing.nodeIds, request.nodeIds), updatedAt: now }
          : {
              linkId: this.deps.newLinkId(),
              sessionId: request.sessionId,
              nodeIds: [...new Set(request.nodeIds)],
              purpose: request.purpose,
              origin: request.origin,
              createdAt: now,
              updatedAt: now,
            };
      const links = existing !== undefined
        ? state.links.map((item) => (item.linkId === existing.linkId ? link : item))
        : [...state.links, link];
      const intents = state.intents.map((intent) =>
        intent.operationId === request.operationId
          ? { ...intent, status: 'linked' as const, resolvedSessionId: request.sessionId, detail: undefined }
          : intent,
      );
      const outcome = await this.persist(read.aggregate, { links, intents });
      if (outcome.status !== 'committed') return outcome;
      return {
        status: 'committed' as const,
        value: { linkId: link.linkId, reusedBlank: actual.blank },
        stateRevision: outcome.stateRevision,
      };
    });
  }

  /** 聚合替换 + stateRevision 推进；unknown-state 时与命令层同样进入隔离。 */
  private async persist(
    aggregate: InstanceAggregate,
    conversations: { links: ConversationLink[]; intents: ConversationIntent[] },
  ): Promise<
    { status: 'committed'; stateRevision: number }
    | { status: 'rejected'; code: string; message: string }
    | { status: 'unknown-state'; code: string; message: string; stage: string }
  > {
    const next: InstanceAggregate = {
      ...aggregate,
      conversations,
      revisions: { ...aggregate.revisions, state: aggregate.revisions.state + 1 },
    };
    const result = await this.deps.store.replaceAggregateChecked(
      this.deps.localRoot,
      next,
      this.deps.hooks?.beforeAggregateReplace,
    );
    if (result.status === 'saved') {
      return { status: 'committed' as const, stateRevision: next.revisions.state };
    }
    if (result.status === 'not-saved') {
      return {
        status: 'rejected' as const,
        code: 'persistence-failed',
        message: `本机聚合未保存（阶段 ${result.stage}）：${result.detail ?? ''}`,
      };
    }
    // unknown-state：与命令层一致，进入隔离停止该实例读写。
    await this.deps.store.quarantine(this.deps.localRoot, {
      schemaVersion: 1,
      instanceId: aggregate.instanceId,
      reason: 'unknown-state',
      stage: `conversation:${result.stage}`,
      createdAt: this.deps.clock(),
      detail: result.detail,
      requires: 'offline-review',
    });
    return {
      status: 'unknown-state',
      code: 'unknown-state',
      message: `本机聚合写入结果未知（阶段 ${result.stage}）；实例已隔离，只读诊断可用`,
      stage: result.stage,
    };
  }
}

function withVisibility(
  links: readonly ConversationLink[],
  directory: readonly { sessionId: string; blank: boolean }[],
): LinkView[] {
  return links.map((link) => {
    const actual = directory.find((session) => session.sessionId === link.sessionId);
    return { ...link, visible: actual !== undefined, blank: actual?.blank ?? null };
  });
}

function validNodeIds(nodeIds: unknown): string[] | null {
  if (!Array.isArray(nodeIds) || nodeIds.length === 0) return null;
  return nodeIds.every((id) => typeof id === 'string' && id !== '') ? [...(nodeIds as string[])] : null;
}

function sameMembership(
  link: Pick<ConversationLink, 'nodeIds' | 'purpose'>,
  request: { nodeIds: string[]; purpose: string },
): boolean {
  return (
    link.purpose === request.purpose
    && link.nodeIds.length === new Set(request.nodeIds).size
    && request.nodeIds.every((id) => link.nodeIds.includes(id))
  );
}

function mergeIds(existing: readonly string[], extra: readonly string[]): string[] {
  return [...new Set([...existing, ...extra])];
}
