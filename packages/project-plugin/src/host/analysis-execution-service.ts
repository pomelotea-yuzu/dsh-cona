// 分析执行保护端口的宿主实现（tasks 4.4）：把「注册四个能力 → 登记活动绑定 →
// 核对原生执行器/可见集/守卫」串成派发前的单一步骤。
//
// 能力注册由 AnalysisCapabilityPort 提供（第 5 组实现真实工具）；本文件只负责
// 顺序、幂等与 fail-closed。绑定登记进 analysis-scope 的注册表，守卫按实际
// SessionId 取值；错误 Session、终端绑定或无绑定调用都由 analysis-guard 拒绝。

import type { Context } from '@deepseek-ai/cordis'
import { registerAnalysisBinding, releaseAnalysisBinding } from './analysis-scope.js'
import { verifyAnalysisExecution } from './analysis-execution.js'
import { agentPromptAccepted } from './analysis-execution-port.js'
import type { AnalysisCapabilityPort, AnalysisExecutionPort } from '../application/ports.js'
import type { AnalysisRecord } from '../application/local-state.js'

interface AgentsLike {
  get(sessionId: string): unknown
}
interface ToolsLike {
  definitions(agent: unknown): readonly { readonly name?: unknown }[]
  checkGuards?(execution: {
    readonly agent?: unknown
    readonly name?: unknown
    readonly arguments?: unknown
    readonly callId?: string
  }): unknown
  selectExecutor?(agent: unknown): unknown
}

export interface AnalysisExecutionServiceDeps {
  readonly capabilities: AnalysisCapabilityPort
}

/** 能力未实现时的占位：拒绝派发，不注册任何工具。 */
export function unavailableAnalysisCapabilityPort(message: string): AnalysisCapabilityPort {
  return {
    async register() {
      return { ok: false as const, code: 'analysis-capabilities-unavailable', message }
    },
  }
}

/**
 * 组装分析执行端口。prepare 对同一 (analysisId, sessionId) 只注册一次能力；
 * 每次调用都重新登记绑定并核对，避免依赖上一次的缓存状态。
 */
export function createAnalysisExecutionPort(
  ctx: Context,
  deps: AnalysisExecutionServiceDeps,
): AnalysisExecutionPort {
  const context = ctx as Context & { get?: <T>(name: string) => T | undefined }
  const get = <T>(name: string): T | undefined =>
    typeof context.get === 'function' ? context.get<T>(name) : undefined
  const agents = get<AgentsLike>('agents') ?? (ctx as Context & { agents?: AgentsLike }).agents
  const tools = get<ToolsLike>('tools') ?? (ctx as Context & { tools?: ToolsLike }).tools
  const promptAccepted = agentPromptAccepted(ctx)
  const registered = new Set<string>()

  return {
    async prepare(record: AnalysisRecord) {
      if (record.sessionId === null) {
        return { ready: false as const, code: 'analysis-session-missing', message: '分析记录还没有实际 Session' }
      }
      const agent = agents?.get(record.sessionId)
      if (agent === undefined) {
        return { ready: false as const, code: 'analysis-agent-missing', message: '宿主无法取到该分析 Session 的 Agent' }
      }
      const registrationKey = `${record.analysisId}:${record.sessionId}`
      if (!registered.has(registrationKey)) {
        const capability = await deps.capabilities.register({ agent, record })
        if (!capability.ok) return { ready: false as const, code: capability.code, message: capability.message }
        registered.add(registrationKey)
      }
      const binding = {
        analysisId: record.analysisId,
        sessionId: record.sessionId,
        instanceId: record.instanceId,
        requestId: record.requestId,
        version: record.binding?.version ?? 1,
        persisted: true,
        protected: true,
        terminal: false,
      }
      registerAnalysisBinding(binding)
      if (tools === undefined) {
        releaseAnalysisBinding(record.sessionId)
        return { ready: false as const, code: 'analysis-tools-unavailable', message: '宿主未提供 tools 服务' }
      }
      const check = verifyAnalysisExecution(tools, agent, binding)
      if (!check.ready) {
        // 核对失败不得留下可被守卫接受的绑定。
        releaseAnalysisBinding(record.sessionId)
        return {
          ready: false as const,
          code: 'analysis-execution-unavailable',
          message: check.refusal ?? '分析执行核对失败',
        }
      }
      return { ready: true as const }
    },
    promptAccepted,
  }
}
