// 分析执行保护端口测试（tasks 4.4）：能力注册 → 活动绑定登记 → 执行器/可见集/守卫核对；
// 失败必须释放绑定并拒绝派发。用真实 analysis-guard 判定与真实绑定注册表。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { createAnalysisExecutionPort, unavailableAnalysisCapabilityPort } from '../src/host/analysis-execution-service.js';
import { bindingForSession, releaseAnalysisBinding } from '../src/host/analysis-scope.js';
import { ANALYSIS_ALLOWED_TOOLS, decideAnalysisToolUse } from '../src/host/analysis-guard.js';
import type { AnalysisRecord } from '../src/application/local-state.js';
import type { AnalysisCapabilityPort } from '../src/application/ports.js';

class NativeToolExecutor {}
class PtcExecutor {}

function record(overrides: Partial<AnalysisRecord> = {}): AnalysisRecord {
  return {
    analysisId: 'analysis-1',
    instanceId: 'inst-1',
    repositoryId: 'repo',
    repositoryRoot: '/repo',
    mappingHash: 'hash',
    sourceGeneration: 1,
    scope: { kind: 'root' },
    planVersion: 'plan-v1',
    planRevision: 0,
    observation: { fingerprint: 'f', complete: true, observedAt: 'now', entries: 1, issues: 0 },
    requestId: 'rpc-1',
    sessionId: 'session-1',
    agentPreset: 'cona-project-analysis',
    status: 'created',
    binding: { persisted: true, protected: false, terminal: false, version: 1 },
    createdAt: 'now',
    updatedAt: 'now',
    ...overrides,
  };
}

function harness(options: { extraTool?: boolean; executor?: unknown; agentMissing?: boolean; events?: unknown[] } = {}) {
  let registered = 0;
  let capabilityError: { code: string; message: string } | null = null;
  const capabilities: AnalysisCapabilityPort = {
    async register() {
      registered += 1;
      return capabilityError === null
        ? { ok: true as const }
        : { ok: false as const, code: capabilityError.code, message: capabilityError.message };
    },
  };
  const tools = {
    definitions() {
      return [...ANALYSIS_ALLOWED_TOOLS, ...(options.extraTool === true ? ['bash'] : [])].map((name) => ({ name }));
    },
    selectExecutor() {
      return options.executor ?? new NativeToolExecutor();
    },
    checkGuards(exec: { agent?: unknown; name?: unknown }) {
      const sessionId = (exec.agent as { id?: unknown } | undefined)?.id;
      const binding = bindingForSession(typeof sessionId === 'string' ? sessionId : undefined);
      const decision = decideAnalysisToolUse(binding, exec as never);
      return decision.kind === 'deny' ? decision.reason : undefined;
    },
  };
  const ctx = {
    get(name: string) {
      if (name === 'tools') return tools;
      if (name === 'agents') {
        return {
          get(sessionId: string) {
            if (options.agentMissing === true) return undefined;
            return {
              id: sessionId,
              session: { snapshotEvents: () => options.events ?? [] },
            };
          },
        };
      }
      return undefined;
    },
  } as unknown as Context;
  const port = createAnalysisExecutionPort(ctx, { capabilities });
  return {
    port,
    ctx,
    get registered() {
      return registered;
    },
    failCapabilities(code: string, message: string) {
      capabilityError = { code, message };
    },
  };
}

test('4.4 prepare 注册能力与活动绑定，并让守卫按实际 Session 判允许/拒绝', async () => {
  releaseAnalysisBinding('session-1');
  const h = harness();
  assert.equal(bindingForSession('session-1'), undefined);

  const ready = await h.port.prepare(record());
  assert.deepEqual(ready, { ready: true });
  assert.equal(h.registered, 1);
  const binding = bindingForSession('session-1');
  assert.ok(binding !== undefined);
  assert.equal(binding?.protected, true);
  assert.equal(binding?.persisted, true);

  const allowed = decideAnalysisToolUse(binding, { agent: { id: 'session-1' }, name: 'cona_analysis_scope_files' });
  assert.equal(allowed.kind, 'allow');
  const wrong = decideAnalysisToolUse(binding, { agent: { id: 'session-other' }, name: 'cona_analysis_scope_files' });
  assert.equal(wrong.kind, 'deny');
  const bash = decideAnalysisToolUse(binding, { agent: { id: 'session-1' }, name: 'bash' });
  assert.equal(bash.kind, 'deny');

  // 同一 (analysisId, sessionId) 重复 prepare 不重复注册能力。
  await h.port.prepare(record());
  assert.equal(h.registered, 1);
  releaseAnalysisBinding('session-1');
});

test('4.4 能力注册失败、Agent 缺失、执行器不符或可见集不符都拒绝且不留活动绑定', async () => {
  releaseAnalysisBinding('session-1');

  const capabilityFail = harness();
  capabilityFail.failCapabilities('analysis-capabilities-unavailable', '未实现');
  const notReady = await capabilityFail.port.prepare(record());
  assert.equal(notReady.ready, false);
  if (!notReady.ready) assert.equal(notReady.code, 'analysis-capabilities-unavailable');
  assert.equal(bindingForSession('session-1'), undefined);

  const missing = harness({ agentMissing: true });
  const noAgent = await missing.port.prepare(record());
  assert.equal(noAgent.ready, false);
  if (!noAgent.ready) assert.equal(noAgent.code, 'analysis-agent-missing');

  const ptc = harness({ executor: new PtcExecutor() });
  const wrongExecutor = await ptc.port.prepare(record());
  assert.equal(wrongExecutor.ready, false);
  if (!wrongExecutor.ready) assert.match(wrongExecutor.message, /analysis-executor-not-native/);
  assert.equal(bindingForSession('session-1'), undefined, '核对失败不留下可被守卫接受的绑定');

  const extra = harness({ extraTool: true });
  const extraTool = await extra.port.prepare(record());
  assert.equal(extraTool.ready, false);
  if (!extraTool.ready) assert.match(extraTool.message, /analysis-tools-mismatch/);
  assert.equal(bindingForSession('session-1'), undefined);
});

test('4.4 无 Session 的记录不进入核对', async () => {
  releaseAnalysisBinding('session-1');
  const h = harness();
  const result = await h.port.prepare(record({ sessionId: null }));
  assert.equal(result.ready, false);
  if (!result.ready) assert.equal(result.code, 'analysis-session-missing');
  assert.equal(h.registered, 0);
  assert.equal(await h.port.promptAccepted('session-1', 'rpc-1'), false);
});

test('4.4 能力占位端口拒绝派发且查询保持未知', async () => {
  const port = unavailableAnalysisCapabilityPort('未实现');
  const result = await port.register({ agent: {}, record: record() });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'analysis-capabilities-unavailable');
});
