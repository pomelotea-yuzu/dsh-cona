// 接续聊天指针服务（R2 任务 3.3，design §3/§4）：
// 把公开接续记录（recordId + contentHash 定位版本）与本机聊天链接（linkId）关联，
// 指针只存本机实例聚合，绝不写公开资料。查看与打开会话前的复查都在这里完成：
// - 同实例：聚合按 instanceId 隔离，聚合缺失（干净 profile）即指针不可用；
// - 关联核对：linkId 必须仍存在于本机聊天链接（解绑后指针不静默认领）；
// - 记录版本：link 时取当前已接纳索引的 contentHash；打开前再核对请求哈希；
// - 宿主实际 Session：打开前核对宿主会话列表可见。
//
// 边界：不依赖宿主与 React；会话目录与记录索引经回调注入（host 每实例装配）。

import type { LocalStateStorePort, SessionDirectoryPort } from './ports.js';
import { InstanceCommandQueue } from './command-queue.js';
import {
  conversationStateOf,
  resumePointersOf,
  type InstanceAggregate,
  type ResumeChatPointer,
} from './local-state.js';

/** 与聊天关联服务一致的三态回执。 */
export type ResumeChatOutcome<S> =
  | { status: 'committed'; value: S; stateRevision: number }
  | { status: 'rejected'; code: string; message: string }
  | { status: 'unknown-state'; code: string; message: string; stage: string };

/** 指针视图（卡片投影）：linked / unlinked / unavailable 三态；本机状态不可读不冒充失效。 */
export type ResumeChatPointerView =
  | { status: 'linked'; linkId: string; sessionId: string; purpose: string; visible: boolean | null }
  | { status: 'unlinked' }
  | { status: 'unavailable'; reason: string };

/** 打开会话前复查的结果。 */
export type ResumeChatTargetResult =
  | { status: 'ok'; sessionId: string; linkId: string }
  | { status: 'rejected'; code: string; message: string };

export interface ResumeChatServiceDeps {
  localRoot: string;
  /** 本服务绑定的单一实例；host 每实例装配，测试显式指定。 */
  instanceId: string;
  store: LocalStateStorePort;
  /** 与命令/聊天共享的每实例队列，保证指针写与资料命令在实例内串行。 */
  queue: InstanceCommandQueue;
  clock: () => string;
  /** 宿主会话目录：可见性核对（失败给 visible null 或稳定拒绝，不抛给上层）。 */
  directory: SessionDirectoryPort;
  /**
   * 记录版本复查：返回记录在当前已接纳索引中的 contentHash；
   * null = 记录不在当前资料；'unavailable' = 索引不可读（不冒充不存在）。
   */
  findRecord: (recordId: string) => Promise<{ contentHash: string } | null | 'unavailable'>;
  /** 测试故障注入；生产不传。 */
  hooks?: { beforeAggregateReplace?: import('./ports.js').PublishHooksPort };
}

/** 关联已有聊天链接到一条接续记录（幂等；同记录重新关联即替换）。 */
export interface LinkResumeRequest {
  recordId: string;
  linkId: string;
}

export class ResumeChatService {
  private readonly deps: ResumeChatServiceDeps;

  constructor(deps: ResumeChatServiceDeps) {
    this.deps = deps;
  }

  /**
   * 保存指针：复查记录版本（当前已接纳索引）与链接存在性后落盘。
   * 幂等：同一 (recordId, linkId, contentHash) 重复请求不推进修订；
   * 同记录换链接或记录正文经显式核对刷新变化时更新指针。
   * 公开记录的保存由 append-record 完成；本方法失败不产生第二条公开记录。
   */
  async link(request: LinkResumeRequest): Promise<ResumeChatOutcome<{
    recordId: string;
    linkId: string;
    contentHash: string;
    reused: boolean;
  }>> {
    if (typeof request.recordId !== 'string' || request.recordId === ''
      || typeof request.linkId !== 'string' || request.linkId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: 'recordId 与 linkId 必须是非空字符串' };
    }
    return this.deps.queue.run(this.deps.instanceId, async () => {
      const read = await this.readAggregate();
      if ('outcome' in read) return read.outcome;
      const { aggregate } = read;
      const links = conversationStateOf(aggregate.conversations).links;
      if (!links.some((link) => link.linkId === request.linkId)) {
        return { status: 'rejected' as const, code: 'resume-link-missing', message: '本机聊天链接不存在（可能已解除关联）' };
      }
      const record = await this.deps.findRecord(request.recordId);
      if (record === 'unavailable') {
        return { status: 'rejected' as const, code: 'record-unknown', message: '当前资料索引不可读；不写指针' };
      }
      if (record === null) {
        return { status: 'rejected' as const, code: 'record-not-found', message: '记录不在当前已接纳资料中；不写指针' };
      }
      const pointers = resumePointersOf(aggregate.resumePointers);
      const existing = pointers.find((p) => p.recordId === request.recordId);
      if (existing !== undefined && existing.linkId === request.linkId && existing.contentHash === record.contentHash) {
        // 幂等重复：不推进修订。
        return {
          status: 'committed' as const,
          value: { recordId: request.recordId, linkId: request.linkId, contentHash: record.contentHash, reused: true },
          stateRevision: aggregate.revisions.state,
        };
      }
      const next: ResumeChatPointer = {
        recordId: request.recordId,
        contentHash: record.contentHash,
        linkId: request.linkId,
        createdAt: this.deps.clock(),
      };
      const updated = existing === undefined
        ? [...pointers, next]
        : pointers.map((p) => (p.recordId === request.recordId ? next : p));
      const outcome = await this.persist(aggregate, updated);
      if (outcome.status !== 'committed') return outcome;
      return {
        status: 'committed' as const,
        value: { recordId: request.recordId, linkId: request.linkId, contentHash: record.contentHash, reused: false },
        stateRevision: outcome.stateRevision,
      };
    });
  }

  /**
   * 卡片投影：当前候选记录的指针三态。聚合不可读（干净 profile／隔离）→ unavailable，
   * 卡片本身来自公开记录，仍显示摘要；不回退、不冒充。
   * 指针缺失时用「记录 savedAt 早于本机实例登记时刻」区分两种诚实语义：
   * 记录来自其他环境（指针必不在此）→ unavailable(pointer-not-here)；
   * 本机保存时未选聊天 → unlinked。
   */
  async view(recordId: string, contentHash: string, savedAt?: string): Promise<ResumeChatPointerView> {
    if (typeof recordId !== 'string' || recordId === '' || typeof contentHash !== 'string' || contentHash === '') {
      return { status: 'unavailable', reason: 'operation-mismatch' };
    }
    const read = await this.tryReadAggregate();
    if (read.status === 'unavailable') return { status: 'unavailable', reason: read.reason };
    const { aggregate } = read;
    const pointer = resumePointersOf(aggregate.resumePointers).find(
      (p) => p.recordId === recordId && p.contentHash === contentHash,
    );
    if (pointer === undefined) {
      if (typeof savedAt === 'string' && savedAt !== '' && Number.isFinite(Date.parse(savedAt))) {
        try {
          const registry = await this.deps.store.readRegistry(this.deps.localRoot);
          const entry = registry.instances.find((item) => item.instanceId === this.deps.instanceId);
          if (entry !== undefined && Number.isFinite(Date.parse(entry.createdAt))
            && Date.parse(savedAt) < Date.parse(entry.createdAt)) {
            return { status: 'unavailable', reason: 'pointer-not-here' };
          }
        } catch {
          // 注册表不可读：回退 unlinked（诚实缺省，不猜）。
        }
      }
      return { status: 'unlinked' };
    }
    const link = conversationStateOf(aggregate.conversations).links.find((l) => l.linkId === pointer.linkId);
    if (link === undefined) return { status: 'unavailable', reason: 'resume-link-missing' };
    let visible: boolean | null;
    try {
      const directory = await this.deps.directory.listSessions();
      visible = directory.some((session) => session.sessionId === link.sessionId);
    } catch {
      // 目录不可用时记未知，不冒充失效。
      visible = null;
    }
    return {
      status: 'linked',
      linkId: link.linkId,
      sessionId: link.sessionId,
      purpose: link.purpose,
      visible,
    };
  }

  /**
   * 打开会话前的复查（design §4「点击时再复查」）：记录版本、指针、链接与宿主实际 Session。
   * 会话不可见（解绑／删除／干净 profile）给稳定拒绝；导航本身由 client 用宿主能力完成。
   */
  async resolveTarget(request: { recordId: string; contentHash: string; linkId: string }): Promise<ResumeChatTargetResult> {
    const { recordId, contentHash, linkId } = request;
    if (typeof recordId !== 'string' || recordId === ''
      || typeof contentHash !== 'string' || contentHash === ''
      || typeof linkId !== 'string' || linkId === '') {
      return { status: 'rejected', code: 'operation-mismatch', message: 'recordId/contentHash/linkId 必须是非空字符串' };
    }
    const read = await this.readAggregate();
    if ('outcome' in read) {
      return { status: 'rejected', code: read.outcome.code, message: read.outcome.message };
    }
    const { aggregate } = read;
    const pointer = resumePointersOf(aggregate.resumePointers).find((p) => p.recordId === recordId);
    if (pointer === undefined || pointer.linkId !== linkId) {
      return { status: 'rejected', code: 'resume-pointer-missing', message: '该记录没有指向此聊天的指针' };
    }
    if (pointer.contentHash !== contentHash) {
      return { status: 'rejected', code: 'record-version-changed', message: '记录版本已变化；请刷新后重试' };
    }
    const link = conversationStateOf(aggregate.conversations).links.find((l) => l.linkId === linkId);
    if (link === undefined) {
      return { status: 'rejected', code: 'resume-link-missing', message: '本机聊天链接不存在（可能已解除关联）' };
    }
    let directory: Awaited<ReturnType<SessionDirectoryPort['listSessions']>>;
    try {
      directory = await this.deps.directory.listSessions();
    } catch (error) {
      return { status: 'rejected', code: 'session-directory-unavailable', message: (error as Error).message };
    }
    if (!directory.some((session) => session.sessionId === link.sessionId)) {
      return { status: 'rejected', code: 'session-not-visible', message: '原会话在宿主中不可见（可能已删除）' };
    }
    return { status: 'ok', sessionId: link.sessionId, linkId };
  }

  // ---------- 内部 ----------

  /** 读聚合，错误转三态回执（写路径用）。 */
  private async readAggregate(): Promise<
    { aggregate: InstanceAggregate } | { outcome: Exclude<ResumeChatOutcome<never>, { status: 'committed' }> }
  > {
    const quarantined = await this.deps.store.readQuarantine(this.deps.localRoot, this.deps.instanceId);
    if (quarantined !== null) {
      return {
        outcome: {
          status: 'rejected',
          code: 'unknown-state',
          message: `该实例已隔离（${quarantined.reason}，阶段 ${quarantined.stage}）；指针读写停止`,
        },
      };
    }
    const aggregate = await this.deps.store.readAggregate(this.deps.localRoot, this.deps.instanceId);
    if (aggregate === null) {
      return { outcome: { status: 'rejected', code: 'binding-expired', message: '本机注册表中没有该实例' } };
    }
    return { aggregate };
  }

  /** 读聚合，错误转 unavailable（只读投影用，不抛）。 */
  private async tryReadAggregate(): Promise<
    { status: 'ok'; aggregate: InstanceAggregate } | { status: 'unavailable'; reason: string }
  > {
    try {
      const quarantined = await this.deps.store.readQuarantine(this.deps.localRoot, this.deps.instanceId);
      if (quarantined !== null) return { status: 'unavailable', reason: `unknown-state:${quarantined.stage}` };
      const aggregate = await this.deps.store.readAggregate(this.deps.localRoot, this.deps.instanceId);
      if (aggregate === null) return { status: 'unavailable', reason: 'binding-expired' };
      return { status: 'ok', aggregate };
    } catch (error) {
      return { status: 'unavailable', reason: (error as Error).message || 'aggregate-unreadable' };
    }
  }

  /** 聚合替换 + stateRevision 推进；unknown-state 与命令层一致进入隔离。 */
  private async persist(
    aggregate: InstanceAggregate,
    pointers: ResumeChatPointer[],
  ): Promise<
    { status: 'committed'; stateRevision: number }
    | { status: 'rejected'; code: string; message: string }
    | { status: 'unknown-state'; code: string; message: string; stage: string }
  > {
    const next: InstanceAggregate = {
      ...aggregate,
      resumePointers: pointers,
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
      stage: `resume-pointer:${result.stage}`,
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
