// 分析作用域的纯决策逻辑（tasks 2.1-2.3，design「分析会话的执行器」「启动和恢复的提交顺序」）。
//
// 边界：本文件只做判定，不接触 cordis / 宿主服务，也不 import 任何外部包。
// 执行器选择、restrict/guard 的实际挂载由 host/analysis-scope.ts 的 cordis 薄壳完成；
// 本模块把「谁能调用、调用什么、什么时候能进模型」写成可独立测试的规则。
//
// 信任来源只能是 Host 绑定的事实（analysisId、实际 SessionId、请求标识、绑定版本），
// 不能来自工具参数里的身份字段。任何无法核对的输入一律拒绝（fail-closed）。

/** 分析会话允许的能力名（design「分析会话的执行器」）。 */
export const ANALYSIS_TOOL_NAMES = Object.freeze({
  /** 规划背景与索引（只读）。 */
  background: 'cona_analysis_background',
  /** 范围内文件列举与受限读取。 */
  scopeFiles: 'cona_analysis_scope_files',
  /** 同实例已校验验证记录正文读取。 */
  verification: 'cona_analysis_verification',
  /** 本机报告保存（仅本轮绑定可用）。 */
  saveReport: 'cona_analysis_save_report',
} as const);

export type AnalysisToolName = (typeof ANALYSIS_TOOL_NAMES)[keyof typeof ANALYSIS_TOOL_NAMES];

/** 全部允许名，供 restrict allow 与守卫允许集共用同一来源。 */
export const ANALYSIS_ALLOWED_TOOLS: readonly string[] = Object.freeze(Object.values(ANALYSIS_TOOL_NAMES));

/**
 * 分析绑定的最小事实。由 Host 在确认时建立，重启/换源后失效。
 * sessionId 是宿主实际返回的会话身份，不由调用方提供。
 */
export interface AnalysisBinding {
  readonly analysisId: string;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly requestId: string;
  /** 绑定版本；提交后推进，旧版本迟到调用一律拒绝。 */
  readonly version: number;
  /** 是否已持久化关联；未落盘不得派发首条消息或接受保存。 */
  readonly persisted: boolean;
  /** 执行器与守卫是否已核对就绪。 */
  readonly protected: boolean;
  /** 停止请求或真实终态之后不再接受任何分析调用。 */
  readonly terminal: boolean;
}

/** 守卫求值所需的最小调用事实，与 dsh-tools ToolExecution 的读取字段同构。 */
export interface AnalysisInvocation {
  readonly name?: unknown;
  readonly arguments?: unknown;
  /** 实际执行主体；Agent.id 即 SessionId。 */
  readonly agent?: { readonly id?: unknown } | null;
}

/** 首条分析消息的认领事实。 */
export interface AnalysisMessageClaim {
  readonly sessionId?: unknown;
  readonly requestId?: unknown;
}

export type Decision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string };

function deny(reason: string): Decision {
  return { kind: 'deny', reason };
}

/** 会话主体身份：Agent.id 就是 SessionId；缺失或类型不符不可信。 */
export function sessionIdOf(invocation: AnalysisInvocation): string | null {
  const id = invocation.agent?.id;
  return typeof id === 'string' && id !== '' ? id : null;
}

/**
 * 判断一次工具调用是否属于本轮分析绑定且在其允许集内。
 *
 * 检查顺序：绑定存在 → 已持久化 → 保护已建立 → 未终止 → 主体 Session 一致 →
 * 工具名在允许集内。参数中的 sessionId / instanceId / analysisId 一律不读：
 * 它们不能替代 Host 绑定（design「分析会话的执行器」）。
 */
export function decideAnalysisToolUse(
  binding: AnalysisBinding | undefined,
  invocation: AnalysisInvocation,
): Decision {
  if (binding === undefined) return deny('analysis-binding-missing');
  if (!binding.persisted) return deny('analysis-binding-not-persisted');
  if (!binding.protected) return deny('analysis-execution-unprotected');
  if (binding.terminal) return deny('analysis-terminal');
  const session = sessionIdOf(invocation);
  if (session === null) return deny('analysis-agent-unattributed');
  if (session !== binding.sessionId) return deny('analysis-session-mismatch');
  const name = invocation.name;
  if (typeof name !== 'string' || name === '') return deny('analysis-tool-unnamed');
  if (!ANALYSIS_ALLOWED_TOOLS.includes(name)) return deny(`analysis-tool-not-allowed:${name}`);
  return { kind: 'allow' };
}

/**
 * 首条分析消息的进入判定。确认请求标识与实际认领的 Session 必须同时匹配；
 * 任一不符拒绝入模型，避免同一步认领额外未登记消息。
 */
export function decideAnalysisStepEntry(
  binding: AnalysisBinding | undefined,
  claim: AnalysisMessageClaim,
): Decision {
  if (binding === undefined) return deny('analysis-binding-missing');
  if (!binding.persisted) return deny('analysis-binding-not-persisted');
  if (!binding.protected) return deny('analysis-execution-unprotected');
  if (binding.terminal) return deny('analysis-terminal');
  if (claim.sessionId !== binding.sessionId) return deny('analysis-session-mismatch');
  if (claim.requestId !== binding.requestId) return deny('analysis-request-mismatch');
  return { kind: 'allow' };
}

/**
 * 已保存终稿的保存重试判定：同 analysisId + requestId + 载荷哈希返回已有结果；
 * 异载荷报冲突。哈希由调用方对规范化载荷计算，本模块不解释载荷内容。
 */
export function decideSaveRetry(
  saved: { analysisId: string; requestId: string; payloadHash: string } | undefined,
  incoming: { analysisId: string; requestId: string; payloadHash: string },
): Decision {
  if (saved === undefined) return { kind: 'allow' };
  if (saved.analysisId !== incoming.analysisId || saved.requestId !== incoming.requestId) {
    return deny('analysis-save-target-mismatch');
  }
  if (saved.payloadHash !== incoming.payloadHash) return deny('analysis-save-payload-conflict');
  return deny('analysis-save-duplicate');
}
