// R1 最小诊断插件入口（tasks 2.2 / 2.4）：
// Host ESM 入口 + cordis.patch.yml 插件行引用的模块。
// apply 内装配诊断 Remote 服务与无 invocation 的 ToolRunContext 探针工具。
//
// 注：工具定义刻意不 import @deepseek-ai/dsh-tools（defineTool/ToolDefinition）。
// 其类型链会传入 dsh-session 的 .d.ts，其中对 @deepseek-ai/dsh-typert-protocol
// 接口的 merge 与 vendored protocol 源码在同一 face program 内触发
// 「merged interface contains a declaration outside this face」。定义结构改由
// 宿主 tools.register() 运行时校验（缺 output.render 等形态会 TypeError）；
// 工具定义的静态类型校验待宿主发布插件类型包后恢复。

import { Context } from '@deepseek-ai/cordis'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { ProjectCommandService } from '../application/command-service.js'
import { InstanceCommandQueue } from '../application/command-queue.js'
import { ConversationService } from '../application/conversations.js'
import { WorkService } from '../application/work.js'
import { InMemoryChangeStream, notificationForCommit, notificationForRefresh } from '../application/change-stream.js'
import { ProjectSnapshotService } from '../application/snapshot.js'
import { createSourceFiles } from '../adapters/fs/source-files.js'
import { LocalStateStore } from '../adapters/fs/local-state.js'
import { resolveLocalRoot, rootRelation } from '../adapters/fs/local-root.js'
import { inspectPrivateRoot } from '../adapters/fs/git-guard.js'
import { describeRoot } from '../adapters/fs/location.js'
import type { Sha256Fn } from '../domain/types.js'
import { ConaDiagnosticService } from './diagnostic-service.js'
import { createLocalStateService, openConfiguredInstance, resolveHostConfig, type HostConfigInput, type HostWiring } from './bootstrap.js'
import { ConaProjectService } from './project-service.js'
import type { RuntimeResult } from './project-service.js'
import { ProjectToolAdapter, defineProjectTools, type ConaToolDefinition, type ConaToolExec, type ConaToolsRegistry } from './project-tools.js'
import { planNodeView, sessionDirectory, unavailableSessionDirectory } from './session-directory.js'

export const name = 'dsh-cona-project'

/** 插件配置（cordis `Config`）：两条绝对路径都是用户显式选择，缺省即未配置。 */
export const Config = z.object({
  projectRoot: z.string().optional(),
  localDataRoot: z.string().optional(),
  instanceId: z.string().optional(),
})

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex')
const clock = (): string => new Date().toISOString()

/** 包根：lib/host/index.js → packages/project-plugin。 */
function packageRootDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

/** 本机运行数据根默认值（design §2）：`<宿主 home>/data/dsh-cona/local`。 */
function defaultLocalRootDir(): string {
  const home = process.env['DSH_HOME'] ?? path.join(homedir(), '.dsh')
  return path.join(home, 'data', 'dsh-cona', 'local')
}

/** 宿主启动代际（tasks 6.2）：apply 时取进程启动时刻；WorkRun 只在本代际内生效。 */
let bootGeneration = 0

export interface ConaToolObservation {
  /** execute 收到的 exec.agent（Agent.id 为 SessionId）；无 agent 时为 null。 */
  agentId: string | null;
  /** exec 上可见的 callId（若存在）。 */
  callId: string | null;
  /** execute 入口时 exec.signal 的状态；缺失记 null。 */
  signalAbortedAtStart: boolean | null;
  /** 等待结束（或 abort）后 exec.signal 的状态；缺失记 null。 */
  signalAbortedAtEnd: boolean | null;
  /** 从入口到返回的实际等待毫秒（delayMs=0 时接近 0）。 */
  waitedMs: number;
  /** 捕获时间（UTC instant 字符串）。 */
  capturedAt: string;
}

/** 真实工具执行时捕获的 ToolRunContext 形态（内存态，仅供诊断会话读取）。 */
export const toolObservations: ConaToolObservation[] = []

/** 与 dsh-tools ToolRunContext 运行时形态对齐的最小结构（仅探针所需字段）。 */
interface ConaAbortSignalLike {
  readonly aborted: boolean;
  addEventListener?(type: 'abort', listener: () => void, options?: { readonly once?: boolean }): void;
  removeEventListener?(type: 'abort', listener: () => void): void;
}

export function apply(ctx: Context, config?: HostConfigInput): void {
  // tasks 2.3：宿主进程 Node 版本的直接观察证据（随激活日志输出）。
  console.log('[dsh-cona-project] host apply; node =', process.version, '; pid =', process.pid)
  // 宿主启动代际（tasks 6.2）：进程内常量；重启后新代际使全部旧活动绑定失效。
  bootGeneration = Date.now()
  ctx.plugin(ConaDiagnosticService)
  const toolAdapter = mountProjectServices(ctx, config ?? {})

  const tools = (ctx as Context & { tools?: ConaToolsRegistry }).tools
  if (tools === undefined) {
    throw new Error('cona_diag_context: host tools service unavailable (dsh.tools not mounted)')
  }
  tools.register({
    name: 'cona_diag_context',
    description: 'R1 diagnostic probe: reports the real ToolRunContext fields (agent/callId/signal) of this execution. Optional delayMs keeps the call in flight so queue/steer/cancel and late-result behavior can be observed. Read-only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        delayMs: {
          type: 'integer',
          description: 'Optional in-flight delay in milliseconds (0-30000, default 0) to observe queue/steer/cancel and late results.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agentId: { type: 'string' },
          callId: { type: 'string' },
          signalAbortedAtStart: { type: 'boolean' },
          signalAbortedAtEnd: { type: 'boolean' },
          waitedMs: { type: 'integer' },
          capturedAt: { type: 'string' },
        },
        required: ['capturedAt', 'waitedMs'],
      },
      render(_args, value) {
        const v = value as {
          capturedAt?: string
          agentId?: string
          callId?: string
          signalAbortedAtStart?: boolean
          signalAbortedAtEnd?: boolean
          waitedMs?: number
        }
        const lines = [
          `capturedAt: ${v.capturedAt ?? '(missing)'}`,
          `agentId: ${v.agentId ?? '(none)'}`,
          `callId: ${v.callId ?? '(none)'}`,
          `signalAbortedAtStart: ${v.signalAbortedAtStart === undefined ? '(none)' : String(v.signalAbortedAtStart)}`,
          `signalAbortedAtEnd: ${v.signalAbortedAtEnd === undefined ? '(none)' : String(v.signalAbortedAtEnd)}`,
          `waitedMs: ${v.waitedMs === undefined ? '(none)' : String(v.waitedMs)}`,
        ]
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const rawDelay = (args as { delayMs?: unknown } | undefined)?.delayMs
      const delayMs = typeof rawDelay === 'number' && Number.isInteger(rawDelay) && rawDelay >= 0 && rawDelay <= 30000
        ? rawDelay
        : 0
      const signal = exec.signal
      const startedAt = new Date()
      const signalAbortedAtStart = signal === undefined ? null : signal.aborted
      const started = Date.now()
      if (delayMs > 0 && signal?.aborted !== true) {
        // Abort 感知的等待：cancel/steer 打断时立即返回，让探针观察 signal 前后状态。
        await new Promise<void>((resolve) => {
          const timer = setTimeout(finish, delayMs)
          function finish(): void {
            clearTimeout(timer)
            signal?.removeEventListener?.('abort', finish)
            resolve()
          }
          signal?.addEventListener?.('abort', finish, { once: true })
        })
      }
      const waitedMs = Date.now() - started
      const observation: ConaToolObservation = {
        agentId: exec.agent === undefined ? null : String(exec.agent.id),
        callId: exec.callId === undefined ? null : String(exec.callId),
        signalAbortedAtStart,
        signalAbortedAtEnd: signal === undefined ? null : signal.aborted,
        waitedMs,
        capturedAt: startedAt.toISOString(),
      }
      toolObservations.push(observation)
      // 宿主日志留直接证据（客户端会话日志之外的第二条观察面）。
      console.log(
        `[dsh-cona-project] tool exec; agent=${observation.agentId ?? 'none'}`
        + ` callId=${observation.callId ?? 'none'}`
        + ` abortedAtStart=${String(observation.signalAbortedAtStart)}`
        + ` abortedAtEnd=${String(observation.signalAbortedAtEnd)}`
        + ` waitedMs=${waitedMs}`,
      )
      // 输出 schema 声明为可选字段；null 形态以字段缺失表达。
      const output: Record<string, unknown> = {
        capturedAt: observation.capturedAt,
        waitedMs: observation.waitedMs,
      }
      if (observation.agentId !== null) output['agentId'] = observation.agentId
      if (observation.callId !== null) output['callId'] = observation.callId
      if (observation.signalAbortedAtStart !== null) output['signalAbortedAtStart'] = observation.signalAbortedAtStart
      if (observation.signalAbortedAtEnd !== null) output['signalAbortedAtEnd'] = observation.signalAbortedAtEnd
      return output
    },
  })

  // 项目工具（tasks 6.3）：身份只来自真实 ToolRunContext；参数不含身份／授权字段。
  for (const definition of defineProjectTools(toolAdapter)) {
    tools.register(definition)
  }
  console.log('[dsh-cona-project] project tools registered: project_read / project_apply / project_record / project_receipt')
}

/**
 * 装配 `conaProject`（tasks 5.2）：配置 → 打开实例 → 快照／命令服务。
 * 打开失败只记录并可经 `status` 读到，不阻塞宿主启动；首次调用后结果被记忆。
 * 返回项目工具适配器（tasks 6.3）：与 Remote 共用同一 runtime promise。
 */
function mountProjectServices(ctx: Context, config: HostConfigInput): ProjectToolAdapter {
  const stream = new InMemoryChangeStream()
  const store = new LocalStateStore()
  // 与规划命令共享的每实例队列：聊天关联变更与资料命令在同一实例内串行（design §7）。
  const queue = new InstanceCommandQueue()
  const files = createSourceFiles(path.join(packageRootDir(), 'formats', 'v1'), sha256)
  const describe = (root: string): { displayPath: string } => ({ displayPath: describeRoot(root).displayPath })

  const resolveRuntime = async (): Promise<RuntimeResult> => {
    const resolved = resolveHostConfig(config)
    if (!resolved.ok) {
      return { ok: false, code: resolved.issues[0]?.code ?? 'cona-config-invalid', message: resolved.issues.map((issue) => issue.message).join('；') }
    }
    const wiring: HostWiring = {
      files,
      store,
      resolver: { resolveLocal: resolveLocalRoot, relation: rootRelation },
      git: { inspect: inspectPrivateRoot },
      sha256,
      clock,
      newInstanceId: () => randomUUID(),
      defaultLocalRoot: async () => defaultLocalRootDir(),
      describeLocation: describe,
    }
    const localState = createLocalStateService(wiring, ({ entry, aggregate }) => {
      stream.publish(
        notificationForRefresh(
          {
            instanceId: entry.instanceId,
            projectId: entry.projectId,
            sourceEpoch: entry.sourceGeneration,
            stateRevision: aggregate.revisions.state,
            planRevision: aggregate.revisions.plan,
          },
          clock(),
        ),
      )
    })
    const opened = await openConfiguredInstance(resolved.config, {
      files,
      store,
      sha256,
      clock,
      localState,
      defaultLocalRoot: async () => defaultLocalRootDir(),
      describeLocation: describe,
    })
    if (opened.status !== 'opened') {
      return {
        ok: false,
        code: opened.status === 'not-configured' ? 'binding-expired' : opened.code,
        message: opened.message,
      }
    }
    const instance = opened.instance
    // 会话目录（tasks 6.1）：cwd 绑定实例资料根；宿主 sessionController 缺失时用稳定拒绝的占位实现。
    const directoryResult = sessionDirectory(ctx, instance.sourceRoot)
    const directory = directoryResult.ok
      ? directoryResult.directory
      : unavailableSessionDirectory(directoryResult.message)
    if (!directoryResult.ok) {
      console.log(`[dsh-cona-project] 会话目录不可用（${directoryResult.message}）；聊天创建／关联将以稳定码拒绝`)
    }
    // 工作意图与活动 WorkRun（tasks 6.2）：与命令服务共享同一 planNodes 视图与队列。
    const work = new WorkService({
      localRoot: instance.localRoot,
      instanceId: instance.instanceId,
      store,
      planNodes: planNodeView(files, () => instance.sourceRoot, sha256, clock),
      clock,
      newWorkRunId: () => randomUUID(),
      newSuggestionId: () => randomUUID(),
      bootGeneration,
      queue,
    })
    const command = new ProjectCommandService({
      localRoot: instance.localRoot,
      store,
      files,
      sha256,
      clock,
      newNodeId: () => randomUUID(),
      newRecordId: () => randomUUID(),
      queue,
      work, // agent-work 上下文的有限范围准入与绑定版本推进（tasks 6.2）
      notify: (result, envelope) =>
        stream.publish(
          notificationForCommit(
            { instanceId: envelope.instanceId, projectId: envelope.projectId },
            result,
            clock(),
          ),
        ),
    })
    const chats = new ConversationService({
      localRoot: instance.localRoot,
      instanceId: instance.instanceId,
      store,
      directory,
      planNodes: planNodeView(files, () => instance.sourceRoot, sha256, clock),
      clock,
      newLinkId: () => randomUUID(),
      queue,
    })
    const snapshot = new ProjectSnapshotService({
      localRoot: instance.localRoot,
      store,
      files,
      sha256,
      clock,
      stream,
      describeLocation: describe,
    })
    return { ok: true, value: { instance, snapshot, command, chats, work } }
  }

  let runtime: Promise<RuntimeResult> | null = null
  const shared = (): Promise<RuntimeResult> => (runtime ??= resolveRuntime())

  ctx.plugin(ConaProjectService, {
    runtime: shared,
    localRootDisplay: (root: string) => describeRoot(root).displayPath,
  })

  // 启动即尝试打开一次：成功与失败都留一行宿主日志作为直接证据。
  void shared().then((result) => {
    console.log(
      result.ok
        ? `[dsh-cona-project] 实例 ${result.value.instance.instanceId} @ ${result.value.instance.sourceDisplay}（${result.value.instance.sourceKind}）`
        : `[dsh-cona-project] 资料源未打开（${result.code}: ${result.message}）`,
    )
  })

  return new ProjectToolAdapter({ runtime: shared })
}

// cordis inject 声明（Fiber 构造按 Inject.resolve(plugin.inject) 读取）：
// 'tools' 使 cordis 延迟 apply 至 dsh-tools 服务就绪，并放行 ctx.tools 属性访问
// （否则报 cannot get property "tools" without inject，2026-11-13 profile 实测）。
// host loader 可能以模块对象或 apply 函数两种形态登记插件，两层都声明。
;(apply as unknown as { inject: string[] }).inject = ['tools', 'sessionController']

export const inject = ['tools', 'sessionController']
