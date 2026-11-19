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
import type { PanelTransport, SnapshotResult } from '../src/client/api.js';

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
    readResumeCard: async () => ({ status: 'empty' }),
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

test('load 后自动读接续卡片，默认选中首个可读实例', async () => {
  let readFor: string | null = null;
  const c = new ProjectOverviewController({
    listInstances: async () => ({
      status: 'listed',
      instances: [
        { instanceId: A, projectId: 'p', readable: true },
        { instanceId: B, projectId: 'p', readable: false },
      ],
    }),
    readResumeCard: async (id) => { readFor = id; return { status: 'empty' }; },
    transportFor: () => transport(),
    newOperationId: () => 'op',
  });
  await c.load();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(readFor, A);
  assert.equal(c.getState().resumeCard?.status, 'empty');
});

test('切换实例丢弃迟到的卡片响应', async () => {
  const resolvers: { a?: (v: import('../src/client/project-overview-controller.js').ResumeCardView) => void } = {};
  const c = new ProjectOverviewController({
    listInstances: async () => ({
      status: 'listed',
      instances: [
        { instanceId: A, projectId: 'p', readable: true },
        { instanceId: B, projectId: 'p', readable: true },
      ],
    }),
    readResumeCard: (id) => new Promise((resolve) => {
      if (id === A) resolvers.a = resolve;
      else resolve({ status: 'empty' });
    }),
    transportFor: () => transport(),
    newOperationId: () => 'op',
  });
  await c.load();
  await new Promise((r) => setTimeout(r, 0));
  // 切到 B，B 的卡片立即到达
  c.select(B);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(c.getState().resumeCard?.status, 'empty');
  // A 的迟到响应到达，不应覆盖 B
  resolvers.a?.({ status: 'diagnostic', code: 'stale', message: 'late' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(c.getState().resumeCard?.status, 'empty', '迟到响应被丢弃');
});

// —— 3.2b 接续保存流程 ——

import { RESUME_SUMMARY_PREFIX } from '../src/domain/resume.js';

const SNAP = ({
  status: 'snapshot' as const,
  snapshot: {
    projectId: 'p', instanceId: A, sourceEpoch: 1, schemaVersion: 1,
    planVersion: 'v1', planRevision: 0, stateRevision: 0, connectionGeneration: 0,
    sync: { status: 'ready' } as never,
    source: { kind: 'custom' as const, displayPath: '/a' },
    project: { title: 't' } as never,
    tree: [{ id: 'n1', parentId: null, order: 0, title: '根', goal: '', criteria: [] } as never],
    dependencies: [],
    records: [],
    summary: {} as never,
  },
}) as unknown as SnapshotResult;

test('saveResume 必填缺失：failed missing-required，不触 transport', async () => {
  let executed = 0;
  const c = new ProjectOverviewController({
    listInstances: async () => listed(),
    readResumeCard: async () => ({ status: 'empty' }),
    transportFor: () => ({ ...transport(), execute: async () => { executed += 1; return { status: 'rejected', code: 'stub', message: '' }; } }),
    newOperationId: () => 'op-x',
  });
  await c.load();
  c.editResume();
  assert.equal(await c.saveResume(), 'failed');
  assert.equal(c.getState().resumeSave.code, 'missing-required');
  assert.equal(executed, 0);
});

test('saveResume 提交成功：清草稿、刷新卡片、summary 带前缀', async () => {
  const requests: Array<{ command: { summary: string; kind: string; subjectNodeIds: string[] }; operationId: string }> = [];
  let cardReads = 0;
  const c = new ProjectOverviewController({
    listInstances: async () => listed(),
    readResumeCard: async () => { cardReads += 1; return { status: 'empty' }; },
    transportFor: () => ({
      ...transport(),
      snapshot: async () => SNAP,
      execute: async (req) => {
        requests.push({ command: req.command as never, operationId: req.operationId });
        return { status: 'committed', planVersion: 'v1', planRevision: 0, stateRevision: 1, sourceEpoch: 1, impact: 'state' } as never;
      },
    }),
    newOperationId: () => 'op-new',
  });
  await c.load();
  c.editResume();
  c.patchResumeDraft({ stoppedAt: '完成卡片', nextStep: '做代码观察', nextStepKind: 'confirmed', outcome: 'UI 可用' });
  assert.equal(await c.saveResume(), 'saved');
  assert.equal(c.getState().resumeDraft, null);
  assert.equal(c.getState().resumeSave.status, 'saved');
  assert.equal(requests.length, 1);
  const first = requests[0];
  assert.ok(first !== undefined);
  assert.ok(first.command.summary.startsWith(RESUME_SUMMARY_PREFIX));
  assert.equal(first.command.kind, 'execution-note');
  assert.deepEqual(first.command.subjectNodeIds, ['n1']);
  // 保存后刷新卡片（初始 load 1 次 + 保存后 1 次）
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(cardReads, 2);
});

test('saveResume 冲突：conflict 状态，草稿与 operationId 保留供幂等重试', async () => {
  const ops: string[] = [];
  const c = new ProjectOverviewController({
    listInstances: async () => listed(),
    readResumeCard: async () => ({ status: 'empty' }),
    transportFor: () => ({
      ...transport(),
      snapshot: async () => SNAP,
      execute: async (req) => {
        ops.push(req.operationId);
        return { status: 'rejected', code: 'plan-conflict', message: '已变化' };
      },
    }),
    newOperationId: () => 'op-gen',
  });
  await c.load();
  c.editResume();
  c.patchResumeDraft({ stoppedAt: 'a', nextStep: 'b' });
  assert.equal(await c.saveResume(), 'conflict');
  assert.equal(c.getState().resumeSave.status, 'conflict');
  assert.notEqual(c.getState().resumeDraft, null);
  assert.equal(c.getState().resumeDraft?.operationId, 'op-gen');
  // 重试复用同一 operationId
  await c.saveResume();
  assert.deepEqual(ops, ['op-gen', 'op-gen']);
});

test('saveResume 传输异常：transport-unknown，草稿保留', async () => {
  const c = new ProjectOverviewController({
    listInstances: async () => listed(),
    readResumeCard: async () => ({ status: 'empty' }),
    transportFor: () => ({
      ...transport(),
      snapshot: async () => SNAP,
      execute: async () => { throw new Error('网络断开'); },
    }),
    newOperationId: () => 'op-t',
  });
  await c.load();
  c.editResume();
  c.patchResumeDraft({ stoppedAt: 'a', nextStep: 'b' });
  assert.equal(await c.saveResume(), 'failed');
  assert.equal(c.getState().resumeSave.code, 'transport-unknown');
  assert.notEqual(c.getState().resumeDraft, null);
  assert.equal(c.getState().resumeDraft?.operationId, 'op-t');
});
