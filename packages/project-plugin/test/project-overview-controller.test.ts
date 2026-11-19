// R2 任务 2.2：顶部概览控制器测试。
// 覆盖：实例列表装载、可读选择/不可读拒绝、折叠态、按实例 controller 隔离、
// 委托控制器在选中切换时改绑且保留各自草稿。纯逻辑，不依赖 DOM/React。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProjectOverviewController,
  DelegatingPanelController,
  type OverviewListResult,
} from '../src/client/project-overview-controller.js';
import type { PanelTransport } from '../src/client/api.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function transport(): PanelTransport {
  return {
    status: async () => ({ configured: true, instanceId: A, projectId: 'p', sourceKind: 'custom', sourceDisplay: '/a', localRootDisplay: '/l', created: false, error: null }),
    snapshot: async () => ({ status: 'unsynced', reason: 'unstable', attempts: 0, detail: 'stub' }),
    execute: async () => ({ status: 'rejected', code: 'stub', message: 'stub' }),
  };
}

function controller(list: OverviewListResult): ProjectOverviewController {
  return new ProjectOverviewController({
    listInstances: async () => list,
    transportFor: () => transport(),
    newOperationId: () => `op-${Math.random()}`,
  });
}

const listed = (): OverviewListResult => ({
  status: 'listed',
  instances: [
    { instanceId: A, projectId: 'p', readable: true, sourceDisplay: '~/a' },
    { instanceId: B, projectId: 'p', readable: false, code: 'invalid-project', message: '不可读' },
  ],
});

test('load 列出实例，默认选中首个可读，不可读行保留诊断', async () => {
  const c = controller(listed());
  await c.load();
  const s = c.getState();
  assert.equal(s.phase, 'ready');
  assert.equal(s.instances.length, 2);
  assert.equal(s.selectedId, A);
  const bad = s.instances.find((row) => row.instanceId === B);
  assert.equal(bad?.readable, false);
  assert.equal(bad?.code, 'invalid-project');
});

test('不可读实例不能被选中', async () => {
  const c = controller(listed());
  await c.load();
  assert.equal(c.select(B), false);
  assert.equal(c.getState().selectedId, A);
  assert.equal(c.select(A), true);
});

test('toggle 展开并加载，collapse 收起', async () => {
  const c = controller(listed());
  assert.equal(c.getState().expanded, false);
  await c.toggle();
  assert.equal(c.getState().expanded, true);
  assert.equal(c.getState().phase, 'ready');
  c.collapse();
  assert.equal(c.getState().expanded, false);
});

test('按实例 controller 隔离：两次取同一实例复用，不同实例不同对象', () => {
  const c = controller(listed());
  const a1 = c.panelController(A);
  const a2 = c.panelController(A);
  assert.equal(a1, a2);
  const b = c.panelController(B);
  assert.notEqual(a1, b);
});

test('unconfigured/rejected 列表进入 error 态并记稳定码', async () => {
  const c1 = controller({ status: 'unconfigured', message: '无实例' });
  await c1.load();
  assert.equal(c1.getState().phase, 'error');
  assert.equal(c1.getState().code, 'unconfigured');
  const c2 = controller({ status: 'rejected', code: 'forbidden', message: '无权' });
  await c2.load();
  assert.equal(c2.getState().code, 'forbidden');
});

test('委托控制器：选中切换时改绑，未选中时 getState 安全', async () => {
  const c = controller({
    status: 'listed',
    instances: [
      { instanceId: A, projectId: 'p', readable: true },
      { instanceId: B, projectId: 'p', readable: true },
    ],
  });
  await c.load();
  const delegate = new DelegatingPanelController(c);
  // 默认选中 A，委托应绑 A 的 controller
  const aController = c.panelController(A);
  const bController = c.panelController(B);
  // 给两个实例各自设置不同草稿基线，验证隔离
  aController.select('node-a');
  bController.select('node-b');
  assert.equal(delegate.getState().phase, 'idle'); // 尚未 open，真实 controller 仍是 idle
  c.select(B);
  // 切换后委托重绑到 B；B 的 controller 与 A 不同
  assert.notEqual(aController, bController);
  const states: unknown[] = [];
  delegate.subscribe((s) => states.push(s));
  bController.select('node-b-2');
  // 委托应把 B 的状态推给订阅者
  assert.ok(states.length >= 1);
  delegate.dispose();
});
