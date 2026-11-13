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
import { ConaDiagnosticService } from './diagnostic-service.js'

export const name = 'dsh-cona-project'

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

interface ConaToolExec {
  agent?: { readonly id: unknown };
  callId?: unknown;
  signal?: ConaAbortSignalLike;
}

/** 与 dsh-tools ToolDefinition 运行时形态对齐的最小结构（工具定义部分）。 */
interface ConaToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    additionalProperties: false;
    properties: Record<string, { type: string; description?: string; enum?: number[] }>;
    required?: string[];
  };
  output: {
    schema: {
      type: 'object';
      additionalProperties: false;
      properties: Record<string, { type: string }>;
      required?: string[];
    };
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>;
  };
  execute(args: unknown, exec: ConaToolExec): Promise<Record<string, string | boolean | number>>;
}

/** 与 dsh-tools Tools 服务运行时形态对齐的最小结构。 */
interface ConaToolsRegistry {
  register(definition: ConaToolDefinition): () => void;
}

export function apply(ctx: Context): void {
  // tasks 2.3：宿主进程 Node 版本的直接观察证据（随激活日志输出）。
  console.log('[dsh-cona-project] host apply; node =', process.version, '; pid =', process.pid)
  ctx.plugin(ConaDiagnosticService)

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
      const output: Record<string, string | boolean | number> = {
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
}

// cordis inject 声明（Fiber 构造按 Inject.resolve(plugin.inject) 读取）：
// 'tools' 使 cordis 延迟 apply 至 dsh-tools 服务就绪，并放行 ctx.tools 属性访问
// （否则报 cannot get property "tools" without inject，2026-11-13 profile 实测）。
// host loader 可能以模块对象或 apply 函数两种形态登记插件，两层都声明。
;(apply as unknown as { inject: string[] }).inject = ['tools']

export const inject = ['tools']
