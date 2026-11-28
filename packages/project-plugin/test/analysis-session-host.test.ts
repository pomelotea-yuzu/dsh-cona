// 分析 Session 宿主适配器测试（tasks 4.2）：专用 preset 创建、工作区登记、
// 不复用空白会话、返回实际 preset、目录不可用诊断。不启动真实宿主。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { analysisSessionPort } from '../src/host/analysis-session.js';
import { agentPromptAccepted, unavailableAnalysisExecutionPort } from '../src/host/analysis-execution-port.js';
import { attachAnalysisEventObservers } from '../src/host/analysis-events.js';
import type { RuntimeResult } from '../src/host/project-service.js';

interface CreateRequest {
  sessionId?: string;
  cwd?: string;
  workspaceId?: string;
  agentPreset?: string;
}

function harness(options?: {
  workspaces?: boolean;
  invalidSessionId?: boolean;
  preset?: string;
  attachThrows?: boolean;
  noPrompt?: boolean;
}) {
  const creates: CreateRequest[] = [];
  const prompts: Array<{ request: Record<string, unknown>; signal: AbortSignal }> = [];
  const cancels: string[] = [];
  const attached: string[] = [];
  const workspaces = options?.workspaces === false ? undefined : {
    async resolveByPath() {
      return {
        id: 'workspace-1',
        async attachSession(sessionId: string) {
          if (options?.attachThrows === true) throw new Error('attach failed');
          attached.push(sessionId);
        },
      };
    },
    async create() {
      return {
        id: 'workspace-1',
        async attachSession(sessionId: string) {
          attached.push(sessionId);
        },
      };
    },
  };
  const sessionController = {
    async create(request: CreateRequest) {
      creates.push(request);
      return {
        sessionId: options?.invalidSessionId === true ? '' : `session-${creates.length}`,
        ...(options?.preset === undefined ? { agentPreset: request.agentPreset } : { agentPreset: options.preset }),
      };
    },
    async list() {
      return {
        items: [
          { sessionId: 'session-x', blank: true, running: false, updatedAt: 5, cwd: '/repo' },
          { sessionId: '', blank: true },
        ],
      };
    },
    ...(options?.noPrompt === true ? {} : {
      async prompt(request: Record<string, unknown>, signal: AbortSignal) {
        prompts.push({ request, signal });
        return { accepted: true };
      },
      cancel(request: { sessionId: string }) {
        cancels.push(request.sessionId);
        return { accepted: true };
      },
    }),
  };
  const ctx = {
    sessionController,
    get(name: string) {
      return name === 'workspaceRegistry' ? workspaces : undefined;
    },
  } as unknown as Context;
  return { ctx, creates, prompts, cancels, attached };
}

test('4.2 分析创建使用 workspaceId + 专用 preset，且不传 sessionId', async () => {
  const h = harness();
  const result = analysisSessionPort(h.ctx);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const created = await result.port.createAnalysisSession({
    cwd: '/repo',
    agentPreset: 'cona-project-analysis',
  });
  assert.deepEqual(created, { sessionId: 'session-1', agentPreset: 'cona-project-analysis' });
  assert.equal(h.creates[0]?.sessionId, undefined);
  assert.deepEqual(h.creates[0], { agentPreset: 'cona-project-analysis', workspaceId: 'workspace-1' });
  assert.deepEqual(h.attached, ['session-1']);
});

test('4.2 无工作区登记表时退回 cwd 创建，仍不传 sessionId', async () => {
  const h = harness({ workspaces: false });
  const result = analysisSessionPort(h.ctx);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  await result.port.createAnalysisSession({ cwd: '/repo', agentPreset: 'cona-project-analysis' });
  assert.deepEqual(h.creates[0], { agentPreset: 'cona-project-analysis', cwd: '/repo' });
});

test('4.2 宿主返回空 sessionId 时抛错；preset 不符由上层拒绝', async () => {
  const invalid = harness({ invalidSessionId: true });
  const invalidPort = analysisSessionPort(invalid.ctx);
  assert.equal(invalidPort.ok, true);
  if (invalidPort.ok) {
    await assert.rejects(
      invalidPort.port.createAnalysisSession({ cwd: '/repo', agentPreset: 'cona-project-analysis' }),
      /sessionId/,
    );
  }

  const mismatch = harness({ preset: 'standard' });
  const mismatchPort = analysisSessionPort(mismatch.ctx);
  assert.equal(mismatchPort.ok, true);
  if (mismatchPort.ok) {
    const created = await mismatchPort.port.createAnalysisSession({ cwd: '/repo', agentPreset: 'cona-project-analysis' });
    assert.equal(created.agentPreset, 'standard');
  }
});

test('4.2 工作区登记失败不冒充创建失败，但保留可诊断警告', async () => {
  const h = harness({ attachThrows: true });
  const result = analysisSessionPort(h.ctx);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const created = await result.port.createAnalysisSession({ cwd: '/repo', agentPreset: 'cona-project-analysis' });
  assert.equal(created.sessionId, 'session-1');
  assert.deepEqual(h.attached, []);
});

test('4.3 首条消息使用 requestId 与 queue 模式发送；缺 prompt 时明确失败', async () => {
  const h = harness();
  const result = analysisSessionPort(h.ctx);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  await result.port.promptFirstMessage({ sessionId: 'session-1', requestId: 'op-1', text: '分析范围 src' });
  assert.equal(h.prompts.length, 1);
  assert.deepEqual(h.prompts[0]?.request, {
    sessionId: 'session-1',
    requestId: 'op-1',
    mode: 'queue',
    content: [{ type: 'text', text: '分析范围 src' }],
  });
  assert.equal(h.prompts[0]?.signal.aborted, false);

  const missing = analysisSessionPort(harness({ noPrompt: true }).ctx);
  assert.equal(missing.ok, true);
  if (missing.ok) {
    await assert.rejects(
      missing.port.promptFirstMessage({ sessionId: 'session-1', requestId: 'op-1', text: 'x' }),
      /prompt/,
    );
  }
});

test('4.5 停止请求调用宿主 cancel；缺 cancel 时明确失败', async () => {
  const h = harness();
  const result = analysisSessionPort(h.ctx);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  await result.port.cancelSession({ sessionId: 'session-1' });
  assert.deepEqual(h.cancels, ['session-1']);

  const missing = analysisSessionPort(harness({ noPrompt: true }).ctx);
  assert.equal(missing.ok, true);
  if (missing.ok) {
    await assert.rejects(missing.port.cancelSession({ sessionId: 'session-1' }), /cancel/);
  }
});

test('4.5 turn/end 事件转到分析记录；非终态事件忽略', async () => {
  const calls: Array<{ sessionId: string; kind: string }> = [];
  let listener: ((session: unknown, event: unknown) => void) | undefined;
  const ctx = {
    on(_name: string, handler: (session: unknown, event: unknown) => void) {
      listener = handler;
      return () => true;
    },
  } as unknown as Context;
  const runtime = {
    ok: true as const,
    value: {
      analysisSession: {
        async handleTurnEnd(input: { sessionId: string; kind: string }) {
          calls.push(input);
          return { status: 'ignored' as const };
        },
      },
    },
  } as unknown as RuntimeResult;
  const dispose = attachAnalysisEventObservers(ctx, async () => runtime);
  assert.ok(listener !== undefined);
  listener?.({ id: 'session-1' }, { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  listener?.({ id: 'session-1' }, { type: 'turn/start' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, [{ sessionId: 'session-1', kind: 'completed' }]);
  dispose();
});

test('4.3 按 Agent 事件核对 requestId：user/message 与 inbox/spliced 都算已接受', async () => {
  const events = [
    { type: 'user/message', data: { source: { kind: 'user', rpcId: 'op-a' } } },
    { type: 'agent/inbox/spliced', data: { inserted: [{ source: { kind: 'user', rpcId: 'op-b' } }] } },
    { type: 'user/message', data: { source: { kind: 'system', rpcId: 'op-a' } } },
  ];
  const ctx = {
    get(name: string) {
      if (name !== 'agents') return undefined;
      return { get: () => ({ session: { snapshotEvents: () => events } }) };
    },
  } as unknown as Context;
  const accepted = agentPromptAccepted(ctx);
  assert.equal(await accepted('session-1', 'op-a'), true);
  assert.equal(await accepted('session-1', 'op-b'), true);
  assert.equal(await accepted('session-1', 'op-missing'), false);

  const unknown = agentPromptAccepted({ get: () => undefined } as unknown as Context);
  assert.equal(await unknown('session-1', 'op-a'), 'unknown');
});

test('4.3 保护端口未接入时拒绝派发并保持查询未知', async () => {
  const port = unavailableAnalysisExecutionPort('未接入');
  const prepared = await port.prepare({} as never);
  assert.equal(prepared.ready, false);
  if (!prepared.ready) assert.equal(prepared.code, 'analysis-execution-unavailable');
  assert.equal(await port.promptAccepted('session-1', 'op-1'), 'unknown');
});

test('4.2 目录不可用时返回明确原因；listSessions 过滤无效条目', async () => {
  const missing = analysisSessionPort({ get: () => undefined } as unknown as Context);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.message, /sessionController/);

  const h = harness();
  const result = analysisSessionPort(h.ctx);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(await result.port.listSessions(), [
    { sessionId: 'session-x', blank: true, running: false, updatedAt: 5, cwd: '/repo' },
  ]);
});
