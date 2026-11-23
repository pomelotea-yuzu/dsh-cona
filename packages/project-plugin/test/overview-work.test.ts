// R2 收尾 3.2：概览里的项目工作（controller A 层）。
// 覆盖：非配置实例入口不可用、草稿来自树选择与会话、预览走当前快照基线并按目标集合提交、
// 预览失败不落盘、确认按 prepare→start 顺序且不预填 rpcId、确认后打开该会话。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProjectOverviewController,
  type ChatMutationView,
  type OverviewListResult,
  type WorkPreviewView,
} from '../src/client/project-overview-controller.js';
import type { PanelTransport, SnapshotResult } from '../src/client/api.js';
import type { WorkAction } from '../src/application/work.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NODE_A = '11111111-1111-4111-8111-111111111111';
const NODE_B = '22222222-2222-4222-8222-222222222222';
const SESSION = 'session-work';

interface Calls {
  previews: Parameters<NonNullable<ConstructorParameters<typeof ProjectOverviewController>[0]['workPreview']>>[0][];
  prepared: { workIntentId: string; nodeIds: string[]; allowedActions: WorkAction[]; baseline: { planVersion: string; planRevision: number; sourceEpoch: number } }[];
  started: { workIntentId: string; sessionId: string }[];
  opened: string[];
  snapshots: number;
}

function preview(overrides: Partial<WorkPreviewView> = {}): WorkPreviewView {
  return {
    sessionId: SESSION,
    targets: [{
      id: NODE_A, known: true, title: '节点 A', status: 'in-progress', goal: '完成 A',
      completionCriteria: ['条件 1'], dependsOn: [], requiredBy: [],
    }],
    constraints: { allowedActions: ['update', 'record'], reasonScope: 'local' },
    baseline: { planVersion: 'pv-1', planRevision: 2, sourceEpoch: 1 },
    sourceEpoch: 1,
    publicRecords: [],
    chatEntries: [],
    backgroundNodeIds: [],
    items: [{ kind: 'decision', source: 'preview:scope', text: '用户准备确认的范围' }],
    generatedAt: '2026-11-23T00:00:00.000Z',
    ...overrides,
  };
}

function harness(options: {
  configured?: boolean;
  previewResult?: ChatMutationView<WorkPreviewView> | { status: 'rejected'; code: string; message: string };
  prepareResult?: ChatMutationView<{ workIntentId: string; reused: boolean }>;
  startResult?: ChatMutationView<{ workIntentId: string; status: 'awaiting-message' }>;
  snapshot?: SnapshotResult;
} = {}): { controller: ProjectOverviewController; calls: Calls; selectNode(): void } {
  const calls: Calls = { previews: [], prepared: [], started: [], opened: [], snapshots: 0 };
  const configured = options.configured ?? true;
  const transport: PanelTransport = {
    status: async () => ({
      configured, instanceId: configured ? A : B, projectId: 'p', sourceKind: 'custom',
      sourceDisplay: '/x', localRootDisplay: '/l', created: false, error: null,
    }),
    snapshot: async (): Promise<SnapshotResult> => {
      calls.snapshots += 1;
      return options.snapshot ?? ({
        status: 'snapshot',
        snapshot: {
          planVersion: 'pv-1', planRevision: 2, sourceEpoch: 1,
          projectId: 'p', instanceId: A, schemaVersion: 1, stateRevision: 1, connectionGeneration: 0,
          sync: { status: 'synced' }, source: { kind: 'custom', displayPath: '/x' },
          project: { id: 'p', title: 'p', goal: 'g', constraints: [], repositories: [] },
          tree: [], dependencies: [], records: [], summary: { nodeCount: 0, doneCount: 0, dependencyCount: 0, blockedCount: 0 },
          local: { conversationCount: 0, workRunCount: 0, lastOperationAt: null, quarantined: null },
          readAt: '2026-11-23T00:00:00.000Z',
        },
      } as never);
    },
    execute: async () => ({ status: 'rejected', code: 'stub', message: 'stub' }),
  };
  const list: OverviewListResult = {
    status: 'listed',
    instances: [
      { instanceId: A, projectId: 'p', readable: true, sourceDisplay: '~/a', configured: true },
      { instanceId: B, projectId: 'p', readable: true, sourceDisplay: '~/b', configured: false },
    ],
  };
  const controller = new ProjectOverviewController({
    listInstances: async () => list,
    readResumeCard: async () => ({ status: 'empty' }),
    listResumeChats: async () => ({ status: 'unavailable', reason: 'stub' }),
    linkResume: async () => ({ status: 'rejected', code: 'stub', message: 'stub' }),
    resolveChatTarget: async () => ({ status: 'rejected', code: 'stub', message: 'stub' }),
    openSession: (sessionId: string) => { calls.opened.push(sessionId); },
    transportFor: () => transport,
    newOperationId: () => `op-${calls.prepared.length + 1}`,
    listChats: async () => ({
      status: 'committed',
      value: {
        links: [
          { linkId: 'link-1', sessionId: SESSION, nodeIds: [NODE_A], purpose: '讨论 A', origin: 'panel', createdAt: 'x', updatedAt: 'x', visible: true, blank: false },
        ],
        pendingIntents: [],
      },
      stateRevision: 1,
    }),
    listChatSessions: async () => ({
      status: 'committed',
      value: { sessions: [{ sessionId: SESSION, blank: false, running: false, updatedAt: 1, linked: true }] },
      stateRevision: -1,
    }),
    workPreview: async (request) => {
      calls.previews.push(request);
      return options.previewResult ?? { status: 'committed', value: preview(), stateRevision: 3 };
    },
    workPrepare: async (request) => {
      calls.prepared.push({
        workIntentId: request.workIntentId, nodeIds: [...request.nodeIds],
        allowedActions: [...request.allowedActions], baseline: request.baseline,
      });
      return options.prepareResult ?? { status: 'committed', value: { workIntentId: request.workIntentId, reused: false }, stateRevision: 4 };
    },
    workStart: async (request) => {
      calls.started.push({ workIntentId: request.workIntentId, sessionId: request.sessionId });
      return options.startResult ?? { status: 'committed', value: { workIntentId: request.workIntentId, status: 'awaiting-message' }, stateRevision: 5 };
    },
  });
  return {
    controller,
    calls,
    selectNode: () => {
      controller.panelController(A).select(NODE_A);
      controller.panelController(A).toggleSelect(NODE_B);
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('3.2 非配置实例：工作入口不可用，不起草、不预览', async () => {
  const { controller, calls } = harness({ configured: false });
  await controller.load();
  await settle();
  controller.select(B);
  await settle();

  assert.equal(controller.isWorkEntryAvailable(), false);
  assert.equal(controller.beginWork(), false);
  assert.equal(controller.getState().work.notice?.code, 'work-entry-unavailable');
  assert.equal(controller.getState().work.draft, null);
  assert.equal(await controller.previewWork(), 'idle');
  assert.equal(calls.previews.length, 0);
});

test('3.2 起草范围：目标来自树选择，会话来自该实例已有链接', async () => {
  const { controller, selectNode } = harness();
  await controller.load();
  await settle();
  selectNode();

  assert.equal(controller.isWorkEntryAvailable(), true);
  assert.equal(controller.beginWork(), true);
  const draft = controller.getState().work.draft;
  assert.ok(draft !== null);
  assert.deepEqual(draft.nodeIds, [NODE_A, NODE_B]);
  assert.equal(draft.sessionId, SESSION);
  assert.deepEqual(draft.actions, ['update', 'record']);
  assert.equal(draft.reasonScope, 'local');
  assert.equal(draft.purpose, '');
});

test('3.2 预览：用当前快照基线按目标集合请求；预览只读不落盘', async () => {
  const { controller, calls, selectNode } = harness();
  await controller.load();
  await settle();
  selectNode();
  controller.beginWork();
  controller.patchWorkDraft({ purpose: '推进 A 与 B' });

  assert.equal(await controller.previewWork(), 'ok');
  assert.equal(calls.snapshots, 1, '预览取一次当前快照作为基线');
  assert.deepEqual(calls.previews, [{
    instanceId: A,
    sessionId: SESSION,
    nodeIds: [NODE_A, NODE_B],
    allowedActions: ['update', 'record'],
    reasonScope: 'local',
    purpose: '推进 A 与 B',
    baseline: { planVersion: 'pv-1', planRevision: 2, sourceEpoch: 1 },
  }]);
  const state = controller.getState();
  assert.equal(state.work.phase, 'previewed');
  assert.equal(state.work.preview?.targets[0]?.goal, '完成 A');
  // 预览阶段不调用 prepare／start。
  assert.equal(calls.prepared.length, 0);
  assert.equal(calls.started.length, 0);
});

test('3.2 预览前置校验：缺会话／缺用途／无动作都在本地拒绝，不请求宿主', async () => {
  const { controller, calls, selectNode } = harness();
  await controller.load();
  await settle();
  selectNode();
  controller.beginWork();

  assert.equal(await controller.previewWork(), 'failed');
  assert.equal(controller.getState().work.notice?.code, 'missing-purpose');

  controller.patchWorkDraft({ purpose: '有用途', sessionId: '' });
  assert.equal(await controller.previewWork(), 'failed');
  assert.equal(controller.getState().work.notice?.code, 'session-identity-missing');

  controller.patchWorkDraft({ sessionId: SESSION, actions: [] });
  assert.equal(await controller.previewWork(), 'failed');
  assert.equal(controller.getState().work.notice?.code, 'missing-actions');
  assert.equal(calls.previews.length, 0);
  assert.equal(calls.snapshots, 0);
});

test('3.2 预览遇到未同步快照：如实给诊断，不请求预览', async () => {
  const { controller, calls, selectNode } = harness({
    snapshot: { status: 'unsynced', reason: 'unstable', attempts: 2, detail: '资料不稳定' },
  });
  await controller.load();
  await settle();
  selectNode();
  controller.beginWork();
  controller.patchWorkDraft({ purpose: '推进' });

  assert.equal(await controller.previewWork(), 'failed');
  assert.equal(controller.getState().work.notice?.code, 'unsynced-unstable');
  assert.equal(calls.previews.length, 0);
});

test('3.2 确认：按 prepare→start 顺序，带同一意图与会话；确认后打开会话只做导航', async () => {
  const { controller, calls, selectNode } = harness();
  await controller.load();
  await settle();
  selectNode();
  controller.beginWork();
  controller.patchWorkDraft({ purpose: '推进 A 与 B' });
  await controller.previewWork();
  const intentId = controller.getState().work.draft?.workIntentId;
  assert.ok(intentId !== undefined);

  assert.equal(await controller.confirmWork(), 'ok');
  assert.deepEqual(calls.prepared, [{
    workIntentId: intentId,
    nodeIds: [NODE_A, NODE_B],
    allowedActions: ['update', 'record'],
    baseline: { planVersion: 'pv-1', planRevision: 2, sourceEpoch: 1 },
  }]);
  assert.deepEqual(calls.started, [{ workIntentId: intentId, sessionId: SESSION }]);
  const state = controller.getState();
  assert.equal(state.work.phase, 'awaiting-message');
  assert.deepEqual(state.work.started, { workIntentId: intentId, sessionId: SESSION });

  controller.openWorkSession();
  assert.deepEqual(calls.opened, [SESSION]);
  assert.equal(calls.snapshots, 1, '确认与打开都不额外读快照');
});

test('3.2 未预览不得确认；宿主拒绝时保留草稿与预览并给稳定码', async () => {
  const { controller, calls, selectNode } = harness({
    prepareResult: { status: 'rejected', code: 'baseline-stale', message: '意图基线过期' },
  });
  await controller.load();
  await settle();
  selectNode();
  controller.beginWork();
  assert.equal(await controller.confirmWork(), 'idle', '没有预览不确认');
  assert.equal(calls.prepared.length, 0);

  controller.patchWorkDraft({ purpose: '推进' });
  await controller.previewWork();
  assert.equal(await controller.confirmWork(), 'failed');
  assert.equal(controller.getState().work.notice?.code, 'baseline-stale');
  assert.ok(controller.getState().work.preview !== null, '失败保留预览供用户重试');
  assert.ok(controller.getState().work.draft !== null, '失败保留草稿');
  assert.equal(calls.started.length, 0, '意图未登记成功不进入确认');
});

test('3.2 预览中的待核对项原样呈现：源代际推进与背景节点都在界面数据里', async () => {
  const { controller, selectNode } = harness({
    previewResult: {
      status: 'committed',
      stateRevision: 3,
      value: preview({
        backgroundNodeIds: ['33333333-3333-4333-8333-333333333333'],
        items: [
          { kind: 'decision', source: 'preview:scope', text: '用户准备确认的范围' },
          { kind: 'unverified', source: 'source-generation:3', text: '资料源代际已推进，新内容待核对' },
          { kind: 'suggestion', source: 'chat-background:session-work', text: '同会话还有目标外节点，仅作背景' },
        ],
      }),
    },
  });
  await controller.load();
  await settle();
  selectNode();
  controller.beginWork();
  controller.patchWorkDraft({ purpose: '推进' });
  await controller.previewWork();

  const view = controller.getState().work.preview;
  assert.ok(view !== null);
  assert.deepEqual(view.backgroundNodeIds, ['33333333-3333-4333-8333-333333333333']);
  assert.deepEqual(view.items.map((item) => item.kind), ['decision', 'unverified', 'suggestion']);
});
