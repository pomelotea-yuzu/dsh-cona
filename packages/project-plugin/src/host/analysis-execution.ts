// 分析首次派发前的 Host 侧核对（tasks 2.2-2.3，design「分析会话的执行器」
// 「启动和恢复的提交顺序」）。
//
// 背景（真宿主 DSH 0.2.2-rc.2 实测）：分析 preset 在 preset 作用域装 restrict/guard/
// pre-step，分析能力工具由 Host 注册在分析 Session 自己的 agent scope；原生执行器由
// preset 的兄弟子插件在 preset 作用域提供。Host 在发送首条分析消息前必须确认：
//   1. 实际执行器是原生执行器，而不是部署默认的 PTC 等通用执行器；
//   2. 该 Session 可见的工具恰为四个允许能力，既没漏注册也没多出继承工具；
//   3. 守卫对未允许工具确实拒绝、对允许工具不误拒；
//   4. 绑定已持久化且未终止。
// 任何一项无法核对都返回 ready=false 及具体原因；Host 不得派发分析消息。
//
// `selectExecutor` 在 rc.2 是 `ToolsService` 的实例私有方法（`packages/core/tools/
// src/index.ts`），没有公开读取入口。本仓固定宿主版本，因此以最小运行形态接口读取并
// 严格按 `NativeToolExecutor` 类名核对；方法缺失时 fail-closed，不回退到「大概能用」。

import {
  ANALYSIS_ALLOWED_TOOLS,
  type AnalysisBinding,
} from './analysis-guard.js';

/** 核对用的最小 tools 服务形态；字段与 rc.2 运行时一致。 */
export interface AnalysisExecutionTools {
  /** 该 Agent 视图下的可见工具定义。 */
  definitions(agent: unknown): readonly { readonly name?: unknown }[];
  /** 可选的守卫检查；缺失时视为守卫无法核对。 */
  checkGuards?(execution: {
    readonly agent?: unknown;
    readonly name?: unknown;
    readonly arguments?: unknown;
    readonly callId?: string;
  }): unknown;
  /**
   * rc.2 的私有执行器选择入口。固定宿主版本内存在；缺失或抛错都按无法核对处理。
   */
  selectExecutor?(agent: unknown): unknown;
}

/** Host 侧核对结论；ready=false 时 refusal 说明原因。 */
export interface AnalysisExecutionCheck {
  readonly ready: boolean;
  readonly refusal?: string;
}

/** 原生执行器的类名（rc.2 `@deepseek-ai/dsh-tool-executor-native`）。 */
const NATIVE_EXECUTOR_NAME = 'NativeToolExecutor';

function refusal(reason: string): AnalysisExecutionCheck {
  return { ready: false, refusal: reason };
}

/** 取守卫拒绝原因；兼容字符串与 {reason} 两种宿主形态。 */
function denialReason(denial: unknown): string | undefined {
  if (denial === undefined) return undefined;
  if (typeof denial === 'string') return denial;
  if (typeof denial === 'object' && denial !== null) {
    const reason = (denial as { reason?: unknown }).reason;
    if (typeof reason === 'string') return reason;
  }
  return 'unknown';
}

/**
 * 在首条分析消息派发前核对实际执行路径。只读，不注册、不执行工具。
 *
 * @param tools - 宿主 tools 服务（或同形测试替身）。
 * @param agent - 分析 Session 的实际 Agent（其 id 即 SessionId）。
 * @param binding - Host 已登记的绑定；应在核对通过后才把 protected 置为 true。
 * @returns ready=true 或带原因的可诊断结论。
 */
export function verifyAnalysisExecution(
  tools: AnalysisExecutionTools,
  agent: unknown,
  binding: AnalysisBinding | undefined,
): AnalysisExecutionCheck {
  if (binding === undefined) return refusal('analysis-binding-missing');
  if (!binding.persisted) return refusal('analysis-binding-not-persisted');
  if (binding.terminal) return refusal('analysis-terminal');
  const agentId = (agent as { id?: unknown } | null | undefined)?.id;
  if (typeof agentId !== 'string' || agentId === '') return refusal('analysis-agent-unattributed');
  if (agentId !== binding.sessionId) return refusal('analysis-session-mismatch');

  // 1. 实际执行器：必须是原生执行器，避免 PTC 程序正文绕过工具守卫。
  if (typeof tools.selectExecutor !== 'function') return refusal('analysis-executor-unverifiable');
  let executor: unknown;
  try {
    executor = tools.selectExecutor(agent);
  } catch (error) {
    return refusal(`analysis-executor-unavailable:${(error as Error).message}`);
  }
  const executorName = (executor as { constructor?: { name?: unknown } } | null | undefined)
    ?.constructor?.name;
  if (executorName !== NATIVE_EXECUTOR_NAME) {
    return refusal(`analysis-executor-not-native:${typeof executorName === 'string' ? executorName : 'unknown'}`);
  }

  // 2. 可见工具：精确等于允许集，证明 restrict 生效且四个能力注册在本 Session 的 scope。
  let visible: string[];
  try {
    visible = tools.definitions(agent).map((definition) =>
      typeof definition.name === 'string' ? definition.name : '');
  } catch (error) {
    return refusal(`analysis-tools-unreadable:${(error as Error).message}`);
  }
  const expected = [...ANALYSIS_ALLOWED_TOOLS].sort();
  const actual = [...visible].sort();
  if (expected.join('\u0000') !== actual.join('\u0000')) {
    const missing = expected.filter((name) => !actual.includes(name));
    const unexpected = actual.filter((name) => !expected.includes(name));
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing=${missing.join(',')}`);
    if (unexpected.length > 0) parts.push(`unexpected=${unexpected.join(',')}`);
    return refusal(`analysis-tools-mismatch:${parts.join(';')}`);
  }

  // 3. 守卫：确认守卫已装、绑定在该作用域注册表里可按实际 Session 取到，
  // 且允许工具不会被误拒（保护标志尚未提交时，守卫会给
  // `analysis-execution-unprotected`，这是预期中间态，不是失败）。
  if (typeof tools.checkGuards !== 'function') return refusal('analysis-guard-unverifiable');
  const probe = (name: string) =>
    denialReason(tools.checkGuards!({
      // 必须传真实 Agent 对象：守卫按检查对象的作用域链定位安装层，
      // 只传 {id} 的普通对象会找不到分析作用域的守卫（真宿主实测）。
      agent,
      name,
      arguments: {},
      callId: `analysis-verify:${name}`,
    }));
  for (const name of expected) {
    const denial = probe(name);
    if (denial !== undefined && denial !== 'analysis-execution-unprotected') {
      return refusal(`analysis-guard-denied:${name}:${denial}`);
    }
  }
  const disallowed = probe('bash');
  if (disallowed === undefined) return refusal('analysis-guard-missing');
  // 绑定未登记时守卫先返回 binding-missing/mismatch，说明 Host 与作用域注册表不一致；
  // 其他 `analysis-*` 拒绝都证明守卫已按实际 Session 求值。
  if (
    disallowed === 'analysis-binding-missing'
    || disallowed === 'analysis-agent-unattributed'
    || disallowed === 'analysis-session-mismatch'
  ) {
    return refusal(`analysis-binding-not-registered:${disallowed}`);
  }
  if (!disallowed.startsWith('analysis-')) {
    return refusal(`analysis-guard-unknown:${disallowed}`);
  }

  return { ready: true };
}
