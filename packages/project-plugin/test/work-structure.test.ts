// R2 收尾 3.3：受限 Agent 的移动与插入（A/F 层）。
// 覆盖：结构影响范围计算（子树／源与目的同级变序／根组标记）；缺动作、源／目标越权、
// 根组未授权、模板版本未授权、旧绑定与旧基线的拒绝码；两类根级插入返回 parent-not-found
// 且不落候选；获准父节点下的内置／用户模板插入与移动经共享提交协议发布，新节点不加入目标集合；
// owner 在活动运行中改基线后旧运行写法被拒。

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstanceCommandQueue } from '../src/application/command-queue.js';
import {
  WorkService,
  commandTargets,
  structuralImpact,
  type PlanOutline,
  type WorkCapture,
} from '../src/application/work.js';
import { ProjectCommandService, type Command, type TrustedContext } from '../src/application/command-service.js';
import { LocalStateService } from '../src/application/local-state.js';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { createSourceFiles } from '../src/adapters/fs/source-files.js';
import { resolveLocalRoot, rootRelation } from '../src/adapters/fs/local-root.js';
import { inspectPrivateRoot } from '../src/adapters/fs/git-guard.js';
import { computePlanVersion } from '../src/domain/canonical/plan-fingerprint.js';
import { FEATURE_DEVELOPMENT_PRESET } from '../src/domain/presets.js';
import type { PlanNodeViewPort } from '../src/application/ports.js';
import type { ProjectDocument, Sha256Fn, WorkNode } from '../src/domain/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const formatsDir = path.join(packageRoot, 'formats', 'v1');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const R1 = '00000000-0000-4000-8000-000000000101';
const R2 = '00000000-0000-4000-8000-000000000102';
const NODE_A = '00000000-0000-4000-8000-000000000103';
const NODE_B = '00000000-0000-4000-8000-000000000104';
const NODE_C = '00000000-0000-4000-8000-000000000105';
const NODE_A1 = '00000000-0000-4000-8000-000000000106';
const NODE_A2 = '00000000-0000-4000-8000-000000000107';
const NODE_D = '00000000-0000-4000-8000-000000000108';

function node(id: string, parentId: string | null, order: number, title: string): WorkNode {
  return { id, parentId, order, title, goal: `${title} 的目标`, completionCriteria: [], status: 'todo' };
}

/** 夹具：根 [R1,R2]；R1 下 [A,B,C]；A 下 [A1,A2]；R2 下 [D]。 */
function fixtureDoc(): ProjectDocument {
  const draft: ProjectDocument = {
    schemaVersion: 1,
    project: { id: PROJECT_ID, title: '结构授权夹具', goal: '测试', constraints: [], repositories: [] },
    plan: {
      nodes: [
        node(R1, null, 0, 'R1'),
        node(R2, null, 1, 'R2'),
        node(NODE_A, R1, 0, 'A'),
        node(NODE_B, R1, 1, 'B'),
        node(NODE_C, R1, 2, 'C'),
        node(NODE_A1, NODE_A, 0, 'A1'),
        node(NODE_A2, NODE_A, 1, 'A2'),
        node(NODE_D, R2, 0, 'D'),
      ],
      dependencies: [],
    },
    planVersion: '',
    records: [],
  };
  draft.planVersion = computePlanVersion(draft, sha256).planVersion;
  return draft;
}

const OUTLINE: PlanOutline = {
  nodes: [
    { id: R1, parentId: null, order: 0 },
    { id: R2, parentId: null, order: 1 },
    { id: NODE_A, parentId: R1, order: 0 },
    { id: NODE_B, parentId: R1, order: 1 },
    { id: NODE_C, parentId: R1, order: 2 },
    { id: NODE_A1, parentId: NODE_A, order: 0 },
    { id: NODE_A2, parentId: NODE_A, order: 1 },
    { id: NODE_D, parentId: R2, order: 0 },
  ],
};

interface Harness {
  service: ProjectCommandService;
  work: WorkService;
  source: string;
  localRoot: string;
  instanceId: string;
  sourceEpoch: number;
  doc(): ProjectDocument;
  revision(): number;
  state(): { workRuns: { workRunId: string; bindingVersion: number; targets: string[]; templates?: unknown[] }[] };
  envelope(command: Command, overrides?: Partial<{ expectedPlanVersion: string; expectedPlanRevision: number }>): {
    operationId: string;
    projectId: string;
    instanceId: string;
    sourceEpoch: number;
    expectedPlanVersion: string;
    expectedPlanRevision: number;
    command: Command;
  };
  capture(sessionId: string): Promise<WorkCapture>;
}

function planNodesOf(source: string): PlanNodeViewPort {
  const read = (): ProjectDocument => JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as ProjectDocument;
  return {
    async currentNodeIds() {
      return { ok: true as const, nodeIds: new Set(read().plan.nodes.map((item) => item.id)) };
    },
    async planOutline() {
      return {
        ok: true as const,
        nodes: read().plan.nodes.map((item) => ({ id: item.id, parentId: item.parentId, order: item.order })),
      };
    },
    async nodeDetails(ids) {
      const doc = read();
      return {
        ok: true as const,
        nodes: doc.plan.nodes.filter((item) => ids.includes(item.id)).map((item) => ({ id: item.id, title: item.title, status: item.status })),
        records: doc.records.map((record) => ({
          id: record.id, kind: record.kind, summary: record.summary,
          subjectNodeIds: [...record.subjectNodeIds], path: record.path,
        })),
      };
    },
  };
}

async function setup(): Promise<Harness> {
  const base = mkdtempSync(path.join(artifacts, 'work-structure-'));
  const localRoot = path.join(base, 'local');
  const source = path.join(base, 'source');
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, 'project.json'), JSON.stringify(fixtureDoc(), null, 2) + '\n');

  const store = new LocalStateStore();
  const files = createSourceFiles(formatsDir, sha256);
  const clock = (): string => new Date().toISOString();
  const localState = new LocalStateService({
    resolver: { resolveLocal: resolveLocalRoot, relation: rootRelation },
    git: { inspect: inspectPrivateRoot },
    store,
    clock,
    newInstanceId: () => randomUUID(),
  });
  const registered = await localState.register({
    localDataRoot: localRoot, sourceRoot: source, sourceKind: 'custom', projectId: PROJECT_ID,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) throw new Error('register failed');
  const instanceId = registered.entry.instanceId;
  const head = readFileSync(path.join(source, 'project.json'));
  const refreshed = await localState.refresh({
    localDataRoot: localRoot,
    instanceId,
    baseline: {
      projectId: PROJECT_ID,
      planVersion: fixtureDoc().planVersion,
      headHash: 'sha256:' + sha256(head),
      records: [],
      observedAt: clock(),
    },
    source,
  });
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed));

  const queue = new InstanceCommandQueue();
  const planNodes = planNodesOf(source);
  const work = new WorkService({
    localRoot, instanceId, store, planNodes, clock,
    newWorkRunId: () => `run-${randomUUID()}`,
    newSuggestionId: () => `sug-${randomUUID()}`,
    bootGeneration: 1,
    queue,
  });
  const service = new ProjectCommandService({
    localRoot, store, files, sha256, clock,
    newNodeId: () => randomUUID(),
    newRecordId: () => randomUUID(),
    queue,
    work,
  });

  const doc = (): ProjectDocument => JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as ProjectDocument;
  const revision = (): number => {
    const state = JSON.parse(readFileSync(path.join(localRoot, 'instances', instanceId, 'state.json'), 'utf8')) as {
      revisions: { plan: number };
    };
    return state.revisions.plan;
  };
  const state = (): { workRuns: { workRunId: string; bindingVersion: number; targets: string[]; templates?: unknown[] }[] } =>
    JSON.parse(readFileSync(path.join(localRoot, 'instances', instanceId, 'state.json'), 'utf8')) as never;
  const envelope = (command: Command, overrides: Partial<{ expectedPlanVersion: string; expectedPlanRevision: number }> = {}) => ({
    operationId: randomUUID(),
    projectId: PROJECT_ID,
    instanceId,
    sourceEpoch: refreshed.entry.sourceGeneration,
    expectedPlanVersion: doc().planVersion,
    expectedPlanRevision: revision(),
    command,
    ...overrides,
  });
  const capture = async (sessionId: string): Promise<WorkCapture> => {
    const captured = await work.captureBinding(sessionId);
    assert.equal(captured.ok, true, JSON.stringify(captured));
    if (!captured.ok) throw new Error('capture failed');
    return captured.capture;
  };

  return {
    service, work, source, localRoot, instanceId,
    sourceEpoch: refreshed.entry.sourceGeneration,
    doc, revision, state, envelope, capture,
  };
}

/** 登记并启动一个运行（指定目标、动作、根组许可与模板授权），返回捕获。 */
async function startRun(
  h: Harness,
  scope: {
    nodeIds: string[];
    actions: ('move' | 'insert' | 'update' | 'record')[];
    rootGroupAllowed?: boolean;
    templates?: { source: 'builtin' | 'user'; templateId: string; templateVersion?: number; versionRecordId?: string; contentHash?: string }[];
  },
): Promise<WorkCapture> {
  const workIntentId = `intent-${randomUUID()}`;
  // 每个运行独立会话，避免同会话已有活动绑定时被 deferred（切会话不是本用例的关注点）。
  const sessionId = `session-${randomUUID()}`;
  const prepared = await h.work.prepareWork({
    workIntentId,
    nodeIds: scope.nodeIds,
    allowedActions: scope.actions,
    reasonScope: 'local',
    purpose: '结构编辑测试',
    baseline: { planVersion: h.doc().planVersion, planRevision: h.revision(), sourceEpoch: h.sourceEpoch },
    ...(scope.rootGroupAllowed === undefined ? {} : { rootGroupAllowed: scope.rootGroupAllowed }),
    ...(scope.templates === undefined ? {} : { templates: scope.templates }),
  });
  assert.equal(prepared.status, 'committed', JSON.stringify(prepared));
  const rpcId = `rpc-${randomUUID()}`;
  const started = await h.work.startWork({ workIntentId, rpcId, sessionId });
  assert.equal(started.status, 'committed', JSON.stringify(started));
  const consumed = await h.work.observeConsumed({ sessionId, rpcId, turn: 1, agentPresent: true });
  assert.equal(consumed.status, 'started', JSON.stringify(consumed));
  return h.capture(sessionId);
}

const agentCtx = (h: Harness, capture: WorkCapture): TrustedContext => ({
  kind: 'agent-work',
  workRunId: capture.workRunId,
  bindingVersion: capture.bindingVersion,
  instanceId: h.instanceId,
});

function rejectedCode(result: { status: string; code?: string }): string {
  assert.notEqual(result.status, 'committed', JSON.stringify(result));
  return result.code ?? result.status;
}

// ---------- 影响范围计算 ----------

test('3.3 影响范围：移动包含子树、源组后移的同级、目的组后移的同级与锚点', () => {
  const impact = structuralImpact({ type: 'move-node', nodeId: NODE_A, parentId: R1, beforeNodeId: NODE_C }, OUTLINE);
  assert.ok(impact !== null);
  if (impact === null) return;
  assert.deepEqual(impact.subtree.sort(), [NODE_A, NODE_A1, NODE_A2].sort());
  assert.equal(impact.sourceParentId, R1);
  assert.equal(impact.destParentId, R1);
  assert.equal(impact.anchorId, NODE_C);
  // 移到 C 之前：目的组从 C 起后移（C 自己也在内）；源组 B、C 顺序被归一化影响。
  assert.ok(impact.targets.includes(NODE_B));
  assert.ok(impact.targets.includes(NODE_C));
  assert.equal(impact.touchesRootGroup, false);

  const toRoot = structuralImpact({ type: 'move-node', nodeId: NODE_A, parentId: null, beforeNodeId: NODE_B }, OUTLINE);
  assert.ok(toRoot !== null);
  assert.equal(toRoot?.touchesRootGroup, true, '源或目的父组为根即触及根组');

  const intoOtherGroup = structuralImpact({ type: 'move-node', nodeId: NODE_A1, parentId: NODE_D, beforeNodeId: null }, OUTLINE);
  assert.ok(intoOtherGroup !== null);
  assert.deepEqual(intoOtherGroup?.subtree, [NODE_A1]);
  assert.equal(intoOtherGroup?.sourceParentId, NODE_A);
  assert.equal(intoOtherGroup?.destParentId, NODE_D);
  assert.ok(intoOtherGroup?.targets.includes(NODE_D));
});

test('3.3 影响范围：插入包含目标父组、锚点与因插入后移的同级；commandTargets 使用轮廓', () => {
  const append = structuralImpact({
    type: 'insert-preset', templateId: 'x', templateVersion: 1, contentLocale: 'zh-CN', parentId: NODE_A, beforeNodeId: null,
  }, OUTLINE);
  assert.ok(append !== null);
  assert.deepEqual(append?.targets, [NODE_A], '末尾追加不改变既有同级顺序');

  const before = structuralImpact({
    type: 'insert-preset', templateId: 'x', templateVersion: 1, contentLocale: 'zh-CN', parentId: NODE_A, beforeNodeId: NODE_A1,
  }, OUTLINE);
  assert.ok(before !== null);
  assert.deepEqual(before?.targets.sort(), [NODE_A, NODE_A1, NODE_A2].sort());

  assert.deepEqual(
    commandTargets({ type: 'move-node', nodeId: NODE_A, parentId: null, beforeNodeId: NODE_B }, OUTLINE).sort(),
    structuralImpact({ type: 'move-node', nodeId: NODE_A, parentId: null, beforeNodeId: NODE_B }, OUTLINE)?.targets.sort(),
  );
  // 旧调用方（无轮廓）保持保守投影。
  assert.deepEqual(commandTargets({ type: 'move-node', nodeId: NODE_A, parentId: null, beforeNodeId: NODE_B }), [NODE_A]);
});

// ---------- 拒绝路径 ----------

test('3.3 缺动作：允许集合没有 move／insert 时分别返回 forbidden，资料不变', async () => {
  const h = await setup();
  const capture = await startRun(h, { nodeIds: [R1, NODE_A, NODE_A1, NODE_B, NODE_C, NODE_A2], actions: ['update'] });
  const before = readFileSync(path.join(h.source, 'project.json'));
  const revision = h.revision();

  const move = await h.service.execute(agentCtx(h, capture), h.envelope({
    type: 'move-node', nodeId: NODE_A, parentId: R1, beforeNodeId: NODE_C,
  }));
  assert.equal(rejectedCode(move), 'forbidden');
  const insert = await h.service.execute(agentCtx(h, capture), h.envelope({
    type: 'insert-preset', templateId: 'feature-development', templateVersion: 1, contentLocale: 'zh-CN', parentId: NODE_A, beforeNodeId: null,
  }));
  assert.equal(rejectedCode(insert), 'forbidden');
  assert.deepEqual(readFileSync(path.join(h.source, 'project.json')), before);
  assert.equal(h.revision(), revision);
});

test('3.3 源或目标越权：移动进入目标集合外的父组返回 structure-scope-denied', async () => {
  const h = await setup();
  const capture = await startRun(h, { nodeIds: [R1, NODE_A, NODE_A1, NODE_A2, NODE_B, NODE_C], actions: ['move'] });
  const before = readFileSync(path.join(h.source, 'project.json'));

  const denied = await h.service.execute(agentCtx(h, capture), h.envelope({
    type: 'move-node', nodeId: NODE_A1, parentId: NODE_D, beforeNodeId: null,
  }));
  assert.equal(rejectedCode(denied), 'structure-scope-denied');
  assert.deepEqual(readFileSync(path.join(h.source, 'project.json')), before);

  // 源父组在目标集合外同样拒绝：只允许 [A1] 时，移动 A1 会牵扯 A。
  const second = await setup();
  const narrow = await startRun(second, { nodeIds: [NODE_A1], actions: ['move'] });
  const outside = await second.service.execute(agentCtx(second, narrow), second.envelope({
    type: 'move-node', nodeId: NODE_A1, parentId: R1, beforeNodeId: null,
  }));
  assert.equal(rejectedCode(outside), 'structure-scope-denied');
});

test('3.3 根组未授权：根级重排返回 root-group-not-allowed；单独授予后可发布', async () => {
  const h = await setup();
  const capture = await startRun(h, {
    nodeIds: [R1, R2, NODE_A, NODE_A1, NODE_A2, NODE_B, NODE_C, NODE_D],
    actions: ['move'],
  });
  const denied = await h.service.execute(agentCtx(h, capture), h.envelope({
    type: 'move-node', nodeId: R2, parentId: null, beforeNodeId: R1,
  }));
  assert.equal(rejectedCode(denied), 'root-group-not-allowed');
  assert.deepEqual(
    h.doc().plan.nodes.filter((item) => item.parentId === null).map((item) => item.id),
    [R1, R2],
    '资料保持原状',
  );

  const granted = await startRun(h, {
    nodeIds: [R1, R2, NODE_A, NODE_A1, NODE_A2, NODE_B, NODE_C, NODE_D],
    actions: ['move'],
    rootGroupAllowed: true,
  });
  const revision = h.revision();
  const committed = await h.service.execute(agentCtx(h, granted), h.envelope({
    type: 'move-node', nodeId: R2, parentId: null, beforeNodeId: R1,
  }));
  assert.equal(committed.status, 'committed', JSON.stringify(committed));
  assert.equal(h.revision(), revision + 1, '一次发布只推进一次规划修订');
  assert.deepEqual(
    h.doc().plan.nodes.filter((item) => item.parentId === null).sort((a, b) => a.order - b.order).map((item) => item.id),
    [R2, R1],
    '根组顺序按确认重排',
  );
  // 非根节点不能升为根：即使有根组许可也由领域校验拒绝（不新增越级通道）。
  const recaptured = await h.capture(granted.sessionId);
  const promote = await h.service.execute(agentCtx(h, recaptured), h.envelope({
    type: 'move-node', nodeId: NODE_A, parentId: null, beforeNodeId: R1,
  }));
  assert.equal(rejectedCode(promote), 'child-to-root');
});

test('3.3 模板版本未授权或过期：insert 返回 template-not-authorized，含用户模板哈希不符', async () => {
  const h = await setup();
  const withoutTemplates = await startRun(h, { nodeIds: [NODE_A, NODE_A1, NODE_A2], actions: ['insert'] });
  const unauthorized = await h.service.execute(agentCtx(h, withoutTemplates), h.envelope({
    type: 'insert-preset', templateId: 'feature-development', templateVersion: 1, contentLocale: 'zh-CN', parentId: NODE_A, beforeNodeId: null,
  }));
  assert.equal(rejectedCode(unauthorized), 'template-not-authorized', '旧运行无 templates 字段按空授权');

  const wrongVersion = await startRun(h, {
    nodeIds: [NODE_A, NODE_A1, NODE_A2],
    actions: ['insert'],
    templates: [{ source: 'builtin', templateId: 'feature-development', templateVersion: 2 }],
  });
  const staleVersion = await h.service.execute(agentCtx(h, wrongVersion), h.envelope({
    type: 'insert-preset', templateId: 'feature-development', templateVersion: 1, contentLocale: 'zh-CN', parentId: NODE_A, beforeNodeId: null,
  }));
  assert.equal(rejectedCode(staleVersion), 'template-not-authorized', '精确版本未授权');

  const userTriple = await startRun(h, {
    nodeIds: [NODE_A, NODE_A1, NODE_A2],
    actions: ['insert'],
    templates: [{ source: 'user', templateId: 'template-x', versionRecordId: 'record-x', contentHash: `sha256:${'a'.repeat(64)}` }],
  });
  const userMismatch = await h.service.execute(agentCtx(h, userTriple), h.envelope({
    type: 'insert-user-template', templateId: 'template-x', versionRecordId: 'record-x',
    contentHash: `sha256:${'b'.repeat(64)}`, parentId: NODE_A, beforeNodeId: null,
  }));
  assert.equal(rejectedCode(userMismatch), 'template-not-authorized', '用户模板正文哈希不符');
});

test('3.3 两类根级插入：即使授予 insert／精确版本／根组许可仍返回 parent-not-found，无候选', async () => {
  const h = await setup();
  const revision = h.revision();
  const nodesBefore = h.doc().plan.nodes.length;
  const templates = [
    { source: 'builtin' as const, templateId: 'feature-development', templateVersion: 1 },
    { source: 'user' as const, templateId: 'template-x', versionRecordId: 'record-x', contentHash: `sha256:${'a'.repeat(64)}` },
  ];
  const capture = await startRun(h, {
    nodeIds: [R1, R2, NODE_A, NODE_B, NODE_C, NODE_A1, NODE_A2, NODE_D],
    actions: ['insert', 'move'],
    rootGroupAllowed: true,
    templates,
  });
  const builtin = await h.service.execute(agentCtx(h, capture), h.envelope({
    type: 'insert-preset', templateId: 'feature-development', templateVersion: 1, contentLocale: 'zh-CN', parentId: null, beforeNodeId: null,
  }));
  assert.equal(rejectedCode(builtin), 'parent-not-found');
  const user = await h.service.execute(agentCtx(h, capture), h.envelope({
    type: 'insert-user-template', templateId: 'template-x', versionRecordId: 'record-x',
    contentHash: `sha256:${'a'.repeat(64)}`, parentId: null, beforeNodeId: null,
  }));
  assert.equal(rejectedCode(user), 'parent-not-found');
  assert.equal(h.revision(), revision, '拒绝不推进规划修订');
  assert.equal(h.doc().plan.nodes.length, nodesBefore, '没有生成任何节点');
});

// ---------- 获准写入 ----------

test('3.3 获准插入：内置模板在现有父节点下发布，新节点不进入运行目标集合', async () => {
  const h = await setup();
  const capture = await startRun(h, {
    nodeIds: [NODE_A, NODE_A1, NODE_A2],
    actions: ['insert'],
    templates: [{ source: 'builtin', templateId: 'feature-development', templateVersion: 1 }],
  });
  const revision = h.revision();
  const before = h.doc();
  const result = await h.service.execute(agentCtx(h, capture), h.envelope({
    type: 'insert-preset', templateId: 'feature-development', templateVersion: 1, contentLocale: 'zh-CN', parentId: NODE_A, beforeNodeId: null,
  }));
  assert.equal(result.status, 'committed', JSON.stringify(result));
  assert.equal(h.revision(), revision + 1);
  const doc = h.doc();
  const inserted = doc.plan.nodes.filter((item) => !before.plan.nodes.some((old) => old.id === item.id));
  assert.equal(inserted.length, FEATURE_DEVELOPMENT_PRESET.nodes.length);
  assert.ok(inserted.every((item) => item.parentId === NODE_A || inserted.some((other) => other.id === item.parentId)));
  // 生成节点不自动获得写授权：运行目标仍是原集合，绑定版本推进 1。
  const run = h.state().workRuns.at(-1);
  assert.deepEqual(run?.targets, [NODE_A, NODE_A1, NODE_A2]);
  const next = await h.capture(capture.sessionId);
  assert.equal(next.bindingVersion, capture.bindingVersion + 1, '合法提交推进绑定版本');
});

// ---------- 旧绑定与 owner 改基线 ----------

test('3.3 旧绑定与 owner 改基线：两种旧写法分别被拒，运行仍可读，新运行可写', async () => {
  const h = await setup();
  const capture = await startRun(h, {
    nodeIds: [R1, NODE_A, NODE_B, NODE_C, NODE_A1, NODE_A2],
    actions: ['move'],
    rootGroupAllowed: false,
  });
  const first = await h.service.execute(agentCtx(h, capture), h.envelope({
    type: 'move-node', nodeId: NODE_A, parentId: R1, beforeNodeId: NODE_C,
  }));
  assert.equal(first.status, 'committed', JSON.stringify(first));

  // 旧写法一：旧捕获版本（未推进）再写 → binding-expired。
  const staleVersion = await h.service.execute(agentCtx(h, capture), h.envelope({
    type: 'move-node', nodeId: NODE_B, parentId: R1, beforeNodeId: NODE_A,
  }));
  assert.equal(rejectedCode(staleVersion), 'binding-expired');

  // owner 在活动运行中改基线：资料头推进，运行仍可读（捕获与读上下文不受影响）。
  const ownerResult = await h.service.execute(
    { kind: 'remote-owner' },
    h.envelope({ type: 'update-node', nodeId: NODE_C, patch: { goal: 'owner 改基线' } }),
  );
  assert.equal(ownerResult.status, 'committed', JSON.stringify(ownerResult));
  const readable = await h.capture(capture.sessionId);
  assert.equal(readable.workRunId, capture.workRunId, '原运行仍在，可继续读');
  const context = await h.work.buildContext(readable);
  assert.equal(context.status, 'committed', JSON.stringify(context));

  // 旧写法二：同一运行拿 owner 改后的新基线写 → binding-expired（不接受新基线换旧授权）。
  const staleBaseline = await h.service.execute(agentCtx(h, readable), h.envelope({
    type: 'move-node', nodeId: NODE_A, parentId: R1, beforeNodeId: NODE_C,
  }));
  assert.equal(rejectedCode(staleBaseline), 'binding-expired');

  // 结束原运行后显式发起新运行：同一结构写入获准发布。
  const stopped = await h.work.stopWork(capture.workRunId);
  assert.equal(stopped.status, 'committed', JSON.stringify(stopped));
  const fresh = await startRun(h, {
    nodeIds: [R1, NODE_A, NODE_B, NODE_C, NODE_A1, NODE_A2],
    actions: ['move'],
  });
  const written = await h.service.execute(agentCtx(h, fresh), h.envelope({
    type: 'move-node', nodeId: NODE_A, parentId: R1, beforeNodeId: NODE_C,
  }));
  assert.equal(written.status, 'committed', JSON.stringify(written));
});
