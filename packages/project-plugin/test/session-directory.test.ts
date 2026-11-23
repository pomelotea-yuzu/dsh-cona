// 3.1 宿主会话目录适配测试：cwd 归属、空白会话复用与目录不可用占位。
// 只测适配器投影；真实宿主 create/list 属 H 层（5.4）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { sessionDirectory, unavailableSessionDirectory } from '../src/host/session-directory.js';

const ROOT_A = '/projects/a';
const ROOT_B = '/projects/b';

function ctxWith(items: Record<string, unknown>[], created: string[] = []): Context {
  const controller = {
    async create(request: { sessionId?: string; cwd?: string }) {
      created.push(request.sessionId ?? '(new)');
      if (request.sessionId !== undefined) {
        const existing = items.find((item) => item['sessionId'] === request.sessionId);
        if (existing !== undefined) existing['blank'] = false;
        return { sessionId: request.sessionId };
      }
      const sessionId = `session-new-${created.length}`;
      items.push({ sessionId, blank: true, running: false, updatedAt: 100 + created.length, cwd: request.cwd });
      return { sessionId };
    },
    async list() {
      return { items };
    },
  };
  return { sessionController: controller } as unknown as Context;
}

test('3.1 只列本实例工作区的会话：另一副本的会话不可见、不可冒领', async () => {
  const items = [
    { sessionId: 'session-a1', blank: false, running: false, updatedAt: 10, cwd: ROOT_A },
    { sessionId: 'session-b1', blank: true, running: false, updatedAt: 20, cwd: ROOT_B },
    { sessionId: 'session-orphan', blank: true, running: false, updatedAt: 30 },
  ];
  const result = sessionDirectory(ctxWith(items), ROOT_A);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const sessions = await result.directory.listSessions();
  assert.deepEqual(sessions.map((session) => session.sessionId), ['session-a1']);
  assert.equal(sessions[0]?.cwd, ROOT_A);
});

test('3.1 新建会话：同工作区空白会话优先复用，没有才新建且带 cwd', async () => {
  const created: string[] = [];
  const items = [
    { sessionId: 'blank-a', blank: true, running: false, updatedAt: 10, cwd: ROOT_A },
    { sessionId: 'blank-b', blank: true, running: false, updatedAt: 20, cwd: ROOT_B },
  ];
  const result = sessionDirectory(ctxWith(items, created), ROOT_A);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const first = await result.directory.createSession();
  assert.equal(first.sessionId, 'blank-a', '复用本工作区空白会话');
  assert.deepEqual(created, ['blank-a']);

  // 复用后该会话不再是空白：下一次新建走宿主新会话，并带上本实例 cwd。
  const second = await result.directory.createSession();
  assert.notEqual(second.sessionId, 'blank-a');
  const fresh = items.find((item) => item['sessionId'] === second.sessionId);
  assert.equal(fresh?.['cwd'], ROOT_A, '新会话绑定实例资料根');
  assert.deepEqual(created, ['blank-a', '(new)']);
});

test('3.1 宿主未提供 sessionController：稳定拒绝，不抛裸异常给上层', async () => {
  const result = sessionDirectory({} as unknown as Context, ROOT_A);
  assert.equal(result.ok, false);
  const placeholder = unavailableSessionDirectory('宿主未提供 sessionController 服务');
  await assert.rejects(() => placeholder.listSessions(), /sessionController/);
  await assert.rejects(() => placeholder.createSession(), /sessionController/);
});
