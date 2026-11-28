// 2.x 分析作用域守卫的纯逻辑测试（design「分析会话的执行器」「启动和恢复的提交顺序」）。
// 覆盖：允许集、绑定前置条件、Session 身份隔离、参数身份不被信任、首消息认领、
// 历史会话拒绝、保存重试同载荷/异载荷。真实 cordis 挂载与宿主执行器属 H 分句。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYSIS_ALLOWED_TOOLS,
  ANALYSIS_TOOL_NAMES,
  decideAnalysisStepEntry,
  decideAnalysisToolUse,
  decideSaveRetry,
  type AnalysisBinding,
} from '../src/host/analysis-guard.js';

function binding(overrides: Partial<AnalysisBinding> = {}): AnalysisBinding {
  return {
    analysisId: 'a-1',
    sessionId: 'sess-real',
    instanceId: 'inst-1',
    requestId: 'rpc-1',
    version: 1,
    persisted: true,
    protected: true,
    terminal: false,
    ...overrides,
  };
}

const allowedCall = {
  name: ANALYSIS_TOOL_NAMES.scopeFiles,
  agent: { id: 'sess-real' },
};

test('2.x-f 允许集只含分析能力，写入/执行入口不在其中', () => {
  assert.deepEqual([...ANALYSIS_ALLOWED_TOOLS].sort(), [
    ANALYSIS_TOOL_NAMES.background,
    ANALYSIS_TOOL_NAMES.saveReport,
    ANALYSIS_TOOL_NAMES.scopeFiles,
    ANALYSIS_TOOL_NAMES.verification,
  ].sort());
  for (const name of ['bash', 'write', 'edit', 'run_code', 'cona_project_apply']) {
    assert.equal(ANALYSIS_ALLOWED_TOOLS.includes(name), false, `${name} 不得在分析允许集内`);
  }
});

test('2.x-g 绑定未持久化/未保护/已终止时拒绝所有调用（fail-closed）', () => {
  assert.equal(decideAnalysisToolUse(undefined, allowedCall).kind, 'deny');
  assert.equal(decideAnalysisToolUse(binding({ persisted: false }), allowedCall).kind, 'deny');
  assert.equal(decideAnalysisToolUse(binding({ protected: false }), allowedCall).kind, 'deny');
  assert.equal(decideAnalysisToolUse(binding({ terminal: true }), allowedCall).kind, 'deny');
  assert.equal(decideAnalysisToolUse(binding(), allowedCall).kind, 'allow');
});

test('2.x-h 只认实际 Agent 身份；参数里的 sessionId 不能冒领', () => {
  const forged = { ...allowedCall, arguments: { sessionId: 'sess-real', analysisId: 'a-1' } };
  assert.equal(decideAnalysisToolUse(binding(), { ...forged, agent: { id: 'sess-other' } }).kind, 'deny');
  assert.equal(decideAnalysisToolUse(binding(), { ...forged, agent: undefined }).kind, 'deny');
  assert.equal(decideAnalysisToolUse(binding(), forged).kind, 'allow');
});

test('2.x-i 未允许工具在正文前被拒，含局部注册名与同名写入', () => {
  for (const name of ['bash', 'write', 'run_code', 'cona_project_apply', 'cona_diag_context']) {
    const decision = decideAnalysisToolUse(binding(), { name, agent: { id: 'sess-real' } });
    assert.equal(decision.kind, 'deny', `${name} 应被拒绝`);
    assert.match(decision.kind === 'deny' ? decision.reason : '', /analysis-tool-not-allowed/);
  }
});

test('2.x-j 首条消息认领：Session 与请求标识都匹配才入模型', () => {
  assert.equal(decideAnalysisStepEntry(binding(), { sessionId: 'sess-real', requestId: 'rpc-1' }).kind, 'allow');
  assert.equal(decideAnalysisStepEntry(binding(), { sessionId: 'sess-other', requestId: 'rpc-1' }).kind, 'deny');
  assert.equal(decideAnalysisStepEntry(binding(), { sessionId: 'sess-real', requestId: 'rpc-2' }).kind, 'deny');
  assert.equal(decideAnalysisStepEntry(binding({ terminal: true }), { sessionId: 'sess-real', requestId: 'rpc-1' }).kind, 'deny');
});

test('2.x-k 未完成绑定不派发首条消息（未登记 Session 不发送）', () => {
  assert.equal(decideAnalysisStepEntry(binding({ persisted: false }), { sessionId: 'sess-real', requestId: 'rpc-1' }).kind, 'deny');
  assert.equal(decideAnalysisStepEntry(binding({ protected: false }), { sessionId: 'sess-real', requestId: 'rpc-1' }).kind, 'deny');
});

test('2.x-l 保存重试：同号同载荷幂等、异载荷冲突、错目标拒绝', () => {
  const saved = { analysisId: 'a-1', requestId: 'rpc-1', payloadHash: 'h-1' };
  const duplicate = decideSaveRetry(saved, { ...saved });
  assert.equal(duplicate.kind, 'deny');
  assert.equal(duplicate.kind === 'deny' ? duplicate.reason : '', 'analysis-save-duplicate');
  assert.equal(decideSaveRetry(saved, { ...saved, payloadHash: 'h-2' }).kind, 'deny');
  assert.equal(decideSaveRetry(saved, { ...saved, requestId: 'rpc-2' }).kind, 'deny');
  assert.equal(decideSaveRetry(undefined, { ...saved }).kind, 'allow');
});
