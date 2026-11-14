// 面板控制器与 HTTP 传输测试（tasks 5.2）。
// 覆盖：打开成功／未配置；目标编辑保存；冲突与未知结果时草稿保留且不标已保存；
// 重试复用同一 operationId；新增节点 order 与变更原因记录；partial 如实上报；线格式。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PanelController, type PanelState } from '../src/client/panel-controller.js';
import { createHttpTransport, TransportError } from '../src/client/http-transport.js';
import type {
  CommandResult,
  ConaProjectStatus,
  ExecuteRequest,
  PanelSnapshot,
  PanelTransport,
  SnapshotResult,
} from '../src/client/api.js';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const ROOT_NODE = '00000000-0000-4000-8000-000000000002';
const CHILD_NODE = '00000000-0000-4000-8000-000000000003';

function snapshot(overrides: Partial<PanelSnapshot> = {}): PanelSnapshot {
  return {
    projectId: PROJECT_ID,
    instanceId: '11111111-1111-4111-8111-111111111111',
    sourceEpoch: 2,
    schemaVersion: 1,
    planVersion: 'sha256:' + 'a'.repeat(64),
    planRevision: 0,
    stateRevision: 0,
    connectionGeneration: 1,
    sync: { status: 'synced', requiresRefresh: false, basis: 'local-observation' },
    source: { kind: 'custom', displayPath: '~/projects/demo' },
    project: { id: PROJECT_ID, title: '示例', goal: '目标', constraints: [], repositories: [] },
    tree: [
      {
        id: ROOT_NODE,
        parentId: null,
        order: 0,
        title: '阶段1',
        goal: '交付可验证成果',
        completionCriteria: [],
        status: 'todo',
      },
      {
        id: CHILD_NODE,
        parentId: ROOT_NODE,
        order: 0,
        title: '阶段1.1',
        goal: '子目标',
        completionCriteria: [],
        status: 'todo',
      },
    ],
    dependencies: [],
    records: [],
    summary: {
      nodeCount: 2,
      rootCount: 1,
      maxDepth: 2,
      statusCounts: { todo: 2 },
      dependencyCount: 0,
      recordCount: 0,
      recordsByKind: {},
    },
    local: { conversationCount: 0, workRunCount: 0, quarantined: null },
    readAt: '2026-11-14T00:00:00.000Z',
    ...overrides,
  };
}

const READY_STATUS: ConaProjectStatus = {
  configured: true,
  instanceId: '11111111-1111-4111-8111-111111111111',
  projectId: PROJECT_ID,
  sourceKind: 'custom',
  sourceDisplay: '~/projects/demo',
  localRootDisplay: '~/data/dsh-cona/local',
  created: false,
  error: null,
};

interface Script {
  execute: (request: ExecuteRequest) => Promise<CommandResult> | CommandResult;
  /** 第 n 次读（0 为首次打开）返回的快照；缺省沿用上一次。 */
  snapshot?: (readIndex: number) => PanelSnapshot;
}

/** 记录调用的假传输：默认规划命令成功、快照按脚本推进。 */
function fakeTransport(script: Script): PanelTransport & { calls: ExecuteRequest[]; snapshots: number } {
  let current = snapshot();
  const calls: ExecuteRequest[] = [];
  const transport: PanelTransport & { calls: ExecuteRequest[]; snapshots: number } = {
    calls,
    snapshots: 0,
    status: async () => READY_STATUS,
    snapshot: async (): Promise<SnapshotResult> => {
      const index = transport.snapshots;
      transport.snapshots += 1;
      if (script.snapshot !== undefined) current = script.snapshot(index);
      return { status: 'snapshot', snapshot: current };
    },
    execute: async (request) => {
      calls.push(request);
      return script.execute(request);
    },
  };
  return transport;
}

let operationSeq = 0;
function controller(transport: PanelTransport): PanelController {
  return new PanelController({ transport, newOperationId: () => `op-${(operationSeq += 1)}` });
}

function committed(request: ExecuteRequest, planRevision: number): CommandResult {
  return {
    status: 'committed',
    operationId: request.operationId,
    impact: 'plan',
    planVersion: 'sha256:' + String(planRevision).padStart(64, 'b'),
    planRevision,
    stateRevision: planRevision,
    sourceEpoch: 2,
  };
}

test('打开：已配置时进入 ready 并选中首个根节点；未配置时给出原因', async () => {
  const transport = fakeTransport({ execute: () => {
    throw new Error('should not execute');
  } });
  const panel = controller(transport);
  await panel.open();
  const state = panel.getState();
  assert.equal(state.phase, 'ready');
  assert.equal(state.selectedNodeId, ROOT_NODE);
  assert.equal(state.snapshot?.source.displayPath, '~/projects/demo');
  assert.equal(panel.isDirty(), false);
  assert.equal(panel.isSaved(), false);

  const unconfigured = controller({
    status: async () => ({ ...READY_STATUS, configured: false, error: { code: 'binding-expired', message: '未配置 projectRoot' } }),
    snapshot: async () => {
      throw new Error('should not read');
    },
    execute: async () => {
      throw new Error('should not execute');
    },
  });
  await unconfigured.open();
  assert.equal(unconfigured.getState().phase, 'error');
  assert.equal(unconfigured.getState().message, '未配置 projectRoot');
});

test('目标编辑保存：用草稿基线提交，成功后清草稿并回读，标已保存', async () => {
  const transport = fakeTransport({
    execute: (request) => committed(request, 1),
    snapshot: (index) =>
      index === 0
        ? snapshot()
        : snapshot({
            planRevision: 1,
            stateRevision: 1,
            tree: [{ ...snapshot().tree[0]!, goal: '新的目标' }, snapshot().tree[1]!],
          }),
  });
  const panel = controller(transport);
  await panel.open();
  panel.editGoal(ROOT_NODE, '新的目标');
  assert.equal(panel.isDirty(), true);
  assert.equal(panel.isSaved(), false);

  const status = await panel.save();
  assert.equal(status, 'saved');
  assert.equal(transport.calls.length, 1);
  const request = transport.calls[0]!;
  assert.deepEqual(request.command, { type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '新的目标' } });
  assert.equal(request.expectedPlanVersion, snapshot().planVersion);
  assert.equal(request.expectedPlanRevision, 0);
  assert.equal(request.sourceEpoch, 2);

  const state = panel.getState();
  assert.equal(state.draft, null);
  assert.equal(state.save.status, 'saved');
  assert.equal(state.snapshot?.tree[0]?.goal, '新的目标');
  assert.equal(panel.isSaved(), true);
  assert.equal(panel.isDirty(), false);

  // 再次编辑立即清除“已保存”。
  panel.editGoal(ROOT_NODE, '再改一次');
  assert.equal(panel.isSaved(), false);
});

test('规划冲突：草稿与原因保留，不标已保存，operationId 不换', async () => {
  const transport = fakeTransport({
    execute: (request) => ({
      status: 'rejected',
      code: 'plan-conflict',
      message: '规划修订已变为 1',
      current: { planVersion: 'sha256:' + 'c'.repeat(64), planRevision: 1, sourceEpoch: 2 },
    }),
  });
  const panel = controller(transport);
  await panel.open();
  panel.editGoal(ROOT_NODE, '冲突目标');
  panel.setReason('因为新信息');
  const status = await panel.save();

  assert.equal(status, 'conflict');
  const state = panel.getState();
  assert.equal(state.draft?.goal, '冲突目标', '草稿保留');
  assert.equal(state.reason, '因为新信息', '原因保留');
  assert.equal(state.save.status, 'conflict');
  assert.equal(panel.isSaved(), false);
  assert.equal(transport.calls.length, 1, '冲突时不追加记录');
});

test('传输异常：结果未知，保留原 operationId，重试不换 id', async () => {
  let attempt = 0;
  const transport = fakeTransport({
    execute: (request) => {
      attempt += 1;
      if (attempt === 1) throw new TransportError('transport-failed', '连接中断');
      return committed(request, 1);
    },
  });
  const panel = controller(transport);
  await panel.open();
  panel.editGoal(ROOT_NODE, '未知结果');
  const first = await panel.save();
  assert.equal(first, 'failed');
  const firstId = panel.getState().draft?.operationId;
  assert.ok(firstId, '失败后草稿保留并记住 operationId');
  assert.equal(panel.getState().draft?.goal, '未知结果');
  assert.equal(panel.isSaved(), false);

  const second = await panel.save();
  assert.equal(second, 'saved');
  assert.equal(transport.calls[0]?.operationId, transport.calls[1]?.operationId, '重试复用同一 operationId');
});

test('pending-reconciliation：保留草稿与 operationId，不标已保存', async () => {
  const transport = fakeTransport({
    execute: (request) => ({
      status: 'pending-reconciliation',
      operationId: request.operationId,
      stage: 'head',
      message: '资料头发布结果未知',
    }),
  });
  const panel = controller(transport);
  await panel.open();
  panel.editGoal(ROOT_NODE, '待核对目标');
  const status = await panel.save();
  assert.equal(status, 'pending');
  assert.equal(panel.getState().save.status, 'pending');
  assert.equal(panel.getState().draft?.goal, '待核对目标');
  assert.equal(panel.isSaved(), false);
});

test('新增节点：order 取同级最大值 +1，原因在规划后追加为 plan-change 记录', async () => {
  const transport = fakeTransport({
    execute: (request) => committed(request, request.command.type === 'append-record' ? 1 : 1),
    snapshot: (index) => (index === 0 ? snapshot() : snapshot({ planRevision: 1, stateRevision: 1 })),
  });
  const panel = controller(transport);
  await panel.open();
  panel.select(ROOT_NODE);
  panel.beginAddNode();
  panel.editDraft({ title: '新阶段', goal: '新目标', criteria: ['可验证'] });
  panel.setReason('因为拆分需要');
  const status = await panel.save();

  assert.equal(status, 'saved');
  assert.equal(transport.calls.length, 2);
  const planCommand = transport.calls[0]!.command;
  assert.equal(planCommand.type, 'add-nodes');
  if (planCommand.type === 'add-nodes') {
    assert.equal(planCommand.nodes[0]?.parentId, ROOT_NODE);
    assert.equal(planCommand.nodes[0]?.order, 1, '同级已有 order 0，新节点取 1');
    assert.deepEqual(planCommand.nodes[0]?.completionCriteria, ['可验证']);
  }
  const recordCommand = transport.calls[1]!.command;
  assert.equal(recordCommand.type, 'append-record');
  if (recordCommand.type === 'append-record') {
    assert.equal(recordCommand.kind, 'plan-change');
    assert.match(recordCommand.summary, /拆分/);
  }
  assert.equal(panel.getState().save.status, 'saved');
  assert.equal(panel.getState().reason, '', '成功后清空原因');
});

test('原因记录写入失败：标 partial，原因保留，不谎报已保存', async () => {
  const transport = fakeTransport({
    execute: (request) =>
      request.command.type === 'append-record'
        ? { status: 'rejected', code: 'invalid-project', message: '记录未通过校验' }
        : committed(request, 1),
    snapshot: (index) => (index === 0 ? snapshot() : snapshot({ planRevision: 1, stateRevision: 1 })),
  });
  const panel = controller(transport);
  await panel.open();
  panel.editGoal(ROOT_NODE, '已保存的目标');
  panel.setReason('原因写不进去');
  const status = await panel.save();

  assert.equal(status, 'partial');
  const state = panel.getState();
  assert.equal(state.save.status, 'partial');
  assert.equal(state.reason, '原因写不进去', '原因保留可重试');
  assert.equal(state.snapshot?.planRevision, 1, '规划已保存并回读');
  assert.equal(panel.isSaved(), false, '不得标已保存');
});

test('HTTP 传输：args 按参数名封装，HTTP 与解析错误归一为 TransportError', async () => {
  const seen: { url: string; body: unknown }[] = [];
  const okFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({
        type: 'server-response',
        rpcId: 'rpc-1',
        result: { ok: true, value: { status: 'snapshot', snapshot: snapshot() } },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const transport = createHttpTransport({ fetchImpl: okFetch as typeof fetch, rpcId: () => 'rpc-1' });
  const result = await transport.snapshot({ connectionGeneration: 1 });
  assert.equal(result.status, 'snapshot');
  assert.equal(seen[0]?.url, '/api/conaProject/snapshot');
  assert.deepEqual(seen[0]?.body, {
    type: 'client-request',
    rpcId: 'rpc-1',
    method: 'conaProject/snapshot',
    payload: { args: { request: { connectionGeneration: 1 } } },
  });

  const httpFail = createHttpTransport({
    fetchImpl: (async () => new Response('nope', { status: 401 })) as typeof fetch,
  });
  await assert.rejects(() => httpFail.snapshot({ connectionGeneration: 1 }), (error: unknown) => {
    assert.equal((error as TransportError).code, 'transport-http');
    return true;
  });

  const serverReject = createHttpTransport({
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          type: 'server-response',
          rpcId: 'rpc-2',
          result: { ok: false, error: { code: 'gateway/arguments-invalid', message: 'args 不匹配' } },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch,
  });
  await assert.rejects(() => serverReject.status(), (error: unknown) => {
    assert.equal((error as TransportError).code, 'gateway/arguments-invalid');
    return true;
  });
});

/** 只用于类型收敛：确保 PanelState 变更字段被控制器完整填充。 */
export type PanelStateShape = PanelState;

// ── 5.3：连接代际、源代际、乱序快照与草稿分离 ─────────────────────────────

/** 按顺序返回快照（或抛错）的假传输；超过序列长度后重复最后一个。 */
function sequencedTransport(
  behaviors: (PanelSnapshot | Error)[],
  executeImpl?: (request: ExecuteRequest) => CommandResult,
): PanelTransport & { calls: ExecuteRequest[]; reads: number } {
  let index = 0;
  const calls: ExecuteRequest[] = [];
  const transport: PanelTransport & { calls: ExecuteRequest[]; reads: number } = {
    calls,
    reads: 0,
    status: async () => READY_STATUS,
    snapshot: async (): Promise<SnapshotResult> => {
      const behavior = behaviors[Math.min(index, behaviors.length - 1)];
      index += 1;
      transport.reads += 1;
      if (behavior === undefined) throw new Error('空序列');
      if (behavior instanceof Error) throw behavior;
      return { status: 'snapshot', snapshot: behavior };
    },
    execute: async (request) => {
      calls.push(request);
      return executeImpl === undefined ? committed(request, 1) : executeImpl(request);
    },
  };
  return transport;
}

function snapshotResult(value: PanelSnapshot): SnapshotResult {
  return { status: 'snapshot', snapshot: value };
}

test('旧连接：换代后的迟到答复按代际丢弃', async () => {
  const transport = sequencedTransport([
    snapshot({ stateRevision: 0 }),
    snapshot({ stateRevision: 1, planRevision: 1 }),
  ]);
  const panel = controller(transport);
  await panel.open();
  await panel.reconnect();
  assert.equal(panel.getState().connection.generation, 2);
  assert.equal(panel.getState().snapshot?.stateRevision, 1);

  // 旧代际（1）的答复即使修订更高也不采纳。
  const outcome = panel.ingest(snapshotResult(snapshot({ stateRevision: 9, planRevision: 9 })), 1);
  assert.equal(outcome, 'stale-generation');
  assert.equal(panel.getState().snapshot?.stateRevision, 1, '不被旧代际答复覆盖');
});

test('源代际：旧源整份丢弃，新源即使修订更小也接受', async () => {
  const transport = sequencedTransport([snapshot({ sourceEpoch: 2, stateRevision: 5 })]);
  const panel = controller(transport);
  await panel.open();
  const generation = panel.getState().connection.generation;

  assert.equal(panel.ingest(snapshotResult(snapshot({ sourceEpoch: 1, stateRevision: 99 })), generation), 'stale-source');
  assert.equal(panel.getState().snapshot?.sourceEpoch, 2);

  const replaced = snapshot({ sourceEpoch: 3, stateRevision: 0, planRevision: 0 });
  assert.equal(panel.ingest(snapshotResult(replaced), generation), 'applied');
  assert.equal(panel.getState().snapshot?.sourceEpoch, 3, '换代是替换边界，不比较修订大小');
  assert.equal(panel.getState().snapshot?.stateRevision, 0);
});

test('乱序快照：同代际内更旧的修订不覆盖', async () => {
  const transport = sequencedTransport([snapshot({ stateRevision: 2 })]);
  const panel = controller(transport);
  await panel.open();
  const generation = panel.getState().connection.generation;

  assert.equal(panel.ingest(snapshotResult(snapshot({ stateRevision: 1 })), generation), 'stale-revision');
  assert.equal(panel.getState().snapshot?.stateRevision, 2);
  assert.equal(panel.ingest(snapshotResult(snapshot({ stateRevision: 3 })), generation), 'applied');
  assert.equal(panel.getState().snapshot?.stateRevision, 3);
});

test('旧回执不回退：提交后回读被更旧快照覆盖时不降级', async () => {
  const transport = sequencedTransport(
    [snapshot({ stateRevision: 0 }), snapshot({ stateRevision: 1, planRevision: 1 })],
    (request) => committed(request, 1),
  );
  const panel = controller(transport);
  await panel.open();
  panel.editGoal(ROOT_NODE, '提交一次');
  assert.equal(await panel.save(), 'saved');
  assert.equal(panel.getState().snapshot?.stateRevision, 1);

  // 迟到的旧回执触发的读取（更旧修订）不得把树退回去。
  const generation = panel.getState().connection.generation;
  assert.equal(panel.ingest(snapshotResult(snapshot({ stateRevision: 0 })), generation), 'stale-revision');
  assert.equal(panel.getState().snapshot?.stateRevision, 1);
  assert.equal(panel.isSaved(), true);
});

test('草稿跨重连、换代与轮询保留；只在保存成功或放弃时清空', async () => {
  const transport = sequencedTransport([
    snapshot({ stateRevision: 0 }),
    snapshot({ stateRevision: 1, planRevision: 1, sourceEpoch: 3 }),
    snapshot({ stateRevision: 2, planRevision: 2, sourceEpoch: 3 }),
  ]);
  const panel = controller(transport);
  await panel.open();
  panel.editGoal(ROOT_NODE, '跨换代草稿');
  assert.equal(panel.isDraftBaselineStale(), false);

  await panel.reconnect();
  assert.equal(panel.getState().draft?.goal, '跨换代草稿', '重连不清草稿');
  assert.equal(panel.isDraftBaselineStale(), true, '换代后草稿基线已落后');

  await panel.poll();
  assert.equal(panel.getState().draft?.goal, '跨换代草稿', '轮询刷新不清草稿');

  panel.discardDraft();
  assert.equal(panel.getState().draft, null);
});

test('断线：轮询失败标离线保留内容，重连后代际 +1 并完整回读', async () => {
  const transport = sequencedTransport([
    snapshot({ stateRevision: 0 }),
    new Error('连接中断'),
    snapshot({ stateRevision: 4, planRevision: 4 }),
  ]);
  const panel = controller(transport);
  await panel.open();
  const before = panel.getState().connection.generation;

  assert.equal(await panel.poll(), 'failed');
  assert.equal(panel.getState().connection.status, 'offline');
  assert.equal(panel.getState().snapshot?.stateRevision, 0, '断线不清空树');

  await panel.reconnect();
  const state = panel.getState();
  assert.equal(state.connection.generation, before + 1);
  assert.equal(state.connection.status, 'connected');
  assert.equal(state.snapshot?.stateRevision, 4, '重连完整回读');
});

test('轮询：覆盖新修订并清掉离线提示', async () => {
  const transport = sequencedTransport([
    snapshot({ stateRevision: 0 }),
    snapshot({ stateRevision: 1, planRevision: 1 }),
  ]);
  const panel = controller(transport);
  await panel.open();
  panel.markOffline('网络抖动');
  assert.equal(await panel.poll(), 'applied');
  assert.equal(panel.getState().snapshot?.stateRevision, 1);
  assert.equal(panel.getState().connection.status, 'connected');
  assert.equal(panel.getState().connection.error, null);
});
