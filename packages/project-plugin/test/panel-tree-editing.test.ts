// 统一树编辑器（tasks 2.6）：面板控制器层的多选、批量编辑草稿、预览/确认、
// 异步只读目录与跨实例草稿隔离。焦点还原由渲染层负责（无 DOM 测试框架，H 层 5.3 验）。
// 全部在控制器层，不依赖 DOM/React/Node。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PanelController } from '../src/client/panel-controller.js';
import type {
  CommandResult, ConaProjectStatus, ExecuteRequest, InversePreviewResult,
  PanelSnapshot, PanelTransport, SnapshotResult, UndoHistoryResult, UserTemplateListResult,
} from '../src/client/api.js';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const INSTANCE = '11111111-1111-4111-8111-111111111111';
const ROOT = '00000000-0000-4000-8000-000000000002';
const C1 = '00000000-0000-4000-8000-000000000003';
const C2 = '00000000-0000-4000-8000-000000000004';
const C3 = '00000000-0000-4000-8000-000000000005';

function snapshot(overrides: Partial<PanelSnapshot> = {}): PanelSnapshot {
  return {
    projectId: PROJECT_ID, instanceId: INSTANCE, sourceEpoch: 2, schemaVersion: 1,
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
  configured: true, instanceId: INSTANCE, projectId: PROJECT_ID, sourceKind: 'custom',
  sourceDisplay: '~/p', localRootDisplay: '~/d', created: false, error: null,
};

const TEMPLATE = {
  source: 'user' as const, templateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  versionRecordId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  contentHash: 'sha256:' + 'c'.repeat(64), bodyLanguage: 'zh-CN', title: '可复用流程',
};

interface Script {
  snap?: PanelSnapshot;
  execute?: (r: ExecuteRequest) => CommandResult | Promise<CommandResult>;
  undoHistory?: UndoHistoryResult;
  userTemplates?: UserTemplateListResult;
  previewUndo?: InversePreviewResult;
}

function transport(script: Script): PanelTransport & { calls: ExecuteRequest[] } {
  const calls: ExecuteRequest[] = [];
  return {
    calls,
    status: async () => STATUS,
    snapshot: async (): Promise<SnapshotResult> => ({ status: 'snapshot', snapshot: script.snap ?? snapshot() }),
    execute: async (r) => {
      calls.push(r);
      return script.execute?.(r) ?? {
        status: 'committed', operationId: r.operationId, impact: 'plan',
        planVersion: 'sha256:' + 'a'.repeat(64), planRevision: 0, stateRevision: 0, sourceEpoch: 2,
      };
    },
    undoHistory: script.undoHistory === undefined ? undefined : async () => script.undoHistory!,
    userTemplates: script.userTemplates === undefined ? undefined : async () => script.userTemplates!,
    previewUndo: script.previewUndo === undefined ? undefined : async () => script.previewUndo!,
  };
}

let seq = 0;
function ctrl(t: PanelTransport): PanelController {
  return new PanelController({ transport: t, newOperationId: () => `op-${(seq += 1)}` });
}

test('2.6 键盘/点击多选：toggleSelect 与 clearSelection 独立维护，单选保留焦点', async () => {
  const c = ctrl(transport({}));
  await c.open();
  c.select(C1);
  assert.deepEqual(c.getState().selectedNodeIds, [C1]);
  c.toggleSelect(C2);
  c.toggleSelect(C3);
  assert.deepEqual(c.getState().selectedNodeIds, [C1, C2, C3]);
  assert.equal(c.getState().selectedNodeId, C3, '最后切换的节点保持焦点');
  c.toggleSelect(C2);
  assert.deepEqual(c.getState().selectedNodeIds, [C1, C3]);
  c.clearSelection();
  assert.deepEqual(c.getState().selectedNodeIds, []);
});

test('2.6 分组/合并/复制：预览期间不落盘，确认后提交精确载荷', async () => {
  const t = transport({});
  const c = ctrl(t);
  await c.open();
  // 分组：多选 + 内容。
  c.toggleSelect(C1); c.toggleSelect(C2);
  c.beginGroup({ title: '新组', goal: 'g', completionCriteria: ['条件'] }, null);
  assert.equal(t.calls.length, 0, '预览期间无落盘');
  assert.equal(c.preview()?.kind, 'group');
  assert.deepEqual(c.preview()?.sources, ['一', '二']);
  await c.save();
  assert.deepEqual(t.calls[0]!.command, {
    type: 'group-nodes', nodeIds: [C1, C2],
    group: { title: '新组', goal: 'g', completionCriteria: ['条件'] }, anchorId: null,
  });

  // 合并：keep 为多选之一，依赖处置逐条传入。
  c.discardDraft();
  c.clearSelection();
  c.toggleSelect(C1); c.toggleSelect(C3);
  c.beginMerge(C1, { goal: '' }, [{ edge: { nodeId: C3, requiresNodeId: C1 }, action: 'drop' }]);
  assert.equal(c.preview()?.kind, 'merge');
  assert.deepEqual(c.preview()?.sources, ['三'], '合并来源不含保留节点');
  await c.save();
  assert.deepEqual(t.calls[1]!.command, {
    type: 'merge-nodes', keepNodeId: C1, sourceNodeIds: [C3],
    resolutions: [{ edge: { nodeId: C3, requiresNodeId: C1 }, action: 'drop' }],
  });

  // 复制：单选源 + 目标位置 + 外部依赖。
  c.discardDraft();
  c.select(C3);
  c.beginCopy(ROOT, C1, [{ nodeId: C3, requiresNodeId: C1 }]);
  assert.equal(c.preview()?.kind, 'copy');
  assert.deepEqual(c.preview()?.externalDependencies, [{ from: '三', to: '一' }]);
  await c.save();
  assert.deepEqual(t.calls[2]!.command, {
    type: 'copy-subtree', nodeId: C3, targetParentId: ROOT, anchorId: C1,
    externalDependencies: [{ nodeId: C3, requiresNodeId: C1 }],
  });
});

test('2.6 撤销/重做：只读预览取指纹，草稿载荷冻结，拒绝不进入草稿', async () => {
  const opId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const preview: InversePreviewResult = {
    status: 'available', previewDigest: 'sha256:' + 'e'.repeat(64), direction: 'undo',
    target: { operationId: opId, commandType: 'update-node', sourceEpoch: 2, createdAt: '2026-11-23T00:00:00.000Z', afterPlanVersion: 'sha256:' + 'f'.repeat(64) },
    inverse: { affectedNodeIds: [C1], fieldCount: 1, generatedNodeCount: 0, removedNodeCount: 0, dependencyChangeCount: 0 },
    current: { planVersion: 'sha256:' + 'a'.repeat(64), planRevision: 0, sourceEpoch: 2 },
  };
  const t = transport({ previewUndo: preview });
  const c = ctrl(t);
  await c.open();
  const got = await c.previewUndoAction(opId, 'undo');
  assert.deepEqual(got, { ok: true, previewDigest: preview.previewDigest });
  c.beginUndo(opId, preview.previewDigest, 'undo');
  assert.equal(c.preview()?.kind, 'undo');
  await c.save();
  assert.deepEqual(t.calls[0]!.command, {
    type: 'undo-plan-edit', targetOperationId: opId, previewDigest: preview.previewDigest,
  });
});

test('2.6 独立回读：撤销历史与用户模板目录可空态/拒绝态/列出态', async () => {
  const t = transport({
    undoHistory: {
      status: 'committed', instanceId: INSTANCE,
      entries: [{ operationId: 'op1', commandType: 'update-node', createdAt: 't', sourceEpoch: 2, beforePlanVersion: 'x', afterPlanVersion: 'y', affectedNodeIds: [C1], canUndo: true, canRedo: false }],
    },
    userTemplates: { status: 'committed', instanceId: INSTANCE, templates: [TEMPLATE] },
  });
  const c = ctrl(t);
  await c.open();
  await c.loadUndoHistory();
  await c.loadUserTemplates();
  assert.equal(c.getState().undoHistory.status, 'listed');
  assert.equal(c.getState().undoHistory.entries.length, 1);
  assert.equal(c.getState().undoHistory.entries[0]!.canUndo, true);
  assert.equal(c.getState().userTemplates.status, 'listed');
  assert.deepEqual(c.getState().userTemplates.templates[0], TEMPLATE);

  // 模板插入草稿：三元组来自目录，位置为现有父节点。
  c.beginInsertUserTemplate(TEMPLATE, ROOT, C1);
  assert.equal(c.preview()?.kind, 'insert-user-template');
  assert.deepEqual(c.preview()?.templateSource, {
    templateId: TEMPLATE.templateId, versionRecordId: TEMPLATE.versionRecordId,
    contentHash: TEMPLATE.contentHash, bodyLanguage: 'zh-CN',
  });
  await c.save();
  assert.deepEqual(t.calls[0]!.command, {
    type: 'insert-user-template', templateId: TEMPLATE.templateId,
    versionRecordId: TEMPLATE.versionRecordId, contentHash: TEMPLATE.contentHash,
    parentId: ROOT, beforeNodeId: C1,
  });

  // 宿主未挂载只读方法 → 明确诊断，不猜测内容。
  const bare = ctrl(transport({}));
  await bare.open();
  await bare.loadUndoHistory();
  await bare.loadUserTemplates();
  assert.equal(bare.getState().undoHistory.status, 'rejected');
  assert.equal(bare.getState().undoHistory.code, 'unsupported');
  assert.equal(bare.getState().userTemplates.status, 'rejected');
  assert.equal(bare.getState().userTemplates.code, 'unsupported');
});

test('2.6 模板保存草稿与跨实例/快照刷新隔离：草稿与基线不受刷新影响', async () => {
  const t = transport({});
  const c = ctrl(t);
  await c.open();
  c.beginSaveUserTemplate('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '模板', 'zh-CN', C3);
  assert.equal(c.preview()?.kind, 'save-template');
  assert.deepEqual(c.preview()?.sources, ['三']);
  const baseline = c.getState().draft!.baseline;
  // 快照刷新（同一源、更高修订）不清草稿、不改基线。
  c.ingest({ status: 'snapshot', snapshot: snapshot({ planRevision: 1, stateRevision: 1 }) }, 1);
  assert.deepEqual(c.getState().draft!.baseline, baseline, '基线冻结');
  assert.equal(c.getState().draft!.kind, 'save-user-template', '草稿保留');
  await c.save();
  assert.equal(t.calls[0]!.command.type, 'save-user-template');

  // 另一个控制器实例草稿互不影响（每实例一份的语义由控制器隔离承载）。
  const other = ctrl(transport({}));
  await other.open();
  assert.equal(other.getState().draft, null);
  other.beginMove(C2, ROOT, C1);
  assert.equal(c.getState().draft, null, '保存后原草稿已清，另一个控制器不共享');
  assert.equal(other.getState().draft?.kind, 'move');
});
