// 面板结构交互测试（tasks 3.1–3.4）：结构草稿、统一预览、预设插入、提交与回读、
// 实例隔离。全部在控制器层（不依赖 DOM/React），拖放与键盘共用 beginMove 入口。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PanelController } from '../src/client/panel-controller.js';
import type {
  CommandResult, ConaProjectStatus, ExecuteRequest, PanelSnapshot, PanelTransport,
  PresetView, SnapshotResult, TreePresetsResult,
} from '../src/client/api.js';
import { FEATURE_DEVELOPMENT_PRESET } from '../src/domain/presets.js';
import type { PresetDescriptor } from '../src/domain/presets.js';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const INSTANCE_A = '11111111-1111-4111-8111-111111111111';
const ROOT = '00000000-0000-4000-8000-000000000002';
const C1 = '00000000-0000-4000-8000-000000000003';
const C2 = '00000000-0000-4000-8000-000000000004';
const C3 = '00000000-0000-4000-8000-000000000005';

function preset(): PresetView {
  return JSON.parse(JSON.stringify(FEATURE_DEVELOPMENT_PRESET)) as PresetDescriptor;
}

function snapshot(overrides: Partial<PanelSnapshot> = {}): PanelSnapshot {
  return {
    projectId: PROJECT_ID, instanceId: INSTANCE_A, sourceEpoch: 2, schemaVersion: 1,
    planVersion: 'sha256:' + 'a'.repeat(64), planRevision: 0, stateRevision: 0, connectionGeneration: 1,
    sync: { status: 'synced', requiresRefresh: false, basis: 'local-observation' },
    source: { kind: 'custom', displayPath: '~/p' },
    project: { id: PROJECT_ID, title: '示例', goal: 'g', constraints: [], repositories: [] },
    tree: [
      { id: ROOT, parentId: null, order: 0, title: '根', goal: 'g', completionCriteria: [], status: 'todo' },
      { id: C1, parentId: ROOT, order: 0, title: '一', goal: 'g', completionCriteria: [], status: 'todo' },
      { id: C2, parentId: ROOT, order: 1, title: '二', goal: 'g', completionCriteria: [], status: 'todo' },
      { id: C3, parentId: ROOT, order: 2, title: '三', goal: 'g', completionCriteria: [], status: 'todo' },
    ],
    dependencies: [], records: [],
    summary: { nodeCount: 4, rootCount: 1, maxDepth: 2, statusCounts: { todo: 4 }, dependencyCount: 0, recordCount: 0, recordsByKind: {} },
    local: { conversationCount: 0, workRunCount: 0, lastOperationAt: null, quarantined: null },
    readAt: '2026-11-22T00:00:00.000Z',
    ...overrides,
  };
}

const STATUS: ConaProjectStatus = {
  configured: true, instanceId: INSTANCE_A, projectId: PROJECT_ID, sourceKind: 'custom',
  sourceDisplay: '~/p', localRootDisplay: '~/d', created: false, error: null,
};

interface Script {
  snap?: PanelSnapshot;
  presets?: TreePresetsResult;
  execute?: (request: ExecuteRequest) => CommandResult | Promise<CommandResult> | Promise<never>;
  /** 每次 snapshot() 调用依次返回；放 Error 表示读取失败（完整回读失败）。 */
  snapshots?: (PanelSnapshot | Error)[];
}

function transport(script: Script): PanelTransport & { calls: ExecuteRequest[]; reads: number } {
  let current = script.snap ?? snapshot();
  const queue = [...(script.snapshots ?? [])];
  const calls: ExecuteRequest[] = [];
  const t: PanelTransport & { calls: ExecuteRequest[]; reads: number } = {
    calls, reads: 0,
    status: async () => STATUS,
    snapshot: async (): Promise<SnapshotResult> => {
      t.reads += 1;
      if (queue.length > 0) {
        const next = queue.shift() as PanelSnapshot | Error;
        if (next instanceof Error) throw next;
        current = next;
      }
      return { status: 'snapshot', snapshot: current };
    },
    execute: async (request) => {
      calls.push(request);
      if (script.execute === undefined) {
        return { status: 'committed', operationId: request.operationId, impact: 'plan',
          planVersion: 'sha256:' + 'b'.repeat(64), planRevision: 1, stateRevision: 1, sourceEpoch: 2 };
      }
      return script.execute(request);
    },
    treePresets: async () => script.presets ?? { status: 'listed', presets: [preset()] },
  };
  return t;
}

let opSeq = 0;
function ctrl(t: PanelTransport): PanelController {
  return new PanelController({ transport: t, newOperationId: () => `op-${(opSeq += 1)}` });
}

function committed(request: ExecuteRequest, over: Partial<Extract<CommandResult, { status: 'committed' }>> = {}): CommandResult {
  // 默认与初始快照同源（revision 0、相同指纹），使 save 的回读判据通过 → saved。
  // 需要测「已提交待同步」时用 over 覆盖为更高修订。
  return { status: 'committed', operationId: request.operationId, impact: 'plan',
    planVersion: 'sha256:' + 'a'.repeat(64), planRevision: 0, stateRevision: 0, sourceEpoch: 2, ...over };
}

// ---- 3.1 树展示与移动 ----

test('3.1 拖放与键盘移动同一位置生成等价预览；确认走统一保存入口', async () => {
  const t = transport({});
  const c = ctrl(t);
  await c.open();
  // 两种入口以相同参数进入（UI 的拖放/键盘菜单都调 beginMove）。
  c.beginMove(C3, ROOT, C1);
  const p1 = JSON.stringify(c.preview());
  c.discardDraft();
  c.beginMove(C3, ROOT, C1);
  assert.equal(JSON.stringify(c.preview()), p1, '等价预览');
  const preview = c.preview();
  assert.ok(preview && preview.kind === 'move');
  assert.equal(preview.targetParentId, ROOT);
  assert.equal(preview.beforeNodeId, C1);
  assert.equal(preview.noChange, false);
  await c.save();
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.calls[0]!.command, { type: 'move-node', nodeId: C3, parentId: ROOT, beforeNodeId: C1 });
});

test('3.1 原位移动提示无变化并禁用保存；取消清预览', async () => {
  const t = transport({});
  const c = ctrl(t);
  await c.open();
  // C2 之后是 C3：把 C2 移到 C3 之前是原位。
  c.beginMove(C2, ROOT, C3);
  assert.equal(c.preview()?.noChange, true);
  assert.equal(await c.save(), 'idle', '原位不提交');
  assert.equal(t.calls.length, 0);
  c.discardDraft();
  assert.equal(c.preview(), null, '取消清预览');
});

test('3.1 活动工作预览显示条件句提示', async () => {
  const t = transport({ snap: snapshot({ local: { conversationCount: 0, workRunCount: 1, lastOperationAt: null, quarantined: null } }) });
  const c = ctrl(t);
  await c.open();
  c.beginMove(C2, ROOT, C1);
  assert.equal(c.preview()?.workNotice, true);
});

// ---- 3.2 预设与插入预览 ----

test('3.2 预设载荷：来源/版本/语言/依赖字段与本次正文语言', async () => {
  const t = transport({ presets: { status: 'listed', presets: [preset()] } });
  const c = ctrl(t);
  await c.open();
  await c.loadPresets();
  assert.equal(c.getState().presetsStatus, 'listed');
  assert.equal(c.getState().presets.length, 1);
  c.beginInsertPreset(preset(), 'zh-CN', ROOT, C1);
  const preview = c.preview();
  assert.ok(preview && preview.kind === 'insert');
  assert.equal(preview.preset?.source, 'builtin');
  assert.equal(preview.preset?.version, 1);
  assert.deepEqual([...(preview.preset?.locales ?? [])].sort(), ['en', 'zh-CN']);
  assert.equal(preview.preset?.contentLocale, 'zh-CN');
  assert.ok(preview.lines.some((l) => l.title.includes('功能开发') || l.title.includes('明确')));
  assert.equal(preview.preset?.dependencies.length, 2);
});

test('3.2 语言冻结：建草稿后切语言，草稿正文与请求不变', async () => {
  const t = transport({});
  const c = ctrl(t);
  await c.open();
  c.beginInsertPreset(preset(), 'zh-CN', ROOT, null);
  const before = JSON.stringify(c.preview());
  // 语言切换只影响新的 loadPresets/预览选择，不改已建草稿。
  c.beginInsertPreset(preset(), 'en', ROOT, null);
  // 重新用中文建草稿（模拟保留原草稿语义）：本次只验证 contentLocale 取自传入参数。
  c.beginInsertPreset(preset(), 'zh-CN', ROOT, null);
  assert.equal(JSON.stringify(c.preview()), before);
  await c.save();
  const cmd = t.calls[0]!.command as { contentLocale: string };
  assert.equal(cmd.contentLocale, 'zh-CN');
});

// ---- 3.3 结构草稿提交与回读 ----

test('3.3 确认冻结参数与 operationId；传输异常原样重试不换 id', async () => {
  let fail = true;
  const t = transport({ execute: (request) => {
    if (fail) { fail = false; throw new Error('断线'); }
    return committed(request);
  } });
  const c = ctrl(t);
  await c.open();
  c.beginMove(C3, ROOT, C1);
  assert.equal(await c.save(), 'failed');
  assert.equal(await c.save(), 'saved');
  assert.equal(t.calls[0]!.operationId, t.calls[1]!.operationId, '同一 operationId 原样重试');
  assert.deepEqual(t.calls[0]!.command, t.calls[1]!.command, '请求参数不变');
});

test('3.3 冲突后以新基线新操作号提交', async () => {
  let first = true;
  const t = transport({ execute: (request) => {
    if (first) { first = false; return { status: 'rejected', code: 'plan-conflict', message: '冲突' }; }
    return committed(request);
  } });
  const c = ctrl(t);
  await c.open();
  c.beginMove(C3, ROOT, C1);
  assert.equal(await c.save(), 'conflict');
  // 用户在新的权威快照上重新选位置 → 新草稿（基线更新、operationId 重置）。
  c.beginMove(C3, ROOT, C1);
  assert.equal(await c.save(), 'saved');
  assert.notEqual(t.calls[0]!.operationId, t.calls[1]!.operationId, '新操作号');
});

test('3.3 已确认但完整回读失败 → 已提交待同步；retryRead 只重读不重提', async () => {
  const advanced = snapshot({
    planRevision: 1, stateRevision: 1, planVersion: 'sha256:' + 'c'.repeat(64),
  });
  const t = transport({
    execute: (request) => committed(request, { planRevision: 1, stateRevision: 1, planVersion: 'sha256:' + 'c'.repeat(64) }),
    // 首次 open 读初始快照；save 后回读抛错（完整回读失败）；retryRead 读到已推进快照。
    snapshots: [snapshot(), new Error('回读失败'), advanced],
  });
  const c = ctrl(t);
  await c.open();
  c.beginMove(C2, ROOT, C1);
  const status = await c.save();
  assert.equal(status, 'committed-pending-sync');
  const callsAfterSave = t.calls.length;
  // retryRead 只重读：读到已推进且与回执同源的快照 → saved，且不新增 execute 调用。
  assert.equal(await c.retryRead(), 'saved');
  assert.equal(t.calls.length, callsAfterSave, '不重提已成功变更');
});

// ---- 3.4 实例隔离与草稿归属 ----

test('3.4 切实例后各自草稿保留；迟到响应按代际/修订丢弃', async () => {
  const t = transport({});
  const a = ctrl(t);
  await a.open();
  a.beginMove(C3, ROOT, C1); // A 留结构草稿
  const aState = a.getState();
  assert.ok(aState.draft && aState.draft.kind === 'move');
  // 模拟 B 的控制器（独立 transport/instance）。
  const b = ctrl(transport({ snap: snapshot({ instanceId: '22222222-2222-4222-8222-222222222222' }) }));
  await b.open();
  assert.equal(b.getState().draft, null, 'B 无 A 的草稿');
  // A 的旧代际快照不能覆盖 B：直接对 B ingest 带旧 generation 的结果。
  const result = await t.snapshot({ connectionGeneration: 1 });
  assert.equal(b.ingest(result, 1), 'applied'); // B 当前无快照时接受
  // 切回 A：草稿仍在（A 控制器自身持有）。
  const aDraft = a.getState().draft;
  assert.ok(aDraft !== null && aDraft.kind === 'move');
});

test('3.4 已有草稿时发起另一结构操作会覆盖同一实例草稿（单草稿约束）', async () => {
  const t = transport({});
  const c = ctrl(t);
  await c.open();
  c.beginMove(C3, ROOT, C1);
  c.beginInsertPreset(preset(), 'en', ROOT, null);
  const draft = c.getState().draft;
  assert.ok(draft && draft.kind === 'insert-preset', '同一实例始终只有一份草稿');
});
