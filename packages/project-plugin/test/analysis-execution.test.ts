// Host 侧执行前核对（tasks 2.2-2.3）的 keyless 测试：
// 执行器必须是原生执行器、可见集恰为四个允许能力、守卫按实际 Session 生效、
// 绑定已持久化未终止。任何一项不成立都必须 ready=false 并给出原因，
// 供 Host 在派发首条分析消息前 fail-closed。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyAnalysisExecution,
  type AnalysisExecutionTools,
} from '../src/host/analysis-execution.js';
import {
  ANALYSIS_ALLOWED_TOOLS,
  type AnalysisBinding,
  type AnalysisInvocation,
} from '../src/host/analysis-guard.js';

class NativeToolExecutor {}
class PtcExecutor {}

function binding(overrides: Partial<AnalysisBinding> = {}): AnalysisBinding {
  return {
    analysisId: 'a-1', sessionId: 'sess-1', instanceId: 'i-1', requestId: 'rpc-1',
    version: 1, persisted: true, protected: false, terminal: false, ...overrides,
  };
}

interface StubOptions {
  readonly visible?: readonly string[];
  readonly executor?: unknown | (() => never);
  readonly noSelectExecutor?: boolean;
  readonly noCheckGuards?: boolean;
  readonly guard?: (name: string) => string | { reason: string } | undefined;
  readonly definitionsThrows?: boolean;
}

function tools(opts: StubOptions = {}): AnalysisExecutionTools {
  const visible = opts.visible ?? ANALYSIS_ALLOWED_TOOLS;
  const guard = opts.guard ?? ((name) => (name === 'bash' ? 'analysis-tool-not-allowed:bash' : undefined));
  const stub: AnalysisExecutionTools = {
    definitions() {
      if (opts.definitionsThrows) throw new Error('definitions failed');
      return visible.map((name) => ({ name }));
    },
  };
  const withOptional = stub as AnalysisExecutionTools & {
    selectExecutor?: (agent: unknown) => unknown;
    checkGuards?: (execution: AnalysisInvocation & { callId?: string }) => unknown;
  };
  if (!opts.noSelectExecutor) {
    withOptional.selectExecutor = () => {
      if (typeof opts.executor === 'function') return (opts.executor as () => never)();
      return opts.executor ?? new NativeToolExecutor();
    };
  }
  if (!opts.noCheckGuards) {
    withOptional.checkGuards = (execution) => guard(String(execution.name));
  }
  return stub;
}

const agent = { id: 'sess-1' };

test('2.x-t 核对通过：原生执行器、恰好四个可见能力、守卫按 Session 生效', () => {
  assert.deepEqual(verifyAnalysisExecution(tools(), agent, binding()), { ready: true });
});

test('2.x-u 保护标志尚未提交是预期中间态（守卫返回 unprotected 仍视为可用）', () => {
  const current = tools({ guard: () => 'analysis-execution-unprotected' });
  assert.deepEqual(verifyAnalysisExecution(current, agent, binding()), { ready: true });
});

test('2.x-v 绑定缺失、未持久化、已终止或 Session 不符一律拒绝', () => {
  assert.equal(verifyAnalysisExecution(tools(), agent, undefined).refusal, 'analysis-binding-missing');
  assert.equal(verifyAnalysisExecution(tools(), agent, binding({ persisted: false })).refusal, 'analysis-binding-not-persisted');
  assert.equal(verifyAnalysisExecution(tools(), agent, binding({ terminal: true })).refusal, 'analysis-terminal');
  assert.equal(verifyAnalysisExecution(tools(), agent, binding({ sessionId: 'sess-other' })).refusal, 'analysis-session-mismatch');
  assert.equal(verifyAnalysisExecution(tools(), { id: '' }, binding()).refusal, 'analysis-agent-unattributed');
});

test('2.x-w 执行器无法核对、缺失、抛错或不是原生执行器时拒绝', () => {
  assert.equal(
    verifyAnalysisExecution(tools({ noSelectExecutor: true }), agent, binding()).refusal,
    'analysis-executor-unverifiable',
  );
  assert.equal(
    verifyAnalysisExecution(tools({ executor: () => { throw new Error('unavailable'); } }), agent, binding()).refusal,
    'analysis-executor-unavailable:unavailable',
  );
  assert.match(
    verifyAnalysisExecution(tools({ executor: new PtcExecutor() }), agent, binding()).refusal ?? '',
    /^analysis-executor-not-native:PtcExecutor$/,
  );
});

test('2.x-x 可见工具多了继承项或少了允许能力时拒绝并指出差值', () => {
  const extra = [...ANALYSIS_ALLOWED_TOOLS, 'bash'];
  const extraCheck = verifyAnalysisExecution(tools({ visible: extra }), agent, binding());
  assert.match(extraCheck.refusal ?? '', /^analysis-tools-mismatch:unexpected=bash$/);

  const missing = ANALYSIS_ALLOWED_TOOLS.slice(1);
  const missingCheck = verifyAnalysisExecution(tools({ visible: missing }), agent, binding());
  assert.match(missingCheck.refusal ?? '', /^analysis-tools-mismatch:missing=cona_analysis_background$/);

  const unreadable = verifyAnalysisExecution(tools({ definitionsThrows: true }), agent, binding());
  assert.match(unreadable.refusal ?? '', /^analysis-tools-unreadable:/);
});

test('2.x-y 守卫缺失、误拒允许工具、取不到绑定或来源不明时拒绝', () => {
  assert.equal(
    verifyAnalysisExecution(tools({ noCheckGuards: true }), agent, binding()).refusal,
    'analysis-guard-unverifiable',
  );
  assert.equal(
    verifyAnalysisExecution(tools({ guard: () => undefined }), agent, binding()).refusal,
    'analysis-guard-missing',
  );
  assert.match(
    verifyAnalysisExecution(tools({ guard: (name) => (name === 'bash' ? 'analysis-tool-not-allowed:bash' : 'analysis-session-mismatch') }), agent, binding()).refusal ?? '',
    /^analysis-guard-denied:cona_analysis_background:analysis-session-mismatch$/,
  );
  assert.match(
    verifyAnalysisExecution(tools({ guard: (name) => (name === 'bash' ? 'analysis-binding-missing' : undefined) }), agent, binding()).refusal ?? '',
    /^analysis-binding-not-registered:analysis-binding-missing$/,
  );
  assert.match(
    verifyAnalysisExecution(tools({ guard: (name) => (name === 'bash' ? 'some-other-guard' : undefined) }), agent, binding()).refusal ?? '',
    /^analysis-guard-unknown:some-other-guard$/,
  );
});
