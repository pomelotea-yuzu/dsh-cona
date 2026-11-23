// R2 收尾 4.2：概览里的路线图区（controller A 层）。
// 覆盖：v1 空态读取；启用预览与取消（不发命令）；预览后规划变化的本地拒绝；
// 确认按预览基线与摘要提交并重读路线图与卡片；待核对保留原 operationId 复用；拒绝清预览。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectOverviewController, type OverviewListResult } from '../src/client/project-overview-controller.js';
import type { PanelTransport, SnapshotResult } from '../src/client/api.js';
import type {
  RoadmapEnableImpact,
  RoadmapEnablePreviewResult,
  RoadmapStateResult,
} from '../src/application/command-service.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DIGEST = 'sha256:' + 'a'.repeat(64);

interface Calls {
  previews: number;
  reads: number;
  cards: number;
  executed: { operationId: string; command: unknown; expectedPlanVersion: string; expectedPlanRevision: number; sourceEpoch: number }[];
}

function impact(overrides: Partial<RoadmapEnableImpact> = {}): RoadmapEnableImpact {
  return {
    current: { schemaVersion: 1, planVersion: 'pv-1', planRevision: 2, sourceEpoch: 1 },
    target: { schemaVersion: 2, planVersion: 'pv-2' },
    milestoneCount: 0,
    identities: { projectId: 'p', nodeCount: 3, recordCount: 1 },
    verifications: [{
      recordId: 'rec-1', summary: '当前验证', status: 'pass', subjectVersion: 'pv-1', currentlyCurrent: true,
    }],
    previewDigest: DIGEST,
    ...overrides,
  };
}

function harness(options: {
  read?: () => RoadmapStateResult;
  preview?: () => RoadmapEnablePreviewResult;
  snapshotPlanVersion?: string;
  executeResult?: Awaited<ReturnType<PanelTransport['execute']>>;
} = {}): { controller: ProjectOverviewController; calls: Calls } {
  const calls: Calls = { previews: 0, reads: 0, cards: 0, executed: [] };
  let snapshotVersion = options.snapshotPlanVersion ?? 'pv-1';
  const transport: PanelTransport = {
    status: async () => ({
      configured: true, instanceId: A, projectId: 'p', sourceKind: 'custom',
      sourceDisplay: '/x', localRootDisplay: '/l', created: false, error: null,
    }),
    snapshot: async (): Promise<SnapshotResult> => ({
      status: 'snapshot',
      snapshot: {
        planVersion: snapshotVersion, planRevision: 2, sourceEpoch: 1,
        projectId: 'p', instanceId: A, schemaVersion: 1, stateRevision: 1, connectionGeneration: 0,
        sync: { status: 'synced' }, source: { kind: 'custom', displayPath: '/x' },
        project: { id: 'p', title: 'p', goal: 'g', constraints: [], repositories: [] },
        tree: [], dependencies: [], records: [], summary: { nodeCount: 0, doneCount: 0, dependencyCount: 0, blockedCount: 0 },
        local: { conversationCount: 0, workRunCount: 0, lastOperationAt: null, quarantined: null },
        readAt: '2026-11-23T00:00:00.000Z',
      },
    } as never),
    execute: async (request) => {
      calls.executed.push({
        operationId: request.operationId,
        command: request.command,
        expectedPlanVersion: request.expectedPlanVersion,
        expectedPlanRevision: request.expectedPlanRevision,
        sourceEpoch: request.sourceEpoch ?? 0,
      });
      if (options.executeResult !== undefined) return options.executeResult;
      snapshotVersion = 'pv-2';
      return { status: 'committed', operationId: request.operationId, planVersion: 'pv-2', planRevision: 3, stateRevision: 2, sourceEpoch: 1, impact: 'plan' };
    },
  };
  const list: OverviewListResult = {
    status: 'listed',
    instances: [{ instanceId: A, projectId: 'p', readable: true, sourceDisplay: '~/a', configured: true }],
  };
  const controller = new ProjectOverviewController({
    listInstances: async () => list,
    readResumeCard: async () => {
      calls.cards += 1;
      return { status: 'empty' };
    },
    listResumeChats: async () => ({ status: 'unavailable', reason: 'stub' }),
    linkResume: async () => ({ status: 'rejected', code: 'stub', message: 'stub' }),
    resolveChatTarget: async () => ({ status: 'rejected', code: 'stub', message: 'stub' }),
    openSession: () => undefined,
    transportFor: () => transport,
    newOperationId: () => 'op-roadmap-1',
    readRoadmap: async () => {
      calls.reads += 1;
      return options.read?.() ?? {
        status: 'ok',
        roadmap: { schemaVersion: 1, planVersion: 'pv-1', planRevision: 2, sourceEpoch: 1, enabled: false, milestones: [] },
      };
    },
    previewRoadmapEnable: async () => {
      calls.previews += 1;
      return options.preview?.() ?? { status: 'available', impact: impact() };
    },
  });
  return { controller, calls };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('4.2 v1 空态：选中实例即读取路线图，显示未启用与空里程碑', async () => {
  const { controller, calls } = harness();
  await controller.load();
  await settle();
  controller.select(A);
  await settle();
  const state = controller.getState().roadmap;
  assert.equal(state.phase, 'ready');
  assert.equal(state.view?.enabled, false);
  assert.deepEqual(state.view?.milestones, []);
  assert.equal(calls.reads, 1);
});

test('4.2 预览 → 取消：只读预览，不提交命令', async () => {
  const { controller, calls } = harness();
  await controller.load();
  await settle();
  controller.select(A);
  await settle();

  await controller.beginRoadmapEnable();
  const preview = controller.getState().roadmap.preview;
  assert.notEqual(preview, null);
  assert.equal(preview?.impact.previewDigest, DIGEST);
  assert.equal(preview?.operationId, 'op-roadmap-1');
  assert.equal(calls.previews, 1);

  controller.cancelRoadmapEnable();
  assert.equal(controller.getState().roadmap.preview, null);
  assert.equal(calls.executed.length, 0);
});

test('4.2 预览后规划变化：本地拒绝提交并清预览', async () => {
  const { controller, calls } = harness({ snapshotPlanVersion: 'pv-9' });
  await controller.load();
  await settle();
  controller.select(A);
  await settle();
  await controller.beginRoadmapEnable();
  await controller.confirmRoadmapEnable();
  const state = controller.getState().roadmap;
  assert.equal(calls.executed.length, 0, '不带着旧摘要提交');
  assert.equal(state.preview, null);
  assert.equal(state.notice?.code, 'preview-mismatch');
});

test('4.2 确认成功：按预览基线与摘要提交，随后重读路线图与接续卡片', async () => {
  const { controller, calls } = harness();
  await controller.load();
  await settle();
  controller.select(A);
  await settle();
  await controller.beginRoadmapEnable();
  const readsBefore = calls.reads;
  const cardsBefore = calls.cards;
  await controller.confirmRoadmapEnable();
  await settle();

  assert.equal(calls.executed.length, 1);
  const sent = calls.executed[0]!;
  assert.equal(sent.operationId, 'op-roadmap-1', '复用预览时的 operationId');
  assert.deepEqual(sent.command, { type: 'enable-roadmap', previewDigest: DIGEST });
  assert.equal(sent.expectedPlanVersion, 'pv-1');
  assert.equal(sent.expectedPlanRevision, 2);
  assert.ok(calls.reads > readsBefore, '提交后重读路线图');
  assert.ok(calls.cards > cardsBefore, '验证记录转历史后重读卡片');
  assert.equal(controller.getState().roadmap.preview, null);
  assert.equal(controller.getState().roadmap.notice, null);
});

test('4.2 待核对：保留预览与原 operationId，重试复用同一 id', async () => {
  const { controller, calls } = harness({
    executeResult: { status: 'pending-reconciliation', operationId: 'op-roadmap-1', stage: 'receipt', message: '资料已发布但回执未保存' },
  });
  await controller.load();
  await settle();
  controller.select(A);
  await settle();
  await controller.beginRoadmapEnable();
  await controller.confirmRoadmapEnable();
  const state = controller.getState().roadmap;
  assert.equal(state.notice?.code, 'receipt');
  assert.notEqual(state.preview, null, '待核对时保留预览与摘要');

  await controller.confirmRoadmapEnable();
  assert.equal(calls.executed.length, 2);
  assert.equal(calls.executed[1]?.operationId, calls.executed[0]?.operationId, '重试不换 operationId');
});

test('4.2 拒绝：清预览并展示稳定码（已启用时不再提示重试）', async () => {
  const { controller, calls } = harness({
    executeResult: { status: 'rejected', code: 'roadmap-already-enabled', message: '该规划已启用扩展（schemaVersion 2）' },
  });
  await controller.load();
  await settle();
  controller.select(A);
  await settle();
  await controller.beginRoadmapEnable();
  await controller.confirmRoadmapEnable();
  const state = controller.getState().roadmap;
  assert.equal(state.preview, null);
  assert.equal(state.notice?.code, 'roadmap-already-enabled');
  assert.equal(calls.executed.length, 1);
});
