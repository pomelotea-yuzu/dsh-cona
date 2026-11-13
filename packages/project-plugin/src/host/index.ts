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
  /** exec.signal 状态；缺失记 null。 */
  signalAborted: boolean | null;
  /** 捕获时间（UTC instant 字符串）。 */
  capturedAt: string;
}

/** 真实工具执行时捕获的 ToolRunContext 形态（内存态，仅供诊断会话读取）。 */
export const toolObservations: ConaToolObservation[] = []

/** 与 dsh-tools ToolRunContext 运行时形态对齐的最小结构（仅探针所需字段）。 */
interface ConaToolExec {
  agent?: { readonly id: unknown };
  callId?: unknown;
  signal?: { readonly aborted: boolean };
}

/** 与 dsh-tools ToolDefinition 运行时形态对齐的最小结构（工具定义部分）。 */
interface ConaToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, never>;
  output: {
    schema: {
      type: 'object';
      additionalProperties: false;
      properties: Record<string, { type: string }>;
      required?: string[];
    };
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>;
  };
  execute(args: unknown, exec: ConaToolExec): Promise<Record<string, string | boolean>>;
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
    description: 'R1 diagnostic probe: reports the real ToolRunContext fields (agent/callId/signal) of this execution. Read-only.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agentId: { type: 'string' },
          callId: { type: 'string' },
          signalAborted: { type: 'boolean' },
          capturedAt: { type: 'string' },
        },
        required: ['capturedAt'],
      },
      render(_args, value) {
        const v = value as {
          capturedAt?: string
          agentId?: string
          callId?: string
          signalAborted?: boolean
        }
        const lines = [
          `capturedAt: ${v.capturedAt ?? '(missing)'}`,
          `agentId: ${v.agentId ?? '(none)'}`,
          `callId: ${v.callId ?? '(none)'}`,
          `signalAborted: ${v.signalAborted === undefined ? '(none)' : String(v.signalAborted)}`,
        ]
        return [{ type: 'text' as const, text: lines.join('\n') }]
      },
    },
    async execute(_args, exec) {
      const observation: ConaToolObservation = {
        agentId: exec.agent === undefined ? null : String(exec.agent.id),
        callId: exec.callId === undefined ? null : String(exec.callId),
        signalAborted: exec.signal === undefined ? null : exec.signal.aborted,
        capturedAt: new Date().toISOString(),
      }
      toolObservations.push(observation)
      // 输出 schema 声明为可选 string 字段；null 形态以字段缺失表达。
      const output: Record<string, string | boolean> = { capturedAt: observation.capturedAt }
      if (observation.agentId !== null) output['agentId'] = observation.agentId
      if (observation.callId !== null) output['callId'] = observation.callId
      if (observation.signalAborted !== null) output['signalAborted'] = observation.signalAborted
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
