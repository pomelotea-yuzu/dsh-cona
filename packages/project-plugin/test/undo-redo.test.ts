// 经核对的规划撤销与重做（tasks 2.3，design §2「撤销与重做」）。
// A 层：逆向信息持久化、预览/历史查询、无关编辑保留、单次修订、冲突与幂等；
// F 层：真实文件后端重算候选、重启后回读、逆向数据只在本机、合并的 clear/新 replace 记录。

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProjectCommandService,
  type Command,
  type CommandEnvelope,
  type CommandResult,
  type TrustedContext,
} from '../src/application/command-service.js';
import { LocalStateService } from '../src/application/local-state.js';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { createSourceFiles } from '../src/adapters/fs/source-files.js';
import { resolveLocalRoot, rootRelation } from '../src/adapters/fs/local-root.js';
import { inspectPrivateRoot } from '../src/adapters/fs/git-guard.js';
import { validateProjectDocument } from '../src/domain/validate.js';
import { parseReplacementText } from '../src/domain/replacement.js';
import { buildPlanInverse, applyPlanInverse, checkInverseState, validatePlanInverse } from '../src/domain/inverse.js';
import type { ProjectDocument, Sha256Fn, WorkNode } from '../src/domain/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sample = path.join(packageRoot, 'formats', 'v1', 'sample-project.json');
const formatsDir = path.join(packageRoot, 'formats', 'v1');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const ROOT_NODE = '00000000-0000-4000-8000-000000000002';
const CHILD_NODE = '00000000-0000-4000-8000-000000000003';
const OWNER: TrustedContext = { kind: 'remote-owner' };

interface Fixture {
  base: string;
  localRoot: string;
  source: string;
  instanceId: string;
  service: ProjectCommandService;
  store: LocalStateStore;
  doc: () => ProjectDocument;
  envelope: (command: Command, overrides?: Partial<CommandEnvelope>) => CommandEnvelope;
  aggregate: () => Record<string, any>;
  saveAggregate: (value: unknown) => void;
  registerEntry: () => { sourceGeneration: number };
}

async function setup(name: string, options: { newNodeIds?: string[] } = {}): Promise<Fixture> {
  const allocated = options.newNodeIds === undefined ? null : [...options.newNodeIds];
  const nextNodeId = (): string => allocated && allocated.length > 0 ? allocated.shift()! : randomUUID();
  const base = mkdtempSync(path.join(artifacts, name));
  const localRoot = path.join(base, 'local');
  const source = path.join(base, 'source');
  mkdirSync(source, { recursive: true });
  copyFileSync(sample, path.join(source, 'project.json'));

  const store = new LocalStateStore();
  const files = createSourceFiles(formatsDir, sha256);
  const clock = (): string => new Date().toISOString();
  const localState = new LocalStateService({
    resolver: { resolveLocal: resolveLocalRoot, relation: rootRelation },
    git: { inspect: inspectPrivateRoot }, store, clock,
    newInstanceId: () => randomUUID(),
  });
  const registered = await localState.register({
    localDataRoot: localRoot, sourceRoot: source, sourceKind: 'custom', projectId: PROJECT_ID,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) throw new Error('register failed');
  const instanceId = registered.entry.instanceId;

  const service = new ProjectCommandService({
    localRoot, store, files, sha256, clock,
    newNodeId: nextNodeId, newRecordId: () => randomUUID(),
  });
  const doc = (): ProjectDocument =>
    JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as ProjectDocument;
  const aggregatePath = path.join(localRoot, 'instances', instanceId, 'state.json');
  const envelope = (command: Command, overrides: Partial<CommandEnvelope> = {}): CommandEnvelope => {
    const current = doc();
    const agg = JSON.parse(readFileSync(aggregatePath, 'utf8')) as { revisions: { plan: number } };
    return {
      operationId: randomUUID(),
      projectId: PROJECT_ID,
      instanceId,
      sourceEpoch: registered.entry.sourceGeneration,
      expectedPlanVersion: current.planVersion,
      expectedPlanRevision: agg.revisions.plan,
      command,
      ...overrides,
    };
  };
  return {
    base, localRoot, source, instanceId, service, store, doc, envelope,
    aggregate: () => JSON.parse(readFileSync(aggregatePath, 'utf8')) as Record<string, any>,
    saveAggregate: (value) => writeFileSync(aggregatePath, JSON.stringify(value)),
    registerEntry: () => {
      const registry = JSON.parse(readFileSync(path.join(localRoot, 'registry.json'), 'utf8')) as { instances: { sourceGeneration: number }[] };
      return registry.instances[0] as { sourceGeneration: number };
    },
  };
}

function rejected(result: CommandResult): Extract<CommandResult, { status: 'rejected' }> {
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  return result as Extract<CommandResult, { status: 'rejected' }>;
}

function committed(result: CommandResult): Extract<CommandResult, { status: 'committed' }> {
  assert.equal(result.status, 'committed', JSON.stringify(result));
  return result as Extract<CommandResult, { status: 'committed' }>;
}

/** 预览指定操作的撤销/重做并断言可用，返回确认指纹。 */
async function availablePreview(fx: Fixture, operationId: string, direction: 'undo' | 'redo'): Promise<string> {
  const preview = await fx.service.previewInverse(OWNER, { instanceId: fx.instanceId, targetOperationId: operationId, direction });
  assert.equal(preview.status, 'available', JSON.stringify(preview));
  return preview.previewDigest;
}

// ---- 领域层：前后值与三向无关编辑的基础语义 ----

test('2.3 领域 inverse 只记录变化字段，undo/redo 往返保留无关字段', () => {
  const before: ProjectDocument = JSON.parse(readFileSync(sample, 'utf8')) as ProjectDocument;
  const after: ProjectDocument = {
    ...before,
    plan: {
      ...before.plan,
      nodes: before.plan.nodes.map((n) => n.id === ROOT_NODE ? { ...n, goal: '新目标' } : n),
    },
  };
  const inverse = buildPlanInverse({
    operationId: randomUUID(), commandType: 'update-node', sourceEpoch: 1,
    before: before.plan, after: after.plan,
    beforePlanVersion: before.planVersion, afterPlanVersion: after.planVersion,
  });
  assert.deepEqual(inverse.fieldChanges.map((c) => c.field), ['goal']);
  assert.equal(inverse.generatedNodes.length, 0);
  assert.equal(validatePlanInverse(JSON.parse(JSON.stringify(inverse)))?.operationId, inverse.operationId);
  // 无关字段被后续编辑改动：当前 goal 仍是操作后值，undo 可恢复 goal 且保留 title。
  const withUnrelated: ProjectDocument = {
    ...after,
    plan: { ...after.plan, nodes: after.plan.nodes.map((n) => n.id === ROOT_NODE ? { ...n, title: '后来改名' } : n) },
  };
  const undone = applyPlanInverse(withUnrelated.plan, inverse, 'undo');
  assert.equal(undone.ok, true);
  if (!undone.ok) return;
  const root = undone.value.nodes.find((n) => n.id === ROOT_NODE) as WorkNode;
  assert.equal(root.goal, before.plan.nodes.find((n) => n.id === ROOT_NODE)?.goal);
  assert.equal(root.title, '后来改名', '无关字段保留');
  const redone = applyPlanInverse(undone.value, inverse, 'redo');
  assert.equal(redone.ok, true);
  if (!redone.ok) return;
  assert.equal((redone.value.nodes.find((n) => n.id === ROOT_NODE) as WorkNode).goal, '新目标');
  // 触碰字段已改：goal 已不是操作后值，undo 被拒绝。
  const touched: ProjectDocument = {
    ...after,
    plan: { ...after.plan, nodes: after.plan.nodes.map((n) => n.id === ROOT_NODE ? { ...n, goal: '又被改动' } : n) },
  };
  assert.equal(checkInverseState(touched.plan, inverse, 'undo').ok, false);
});

// ---- 服务与文件后端 ----

test('2.3 字段撤销：保留无关编辑、单次修订、逆向只留本机、重启后仍可回读', async () => {
  const fx = await setup('undo-field-');
  const r1 = committed(await fx.service.execute(OWNER, fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '目标A' } })));
  const opId = r1.operationId;
  const agg1 = fx.aggregate();
  const record = agg1.operations.find((o: any) => o.operationId === opId);
  assert.ok(record.inverse, 'owner 规划编辑保存逆向信息');
  assert.equal(record.inverse.commandType, 'update-node');
  assert.equal(validatePlanInverse(record.inverse)?.operationId, opId);

  // 无关编辑：改 title，不影响原操作的 goal 逆向。
  committed(await fx.service.execute(OWNER, fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { title: '后来改名' } })));
  const revBeforeUndo = fx.aggregate().revisions.plan;

  const digest = await availablePreview(fx, opId, 'undo');
  const rUndo = committed(await fx.service.execute(OWNER, fx.envelope({
    type: 'undo-plan-edit', targetOperationId: opId, previewDigest: digest,
  })));
  assert.equal(rUndo.planRevision, revBeforeUndo + 1, '撤销只增一次规划修订');
  assert.equal(fx.aggregate().revisions.plan, revBeforeUndo + 1);
  const undone = fx.doc();
  assert.equal(undone.plan.nodes.find((n) => n.id === ROOT_NODE)?.goal, '交付可验证成果', 'goal 已恢复');
  assert.equal(undone.plan.nodes.find((n) => n.id === ROOT_NODE)?.title, '后来改名', '无关编辑保留');
  assert.equal(validateProjectDocument(undone, { sha256 }).ok, true);
  assert.equal(JSON.stringify(undone).includes('inverse'), false, '公开资料不含逆向数据');

  // 重做目标：同一原操作为 target。
  const redoDigest = await availablePreview(fx, opId, 'redo');
  const rRedo = committed(await fx.service.execute(OWNER, fx.envelope({
    type: 'redo-plan-edit', targetOperationId: opId, previewDigest: redoDigest,
  })));
  assert.equal(rRedo.planRevision, revBeforeUndo + 2, '重做只增一次规划修订');
  const redone = fx.doc();
  assert.equal(redone.plan.nodes.find((n) => n.id === ROOT_NODE)?.goal, '目标A');
  assert.equal(redone.plan.nodes.find((n) => n.id === ROOT_NODE)?.title, '后来改名', '重做也保留无关编辑');

  // 重启：新建服务实例，历史与逆向仍可读。
  const restarted = new ProjectCommandService({
    localRoot: fx.localRoot, store: fx.store,
    files: createSourceFiles(formatsDir, sha256), sha256,
    clock: () => new Date().toISOString(), newNodeId: () => randomUUID(), newRecordId: () => randomUUID(),
  });
  const history = await restarted.undoHistory(OWNER, { instanceId: fx.instanceId });
  assert.equal(history.status, 'committed');
  assert.ok(history.status === 'committed' && history.entries.some((e) => e.operationId === opId && e.canUndo));
  const previewAfterRestart = await restarted.previewInverse(OWNER, { instanceId: fx.instanceId, targetOperationId: opId, direction: 'undo' });
  assert.equal(previewAfterRestart.status, 'available');
});

test('2.3 模板插入的撤销：生成节点按原身份移除，单次修订', async () => {
  const fx = await setup('undo-template-');
  const beforeCount = fx.doc().plan.nodes.length;
  const r1 = committed(await fx.service.execute(OWNER, fx.envelope({
    type: 'insert-preset', templateId: 'feature-development', templateVersion: 1,
    contentLocale: 'zh-CN', parentId: ROOT_NODE, beforeNodeId: null,
  })));
  assert.equal(fx.doc().plan.nodes.length > beforeCount, true);
  const inverse = fx.aggregate().operations.find((o: any) => o.operationId === r1.operationId).inverse;
  assert.ok(inverse.generatedNodes.length > 0, '预设节点身份记录在逆向信息');
  const digest = await availablePreview(fx, r1.operationId, 'undo');
  committed(await fx.service.execute(OWNER, fx.envelope({
    type: 'undo-plan-edit', targetOperationId: r1.operationId, previewDigest: digest,
  })));
  assert.equal(fx.doc().plan.nodes.length, beforeCount, '撤销移除整批生成节点');
  assert.equal(validateProjectDocument(fx.doc(), { sha256 }).ok, true);
});

test('2.3 结构移动与分组的撤销/重做往返', async () => {
  const a = randomUUID(); const b = randomUUID();
  const fx = await setup('undo-structure-', { newNodeIds: [a, b] });
  // 建一棵三节点同父级子树（节点身份由 fixture 的稳定分配队列给出）。
  const input = (id: string, order: number, title: string) => ({
    parentId: ROOT_NODE, order, title, goal: `goal-${title}`, completionCriteria: [], status: 'todo' as const,
  });
  committed(await fx.service.execute(OWNER, fx.envelope({
    type: 'add-nodes', nodes: [input(a, 1, 'A'), input(b, 2, 'B')],
  })));
  const orderBefore = fx.doc().plan.nodes.filter((n) => n.parentId === ROOT_NODE).map((n) => n.id);
  const rMove = committed(await fx.service.execute(OWNER, fx.envelope({
    type: 'move-node', nodeId: b, parentId: ROOT_NODE, beforeNodeId: a,
  })));
  const orderAfter = fx.doc().plan.nodes.filter((n) => n.parentId === ROOT_NODE).map((n) => n.id);
  assert.notDeepEqual(orderAfter, orderBefore);
  const undoDigest = await availablePreview(fx, rMove.operationId, 'undo');
  committed(await fx.service.execute(OWNER, fx.envelope({
    type: 'undo-plan-edit', targetOperationId: rMove.operationId, previewDigest: undoDigest,
  })));
  assert.deepEqual(
    fx.doc().plan.nodes.filter((n) => n.parentId === ROOT_NODE).map((n) => n.id), orderBefore,
    '撤销恢复原同级顺序',
  );
  const redoDigest = await availablePreview(fx, rMove.operationId, 'redo');
  committed(await fx.service.execute(OWNER, fx.envelope({
    type: 'redo-plan-edit', targetOperationId: rMove.operationId, previewDigest: redoDigest,
  })));
  assert.deepEqual(
    fx.doc().plan.nodes.filter((n) => n.parentId === ROOT_NODE).map((n) => n.id), orderAfter,
    '重做恢复新顺序',
  );
});

test('2.3 冲突：无逆向信息、字段已改、节点被引用、活动 WorkRun、换源、预览过期', async () => {
  const fx = await setup('undo-conflict-');
  // 无逆向信息的旧操作：手工把一条 committed 但无 inverse 的记录写入聚合。
  const legacy = await setup('undo-legacy-');
  const agg = legacy.aggregate();
  agg.operations.push({
    operationId: randomUUID(), requestDigest: 'sha256:' + '0'.repeat(64),
    origin: { kind: 'remote-owner' }, status: 'committed',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    baseline: { expectedPlanVersion: legacy.doc().planVersion, expectedPlanRevision: 0, sourceEpoch: 1 },
    generated: {}, result: { impact: 'state', planVersion: legacy.doc().planVersion, planRevision: 0, stateRevision: 1, sourceEpoch: 1 },
  });
  legacy.saveAggregate(agg);
  const legacyPreview = await legacy.service.previewInverse(OWNER, {
    instanceId: legacy.instanceId, targetOperationId: (agg.operations as any[]).at(-1).operationId, direction: 'undo',
  });
  assert.equal(legacyPreview.status, 'unavailable');
  assert.match((legacyPreview as any).message, /旧操作没有逆向信息/);

  // 字段已改：A 改 goal，随后 B 再改 goal。
  const r1 = committed(await fx.service.execute(OWNER, fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: 'A' } })));
  committed(await fx.service.execute(OWNER, fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: 'B' } })));
  const touched = await fx.service.previewInverse(OWNER, { instanceId: fx.instanceId, targetOperationId: r1.operationId, direction: 'undo' });
  assert.equal(touched.status, 'conflict', JSON.stringify(touched));
  assert.ok((touched as any).conflicts.some((c: any) => c.code === 'inverse-field-changed'));

  // 节点被公开记录引用：用干净夹具插入预设，追加记录 subject 指向生成节点。
  const fx2 = await setup('undo-record-ref-');
  const ins = committed(await fx2.service.execute(OWNER, fx2.envelope({
    type: 'insert-preset', templateId: 'feature-development', templateVersion: 1,
    contentLocale: 'zh-CN', parentId: ROOT_NODE, beforeNodeId: null,
  })));
  const generated = fx2.aggregate().operations.find((o: any) => o.operationId === ins.operationId).inverse.generatedNodes as WorkNode[];
  committed(await fx2.service.execute(OWNER, fx2.envelope({
    type: 'append-record', kind: 'analysis-note', subjectNodeIds: [generated[0]!.id],
    summary: '占用生成节点', sources: [], body: '正文',
  })));
  const refPreview = await fx2.service.previewInverse(OWNER, { instanceId: fx2.instanceId, targetOperationId: ins.operationId, direction: 'undo' });
  assert.equal(refPreview.status, 'conflict');
  assert.ok((refPreview as any).conflicts.some((c: any) => c.code === 'inverse-node-in-use' && c.kind === 'record'));

  // 活动 WorkRun 与换源：用干净夹具做字段编辑，再分别篡改本机状态。
  const fx3 = await setup('undo-active-');
  const r3 = committed(await fx3.service.execute(OWNER, fx3.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: 'X' } })));
  const agg3 = fx3.aggregate();
  agg3.workRuns.push({
    workRunId: 'run-1', workIntentId: 'intent-1', sessionId: 's', turn: 1, bootGeneration: 1,
    bindingVersion: 1, acceptedBaseline: { planVersion: fx3.doc().planVersion, planRevision: 1, sourceEpoch: 1 },
    targets: [ROOT_NODE], allowedActions: ['update'], reasonScope: 'local', rpcId: 'rpc',
    status: 'active', startedAt: new Date().toISOString(),
  });
  fx3.saveAggregate(agg3);
  const activePreview = await fx3.service.previewInverse(OWNER, { instanceId: fx3.instanceId, targetOperationId: r3.operationId, direction: 'undo' });
  assert.equal(activePreview.status, 'conflict');
  assert.ok((activePreview as any).conflicts.some((c: any) => c.code === 'inverse-work-active'));

  // 换源：提升注册表代际后预览，inverse.sourceEpoch 已过期。
  const entry = fx3.registerEntry();
  entry.sourceGeneration = 2;
  writeFileSync(path.join(fx3.localRoot, 'registry.json'), JSON.stringify({
    schemaVersion: 2, instances: [entry], migrations: [],
  }));
  const sourcePreview = await fx3.service.previewInverse(OWNER, { instanceId: fx3.instanceId, targetOperationId: r3.operationId, direction: 'undo' });
  assert.equal(sourcePreview.status, 'conflict');
  assert.ok((sourcePreview as any).conflicts.some((c: any) => c.code === 'source-changed'));
});

test('2.3 预览过期与重复操作号：不接受旧指纹，同号重放只回读原回执', async () => {
  const fx = await setup('undo-replay-');
  const r1 = committed(await fx.service.execute(OWNER, fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: 'Z' } })));
  const digest = await availablePreview(fx, r1.operationId, 'undo');
  // 预览后基线变化：另一个编辑推进指纹。
  committed(await fx.service.execute(OWNER, fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { title: '变了' } })));
  const stale = await fx.service.execute(OWNER, fx.envelope({
    type: 'undo-plan-edit', targetOperationId: r1.operationId, previewDigest: digest,
  }));
  // 预览指纹覆盖当前基线；基线变了即不匹配（或在更早的 plan-conflict 被拦下）。
  assert.equal(stale.status, 'rejected', JSON.stringify(stale));

  // 用当前基线重新预览并成功撤销，记录撤销操作号。
  const fresh = await availablePreview(fx, r1.operationId, 'undo');
  const undoEnv = fx.envelope({ type: 'undo-plan-edit', targetOperationId: r1.operationId, previewDigest: fresh });
  const undo = committed(await fx.service.execute(OWNER, undoEnv));
  const replay = await fx.service.execute(OWNER, undoEnv);
  assert.equal(replay.status, 'committed');
  assert.equal((replay as any).replayed, true, '同号重放返回原回执');
  assert.equal(replay.operationId, undo.operationId);
});

test('2.3 合并的撤销追加 clear 记录、重做产生新 replace 记录（E02 补充）', async () => {
  const source = randomUUID();
  const fx = await setup('undo-merge-', { newNodeIds: [source] });
  const keep = CHILD_NODE;
  committed(await fx.service.execute(OWNER, fx.envelope({
    type: 'add-nodes', nodes: [{
      parentId: ROOT_NODE, order: 1, title: 'S', goal: 'goal-S', completionCriteria: [], status: 'todo',
    }],
  })));
  // source 没有触及任何依赖边，合并无需处置依赖。
  const merge = committed(await fx.service.execute(OWNER, fx.envelope({
    type: 'merge-nodes', keepNodeId: keep, sourceNodeIds: [source],
    patch: undefined, resolutions: [],
  })));
  assert.ok(merge.recordId, '合并发布替代记录');
  const inverse = fx.aggregate().operations.find((o: any) => o.operationId === merge.operationId).inverse;
  assert.equal(inverse.replacement?.replacementNodeId, keep);

  // 撤销合并：来源恢复为 done、发布 clear 记录。
  const undoDigest = await availablePreview(fx, merge.operationId, 'undo');
  const undo = committed(await fx.service.execute(OWNER, fx.envelope({
    type: 'undo-plan-edit', targetOperationId: merge.operationId, previewDigest: undoDigest,
  })));
  assert.ok(undo.recordId, '撤销追加 clear 记录');
  assert.notEqual(undo.recordId, merge.recordId, 'clear 是新记录');
  const clearDoc = fx.doc();
  const clearEntry = clearDoc.records.find((r) => r.id === undo.recordId);
  assert.ok(clearEntry?.summary.startsWith('[cona:replacement] '));
  const clearBody = readFileSync(path.join(fx.source, clearEntry!.path), 'utf8');
  assert.equal((parseReplacementText(clearBody) as any).body.kind, 'clear');
  assert.equal(fx.doc().plan.nodes.find((n) => n.id === source)?.status, 'todo', '来源恢复');

  // 重做合并：来源再次取消、产生新的 replace 记录（旧历史保留）。
  const redoDigest = await availablePreview(fx, merge.operationId, 'redo');
  const redo = committed(await fx.service.execute(OWNER, fx.envelope({
    type: 'redo-plan-edit', targetOperationId: merge.operationId, previewDigest: redoDigest,
  })));
  assert.ok(redo.recordId);
  assert.notEqual(redo.recordId, merge.recordId, '重做产生新 replace 记录，旧历史保留');
  const redoEntry = fx.doc().records.find((r) => r.id === redo.recordId);
  const redoBody = readFileSync(path.join(fx.source, redoEntry!.path), 'utf8');
  assert.equal((parseReplacementText(redoBody) as any).body.kind, 'replace');
  assert.equal(fx.doc().plan.nodes.find((n) => n.id === source)?.status, 'canceled', '来源再次取消');
  assert.equal(validateProjectDocument(fx.doc(), { sha256 }).ok, true);
});
