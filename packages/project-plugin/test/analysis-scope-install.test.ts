// installAnalysisScope 的 keyless 安装测试（tasks 2.1-2.3）。
// 用最小 tools/on stub 验证：安装步骤完整、guard/restrict/pre-step 真的接上、
// 服务缺失/拒绝时 fail-closed、dispose 释放全部监听。真实 cordis 挂载属 H 分句。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import {
  apply,
  installAnalysisScope,
  preStepDecision,
  requestIdOf,
} from '../src/host/analysis-scope.js';
import {
  ANALYSIS_ALLOWED_TOOLS,
  type AnalysisBinding,
  type AnalysisInvocation,
} from '../src/host/analysis-guard.js';

type Guard = (execution: AnalysisInvocation) => string | undefined;
type StepListener = (payload: {
  agent?: { id?: unknown } | null;
  messages?: readonly { source?: { kind?: unknown; rpcId?: unknown } }[];
  step?: unknown;
}, next: () => Promise<{ kind: 'reject' } | { kind: 'enter'; messages: unknown[] }>) => Promise<{ kind: 'reject' } | { kind: 'enter'; messages: unknown[] }>;

interface Harness {
  ctx: Context;
  guards: Guard[];
  allowed: readonly string[] | null;
  steps: StepListener[];
  disposed: number;
}

function harness(opts: { noTools?: boolean; noOn?: boolean; restrictThrows?: boolean; guardThrows?: boolean } = {}): Harness {
  const guards: Guard[] = [];
  const steps: StepListener[] = [];
  let allowed: readonly string[] | null = null;
  let disposed = 0;
  const tools = opts.noTools ? undefined : {
    guard(g: Guard) { if (opts.guardThrows) throw new Error('guard refused'); guards.push(g); return () => { disposed++; }; },
    restrict(filter: { allow: readonly string[] }) {
      if (opts.restrictThrows) throw new Error('restrict refused');
      allowed = filter.allow;
      return () => { disposed++; };
    },
  };
  const raw: {
    tools?: unknown;
    on?: (event: string, listener: StepListener) => () => void;
  } = { ...(tools === undefined ? {} : { tools }) };
  if (!opts.noOn) {
    raw.on = (event: string, listener: StepListener) => {
      if (event !== 'agent/pre-step') throw new Error(`unexpected event ${event}`);
      steps.push(listener);
      return () => { disposed++; };
    };
  }
  return { ctx: raw as unknown as Context, guards, get allowed() { return allowed; }, steps, get disposed() { return disposed; } };
}

function binding(overrides: Partial<AnalysisBinding> = {}): AnalysisBinding {
  return {
    analysisId: 'a-1', sessionId: 'sess-1', instanceId: 'i-1', requestId: 'rpc-1',
    version: 1, persisted: true, protected: true, terminal: false, ...overrides,
  };
}

test('2.x-m 安装完整：restrict 允许集、guard、pre-step 全部接上，dispose 释放', () => {
  const h = harness();
  const current = { value: binding() };
  const install = installAnalysisScope(h.ctx, () => current.value);
  assert.equal(install.ready, true);
  assert.deepEqual([...h.allowed ?? []].sort(), [...ANALYSIS_ALLOWED_TOOLS].sort());
  assert.equal(h.guards.length, 1);
  assert.equal(h.steps.length, 1);
  install.dispose();
  assert.equal((h as { disposed: number }).disposed >= 3, true);
});

test('2.x-n guard 按运行时主体取绑定：正确 Session 允许，冒领/无绑定拒绝', () => {
  const h = harness();
  const current = { value: binding() };
  installAnalysisScope(h.ctx, (sid) => sid === current.value.sessionId ? current.value : undefined);
  const guard = h.guards[0]!;
  assert.equal(guard({ name: ANALYSIS_ALLOWED_TOOLS[0], agent: { id: 'sess-1' } }), undefined);
  assert.match(guard({ name: ANALYSIS_ALLOWED_TOOLS[0], agent: { id: 'sess-other' } }) ?? '', /analysis-binding-missing/);
  assert.match(guard({ name: 'bash', agent: { id: 'sess-1' } }) ?? '', /analysis-tool-not-allowed/);
});

test('2.x-o pre-step 只拦已登记分析会话的未认领消息；无绑定步骤放行', async () => {
  const h = harness();
  const current = { value: binding() };
  installAnalysisScope(h.ctx, (sid) => sid === 'sess-1' ? current.value : undefined);
  const step = h.steps[0]!;
  const next = async () => ({ kind: 'enter' as const, messages: [{ role: 'user' }] });
  const good = await step({ agent: { id: 'sess-1' }, messages: [{ source: { kind: 'user', rpcId: 'rpc-1' } }] }, next);
  assert.equal(good.kind, 'enter');
  const wrongRequest = await step({ agent: { id: 'sess-1' }, messages: [{ source: { kind: 'user', rpcId: 'rpc-2' } }] }, next);
  assert.equal(wrongRequest.kind, 'reject');
  const otherAgent = await step({ agent: { id: 'sess-other' }, messages: [{ source: { kind: 'user', rpcId: 'rpc-1' } }] }, next);
  assert.equal(otherAgent.kind, 'enter', '普通会话步骤不被分析 scope 拦截');
  const upstream = await step({ agent: { id: 'sess-1' } }, async () => ({ kind: 'reject' as const }));
  assert.equal(upstream.kind, 'reject', '宿主上游拒绝被尊重');
});

test('2.x-p 上游依赖缺失或安装失败时 ready=false，不留下半装状态', () => {
  const noTools = harness({ noTools: true });
  assert.equal(installAnalysisScope(noTools.ctx, () => undefined).ready, false);
  const noOn = harness({ noOn: true });
  assert.equal(installAnalysisScope(noOn.ctx, () => undefined).ready, false);
  const restrictFail = harness({ restrictThrows: true });
  assert.equal(installAnalysisScope(restrictFail.ctx, () => undefined).ready, false);
  const guardFail = harness({ guardThrows: true });
  assert.equal(installAnalysisScope(guardFail.ctx, () => undefined).ready, false);
  assert.equal(guardFail.guards.length, 0);
});

test('2.x-s 回合续步（step>1）放行；新回合第一步仍按请求标识认领；终态含续步都拒绝', async () => {
  const h = harness();
  const current = { value: binding() };
  installAnalysisScope(h.ctx, (sid) => (sid === 'sess-1' ? current.value : undefined));
  const step = h.steps[0]!;
  const next = async () => ({ kind: 'enter' as const, messages: [] });

  // 工具续步没有新的用户 rpcId，必须放行（否则一次工具调用就把回合拦死）。
  const continuation = await step({ agent: { id: 'sess-1' }, step: 2, messages: [{ source: { kind: 'model' } }] }, next);
  assert.equal(continuation.kind, 'enter');

  // 新回合第一步：错误请求标识仍拒绝。
  const wrong = await step({ agent: { id: 'sess-1' }, step: 1, messages: [{ source: { kind: 'user', rpcId: 'rpc-2' } }] }, next);
  assert.equal(wrong.kind, 'reject');
  const ok = await step({ agent: { id: 'sess-1' }, step: 1, messages: [{ source: { kind: 'user', rpcId: 'rpc-1' } }] }, next);
  assert.equal(ok.kind, 'enter');

  // 终态：第一步和迟到续步都拒绝。
  current.value = binding({ terminal: true });
  const terminalFirst = await step({ agent: { id: 'sess-1' }, step: 1, messages: [{ source: { kind: 'user', rpcId: 'rpc-1' } }] }, next);
  assert.equal(terminalFirst.kind, 'reject');
  const terminalContinuation = await step({ agent: { id: 'sess-1' }, step: 2, messages: [{ source: { kind: 'model' } }] }, next);
  assert.equal(terminalContinuation.kind, 'reject');
});

test('2.x-r apply 按 cordis effect 语义安装：保护保持到卸载，不立即释放', () => {
  const h = harness();
  const disposers: Array<() => void> = [];
  (h.ctx as unknown as { effect: (factory: () => () => void) => () => void }).effect = (factory) => {
    // cordis Fiber.effect 立即执行工厂并收集其返回的释放函数（真宿主语义）。
    const disposer = factory();
    disposers.push(disposer);
    return () => disposer();
  };
  apply(h.ctx);
  assert.equal(h.guards.length, 1, 'apply 后守卫必须仍在');
  assert.equal(h.steps.length, 1, 'apply 后 pre-step 必须仍在');
  assert.deepEqual([...(h.allowed ?? [])].sort(), [...ANALYSIS_ALLOWED_TOOLS].sort());
  assert.equal((h as { disposed: number }).disposed, 0, 'apply 不得立即释放保护');
  for (const dispose of disposers) dispose();
  assert.equal((h as { disposed: number }).disposed >= 3, true, '作用域卸载时才释放');
});

test('2.x-q 工具辅助：requestIdOf 只取 user 消息 rpcId，preStepDecision 转拒绝', () => {
  assert.equal(requestIdOf({ messages: [{ source: { kind: 'user', rpcId: 'r1' } }] }), 'r1');
  assert.equal(requestIdOf({ messages: [{ source: { kind: 'system', rpcId: 'r1' } }] }), null);
  assert.equal(requestIdOf({ messages: [{ source: { kind: 'user', rpcId: '' } }] }), null);
  assert.deepEqual(preStepDecision({ kind: 'deny', reason: 'x' }), { kind: 'reject' });
  assert.deepEqual(preStepDecision({ kind: 'allow' }), { kind: 'enter', messages: [] });
});
