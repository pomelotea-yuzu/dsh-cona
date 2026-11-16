// 工作意图、消息准入映射与活动 WorkRun（tasks 6.2，design §7）。
//
// 规则（design §7、spec project-conversation-context）：
// - 工作意图先落盘：目标集合、允许动作、原因可发布范围与输入规划基线由“开始工作”显式确认；
//   R1 不做自然语言自动扩权，绑定外变更先保留为建议。
// - 消息准入映射：意图登记期望消息来源（Client prompt 的 requestId，宿主保存为 source.rpcId）；
//   排队（next-turn 未消费）只登记，不改绑定；宿主实际消费时才首次匹配启动 WorkRun。
//   rpcId 不是授权令牌：匹配还须核对会话、turn 与实际 Agent 在场；工具提交时再核对真实
//   ToolRunContext 的 agent.id（见 captureBinding），仅凭消息里有同名 id 不授权。
// - 活动身份键＝(bootGeneration, sessionId, turn)；同一会话同时最多一个生效运行。
//   同轮已有活动绑定时，另一意图的消息消费保留为待执行意图（排队不覆盖当前绑定），
//   直到可信边界显式建立新绑定（重新 startWork 换新 rpcId）。
// - agent 缺失或归属不唯一：拒绝新绑定并记 blocked，不从模型参数或 owner 判据推导执行身份。
// - 绑定版本：规划命令成功后仅更新已接受基线并 +1（范围与动作不自动扩大）；
//   已捕获旧版本的并行／迟到调用被拒绝。
// - 私有授权只存本机聚合：导入外部 v1 公开资料不带来任何意图／运行／绑定。
// - Host 重启只恢复历史：旧 bootGeneration 的运行不再有写资格；重启不复活任何绑定。
//
// 本文件不依赖宿主、Node 或 React：规划节点视图经端口注入。

import type { Command } from './command-service.js';
import { InstanceCommandQueue } from './command-queue.js';
import {
  WORK_ACTIONS,
  workStateOf,
  type InstanceAggregate,
  type WorkAction,
  type WorkBaseline,
  type WorkIntent,
  type WorkRunRecord,
} from './local-state.js';
import type { LocalStateStorePort, PlanNodeViewPort } from './ports.js';

export type { WorkAction, WorkBaseline, WorkIntent, WorkRunRecord };
export { WORK_ACTIONS };

export type WorkOutcome<S> =
  | { status: 'committed'; value: S; stateRevision: number }
  | { status: 'rejected'; code: string; message: string }
  | { status: 'unknown-state'; code: string; message: string; stage: string };

/** 消息准入观测结果：unmatched／deferred 是正常流（不属任何意图或同会话已有绑定）。 */
export type AdmissionResult =
  | { status: 'unmatched' }
  | { status: 'queued'; matched: number; stateRevision: number }
  | { status: 'ended'; workRunId: string; kind: 'completed' | 'aborted'; stateRevision: number }
  | {
      status: 'started';
      workRunId: string;
      workIntentId: string;
      bindingVersion: number;
      sessionId: string;
      turn: number;
      stateRevision: number;
    }
  | { status: 'deferred'; reason: 'session-busy'; workIntentId: string }
  | {
      status: 'blocked';
      reason: 'ambiguous-intent' | 'agent-missing' | 'session-mismatch';
      workIntentIds: string[];
      stateRevision: number;
    }
  | { status: 'rejected'; code: string; message: string }
  | { status: 'unknown-state'; code: string; message: string; stage: string };

export interface PrepareWorkRequest {
  workIntentId: string;
  nodeIds: string[];
  allowedActions: WorkAction[];
  reasonScope: 'public' | 'local';
  purpose: string;
  origin?: 'panel' | 'agent';
  /** 输入规划基线：确认时所见快照；startWork 时与本机已知基线核对，过期即拒绝。 */
  baseline: WorkBaseline;
}

export interface StartWorkRequest {
  workIntentId: string;
  rpcId: string;
  sessionId?: string;
}

export interface QueuedMessageEvent {
  sessionId: string;
  rpcId: string;
}

export interface ConsumedMessageEvent {
  sessionId: string;
  rpcId: string;
  turn: number;
  /** 消费点是否有实际 Agent 归属（2.4：工具侧 agent.id＝SessionId）；缺失即拒绝新绑定。 */
  agentPresent: boolean;
}

export interface TurnEndEvent {
  sessionId: string;
  turn: number;
  kind: 'completed' | 'aborted';
}

export interface WorkCapture {
  workRunId: string;
  bindingVersion: number;
  sessionId: string;
  turn: number;
  targets: string[];
  allowedActions: WorkAction[];
  reasonScope: 'public' | 'local';
  acceptedBaseline: WorkBaseline;
}

export type CaptureResult =
  | { ok: true; capture: WorkCapture }
  | { ok: false; code: 'agent-missing' | 'binding-expired' | 'binding-ambiguous'; message: string };

export interface WorkIntentView extends WorkIntent {
  /** 运行中且属于当前宿主代际；false 表示历史／已失效。 */
  runActive: boolean;
}

export interface WorkRunView extends WorkRunRecord {
  /** status==='active' 且属于当前宿主代际；重启后旧代际运行不再有写资格。 */
  effective: boolean;
}

export interface WorkListView {
  intents: WorkIntentView[];
  runs: WorkRunView[];
  stateRevision: number;
}

/** 命令 → 工作动作映射（design §7 允许动作子集）。 */
export function commandAction(command: Command): WorkAction {
  switch (command.type) {
    case 'add-nodes':
      return 'add';
    case 'update-node':
      return 'update';
    case 'split-node':
      return 'split';
    case 'set-dependencies':
      return 'dependencies';
    case 'append-record':
      return 'record';
    case 'set-node-status':
      return 'status';
  }
}

/**
 * 命令的目标节点集合：所有被写到的规划节点。add-nodes 以父节点为目标；
 * 父为 null（新增根级节点）不在任何节点目标集合内，准入层直接拒绝。
 */
export function commandTargets(command: Command): string[] {
  switch (command.type) {
    case 'add-nodes': {
      const parents = command.nodes.map((node) => node.parentId).filter((id): id is string => id !== null);
      return [...new Set(parents)];
    }
    case 'update-node':
      return [command.nodeId];
    case 'split-node':
      return [command.parentId];
    case 'set-dependencies':
      return [...new Set(command.dependencies.flatMap((edge) => [edge.nodeId, edge.requiresNodeId]))];
    case 'set-node-status':
      return [command.nodeId];
    case 'append-record':
      return [...new Set(command.subjectNodeIds)];
  }
}

interface WorkServiceDeps {
  localRoot: string;
  /** 本服务绑定的单一实例；host 每实例装配，测试显式指定。 */
  instanceId: string;
  store: LocalStateStorePort;
  planNodes: PlanNodeViewPort;
  clock: () => string;
  newWorkRunId: () => string;
  /** 宿主启动代际：每次宿主进程启动不同；运行只在本代际内生效。 */
  bootGeneration: number;
  queue: InstanceCommandQueue;
}

/** 读取失败的稳定拒绝（readAggregate 只会拒绝，不会提交）。 */
type WorkRejection =
  | { status: 'rejected'; code: string; message: string }
  | { status: 'unknown-state'; code: string; message: string; stage: string };

export class WorkService {
  private readonly deps: WorkServiceDeps;

  constructor(deps: WorkServiceDeps) {
    this.deps = deps;
  }

  // ---------- 意图登记与确认 ----------

  /** 登记工作意图（pending）：范围尚未生效，等“开始工作”确认。 */
  async prepareWork(request: PrepareWorkRequest): Promise<WorkOutcome<{ workIntentId: string; reused: boolean }>> {
    const invalid = this.validatePrepareRequest(request);
    if (invalid !== null) return invalid;
    const nodes = await this.deps.planNodes.currentNodeIds();
    if (!nodes.ok) return { status: 'rejected', code: nodes.code, message: nodes.message };
    const missing = request.nodeIds.filter((id) => !nodes.nodeIds.has(id));
    if (missing.length > 0) {
      return { status: 'rejected', code: 'unknown-node', message: `节点不存在于当前资料：${missing.join(', ')}` };
    }
    return this.deps.queue.run(this.deps.instanceId, async () => {
      const read = await this.readAggregate();
      if ('outcome' in read) return read.outcome;
      const work = workStateOf(read.aggregate);
      const existing = work.intents.find((intent) => intent.workIntentId === request.workIntentId);
      if (existing !== undefined) {
        if (sameIntent(existing, request)) {
          return {
            status: 'committed' as const,
            value: { workIntentId: request.workIntentId, reused: true },
            stateRevision: read.aggregate.revisions.state,
          };
        }
        return {
          status: 'rejected' as const,
          code: 'operation-mismatch',
          message: 'workIntentId 已被不同范围的意图占用；换新 id，不覆盖旧意图',
        };
      }
      const now = this.deps.clock();
      const intent: WorkIntent = {
        workIntentId: request.workIntentId,
        nodeIds: [...new Set(request.nodeIds)],
        allowedActions: [...request.allowedActions],
        reasonScope: request.reasonScope,
        purpose: request.purpose,
        origin: request.origin ?? 'panel',
        baseline: { ...request.baseline },
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      };
      const outcome = await this.persist(read.aggregate, (aggregate) => ({
        ...aggregate,
        workIntents: [...work.intents, intent],
      }));
      if (outcome.status !== 'committed') return outcome;
      return {
        status: 'committed' as const,
        value: { workIntentId: request.workIntentId, reused: false },
        stateRevision: outcome.stateRevision,
      };
    });
  }

  /**
   * “开始工作”（tasks 6.2，design §7）：确认具体范围并登记期望消息来源。
   * 基线与本机已知状态不一致时拒绝（先刷新再重新确认）；重启后的 pending 意图仍可确认，
   * 但确认只等新消息消费，不恢复任何旧运行。
   */
  async startWork(request: StartWorkRequest): Promise<WorkOutcome<{ workIntentId: string; status: 'awaiting-message' }>> {
    if (typeof request.rpcId !== 'string' || request.rpcId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少期望消息 rpcId' };
    }
    if (request.sessionId !== undefined && (typeof request.sessionId !== 'string' || request.sessionId === '')) {
      return { status: 'rejected', code: 'operation-mismatch', message: 'sessionId 为空' };
    }
    return this.deps.queue.run(this.deps.instanceId, async () => {
      const read = await this.readAggregate();
      if ('outcome' in read) return read.outcome;
      const { aggregate } = read;
      const work = workStateOf(aggregate);
      const intent = work.intents.find((item) => item.workIntentId === request.workIntentId);
      if (intent === undefined) {
        return { status: 'rejected' as const, code: 'binding-expired', message: '工作意图不存在；先 prepareWork 登记' };
      }
      if (intent.status !== 'pending' && intent.status !== 'awaiting-message') {
        return {
          status: 'rejected' as const,
          code: 'binding-expired',
          message: `意图状态为 ${intent.status}；只有 pending／awaiting-message 可确认，不复活已结束或被拒绝的意图`,
        };
      }
      // 输入基线核对：确认时的基线必须是本机已知当前基线，过期即拒绝（先刷新）。
      const knownPlanVersion = aggregate.lastObservation?.planVersion;
      if (
        intent.baseline.planRevision !== aggregate.revisions.plan
        || intent.baseline.sourceEpoch !== aggregate.source.generation
        || (knownPlanVersion !== undefined && knownPlanVersion !== null && intent.baseline.planVersion !== knownPlanVersion)
      ) {
        return {
          status: 'rejected' as const,
          code: 'baseline-stale',
          message: '意图基线与本机已知基线不一致；先刷新资料并以最新快照重新确认范围',
        };
      }
      const intents = work.intents.map((item) =>
        item.workIntentId === request.workIntentId
          ? {
              ...item,
              status: 'awaiting-message' as const,
              expectedRpcId: request.rpcId,
              ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
              blockedReason: undefined,
              updatedAt: this.deps.clock(),
            }
          : item,
      );
      const outcome = await this.persist(aggregate, (next) => ({ ...next, workIntents: intents }));
      if (outcome.status !== 'committed') return outcome;
      return {
        status: 'committed' as const,
        value: { workIntentId: request.workIntentId, status: 'awaiting-message' as const },
        stateRevision: outcome.stateRevision,
      };
    });
  }

  // ---------- 消息准入映射 ----------

  /**
   * 排队观测（2.4：prompt mode queue → `agent/inbox/spliced target=next-turn`）：
   * 只登记排队事实，不改状态、不启动运行、不改绑定（排队消息不覆盖当前目标）。
   */
  async observeQueued(event: QueuedMessageEvent): Promise<AdmissionResult> {
    if (!validMessageEvent(event)) {
      return { status: 'rejected', code: 'operation-mismatch', message: '排队事件缺少 sessionId 或 rpcId' };
    }
    return this.deps.queue.run(this.deps.instanceId, async () => {
      const read = await this.readAggregate();
      if ('outcome' in read) return read.outcome;
      const work = workStateOf(read.aggregate);
      const now = this.deps.clock();
      let matched = 0;
      const intents = work.intents.map((intent) =>
        intent.status === 'awaiting-message' && intent.expectedRpcId === event.rpcId
          ? (++matched, { ...intent, queuedAt: now, updatedAt: now })
          : intent,
      );
      if (matched === 0) return { status: 'unmatched' };
      const outcome = await this.persist(read.aggregate, (next) => ({ ...next, workIntents: intents }));
      if (outcome.status !== 'committed') return outcome;
      return { status: 'queued' as const, matched, stateRevision: outcome.stateRevision };
    });
  }

  /**
   * 消费观测（2.4：`agent/inbox/spliced removed` + user/message，或 pre-step）：
   * 首次唯一匹配启动 WorkRun。归属不唯一（同 rpcId 多意图）或 agent 缺失 → 拒绝新绑定记 blocked；
   * 同会话已有生效绑定 → 意图保留待执行（deferred），直到可信边界显式建立新绑定。
   */
  async observeConsumed(event: ConsumedMessageEvent): Promise<AdmissionResult> {
    if (!validMessageEvent(event)) {
      return { status: 'rejected', code: 'operation-mismatch', message: '消费事件缺少 sessionId 或 rpcId' };
    }
    if (!Number.isSafeInteger(event.turn) || (event.turn as number) < 0) {
      return { status: 'rejected', code: 'operation-mismatch', message: '消费事件缺少有效 turn；无法建立唯一执行归属' };
    }
    return this.deps.queue.run(this.deps.instanceId, async () => {
      const read = await this.readAggregate();
      if ('outcome' in read) return read.outcome;
      const { aggregate } = read;
      const work = workStateOf(aggregate);
      const candidates = work.intents.filter(
        (intent) =>
          intent.status === 'awaiting-message'
          && intent.expectedRpcId === event.rpcId
          && (intent.sessionId === undefined || intent.sessionId === event.sessionId),
      );
      if (candidates.length === 0) return { status: 'unmatched' };

      const now = this.deps.clock();
      if (candidates.length > 1) {
        // 归属不唯一：同一消息匹配多个待执行意图，拒绝新绑定并记 blocked（2.4b(i)）。
        const ids = candidates.map((intent) => intent.workIntentId);
        const intents = work.intents.map((intent) =>
          candidates.some((candidate) => candidate.workIntentId === intent.workIntentId)
            ? {
                ...intent,
                status: 'blocked' as const,
                blockedReason: `归属不唯一：消息 ${event.rpcId} 同时匹配 ${candidates.length} 个待执行意图；拒绝建立绑定`,
                updatedAt: now,
              }
            : intent,
        );
        const outcome = await this.persist(aggregate, (next) => ({ ...next, workIntents: intents }));
        if (outcome.status !== 'committed') return outcome;
        return { status: 'blocked' as const, reason: 'ambiguous-intent' as const, workIntentIds: ids, stateRevision: outcome.stateRevision };
      }

      const intent = candidates[0] as WorkIntent;
      if (event.agentPresent !== true) {
        // agent 缺失：消费点没有实际 Agent 归属，拒绝新绑定并记 blocked（2.4b(i)）。
        const intents = work.intents.map((item) =>
          item.workIntentId === intent.workIntentId
            ? {
                ...item,
                status: 'blocked' as const,
                blockedReason: 'agent 缺失：消费事件没有实际 Agent 归属；不从模型参数或判据空值推导执行身份',
                updatedAt: now,
              }
            : item,
        );
        const outcome = await this.persist(aggregate, (next) => ({ ...next, workIntents: intents }));
        if (outcome.status !== 'committed') return outcome;
        return { status: 'blocked' as const, reason: 'agent-missing' as const, workIntentIds: [intent.workIntentId], stateRevision: outcome.stateRevision };
      }
      if (intent.sessionId !== undefined && intent.sessionId !== event.sessionId) {
        const intents = work.intents.map((item) =>
          item.workIntentId === intent.workIntentId
            ? {
                ...item,
                status: 'blocked' as const,
                blockedReason: `会话不符：期望 ${intent.sessionId}，消费发生在 ${event.sessionId}`,
                updatedAt: now,
              }
            : item,
        );
        const outcome = await this.persist(aggregate, (next) => ({ ...next, workIntents: intents }));
        if (outcome.status !== 'committed') return outcome;
        return { status: 'blocked' as const, reason: 'session-mismatch' as const, workIntentIds: [intent.workIntentId], stateRevision: outcome.stateRevision };
      }

      // 同会话已有生效绑定：排队／steer 消费不覆盖当前绑定，意图保留待执行。
      const busy = work.runs.some((run) => run.sessionId === event.sessionId && this.effectiveRun(run));
      if (busy) {
        return { status: 'deferred' as const, reason: 'session-busy' as const, workIntentId: intent.workIntentId };
      }

      const run: WorkRunRecord = {
        workRunId: this.deps.newWorkRunId(),
        workIntentId: intent.workIntentId,
        sessionId: event.sessionId,
        turn: event.turn,
        bootGeneration: this.deps.bootGeneration,
        bindingVersion: 1,
        acceptedBaseline: { ...intent.baseline },
        targets: [...intent.nodeIds],
        allowedActions: [...intent.allowedActions],
        reasonScope: intent.reasonScope,
        rpcId: event.rpcId,
        status: 'active',
        startedAt: now,
      };
      const intents = work.intents.map((item) =>
        item.workIntentId === intent.workIntentId
          ? { ...item, status: 'active' as const, updatedAt: now }
          : item,
      );
      const outcome = await this.persist(aggregate, (next) => ({
        ...next,
        workIntents: intents,
        workRuns: [...work.runs, run],
      }));
      if (outcome.status !== 'committed') return outcome;
      return {
        status: 'started' as const,
        workRunId: run.workRunId,
        workIntentId: intent.workIntentId,
        bindingVersion: 1,
        sessionId: event.sessionId,
        turn: event.turn,
        stateRevision: outcome.stateRevision,
      };
    });
  }

  // ---------- 工具侧捕获与准入 ----------

  /**
   * 工具执行开始时捕获绑定快照（真实 ToolRunContext：agent.id＝SessionId；无 invocation 正常）。
   * 无 agent → agent-missing；无生效绑定 → binding-expired（不因缺 invocation 授权，也不降级 owner）。
   */
  async captureBinding(sessionId: string | null | undefined): Promise<CaptureResult> {
    if (typeof sessionId !== 'string' || sessionId === '') {
      return {
        ok: false,
        code: 'agent-missing',
        message: '工具上下文没有实际 Agent（agent.id 缺失）；拒绝建立绑定，不从模型参数补值',
      };
    }
    const read = await this.readAggregate();
    if ('outcome' in read) {
      return { ok: false, code: 'binding-expired', message: read.outcome.message };
    }
    const work = workStateOf(read.aggregate);
    const active = work.runs.filter((run) => run.sessionId === sessionId && this.effectiveRun(run));
    if (active.length === 0) {
      return {
        ok: false,
        code: 'binding-expired',
        message: '该会话没有生效的 WorkRun 绑定；无 invocation 也不授权，先经可信边界建立绑定',
      };
    }
    if (active.length > 1) {
      return {
        ok: false,
        code: 'binding-ambiguous',
        message: `会话 ${sessionId} 存在 ${active.length} 个生效绑定；执行归属不唯一，拒绝`,
      };
    }
    const run = active[0] as WorkRunRecord;
    return {
      ok: true,
      capture: {
        workRunId: run.workRunId,
        bindingVersion: run.bindingVersion,
        sessionId: run.sessionId,
        turn: run.turn,
        targets: [...run.targets],
        allowedActions: [...run.allowedActions],
        reasonScope: run.reasonScope,
        acceptedBaseline: { ...run.acceptedBaseline },
      },
    };
  }

  /**
   * 提交序列准入（命令服务在 execute 前调用）：核对运行生效、绑定版本、动作与目标范围、
   * 命令基线与已接受基线一致。旧捕获版本或基线过期一律拒绝，不把新版本权限借给旧调用。
   */
  async authorizeAgentCommand(
    ctx: { kind: 'agent-work'; workRunId: string; bindingVersion: number; instanceId: string },
    envelope: { instanceId: string; sourceEpoch: number; expectedPlanVersion: string; expectedPlanRevision: number; command: Command },
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    if (ctx.instanceId !== envelope.instanceId) {
      return { ok: false, code: 'forbidden', message: '绑定实例与命令实例不一致' };
    }
    const read = await this.readAggregate();
    if ('outcome' in read) return { ok: false, code: read.outcome.status === 'rejected' ? read.outcome.code : 'unknown-state', message: read.outcome.message };
    const work = workStateOf(read.aggregate);
    const run = work.runs.find((item) => item.workRunId === ctx.workRunId);
    if (run === undefined || !this.effectiveRun(run)) {
      return { ok: false, code: 'binding-expired', message: 'WorkRun 不存在或已失效（结束／取消／宿主重启）；不接受新写入' };
    }
    if (ctx.bindingVersion !== run.bindingVersion) {
      return {
        ok: false,
        code: 'binding-expired',
        message: `捕获绑定版本 ${ctx.bindingVersion} 已过期（当前 ${run.bindingVersion}）；迟到／并行旧调用不接受新权限`,
      };
    }
    const action = commandAction(envelope.command);
    if (!run.allowedActions.includes(action)) {
      return { ok: false, code: 'forbidden', message: `动作 ${action} 不在工作范围内（允许：${run.allowedActions.join(', ')}）` };
    }
    if (action === 'add') {
      const rootAdds = (envelope.command.type === 'add-nodes' ? envelope.command.nodes : []).filter((node) => node.parentId === null);
      if (rootAdds.length > 0) {
        return { ok: false, code: 'forbidden', message: '新增根级节点不在节点目标集合内；工具不获得根级新增资格' };
      }
    }
    const targets = commandTargets(envelope.command);
    const outside = targets.filter((id) => !run.targets.includes(id));
    if (outside.length > 0) {
      return { ok: false, code: 'forbidden', message: `目标超出工作范围：${outside.join(', ')}` };
    }
    if (
      envelope.expectedPlanVersion !== run.acceptedBaseline.planVersion
      || envelope.expectedPlanRevision !== run.acceptedBaseline.planRevision
      || envelope.sourceEpoch !== run.acceptedBaseline.sourceEpoch
    ) {
      return {
        ok: false,
        code: 'binding-expired',
        message: '命令基线与绑定已接受基线不一致；外部变化或版本推进后需重新取得绑定，不沿用旧授权',
      };
    }
    return { ok: true };
  }

  /**
   * 本运行规划命令成功后推进绑定版本（仅更新已接受基线；范围与动作不自动扩大）。
   * 必须在实例队列任务内调用（commit 已在队列内）；核对失败不 bump，不抛异常。
   */
  async afterPlanCommit(
    ctx: { kind: 'agent-work'; workRunId: string; bindingVersion: number },
    result: { planVersion: string; planRevision: number; sourceEpoch: number },
  ): Promise<void> {
    const read = await this.readAggregate();
    if ('outcome' in read) return;
    const { aggregate } = read;
    const work = workStateOf(aggregate);
    const run = work.runs.find((item) => item.workRunId === ctx.workRunId);
    if (run === undefined || !this.effectiveRun(run) || ctx.bindingVersion !== run.bindingVersion) return;
    const runs = work.runs.map((item) =>
      item.workRunId === run.workRunId
        ? {
            ...item,
            bindingVersion: item.bindingVersion + 1,
            acceptedBaseline: { planVersion: result.planVersion, planRevision: result.planRevision, sourceEpoch: result.sourceEpoch },
          }
        : item,
    );
    await this.persistUnchecked(aggregate, (next) => ({ ...next, workRuns: runs }));
  }

  // ---------- 结束与停止 ----------

  /** 显式停止：立即停止新写准入；已进入发布的操作按提交恢复协议核对。 */
  async stopWork(workRunId: string): Promise<WorkOutcome<{ stopped: boolean }>> {
    return this.deps.queue.run(this.deps.instanceId, async () => {
      const read = await this.readAggregate();
      if ('outcome' in read) return read.outcome;
      const { aggregate } = read;
      const work = workStateOf(aggregate);
      const run = work.runs.find((item) => item.workRunId === workRunId);
      if (run === undefined || !this.effectiveRun(run)) {
        return { status: 'committed' as const, value: { stopped: false }, stateRevision: aggregate.revisions.state };
      }
      const now = this.deps.clock();
      const runs = work.runs.map((item) =>
        item.workRunId === workRunId
          ? { ...item, status: 'stopped' as const, endedAt: now, endKind: 'stopped' as const }
          : item,
      );
      const intents = work.intents.map((item) =>
        item.workIntentId === run.workIntentId && item.status === 'active'
          ? { ...item, status: 'stopped' as const, updatedAt: now }
          : item,
      );
      const outcome = await this.persist(aggregate, (next) => ({ ...next, workRuns: runs, workIntents: intents }));
      if (outcome.status !== 'committed') return outcome;
      return { status: 'committed' as const, value: { stopped: true }, stateRevision: outcome.stateRevision };
    });
  }

  /**
   * 真实终态观测（2.4：turn/end completed／aborted；预告 stopping 不作数）。
   * aborted 的意图标 stopped（可重新接续），completed 标 completed。
   */
  async observeTurnEnd(event: TurnEndEvent): Promise<AdmissionResult> {
    if (!validMessageEvent({ sessionId: event.sessionId, rpcId: 'x' })) {
      return { status: 'rejected', code: 'operation-mismatch', message: '终态事件缺少 sessionId' };
    }
    if (!Number.isSafeInteger(event.turn) || (event.turn as number) < 0) {
      return { status: 'rejected', code: 'operation-mismatch', message: '终态事件缺少有效 turn' };
    }
    return this.deps.queue.run(this.deps.instanceId, async () => {
      const read = await this.readAggregate();
      if ('outcome' in read) return read.outcome;
      const { aggregate } = read;
      const work = workStateOf(aggregate);
      const run = work.runs.find(
        (item) => item.sessionId === event.sessionId && item.turn === event.turn && this.effectiveRun(item),
      );
      if (run === undefined) return { status: 'unmatched' };
      const now = this.deps.clock();
      const runs = work.runs.map((item) =>
        item.workRunId === run.workRunId
          ? { ...item, status: 'ended' as const, endedAt: now, endKind: event.kind }
          : item,
      );
      const intents = work.intents.map((item) =>
        item.workIntentId === run.workIntentId && item.status === 'active'
          ? { ...item, status: event.kind === 'completed' ? ('completed' as const) : ('stopped' as const), updatedAt: now }
          : item,
      );
      const outcome = await this.persist(aggregate, (next) => ({ ...next, workRuns: runs, workIntents: intents }));
      if (outcome.status !== 'committed') return outcome;
      return { status: 'ended' as const, workRunId: run.workRunId, kind: event.kind, stateRevision: outcome.stateRevision };
    });
  }

  /** 只读列表：标注每个运行的生效性（重启后旧代际不再有写资格）。 */
  async listWork(): Promise<WorkOutcome<WorkListView>> {
    return this.deps.queue.run(this.deps.instanceId, async () => {
      const read = await this.readAggregate();
      if ('outcome' in read) return read.outcome;
      const { aggregate } = read;
      const work = workStateOf(aggregate);
      const activeRunIds = new Set(work.runs.filter((run) => this.effectiveRun(run)).map((run) => run.workRunId));
      return {
        status: 'committed' as const,
        value: {
          intents: work.intents.map((intent) => ({ ...intent, runActive: intent.status === 'active' && activeRunIds.size > 0 && work.runs.some((run) => run.workIntentId === intent.workIntentId && this.effectiveRun(run)) })),
          runs: work.runs.map((run) => ({ ...run, effective: this.effectiveRun(run) })),
          stateRevision: aggregate.revisions.state,
        },
        stateRevision: aggregate.revisions.state,
      };
    });
  }

  // ---------- 内部 ----------

  /** 生效运行：状态 active 且属于当前宿主代际（重启即失效，不从历史恢复写资格）。 */
  private effectiveRun(run: WorkRunRecord): boolean {
    return run.status === 'active' && run.bootGeneration === this.deps.bootGeneration;
  }

  private validatePrepareRequest(request: PrepareWorkRequest): WorkRejection | null {
    if (typeof request.workIntentId !== 'string' || request.workIntentId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少 workIntentId' };
    }
    if (!Array.isArray(request.nodeIds) || request.nodeIds.length === 0 || !request.nodeIds.every((id) => typeof id === 'string' && id !== '')) {
      return { status: 'rejected', code: 'operation-mismatch', message: 'nodeIds 必须是非空字符串数组' };
    }
    if (!Array.isArray(request.allowedActions) || request.allowedActions.length === 0
      || !request.allowedActions.every((action) => WORK_ACTIONS.includes(action))) {
      return { status: 'rejected', code: 'operation-mismatch', message: `allowedActions 必须是 ${WORK_ACTIONS.join('/')} 的非空子集` };
    }
    if (request.reasonScope !== 'public' && request.reasonScope !== 'local') {
      return { status: 'rejected', code: 'operation-mismatch', message: "reasonScope 必须是 'public' 或 'local'" };
    }
    if (typeof request.purpose !== 'string' || request.purpose === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少 purpose' };
    }
    const baseline = request.baseline;
    if (
      baseline === null || typeof baseline !== 'object'
      || typeof baseline.planVersion !== 'string' || baseline.planVersion === ''
      || !Number.isSafeInteger(baseline.planRevision) || baseline.planRevision < 0
      || !Number.isSafeInteger(baseline.sourceEpoch) || baseline.sourceEpoch < 1
    ) {
      return { status: 'rejected', code: 'operation-mismatch', message: 'baseline 缺失或形状不合法' };
    }
    return null;
  }

  private async readAggregate(): Promise<
    { aggregate: InstanceAggregate } | { outcome: WorkRejection }
  > {
    const quarantined = await this.deps.store.readQuarantine(this.deps.localRoot, this.deps.instanceId);
    if (quarantined !== null) {
      return {
        outcome: {
          status: 'rejected',
          code: 'unknown-state',
          message: `该实例已隔离（${quarantined.reason}，阶段 ${quarantined.stage}）；工作意图与绑定读写停止`,
        },
      };
    }
    const aggregate = await this.deps.store.readAggregate(this.deps.localRoot, this.deps.instanceId);
    if (aggregate === null) {
      return { outcome: { status: 'rejected', code: 'binding-expired', message: '本机注册表中没有该实例' } };
    }
    return { aggregate };
  }

  private async persist(
    aggregate: InstanceAggregate,
    update: (aggregate: InstanceAggregate) => InstanceAggregate,
  ): Promise<
    { status: 'committed'; stateRevision: number }
    | { status: 'rejected'; code: string; message: string }
    | { status: 'unknown-state'; code: string; message: string; stage: string }
  > {
    return this.persistUnchecked(aggregate, (next) => ({
      ...update(next),
      revisions: { ...next.revisions, state: next.revisions.state + 1 },
    }));
  }

  /** 不推进修订的落盘（afterPlanCommit 在队列任务内调用；绑定版本本身就是计数）。 */
  private async persistUnchecked(
    aggregate: InstanceAggregate,
    update: (aggregate: InstanceAggregate) => InstanceAggregate,
  ): Promise<
    { status: 'committed'; stateRevision: number }
    | { status: 'rejected'; code: string; message: string }
    | { status: 'unknown-state'; code: string; message: string; stage: string }
  > {
    const next = update(aggregate);
    const result = await this.deps.store.replaceAggregateChecked(this.deps.localRoot, next);
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
    await this.deps.store.quarantine(this.deps.localRoot, {
      schemaVersion: 1,
      instanceId: aggregate.instanceId,
      reason: 'unknown-state',
      stage: `work:${result.stage}`,
      createdAt: this.deps.clock(),
      detail: result.detail,
      requires: 'offline-review',
    });
    return {
      status: 'unknown-state' as const,
      code: 'unknown-state',
      message: `本机聚合写入结果未知（阶段 ${result.stage}）；实例已隔离，只读诊断可用`,
      stage: result.stage,
    };
  }
}

function sameIntent(intent: WorkIntent, request: PrepareWorkRequest): boolean {
  const sameIds = intent.nodeIds.length === new Set(request.nodeIds).size
    && request.nodeIds.every((id) => intent.nodeIds.includes(id));
  const sameActions = intent.allowedActions.length === request.allowedActions.length
    && request.allowedActions.every((action) => intent.allowedActions.includes(action));
  return sameIds
    && sameActions
    && intent.reasonScope === request.reasonScope
    && intent.purpose === request.purpose
    && intent.baseline.planVersion === request.baseline.planVersion
    && intent.baseline.planRevision === request.baseline.planRevision
    && intent.baseline.sourceEpoch === request.baseline.sourceEpoch;
}

function validMessageEvent(event: { sessionId?: unknown; rpcId?: unknown }): boolean {
  return typeof event.sessionId === 'string' && event.sessionId !== '' && typeof event.rpcId === 'string' && event.rpcId !== '';
}
