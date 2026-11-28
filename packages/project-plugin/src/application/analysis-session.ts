// 分析 Session 生命周期（tasks 4.1-4.3）：owner 确认后冻结输入、先落本机记录、
// 用专用 preset 新建真实 Session、登记实际身份。首条消息的发送与启动核对在
// 4.3 的发送路径上继续；本文件先把「记录先于宿主」与「关联未落盘不派发」做成
// 可测的应用规则。
//
// 边界：不依赖 DSH 宿主、Node 或 React；宿主会话目录与规划基线经端口注入。
// 公开资料不写分析记录；分析 ID、绑定与 Session 引用只在本机聚合。

import { InstanceCommandQueue } from './command-queue.js';
import {
  analysisRecordsOf,
  type AnalysisBindingState,
  type AnalysisRecord,
  type AnalysisStartObservation,
  type AnalysisStatus,
  type InstanceAggregate,
} from './local-state.js';
import type { AnalysisSelection, AnalysisScopeService } from './analysis-scope.js';
import type { AnalysisExecutionPort, AnalysisSessionPort, LocalStateStorePort, PublishHooksPort } from './ports.js';
import type { ScopeSelection } from '../domain/analysis.js';

export type AnalysisOutcome<S> =
  | { status: 'committed'; value: S; stateRevision: number }
  | { status: 'rejected'; code: string; message: string }
  | { status: 'unknown-state'; code: string; message: string; stage: string };

export interface StartAnalysisRequest {
  /** owner 确认的启动操作号；也是首条消息的 rpcId 与幂等键。 */
  readonly operationId: string;
  readonly repositoryId: string;
  readonly scope: ScopeSelection;
  /**
   * 用户在预览中看到的指纹。确认时工作副本已变化则拒绝，要求重新预览；
   * 不传表示预览与确认在同一次调用内完成。
   */
  readonly expectedFingerprint?: string;
  /** 预览时的规划指纹；确认时规划已变化则拒绝。 */
  readonly expectedPlanVersion?: string;
  /** 复盘来源（同一项目上一轮分析）；首切片只记录，不改本轮输入。 */
  readonly previousAnalysisId?: string;
}

export interface StartAnalysisValue {
  readonly analysis: AnalysisRecord;
  /** 同一 operationId 的重复确认返回原记录，不再新建 Session。 */
  readonly reused: boolean;
}

export interface AnalysisSessionServiceDeps {
  readonly localRoot: string;
  /** 本服务绑定的单一实例；host 每实例装配，测试显式指定。 */
  readonly instanceId: string;
  readonly store: LocalStateStorePort;
  readonly queue: InstanceCommandQueue;
  readonly scope: AnalysisScopeService;
  /** 当前规划指纹；失败给稳定码。planRevision 从本机聚合读取。 */
  readonly planBaseline: () => Promise<
    { readonly ok: true; readonly planVersion: string } | { readonly ok: false; readonly code: string; readonly message: string }
  >;
  readonly session: AnalysisSessionPort;
  /** 派发前保护核对与首消息接受查询（4.3-4.4）。 */
  readonly execution: AnalysisExecutionPort;
  readonly clock: () => string;
  readonly newAnalysisId: () => string;
  /** 固定分析 preset 标识（与 cordis.patch.yml 一致）。 */
  readonly agentPreset: string;
  /** 测试故障注入；生产不传。 */
  readonly hooks?: { readonly beforeAggregateReplace?: PublishHooksPort };
}

/** 分析记录服务：每实例一个，与命令／聊天共用实例队列。 */
export class AnalysisSessionService {
  private readonly deps: AnalysisSessionServiceDeps;

  constructor(deps: AnalysisSessionServiceDeps) {
    this.deps = deps;
  }

  /**
   * owner 确认：在同一队列任务内依次做「预览核对 → 落本机记录 → 建真实 Session →
   * 持久登记实际身份」。任何一步未确认都不进入下一步，尤其不在关联未落盘时返回可发送状态。
   */
  async start(request: StartAnalysisRequest): Promise<AnalysisOutcome<StartAnalysisValue>> {
    const guard = validateStart(request);
    if (guard !== null) return guard;
    return this.deps.queue.run(this.deps.instanceId, async () => {
      const read = await this.readAggregate();
      if ('outcome' in read) return read.outcome;
      const records = analysisRecordsOf(read.aggregate.analyses);
      const existing = records.find((record) => record.requestId === request.operationId);
      if (existing !== undefined) {
        // 同 operationId 的重复确认：回到原记录，绝不创建第二个 Session。
        return { status: 'committed' as const, value: { analysis: existing, reused: true }, stateRevision: read.aggregate.revisions.state };
      }

      const preview = await this.deps.scope.preview({ repositoryId: request.repositoryId, scope: request.scope });
      if (preview.status === 'rejected') {
        return { status: 'rejected' as const, code: preview.code, message: preview.message };
      }
      if (request.expectedFingerprint !== undefined && request.expectedFingerprint !== preview.fingerprint) {
        return {
          status: 'rejected' as const,
          code: 'analysis-preview-stale',
          message: '确认时范围内内容已变化；请重新预览后再开始分析',
        };
      }
      const baseline = await this.deps.planBaseline();
      if (!baseline.ok) return { status: 'rejected' as const, code: baseline.code, message: baseline.message };
      if (request.expectedPlanVersion !== undefined && request.expectedPlanVersion !== baseline.planVersion) {
        return {
          status: 'rejected' as const,
          code: 'analysis-plan-changed',
          message: '确认时规划已变化；请重新预览后再开始分析',
        };
      }

      const now = this.deps.clock();
      const observation: AnalysisStartObservation = {
        fingerprint: preview.fingerprint,
        complete: preview.complete,
        observedAt: preview.observedAt,
        entries: preview.entries.length,
        issues: preview.issues.length,
      };
      const prepared: AnalysisRecord = {
        analysisId: this.deps.newAnalysisId(),
        instanceId: this.deps.instanceId,
        repositoryId: request.repositoryId,
        repositoryRoot: preview.selection.repositoryRoot,
        mappingHash: preview.selection.mappingHash,
        sourceGeneration: preview.selection.sourceGeneration,
        scope: request.scope,
        planVersion: baseline.planVersion,
        planRevision: read.aggregate.revisions.plan,
        observation,
        requestId: request.operationId,
        sessionId: null,
        agentPreset: this.deps.agentPreset,
        status: 'prepared',
        binding: null,
        createdAt: now,
        updatedAt: now,
        ...(request.previousAnalysisId === undefined ? {} : { previousAnalysisId: request.previousAnalysisId }),
      };
      // 记录先落盘：后续即使宿主创建结果未知，也有可核对的本机记录。
      const saved = await this.persist(read.aggregate, [...records, prepared]);
      if (saved.status !== 'committed') return saved;

      // 创建前标记 creating；崩溃后留下可核对的中间态，不会假装已关联。
      const creating = { ...prepared, status: 'creating' as const, updatedAt: now };
      const creatingSaved = await this.persist({ ...read.aggregate, revisions: { ...read.aggregate.revisions, state: saved.stateRevision } }, [
        ...records, creating,
      ]);
      if (creatingSaved.status !== 'committed') return creatingSaved;

      let created: { sessionId: string; agentPreset?: string };
      try {
        created = await this.deps.session.createAnalysisSession({
          cwd: prepared.repositoryRoot,
          agentPreset: this.deps.agentPreset,
        });
      } catch (error) {
        // 宿主结果未知：保留 creating，等显式核对；绝不自动再建第二个 Session。
        const detail = `宿主创建结果未知：${(error as Error).message}`;
        const unknown: AnalysisRecord = { ...creating, status: 'unknown', detail, updatedAt: this.deps.clock() };
        await this.persist({ ...read.aggregate, revisions: { ...read.aggregate.revisions, state: creatingSaved.stateRevision } }, [...records, unknown]);
        return { status: 'rejected' as const, code: 'analysis-session-create-unknown', message: detail };
      }
      if (typeof created.sessionId !== 'string' || created.sessionId === '') {
        const detail = '宿主未返回有效 Session id';
        const unknown: AnalysisRecord = { ...creating, status: 'unknown', detail, updatedAt: this.deps.clock() };
        await this.persist({ ...read.aggregate, revisions: { ...read.aggregate.revisions, state: creatingSaved.stateRevision } }, [...records, unknown]);
        return { status: 'rejected' as const, code: 'analysis-session-identity-missing', message: detail };
      }
      if (created.agentPreset !== undefined && created.agentPreset !== this.deps.agentPreset) {
        const detail = `宿主返回的 preset 是 ${created.agentPreset}，不是 ${this.deps.agentPreset}`;
        const failed: AnalysisRecord = { ...creating, status: 'failed', detail, updatedAt: this.deps.clock() };
        await this.persist({ ...read.aggregate, revisions: { ...read.aggregate.revisions, state: creatingSaved.stateRevision } }, [...records, failed]);
        return { status: 'rejected' as const, code: 'analysis-preset-mismatch', message: detail };
      }

      const binding: AnalysisBindingState = { persisted: true, protected: false, terminal: false, version: 1 };
      const record: AnalysisRecord = {
        ...creating,
        sessionId: created.sessionId,
        status: 'created',
        binding,
        updatedAt: this.deps.clock(),
      };
      const associated = await this.persist({ ...read.aggregate, revisions: { ...read.aggregate.revisions, state: creatingSaved.stateRevision } }, [
        ...records, record,
      ]);
      if (associated.status !== 'committed') {
        // 会话已存在但关联未确认：保留 creating，不返回可发送状态。
        return {
          status: 'rejected' as const,
          code: 'analysis-association-unknown',
          message: `Session ${created.sessionId} 已创建，但本机关联未确认；请核对后再发送`,
        };
      }
      return { status: 'committed' as const, value: { analysis: record, reused: false }, stateRevision: associated.stateRevision };
    });
  }

  /**
   * 发送首条分析消息（tasks 4.3）。派发前先经保护端口核对执行器/守卫并注册能力；
   * 发送前落 `sending`，成功后落 `running`。宿主报错后先查询同一 requestId 是否已到达，
   * 未查清时保留 unknown 且不自动重发；显式 retry 只在查询确认未到达后复用同一 requestId。
   */
  async sendFirstMessage(
    analysisId: string,
    options: { readonly retry?: boolean } = {},
  ): Promise<AnalysisOutcome<{ readonly sent: boolean; readonly recovered: boolean; readonly reused: boolean }>> {
    if (typeof analysisId !== 'string' || analysisId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少 analysisId' };
    }
    return this.deps.queue.run(this.deps.instanceId, async () => {
      const read = await this.readAggregate();
      if ('outcome' in read) return read.outcome;
      const records = analysisRecordsOf(read.aggregate.analyses);
      const record = records.find((item) => item.analysisId === analysisId);
      if (record === undefined) return { status: 'rejected' as const, code: 'analysis-not-found', message: '本机没有该分析记录' };
      if (ANALYSIS_TERMINAL_STATUSES.includes(record.status)) {
        return { status: 'rejected' as const, code: 'analysis-terminal', message: '该分析已结束，只可回看，不再接受新消息' };
      }
      if (record.sessionId === null) {
        return { status: 'rejected' as const, code: 'analysis-session-missing', message: '尚未登记实际 Session；请先核对启动结果' };
      }
      if (record.binding === null || !record.binding.persisted) {
        return { status: 'rejected' as const, code: 'analysis-binding-not-persisted', message: '本机关联尚未落盘，不发送分析消息' };
      }
      const sessionId = record.sessionId;
      if (record.status === 'running') {
        return { status: 'committed' as const, value: { sent: true, recovered: false, reused: true }, stateRevision: read.aggregate.revisions.state };
      }
      if (record.status === 'sending' || record.status === 'unknown') {
        const accepted = await this.deps.execution.promptAccepted(sessionId, record.requestId);
        if (accepted === true) {
          return this.finishSend(read.aggregate, records, record, { recovered: true, reused: true });
        }
        if (accepted === 'unknown') {
          return {
            status: 'rejected' as const,
            code: 'analysis-send-unconfirmed',
            message: '上次发送结果无法核对；不自动重发，请稍后显式重试',
          };
        }
        if (options.retry !== true) {
          return {
            status: 'rejected' as const,
            code: 'analysis-send-unconfirmed',
            message: '上次发送未被宿主接受；不自动重发，显式重试可复用同一请求标识',
          };
        }
        // 查询确认未到达：允许显式 retry，仍使用原 requestId（不换号）。
      }

      const prepared = await this.deps.execution.prepare(record);
      if (!prepared.ready) {
        return { status: 'rejected' as const, code: prepared.code, message: prepared.message };
      }

      const now = this.deps.clock();
      const sending: AnalysisRecord = {
        ...record,
        status: 'sending',
        binding: { ...(record.binding ?? { persisted: true, terminal: false, version: 1 }), protected: true },
        updatedAt: now,
      };
      const sendingSaved = await this.persist(read.aggregate, replaceRecord(records, sending));
      if (sendingSaved.status !== 'committed') return sendingSaved;

      try {
        await this.deps.session.promptFirstMessage({
          sessionId,
          requestId: record.requestId,
          text: firstMessageText(record),
        });
      } catch (error) {
        const accepted = await this.deps.execution.promptAccepted(sessionId, record.requestId);
        if (accepted === true) {
          return this.finishSend(
            { ...read.aggregate, revisions: { ...read.aggregate.revisions, state: sendingSaved.stateRevision } },
            replaceRecord(records, sending),
            sending,
            { recovered: true, reused: false },
          );
        }
        const detail = `首条消息发送结果未知：${(error as Error).message}`;
        const unknown: AnalysisRecord = { ...sending, status: 'unknown', detail, updatedAt: this.deps.clock() };
        await this.persist(
          { ...read.aggregate, revisions: { ...read.aggregate.revisions, state: sendingSaved.stateRevision } },
          replaceRecord(records, unknown),
        );
        return { status: 'rejected' as const, code: 'analysis-send-unknown', message: detail };
      }
      return this.finishSend(
        { ...read.aggregate, revisions: { ...read.aggregate.revisions, state: sendingSaved.stateRevision } },
        replaceRecord(records, sending),
        sending,
        { recovered: false, reused: false },
      );
    });
  }

  /**
   * 启动／发送结果核对（tasks 4.3）。创建结果未知时只在宿主列表里找候选，不自动再建；
   * 发送结果未知时只查询同一 requestId，查清前保持原状态。
   */
  async reconcile(analysisId: string): Promise<
    | { readonly status: 'adopted'; readonly analysis: AnalysisRecord; readonly candidates: readonly string[] }
    | { readonly status: 'running'; readonly analysis: AnalysisRecord; readonly candidates: readonly string[] }
    | { readonly status: 'created'; readonly analysis: AnalysisRecord; readonly candidates: readonly string[] }
    | { readonly status: 'needs-choice'; readonly analysis: AnalysisRecord; readonly candidates: readonly string[] }
    | { readonly status: 'not-found'; readonly analysis: AnalysisRecord; readonly candidates: readonly string[] }
    | { readonly status: 'unconfirmed'; readonly analysis: AnalysisRecord; readonly candidates: readonly string[] }
    | { readonly status: 'rejected'; readonly code: string; readonly message: string }
  > {
    if (typeof analysisId !== 'string' || analysisId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少 analysisId' };
    }
    return this.deps.queue.run(this.deps.instanceId, async () => {
      const read = await this.readAggregate();
      if ('outcome' in read) {
        const outcome = read.outcome;
        if (outcome.status === 'committed') return { status: 'rejected' as const, code: 'analysis-read-failed', message: '读取分析记录失败' };
        return { status: 'rejected' as const, code: outcome.code, message: outcome.message };
      }
      const records = analysisRecordsOf(read.aggregate.analyses);
      const record = records.find((item) => item.analysisId === analysisId);
      if (record === undefined) return { status: 'rejected' as const, code: 'analysis-not-found', message: '本机没有该分析记录' };

      if (record.sessionId === null) {
        const sessions = await this.deps.session.listSessions();
        const createdMs = Date.parse(record.createdAt);
        const candidates = sessions
          .filter((session) => session.blank && session.cwd === record.repositoryRoot
            && Number.isFinite(createdMs) && session.updatedAt >= createdMs)
          .map((session) => session.sessionId);
        if (candidates.length !== 1) {
          return {
            status: candidates.length > 1 ? 'needs-choice' as const : 'not-found' as const,
            analysis: record,
            candidates,
          };
        }
        const sessionId = candidates[0] as string;
        const adopted: AnalysisRecord = {
          ...record,
          sessionId,
          status: 'created',
          binding: { persisted: true, protected: false, terminal: false, version: 1 },
          updatedAt: this.deps.clock(),
        };
        const saved = await this.persist(read.aggregate, replaceRecord(records, adopted));
        if (saved.status !== 'committed') return { status: 'rejected' as const, code: saved.code, message: saved.message };
        return { status: 'adopted' as const, analysis: adopted, candidates };
      }

      if (record.status === 'sending' || record.status === 'unknown') {
        const accepted = await this.deps.execution.promptAccepted(record.sessionId, record.requestId);
        if (accepted === true) {
          const done = await this.finishSend(read.aggregate, records, record, { recovered: true, reused: false });
          if (done.status !== 'committed') return { status: 'rejected' as const, code: done.code, message: done.message };
          return { status: 'running' as const, analysis: done.value.analysis, candidates: [] };
        }
        if (accepted === false) {
          const rolled: AnalysisRecord = { ...record, status: 'created', detail: undefined, updatedAt: this.deps.clock() };
          const saved = await this.persist(read.aggregate, replaceRecord(records, rolled));
          if (saved.status !== 'committed') return { status: 'rejected' as const, code: saved.code, message: saved.message };
          return { status: 'created' as const, analysis: rolled, candidates: [] };
        }
        return { status: 'unconfirmed' as const, analysis: record, candidates: [] };
      }
      return { status: 'running' as const, analysis: record, candidates: [] };
    });
  }

  /** 读取单条分析记录（只读；不改变状态）。 */
  async get(analysisId: string): Promise<{ status: 'ok'; analysis: AnalysisRecord } | { status: 'rejected'; code: string; message: string }> {
    if (typeof analysisId !== 'string' || analysisId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: '缺少 analysisId' };
    }
    const read = await this.readAggregate();
    if ('outcome' in read) {
      const outcome = read.outcome;
      if (outcome.status === 'committed') {
        return { status: 'rejected', code: 'analysis-read-failed', message: '读取分析记录失败' };
      }
      return { status: 'rejected', code: outcome.code, message: outcome.message };
    }
    const record = analysisRecordsOf(read.aggregate.analyses).find((item) => item.analysisId === analysisId);
    if (record === undefined) return { status: 'rejected', code: 'analysis-not-found', message: '本机没有该分析记录' };
    return { status: 'ok', analysis: record };
  }

  /** 本实例分析记录（新到旧）；历史只读。 */
  async list(): Promise<readonly AnalysisRecord[]> {
    const read = await this.readAggregate();
    if ('outcome' in read) return [];
    return analysisRecordsOf(read.aggregate.analyses)
      .slice()
      .sort((left, right) => (left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0));
  }

  private async readAggregate(): Promise<
    { aggregate: InstanceAggregate } | { outcome: AnalysisOutcome<never> }
  > {
    const quarantined = await this.deps.store.readQuarantine(this.deps.localRoot, this.deps.instanceId);
    if (quarantined !== null) {
      return {
        outcome: {
          status: 'rejected',
          code: 'unknown-state',
          message: `该实例已隔离（${quarantined.reason}，阶段 ${quarantined.stage}）；分析读写停止`,
        },
      };
    }
    const aggregate = await this.deps.store.readAggregate(this.deps.localRoot, this.deps.instanceId);
    if (aggregate === null) {
      return { outcome: { status: 'rejected', code: 'binding-expired', message: '本机注册表中没有该实例' } };
    }
    return { aggregate };
  }

  /** 发送完成：落 running 与 sentAt；返回统一的 committed 结果。 */
  private async finishSend(
    aggregate: InstanceAggregate,
    records: readonly AnalysisRecord[],
    record: AnalysisRecord,
    outcome: { readonly recovered: boolean; readonly reused: boolean },
  ): Promise<AnalysisOutcome<{ readonly sent: boolean; readonly recovered: boolean; readonly reused: boolean; readonly analysis: AnalysisRecord }>> {
    const running: AnalysisRecord = {
      ...record,
      status: 'running',
      sentAt: record.sentAt ?? this.deps.clock(),
      updatedAt: this.deps.clock(),
      detail: undefined,
    };
    const saved = await this.persist(aggregate, replaceRecord(records, running));
    if (saved.status !== 'committed') return saved;
    return {
      status: 'committed' as const,
      value: { sent: true, recovered: outcome.recovered, reused: outcome.reused, analysis: running },
      stateRevision: saved.stateRevision,
    };
  }

  /** 聚合替换 + stateRevision 推进；unknown-state 时与命令层同样进入隔离。 */
  private async persist(
    aggregate: InstanceAggregate,
    analyses: AnalysisRecord[],
  ): Promise<
    { status: 'committed'; stateRevision: number }
    | { status: 'rejected'; code: string; message: string }
    | { status: 'unknown-state'; code: string; message: string; stage: string }
  > {
    const next: InstanceAggregate = {
      ...aggregate,
      analyses,
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
    await this.deps.store.quarantine(this.deps.localRoot, {
      schemaVersion: 1,
      instanceId: aggregate.instanceId,
      reason: 'unknown-state',
      stage: `analysis:${result.stage}`,
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

/** 构造分析选择视图：从本机记录还原 3.x 服务使用的冻结身份。 */
export function analysisSelectionOf(record: AnalysisRecord): AnalysisSelection {
  return {
    instanceId: record.instanceId,
    repositoryId: record.repositoryId,
    repositoryRoot: record.repositoryRoot,
    sourceGeneration: record.sourceGeneration,
    mappingHash: record.mappingHash,
    scope: record.scope,
    frozenAt: record.createdAt,
  };
}

/** 状态是否已有真实 Session（创建后到终态之前／之后）。 */
export function hasActualSession(record: AnalysisRecord): boolean {
  return record.sessionId !== null;
}

/** 终态集合：不再接受分析工作，只作历史回看。 */
export const ANALYSIS_TERMINAL_STATUSES: readonly AnalysisStatus[] = ['completed', 'interrupted', 'failed'];

function validateStart(request: StartAnalysisRequest): AnalysisOutcome<never> | null {
  if (typeof request?.operationId !== 'string' || request.operationId === '') {
    return { status: 'rejected', code: 'operation-mismatch', message: '缺少 operationId' };
  }
  if (typeof request.repositoryId !== 'string' || request.repositoryId === '') {
    return { status: 'rejected', code: 'operation-mismatch', message: '缺少 repositoryId' };
  }
  const scope = request.scope;
  if (scope === null || typeof scope !== 'object') {
    return { status: 'rejected', code: 'operation-mismatch', message: '缺少分析范围' };
  }
  if (scope.kind !== 'root' && scope.kind !== 'file' && scope.kind !== 'directory') {
    return { status: 'rejected', code: 'operation-mismatch', message: '分析范围必须是仓库根、文件或目录' };
  }
  if (scope.kind !== 'root' && (typeof scope.path !== 'string' || scope.path === '')) {
    return { status: 'rejected', code: 'operation-mismatch', message: '文件／目录范围需要非空路径' };
  }
  if (request.expectedFingerprint !== undefined && typeof request.expectedFingerprint !== 'string') {
    return { status: 'rejected', code: 'operation-mismatch', message: 'expectedFingerprint 必须是字符串' };
  }
  return null;
}


/** 替换一条记录；找不到时不追加。 */
function replaceRecord(records: readonly AnalysisRecord[], record: AnalysisRecord): AnalysisRecord[] {
  return records.map((item) => (item.analysisId === record.analysisId ? record : item));
}

/** 首条分析消息正文：只给逻辑身份与冻结范围，不注入机器绝对路径。 */
export function firstMessageText(record: AnalysisRecord): string {
  const scope = record.scope.kind === 'root'
    ? '仓库根'
    : `${record.scope.kind === 'file' ? '文件' : '目录'} ${record.scope.path}`;
  return [
    '请对本项目做一次只读分析。',
    `项目实例：${record.instanceId}`,
    `逻辑仓库：${record.repositoryId}`,
    `分析范围：${scope}`,
    `起始观察：${record.observation.entries} 个文件，完整=${record.observation.complete ? '是' : '否'}，指纹=${record.observation.fingerprint}`,
    `规划版本：${record.planVersion}`,
    '只使用 cona_analysis_background、cona_analysis_scope_files、cona_analysis_verification、cona_analysis_save_report。',
    '先看背景与范围，再按实际读取生成报告；不要写文件、不要执行代码。若保护或范围不可用，直接说明原因。',
  ].join('\n');
}
