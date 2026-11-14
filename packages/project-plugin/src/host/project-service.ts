// `conaProject` Remote 服务（tasks 5.2，design §5）：面板的只读快照与统一命令入口。
//
// 准入：只有宿主真实生成的 owner invocation 才放行（`ctx.invocation` 存在、
// peer 主体 owner、`principalOf(invocation)` 为空）；缺 invocation 不降级为进程内 owner，
// 也不把业务参数当身份。Agent 工具入口不在本服务范围（第 6 段）。
//
// 边界：本文件只做准入、参数补齐与结果转交；一致性读取、命令序列、隔离与修订都在应用层。
// 运行时（实例 + 两个应用服务）由宿主在配置解析与资料打开后提供；未配置时面板得到明确码。

import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService, principalOf } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import type {
  Command,
  CommandEnvelope,
  CommandResult,
  ProjectCommandService,
  TrustedContext,
} from '../application/command-service.js'
import type { ProjectSnapshotService, SnapshotResult } from '../application/snapshot.js'
import type { OpenedInstance } from './bootstrap.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    conaProject: ConaProjectService
  }
}

/** 面板启动信息：是否已配置、打开到哪个实例、位置显示与失败原因。 */
export interface ConaProjectStatus {
  configured: boolean;
  instanceId: string | null;
  projectId: string | null;
  sourceKind: string | null;
  sourceDisplay: string | null;
  localRootDisplay: string | null;
  created: boolean;
  error: { code: string; message: string } | null;
}

export interface ConaSnapshotRequest {
  /** 连接代际；面板重连后递增。缺省按 0 处理（无 follow 时不做过期判定）。 */
  connectionGeneration?: number;
  /** 订阅 ready 报出的最高修订。 */
  minStateRevision?: number;
}

export interface ConaExecuteRequest {
  operationId: string;
  command: Command;
  expectedPlanVersion: string;
  expectedPlanRevision: number;
  instanceId?: string;
  projectId?: string;
  sourceEpoch?: number;
}

/** 已打开的运行时：实例 + 两个应用服务。 */
export interface ConaProjectRuntime {
  instance: OpenedInstance;
  snapshot: ProjectSnapshotService;
  command: ProjectCommandService;
}

export type RuntimeResult =
  | { ok: true; value: ConaProjectRuntime }
  | { ok: false; code: string; message: string };

export interface ConaProjectServiceDeps {
  /** 懒装配：首次调用时解析配置并打开资料；失败结果被记忆，不再重试。 */
  runtime: () => Promise<RuntimeResult>;
  localRootDisplay: (root: string) => string;
}

const OWNER: TrustedContext = { kind: 'remote-owner' }

/** `conaProject`：面板读取与保存的唯一 Remote 入口。 */
export class ConaProjectService extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly deps: ConaProjectServiceDeps,
  ) {
    super(ctx, 'conaProject')
  }

  /** 面板启动信息：只读，不含资料内容。 */
  @Remote('status')
  async status(): Promise<ConaProjectStatus> {
    const runtime = await this.deps.runtime()
    if (!runtime.ok) {
      return {
        configured: false,
        instanceId: null,
        projectId: null,
        sourceKind: null,
        sourceDisplay: null,
        localRootDisplay: null,
        created: false,
        error: { code: runtime.code, message: runtime.message },
      }
    }
    const instance = runtime.value.instance
    return {
      configured: true,
      instanceId: instance.instanceId,
      projectId: instance.projectId,
      sourceKind: instance.sourceKind,
      sourceDisplay: instance.sourceDisplay,
      localRootDisplay: this.deps.localRootDisplay(instance.localRoot),
      created: instance.created,
      error: null,
    }
  }

  /** 完整快照；未配置或资料不可读时返回稳定拒绝码，不返回半截内容。 */
  @Remote('snapshot')
  async snapshot(request: ConaSnapshotRequest): Promise<SnapshotResult> {
    const denied = this.deny()
    if (denied !== null) return denied
    const runtime = await this.deps.runtime()
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    const connectionGeneration = request.connectionGeneration ?? 0
    if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 0) {
      return { status: 'rejected', code: 'operation-mismatch', message: 'connectionGeneration 必须是非负整数' }
    }
    return runtime.value.snapshot.read(OWNER, {
      instanceId: runtime.value.instance.instanceId,
      connectionGeneration,
      ...(request.minStateRevision === undefined ? {} : { minStateRevision: request.minStateRevision }),
    })
  }

  /** 统一命令入口：与 CLI 同一应用服务，面板不能绕过校验。 */
  @Remote('execute')
  async execute(request: ConaExecuteRequest): Promise<CommandResult> {
    const denied = this.deny()
    if (denied !== null) return denied
    const runtime = await this.deps.runtime()
    if (!runtime.ok) return { status: 'rejected', code: runtime.code, message: runtime.message }
    const instance = runtime.value.instance
    if (request.instanceId !== undefined && request.instanceId !== instance.instanceId) {
      return { status: 'rejected', code: 'forbidden', message: '命令实例与已配置实例不一致' }
    }
    if (request.projectId !== undefined && request.projectId !== instance.projectId) {
      return { status: 'rejected', code: 'forbidden', message: '命令项目与已配置实例不一致' }
    }
    const envelope: CommandEnvelope = {
      operationId: request.operationId,
      projectId: instance.projectId,
      instanceId: instance.instanceId,
      sourceEpoch: request.sourceEpoch ?? instance.sourceEpoch,
      expectedPlanVersion: request.expectedPlanVersion,
      expectedPlanRevision: request.expectedPlanRevision,
      command: request.command,
    }
    return runtime.value.command.execute(OWNER, envelope)
  }

  /** 准入：缺 invocation、非 owner、或 `principalOf` 非空都拒绝，不降级。 */
  private deny(): { status: 'rejected'; code: string; message: string } | null {
    const invocation: RemoteInvocation | undefined = this.ctx.invocation
    if (invocation === undefined) {
      return { status: 'rejected', code: 'forbidden', message: '缺少宿主生成的 Remote invocation；不降级为进程内 owner' }
    }
    if (invocation.peer.principal.kind !== 'owner') {
      return { status: 'rejected', code: 'forbidden', message: '该 Remote 入口只允许 owner 主体' }
    }
    if (principalOf(invocation) !== undefined) {
      return { status: 'rejected', code: 'forbidden', message: 'principalOf 非空；该入口只接受 owner 直接调用' }
    }
    return null
  }
}

/** 供宿主日志使用的一行摘要，不含资料内容。 */
export function statusLine(status: ConaProjectStatus): string {
  if (!status.configured) {
    return `[dsh-cona-project] 未打开实例${status.error === null ? '' : `（${status.error.code}: ${status.error.message}）`}`
  }
  return `[dsh-cona-project] 实例 ${status.instanceId} @ ${status.sourceDisplay}（${status.sourceKind}）`
}
