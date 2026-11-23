// R2 收尾 3.1：概览按实例的本机聊天（controller A 层）。
// 覆盖：链接／可选会话／待核对投影、创建与关联（节点选择与用途校验）、待核对认领、
// 解绑、按实际 Session 打开（只用导航、不发命令/快照）、卡片显式重绑、
// 切换实例丢弃迟到响应、旧宿主缺方法时的 unavailable 降级。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProjectOverviewController,
  type OverviewChatsView,
  type OverviewListResult,
  type ResumeCardView,
  type RebindResumeView,
} from '../src/client/project-overview-controller.js';
import type { PanelTransport, SnapshotResult } from '../src/client/api.js';
import type { ChatsView } from '../src/application/conversations.js';
import type { ResumeChatsResult, ResumeLinkResult, ResumeChatTargetResult } from '../src/host/overview-service.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NODE = '11111111-1111-4111-8111-111111111111';
const RECORD = '22222222-2222-4222-8222-222222222222';
const HASH = `sha256:${'a'.repeat(64)}`;

const emptyChats = (): ChatsView => ({ links: [], pendingIntents: [] });

function cardWith(chat: 'unlinked' | 'unavailable' | 'linked'): ResumeCardView {
  const pointer = chat === 'linked'
    ? { status: 'linked' as const, linkId: 'link-1', sessionId: 'session-a', purpose: '讨论', visible: true }
    : chat === 'unlinked'
      ? { status: 'unlinked' as const }
      : { status: 'unavailable' as const, reason: 'pointer-not-here' };
  return {
    status: 'card',
    recordId: RECORD,
    contentHash: HASH,
    payload: {
      version: 1 as const,
      stoppedAt: '树重构到一半',
      nextStep: '补 2.7 验证',
      nextStepKind: 'suggested' as const,
      savedAt: new Date().toISOString(),
    },
    codeObservation: { status: 'not-configured' },
    chat: pointer,
  };
}

interface Calls {
  chatList: string[];
  sessions: string[];
  created: { instanceId: string; nodeIds: string[]; purpose: string }[];
  linked: { instanceId: string; sessionId: string; nodeIds: string[]; purpose: string }[];
  claimed: { instanceId: string; sessionId: string; purpose: string }[];
  unlinked: string[];
  rebinds: { instanceId: string; recordId: string; contentHash: string; mode: 'create' | 'link'; sessionId?: string; purpose: string }[];
  targets: string[];
  openedSessions: string[];
  snapshot: number;
  execute: number;
}

function harness(options: {
  chats?: ChatsView;
  sessions?: { sessionId: string; blank: boolean; running: boolean; updatedAt: number; linked: boolean }[];
  card?: ResumeCardView;
  createResult?: OverviewChatsView;
  linkResult?: OverviewChatsView;
  claimResult?: OverviewChatsView;
  unlinkResult?: OverviewChatsView;
  targetResult?: OverviewChatsView;
  rebindResult?: RebindResumeView;
  withoutChatDeps?: boolean;
  chatsResult?: OverviewChatsView;
} = {}): { controller: ProjectOverviewController; calls: Calls } {
  const calls: Calls = {
    chatList: [], sessions: [], created: [], linked: [], claimed: [], unlinked: [], rebinds: [],
    targets: [], openedSessions: [], snapshot: 0, execute: 0,
  };
  const transport: PanelTransport = {
    status: async () => ({
      configured: true, instanceId: A, projectId: 'p', sourceKind: 'custom',
      sourceDisplay: '/a', localRootDisplay: '/l', created: false, error: null,
    }),
    snapshot: async (): Promise<SnapshotResult> => {
      calls.snapshot += 1;
      return { status: 'unsynced', reason: 'unstable', attempts: 0, detail: 'stub' };
    },
    execute: async () => {
      calls.execute += 1;
      return { status: 'rejected', code: 'stub', message: 'stub' };
    },
  };
  const list: OverviewListResult = {
    status: 'listed',
    instances: [
      { instanceId: A, projectId: 'p', readable: true, sourceDisplay: '~/a', configured: true },
      { instanceId: B, projectId: 'p', readable: true, sourceDisplay: '~/b', configured: false },
    ],
  };
  const chatsView: OverviewChatsView = options.chatsResult ?? {
    status: 'committed',
    value: options.chats ?? emptyChats(),
    stateRevision: 3,
  };
  const deps = {
    listInstances: async (): Promise<OverviewListResult> => list,
    readResumeCard: async (): Promise<ResumeCardView> => options.card ?? { status: 'empty' },
    listResumeChats: async (_i: string): Promise<Exclude<ResumeChatsResult, null>> => ({ status: 'unavailable', reason: 'stub' }),
    linkResume: async (_i: string, _r: string, _l: string): Promise<Exclude<ResumeLinkResult, null>> =>
      ({ status: 'rejected', code: 'stub', message: 'stub' }),
    resolveChatTarget: async (_i: string, _r: string, _h: string, _l: string): Promise<Exclude<ResumeChatTargetResult, null>> =>
      ({ status: 'rejected', code: 'stub', message: 'stub' }),
    openSession: (sessionId: string): void => { calls.openedSessions.push(sessionId); },
    transportFor: (): PanelTransport => transport,
    newOperationId: (): string => `op-${calls.created.length + calls.linked.length + calls.claimed.length + calls.unlinked.length + 1}`,
  };
  if (options.withoutChatDeps === true) {
    return { controller: new ProjectOverviewController(deps), calls };
  }
  const controller = new ProjectOverviewController({
    ...deps,
    listChats: async (instanceId: string) => { calls.chatList.push(instanceId); return chatsView; },
    listChatSessions: async (instanceId: string) => {
      calls.sessions.push(instanceId);
      return { status: 'committed' as const, value: { sessions: options.sessions ?? [] }, stateRevision: -1 };
    },
    createChat: async (request) => {
      calls.created.push({ instanceId: request.instanceId, nodeIds: [...request.nodeIds], purpose: request.purpose });
      return (options.createResult ?? { status: 'committed', value: { sessionId: 'session-new', linkId: 'link-new', reusedBlank: true }, stateRevision: 4 }) as never;
    },
    linkChat: async (request) => {
      calls.linked.push({ instanceId: request.instanceId, sessionId: request.sessionId, nodeIds: [...request.nodeIds], purpose: request.purpose });
      return (options.linkResult ?? { status: 'committed', value: { linkId: 'link-1', reused: false }, stateRevision: 4 }) as never;
    },
    claimChat: async (request) => {
      calls.claimed.push({ instanceId: request.instanceId, sessionId: request.sessionId, purpose: request.purpose });
      return (options.claimResult ?? { status: 'committed', value: { linkId: 'link-2', reusedBlank: true }, stateRevision: 4 }) as never;
    },
    unlinkChat: async (request) => {
      calls.unlinked.push(request.linkId);
      return (options.unlinkResult ?? { status: 'committed', value: { removed: true }, stateRevision: 4 }) as never;
    },
    resolveChatLinkTarget: async (instanceId: string, linkId: string) => {
      calls.targets.push(`${instanceId}:${linkId}`);
      return (options.targetResult ?? { status: 'committed', value: { sessionId: 'session-a' }, stateRevision: -1 }) as never;
    },
    rebindResumeChat: async (request) => {
      calls.rebinds.push({
        instanceId: request.instanceId, recordId: request.recordId, contentHash: request.contentHash,
        mode: request.mode, ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        purpose: request.purpose,
      });
      return options.rebindResult ?? {
        status: 'linked', recordId: RECORD, linkId: 'link-1', sessionId: request.sessionId ?? 'session-new',
        purpose: request.purpose, reusedLink: false,
      };
    },
  });
  return { controller, calls };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('3.1 load 后按实例读取聊天：链接、可选会话与待核对意图如实投影，非配置实例带 configured=false', async () => {
  const { controller } = harness({
    chats: {
      links: [
        { linkId: 'link-1', sessionId: 'session-a', nodeIds: [NODE], purpose: '需求讨论', origin: 'panel', createdAt: 'x', updatedAt: 'x', visible: true, blank: false },
        { linkId: 'link-2', sessionId: 'session-gone', nodeIds: [NODE], purpose: '实现', origin: 'panel', createdAt: 'x', updatedAt: 'x', visible: false, blank: null },
      ],
      pendingIntents: [
        { operationId: 'op-p', action: 'create', nodeIds: [NODE], purpose: '待核对用途', origin: 'panel', createdAt: 'x', status: 'unknown', candidates: ['session-c'] },
      ],
    },
    sessions: [{ sessionId: 'session-a', blank: false, running: false, updatedAt: 1, linked: true }],
  });
  await controller.load();
  await settle();

  const state = controller.getState();
  assert.equal(state.chats.phase, 'ready');
  assert.equal(state.chats.links.length, 2);
  assert.equal(state.chats.links[1]?.visible, false, '失效链接可见性如实标注');
  assert.equal(state.chats.pending.length, 1);
  assert.equal(state.chats.pending[0]?.purpose, '待核对用途', '用户原文保留');
  assert.deepEqual(state.chats.pending[0]?.candidates, ['session-c']);
  assert.equal(state.chats.sessions[0]?.linked, true);

  const b = state.instances.find((row) => row.instanceId === B);
  assert.equal(b?.configured, false, '界面据此提示工作入口不可用');
  const a = state.instances.find((row) => row.instanceId === A);
  assert.equal(a?.configured, true);
});

test('3.1 创建聊天：未选节点给稳定提示且不调用宿主；选节点后按所选身份提交并刷新', async () => {
  const { controller, calls } = harness();
  await controller.load();
  await settle();

  assert.equal(await controller.createChat('讨论'), 'failed');
  assert.equal(controller.getState().chats.notice?.code, 'no-node-selected');
  assert.equal(calls.created.length, 0, '未选节点不得提交');

  controller.panelController(A).select(NODE);
  assert.equal(await controller.createChat('讨论'), 'ok');
  assert.deepEqual(calls.created, [{ instanceId: A, nodeIds: [NODE], purpose: '讨论' }]);
  assert.equal(controller.getState().chats.notice, null);

  // 空白用途在本地即拒绝，不触达宿主。
  assert.equal(await controller.createChat('  '), 'failed');
  assert.equal(controller.getState().chats.notice?.code, 'missing-purpose');
  assert.equal(calls.created.length, 1);
});

test('3.1 关联已有会话：会话身份随请求提交；宿主拒绝时保留稳定码', async () => {
  const { controller, calls } = harness({
    linkResult: { status: 'rejected', code: 'session-not-visible', message: '宿主会话列表中没有该 Session' },
  });
  await controller.load();
  await settle();
  controller.panelController(A).select(NODE);

  const result = await controller.linkSession('session-gone', '实现');
  assert.equal(result, 'failed');
  assert.deepEqual(calls.linked, [{ instanceId: A, sessionId: 'session-gone', nodeIds: [NODE], purpose: '实现' }]);
  assert.equal(controller.getState().chats.notice?.code, 'session-not-visible');
});

test('3.1 打开所选聊天：只做身份复查与导航，不发快照或命令', async () => {
  const { controller, calls } = harness();
  await controller.load();
  await settle();

  await controller.openChatLink('link-1');
  assert.deepEqual(calls.targets, [`${A}:link-1`]);
  assert.deepEqual(calls.openedSessions, ['session-a']);
  assert.equal(calls.snapshot, 0, '导航不得额外读快照');
  assert.equal(calls.execute, 0, '导航不得执行命令');
});

test('3.1 待核对认领与解绑：只对明确点击的候选／链接动作', async () => {
  const { controller, calls } = harness({
    chats: {
      links: [{ linkId: 'link-1', sessionId: 'session-a', nodeIds: [NODE], purpose: '讨论', origin: 'panel', createdAt: 'x', updatedAt: 'x', visible: true, blank: false }],
      pendingIntents: [{ operationId: 'op-p', action: 'create', nodeIds: [NODE], purpose: '待核对', origin: 'panel', createdAt: 'x', status: 'unknown', candidates: ['session-c'] }],
    },
  });
  await controller.load();
  await settle();

  const pending = controller.getState().chats.pending[0];
  assert.ok(pending !== undefined);
  assert.equal(await controller.claimPending(pending, 'session-c'), 'ok');
  assert.deepEqual(calls.claimed, [{ instanceId: A, sessionId: 'session-c', purpose: '待核对' }]);

  assert.equal(await controller.unlinkChat('link-1'), 'ok');
  assert.deepEqual(calls.unlinked, ['link-1']);
});

test('3.1 卡片显式重绑：无指针的接续记录可在当前实例建立关系后写指针', async () => {
  const { controller, calls } = harness({ card: cardWith('unlinked') });
  await controller.load();
  await controller.loadResumeCard(A);
  await settle();

  assert.equal(controller.beginRebindResume(), true);
  assert.equal(controller.getState().rebindDraft?.recordId, RECORD);

  // 重绑走 create：不需要页面里选节点，节点由记录主语决定（宿主侧解析）。
  assert.equal(await controller.createChat('接续重绑'), 'ok');
  assert.deepEqual(calls.rebinds, [{
    instanceId: A, recordId: RECORD, contentHash: HASH, mode: 'create', purpose: '接续重绑',
  }]);
  assert.equal(controller.getState().rebindDraft, null, '成功后清重绑草稿');
  assert.equal(calls.created.length, 0, '重绑不经普通创建入口');

  // 重绑走 link：选择已有会话。
  controller.beginRebindResume();
  assert.equal(await controller.linkSession('session-a', '接续重绑'), 'ok');
  assert.equal(calls.rebinds[1]?.mode, 'link');
  assert.equal(calls.rebinds[1]?.sessionId, 'session-a');
  assert.equal(calls.linked.length, 0, '重绑不经普通关联入口');

  // 取消重绑后回到普通路径。
  controller.beginRebindResume();
  controller.cancelRebindResume();
  assert.equal(controller.getState().rebindDraft, null);
});

test('3.1 切换实例：清空聊天区，A 的迟到响应不写入 B', async () => {
  let releaseLate: () => void = () => {};
  const lateView = (): OverviewChatsView => ({
    status: 'committed',
    value: {
      links: [{ linkId: 'link-a', sessionId: 'session-a', nodeIds: [NODE], purpose: 'A 的迟到结果', origin: 'panel', createdAt: 'x', updatedAt: 'x', visible: true, blank: false }],
      pendingIntents: [],
    },
    stateRevision: 9,
  });
  const controller = new ProjectOverviewController({
    listInstances: async (): Promise<OverviewListResult> => ({
      status: 'listed',
      instances: [
        { instanceId: A, projectId: 'p', readable: true, sourceDisplay: '~/a', configured: true },
        { instanceId: B, projectId: 'p', readable: true, sourceDisplay: '~/b', configured: false },
      ],
    }),
    readResumeCard: async (): Promise<ResumeCardView> => ({ status: 'empty' }),
    listResumeChats: async () => ({ status: 'unavailable', reason: 'stub' }),
    linkResume: async () => ({ status: 'rejected', code: 'stub', message: 'stub' }),
    resolveChatTarget: async () => ({ status: 'rejected', code: 'stub', message: 'stub' }),
    openSession: () => {},
    transportFor: () => ({
      status: async () => ({
        configured: true, instanceId: A, projectId: 'p', sourceKind: 'custom',
        sourceDisplay: '/a', localRootDisplay: '/l', created: false, error: null,
      }),
      snapshot: async () => ({ status: 'unsynced', reason: 'unstable', attempts: 0, detail: 'stub' }),
      execute: async () => ({ status: 'rejected', code: 'stub', message: 'stub' }),
    }),
    newOperationId: () => 'op-x',
    listChats: async (instanceId: string): Promise<OverviewChatsView> => {
      if (instanceId === A) {
        await new Promise<void>((resolve) => { releaseLate = resolve; });
        return lateView();
      }
      return { status: 'committed', value: emptyChats(), stateRevision: 1 };
    },
    listChatSessions: async () => ({ status: 'committed', value: { sessions: [] }, stateRevision: -1 }),
  });

  await controller.load();
  // A 的读取被挂起；切到 B 后聊天区先被清空再读 B。
  assert.equal(controller.getState().selectedId, A);
  assert.equal(controller.select(B), true);
  await settle();
  assert.equal(controller.getState().selectedId, B);
  assert.equal(controller.getState().chats.links.length, 0, 'B 自己的空列表');

  releaseLate();
  await settle();
  assert.equal(controller.getState().selectedId, B);
  assert.equal(controller.getState().chats.links.length, 0, 'A 的迟到结果被丢弃');
});

test('3.1 旧宿主缺聊天方法：消息区给 unavailable，写操作给稳定提示', async () => {
  const { controller } = harness({ withoutChatDeps: true });
  await controller.load();
  await settle();
  assert.equal(controller.getState().chats.phase, 'unavailable');
  assert.equal(controller.getState().chats.reason, 'chats-unavailable');

  controller.panelController(A).select(NODE);
  assert.equal(await controller.createChat('讨论'), 'failed');
  assert.equal(controller.getState().chats.notice?.code, 'chats-unavailable');
  assert.equal(await controller.openChatLink('link-1'), undefined);
  assert.equal(controller.getState().chats.phase, 'unavailable');
});
