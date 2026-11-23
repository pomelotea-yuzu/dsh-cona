// 规划与记录命令封套（tasks 4.1／4.2，design §5–§6）。
// 本文件负责：可信入口校验、每实例提交队列、提交前重读、不可变变换、三态发布、双修订推进，
// 以及 (instanceId, operationId) 幂等：先写 pending 意图、完成后写回执，重试返回原结果。
// 4.5 增补：unknown-state／聚合不可读时写隔离标记，停止该实例读写，并提供只读诊断与显式解除。

import { applyPlanCommand, appendRecordIndex, type NodePatch, type PlanCommand } from '../domain/commands.js';
import type { GroupContent, MergeDependencyResolution } from '../domain/transforms.js';
import { buildReplacementClearText, buildReplacementReplaceText, REPLACEMENT_SUMMARY_PREFIX } from '../domain/replacement.js';
import { computePlanVersion } from '../domain/canonical/plan-fingerprint.js';
import {
  applyPlanInverse,
  buildPlanInverse,
  checkInverseState,
  validatePlanInverse,
  type InverseDirection,
  type InverseReplacement,
  type PlanInverse,
} from '../domain/inverse.js';
import {
  USER_TEMPLATE_SUMMARY_PREFIX,
  buildUserTemplateText,
  extractSubtreeTemplate,
  internalDependencies,
  parseUserTemplateText,
  validateUserTemplateBody,
  type UserTemplateBody,
} from '../domain/user-template.js';
import {
  FEATURE_DEVELOPMENT_PRESET,
  validatePreset,
  type PresetContentLocale,
  type PresetDescriptor,
} from '../domain/presets.js';
import type {
  DependencyEdge,
  MilestoneDelivery,
  NodeStatus,
  ProjectDocument,
  RecordKind,
  RecordSource,
  Sha256Fn,
  ValidationIssue,
  VerificationBlock,
  WorkNode,
} from '../domain/types.js';
import { validateProjectDocument } from '../domain/validate.js';
import { convertToRoadmap, milestoneOf, resolveDelivery, roadmapEnableDigest, sameDelivery } from '../domain/roadmap.js';
import {
  MILESTONE_COMPLETION_SUMMARY_PREFIX,
  buildMilestoneCompletionText,
  type MilestoneCompletionBody,
  type MilestoneCompletionEvidence,
} from '../domain/milestone-completion.js';
import { UUID_RE } from '../domain/validate-constants.js';
import { readSourceBaseline, type SourceBaseline } from './baseline.js';
import { hasResumePrefix, parseResumeBody } from '../domain/resume.js';
import { InstanceCommandQueue } from './command-queue.js';
import type {
  InstanceAggregate,
  OperationOrigin,
  OperationRecord,
  OperationResultSnapshot,
  QuarantineInfo,
} from './local-state.js';
import type { BodyWriteOutcome, LocalStateStorePort, PublishHooksPort, SourceFilesPort } from './ports.js';

/** 可信主体来源：两条入口分别判据，不共用一个“owner 或为空即放行”的判断。 */
export type TrustedContext =
  | { kind: 'remote-owner' }
  | { kind: 'agent-work'; workRunId: string; bindingVersion: number; instanceId: string };

export interface NewNodeInput {
  parentId: string | null;
  order: number;
  title: string;
  goal: string;
  completionCriteria: string[];
  status?: NodeStatus;
}

export interface AppendRecordCommand {
  type: 'append-record';
  kind: RecordKind;
  subjectNodeIds: string[];
  summary: string;
  sources: RecordSource[];
  /** UTF-8 Markdown 正文；哈希与路径由应用层计算。 */
  body: string;
  verification?: VerificationBlock;
}

/** owner 移动节点：目标父节点（null=根组）+ 同级锚点（null=末尾）。 */
export interface MoveNodeCommand {
  type: 'move-node';
  nodeId: string;
  parentId: string | null;
  beforeNodeId: string | null;
}

/**
 * owner 插入内置流程：请求只带预设身份与正文语言，Host 按自身随包预设解析内容。
 * 全部参数进入请求摘要；升级后旧请求按已持久化的候选／回执恢复，不再查预设。
 */
export interface InsertPresetCommand {
  type: 'insert-preset';
  templateId: string;
  templateVersion: number;
  contentLocale: PresetContentLocale;
  parentId: string | null;
  beforeNodeId: string | null;
}

/** 撤销/重做：以原操作的 operationId 为目标，确认预览指纹后从私有历史重算候选。 */
export interface UndoPlanEditCommand {
  type: 'undo-plan-edit' | 'redo-plan-edit';
  targetOperationId: string;
  previewDigest: string;
}

/** 保存用户模板：从所选子树抽取模板正文，作为不可变 plan-change 记录发布。 */
export interface SaveUserTemplateCommand {
  type: 'save-user-template';
  templateId: string;
  title: string;
  bodyLanguage: string;
  /** 子树根的项目节点 id；正文只用局部键，原节点身份不进入模板。 */
  rootNodeId: string;
}

/**
 * 插入用户模板：身份三元组冻结一个不可变版本，提交时重读当前发布索引与正文核对。
 * parentId 必须是现有父节点（null 与缺失都返回 parent-not-found）。
 */
export interface InsertUserTemplateCommand {
  type: 'insert-user-template';
  templateId: string;
  versionRecordId: string;
  contentHash: string;
  parentId: string | null;
  beforeNodeId: string | null;
}

export type Command =
  | { type: 'add-nodes'; nodes: NewNodeInput[] }
  | { type: 'update-node'; nodeId: string; patch: NodePatch }
  | { type: 'split-node'; parentId: string; children: Omit<NewNodeInput, 'parentId'>[] }
  | { type: 'group-nodes'; nodeIds: string[]; group: GroupContent; anchorId: string | null }
  | {
      type: 'merge-nodes';
      keepNodeId: string;
      sourceNodeIds: string[];
      patch?: NodePatch;
      resolutions: MergeDependencyResolution[];
    }
  | {
      type: 'copy-subtree';
      nodeId: string;
      targetParentId: string | null;
      anchorId: string | null;
      externalDependencies: { nodeId: string; requiresNodeId: string }[];
    }
  | { type: 'set-dependencies'; dependencies: DependencyEdge[] }
  | { type: 'set-node-status'; nodeId: string; status: NodeStatus }
  /** 4.2 启用扩展规划：owner 预览后按确认摘要发布 v2（不改节点与记录身份）。 */
  | { type: 'enable-roadmap'; previewDigest: string }
  /** 4.3 里程碑：只改目标节点的公开字段；交付整体替换，空数组合法。 */
  | { type: 'set-milestone'; nodeId: string; deliveries: MilestoneDelivery[] }
  | { type: 'remove-milestone'; nodeId: string }
  /** 4.3 正式完成：逐项证据 + 一次原子发布（节点 done + 完成记录 + 新指纹）。 */
  | { type: 'complete-milestone'; nodeId: string; evidence: MilestoneCompletionEvidence[] }
  | MoveNodeCommand
  | InsertPresetCommand
  | UndoPlanEditCommand
  | SaveUserTemplateCommand
  | InsertUserTemplateCommand
  | AppendRecordCommand;

/**
 * 只能由 owner 发起的命令：分组／合并／复制、撤销重做、模板保存仍是 owner-only。
 * move-node／insert-preset／insert-user-template 自 3.3 起可由配置实例内的可信 WorkRun 发起，
 * 但必须经 WorkAdmissionPort 准入（缺工作端口的 agent 上下文仍拒绝），见 execute。
 */
const OWNER_ONLY_COMMANDS = new Set<string>([
  'group-nodes', 'merge-nodes', 'copy-subtree',
  'undo-plan-edit', 'redo-plan-edit', 'save-user-template',
  // 4.2 启用扩展：改变公开格式版本，只能由 owner 在预览确认后发起。
  'enable-roadmap',
  // 4.3 里程碑编辑与完成：owner 决定交付与逐项证据的对应关系，工具不能代替。
  'set-milestone', 'remove-milestone', 'complete-milestone',
]);

/** 可由可信 WorkRun 发起的结构命令（3.3）：缺工作端口时不得降级放行。 */
const WORK_RUN_STRUCTURAL_COMMANDS = new Set<string>([
  'move-node', 'insert-preset', 'insert-user-template',
]);

/** 可撤销的规划编辑（append-record 与逆向命令自身不写入新的逆向信息）。 */
const INVERTIBLE_COMMANDS = new Set<string>([
  'add-nodes', 'update-node', 'split-node', 'group-nodes', 'merge-nodes', 'copy-subtree',
  'set-dependencies', 'set-node-status', 'move-node', 'insert-preset', 'insert-user-template',
  // 4.5：里程碑条目编辑与逆向信息一起保存（未触及的条目不受影响）。
  'set-milestone', 'remove-milestone',
]);

/** 逆向命令的方向与目标。 */
function inverseCommandOf(command: Command): (UndoPlanEditCommand & { direction: InverseDirection }) | null {
  if (command.type === 'undo-plan-edit' || command.type === 'redo-plan-edit') {
    return { ...command, direction: command.type === 'undo-plan-edit' ? 'undo' : 'redo' };
  }
  return null;
}

/** 只读预览请求：不写任何文件，返回确认指纹、影响摘要与冲突对象。 */
export interface InversePreviewRequest {
  instanceId: string;
  targetOperationId: string;
  direction: InverseDirection;
}

export interface InverseConflictView {
  code: string;
  message: string;
  kind?: string;
  nodeId?: string;
  field?: string;
}

export type InversePreviewResult =
  | {
      status: 'available';
      previewDigest: string;
      direction: InverseDirection;
      target: { operationId: string; commandType: string; sourceEpoch: number; createdAt: string; afterPlanVersion: string };
      inverse: {
        affectedNodeIds: string[];
        fieldCount: number;
        generatedNodeCount: number;
        removedNodeCount: number;
        dependencyChangeCount: number;
        replacement?: InverseReplacement;
      };
      current: CommandCurrent;
    }
  | { status: 'unavailable' | 'conflict' | 'not-found'; direction: InverseDirection; message: string; conflicts?: InverseConflictView[]; current?: CommandCurrent };

/** 目标视图的单个交付项：节点或已发布记录；`diagnostic` 非空表示待核对。 */
export interface MilestoneDeliveryView {
  kind: 'node' | 'record';
  refId: string;
  /** 节点交付：标题与状态；记录交付为 null。 */
  title: string | null;
  status: string | null;
  /** 记录交付：记录类型、摘要、正文哈希与可定位的主体节点。 */
  recordKind: string | null;
  summary: string | null;
  contentHash: string | null;
  subjectNodeId: string | null;
  /** `milestone-delivery-*` 诊断码；null 表示当前可核对。 */
  diagnostic: string | null;
}

/** 已发布接续摘要（目标视图的“实际进展／下一步／阻塞”来源）。 */
export interface MilestoneProgressView {
  recordId: string;
  savedAt: string;
  stoppedAt: string;
  nextStep: string;
  nextStepKind: 'suggested' | 'confirmed';
  outcome: string | null;
  openIssues: string | null;
}

/** 完成记录定位：`current` 为假表示与当前规划指纹不同（历史／已过期）。 */
export interface MilestoneCompletionView {
  recordId: string;
  subjectVersion: string;
  current: boolean;
}

/** 目标视图中的一个里程碑：取节点原值，不复制成第二套真源。 */
export interface MilestoneView {
  nodeId: string;
  title: string;
  status: string;
  goal: string;
  completionCriteria: string[];
  deliveries: MilestoneDeliveryView[];
  dependsOn: { id: string; title: string; status: string }[];
  requiredBy: { id: string; title: string; status: string }[];
  /** 最近接续（索引倒序，最多 3 条）：实际进展、下一步与未解决问题。 */
  progress: MilestoneProgressView[];
  /** 全部完成记录（索引倒序）；第一条即最近一次。 */
  completions: MilestoneCompletionView[];
  /** 交付待核对与完成记录过期的汇总诊断码。 */
  diagnostics: string[];
  deliveryCount: number;
  criterionCount: number;
  completionRecordId: string | null;
  completionSubjectVersion: string | null;
  completionCurrent: boolean;
}

/** 路线图只读状态：v1 为“未启用”，v2 给出里程碑目标视图（同源快照投影）。 */
export interface RoadmapStateView {
  schemaVersion: number;
  planVersion: string;
  planRevision: number;
  sourceEpoch: number;
  enabled: boolean;
  milestones: MilestoneView[];
}

export type RoadmapStateResult =
  | { status: 'ok'; roadmap: RoadmapStateView }
  | { status: 'rejected'; code: string; message: string };

/** 启用前的兼容影响：哪些验证记录会转成历史、身份与版本如何变化。 */
export interface RoadmapEnableImpact {
  current: CommandCurrent & { schemaVersion: number };
  target: { schemaVersion: 2; planVersion: string };
  /** 启用只创建空集合。 */
  milestoneCount: 0;
  identities: { projectId: string; nodeCount: number; recordCount: number };
  verifications: {
    recordId: string;
    summary: string;
    status: string;
    subjectVersion: string | null;
    /** 启用前是否属于当前规划版本（这些记录启用后转为历史，不计入完成依据）。 */
    currentlyCurrent: boolean;
  }[];
  previewDigest: string;
}

export type RoadmapEnablePreviewResult =
  | { status: 'available'; impact: RoadmapEnableImpact }
  | { status: 'rejected'; code: string; message: string };

/** 历史项：每条带逆向信息的已提交 owner 规划操作及其当前撤销/重做可用性。 */
export interface UndoHistoryEntry {
  operationId: string;
  commandType: string;
  createdAt: string;
  sourceEpoch: number;
  beforePlanVersion: string;
  afterPlanVersion: string;
  affectedNodeIds: string[];
  canUndo: boolean;
  canRedo: boolean;
  reason?: string;
}

export type UndoHistoryResult =
  | { status: 'committed'; instanceId: string; entries: UndoHistoryEntry[] }
  | { status: 'rejected'; code: string; message: string };

/** 用户模板目录项：来源固定 user，身份为 templateId + versionRecordId + contentHash。 */
export interface UserTemplateDescriptor {
  source: 'user';
  templateId: string;
  versionRecordId: string;
  contentHash: string;
  bodyLanguage: string;
  title: string;
}

export type UserTemplateListResult =
  | { status: 'committed'; instanceId: string; templates: UserTemplateDescriptor[] }
  | { status: 'rejected'; code: string; message: string };

export type UserTemplateGetResult =
  | { status: 'committed'; descriptor: UserTemplateDescriptor; body: UserTemplateBody }
  | { status: 'rejected'; code: 'template-version-unavailable' | 'template-version-mismatch' | 'template-invalid'; message: string };

/** 从已发布正文与索引条目组装目录项；正文损坏或版本不支持时返回 null（目录过滤）。 */
function templateDescriptor(entry: {
  id: string; path: string; contentHash: string; summary: string;
}, parsed: UserTemplateBody): UserTemplateDescriptor {
  return {
    source: 'user',
    templateId: parsed.templateId,
    versionRecordId: entry.id,
    contentHash: entry.contentHash,
    bodyLanguage: parsed.bodyLanguage,
    title: parsed.title,
  };
}

/** 提交时从私有历史解析出的逆向上下文（只在实例队列内构造，不进入公开资料）。 */
interface InverseContext {
  direction: InverseDirection;
  targetOperationId: string;
  inverse: PlanInverse;
  /** 预览指纹：确认后基线或目标变化都会导致不匹配。 */
  previewDigest: string;
}

/** 随包预设目录：按 ID 与版本精确匹配，未知 ID／不可用版本返回稳定诊断。 */
export interface PresetCatalog {
  list(): readonly PresetDescriptor[];
  resolve(templateId: string, templateVersion: number):
    | { ok: true; preset: PresetDescriptor }
    | { ok: false; code: 'template-not-found' | 'template-version-unavailable' | 'template-invalid'; message: string };
}

/** 默认目录只含随包 feature-development v1；描述无效时按 template-invalid 拒绝。 */
export function createBuiltinPresetCatalog(presets: readonly PresetDescriptor[] = [FEATURE_DEVELOPMENT_PRESET]): PresetCatalog {
  return {
    list: () => presets.map((preset) => JSON.parse(JSON.stringify(preset)) as PresetDescriptor),
    resolve(templateId, templateVersion) {
      const byId = presets.filter((item) => item.id === templateId);
      if (byId.length === 0) {
        return { ok: false, code: 'template-not-found', message: `未知预设 ${templateId}` };
      }
      const preset = byId.find((item) => item.version === templateVersion);
      if (preset === undefined) {
        return { ok: false, code: 'template-version-unavailable', message: `预设 ${templateId} 无版本 ${templateVersion}` };
      }
      const issues = validatePreset(preset);
      if (issues.length > 0) {
        return { ok: false, code: 'template-invalid', message: '预设描述无效' };
      }
      return { ok: true, preset };
    },
  };
}

export interface CommandEnvelope {
  operationId: string;
  projectId: string;
  instanceId: string;
  /** 资料实例的源代际（注册表 sourceGeneration）。 */
  sourceEpoch: number;
  expectedPlanVersion: string;
  expectedPlanRevision: number;
  command: Command;
}

export interface CommandCurrent {
  planVersion: string;
  planRevision: number;
  sourceEpoch: number;
}

export interface CommittedCommand {
  status: 'committed';
  operationId: string;
  impact: 'plan' | 'state';
  planVersion: string;
  planRevision: number;
  stateRevision: number;
  sourceEpoch: number;
  recordId?: string;
  recordPath?: string;
  /** true 表示返回的是历史回执，未再次执行。 */
  replayed?: boolean;
}

export interface RejectedCommand {
  status: 'rejected';
  code: string;
  message: string;
  issues?: ValidationIssue[];
  current?: CommandCurrent;
  replayed?: boolean;
}

export interface PendingCommand {
  status: 'pending-reconciliation';
  operationId: string;
  stage: string;
  message: string;
}

export type CommandResult = CommittedCommand | RejectedCommand | PendingCommand;

export type ReceiptResult = CommandResult | { status: 'not-found' };

/**
 * 工作绑定准入端口（tasks 6.2，design §7）：agent-work 上下文的有限范围授权。
 * 由 WorkService 结构化实现；命令服务只依赖此接口，不依赖 WorkService 全量 API。
 */
export interface WorkAdmissionPort {
  /** 核对活动 WorkRun、绑定版本、动作与目标范围、命令基线与已接受基线一致。 */
  authorizeAgentCommand(
    ctx: { kind: 'agent-work'; workRunId: string; bindingVersion: number; instanceId: string },
    envelope: CommandEnvelope,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  /** 本运行规划命令成功后推进绑定版本（仅更新已接受基线；在实例队列任务内调用）。 */
  afterPlanCommit(
    ctx: { kind: 'agent-work'; workRunId: string; bindingVersion: number },
    result: { planVersion: string; planRevision: number; sourceEpoch: number },
  ): Promise<void>;
}

/** 只读诊断报告（tasks 4.5）：不写文件，不改变任何状态。 */
export interface DiagnosticsReport {
  instanceId: string;
  quarantined: QuarantineInfo | null;
  operations: {
    operationId: string;
    status: string;
    createdAt: string;
    candidateHeadHash?: string;
    candidateHead?: string;
  }[];
  current: { planVersion: string; headHash: string; recordCount: number } | null;
  comparisons: {
    operationId: string;
    headMatched: boolean;
    bodiesMatched: boolean;
    reverted: boolean;
    diverged: boolean;
  }[];
  issues: { code: string; message: string }[];
  guidance: string[];
}

/**
 * 恢复结论（tasks 4.4）：
 * - committed + `history`：直接返回历史回执，不重放；
 * - committed + `candidate-matched`：磁盘内容精确对应候选，已补回执并一次性补修订；
 * - rejected + `not-published`：prepared 阶段被终止，标记未发布，保留原 operationId；
 * - pending-reconciliation：原基线重现或已分叉，无法判定，不自动重试。
 */
export type RecoveryResult =
  | (CommittedCommand & { replayed: true; recovery: 'history' | 'candidate-matched' })
  | (RejectedCommand & { recovery?: 'history' | 'not-published' })
  | PendingCommand
  | { status: 'not-found' };

export interface ProjectCommandDeps {
  /** R1 单一本机根；多根部署不在支持范围。 */
  localRoot: string;
  store: LocalStateStorePort;
  files: SourceFilesPort;
  sha256: Sha256Fn;
  clock: () => string;
  newNodeId: () => string;
  newRecordId: () => string;
  queue?: InstanceCommandQueue;
  /** 工作绑定准入（tasks 6.2）：agent-work 上下文的有限范围授权与绑定版本推进。 */
  work?: WorkAdmissionPort;
  /** 随包预设目录（tasks 2.1）；缺省使用内置 feature-development v1。 */
  presetCatalog?: PresetCatalog;
  /** 故障注入（仅测试）。 */
  hooks?: { publish?: PublishHooksPort; body?: PublishHooksPort; state?: PublishHooksPort };
  /** 提交后通知（第 5 段失效流）；失败不撤回提交。 */
  notify?: (result: CommittedCommand, envelope: CommandEnvelope) => void | Promise<void>;
}

/** 规划命令（除记录追加外的五类）。 */
type PlanningCommand = Exclude<Command, AppendRecordCommand>;

type AuthorizeResult = { ok: true } | { ok: false; code: string; message: string };

/** 只校验主体本身（不含实例匹配），供回执查询等只读路径复用。 */
export function checkTrustedContext(ctx: TrustedContext | undefined): AuthorizeResult {
  if (ctx === undefined || ctx === null) {
    return { ok: false, code: 'forbidden', message: '缺少可信执行上下文，不降级为进程内 owner' };
  }
  if (ctx.kind === 'remote-owner') return { ok: true };
  if (ctx.kind === 'agent-work') {
    if (typeof ctx.workRunId !== 'string' || ctx.workRunId === '') {
      return { ok: false, code: 'forbidden', message: '工具入口缺少真实 WorkRun 归属' };
    }
    if (!Number.isSafeInteger(ctx.bindingVersion) || ctx.bindingVersion < 1) {
      return { ok: false, code: 'forbidden', message: '工具入口缺少有效绑定版本' };
    }
    return { ok: true };
  }
  return { ok: false, code: 'forbidden', message: '未知入口类型' };
}

/**
 * 入口校验：UI Remote 由适配器在真实 owner invocation 上判定；工具由真实 ToolRunContext 判定。
 * 缺上下文不降级；伪造字段不能借业务参数取得资格。
 */
export function authorizeTrustedContext(ctx: TrustedContext | undefined, envelope: CommandEnvelope): AuthorizeResult {
  const base = checkTrustedContext(ctx);
  if (!base.ok) return base;
  // 结构命令（移动／插入）覆盖原始命令的直达调用：只允许 owner，agent-work 一律拒绝。
  if (ctx !== undefined && ctx.kind === 'agent-work' && OWNER_ONLY_COMMANDS.has(envelope.command?.type)) {
    return { ok: false, code: 'forbidden', message: '结构命令只能由 owner 发起' };
  }
  if (ctx !== undefined && ctx.kind === 'agent-work' && ctx.instanceId !== envelope.instanceId) {
    return { ok: false, code: 'forbidden', message: '绑定实例与命令实例不一致' };
  }
  return { ok: true };
}

function originOf(ctx: TrustedContext): OperationOrigin {
  return ctx.kind === 'remote-owner' ? { kind: 'remote-owner' } : { kind: 'agent-work', workRunId: ctx.workRunId };
}


function sameOrigin(a: OperationOrigin, b: OperationOrigin): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'agent-work') return a.workRunId === b.workRunId;
  return true;
}

/** 递归按键排序并丢弃 undefined：同一业务请求必须得到同一摘要，与字面量书写顺序无关。 */
function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const item = source[key];
      if (item === undefined) continue;
      out[key] = stableValue(item);
    }
    return out;
  }
  return value;
}

export class ProjectCommandService {
  private readonly queue: InstanceCommandQueue;
  private readonly presetCatalog: PresetCatalog;

  constructor(private readonly deps: ProjectCommandDeps) {
    this.queue = deps.queue ?? new InstanceCommandQueue();
    this.presetCatalog = deps.presetCatalog ?? createBuiltinPresetCatalog();
  }

  /** 当前随包预设目录（owner 树入口读取；实例可读性由 host 入口核对）。 */
  treePresets(): readonly PresetDescriptor[] {
    return this.presetCatalog.list();
  }

  /** 规范化请求摘要：命令、业务参数与输入基线；不含 operationId 或重连临时标识。 */
  requestDigest(envelope: CommandEnvelope): string {
    const payload = {
      projectId: envelope.projectId,
      instanceId: envelope.instanceId,
      sourceEpoch: envelope.sourceEpoch,
      expectedPlanVersion: envelope.expectedPlanVersion,
      expectedPlanRevision: envelope.expectedPlanRevision,
      command: envelope.command,
    };
    return 'sha256:' + this.deps.sha256(new TextEncoder().encode(JSON.stringify(stableValue(payload))));
  }

  /**
   * 从当前公开资料抽取所选子树，构造用户模板正文（tasks 2.4）。
   * 只用局部键，省略对外依赖；项目节点身份、聊天、授权与私有数据均不进入正文。
   */
  private buildTemplateBody(
    doc: ProjectDocument,
    request: { templateId: string; title: string; bodyLanguage: string; rootNodeId: string },
  ): { ok: true; body: UserTemplateBody } | { ok: false; code: string; message: string } {
    const uuid = UUID_RE.test(request.templateId);
    if (!uuid) return { ok: false, code: 'template-invalid', message: 'templateId 必须是 UUID' };
    if (request.title.trim() === '') return { ok: false, code: 'template-invalid', message: '模板标题不能为空' };
    if (!doc.plan.nodes.some((node) => node.id === request.rootNodeId)) {
      return { ok: false, code: 'node-not-found', message: `子树根 ${request.rootNodeId} 不存在` };
    }
    const extracted = extractSubtreeTemplate(doc.plan, request.rootNodeId);
    const body: UserTemplateBody = {
      version: 1,
      templateId: request.templateId,
      title: request.title,
      bodyLanguage: request.bodyLanguage,
      nodes: extracted.nodes,
      dependencies: internalDependencies(doc.plan, extracted.keyOf),
    };
    const validated = validateUserTemplateBody(body);
    if (!validated.ok) {
      return { ok: false, code: 'template-invalid', message: validated.issues[0]?.message ?? '模板描述无效' };
    }
    return { ok: true, body: validated.body };
  }

  /** 只读预览所选子树的模板正文与摘要（不发布、不改文件）。 */
  async previewUserTemplate(
    ctx: TrustedContext | undefined,
    request: { instanceId: string; templateId: string; title: string; bodyLanguage: string; rootNodeId: string },
  ): Promise<
    | { status: 'available'; body: UserTemplateBody; text: string; summary: string }
    | { status: 'rejected'; code: string; message: string }
  > {
    const authorized = checkTrustedContext(ctx);
    if (!authorized.ok) return { status: 'rejected', code: authorized.code, message: authorized.message };
    const registry = await this.deps.store.readRegistry(this.deps.localRoot);
    const entry = registry.instances.find((item) => item.instanceId === request.instanceId);
    if (entry === undefined) return { status: 'rejected', code: 'binding-expired', message: '本机注册表中没有该实例' };
    const baseline = await readSourceBaseline(this.deps.files, entry.sourceRoot, this.deps.sha256, this.deps.clock);
    if (!baseline.ok) return { status: 'rejected', code: 'invalid-project', message: '当前资料不可读或不合法' };
    const built = this.buildTemplateBody(baseline.doc, request);
    if (!built.ok) return { status: 'rejected', code: built.code, message: built.message };
    return {
      status: 'available',
      body: built.body,
      text: buildUserTemplateText(built.body),
      summary: `${USER_TEMPLATE_SUMMARY_PREFIX}${built.body.title}（${built.body.nodes.length} 节点）`,
    };
  }

  /** 读取某实例的异步用户模板目录；只收已发布且正文验证成功的记录版本。 */
  async listUserTemplates(ctx: TrustedContext | undefined, request: { instanceId: string }): Promise<UserTemplateListResult> {
    const authorized = checkTrustedContext(ctx);
    if (!authorized.ok) return { status: 'rejected', code: authorized.code, message: authorized.message };
    const quarantine = await this.deps.store.readQuarantine(this.deps.localRoot, request.instanceId);
    if (quarantine !== null) return { status: 'rejected', code: 'unknown-state', message: `实例已隔离（${quarantine.reason}）` };
    const registry = await this.deps.store.readRegistry(this.deps.localRoot);
    const entry = registry.instances.find((item) => item.instanceId === request.instanceId);
    if (entry === undefined) return { status: 'rejected', code: 'binding-expired', message: '本机注册表中没有该实例' };
    const doc = await this.deps.files.readDocument(entry.sourceRoot);
    if (!doc.ok) return { status: 'rejected', code: 'invalid-project', message: '当前资料不可读或不合法' };

    const templates: UserTemplateDescriptor[] = [];
    for (const record of doc.doc.records) {
      if (record.kind !== 'plan-change' || !record.summary.startsWith(USER_TEMPLATE_SUMMARY_PREFIX)) continue;
      const body = await this.deps.files.readScopedFile(entry.sourceRoot, record.path);
      if (!body.ok) continue;
      const actualHash = 'sha256:' + this.deps.sha256(body.bytes);
      if (actualHash !== record.contentHash) continue;
      const parsed = parseUserTemplateText(new TextDecoder().decode(body.bytes));
      if (!parsed.ok) continue;
      templates.push(templateDescriptor(record, parsed.body));
    }
    return { status: 'committed', instanceId: request.instanceId, templates };
  }

  /** 按 templateId + versionRecordId + contentHash 三元组精确读取单一版本。 */
  async getUserTemplate(
    ctx: TrustedContext | undefined,
    request: { instanceId: string; templateId: string; versionRecordId: string; contentHash: string },
  ): Promise<UserTemplateGetResult> {
    const listed = await this.listUserTemplates(ctx, { instanceId: request.instanceId });
    if (listed.status !== 'committed') {
      return { status: 'rejected', code: 'template-version-unavailable', message: listed.message };
    }
    const descriptor = listed.templates.find((item) =>
      item.templateId === request.templateId
      && item.versionRecordId === request.versionRecordId
      && item.contentHash === request.contentHash,
    );
    if (descriptor === undefined) {
      return { status: 'rejected', code: 'template-version-unavailable', message: '模板版本不存在或已移出索引' };
    }
    const registry = await this.deps.store.readRegistry(this.deps.localRoot);
    const entry = registry.instances.find((item) => item.instanceId === request.instanceId);
    if (entry === undefined) {
      return { status: 'rejected', code: 'template-version-unavailable', message: '实例不存在' };
    }
    const body = await this.deps.files.readScopedFile(entry.sourceRoot,
      `records/${request.versionRecordId}/${request.contentHash.slice('sha256:'.length)}.md`);
    if (!body.ok) return { status: 'rejected', code: 'template-version-unavailable', message: '正文不可读' };
    const parsed = parseUserTemplateText(new TextDecoder().decode(body.bytes));
    if (!parsed.ok) return { status: 'rejected', code: 'template-invalid', message: '模板正文无效' };
    const actualHash = 'sha256:' + this.deps.sha256(body.bytes);
    if (actualHash !== request.contentHash || parsed.body.templateId !== request.templateId) {
      return { status: 'rejected', code: 'template-version-mismatch', message: '模板身份或正文哈希不匹配' };
    }
    return { status: 'committed', descriptor, body: parsed.body };
  }

  /**
   * 确认预览指纹（tasks 2.3）：覆盖方向、目标操作、目标逆向信息与当前基线。
   * 预览后若目标操作、资料版本或源代际变化，提交时的重算值即不匹配，拒绝执行。
   */
  private inversePreviewDigest(
    request: { targetOperationId: string; direction: InverseDirection },
    inverse: PlanInverse,
    current: CommandCurrent,
  ): string {
    const payload = {
      targetOperationId: request.targetOperationId,
      direction: request.direction,
      inverseSourceEpoch: inverse.sourceEpoch,
      beforePlanVersion: inverse.beforePlanVersion,
      afterPlanVersion: inverse.afterPlanVersion,
      affectedNodeIds: inverse.affectedNodeIds,
      current,
    };
    return 'sha256:' + this.deps.sha256(new TextEncoder().encode(JSON.stringify(stableValue(payload))));
  }

  /** 读取可撤销操作的已核对逆向信息；无逆向信息、归属不符或未提交都给出原因。 */
  private inverseOfRecord(
    record: OperationRecord | undefined,
    origin: OperationOrigin,
  ): { ok: true; inverse: PlanInverse; record: OperationRecord } | { ok: false; reason: string } {
    if (record === undefined) return { ok: false, reason: '目标操作不存在' };
    if (record.status !== 'committed' || record.result === undefined) {
      return { ok: false, reason: '目标操作尚未提交成功，没有可核对的回执' };
    }
    if (!sameOrigin(record.origin, origin)) {
      return { ok: false, reason: '目标操作属于其他调用归属，不提供逆向信息' };
    }
    const inverse = validatePlanInverse(record.inverse);
    if (inverse === null) {
      return { ok: false, reason: '旧操作没有逆向信息，不能撤销或重做' };
    }
    if (inverse.operationId !== record.operationId) {
      return { ok: false, reason: '逆向信息的操作 id 与回执不一致' };
    }
    return { ok: true, inverse, record };
  }

  /** 只读安全核对：换源、字段/依赖变化、生成节点被引用、活动 WorkRun。 */
  private inverseSafety(
    inverse: PlanInverse,
    direction: InverseDirection,
    doc: ProjectDocument,
    aggregate: InstanceAggregate,
    sourceEpoch: number,
  ): InverseConflictView[] {
    const conflicts: InverseConflictView[] = [];
    if (inverse.sourceEpoch !== sourceEpoch) {
      conflicts.push({ code: 'source-changed', message: `原操作源代际 ${inverse.sourceEpoch} 与当前 ${sourceEpoch} 不同；换源后须重新核对` });
    }
    const state = checkInverseState(doc.plan, inverse, direction);
    if (!state.ok) {
      for (const item of state.conflicts) {
        conflicts.push({ code: item.code, message: item.message, kind: item.kind, nodeId: item.nodeId, field: item.field });
      }
    }
    // 撤销会移除原生成节点：若其已获得公开记录、聊天或依赖引用，属不可逆场景。
    const touchedIds = new Set(inverse.affectedNodeIds);
    if (direction === 'undo') {
      const generated = new Set(inverse.generatedNodes.map((node) => node.id));
      if (generated.size > 0) {
        for (const record of doc.records) {
          for (const id of record.subjectNodeIds) {
            if (generated.has(id)) {
              conflicts.push({ code: 'inverse-node-in-use', message: `节点 ${id} 已被公开记录 ${record.id} 引用`, kind: 'record', nodeId: id });
            }
          }
        }
        for (const link of aggregate.conversations.links) {
          for (const id of link.nodeIds) {
            if (generated.has(id)) {
              conflicts.push({ code: 'inverse-node-in-use', message: `节点 ${id} 已关联本机聊天 ${link.linkId}`, kind: 'chat', nodeId: id });
            }
          }
        }
        // 原操作自己 added 的依赖会随撤销一起移除，不算「后来新增的引用」。
        const ownEdges = new Set(inverse.dependencyChanges
          .filter((item) => item.direction === 'added')
          .map((item) => `${item.edge.nodeId}\u0000${item.edge.requiresNodeId}`));
        for (const edge of doc.plan.dependencies) {
          if (!generated.has(edge.nodeId) && !generated.has(edge.requiresNodeId)) continue;
          if (ownEdges.has(`${edge.nodeId}\u0000${edge.requiresNodeId}`)) continue;
          conflicts.push({ code: 'inverse-node-in-use', message: `节点已被新增依赖 ${edge.nodeId}→${edge.requiresNodeId} 引用`, kind: 'dependency', nodeId: edge.nodeId });
        }
      }
    }
    const activeRuns = aggregate.workRuns.filter((run) => run.status === 'active');
    if (activeRuns.length > 0 && [...touchedIds].some((id) => activeRuns.some((run) => run.targets.includes(id)))) {
      conflicts.push({ code: 'inverse-work-active', message: '存在活动 WorkRun 以受影响节点为目标；先结束该运行再撤销或重做' });
    }
    return conflicts;
  }

  /** 只读预览：列出可确认指纹、影响范围与冲突，不改变任何状态。 */
  /**
   * 只读：当前资料的路线图状态。v1 返回 enabled=false 与空里程碑（界面据此给空态与启用入口），
   * v2 返回里程碑节点与交付数量；不返回正文，也不改动资料。
   */
  async roadmapState(ctx: TrustedContext | undefined, request: { instanceId: string }): Promise<RoadmapStateResult> {
    const authorized = checkTrustedContext(ctx);
    if (!authorized.ok) return { status: 'rejected', code: authorized.code, message: authorized.message };
    const read = await this.readInstanceSource(request?.instanceId);
    if (!read.ok) return { status: 'rejected', code: read.code, message: read.message };
    return { status: 'ok', roadmap: await this.buildRoadmapView(read) };
  }

  /**
   * 只读：启用扩展规划前的兼容影响。确认摘要绑定当前资料字节与规划版本，
   * 预览后任何外部改写都会让提交返回 preview-mismatch。
   */
  async previewRoadmapEnable(
    ctx: TrustedContext | undefined,
    request: { instanceId: string },
  ): Promise<RoadmapEnablePreviewResult> {
    const authorized = checkTrustedContext(ctx);
    if (!authorized.ok) return { status: 'rejected', code: authorized.code, message: authorized.message };
    const read = await this.readInstanceSource(request?.instanceId);
    if (!read.ok) return { status: 'rejected', code: read.code, message: read.message };
    if (read.doc.schemaVersion === 2) {
      return { status: 'rejected', code: 'roadmap-already-enabled', message: '该规划已启用扩展（schemaVersion 2）' };
    }
    const converted = convertToRoadmap(read.doc, this.deps.sha256);
    if (!converted.ok) return { status: 'rejected', code: converted.code, message: converted.message };
    return {
      status: 'available',
      impact: {
        current: {
          schemaVersion: read.doc.schemaVersion,
          planVersion: read.doc.planVersion,
          planRevision: read.planRevision,
          sourceEpoch: read.sourceEpoch,
        },
        target: { schemaVersion: 2, planVersion: converted.toPlanVersion },
        milestoneCount: 0,
        identities: {
          projectId: read.doc.project.id,
          nodeCount: read.doc.plan.nodes.length,
          recordCount: read.doc.records.length,
        },
        verifications: read.doc.records
          .filter((record) => record.kind === 'verification')
          .map((record) => ({
            recordId: record.id,
            summary: record.summary,
            status: record.verification?.status ?? 'untested',
            subjectVersion: record.verification?.subjectVersion ?? null,
            currentlyCurrent: record.verification?.subjectVersion === read.doc.planVersion,
          })),
        previewDigest: roadmapEnableDigest(
          {
            schemaVersion: read.doc.schemaVersion,
            planVersion: read.doc.planVersion,
            headHash: read.baseline.headHash,
          },
          this.deps.sha256,
        ),
      },
    };
  }

  /**
   * 目标视图（tasks 4.4）：从与树／Agent 读取同源的完整快照投影。里程碑取节点原值，
   * 交付按当前索引解析（失效只标诊断），进展／下一步取关联该节点的已发布接续，
   * 完成记录按受检版本区分当前与历史。只读；不写资料、不启动执行。
   */
  private async buildRoadmapView(
    read: { doc: ProjectDocument; sourceRoot: string; sourceEpoch: number; planRevision: number },
  ): Promise<RoadmapStateView> {
    const { doc } = read;
    const nodeById = new Map(doc.plan.nodes.map((node) => [node.id, node] as const));
    const milestones: MilestoneView[] = [];
    for (const milestone of doc.plan.roadmap?.milestones ?? []) {
      const node = nodeById.get(milestone.nodeId);
      const diagnostics: string[] = [];
      const deliveries: MilestoneDeliveryView[] = milestone.deliveries.map((delivery) => {
        if (delivery.kind === 'node') {
          const target = nodeById.get(delivery.refId);
          const diagnostic = target === undefined
            ? 'milestone-delivery-node-missing'
            : target.status === 'canceled'
              ? 'milestone-delivery-node-canceled'
              : null;
          if (diagnostic !== null) diagnostics.push(diagnostic);
          return {
            kind: 'node', refId: delivery.refId,
            title: target?.title ?? null, status: target?.status ?? null,
            recordKind: null, summary: null, contentHash: null, subjectNodeId: null,
            diagnostic,
          };
        }
        const record = doc.records.find((item) => item.id === delivery.refId);
        const diagnostic = record === undefined
          ? 'milestone-delivery-record-missing'
          : record.contentHash !== delivery.contentHash
            ? 'milestone-delivery-hash-mismatch'
            : null;
        if (diagnostic !== null) diagnostics.push(diagnostic);
        return {
          kind: 'record', refId: delivery.refId,
          title: null, status: null,
          recordKind: record?.kind ?? null, summary: record?.summary ?? null,
          contentHash: record?.contentHash ?? delivery.contentHash,
          subjectNodeId: record?.subjectNodeIds[0] ?? null,
          diagnostic,
        };
      });

      const dependsOn = doc.plan.dependencies
        .filter((edge) => edge.nodeId === milestone.nodeId)
        .map((edge) => {
          const target = nodeById.get(edge.requiresNodeId);
          return { id: edge.requiresNodeId, title: target?.title ?? '', status: target?.status ?? 'unknown' };
        });
      const requiredBy = doc.plan.dependencies
        .filter((edge) => edge.requiresNodeId === milestone.nodeId)
        .map((edge) => {
          const source = nodeById.get(edge.nodeId);
          return { id: edge.nodeId, title: source?.title ?? '', status: source?.status ?? 'unknown' };
        });

      const completions: MilestoneCompletionView[] = [];
      for (const record of doc.records) {
        if (record.kind !== 'verification' || !record.summary.startsWith(MILESTONE_COMPLETION_SUMMARY_PREFIX)) continue;
        if (!record.subjectNodeIds.includes(milestone.nodeId)) continue;
        const subjectVersion = record.verification?.subjectVersion ?? '';
        completions.push({ recordId: record.id, subjectVersion, current: subjectVersion === doc.planVersion });
      }
      completions.reverse();
      if (completions[0] !== undefined && !completions[0].current) diagnostics.push('milestone-completion-stale');

      milestones.push({
        nodeId: milestone.nodeId,
        title: node?.title ?? '',
        status: node?.status ?? 'unknown',
        goal: node?.goal ?? '',
        completionCriteria: node === undefined ? [] : [...node.completionCriteria],
        deliveries,
        dependsOn,
        requiredBy,
        progress: await this.readMilestoneProgress(read.sourceRoot, doc, milestone.nodeId),
        completions,
        diagnostics,
        deliveryCount: milestone.deliveries.length,
        criterionCount: node?.completionCriteria.length ?? 0,
        completionRecordId: completions[0]?.recordId ?? null,
        completionSubjectVersion: completions[0]?.subjectVersion ?? null,
        completionCurrent: completions[0]?.current ?? false,
      });
    }
    return {
      schemaVersion: doc.schemaVersion,
      planVersion: doc.planVersion,
      planRevision: read.planRevision,
      sourceEpoch: read.sourceEpoch,
      enabled: doc.schemaVersion === 2,
      milestones,
    };
  }

  /** 最近 3 条关联该节点的已发布接续（正文不可读或格式无效的条目跳过，不阻断视图）。 */
  private async readMilestoneProgress(
    sourceRoot: string,
    doc: ProjectDocument,
    nodeId: string,
  ): Promise<MilestoneProgressView[]> {
    const candidates = doc.records
      .filter((record) => record.kind === 'execution-note'
        && hasResumePrefix(record.summary)
        && record.subjectNodeIds.includes(nodeId))
      .slice(-3)
      .reverse();
    const out: MilestoneProgressView[] = [];
    for (const record of candidates) {
      const body = await this.deps.files.readScopedFile(sourceRoot, record.path);
      if (!body.ok) continue;
      const parsed = parseResumeBody(new TextDecoder().decode(body.bytes));
      if (!parsed.ok) continue;
      const payload = parsed.payload;
      out.push({
        recordId: record.id,
        savedAt: payload.savedAt,
        stoppedAt: payload.stoppedAt,
        nextStep: payload.nextStep,
        nextStepKind: payload.nextStepKind,
        outcome: payload.outcome ?? null,
        openIssues: payload.openIssues ?? null,
      });
    }
    return out;
  }

  /** 只读读路：隔离、注册表、聚合与完整基线一次核对；任何失败都返回稳定码。 */
  private async readInstanceSource(instanceId: unknown): Promise<
    | { ok: true; doc: ProjectDocument; baseline: SourceBaseline; sourceRoot: string; sourceEpoch: number; planRevision: number }
    | { ok: false; code: string; message: string }
  > {
    if (typeof instanceId !== 'string' || instanceId === '') {
      return { ok: false, code: 'operation-mismatch', message: '缺少 instanceId' };
    }
    const quarantine = await this.deps.store.readQuarantine(this.deps.localRoot, instanceId);
    if (quarantine !== null) {
      return { ok: false, code: 'unknown-state', message: `该实例已隔离（${quarantine.reason}）；先离线核对再读取` };
    }
    const registry = await this.deps.store.readRegistry(this.deps.localRoot);
    const entry = registry.instances.find((item) => item.instanceId === instanceId);
    if (entry === undefined) return { ok: false, code: 'binding-expired', message: '本机注册表中没有该实例' };
    const aggregate = await this.deps.store.readAggregate(this.deps.localRoot, instanceId);
    if (aggregate === null) return { ok: false, code: 'binding-expired', message: '实例聚合缺失；不自动重建' };
    const baseline = await readSourceBaseline(this.deps.files, entry.sourceRoot, this.deps.sha256, this.deps.clock);
    if (!baseline.ok) {
      const first = baseline.issues[0];
      return {
        ok: false,
        code: first?.code ?? 'invalid-project',
        message: baseline.issues.map((issue) => issue.message).join('；') || '资料不可读',
      };
    }
    return {
      ok: true,
      doc: baseline.doc,
      baseline: baseline.baseline,
      sourceRoot: entry.sourceRoot,
      sourceEpoch: entry.sourceGeneration,
      planRevision: aggregate.revisions.plan,
    };
  }

  async previewInverse(ctx: TrustedContext | undefined, request: InversePreviewRequest): Promise<InversePreviewResult> {
    const authorized = checkTrustedContext(ctx);
    if (!authorized.ok) {
      return { status: 'unavailable', direction: request.direction, message: authorized.message };
    }
    if (request.direction !== 'undo' && request.direction !== 'redo') {
      return { status: 'unavailable', direction: request.direction, message: '方向必须是 undo 或 redo' };
    }
    const quarantine = await this.deps.store.readQuarantine(this.deps.localRoot, request.instanceId);
    if (quarantine !== null) {
      return { status: 'unavailable', direction: request.direction, message: `实例已隔离（${quarantine.reason}）` };
    }
    const registry = await this.deps.store.readRegistry(this.deps.localRoot);
    const entry = registry.instances.find((item) => item.instanceId === request.instanceId);
    if (entry === undefined) return { status: 'not-found', direction: request.direction, message: '本机注册表中没有该实例' };
    const aggregate = await this.deps.store.readAggregate(this.deps.localRoot, request.instanceId);
    if (aggregate === null) return { status: 'not-found', direction: request.direction, message: '实例聚合缺失' };
    const origin = originOf(ctx as TrustedContext);
    const found = this.inverseOfRecord(aggregate.operations.find((item) => item.operationId === request.targetOperationId), origin);
    if (!found.ok) return { status: 'unavailable', direction: request.direction, message: found.reason };

    const baseline = await readSourceBaseline(this.deps.files, entry.sourceRoot, this.deps.sha256, this.deps.clock);
    if (!baseline.ok) {
      return { status: 'unavailable', direction: request.direction, message: '当前资料不可读或不合法，无法预览' };
    }
    const current: CommandCurrent = {
      planVersion: baseline.baseline.planVersion,
      planRevision: aggregate.revisions.plan,
      sourceEpoch: entry.sourceGeneration,
    };
    const conflicts = this.inverseSafety(found.inverse, request.direction, baseline.doc, aggregate, entry.sourceGeneration);
    if (conflicts.length > 0) {
      return { status: 'conflict', direction: request.direction, message: '当前存在不允许逆向的变化', conflicts, current };
    }
    const inverse = found.inverse;
    return {
      status: 'available',
      previewDigest: this.inversePreviewDigest(request, inverse, current),
      direction: request.direction,
      target: {
        operationId: found.record.operationId,
        commandType: inverse.commandType,
        sourceEpoch: inverse.sourceEpoch,
        createdAt: found.record.createdAt,
        afterPlanVersion: inverse.afterPlanVersion,
      },
      inverse: {
        affectedNodeIds: [...inverse.affectedNodeIds],
        fieldCount: inverse.fieldChanges.length,
        generatedNodeCount: inverse.generatedNodes.length,
        removedNodeCount: inverse.removedNodes.length,
        dependencyChangeCount: inverse.dependencyChanges.length,
        ...(inverse.replacement === undefined ? {} : { replacement: inverse.replacement }),
      },
      current,
    };
  }

  /** 历史查询：列出带逆向信息的已提交 owner 规划操作及其当前可用性。 */
  async undoHistory(ctx: TrustedContext | undefined, request: { instanceId: string }): Promise<UndoHistoryResult> {
    const authorized = checkTrustedContext(ctx);
    if (!authorized.ok) return { status: 'rejected', code: authorized.code, message: authorized.message };
    const quarantine = await this.deps.store.readQuarantine(this.deps.localRoot, request.instanceId);
    if (quarantine !== null) {
      return { status: 'rejected', code: 'unknown-state', message: `实例已隔离（${quarantine.reason}）` };
    }
    const registry = await this.deps.store.readRegistry(this.deps.localRoot);
    const entry = registry.instances.find((item) => item.instanceId === request.instanceId);
    if (entry === undefined) return { status: 'rejected', code: 'binding-expired', message: '本机注册表中没有该实例' };
    const aggregate = await this.deps.store.readAggregate(this.deps.localRoot, request.instanceId);
    if (aggregate === null) return { status: 'rejected', code: 'binding-expired', message: '实例聚合缺失' };
    const baseline = await readSourceBaseline(this.deps.files, entry.sourceRoot, this.deps.sha256, this.deps.clock);
    if (!baseline.ok) return { status: 'rejected', code: 'invalid-project', message: '当前资料不可读或不合法' };
    const origin = originOf(ctx as TrustedContext);
    const entries: UndoHistoryEntry[] = [];
    for (const record of aggregate.operations) {
      const inverse = validatePlanInverse(record.inverse);
      if (inverse === null || record.status !== 'committed' || !sameOrigin(record.origin, origin)) continue;
      const undoConflicts = this.inverseSafety(inverse, 'undo', baseline.doc, aggregate, entry.sourceGeneration);
      const redoConflicts = this.inverseSafety(inverse, 'redo', baseline.doc, aggregate, entry.sourceGeneration);
      entries.push({
        operationId: record.operationId,
        commandType: inverse.commandType,
        createdAt: record.createdAt,
        sourceEpoch: inverse.sourceEpoch,
        beforePlanVersion: inverse.beforePlanVersion,
        afterPlanVersion: inverse.afterPlanVersion,
        affectedNodeIds: [...inverse.affectedNodeIds],
        canUndo: undoConflicts.length === 0,
        canRedo: redoConflicts.length === 0,
        ...(undoConflicts.length > 0 || redoConflicts.length > 0
          ? { reason: [...undoConflicts, ...redoConflicts].map((item) => item.code).join(',') }
          : {}),
      });
    }
    return { status: 'committed', instanceId: request.instanceId, entries };
  }

  /**
   * 执行一条命令。同实例串行；失败不占用后续命令。
   * 只有资料与私有聚合都明确成功才返回 `committed`。
   */
  async execute(ctx: TrustedContext | undefined, envelope: CommandEnvelope): Promise<CommandResult> {
    const authorized = authorizeTrustedContext(ctx, envelope);
    if (!authorized.ok) {
      return { status: 'rejected', code: authorized.code, message: authorized.message };
    }
    // agent-work 入口的第二层准入（tasks 6.2）：活动 WorkRun、绑定版本、目标／动作范围与基线。
    // remote-owner 路径不走工作绑定；两条入口判据独立，不共用一个“有绑定即放行”。
    if (ctx !== undefined && ctx.kind === 'agent-work') {
      if (WORK_RUN_STRUCTURAL_COMMANDS.has(envelope.command?.type) && this.deps.work === undefined) {
        return {
          status: 'rejected',
          code: 'forbidden',
          message: '结构命令只经可信 WorkRun 准入；宿主未提供工作绑定端口，拒绝降级放行',
        };
      }
      if (this.deps.work !== undefined) {
        const admitted = await this.deps.work.authorizeAgentCommand(ctx, envelope);
        if (!admitted.ok) {
          return { status: 'rejected', code: admitted.code, message: admitted.message };
        }
      }
    }
    const shape = this.checkEnvelope(envelope);
    if (shape !== null) return shape;
    return this.queue.run(envelope.instanceId, () => this.commit(ctx as TrustedContext, envelope));
  }

  /** 查询原回执：先于任何新写；归属不同者不能读取。 */
  async getReceipt(
    ctx: TrustedContext | undefined,
    request: { instanceId: string; operationId: string },
  ): Promise<ReceiptResult> {
    const authorized = checkTrustedContext(ctx);
    if (!authorized.ok) return { status: 'rejected', code: authorized.code, message: authorized.message };
    const quarantine = await this.deps.store.readQuarantine(this.deps.localRoot, request.instanceId);
    if (quarantine !== null) {
      return {
        status: 'rejected',
        code: 'unknown-state',
        message: `该实例已隔离（${quarantine.reason}）；只提供只读诊断，不提供回执读取`,
      };
    }
    let aggregate: InstanceAggregate | null;
    try {
      aggregate = await this.deps.store.readAggregate(this.deps.localRoot, request.instanceId);
    } catch (error) {
      await this.isolate(request.instanceId, 'aggregate-unreadable', 'read-receipt', undefined, (error as Error).message);
      return { status: 'rejected', code: 'unknown-state', message: '本机聚合不可读；实例已隔离，只提供只读诊断' };
    }
    if (aggregate === null) return { status: 'not-found' };
    const record = aggregate.operations.find((item) => item.operationId === request.operationId);
    if (record === undefined) return { status: 'not-found' };
    const origin = originOf(ctx as TrustedContext);
    if (!sameOrigin(record.origin, origin)) {
      return { status: 'rejected', code: 'forbidden', message: '该回执属于其他调用归属，不提供正文或结果' };
    }
    return this.replay(record, record.requestDigest, origin);
  }

  /**
   * 显式恢复核对（tasks 4.4）：只核对磁盘与意图，不重放业务命令。
   * 必须在实例队列内执行，保证与正常提交串行。
   */
  async recover(
    ctx: TrustedContext | undefined,
    request: { instanceId: string; operationId: string },
  ): Promise<RecoveryResult> {
    const authorized = checkTrustedContext(ctx);
    if (!authorized.ok) return { status: 'rejected', code: authorized.code, message: authorized.message };
    const quarantine = await this.deps.store.readQuarantine(this.deps.localRoot, request.instanceId);
    if (quarantine !== null) {
      return {
        status: 'rejected',
        code: 'unknown-state',
        message: `该实例已隔离（${quarantine.reason}，阶段 ${quarantine.stage}）；先离线核对并解除隔离后再恢复`,
      };
    }
    return this.queue.run(request.instanceId, async () => {
      const root = this.deps.localRoot;
      const registry = await this.deps.store.readRegistry(root);
      const entry = registry.instances.find((item) => item.instanceId === request.instanceId);
      if (entry === undefined) return { status: 'not-found' };
      let aggregate: InstanceAggregate | null;
      try {
        aggregate = await this.deps.store.readAggregate(root, request.instanceId);
      } catch (error) {
        await this.isolate(request.instanceId, 'aggregate-unreadable', 'read-recover', undefined, (error as Error).message);
        return { status: 'rejected', code: 'unknown-state', message: '本机聚合不可读；实例已隔离' };
      }
      if (aggregate === null) return { status: 'not-found' };
      const record = aggregate.operations.find((item) => item.operationId === request.operationId);
      if (record === undefined) return { status: 'not-found' };
      const origin = originOf(ctx as TrustedContext);
      if (!sameOrigin(record.origin, origin)) {
        return { status: 'rejected', code: 'forbidden', message: '该操作属于其他调用归属，不提供恢复或结果' };
      }

      const replayed = this.replay(record, record.requestDigest, origin);
      if (record.status === 'committed' || record.status === 'rejected') {
        return { ...replayed, recovery: 'history' } as RecoveryResult;
      }

      if (record.status === 'prepared') {
        // 仍在 prepared：可证明未进入发布阶段。标记终止，保留 operationId，不隐式重放。
        const rejected: RejectedCommand = {
          status: 'rejected',
          code: 'not-published',
          message: '该操作停在 prepared，未进入发布；已标记为未发布。如需重做请使用明确的新命令',
        };
        await this.finishRejected(root, aggregate, record.operationId, rejected);
        return { ...rejected, recovery: 'not-published' };
      }

      // publishing：逐项比对当前磁盘与候选，不猜“已提交”或“未提交”。
      const prepared = record.prepared;
      if (prepared === undefined) {
        return {
          status: 'pending-reconciliation',
          operationId: record.operationId,
          stage: 'missing-candidate',
          message: '操作处于 publishing 但缺少候选记录；无法核对，保持待核对',
        };
      }
      const current = await readSourceBaseline(this.deps.files, entry.sourceRoot, this.deps.sha256, this.deps.clock);
      if (!current.ok) {
        return {
          status: 'pending-reconciliation',
          operationId: record.operationId,
          stage: 'invalid-project',
          message: '恢复时资料不可读或不合法；保留待核对并停止该源写入',
        };
      }
      const headMatched = current.baseline.headHash === prepared.candidateHeadHash;
      const bodiesMatched = prepared.bodies.every((body) =>
        current.baseline.records.some((item) => item.path === body.path && item.observedHash === body.contentHash),
      );
      if (headMatched && bodiesMatched) {
        const mergedRevisions = {
          plan: Math.max(aggregate.revisions.plan, prepared.planRevision),
          state: Math.max(aggregate.revisions.state, prepared.stateRevision),
        };
        const receipt: OperationRecord = {
          ...record,
          status: 'committed',
          updatedAt: this.deps.clock(),
          result: prepared.result,
          recovered: true,
        };
        const next: InstanceAggregate = {
          ...aggregate,
          revisions: mergedRevisions,
          lastObservation: {
            planVersion: current.baseline.planVersion,
            headHash: current.baseline.headHash,
            records: current.baseline.records.map((item) => ({
              path: item.path,
              contentHash: item.contentHash,
              observedHash: item.observedHash,
            })),
            observedAt: this.deps.clock(),
          },
          operations: aggregate.operations.map((item) =>
            item.operationId === record.operationId ? receipt : item,
          ),
        };
        const saved = await this.deps.store.replaceAggregateChecked(root, next, this.deps.hooks?.state);
        if (saved.status === 'not-saved') {
          return {
            status: 'pending-reconciliation',
            operationId: record.operationId,
            stage: 'receipt',
            message: `候选已匹配但回执未保存（${saved.stage}）；保留原操作 id 再核对`,
          };
        }
        if (saved.status === 'unknown-state') {
          await this.isolate(request.instanceId, 'unknown-state', 'recover', record.operationId, saved.detail);
          return {
            status: 'pending-reconciliation',
            operationId: record.operationId,
            stage: 'local-state',
            message: '候选已匹配，但本机聚合写入结果未知；实例已隔离，先离线核对再解除',
          };
        }
        return {
          status: 'committed',
          operationId: record.operationId,
          ...prepared.result,
          planRevision: mergedRevisions.plan,
          stateRevision: mergedRevisions.state,
          replayed: true,
          recovery: 'candidate-matched',
        };
      }

      const reverted = current.baseline.headHash === prepared.originalHeadHash;
      return {
        status: 'pending-reconciliation',
        operationId: record.operationId,
        stage: reverted ? 'reverted' : 'diverged',
        message: reverted
          ? '当前资料等于原基线，无法排除“发布后被回退”；保持待核对，不宣称未提交'
          : '当前资料既不匹配候选也不等于原基线（部分匹配或分叉）；保持待核对，不自动覆盖',
      };
    });
  }

  /** 写隔离标记（best-effort）：即使标记写不进去，调用方仍会停止后续操作。 */
  private async isolate(
    instanceId: string,
    reason: QuarantineInfo['reason'],
    stage: string,
    operationId?: string,
    detail?: string,
  ): Promise<void> {
    try {
      await this.deps.store.quarantine(this.deps.localRoot, {
        schemaVersion: 1,
        instanceId,
        reason,
        stage,
        createdAt: this.deps.clock(),
        requires: 'offline-review',
        ...(operationId === undefined ? {} : { operationId }),
        ...(detail === undefined ? {} : { detail }),
      });
    } catch {
      // 标记失败不改变“停止读写”的结论；由调用方返回待核对。
    }
  }

  /**
   * 只读诊断（tasks 4.5）：列出隔离状态、未决操作、当前磁盘基线与候选比对。
   * 不写任何文件；聚合不可读时仍返回隔离原因与诊断建议。
   */
  async diagnostics(instanceId: string): Promise<DiagnosticsReport> {
    const root = this.deps.localRoot;
    const issues: { code: string; message: string }[] = [];
    const quarantined = await this.deps.store.readQuarantine(root, instanceId);

    let aggregate: InstanceAggregate | null = null;
    try {
      aggregate = await this.deps.store.readAggregate(root, instanceId);
    } catch (error) {
      issues.push({
        code: (error as { code?: string }).code ?? 'local-aggregate-unreadable',
        message: (error as Error).message,
      });
    }

    const registry = await this.deps.store.readRegistry(root);
    const entry = registry.instances.find((item) => item.instanceId === instanceId);
    let current: DiagnosticsReport['current'] = null;
    let currentRecords: { path: string; contentHash: string; observedHash: string }[] = [];
    if (entry === undefined) {
      issues.push({ code: 'registry-instance-not-found', message: '本机注册表中没有该实例' });
    } else {
      const baseline = await readSourceBaseline(this.deps.files, entry.sourceRoot, this.deps.sha256, this.deps.clock);
      if (baseline.ok) {
        current = {
          planVersion: baseline.baseline.planVersion,
          headHash: baseline.baseline.headHash,
          recordCount: baseline.baseline.records.length,
        };
        currentRecords = baseline.baseline.records.map((item) => ({
          path: item.path,
          contentHash: item.contentHash,
          observedHash: item.observedHash,
        }));
      } else {
        issues.push(...baseline.issues.map((issue) => ({ code: issue.code, message: issue.message })));
      }
    }

    const operations = (aggregate?.operations ?? []).map((item) => ({
      operationId: item.operationId,
      status: item.status,
      createdAt: item.createdAt,
      ...(item.prepared === undefined
        ? {}
        : { candidateHeadHash: item.prepared.candidateHeadHash, candidateHead: item.prepared.candidateHead }),
    }));

    const comparisons = (aggregate?.operations ?? [])
      .filter((item) => item.status === 'publishing' && item.prepared !== undefined)
      .map((item) => {
        const prepared = item.prepared as NonNullable<OperationRecord['prepared']>;
        const headMatched = current !== null && current.headHash === prepared.candidateHeadHash;
        const reverted = current !== null && current.headHash === prepared.originalHeadHash;
        const bodiesMatched =
          current !== null &&
          prepared.bodies.every((body) =>
            currentRecords.some((record) => record.path === body.path && record.observedHash === body.contentHash),
          );
        return { operationId: item.operationId, headMatched, bodiesMatched, reverted, diverged: !headMatched && !reverted };
      });

    const guidance = [
      quarantined === null
        ? '实例未隔离；如存在未决操作，先运行 recover 核对，不要直接重发业务命令。'
        : `实例已隔离（${quarantined.reason}）：停止所有命令与回执读取。人工核对资料根与本机数据后，用 local unisolate --confirm offline-reviewed 解除。`,
      '核对顺序：看本报告的 current.headHash 与 comparisons；必要时对比 Git 历史确认资料是否被回退。',
      '隔离解除后先用 recover 核对未决操作；匹配候选会补回执，不匹配会保持待核对。',
    ];

    return { instanceId, quarantined, operations, current, comparisons, issues, guidance };
  }

  private checkEnvelope(envelope: CommandEnvelope): CommandResult | null {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    if (!uuid.test(envelope.operationId)) {
      return { status: 'rejected', code: 'operation-mismatch', message: 'operationId 必须是 UUID v4' };
    }
    if (!uuid.test(envelope.instanceId) || !uuid.test(envelope.projectId)) {
      return { status: 'rejected', code: 'operation-mismatch', message: '项目或实例 id 形态非法' };
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(envelope.expectedPlanVersion)) {
      return { status: 'rejected', code: 'operation-mismatch', message: 'expectedPlanVersion 形态非法' };
    }
    if (!Number.isSafeInteger(envelope.expectedPlanRevision) || envelope.expectedPlanRevision < 0) {
      return { status: 'rejected', code: 'operation-mismatch', message: 'expectedPlanRevision 必须是非负整数' };
    }
    if (!Number.isSafeInteger(envelope.sourceEpoch) || envelope.sourceEpoch < 1) {
      return { status: 'rejected', code: 'operation-mismatch', message: 'sourceEpoch 必须是正整数' };
    }
    if (envelope.command === undefined || typeof envelope.command.type !== 'string') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少命令内容' };
    }
    if (envelope.command.type === 'enable-roadmap'
      && !/^sha256:[0-9a-f]{64}$/.test(String(envelope.command.previewDigest))) {
      return { status: 'rejected', code: 'operation-mismatch', message: '启用扩展需要预览返回的确认摘要' };
    }
    return null;
  }

  /** 重放：同摘要同归属返回原结果；不同摘要或归属拒绝；未决保持待核对。 */
  private replay(record: OperationRecord, digest: string, origin: OperationOrigin): CommandResult {
    if (record.requestDigest !== digest) {
      return {
        status: 'rejected',
        code: 'operation-mismatch',
        message: '同一 operationId 的请求参数或输入基线已不同；拒绝按新命令执行',
      };
    }
    if (!sameOrigin(record.origin, origin)) {
      return { status: 'rejected', code: 'forbidden', message: '该操作属于其他调用归属' };
    }
    if (record.status === 'committed' && record.result !== undefined) {
      return { status: 'committed', operationId: record.operationId, ...record.result, replayed: true };
    }
    if (record.status === 'rejected' && record.rejection !== undefined) {
      return { status: 'rejected', code: record.rejection.code, message: record.rejection.message, replayed: true };
    }
    return {
      status: 'pending-reconciliation',
      operationId: record.operationId,
      stage: record.status,
      message: `该操作处于 ${record.status} 阶段、尚未完成；先核对实际资料再按恢复流程处理，不按新命令重跑`,
    };
  }

  private async commit(ctx: TrustedContext, envelope: CommandEnvelope): Promise<CommandResult> {
    const root = this.deps.localRoot;
    const quarantine = await this.deps.store.readQuarantine(root, envelope.instanceId);
    if (quarantine !== null) {
      return {
        status: 'rejected',
        code: 'unknown-state',
        message: `该实例已隔离（${quarantine.reason}，阶段 ${quarantine.stage}${
          quarantine.operationId === undefined ? '' : `，保留操作 ${quarantine.operationId}`
        }）；先离线核对再用 local unisolate 解除`,
      };
    }
    const registry = await this.deps.store.readRegistry(root);
    const entry = registry.instances.find((item) => item.instanceId === envelope.instanceId);
    if (entry === undefined) {
      return { status: 'rejected', code: 'binding-expired', message: '本机注册表中没有该实例' };
    }
    if (entry.projectId !== envelope.projectId) {
      return { status: 'rejected', code: 'forbidden', message: '命令的项目 id 与已登记实例不一致' };
    }
    if (entry.sourceGeneration !== envelope.sourceEpoch) {
      return {
        status: 'rejected',
        code: 'source-changed',
        message: `资料源代际已变为 ${entry.sourceGeneration}，命令基线为 ${envelope.sourceEpoch}`,
      };
    }
    let aggregate: InstanceAggregate | null;
    try {
      aggregate = await this.deps.store.readAggregate(root, envelope.instanceId);
    } catch (error) {
      await this.isolate(envelope.instanceId, 'aggregate-unreadable', 'read', undefined, (error as Error).message);
      return {
        status: 'rejected',
        code: 'unknown-state',
        message: '本机聚合不可读；实例已隔离，先用 local diagnostics 核对',
      };
    }
    if (aggregate === null) {
      return { status: 'rejected', code: 'binding-expired', message: '实例聚合缺失；不自动重建' };
    }

    // 幂等查询先于任何新写与规划冲突判断；读取资格已在 execute 校验。
    const origin = originOf(ctx);
    const digest = this.requestDigest(envelope);
    const existing = aggregate.operations.find((item) => item.operationId === envelope.operationId);
    if (existing !== undefined) return this.replay(existing, digest, origin);

    // 同一实例最多一个未决发布意图；未决时阻止后续写入（先核对，不自动续写）。
    const blocked = aggregate.operations.find(
      (item) => item.status === 'prepared' || item.status === 'publishing',
    );
    if (blocked !== undefined) {
      return {
        status: 'pending-reconciliation',
        operationId: blocked.operationId,
        stage: 'instance-blocked',
        message: `该实例存在未决操作 ${blocked.operationId}（${blocked.status}）；先核对实际资料，不接受新命令`,
      };
    }

    if (aggregate.revisions.plan !== envelope.expectedPlanRevision) {
      return {
        status: 'rejected',
        code: 'plan-conflict',
        message: `规划修订已变为 ${aggregate.revisions.plan}，命令基线为 ${envelope.expectedPlanRevision}`,
        current: {
          planVersion: aggregate.lastObservation?.planVersion ?? '(unknown)',
          planRevision: aggregate.revisions.plan,
          sourceEpoch: entry.sourceGeneration,
        },
      };
    }

    // 提交前重读权威资料：不使用内存残留，也不信任命令自报的规划内容。
    const baseline = await readSourceBaseline(this.deps.files, entry.sourceRoot, this.deps.sha256, this.deps.clock);
    if (!baseline.ok) {
      const formatIssue = baseline.issues.some((issue) =>
        ['invalid-schema-version', 'unknown-field', 'invalid-json'].includes(issue.code),
      );
      return {
        status: 'rejected',
        code: formatIssue ? 'unsupported-format' : 'invalid-project',
        message: '提交前重读资料失败，停止该源写入',
        issues: baseline.issues.map((issue) => ({ code: issue.code, path: issue.path ?? '', message: issue.message })),
      };
    }
    if (baseline.baseline.projectId !== envelope.projectId) {
      return { status: 'rejected', code: 'forbidden', message: '磁盘资料的项目 id 与命令不一致' };
    }
    if (baseline.baseline.planVersion !== envelope.expectedPlanVersion) {
      return {
        status: 'rejected',
        code: 'plan-conflict',
        message: '规划的 planVersion 已变化（外部修改或另一写者提交）',
        current: {
          planVersion: baseline.baseline.planVersion,
          planRevision: aggregate.revisions.plan,
          sourceEpoch: entry.sourceGeneration,
        },
      };
    }

    // 4.2 启用扩展规划：版本与确认摘要都在发布前核对；已启用时不重复发布。
    if (envelope.command.type === 'enable-roadmap') {
      if (baseline.doc.schemaVersion === 2) {
        return { status: 'rejected', code: 'roadmap-already-enabled', message: '该规划已启用扩展（schemaVersion 2）' };
      }
      const expectedDigest = roadmapEnableDigest(
        {
          schemaVersion: baseline.doc.schemaVersion,
          planVersion: baseline.baseline.planVersion,
          headHash: baseline.baseline.headHash,
        },
        this.deps.sha256,
      );
      if (envelope.command.previewDigest !== expectedDigest) {
        return {
          status: 'rejected',
          code: 'preview-mismatch',
          message: '确认预览已过期：资料字节或规划版本在预览后发生变化；重新预览后再提交',
          current: {
            planVersion: baseline.baseline.planVersion,
            planRevision: aggregate.revisions.plan,
            sourceEpoch: entry.sourceGeneration,
          },
        };
      }
    }

    // 4.3 里程碑：只有“新增或改变”的交付必须可解析；既有失效引用按待核对保留。
    if (envelope.command.type === 'set-milestone') {
      if (baseline.doc.schemaVersion !== 2) {
        return { status: 'rejected', code: 'roadmap-not-enabled', message: '该规划未启用扩展（schemaVersion 1）；先显式启用 v2' };
      }
      const nodeId = envelope.command.nodeId;
      const node = baseline.doc.plan.nodes.find((item) => item.id === nodeId);
      if (node === undefined) {
        return { status: 'rejected', code: 'milestone-node-missing', message: `里程碑节点 ${String(nodeId)} 不在当前树中` };
      }
      if (node.status === 'done') {
        return {
          status: 'rejected', code: 'milestone-reopen-required',
          message: '该节点已完成；先重新打开并补验，再调整里程碑交付',
        };
      }
      const previous = baseline.doc.plan.roadmap?.milestones.find((item) => item.nodeId === nodeId);
      for (const delivery of envelope.command.deliveries) {
        if (delivery.kind !== 'node' && delivery.kind !== 'record') {
          return { status: 'rejected', code: 'invalid-delivery-kind', message: "交付项 kind 必须是 'node' 或 'record'" };
        }
        const resolved = resolveDelivery(baseline.doc.plan, baseline.doc.records, delivery);
        if (resolved.resolved) continue;
        const existing = previous?.deliveries.some((item) => sameDelivery(item, delivery)) ?? false;
        if (!existing) {
          return { status: 'rejected', code: resolved.code, message: resolved.message };
        }
      }
    }

    // 4.3 正式完成：里程碑、逐项条件、证据状态、主体与受检版本在发布前一次核对。
    if (envelope.command.type === 'complete-milestone') {
      const command = envelope.command;
      if (baseline.doc.schemaVersion !== 2) {
        return { status: 'rejected', code: 'roadmap-not-enabled', message: '该规划未启用扩展（schemaVersion 1）' };
      }
      const milestone = milestoneOf(baseline.doc.plan, command.nodeId);
      const node = baseline.doc.plan.nodes.find((item) => item.id === command.nodeId);
      if (milestone === null || node === undefined) {
        return { status: 'rejected', code: 'milestone-not-found', message: `节点 ${String(command.nodeId)} 没有里程碑条目` };
      }
      if (node.status === 'done') {
        return { status: 'rejected', code: 'milestone-already-complete', message: '该里程碑已完成；改变条件或交付需先重新打开' };
      }
      if (node.completionCriteria.length === 0) {
        return { status: 'rejected', code: 'milestone-criteria-empty', message: '里程碑没有完成条件；先补充条件再完成' };
      }
      if (!Array.isArray(command.evidence) || command.evidence.length !== node.completionCriteria.length) {
        return {
          status: 'rejected', code: 'milestone-evidence-mismatch',
          message: `证据必须逐项覆盖 ${node.completionCriteria.length} 条完成条件`,
        };
      }
      for (const [index, item] of command.evidence.entries()) {
        const criterion = node.completionCriteria[index];
        if (item.criterionIndex !== index || item.criterionText !== criterion) {
          return {
            status: 'rejected', code: 'milestone-evidence-mismatch',
            message: `第 ${index} 项证据的条件索引或原文与当前规划不一致（当前：${String(criterion)}）`,
          };
        }
        const record = baseline.doc.records.find((entry) => entry.id === item.recordId);
        if (record === undefined) {
          return { status: 'rejected', code: 'milestone-evidence-unavailable', message: `证据记录 ${item.recordId} 不在索引中` };
        }
        if (record.kind !== 'verification' || record.contentHash !== item.contentHash) {
          return { status: 'rejected', code: 'milestone-evidence-unavailable', message: `证据记录 ${item.recordId} 不是验证记录或正文哈希不符` };
        }
        const verification = record.verification;
        if (verification === undefined || verification.status !== 'pass'
          || verification.subject.kind !== 'node' || verification.subject.id !== command.nodeId) {
          return {
            status: 'rejected', code: 'milestone-evidence-not-pass',
            message: `证据记录 ${item.recordId} 必须是以该节点为主题、结论为 pass 的验证记录`,
          };
        }
        if (verification.subjectVersion !== baseline.doc.planVersion) {
          return {
            status: 'rejected', code: 'milestone-evidence-stale',
            message: `证据记录 ${item.recordId} 的受检版本 ${String(verification.subjectVersion)} 不是当前规划 ${baseline.doc.planVersion}`,
          };
        }
        if (verification.scope === undefined || verification.scope.trim() === '') {
          return { status: 'rejected', code: 'milestone-evidence-scope-missing', message: `证据记录 ${item.recordId} 缺少可查阅的受检范围` };
        }
      }
    }

    // 结构命令：按 ID 与版本精确解析随包预设并核对正文语言。解析失败返回稳定码，
    // 不写文件也不推进修订。解析只在首次提交发生；重试／恢复用已持久化的候选与回执。
    let resolvedPreset: PresetDescriptor | undefined;
    if (envelope.command.type === 'insert-preset') {
      const request = envelope.command;
      const resolved = this.presetCatalog.resolve(request.templateId, request.templateVersion);
      if (!resolved.ok) {
        return { status: 'rejected', code: resolved.code, message: resolved.message };
      }
      if (!resolved.preset.contentLocales.includes(request.contentLocale)) {
        return {
          status: 'rejected',
          code: 'template-locale-unsupported',
          message: `预设 ${request.templateId} 不支持正文语言 ${String(request.contentLocale)}`,
        };
      }
      resolvedPreset = resolved.preset;
    }

    // 插入用户模板：提交时重读当前发布索引与正文，精确核对 templateId + versionRecordId + contentHash。
    // 解析只在首次提交发生；同号重试与恢复用已持久化的候选与回执，不重新解析模板。
    let resolvedUserTemplate: UserTemplateBody | undefined;
    if (envelope.command.type === 'insert-user-template') {
      const request = envelope.command;
      const record = baseline.doc.records.find((item) => item.id === request.versionRecordId);
      if (record === undefined || record.kind !== 'plan-change'
        || !record.summary.startsWith(USER_TEMPLATE_SUMMARY_PREFIX)) {
        return {
          status: 'rejected', code: 'template-version-unavailable',
          message: '模板版本不存在或已移出索引',
        };
      }
      if (record.contentHash !== request.contentHash) {
        return {
          status: 'rejected', code: 'template-version-mismatch',
          message: '模板记录的内容哈希与请求不一致',
        };
      }
      const bodyResult = await this.deps.files.readScopedFile(entry.sourceRoot, record.path);
      if (!bodyResult.ok) {
        return {
          status: 'rejected', code: 'template-version-unavailable', message: '模板正文不可读',
        };
      }
      const actualHash = 'sha256:' + this.deps.sha256(bodyResult.bytes);
      if (actualHash !== request.contentHash) {
        return {
          status: 'rejected', code: 'template-version-mismatch', message: '模板正文哈希与索引不一致',
        };
      }
      const parsed = parseUserTemplateText(new TextDecoder().decode(bodyResult.bytes));
      if (!parsed.ok) {
        return {
          status: 'rejected', code: 'template-invalid',
          message: parsed.issues[0]?.message ?? '模板正文描述无效',
        };
      }
      if (parsed.body.templateId !== request.templateId) {
        return {
          status: 'rejected', code: 'template-version-mismatch', message: '模板身份与请求不一致',
        };
      }
      resolvedUserTemplate = parsed.body;
    }

    // 逆向命令：从已核对的私有历史与当前基线重算候选。确认指纹与安全条件都在发布前核对。
    let inverseContext: InverseContext | undefined;
    const inverseCommand = inverseCommandOf(envelope.command);
    if (inverseCommand !== null) {
      const current: CommandCurrent = {
        planVersion: baseline.baseline.planVersion,
        planRevision: aggregate.revisions.plan,
        sourceEpoch: entry.sourceGeneration,
      };
      const found = this.inverseOfRecord(
        aggregate.operations.find((item) => item.operationId === inverseCommand.targetOperationId), origin,
      );
      if (!found.ok) {
        return { status: 'rejected', code: 'inverse-unavailable', message: found.reason };
      }
      if (inverseCommand.previewDigest !== this.inversePreviewDigest(inverseCommand, found.inverse, current)) {
        return {
          status: 'rejected', code: 'preview-mismatch',
          message: '确认预览已过期：目标逆向信息或当前基线在预览后发生变化；重新预览后再提交',
          current,
        };
      }
      const conflicts = this.inverseSafety(found.inverse, inverseCommand.direction, baseline.doc, aggregate, entry.sourceGeneration);
      if (conflicts.length > 0) {
        return {
          status: 'rejected', code: conflicts[0]?.code ?? 'inverse-conflict',
          message: conflicts[0]?.message ?? '当前状态不允许逆向', issues: conflicts.map((item) => ({
            code: item.code, path: '', message: item.message,
          })),
          current,
        };
      }
      inverseContext = {
        direction: inverseCommand.direction,
        targetOperationId: inverseCommand.targetOperationId,
        inverse: found.inverse,
        previewDigest: inverseCommand.previewDigest,
      };
    }

    // 稳定生成 id：先落意图，重启或核对时复用同一批 id，不重复创建。
    const generated = this.allocateIds(envelope.command, baseline.doc, resolvedPreset, inverseContext, resolvedUserTemplate);
    const candidate = this.buildCandidate(
      envelope.command, baseline.doc, baseline.baseline.records, generated, resolvedPreset, inverseContext, resolvedUserTemplate,
    );
    if ('rejected' in candidate) return candidate.rejected;

    // 用户模板保存是记录追加（只推进状态修订、需写回资料头更新记录索引），不是规划变换。
    const planning = envelope.command.type !== 'append-record' && envelope.command.type !== 'save-user-template';
    const noBusinessChange = planning && candidate.doc.planVersion === baseline.baseline.planVersion;
    const impact: 'plan' | 'state' = noBusinessChange ? 'state' : planning ? 'plan' : 'state';
    const planRevision = impact === 'plan' ? aggregate.revisions.plan + 1 : aggregate.revisions.plan;
    const stateRevision = aggregate.revisions.state + 1;
    const rendered = this.deps.files.renderHead(candidate.doc);
    const result: OperationResultSnapshot = {
      impact,
      planVersion: candidate.doc.planVersion,
      planRevision,
      stateRevision,
      sourceEpoch: entry.sourceGeneration,
      ...(candidate.recordId === undefined ? {} : { recordId: candidate.recordId }),
      ...(candidate.recordPath === undefined ? {} : { recordPath: candidate.recordPath }),
    };

    // 逆向信息只写本机聚合：owner 规划编辑与逆向命令都保存前后值与生成身份，随原回执保留。
    let inverse: PlanInverse | undefined;
    const inverseCommandType = envelope.command.type;
    // replacement 只标记原 merge 操作：撤销/重做都以原操作为目标，撤销追加 clear、重做追加新 replace。
    const inverseReplacement: InverseReplacement | undefined =
      inverseContext === undefined && envelope.command.type === 'merge-nodes' && candidate.recordId !== undefined
        ? {
            recordId: candidate.recordId,
            sourceNodeIds: [...envelope.command.sourceNodeIds],
            replacementNodeId: envelope.command.keepNodeId,
          }
        : undefined;
    if (ctx.kind === 'remote-owner' && INVERTIBLE_COMMANDS.has(envelope.command.type)) {
      inverse = buildPlanInverse({
        operationId: envelope.operationId,
        commandType: inverseCommandType,
        sourceEpoch: entry.sourceGeneration,
        before: baseline.doc.plan,
        after: candidate.doc.plan,
        beforePlanVersion: baseline.baseline.planVersion,
        afterPlanVersion: candidate.doc.planVersion,
        ...(inverseReplacement === undefined ? {} : { replacement: inverseReplacement }),
      });
    } else if (ctx.kind === 'remote-owner' && inverseContext !== undefined) {
      // 逆向命令本身也保存逆向信息：撤销后再重做、连续撤销都可从历史核对。
      inverse = buildPlanInverse({
        operationId: envelope.operationId,
        commandType: inverseCommandType,
        sourceEpoch: entry.sourceGeneration,
        before: baseline.doc.plan,
        after: candidate.doc.plan,
        beforePlanVersion: baseline.baseline.planVersion,
        afterPlanVersion: candidate.doc.planVersion,
        ...(inverseReplacement === undefined ? {} : { replacement: inverseReplacement }),
      });
    }
    const now = this.deps.clock();
    const record: OperationRecord = {
      operationId: envelope.operationId,
      requestDigest: digest,
      origin,
      status: 'prepared',
      createdAt: now,
      updatedAt: now,
      baseline: {
        expectedPlanVersion: envelope.expectedPlanVersion,
        expectedPlanRevision: envelope.expectedPlanRevision,
        sourceEpoch: envelope.sourceEpoch,
      },
      generated,
      prepared: {
        candidateHead: rendered.text,
        candidateHeadHash: rendered.headHash,
        originalHeadHash: baseline.baseline.headHash,
        candidatePlanVersion: candidate.doc.planVersion,
        bodies: candidate.bodies,
        impact,
        planRevision,
        stateRevision,
        result,
        writeHead: !noBusinessChange,
      },
      ...(inverse === undefined ? {} : { inverse }),
    };

    // 阶段 1：prepared（候选头与正文清单先持久化；失败则不发布任何内容）。
    let working: InstanceAggregate = { ...aggregate, operations: [...aggregate.operations, record] };
    const preparedSaved = await this.deps.store.replaceAggregateChecked(root, working, this.deps.hooks?.state);
    if (preparedSaved.status !== 'saved') {
      if (preparedSaved.status === 'unknown-state') {
        await this.isolate(envelope.instanceId, 'unknown-state', 'prepared', envelope.operationId, preparedSaved.detail);
        return {
          status: 'pending-reconciliation',
          operationId: envelope.operationId,
          stage: 'prepared',
          message: 'prepared 意图写入结果未知；实例已隔离，先核对本机数据',
        };
      }
      return {
        status: 'rejected',
        code: 'persistence-failed',
        message: `prepared 意图未能持久化（${preparedSaved.stage}）；不开始发布`,
      };
    }

    // 阶段 2：publishing（明确“可能已开始写文件”，恢复时按候选核对）。
    working = this.withRecord(working, envelope.operationId, (item) => ({ ...item, status: 'publishing', updatedAt: this.deps.clock() }));
    const publishingSaved = await this.deps.store.replaceAggregateChecked(root, working, this.deps.hooks?.state);
    if (publishingSaved.status !== 'saved') {
      if (publishingSaved.status === 'unknown-state') {
        await this.isolate(envelope.instanceId, 'unknown-state', 'publishing', envelope.operationId, publishingSaved.detail);
        return {
          status: 'pending-reconciliation',
          operationId: envelope.operationId,
          stage: 'publishing',
          message: 'publishing 阶段写入结果未知；实例已隔离，先核对资料与本机数据',
        };
      }
      const rejected: RejectedCommand = {
        status: 'rejected',
        code: 'persistence-failed',
        message: `publishing 阶段未能持久化（${publishingSaved.stage}）；未写任何文件`,
      };
      await this.finishRejected(root, working, envelope.operationId, rejected);
      return rejected;
    }

    // 阶段 3：先写不可变正文，再发布资料头。
    for (const body of candidate.bodies) {
      const outcome = await this.deps.files.writeBody(
        entry.sourceRoot,
        body.recordId,
        body.contentHash,
        body.bytesData,
        this.deps.hooks?.body,
      );
      if (outcome.status === 'conflict' || outcome.status === 'not-published') {
        const rejected: RejectedCommand = {
          status: 'rejected',
          code: 'persistence-failed',
          message: `正文写入未完成（${outcome.status}）：${outcome.detail ?? ''}`,
        };
        await this.finishRejected(root, working, envelope.operationId, rejected);
        return rejected;
      }
      if (outcome.status === 'unknown') {
        return {
          status: 'pending-reconciliation',
          operationId: envelope.operationId,
          stage: 'body',
          message: '正文写入结果未知；保留原操作 id，先核对资料根',
        };
      }
    }

    let headHash = baseline.baseline.headHash;
    if (record.prepared?.writeHead !== false) {
      const written = await this.deps.files.writeDocument(entry.sourceRoot, candidate.doc, this.deps.hooks?.publish);
      if (!written.ok) {
        if (written.status === 'unknown') {
          // unknown 不能当作未提交：资料可能已替换，保留 publishing 意图待核对。
          return {
            status: 'pending-reconciliation',
            operationId: envelope.operationId,
            stage: 'head',
            message: '资料头发布结果未知；保留原操作 id，先核对资料根与候选内容',
          };
        }
        const rejected: RejectedCommand = {
          status: 'rejected',
          code: 'persistence-failed',
          message: '资料头发布未完成',
          issues: written.issues,
        };
        await this.finishRejected(root, working, envelope.operationId, rejected);
        return rejected;
      }
      headHash = written.headHash;
    }

    // 阶段 4：完成回执与双修订在同一次聚合替换中保存。
    const receipt: OperationRecord = {
      ...(record as OperationRecord),
      status: 'committed',
      updatedAt: this.deps.clock(),
      result,
    };
    const receiptAggregate: InstanceAggregate = {
      ...working,
      revisions: { plan: planRevision, state: stateRevision },
      lastObservation: {
        planVersion: candidate.doc.planVersion,
        headHash,
        records: candidate.records,
        observedAt: this.deps.clock(),
      },
      operations: this.withRecord(working, envelope.operationId, () => receipt).operations,
    };
    const saved = await this.deps.store.replaceAggregateChecked(root, receiptAggregate, this.deps.hooks?.state);
    if (saved.status === 'not-saved') {
      // 资料已发布、回执未落盘：属于待核对，不能返回“可重试的失败”。
      return {
        status: 'pending-reconciliation',
        operationId: envelope.operationId,
        stage: 'receipt',
        message: `资料已发布但本机回执未保存（${saved.stage}）：${saved.detail ?? ''}；保留原操作 id 核对`,
      };
    }
    if (saved.status === 'unknown-state') {
      await this.isolate(envelope.instanceId, 'unknown-state', 'receipt', envelope.operationId, saved.detail);
      return {
        status: 'pending-reconciliation',
        operationId: envelope.operationId,
        stage: 'local-state',
        message: '资料已发布，本机聚合写入结果未知；实例已隔离，先离线核对再解除',
      };
    }

    const committed: CommittedCommand = { status: 'committed', operationId: envelope.operationId, ...result };
    // 通知在提交之后：失败不撤回事实，也不改变返回结果。
    if (this.deps.notify !== undefined) {
      try {
        await this.deps.notify(committed, envelope);
      } catch {
        // 通知失败不回滚、不重复执行。
      }
    }
    // 工作绑定版本推进（tasks 6.2，design §7）：本运行规划命令成功后仅更新已接受基线并 +1，
    // 目标范围与动作集合不自动扩大；bump 失败不撤回提交，旧版本捕获将在下一次调用被拒绝。
    if (ctx.kind === 'agent-work' && this.deps.work !== undefined && result.impact === 'plan') {
      try {
        await this.deps.work.afterPlanCommit(ctx, {
          planVersion: result.planVersion,
          planRevision: result.planRevision,
          sourceEpoch: result.sourceEpoch,
        });
      } catch {
        // 绑定推进失败不影响已提交事实；下一次工具调用按版本核对拒绝并需重新接续。
      }
    }
    return committed;
  }

  private withRecord(
    aggregate: InstanceAggregate,
    operationId: string,
    update: (record: OperationRecord) => OperationRecord,
  ): InstanceAggregate {
    return {
      ...aggregate,
      operations: aggregate.operations.map((item) => (item.operationId === operationId ? update(item) : item)),
    };
  }

  /** 明确拒绝也要留回执：重试同一 operationId 不得重新执行。 */
  private async finishRejected(
    root: string,
    aggregate: InstanceAggregate,
    operationId: string,
    rejected: RejectedCommand,
  ): Promise<void> {
    const now = this.deps.clock();
    const next = this.withRecord(aggregate, operationId, (item) => ({
      ...item,
      status: 'rejected',
      updatedAt: now,
      rejection: { code: rejected.code, message: rejected.message },
    }));
    // 回执写入失败不改变“明确拒绝”的事实：没有发布任何内容，重试仍是安全的。
    await this.deps.store.replaceAggregateChecked(root, next, this.deps.hooks?.state);
  }

  /**
   * 构造候选文档与待写正文（不写文件）。
   * 记录命令在此计算哈希与路径，正文实际写入发生在 publishing 阶段之后。
   */
  private buildCandidate(
    command: Command,
    doc: ProjectDocument,
    baselineRecords: { path: string; contentHash: string; observedHash: string }[],
    generated: { recordId?: string; nodeIds?: string[] },
    resolvedPreset?: PresetDescriptor,
    inverseContext?: InverseContext,
    resolvedUserTemplate?: UserTemplateBody,
  ):
    | {
        doc: ProjectDocument;
        records: typeof baselineRecords;
        bodies: { recordId: string; contentHash: string; path: string; bytes: number; bytesData: Uint8Array }[];
        recordId?: string;
        recordPath?: string;
      }
    | { rejected: RejectedCommand } {
    // 撤销/重做：在当前资料上按方向应用逆向前值/后值；重算指纹并完整校验。
    if (inverseContext !== undefined) {
      return this.buildInverseCandidate(doc, baselineRecords, generated, inverseContext);
    }
    // 保存用户模板：从所选子树构造正文，作为 plan-change 记录发布（只推进状态修订）。
    if (command.type === 'save-user-template') {
      const built = this.buildTemplateBody(doc, command);
      if (!built.ok) return { rejected: { status: 'rejected', code: built.code, message: built.message } };
      const asRecord: AppendRecordCommand = {
        type: 'append-record',
        kind: 'plan-change',
        subjectNodeIds: [],
        summary: `${USER_TEMPLATE_SUMMARY_PREFIX}${built.body.title}（${built.body.nodes.length} 节点）`,
        sources: [],
        body: buildUserTemplateText(built.body),
      };
      return this.buildCandidate(asRecord, doc, baselineRecords, generated, resolvedPreset, inverseContext, resolvedUserTemplate);
    }
    // 4.3 正式完成：节点 done + 完成记录 + 新指纹在同一次发布中落盘（一条记录、一次修订）。
    if (command.type === 'complete-milestone') {
      const recordId = generated.recordId ?? this.deps.newRecordId();
      const nodes = doc.plan.nodes.map((node) =>
        node.id === command.nodeId
          ? { ...node, status: 'done' as const, completionCriteria: [...node.completionCriteria] }
          : { ...node, completionCriteria: [...node.completionCriteria] },
      );
      const draft: ProjectDocument = {
        schemaVersion: doc.schemaVersion,
        project: doc.project,
        plan: { ...doc.plan, nodes },
        planVersion: '',
        records: doc.records,
      };
      draft.planVersion = computePlanVersion(draft, this.deps.sha256).planVersion;
      const body: MilestoneCompletionBody = {
        version: 1,
        milestoneNodeId: command.nodeId,
        inputPlanVersion: doc.planVersion,
        evidence: command.evidence.map((item) => ({ ...item })),
      };
      const bodyText = buildMilestoneCompletionText(body);
      const bytesData = new TextEncoder().encode(bodyText);
      const contentHash = 'sha256:' + this.deps.sha256(bytesData);
      const recordPath = `records/${recordId}/${contentHash.slice('sha256:'.length)}.md`;
      const appended = appendRecordIndex(draft.records, {
        id: recordId,
        kind: 'verification',
        subjectNodeIds: [command.nodeId],
        path: recordPath,
        contentHash,
        summary: `${MILESTONE_COMPLETION_SUMMARY_PREFIX}完成 ${command.nodeId}（${command.evidence.length} 项条件）`,
        sources: [],
        verification: {
          status: 'pass',
          subject: { kind: 'node', id: command.nodeId },
          subjectVersion: draft.planVersion,
          scope: `里程碑完成记录：逐项核对 ${command.evidence.length} 项完成条件`,
        },
      });
      if (!appended.ok) {
        return {
          rejected: { status: 'rejected', code: 'invalid-project', message: '完成记录索引追加失败', issues: appended.issues },
        };
      }
      const validated = validateProjectDocument({ ...draft, records: appended.value }, { sha256: this.deps.sha256 });
      if (!validated.ok) {
        return { rejected: { status: 'rejected', code: 'invalid-project', message: '完成候选未通过领域校验', issues: validated.issues } };
      }
      return {
        doc: validated.doc,
        records: baselineRecords,
        bodies: [{ recordId, contentHash, path: recordPath, bytes: bytesData.length, bytesData }],
        recordId,
        recordPath,
      };
    }
    if (command.type !== 'append-record') {
      // 4.2：启用扩展不经过规划变换，直接由 v1 文档构造空里程碑候选（节点／记录身份不变）。
      if (command.type === 'enable-roadmap') {
        const converted = convertToRoadmap(doc, this.deps.sha256);
        if (!converted.ok) {
          return {
            rejected: { status: 'rejected', code: converted.code, message: converted.message, ...(converted.issues === undefined ? {} : { issues: converted.issues }) },
          };
        }
        return { doc: converted.doc, records: baselineRecords, bodies: [] };
      }
      const applied = applyPlanCommand(
        doc,
        this.materialize(command, generated.nodeIds ?? [], resolvedPreset, resolvedUserTemplate),
        this.deps.sha256,
      );
      if (!applied.ok) {
        // 结构命令把领域拒绝码原样上抛（parent-not-found / invalid-anchor 等），
        // 便于界面逐项提示；其余命令维持既有 invalid-project 诊断。
        const structural =
          command.type === 'move-node' || command.type === 'insert-preset' || command.type === 'group-nodes'
          || command.type === 'merge-nodes' || command.type === 'copy-subtree'
          || command.type === 'insert-user-template'
          || command.type === 'set-milestone' || command.type === 'remove-milestone';
        // 里程碑守卫（4.3）对普通命令也要原样上抛：它来自 update-node／set-node-status 等入口。
        const MILESTONE_CODES = [
          'roadmap-not-enabled', 'milestone-invalid-node', 'milestone-node-missing',
          'milestone-self-delivery', 'duplicate-milestone-delivery', 'invalid-delivery-kind',
          'milestone-not-found', 'milestone-reopen-required', 'milestone-evidence-required',
          'milestone-delivery-node-missing', 'milestone-delivery-record-missing',
          'milestone-delivery-hash-mismatch',
        ];
        const domainCode = applied.issues.find((issue) =>
          (structural && ['parent-not-found', 'invalid-anchor', 'node-not-found', 'root-to-child', 'child-to-root',
            'invalid-parent', 'empty-selection', 'cross-parent-selection', 'root-in-selection',
            'invalid-merge-source', 'duplicate-merge-source', 'unresolved-dependency', 'dependency-not-found',
            'copy-id-count-mismatch',
            'template-invalid', 'template-locale-unsupported', 'duplicate-node-id',
            'invalid-uuid', 'template-id-count-mismatch'].includes(issue.code))
          || MILESTONE_CODES.includes(issue.code),
        );
        return {
          rejected: {
            status: 'rejected',
            code: domainCode?.code ?? 'invalid-project',
            message: domainCode?.message ?? '命令变换未通过领域校验',
            issues: applied.issues,
          },
        };
      }
      // 2.2 合并：规划候选与结构化替代记录在同一权威头发布（plan-change 记录 + 正文）。
      if (command.type === 'merge-nodes') {
        const recordId = generated.recordId ?? this.deps.newRecordId();
        const bodyText = buildReplacementReplaceText({
          version: 1,
          kind: 'replace',
          sourceNodeIds: [...command.sourceNodeIds],
          replacementNodeId: command.keepNodeId,
        });
        const bytesData = new TextEncoder().encode(bodyText);
        const contentHash = 'sha256:' + this.deps.sha256(bytesData);
        const recordPath = `records/${recordId}/${contentHash.slice('sha256:'.length)}.md`;
        const appended = appendRecordIndex(applied.doc.records, {
          id: recordId,
          kind: 'plan-change',
          subjectNodeIds: [command.keepNodeId, ...command.sourceNodeIds],
          path: recordPath,
          contentHash,
          summary: `${REPLACEMENT_SUMMARY_PREFIX}${command.sourceNodeIds.length} 个来源并入 ${command.keepNodeId}`,
          sources: [],
        });
        if (!appended.ok) {
          return {
            rejected: { status: 'rejected', code: 'invalid-project', message: '替代记录索引追加失败', issues: appended.issues },
          };
        }
        const withRecord: ProjectDocument = { ...applied.doc, records: appended.value };
        const validated = validateProjectDocument(withRecord, { sha256: this.deps.sha256 });
        if (!validated.ok) {
          return {
            rejected: { status: 'rejected', code: 'invalid-project', message: '合并候选未通过领域校验', issues: validated.issues },
          };
        }
        return {
          doc: validated.doc,
          records: [...baselineRecords, { path: recordPath, contentHash, observedHash: contentHash }],
          bodies: [{ recordId, contentHash, path: recordPath, bytes: bytesData.length, bytesData }],
          recordId,
          recordPath,
        };
      }
      return { doc: applied.doc, records: baselineRecords, bodies: [] };
    }

    const bytesData = new TextEncoder().encode(command.body);
    const contentHash = 'sha256:' + this.deps.sha256(bytesData);
    const id = generated.recordId ?? this.deps.newRecordId();
    const recordPath = `records/${id}/${contentHash.slice('sha256:'.length)}.md`;
    const appended = appendRecordIndex(doc.records, {
      id,
      kind: command.kind,
      subjectNodeIds: [...command.subjectNodeIds],
      path: recordPath,
      contentHash,
      summary: command.summary,
      sources: command.sources.map((source) => (typeof source === 'string' ? source : { ...source })),
      ...(command.verification === undefined ? {} : { verification: command.verification }),
    });
    if (!appended.ok) {
      return {
        rejected: { status: 'rejected', code: 'invalid-project', message: '记录索引追加失败', issues: appended.issues },
      };
    }
    const validated = validateProjectDocument({ ...doc, records: appended.value }, { sha256: this.deps.sha256 });
    if (!validated.ok) {
      return {
        rejected: { status: 'rejected', code: 'invalid-project', message: '记录未通过领域校验', issues: validated.issues },
      };
    }
    return {
      doc: validated.doc,
      records: [...baselineRecords, { path: recordPath, contentHash, observedHash: contentHash }],
      bodies: [{ recordId: id, contentHash, path: recordPath, bytes: bytesData.length, bytesData }],
      recordId: id,
      recordPath,
    };
  }

  /**
   * 撤销/重做候选：在当前资料上应用逆向或正向变换，重算指纹并校验。
   * 合并的撤销在同一权威头追加 clear 记录；重做产生新的 replace 记录，旧历史保持可查。
   */
  private buildInverseCandidate(
    doc: ProjectDocument,
    baselineRecords: { path: string; contentHash: string; observedHash: string }[],
    generated: { recordId?: string; nodeIds?: string[] },
    context: InverseContext,
  ):
    | {
        doc: ProjectDocument;
        records: typeof baselineRecords;
        bodies: { recordId: string; contentHash: string; path: string; bytes: number; bytesData: Uint8Array }[];
        recordId?: string;
        recordPath?: string;
      }
    | { rejected: RejectedCommand } {
    const applied = applyPlanInverse(doc.plan, context.inverse, context.direction);
    if (!applied.ok) {
      return {
        rejected: {
          status: 'rejected',
          code: applied.issues[0]?.code ?? 'inverse-conflict',
          message: applied.issues[0]?.message ?? '逆向变换未通过领域校验',
          issues: applied.issues,
        },
      };
    }
    // v2 roadmap 不参与结构逆向：撤销/重做保留未被编辑的里程碑扩展；
    // 里程碑条目自身的逆向已由 applyPlanInverse 写回（不带 roadmapChanges 时保持原值）。
    const inversePlan = doc.plan.roadmap === undefined
      ? applied.value
      : { ...applied.value, roadmap: applied.value.roadmap ?? doc.plan.roadmap };

    // 4.5：重做普通状态命令也不能完成里程碑（与直接提交同一判据）。
    if (context.direction === 'redo') {
      const completesMilestone = context.inverse.fieldChanges.some((change) =>
        change.field === 'status'
        && change.after === 'done'
        && (inversePlan.roadmap?.milestones.some((item) => item.nodeId === change.nodeId) ?? false));
      if (completesMilestone) {
        return {
          rejected: {
            status: 'rejected',
            code: 'milestone-evidence-required',
            message: '重做不能完成里程碑；用 complete-milestone 提交逐项证据',
          },
        };
      }
    }
    const draft: ProjectDocument = {
      schemaVersion: doc.schemaVersion,
      project: doc.project,
      plan: inversePlan,
      planVersion: computePlanVersion({ ...doc, plan: inversePlan, planVersion: '' }, this.deps.sha256).planVersion,
      records: doc.records,
    };
    let validated = validateProjectDocument(draft, { sha256: this.deps.sha256 });
    if (!validated.ok) {
      return { rejected: { status: 'rejected', code: 'invalid-project', message: '逆向候选未通过领域校验', issues: validated.issues } };
    }
    if (context.inverse.replacement === undefined) {
      return { doc: validated.doc, records: baselineRecords, bodies: [] };
    }

    // 合并的结构化替代：撤销追加 clear、重做追加新 replace；同一权威头发布，正文内容寻址。
    const recordId = generated.recordId ?? this.deps.newRecordId();
    const replacement = context.inverse.replacement;
    const bodyText = context.direction === 'undo'
      ? buildReplacementClearText({ version: 1, kind: 'clear', clearsRecordId: replacement.recordId })
      : buildReplacementReplaceText({
          version: 1, kind: 'replace',
          sourceNodeIds: [...replacement.sourceNodeIds],
          replacementNodeId: replacement.replacementNodeId,
        });
    const bytesData = new TextEncoder().encode(bodyText);
    const contentHash = 'sha256:' + this.deps.sha256(bytesData);
    const recordPath = `records/${recordId}/${contentHash.slice('sha256:'.length)}.md`;
    const summary = context.direction === 'undo'
      ? `${REPLACEMENT_SUMMARY_PREFIX}解除替代关系 ${replacement.recordId}`
      : `${REPLACEMENT_SUMMARY_PREFIX}重建 ${replacement.sourceNodeIds.length} 个来源到 ${replacement.replacementNodeId}`;
    const appended = appendRecordIndex(validated.doc.records, {
      id: recordId,
      kind: 'plan-change',
      subjectNodeIds: [...new Set([replacement.replacementNodeId, ...replacement.sourceNodeIds])],
      path: recordPath,
      contentHash,
      summary,
      sources: [],
    });
    if (!appended.ok) {
      return { rejected: { status: 'rejected', code: 'invalid-project', message: '逆向替代记录追加失败', issues: appended.issues } };
    }
    validated = validateProjectDocument({ ...validated.doc, records: appended.value }, { sha256: this.deps.sha256 });
    if (!validated.ok) {
      return { rejected: { status: 'rejected', code: 'invalid-project', message: '逆向替代候选未通过领域校验', issues: validated.issues } };
    }
    return {
      doc: validated.doc,
      records: [...baselineRecords, { path: recordPath, contentHash, observedHash: contentHash }],
      bodies: [{ recordId, contentHash, path: recordPath, bytes: bytesData.length, bytesData }],
      recordId,
      recordPath,
    };
  }

  private allocateIds(
    command: Command,
    doc: ProjectDocument,
    preset?: PresetDescriptor,
    inverseContext?: InverseContext,
    body?: UserTemplateBody,
  ): { recordId?: string; nodeIds?: string[] } {
    // 撤销/重做生成节点已在原操作回执的 inverse 中固定身份，不重新分配；
    // 合并的逆向需要一条新的结构化记录（clear 或新 replace），分配一个记录 id。
    if (inverseContext !== undefined) {
      return inverseContext.inverse.replacement === undefined ? {} : { recordId: this.deps.newRecordId() };
    }
    if (command.type === 'append-record') return { recordId: this.deps.newRecordId() };
    if (command.type === 'save-user-template') return { recordId: this.deps.newRecordId() };
    if (command.type === 'complete-milestone') return { recordId: this.deps.newRecordId() };
    if (command.type === 'add-nodes') return { nodeIds: command.nodes.map(() => this.deps.newNodeId()) };
    if (command.type === 'split-node') return { nodeIds: command.children.map(() => this.deps.newNodeId()) };
    // 2.1 分组：组节点身份由应用层分配，成员沿用原 id。
    if (command.type === 'group-nodes') return { nodeIds: [this.deps.newNodeId()] };
    // 2.2 合并：分配替代记录 id（无新节点）；复制：按源子树 DFS 顺序分配新 id。
    if (command.type === 'merge-nodes') return { recordId: this.deps.newRecordId() };
    if (command.type === 'copy-subtree') {
      // 源子树节点数（含自身）：逐层向下数，顺序与 copySubtree 的 DFS 一致。
      let count = 0;
      const level = [command.nodeId];
      while (level.length > 0) {
        const current = level.shift()!;
        count += 1;
        for (const node of doc.plan.nodes) {
          if (node.parentId === current) level.push(node.id);
        }
      }
      return { nodeIds: Array.from({ length: count }, () => this.deps.newNodeId()) };
    }
    if (command.type === 'insert-preset' && preset !== undefined) {
      return { nodeIds: preset.nodes.map(() => this.deps.newNodeId()) };
    }
    if (command.type === 'insert-user-template' && body !== undefined) {
      return { nodeIds: body.nodes.map(() => this.deps.newNodeId()) };
    }
    return {};
  }

  /** 新节点 id 由应用层生成并已在意图中固定；命令不能指定 id 覆盖旧节点。 */
  private materialize(
    command: PlanningCommand,
    allocated: string[],
    preset?: PresetDescriptor,
    body?: UserTemplateBody,
  ): PlanCommand {
    let cursor = 0;
    const nextId = (): string => allocated[cursor++] ?? this.deps.newNodeId();
    const toNode = (input: NewNodeInput, parentOverride?: string | null): WorkNode => ({
      id: nextId(),
      parentId: parentOverride === undefined ? input.parentId : parentOverride,
      order: input.order,
      title: input.title,
      goal: input.goal,
      completionCriteria: [...input.completionCriteria],
      status: input.status ?? 'todo',
    });
    switch (command.type) {
      case 'add-nodes':
        return { type: 'add-nodes', nodes: command.nodes.map((node) => toNode(node)) };
      case 'split-node':
        return {
          type: 'split-node',
          parentId: command.parentId,
          children: command.children.map((child) => toNode({ ...child, parentId: command.parentId }, command.parentId)),
        };
      case 'group-nodes':
        return {
          type: 'group-nodes',
          nodeIds: [...command.nodeIds],
          group: { title: command.group.title, goal: command.group.goal, completionCriteria: [...command.group.completionCriteria] },
          anchorId: command.anchorId,
          newGroupId: nextId(),
        };
      case 'merge-nodes':
        return command;
      case 'copy-subtree':
        return { ...command, newIds: [...allocated] };
      case 'move-node':
        return command;
      case 'insert-preset':
        if (preset === undefined) {
          throw new Error('insert-preset 缺少已解析预设，不能在物化阶段重新查询');
        }
        return {
          type: 'instantiate-template',
          preset,
          contentLocale: command.contentLocale,
          newIds: [...allocated],
          parentId: command.parentId,
          beforeNodeId: command.beforeNodeId,
        };
      case 'insert-user-template':
        if (body === undefined) {
          throw new Error('insert-user-template 缺少已解析模板正文，不能在物化阶段重新解析');
        }
        return {
          type: 'instantiate-user-template',
          body,
          newIds: [...allocated],
          parentId: command.parentId,
          beforeNodeId: command.beforeNodeId,
        };
      case 'undo-plan-edit':
      case 'redo-plan-edit':
        // 逆向命令在 buildCandidate 的 inverseContext 分支处理，不物化为领域 PlanCommand。
        throw new Error('撤销/重做命令不能物化为普通规划命令');
      case 'save-user-template':
        // 用户模板作为公开记录发布，不经领域 PlanCommand 变换。
        throw new Error('用户模板保存命令不能物化为规划命令');
      case 'enable-roadmap':
        // 4.2 启用扩展不经过规划变换：候选由 convertToRoadmap 直接从 v1 文档构造。
        throw new Error('启用扩展规划命令不能物化为规划命令');
      case 'complete-milestone':
        // 4.3 完成：节点状态、完成记录与指纹在 buildCandidate 中一次构造。
        throw new Error('里程碑完成命令不能物化为规划命令');
      default:
        return command;
    }
  }
}
