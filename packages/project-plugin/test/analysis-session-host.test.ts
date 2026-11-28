// 分析 Session 宿主适配器测试（tasks 4.2）：专用 preset 创建、工作区登记、
// 不复用空白会话、返回实际 preset、目录不可用诊断。不启动真实宿主。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { analysisSessionPort } from '../src/host/analysis-session.js';

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
}) {
  const creates: CreateRequest[] = [];
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
  };
  const ctx = {
    sessionController,
    get(name: string) {
      return name === 'workspaceRegistry' ? workspaces : undefined;
    },
  } as unknown as Context;
  return { ctx, creates, attached };
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
