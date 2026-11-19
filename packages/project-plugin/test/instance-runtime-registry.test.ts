// R2 任务 2.1：多实例运行时表测试。
// 覆盖：配置实例复用、按实例懒装配与并发共享、不可读诊断、
// 已登记 id 集合、配置实例不可释放。这里只测表的隔离语义，
// 不测 cordis 接线与真实资料（那属于 H 层）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InstanceRuntimeRegistry,
  type OpenInstanceInput,
} from '../src/host/instance-runtime-registry.js';
import type { RuntimeResult } from '../src/host/project-service.js';
import type { RegistryEntry } from '../src/application/local-state.js';
import type { OpenedInstance } from '../src/host/bootstrap.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROJECT = '00000000-0000-4000-8000-000000000001';

function entry(instanceId: string, sourceRoot: string, projectId = PROJECT): RegistryEntry {
  return {
    instanceId,
    projectId,
    sourceRoot,
    sourceKind: 'custom',
    sourceGeneration: 1,
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:00:00.000Z',
  };
}

function openedRuntime(instanceId: string): RuntimeResult {
  const instance: OpenedInstance = {
    instanceId,
    projectId: PROJECT,
    sourceRoot: `/projects/${instanceId}`,
    sourceKind: 'custom',
    sourceDisplay: `~/projects/${instanceId}`,
    sourceEpoch: 1,
    localRoot: '/local',
    created: false,
    baselineEstablished: true,
  };
  // 表的测试只关心 instance 身份；其余服务用占位，满足 ConaProjectRuntime 形状。
  return { ok: true, value: { instance } as never };
}

test('配置实例复用已注入的 runtime，不重新 open', async () => {
  let opened = 0;
  const reg = new InstanceRuntimeRegistry({
    listEntries: async () => [entry(A, '/projects/a')],
    open: async (input) => { opened++; return openedRuntime(input.instanceId); },
    describeLocation: (r) => r,
    configured: { instanceId: A, runtime: async () => openedRuntime(A) },
  });
  const r = await reg.runtime(A);
  assert.equal(r?.ok, true);
  assert.equal(opened, 0, '配置实例不得触发 open');
  await reg.openEntry(entry(A, '/projects/a'));
  assert.equal(opened, 0, 'openEntry 命中已注册实例也应复用');
});

test('其他实例按 entry 懒装配，同一实例并发只 open 一次', async () => {
  let opened = 0;
  const reg = new InstanceRuntimeRegistry({
    listEntries: async () => [entry(B, '/projects/b')],
    open: async (input) => { opened++; await Promise.resolve(); return openedRuntime(input.instanceId); },
    describeLocation: (r) => r,
  });
  const e = entry(B, '/projects/b');
  const [r1, r2] = await Promise.all([reg.openEntry(e), reg.openEntry(e)]);
  assert.equal(opened, 1, '并发打开应共享同一 promise');
  assert.equal(r1, r2);
  assert.equal(r1.ok, true);
});

test('不同实例各自装配，A 的运行时不被 B 覆盖', async () => {
  const opened: string[] = [];
  const reg = new InstanceRuntimeRegistry({
    listEntries: async () => [],
    open: async (input) => { opened.push(input.instanceId); return openedRuntime(input.instanceId); },
    describeLocation: (r) => r,
  });
  await reg.openEntry(entry(A, '/projects/a'));
  await reg.openEntry(entry(B, '/projects/b'));
  assert.deepEqual(opened, [A, B]);
  const ra = await reg.runtime(A);
  const rb = await reg.runtime(B);
  assert.equal(ra?.ok, true);
  assert.equal(rb?.ok, true);
  if (ra?.ok && rb?.ok) {
    assert.notEqual(ra.value.instance.instanceId, rb.value.instance.instanceId);
  }
});

test('不可读实例保留诊断行，不隐藏条目', async () => {
  const reg = new InstanceRuntimeRegistry({
    listEntries: async () => [entry(A, '/projects/a'), entry(B, '/projects/b')],
    open: async (input) => input.instanceId === B
      ? { ok: false, code: 'invalid-project', message: '资料根不可读' }
      : openedRuntime(A),
    describeLocation: (r) => r,
  });
  const rows = await reg.overviewRows();
  assert.equal(rows.length, 2);
  const a = rows.find((row) => row.instanceId === A);
  const b = rows.find((row) => row.instanceId === B);
  assert.equal(a?.readable, true);
  assert.equal(b?.readable, false);
  if (b && !b.readable) {
    assert.equal(b.code, 'invalid-project');
    assert.equal(b.message, '资料根不可读');
  }
});

test('knownInstanceIds 只含已登记实例', async () => {
  const reg = new InstanceRuntimeRegistry({
    listEntries: async () => [entry(A, '/projects/a')],
    open: async (input) => openedRuntime(input.instanceId),
    describeLocation: (r) => r,
  });
  const known = await reg.knownInstanceIds();
  assert.deepEqual([...known], [A]);
  assert.equal(known.has(B), false);
});

test('配置实例不可释放，其他实例可释放后重新装配', async () => {
  let opened = 0;
  const reg = new InstanceRuntimeRegistry({
    listEntries: async () => [],
    open: async (input) => { opened++; return openedRuntime(input.instanceId); },
    describeLocation: (r) => r,
    configured: { instanceId: A, runtime: async () => openedRuntime(A) },
  });
  assert.equal(reg.release(A), false, '配置实例释放被忽略');
  assert.notEqual(await reg.runtime(A), undefined);
  await reg.openEntry(entry(B, '/projects/b'));
  assert.equal(reg.release(B), true);
  assert.equal(await reg.runtime(B), undefined);
  await reg.openEntry(entry(B, '/projects/b'));
  assert.equal(opened, 2, '释放后重新 open');
});
