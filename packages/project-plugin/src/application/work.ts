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
  type WorkContinuation,
  type WorkIntent,
  type WorkRunRecord,
  type WorkSuggestion,
  type WorkTemplateAuthorization,
} from './local-state.js';
import type { LocalStateStorePort, PlanNodeViewPort } from './ports.js';

export type {
  WorkAction,
  WorkBaseline,
  WorkContinuation,
  WorkIntent,
  WorkRunRecord,
  WorkSuggestion,
  WorkTemplateAuthorization,
};
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
  | { status: 'cancelling'; workRunId: string; stateRevision: number }
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
      reason: 'ambiguous-intent' | 'agent-missing' | 'session-mismatch' | 'lifecycle-unattributable';
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
  /** 根组重排许可（tasks 3.3）：单独授予，缺省不授予。 */
  rootGroupAllowed?: boolean;
  /** 插入模板精确授权（tasks 3.3）：缺省空＝不授权任何模板。 */
  templates?: WorkTemplateAuthorization[];
}

export interface StartWorkRequest {
  workIntentId: string;
  /** 期望消息的 rpcId（宿主消息 source.rpcId）。面板路径不预知 rpcId 时可省略，
   *  改为按 sessionId 匹配该会话的下一条用户消息。 */
  rpcId?: string;
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

// ---------- 有来源运行上下文（tasks 6.4） ----------

export type ContextItemKind = 'decision' | 'suggestion' | 'unverified';

/** 上下文条目：每条带来源；建议与未核查项是背景信息，不构成任何写授权。 */
export interface ContextItem {
  kind: ContextItemKind;
  /** 来源说明（intent:<id>／continuation:<version>／run:<id>#suggestion 等）。 */
  source: string;
  text: string;
  /** 关联节点（建议／未核查项）。 */
  nodeIds?: string[];
  /** 建议条目 id（kind==='suggestion'）。 */
  suggestionId?: string;
}

/**
 * 有来源运行上下文（spec：按实际绑定提供目标、约束、规划基线、相关公开记录和本机聊天入口，
 * 区分用户决定、Agent 建议与未核查项）。仅供提示注入；授权判断始终走程序化准入，
 * 提示文本不参与授权（design §7）。
 */
export interface WorkContext {
  workRunId: string;
  bindingVersion: number;
  sessionId: string;
  turn: number;
  /** 目标节点摘要；known=false 表示节点不在当前资料中（外部重载后待核对）。 */
  targets: Array<{ id: string; title?: string; status?: string; known: boolean }>;
  constraints: { allowedActions: WorkAction[]; reasonScope: 'public' | 'local' };
  baseline: WorkBaseline;
  /** 相关公开记录（subjectNodeIds 与目标相交的资料头记录索引）。 */
  publicRecords: Array<{ id: string; kind: string; summary: string; path: string; subjectNodeIds: string[] }>;
  /** 与目标相交的本机聊天入口（链接只表达背景关系，不构成写授权）。 */
  chatEntries: Array<{ linkId: string; sessionId: string; purpose: string; origin: string }>;
  items: ContextItem[];
  generatedAt: string;
}

// ---------- 工作预览（tasks 3.2）：确认范围前核对上下文，不建立任何绑定 ----------

/** 预览请求：与 prepareWork 同范围，但只读、不落盘、不登记意图。 */
export interface WorkPreviewRequest {
  /** 已由宿主核对过的真实会话（可见且属本实例）；预览不因此获得任何写授权。 */
  sessionId: string;
  nodeIds: string[];
  allowedActions: WorkAction[];
  reasonScope: 'public' | 'local';
  purpose: string;
  /** 预览所依据的基线（客户端快照）；与当前资料不一致时以未核查项呈现。 */
  baseline: WorkBaseline;
}

/** 预览中的目标：条件与直接依赖都在这里，缺节点时 known=false（待核对）。 */
export interface WorkPreviewTarget {
  id: string;
  known: boolean;
  title?: string;
  status?: string;
  goal?: string;
  completionCriteria?: string[];
  /** 目标依赖的节点（出边）；unknown 目标只给 id。 */
  dependsOn: Array<{ id: string; known: boolean; title?: string }>;
  /** 依赖目标的节点（入边）。 */
  requiredBy: Array<{ id: string; known: boolean; title?: string }>;
}

/**
 * 工作预览（spec：从接续摘要选择会话、目标、意图与动作后核对上下文）。
 * 与运行上下文同源同口径：目标条件、约束、基线、公开记录、聊天入口与三类条目；
 * 额外标出同会话已关联但不在目标集合内的节点（只作背景，不进写范围）。
 */
export interface WorkPreview {
  sessionId: string;
  targets: WorkPreviewTarget[];
  constraints: { allowedActions: WorkAction[]; reasonScope: 'public' | 'local' };
  baseline: WorkBaseline;
  /** 预览时读到的源代际；null 表示注册表不可读（不冒充一致）。 */
  sourceEpoch: number | null;
  publicRecords: Array<{ id: string; kind: string; summary: string; path: string; subjectNodeIds: string[] }>;
  chatEntries: Array<{ linkId: string; sessionId: string; purpose: string; origin: string }>;
  /** 同会话已关联但不在本次目标集合内的节点：只作适用背景。 */
  backgroundNodeIds: string[];
  items: ContextItem[];
  generatedAt: string;
}

/** 显式接续请求：把新目标纳入活动运行的范围（版本 +1 并保留接续原因）。 */export interface ContinueScopeRequest {
  workRunId: string;
  /** 发起方：panel 走 owner 入口；agent 必须与运行归属会话一致。 */
  origin: 'panel' | 'agent';
  /** agent 发起时必须提供归属会话 id。 */
  sessionId?: string;
  addedTargets: string[];
  /** 接续原因（必填；spec 要求保留接续原因）。 */
  reason: string;
}

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
    // 结构命令（tasks 3.3）：move／insert 需显式动作授权；其余结构编辑仍为 owner-only。
    case 'move-node':
      return 'move';
    case 'insert-preset':
    case 'insert-user-template':
      return 'insert';
    case 'group-nodes':
    case 'merge-nodes':
    case 'copy-subtree':
      return 'update';
    // 撤销/重做是 owner-only（命令服务入口拒绝 agent 直达）；保守映射，实际不走工作绑定。
    case 'undo-plan-edit':
    case 'redo-plan-edit':
      return 'update';
    // 模板保存是 owner-only 的记录发布；保守映射，不走工作绑定。
    case 'save-user-template':
      return 'record';
  }
}

/** 规划轮廓（tasks 3.3）：结构命令影响范围要用当前父子与顺序解析，不能只看命令字面量。 */
export interface PlanOutlineNode {
  id: string;
  parentId: string | null;
  order: number;
}

export interface PlanOutline {
  nodes: PlanOutlineNode[];
}

/** 结构命令的影响范围：子树、源／目的父组、锚点以及因归一化而变序的同级节点。 */
export interface StructuralImpact {
  kind: 'move' | 'insert';
  /** 必须全部落在运行目标集合内的既有节点。 */
  targets: string[];
  /** 移动子树（含自身）；插入为空。 */
  subtree: string[];
  sourceParentId: string | null;
  destParentId: string | null;
  anchorId: string | null;
  /** 触及根组：源或目的父组为根（null）时为真。 */
  touchesRootGroup: boolean;
}

function childrenOf(outline: PlanOutline, parentId: string | null): PlanOutlineNode[] {
  return outline.nodes
    .filter((node) => node.parentId === parentId)
    .sort((a, b) => (a.order === b.order ? a.id.localeCompare(b.id) : a.order - b.order));
}

/**
 * 计算 move／insert 的影响范围（当前计划轮廓）。非结构命令或轮廓缺节点时返回 null，
 * 由调用方退回保守投影或让领域变换给出 node-not-found。
 */
export function structuralImpact(command: Command, outline: PlanOutline): StructuralImpact | null {
  if (command.type === 'move-node') {
    const node = outline.nodes.find((item) => item.id === command.nodeId);
    if (node === undefined) return null;
    const subtree: string[] = [];
    const queue = [node.id];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      subtree.push(current);
      for (const child of outline.nodes) {
        if (child.parentId === current) queue.push(child.id);
      }
    }
    const subtreeSet = new Set(subtree);
    const sourceParent = node.parentId;
    const destParent = command.parentId;
    const anchor = command.beforeNodeId === null ? undefined : outline.nodes.find((item) => item.id === command.beforeNodeId);
    // 源组：移除后 order 大于原位置的同级节点会前移。
    const sourceShifts = childrenOf(outline, sourceParent)
      .filter((item) => !subtreeSet.has(item.id) && item.order > node.order)
      .map((item) => item.id);
    // 目的组：插入点及其后的同级节点会后退；锚点本身也在影响内。
    const destSiblings = childrenOf(outline, destParent).filter((item) => !subtreeSet.has(item.id));
    const insertIndex = anchor === undefined ? destSiblings.length : destSiblings.findIndex((item) => item.id === anchor.id);
    const destShifts = insertIndex < 0
      ? []
      : destSiblings.slice(insertIndex).map((item) => item.id);
    const targets = [...new Set([
      ...subtree,
      ...(sourceParent === null ? [] : [sourceParent]),
      ...(destParent === null ? [] : [destParent]),
      ...(command.beforeNodeId === null ? [] : [command.beforeNodeId]),
      ...sourceShifts,
      ...destShifts,
    ])];
    return {
      kind: 'move',
      targets,
      subtree,
      sourceParentId: sourceParent,
      destParentId: destParent,
      anchorId: command.beforeNodeId,
      touchesRootGroup: sourceParent === null || destParent === null,
    };
  }
  if (command.type === 'insert-preset' || command.type === 'insert-user-template') {
    const destParent = command.parentId;
    if (destParent === null) {
      // 根级插入在任何许可下都不允许；由调用方先返回 parent-not-found。
      return {
        kind: 'insert',
        targets: command.beforeNodeId === null ? [] : [command.beforeNodeId],
        subtree: [],
        sourceParentId: null,
        destParentId: null,
        anchorId: command.beforeNodeId,
        touchesRootGroup: false,
      };
    }
    const siblings = childrenOf(outline, destParent);
    const anchor = command.beforeNodeId === null ? undefined : siblings.find((item) => item.id === command.beforeNodeId);
    const insertIndex = anchor === undefined ? siblings.length : siblings.findIndex((item) => item.id === anchor.id);
    const shifts = insertIndex < 0 ? [] : siblings.slice(insertIndex).map((item) => item.id);
    return {
      kind: 'insert',
      targets: [...new Set([destParent, ...(command.beforeNodeId === null ? [] : [command.beforeNodeId]), ...shifts])],
      subtree: [],
      sourceParentId: null,
      destParentId: destParent,
      anchorId: command.beforeNodeId,
      touchesRootGroup: false,
    };
  }
  return null;
}

/**
 * 命令的目标节点集合：所有被写到的规划节点。add-nodes 以父节点为目标；
 * 父为 null（新增根级节点）不在任何节点目标集合内，准入层直接拒绝。
 */
export function commandTargets(command: Command, outline?: PlanOutline): string[] {
  // 结构命令（tasks 3.3）：给了当前计划轮廓就按真实影响范围解析（子树／同级变序），
  // 否则退回保守投影（旧调用方与只说“两个端点”的提示保持原样）。
  if (outline !== undefined) {
    const impact = structuralImpact(command, outline);
    if (impact !== null) return impact.targets;
  }
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
    case 'move-node':
      return [command.nodeId, ...(command.parentId === null ? [] : [command.parentId])];
    case 'group-nodes':
      return [...new Set(command.nodeIds)];
    case 'merge-nodes':
      return [...new Set([command.keepNodeId, ...command.sourceNodeIds])];
    case 'copy-subtree':
      return command.targetParentId === null ? [] : [command.targetParentId];
    case 'insert-preset':
      return command.parentId === null ? [] : [command.parentId];
    // 目标由命令服务从私有历史的 inverse.affectedNodeIds 解析；此处静态映射返回空。
    case 'undo-plan-edit':
    case 'redo-plan-edit':
      return [];
    // 模板正文不针对具体节点（subjectNodeIds 为空），目标为空。
    case 'save-user-template':
      return [command.rootNodeId];
    case 'insert-user-template':
      return command.parentId === null ? [] : [command.parentId];
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
  /** 建议条目 id（tasks 6.4）：绑定外变更保留为建议时生成。 */
  newSuggestionId: () => string;
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
        ...(request.rootGroupAllowed === undefined ? {} : { rootGroupAllowed: request.rootGroupAllowed }),
        ...(request.templates === undefined ? {} : { templates: request.templates.map((item) => ({ ...item })) }),
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
    if (request.rpcId !== undefined && (typeof request.rpcId !== 'string' || request.rpcId === '')) {
      return { status: 'rejected', code: 'operation-mismatch', message: '期望消息 rpcId 不能为空字符串' };
    }
    if (request.sessionId !== undefined && (typeof request.sessionId !== 'string' || request.sessionId === '')) {
      return { status: 'rejected', code: 'operation-mismatch', message: 'sessionId 为空' };
    }
    // 面板路径不预知宿主消息 rpcId：允许只确认「在本会话发送的下一条消息生效」，
    // 但必须至少有一个可匹配的身份，不接受“等任意消息”的空白确认。
    if (request.rpcId === undefined && request.sessionId === undefined) {
      return { status: 'rejected', code: 'operation-mismatch', message: '必须提供期望消息 rpcId 或已核对的会话 id' };
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
              // rpcId 缺省＝按会话匹配下一条用户消息（面板路径）；显式给出时按消息身份匹配。
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
        intent.status === 'awaiting-message' && (
          intent.expectedRpcId !== undefined
            ? intent.expectedRpcId === event.rpcId
            : intent.sessionId === event.sessionId
        )
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
      const candidates = work.intents.filter((intent) => {
        if (intent.status !== 'awaiting-message') return false;
        // 显式 rpcId：按消息身份匹配（可再限定会话）；面板确认（无 rpcId）：只按会话匹配下一条消息。
        if (intent.expectedRpcId !== undefined) {
          return intent.expectedRpcId === event.rpcId
            && (intent.sessionId === undefined || intent.sessionId === event.sessionId);
        }
        return intent.sessionId === event.sessionId;
      });
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
        ...(intent.rootGroupAllowed === undefined ? {} : { rootGroupAllowed: intent.rootGroupAllowed }),
        ...(intent.templates === undefined ? {} : { templates: intent.templates.map((item) => ({ ...item })) }),
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
    const registered = await this.ensureRegistered();
    if (registered !== null) {
      return { ok: false, code: 'binding-expired', message: registered };
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
    const registered = await this.ensureRegistered();
    if (registered !== null) {
      return { ok: false, code: 'binding-expired', message: registered };
    }
    const read = await this.readAggregate();
    if ('outcome' in read) return { ok: false, code: read.outcome.status === 'rejected' ? read.outcome.code : 'unknown-state', message: read.outcome.message };
    const work = workStateOf(read.aggregate);
    const run = work.runs.find((item) => item.workRunId === ctx.workRunId);
    if (run === undefined || !this.effectiveRun(run)) {
      return { ok: false, code: 'binding-expired', message: 'WorkRun 不存在或已失效（结束／取消／宿主重启）；不接受新写入' };
    }
    if (run.admissionStoppedAt !== undefined) {
      return {
        ok: false,
        code: 'binding-expired',
        message: `已收到取消请求（${run.admissionStoppedAt}）；新写准入已停止，等待真实终态确认`,
      };
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
      const message = `动作 ${action} 不在工作范围内（允许：${run.allowedActions.join(', ')}）`;
      await this.noteSuggestion(run, action, commandTargets(envelope.command), message);
      return { ok: false, code: 'forbidden', message };
    }
    if (action === 'add') {
      const rootAdds = (envelope.command.type === 'add-nodes' ? envelope.command.nodes : []).filter((node) => node.parentId === null);
      if (rootAdds.length > 0) {
        const message = '新增根级节点不在节点目标集合内；工具不获得根级新增资格';
        await this.noteSuggestion(run, action, [], message);
        return { ok: false, code: 'forbidden', message };
      }
    }

    // 结构命令（tasks 3.3）：插入先拒绝根级父节点并核对精确模板授权，再用当前轮廓算影响范围。
    const command = envelope.command;
    if (command.type === 'insert-preset' || command.type === 'insert-user-template') {
      if (command.parentId === null) {
        return {
          ok: false,
          code: 'parent-not-found',
          message: '插入必须以现有节点为父节点；即使持有插入与根组许可，根级插入也不允许',
        };
      }
      if (!templateAuthorized(run, command)) {
        const message = command.type === 'insert-preset'
          ? `未授权内置模板 ${command.templateId} v${command.templateVersion}；绑定只授权显式确认的模板与版本`
          : `未授权用户模板 ${command.templateId}（记录 ${command.versionRecordId}）；绑定只授权显式确认的版本与正文哈希`;
        return { ok: false, code: 'template-not-authorized', message };
      }
    }
    let outline: PlanOutline | undefined;
    if (command.type === 'move-node' || command.type === 'insert-preset' || command.type === 'insert-user-template') {
      const readOutline = this.deps.planNodes.planOutline;
      if (readOutline === undefined) {
        return {
          ok: false,
          code: 'structure-scope-unavailable',
          message: '宿主未提供规划轮廓；结构命令的影响范围不可判定，拒绝写入',
        };
      }
      const outlineResult = await readOutline.call(this.deps.planNodes);
      if (!outlineResult.ok) {
        return { ok: false, code: 'structure-scope-unavailable', message: outlineResult.message };
      }
      outline = { nodes: outlineResult.nodes.map((node) => ({ ...node })) };
    }
    if (command.type === 'move-node' && outline !== undefined) {
      const impact = structuralImpact(command, outline);
      if (impact === null) {
        return { ok: false, code: 'node-not-found', message: `移动源节点 ${command.nodeId} 不在当前资料中` };
      }
      if (impact.touchesRootGroup && run.rootGroupAllowed !== true) {
        const message = '根组重排需要单独授予的根组许可；本次绑定未授予';
        await this.noteSuggestion(run, action, impact.targets, message);
        return { ok: false, code: 'root-group-not-allowed', message };
      }
    }
    const targets = commandTargets(command, outline);
    const outside = targets.filter((id) => !run.targets.includes(id));
    if (outside.length > 0) {
      const message = `目标超出工作范围：${outside.join(', ')}`;
      await this.noteSuggestion(run, action, targets, message);
      return {
        ok: false,
        code: command.type === 'move-node' || command.type === 'insert-preset' || command.type === 'insert-user-template'
          ? 'structure-scope-denied'
          : 'forbidden',
        message,
      };
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

  // ---------- 有来源上下文与显式接续（tasks 6.4） ----------

  /**
   * 有来源运行上下文：按捕获绑定生成，刷新在可信执行边界生效（捕获版本过期即拒绝，
   * 不读一个可变的全局上下文）。只读，不改目标：新材料到达标记待核对，不静默改写。
   */
  async buildContext(capture: WorkCapture): Promise<WorkOutcome<WorkContext>> {
    return this.deps.queue.run(this.deps.instanceId, async () => {
      const read = await this.readAggregate();
      if ('outcome' in read) return read.outcome;
      const work = workStateOf(read.aggregate);
      const run = work.runs.find((item) => item.workRunId === capture.workRunId);
      if (run === undefined || !this.effectiveRun(run) || run.sessionId !== capture.sessionId) {
        return { status: 'rejected' as const, code: 'binding-expired', message: 'WorkRun 不存在或已失效；重新捕获绑定' };
      }
      if (capture.bindingVersion !== run.bindingVersion) {
        return {
          status: 'rejected' as const,
          code: 'binding-expired',
          message: `捕获绑定版本 ${capture.bindingVersion} 已过期（当前 ${run.bindingVersion}）；重新捕获，不借新上下文`,
        };
      }
      return {
        status: 'committed' as const,
        value: await this.contextForRun(run, work, read.aggregate),
        stateRevision: read.aggregate.revisions.state,
      };
    });
  }

  /** owner 入口按运行读上下文：核对运行有效后共用 contextForRun（不要求捕获版本）。 */
  async contextForRunRemote(workRunId: string): Promise<WorkOutcome<WorkContext>> {
    return this.deps.queue.run(this.deps.instanceId, async () => {
      const read = await this.readAggregate();
      if ('outcome' in read) return read.outcome;
      const work = workStateOf(read.aggregate);
      const run = work.runs.find((item) => item.workRunId === workRunId);
      if (run === undefined) {
        return { status: 'rejected' as const, code: 'not-found', message: '没有该 WorkRun' };
      }
      return {
        status: 'committed' as const,
        value: await this.contextForRun(run, work, read.aggregate),
        stateRevision: read.aggregate.revisions.state,
      };
    });
  }

  /**
   * 工作预览（tasks 3.2）：只读核对确认前的上下文，不登记意图、不建立绑定、不推进修订。
   * 与运行上下文同源：目标条件、直接依赖、约束、基线、相关公开记录、聊天入口与三类条目；
   * 同会话已关联但不在目标集合内的节点只列背景，不进写范围。
   */
  async previewWork(request: WorkPreviewRequest): Promise<WorkOutcome<WorkPreview>> {
    const invalid = this.validateScope(request, false);
    if (invalid !== null) return invalid;
    if (typeof request.sessionId !== 'string' || request.sessionId === '') {
      return { status: 'rejected', code: 'session-identity-missing', message: '缺少已核对的本机会话 id' };
    }
    const nodes = await this.deps.planNodes.currentNodeIds();
    if (!nodes.ok) return { status: 'rejected', code: nodes.code, message: nodes.message };
    const missing = request.nodeIds.filter((id) => !nodes.nodeIds.has(id));
    if (missing.length > 0) {
      return { status: 'rejected', code: 'unknown-node', message: `节点不存在于当前资料：${missing.join(', ')}` };
    }
    return this.deps.queue.run(this.deps.instanceId, async () => {
      const read = await this.readAggregate();
      if ('outcome' in read) return read.outcome;
      const { aggregate } = read;
      const targets = [...new Set(request.nodeIds)];

      // 目标条件与依赖：planTargets 缺失时退化为仅标题与状态（不因此拒绝）。
      const detailsById = new Map<string, { title?: string; status?: string; goal?: string; completionCriteria?: string[] }>();
      let edges: Array<{ nodeId: string; requiresNodeId: string }> = [];
      const planTargets = this.deps.planNodes.planTargets;
      if (planTargets !== undefined) {
        try {
          const rich = await planTargets.call(this.deps.planNodes, targets);
          if (rich.ok) {
            edges = [...rich.dependencies];
            for (const node of rich.nodes) {
              detailsById.set(node.id, {
                title: node.title,
                status: node.status,
                ...(node.goal === undefined ? {} : { goal: node.goal }),
                ...(node.completionCriteria === undefined ? {} : { completionCriteria: [...node.completionCriteria] }),
              });
            }
          }
        } catch {
          // 详情不可用：预览退化，不失败。
        }
      }
      if (detailsById.size === 0) {
        const nodeDetails = this.deps.planNodes.nodeDetails;
        if (nodeDetails !== undefined) {
          try {
            const basic = await nodeDetails.call(this.deps.planNodes, targets);
            if (basic.ok) {
              for (const node of basic.nodes) {
                detailsById.set(node.id, { title: node.title, status: node.status });
              }
            }
          } catch {
            // 同上。
          }
        }
      }

      // 依赖端点标题：只为已知节点解析，不扩大目标集合。
      const endpointIds = [...new Set(edges
        .filter((edge) => targets.includes(edge.nodeId) || targets.includes(edge.requiresNodeId))
        .flatMap((edge) => [edge.nodeId, edge.requiresNodeId])
        .filter((id) => !targets.includes(id)))];
      if (endpointIds.length > 0 && this.deps.planNodes.planTargets !== undefined) {
        try {
          const extra = await this.deps.planNodes.planTargets.call(this.deps.planNodes, endpointIds);
          if (extra.ok) {
            for (const node of extra.nodes) {
              detailsById.set(node.id, { title: node.title, status: node.status });
            }
          }
        } catch {
          // 端点标题缺失时只显示 id。
        }
      }
      const endpointView = (id: string): { id: string; known: boolean; title?: string } => {
        const detail = detailsById.get(id);
        return detail?.title === undefined ? { id, known: nodes.nodeIds.has(id) } : { id, known: true, title: detail.title };
      };
      const previewTargets: WorkPreviewTarget[] = targets.map((id) => {
        const detail = detailsById.get(id);
        const known = nodes.nodeIds.has(id);
        return {
          id,
          known,
          ...(detail?.title === undefined ? {} : { title: detail.title }),
          ...(detail?.status === undefined ? {} : { status: detail.status }),
          ...(detail?.goal === undefined ? {} : { goal: detail.goal }),
          ...(detail?.completionCriteria === undefined ? {} : { completionCriteria: [...detail.completionCriteria] }),
          dependsOn: edges.filter((edge) => edge.nodeId === id && !targets.includes(edge.requiresNodeId)).map((edge) => endpointView(edge.requiresNodeId)),
          requiredBy: edges.filter((edge) => edge.requiresNodeId === id && !targets.includes(edge.nodeId)).map((edge) => endpointView(edge.nodeId)),
        };
      });
      const targetSet = new Set(targets);

      // 公开记录：与目标相交的索引条目（成果／验证／决定都可在此核对）。
      let records: WorkPreview['publicRecords'] = [];
      const nodeDetails = this.deps.planNodes.nodeDetails;
      if (nodeDetails !== undefined) {
        try {
          const result = await nodeDetails.call(this.deps.planNodes, targets);
          if (result.ok) {
            records = result.records
              .filter((record) => record.subjectNodeIds.some((id) => targetSet.has(id)))
              .map((record) => ({
                id: record.id,
                kind: record.kind,
                summary: record.summary,
                path: record.path,
                subjectNodeIds: [...record.subjectNodeIds],
              }));
          }
        } catch {
          // 记录不可用：预览不注入猜测内容。
        }
      }

      const chatEntries = aggregate.conversations.links
        .filter((link) => link.nodeIds.some((id) => targetSet.has(id)))
        .map((link) => ({ linkId: link.linkId, sessionId: link.sessionId, purpose: link.purpose, origin: link.origin }));
      // 同会话已关联的其他节点：只作背景，不进入本次范围。
      const backgroundNodeIds = [...new Set(
        aggregate.conversations.links
          .filter((link) => link.sessionId === request.sessionId)
          .flatMap((link) => link.nodeIds)
          .filter((id) => !targetSet.has(id)),
      )];

      const items: ContextItem[] = [{
        kind: 'decision',
        source: 'preview:scope',
        text: `准备确认的工作目的：${request.purpose}；目标 ${targets.join(', ')}；允许动作 ${request.allowedActions.join(', ')}`,
        nodeIds: [...targets],
      }];
      const currentEpoch = await this.currentSourceEpoch(aggregate.instanceId);
      if (currentEpoch !== null && currentEpoch > request.baseline.sourceEpoch) {
        items.push({
          kind: 'unverified',
          source: `source-generation:${currentEpoch}`,
          text: `资料源代际已推进（${request.baseline.sourceEpoch}→${currentEpoch}）；预览基于旧资料，新内容待核对`,
        });
      }
      const knownPlanVersion = aggregate.lastObservation?.planVersion;
      if (knownPlanVersion !== undefined && knownPlanVersion !== null && knownPlanVersion !== request.baseline.planVersion) {
        items.push({
          kind: 'unverified',
          source: `plan-baseline:${knownPlanVersion}`,
          text: `预览基线与本机已知规划不一致（${request.baseline.planVersion}→${knownPlanVersion}）；提交前请先刷新`,
        });
      }
      const unknownTargets = previewTargets.filter((target) => !target.known).map((target) => target.id);
      if (unknownTargets.length > 0) {
        items.push({
          kind: 'unverified',
          source: `plan-nodes:${unknownTargets.join(',')}`,
          text: `目标节点不在当前资料中：${unknownTargets.join(', ')}；待核对，不静默改写`,
          nodeIds: unknownTargets,
        });
      }
      if (backgroundNodeIds.length > 0) {
        items.push({
          kind: 'suggestion',
          source: `chat-background:${request.sessionId}`,
          text: `同会话还关联了目标集合外的节点：${backgroundNodeIds.join(', ')}；只作背景，不在本次写范围`,
          nodeIds: backgroundNodeIds,
        });
      }
      return {
        status: 'committed' as const,
        value: {
          sessionId: request.sessionId,
          targets: previewTargets,
          constraints: { allowedActions: [...request.allowedActions], reasonScope: request.reasonScope },
          baseline: { ...request.baseline },
          sourceEpoch: currentEpoch,
          publicRecords: records,
          chatEntries,
          backgroundNodeIds,
          items,
          generatedAt: this.deps.clock(),
        },
        stateRevision: aggregate.revisions.state,
      };
    });
  }

  /**
   * 显式接续：把新目标纳入活动运行范围。版本 +1 并保留接续记录（谁、从哪到哪、纳入了什么、
   * 为什么）；目标只增不减；接续后旧捕获版本一律拒绝（旧并行调用不能借新权限）。
   * 匹配的开放建议随接续闭环（included）。
   */
  async continueScope(request: ContinueScopeRequest): Promise<WorkOutcome<{ workRunId: string; bindingVersion: number; addedTargets: string[]; includedSuggestions: number }>> {
    if (typeof request.workRunId !== 'string' || request.workRunId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少 workRunId' };
    }
    if (request.origin !== 'panel' && request.origin !== 'agent') {
      return { status: 'rejected', code: 'operation-mismatch', message: 'origin 必须是 panel 或 agent' };
    }
    if (
      !Array.isArray(request.addedTargets)
      || request.addedTargets.length === 0
      || !request.addedTargets.every((id) => typeof id === 'string' && id !== '')
    ) {
      return { status: 'rejected', code: 'operation-mismatch', message: 'addedTargets 必须是非空节点 id 数组' };
    }
    if (typeof request.reason !== 'string' || request.reason.trim() === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '接续必须给出原因（reason 非空）' };
    }
    if (request.origin === 'agent' && (typeof request.sessionId !== 'string' || request.sessionId === '')) {
      return { status: 'rejected', code: 'operation-mismatch', message: 'agent 发起接续必须提供归属会话 id' };
    }
    const nodes = await this.deps.planNodes.currentNodeIds();
    if (!nodes.ok) return { status: 'rejected', code: nodes.code, message: nodes.message };
    const missing = request.addedTargets.filter((id) => !nodes.nodeIds.has(id));
    if (missing.length > 0) {
      return { status: 'rejected', code: 'unknown-node', message: `接续目标不存在于当前资料：${missing.join(', ')}` };
    }
    return this.deps.queue.run(this.deps.instanceId, async () => {
      const read = await this.readAggregate();
      if ('outcome' in read) return read.outcome;
      const work = workStateOf(read.aggregate);
      const run = work.runs.find((item) => item.workRunId === request.workRunId);
      if (run === undefined || !this.effectiveRun(run)) {
        return { status: 'rejected' as const, code: 'binding-expired', message: 'WorkRun 不存在或已失效；不能接续' };
      }
      if (request.origin === 'agent' && request.sessionId !== run.sessionId) {
        return { status: 'rejected' as const, code: 'forbidden', message: '只有归属会话可接续自己的运行范围' };
      }
      const fresh = request.addedTargets.filter((id) => !run.targets.includes(id));
      if (fresh.length === 0) {
        return { status: 'rejected' as const, code: 'operation-mismatch', message: '接续目标已在范围内；不重复接续，不推进版本' };
      }
      const now = this.deps.clock();
      const continuation: WorkContinuation = {
        at: now,
        fromVersion: run.bindingVersion,
        toVersion: run.bindingVersion + 1,
        addedTargets: fresh,
        reason: request.reason.trim(),
        origin: request.origin,
      };
      const targets = [...run.targets, ...fresh];
      // 开放建议闭环：建议的全部节点都已进入范围即标记 included（建议→决定的路径）。
      let includedSuggestions = 0;
      const suggestions = work.suggestions.map((item) => {
        const resolvable =
          item.status === 'open'
          && item.workRunId === run.workRunId
          && item.nodeIds.length > 0
          && item.nodeIds.every((id) => targets.includes(id));
        if (!resolvable) return item;
        includedSuggestions += 1;
        return { ...item, status: 'included' as const, resolvedAt: now, resolvedHow: `continuation:${continuation.toVersion}` };
      });
      const runs = work.runs.map((item) =>
        item.workRunId === run.workRunId
          ? {
              ...item,
              bindingVersion: continuation.toVersion,
              targets,
              continuations: [...(item.continuations ?? []), continuation],
            }
          : item,
      );
      const persisted = await this.persistUnchecked(read.aggregate, (next) => ({
        ...next,
        workRuns: runs,
        workSuggestions: suggestions,
      }));
      if (persisted.status !== 'committed') return persisted;
      return {
        status: 'committed' as const,
        value: {
          workRunId: run.workRunId,
          bindingVersion: continuation.toVersion,
          addedTargets: fresh,
          includedSuggestions,
        },
        stateRevision: persisted.stateRevision,
      };
    });
  }

  /**
   * 绑定外变更保留为建议（best-effort）：同运行同动作同目标集合的开放建议只更新
   * lastSeenAt，不重复堆积。建议是背景信息，不改变拒绝结果，也不构成写授权。
   */
  private async noteSuggestion(run: WorkRunRecord, action: WorkAction, nodeIds: string[], reason: string): Promise<void> {
    try {
      await this.deps.queue.run(this.deps.instanceId, async () => {
        const read = await this.readAggregate();
        if ('outcome' in read) return;
        const work = workStateOf(read.aggregate);
        const now = this.deps.clock();
        const key = [...new Set(nodeIds)].sort().join(',');
        const existing = work.suggestions.find(
          (item) =>
            item.status === 'open'
            && item.workRunId === run.workRunId
            && item.action === action
            && [...new Set(item.nodeIds)].sort().join(',') === key,
        );
        const suggestions = existing !== undefined
          ? work.suggestions.map((item) => (item.suggestionId === existing.suggestionId ? { ...item, lastSeenAt: now } : item))
          : [
              ...work.suggestions,
              {
                suggestionId: this.deps.newSuggestionId(),
                workRunId: run.workRunId,
                sessionId: run.sessionId,
                action,
                nodeIds: [...new Set(nodeIds)],
                reason,
                status: 'open' as const,
                createdAt: now,
                lastSeenAt: now,
              } satisfies WorkSuggestion,
            ];
        await this.persistUnchecked(read.aggregate, (next) => ({ ...next, workSuggestions: suggestions }));
      });
    } catch {
      // 建议是 best-effort 背景；持久化失败不影响拒绝结果本身。
    }
  }

  /** 从运行当前状态组装上下文（owner Remote 与捕获路径共用；调用方已核对版本有效性）。 */
  private async contextForRun(
    run: WorkRunRecord,
    work: { intents: WorkIntent[]; runs: WorkRunRecord[]; suggestions: WorkSuggestion[] },
    aggregate: InstanceAggregate,
  ): Promise<WorkContext> {
    const intent = work.intents.find((item) => item.workIntentId === run.workIntentId);
    const items: ContextItem[] = [];
    // 用户决定：意图目的与确认范围（“开始工作”确认的具体范围）。
    if (intent !== undefined) {
      items.push({
        kind: 'decision',
        source: `intent:${intent.workIntentId}`,
        text: `用户确认的工作目的：${intent.purpose}；目标 ${intent.nodeIds.join(', ')}；允许动作 ${intent.allowedActions.join(', ')}`,
      });
    }
    // 接续也是决定：每次显式接续带原因进入上下文。
    for (const continuation of run.continuations ?? []) {
      items.push({
        kind: 'decision',
        source: `continuation:${continuation.toVersion}`,
        text: `范围接续（v${continuation.fromVersion}→v${continuation.toVersion}，${continuation.origin}）：纳入 ${continuation.addedTargets.join(', ')}；原因：${continuation.reason}`,
        nodeIds: [...continuation.addedTargets],
      });
    }
    // Agent 建议：开放的建议条目（绑定外变更被拒后保留）。
    for (const suggestion of work.suggestions) {
      if (suggestion.workRunId !== run.workRunId || suggestion.status !== 'open') continue;
      items.push({
        kind: 'suggestion',
        source: `suggestion:${suggestion.suggestionId}`,
        text: `绑定外${suggestion.action}被拒并保留为建议（目标 ${suggestion.nodeIds.length > 0 ? suggestion.nodeIds.join(', ') : '（根级）'}）：${suggestion.reason}`,
        nodeIds: [...suggestion.nodeIds],
        suggestionId: suggestion.suggestionId,
      });
    }
    // 目标节点详情与相关公开记录：只取目标集合，不注入整棵树。
    const targets: WorkContext['targets'] = run.targets.map((id) => ({ id, known: true }));
    let records: WorkContext['publicRecords'] = [];
    const details = this.deps.planNodes.nodeDetails;
    if (details !== undefined) {
      try {
        const result = await details.call(this.deps.planNodes, run.targets);
        if (result.ok) {
          const byId = new Map(result.nodes.map((node) => [node.id, node]));
          for (const target of targets) {
            const node = byId.get(target.id);
            if (node === undefined) {
              target.known = false;
            } else {
              target.title = node.title;
              target.status = node.status;
            }
          }
          const targetSet = new Set(run.targets);
          records = result.records
            .filter((record) => record.subjectNodeIds.some((id) => targetSet.has(id)))
            .map((record) => ({
              id: record.id,
              kind: record.kind,
              summary: record.summary,
              path: record.path,
              subjectNodeIds: [...record.subjectNodeIds],
            }));
        }
      } catch {
        // 详情不可用：上下文退化为仅 id，不因此失败。
      }
    }
    // 未核查项一：新材料到达（源代际推进）——标记待核对，目标不静默改写。
    const currentEpoch = await this.currentSourceEpoch(aggregate.instanceId);
    if (currentEpoch !== null && currentEpoch > run.acceptedBaseline.sourceEpoch) {
      items.push({
        kind: 'unverified',
        source: `source-generation:${currentEpoch}`,
        text: `资料源代际已推进（${run.acceptedBaseline.sourceEpoch}→${currentEpoch}）；当前目标基于旧资料，新内容待核对，不静默改写已启动目标`,
      });
    }
    // 未核查项二：目标节点已不在当前资料中（外部重载后可能被移除）。
    const unknownTargets = targets.filter((target) => !target.known).map((target) => target.id);
    if (unknownTargets.length > 0) {
      items.push({
        kind: 'unverified',
        source: `plan-nodes:${unknownTargets.join(',')}`,
        text: `目标节点不在当前资料中（外部重载后可能已变化）：${unknownTargets.join(', ')}；待核对，不静默改写`,
        nodeIds: unknownTargets,
      });
    }
    return {
      workRunId: run.workRunId,
      bindingVersion: run.bindingVersion,
      sessionId: run.sessionId,
      turn: run.turn,
      targets,
      constraints: { allowedActions: [...run.allowedActions], reasonScope: run.reasonScope },
      baseline: { ...run.acceptedBaseline },
      publicRecords: records,
      chatEntries: aggregate.conversations.links
        .filter((link) => link.nodeIds.some((id) => run.targets.includes(id)))
        .map((link) => ({ linkId: link.linkId, sessionId: link.sessionId, purpose: link.purpose, origin: link.origin })),
      items,
      generatedAt: this.deps.clock(),
    };
  }

  /** 当前资料源代际（注册表权威值）；读不到时返回 null（上下文不因此失败）。 */
  private async currentSourceEpoch(instanceId: string): Promise<number | null> {
    try {
      const registry = await this.deps.store.readRegistry(this.deps.localRoot);
      const entry = registry.instances.find((item) => item.instanceId === instanceId);
      return entry === undefined ? null : entry.sourceGeneration;
    } catch {
      return null;
    }
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
   * 取消请求观测（tasks 6.5，design §7）：宿主 cancel／steer 的 abort 属取消请求——
   * 立即停止新写准入（admissionStoppedAt），但 status 保持 active，等真实终态（turn/end）
   * 确认；不把 turn-stopping 预告当已终止。已准入（在途发布）的操作不受影响，按提交
   * 恢复协议处理；会话没有生效运行时不撤销任何东西（Client 断线不取消 Host 工作）。
   * 无法唯一归属且该会话存在失去链路的 active 意图（运行缺失）时记 blocked。
   */
  async observeCancel(event: { sessionId: string; turn?: number }): Promise<AdmissionResult> {
    if (typeof event.sessionId !== 'string' || event.sessionId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '取消事件缺少 sessionId' };
    }
    return this.deps.queue.run(this.deps.instanceId, async () => {
      const read = await this.readAggregate();
      if ('outcome' in read) return read.outcome;
      const { aggregate } = read;
      const work = workStateOf(aggregate);
      const now = this.deps.clock();
      const active = work.runs.filter((run) => run.sessionId === event.sessionId && this.effectiveRun(run));
      if (active.length === 1) {
        const run = active[0] as WorkRunRecord;
        if (run.admissionStoppedAt !== undefined) {
          return { status: 'cancelling' as const, workRunId: run.workRunId, stateRevision: aggregate.revisions.state };
        }
        const runs = work.runs.map((item) =>
          item.workRunId === run.workRunId ? { ...item, admissionStoppedAt: now } : item,
        );
        const outcome = await this.persist(aggregate, (next) => ({ ...next, workRuns: runs }));
        if (outcome.status !== 'committed') return outcome;
        return { status: 'cancelling' as const, workRunId: run.workRunId, stateRevision: outcome.stateRevision };
      }
      if (active.length > 1) {
        return { status: 'rejected', code: 'binding-ambiguous', message: `会话 ${event.sessionId} 存在 ${active.length} 个生效绑定；取消归属不唯一，拒绝盲停` };
      }
      // 无生效运行：失去链路的 active 意图（运行缺失）记 blocked，不静默清理。
      const stale = work.intents.filter((intent) => intent.status === 'active' && intent.sessionId === event.sessionId);
      if (stale.length === 0) return { status: 'unmatched' };
      const intents = work.intents.map((item) =>
        item.status === 'active' && item.sessionId === event.sessionId
          ? { ...item, status: 'blocked' as const, blockedReason: 'lifecycle-unattributable', updatedAt: now }
          : item,
      );
      const outcome = await this.persist(aggregate, (next) => ({ ...next, workIntents: intents }));
      if (outcome.status !== 'committed') return outcome;
      return {
        status: 'blocked',
        reason: 'lifecycle-unattributable',
        workIntentIds: stale.map((item) => item.workIntentId),
        stateRevision: outcome.stateRevision,
      };
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
    return this.validateScope(request, true);
  }

  /**
   * 范围校验（prepare 与 preview 共用）：目标、动作、原因范围、目的与基线形状。
   * `requireIntentId` 仅 prepare 需要（意图要有稳定 id 以便幂等重试）。
   */
  private validateScope(
    request: Omit<PrepareWorkRequest, 'workIntentId'> & { workIntentId?: string },
    requireIntentId: boolean,
  ): WorkRejection | null {
    if (requireIntentId && (typeof request.workIntentId !== 'string' || request.workIntentId === '')) {
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
    if (request.rootGroupAllowed !== undefined && typeof request.rootGroupAllowed !== 'boolean') {
      return { status: 'rejected', code: 'operation-mismatch', message: 'rootGroupAllowed 必须是布尔值' };
    }
    if (request.templates !== undefined) {
      const templates = request.templates;
      if (!Array.isArray(templates)) {
        return { status: 'rejected', code: 'operation-mismatch', message: 'templates 必须是数组' };
      }
      for (const item of templates) {
        if (item === null || typeof item !== 'object') {
          return { status: 'rejected', code: 'operation-mismatch', message: '模板授权必须是对象' };
        }
        if (item.source !== 'builtin' && item.source !== 'user') {
          return { status: 'rejected', code: 'operation-mismatch', message: "模板来源必须是 'builtin' 或 'user'" };
        }
        if (typeof item.templateId !== 'string' || item.templateId === '') {
          return { status: 'rejected', code: 'operation-mismatch', message: '模板授权缺少 templateId' };
        }
        if (item.source === 'builtin'
          && (!Number.isSafeInteger(item.templateVersion) || (item.templateVersion as number) < 1)) {
          return { status: 'rejected', code: 'operation-mismatch', message: '内置模板授权必须给出正整数版本' };
        }
        if (item.source === 'user'
          && (typeof item.versionRecordId !== 'string' || item.versionRecordId === ''
            || typeof item.contentHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(item.contentHash))) {
          return { status: 'rejected', code: 'operation-mismatch', message: '用户模板授权必须给出记录 id 与 sha256 正文哈希' };
        }
      }
    }
    return null;
  }

  /**
   * 实例仍在注册表的核对（tasks 6.5）：卸载（注册表条目移除）后不建立新捕获、不接受写入。
   * 返回 null 表示已注册；否则返回面向调用者的说明。注册表不可读时按稳定拒绝停止（fail-closed）。
   */
  private async ensureRegistered(): Promise<string | null> {
    let registry;
    try {
      registry = await this.deps.store.readRegistry(this.deps.localRoot);
    } catch (error) {
      return `本机注册表不可读（${(error as Error).message}）；不建立或延续写资格`;
    }
    const entry = registry.instances.find((item) => item.instanceId === this.deps.instanceId);
    if (entry === undefined) {
      return '实例已从本机注册表卸载；绑定失效，不接受写入';
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
  // 结构权限也属于“范围”：同号换许可必须拒绝，不能拿原意图的旧许可继续用。
  const sameRootGroup = (intent.rootGroupAllowed === true) === (request.rootGroupAllowed === true);
  const sameTemplates = templateKey(intent.templates ?? []) === templateKey(request.templates ?? []);
  return sameIds
    && sameActions
    && sameRootGroup
    && sameTemplates
    && intent.reasonScope === request.reasonScope
    && intent.purpose === request.purpose
    && intent.baseline.planVersion === request.baseline.planVersion
    && intent.baseline.planRevision === request.baseline.planRevision
    && intent.baseline.sourceEpoch === request.baseline.sourceEpoch;
}

/** 模板授权的规范化键（顺序无关）；用于幂等比较。 */
function templateKey(templates: readonly WorkTemplateAuthorization[]): string {
  return templates
    .map((item) => [item.source, item.templateId, item.templateVersion ?? '', item.versionRecordId ?? '', item.contentHash ?? ''].join('\u0000'))
    .sort()
    .join('\u0001');
}

/**
 * 精确模板授权核对（tasks 3.3）：内置按 ID+版本，用户模板按 ID+版本记录+正文哈希。
 * 旧运行／旧意图没有 templates 字段 → 空授权，不因缺字段放宽。
 */
function templateAuthorized(
  run: Pick<WorkRunRecord, 'templates'>,
  command: Extract<Command, { type: 'insert-preset' } | { type: 'insert-user-template' }>,
): boolean {
  const templates = run.templates ?? [];
  if (command.type === 'insert-preset') {
    return templates.some((item) =>
      item.source === 'builtin'
      && item.templateId === command.templateId
      && item.templateVersion === command.templateVersion,
    );
  }
  return templates.some((item) =>
    item.source === 'user'
    && item.templateId === command.templateId
    && item.versionRecordId === command.versionRecordId
    && item.contentHash === command.contentHash,
  );
}

function validMessageEvent(event: { sessionId?: unknown; rpcId?: unknown }): boolean {
  return typeof event.sessionId === 'string' && event.sessionId !== '' && typeof event.rpcId === 'string' && event.rpcId !== '';
}
