// 分析作用域的 cordis 薄壳（tasks 2.1-2.3，design「分析会话的执行器」）。
//
// 本模块由 cordis.patch.yml 的 cona-project-analysis preset 作为子插件挂载，
// 运行在分析 Session 的 agent scope 内。职责：
//   1. 在该 scope 注册分析守卫：只允许 analysis-guard 定义的工具名，且只认 Host 绑定的 Session；
//   2. 安装 agent/pre-step：把首条请求与历史会话的新输入按 Host 绑定判定，拒绝未登记的进入；
//   3. 记录实际安装状态，任何一步无法建立都以 fail-closed 呈现（入口显示不可用）。
//
// 执行器由 preset 的兄弟子插件 @deepseek-ai/dsh-tool-executor-native 在同 scope 提供；
// 可见工具由宿主侧分析能力模块提供。本文件只 import 已声明依赖 cordis/dsh-tools，
// 不直接 import dsh-agent/dsh-agent-preset 的类型（其 .d.ts 会触发 face merge 冲突，
// 前因见 host/index.ts 注），全部用最小运行形态接口表达。

import type { Context } from '@deepseek-ai/cordis';
import {
  ANALYSIS_ALLOWED_TOOLS,
  decideAnalysisStepEntry,
  decideAnalysisToolUse,
  sessionIdOf,
  type AnalysisBinding,
  type AnalysisInvocation,
  type AnalysisMessageClaim,
  type Decision,
} from './analysis-guard.js';

/** 与 dsh-agent PreStepDecision 同构的最小形态；不从 dsh-agent 导入类型以避免 face merge 冲突。 */
type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: readonly unknown[] };

/** 宿主 tools 服务在本 scope 的最小形态（与 dsh-tools 运行时对齐）。 */
interface ToolsLike {
  guard(guard: (execution: AnalysisInvocation) => string | undefined): () => void;
  restrict(filter: { allow: readonly string[] }): () => void;
}

/** agent/pre-step 事件载荷的最小形态。 */
interface PreStepPayload {
  readonly agent?: { readonly id?: unknown } | null;
  readonly messages?: readonly {
    readonly source?: { readonly kind?: unknown; readonly rpcId?: unknown };
  }[];
}

/** 绑定提供者：按实际调用主体的 SessionId 取绑定；无绑定时给 undefined。 */
export type BindingProvider = (sessionId: string | undefined) => AnalysisBinding | undefined;

/** 请求标识提取：只认带 rpcId 的 user 消息，与 work-events 的同名规则一致。 */
export function requestIdOf(payload: PreStepPayload): string | null {
  const messages = payload.messages ?? [];
  for (const message of messages) {
    const source = message.source;
    if (source?.kind !== 'user') continue;
    const rpcId = source.rpcId;
    if (typeof rpcId === 'string' && rpcId !== '') return rpcId;
  }
  return null;
}

/** 把纯判定转成 host pre-step 需要的决策形态（拒绝不进模型）。 */
export function preStepDecision(decision: Decision): PreStepDecision {
  return decision.kind === 'allow' ? { kind: 'enter', messages: [] } : { kind: 'reject' };
}

export interface AnalysisScopeInstall {
  /** 释放守卫、restrict 与 pre-step 监听。 */
  dispose(): void;
  /** 安装是否完整；false 时入口必须显示分析执行不可用。 */
  readonly ready: boolean;
  /** ready=false 的原因。 */
  readonly refusal?: string;
}

/**
 * 在分析 agent scope 安装保护。ctx 必须已带 scope 标签（由 preset 挂载保证）；
 * 任一步失败都返回 ready=false 的可诊断结果，不抛出半装状态。
 */
export function installAnalysisScope(ctx: Context, bindingOf: BindingProvider): AnalysisScopeInstall {
  const disposers: Array<() => void> = [];
  // 用 unknown 中转，避开 cordis 对 'agent/pre-step' 的强类型 on 重载。
  const rawCtx = ctx as unknown as {
    tools?: ToolsLike;
    on?: (event: string, listener: (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>) => () => void;
  };
  const withCtx = rawCtx;
  if (withCtx.tools === undefined) {
    return { dispose: () => {}, ready: false, refusal: 'analysis-tools-service-missing' };
  }

  try {
    // 可见性限制：分析 scope 只暴露允许工具；restrict 在 scope 内是合法的。
    disposers.push(withCtx.tools.restrict({ allow: ANALYSIS_ALLOWED_TOOLS }));
  } catch (error) {
    return { dispose: () => disposers.forEach((d) => d()), ready: false, refusal: `analysis-restrict-failed:${(error as Error).message}` };
  }

  try {
    // 执行守卫：核对绑定与主体 Session，拒绝未在允许集内的任何调用。
    disposers.push(withCtx.tools.guard((execution) => {
      const invocation = execution as AnalysisInvocation;
      const decision = decideAnalysisToolUse(bindingOf(sessionIdOf(invocation) ?? undefined), invocation);
      return decision.kind === 'deny' ? decision.reason : undefined;
    }));
  } catch (error) {
    return { dispose: () => disposers.forEach((d) => d()), ready: false, refusal: `analysis-guard-failed:${(error as Error).message}` };
  }

  if (withCtx.on === undefined) {
    return { dispose: () => disposers.forEach((d) => d()), ready: false, refusal: 'analysis-prestep-unavailable' };
  }
  try {
    disposers.push(withCtx.on('agent/pre-step', async (payload, next) => {
      // 先让宿主原有步骤决策跑完；它拒绝则尊重其结论。
      const upstream = await next();
      if (upstream.kind !== 'enter') return upstream;
      const sessionId = typeof payload.agent?.id === 'string' ? payload.agent.id : undefined;
      const binding = bindingOf(sessionId);
      if (binding === undefined) {
        // 无分析绑定：普通工作步骤不被本 scope 拦截（分析 scope 只服务分析会话）。
        return upstream;
      }
      const claim: AnalysisMessageClaim = { sessionId: (payload.agent?.id) as string | undefined, requestId: requestIdOf(payload) ?? undefined };
      const decision = decideAnalysisStepEntry(binding, claim);
      return decision.kind === 'allow' ? upstream : preStepDecision(decision);
    }));
  } catch (error) {
    return { dispose: () => disposers.forEach((d) => d()), ready: false, refusal: `analysis-prestep-failed:${(error as Error).message}` };
  }

  return {
    dispose: () => disposers.forEach((d) => d()),
    ready: true,
  };
}

// ---------------------------------------------------------------------------
// 绑定注册表：Host 侧在用户确认分析时登记，preset 的 scope 模块按 Session 读取。
// 本注册表只存 Host 已核对的事实，不存调用方提供的身份；同一时刻可有多个实例。
// ---------------------------------------------------------------------------

const bindings = new Map<string, AnalysisBinding>();

/** Host 确认分析后登记绑定；覆盖同 Session 的旧绑定前须由调用方确认终止。 */
export function registerAnalysisBinding(binding: AnalysisBinding): void {
  bindings.set(binding.sessionId, binding);
}

/** 释放绑定（正常完成、中断、换源、重启代际失效时调用）。 */
export function releaseAnalysisBinding(sessionId: string): void {
  bindings.delete(sessionId);
}

/** 按实际 SessionId 读取绑定：scope 模块只用它，不接受参数里的身份。 */
export function bindingForSession(sessionId: string | undefined): AnalysisBinding | undefined {
  return sessionId === undefined ? undefined : bindings.get(sessionId);
}

/** cordis 插件入口：preset 子插件在分析 agent scope 内挂载。 */
export const name = 'cona-project-analysis-scope';

/** 需要 tools 服务在 scope 内就绪后再装守卫。 */
export const inject = ['tools'];

/**
 * apply 在安装 scope 上装保护。绑定按每次调用的运行时主体 SessionId 读取注册表；
 * 主体不可判定时以空绑定 fail-closed——守卫拒绝所有分析工具调用，pre-step 不拦截普通步骤。
 */
export function apply(ctx: Context): void {
  // 绑定不按构建期 scope key 选择，而按每次调用的运行时主体 SessionId 选择：
  // 守卫用 ToolExecution.agent.id，pre-step 用 payload.agent.id。这样同一 preset
  // 在多个分析 Session 上挂载时不会串绑，也无法用参数里的身份冒领。
  const install = installAnalysisScope(ctx, bindingForSession);
  if (!install.ready) {
    console.warn(`[cona-project-analysis] 分析执行不可用（${install.refusal ?? 'unknown'}）`);
  } else {
    console.log('[cona-project-analysis] 分析作用域保护已建立');
  }
  // cordis 插件的清理：作用域卸载时自动释放守卫/restrict/pre-step。
  (ctx as Context & { effect?: (fn: () => void) => void }).effect?.(() => install.dispose());
}
