// R1 最小诊断插件入口（tasks 2.2 / 2.4）：
// Host ESM 入口 + cordis.patch.yml 插件行引用的模块。
// apply 内装配诊断 Remote 服务与无 invocation 的 ToolRunContext 探针工具。

import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
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

export function apply(ctx: Context): void {
  ctx.plugin(ConaDiagnosticService)

  ctx.tools.register(defineTool({
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
          capturedAt: { type: 'string', required: true },
        },
      },
    },
    execute(_args, exec) {
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
  }))
}
