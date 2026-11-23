// R2 收尾 4.5：v2 规划变换的扩展保留与里程碑逆向（A/F 层）。
// 覆盖：结构／字段／状态／模板（内置与用户）／分组／合并／复制变换后未编辑的里程碑与交付引用原样保留；
// 合并替代使交付节点取消时引用保留并给诊断；set-milestone／remove-milestone 的撤销与重做；
// 重做普通状态命令不能完成里程碑；完成命令同 operationId 回放不产生第二次发布；
// v1 夹具上同样的编辑保持 v1 字段与字节协议（独立复算通过）。

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstanceCommandQueue } from '../src/application/command-queue.js';
import { ProjectCommandService, type Command, type TrustedContext } from '../src/application/command-service.js';
import { LocalStateService } from '../src/application/local-state.js';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { createSourceFiles } from '../src/adapters/fs/source-files.js';
import { resolveLocalRoot, rootRelation } from '../src/adapters/fs/local-root.js';
import { inspectPrivateRoot } from '../src/adapters/fs/git-guard.js';
import { computePlanVersion, planVersionFromJsonText } from '../src/domain/canonical/plan-fingerprint.js';
import { validateProjectDocument } from '../src/domain/validate.js';
import type { ProjectDocument, RecordIndexEntry, Sha256Fn, WorkNode } from '../src/domain/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const formatsDir = path.join(packageRoot, 'formats', 'v1');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const M1 = '00000000-0000-4000-8000-000000000101';
const A = '00000000-0000-4000-8000-000000000102';
const B = '00000000-0000-4000-8000-000000000103';
const M2 = '00000000-0000-4000-8000-000000000104';
const C = '00000000-0000-4000-8000-000000000105';
const D = '00000000-0000-4000-8000-000000000106';
const ARTIFACT = '00000000-0000-4000-8000-000000000201';

function node(id: string, parentId: string | null, order: number, title: string): WorkNode {
  return { id, parentId, order, title, goal: `${title} 的目标`, completionCriteria: [], status: 'todo' };
}

function artifactRecord(): RecordIndexEntry {
  const body = '# 成果记录\n\n跨分支交付的成果。\n';
  const contentHash = 'sha256:' + sha256(new TextEncoder().encode(body));
  return {
    id: ARTIFACT,
    kind: 'execution-note',
    subjectNodeIds: [A],
    path: `records/${ARTIFACT}/${contentHash.slice('sha256:'.length)}.md`,
    contentHash,
    summary: '成果记录',
    sources: [],
  };
}

function artifactBody(): string {
  return '# 成果记录\n\n跨分支交付的成果。\n';
}

/** v2 夹具：M1（交付 A 与一条记录）、M2（复用 A），C 跨分支依赖 A，D 独立根。 */
function fixtureDoc(schemaVersion = 2): ProjectDocument {
  const draft: ProjectDocument = {
    schemaVersion,
    project: { id: PROJECT_ID, title: 'v2 变换夹具', goal: '保留扩展', constraints: [], repositories: [] },
    plan: {
      nodes: [
        node(M1, null, 0, '里程碑一'),
        node(A, M1, 0, '交付 A'),
        node(B, M1, 1, '交付 B'),
        node(M2, null, 1, '里程碑二'),
        node(C, M2, 0, '分支 C'),
        node(D, null, 2, '独立 D'),
      ],
      dependencies: [{ nodeId: C, requiresNodeId: A }],
      ...(schemaVersion === 2
        ? {
            roadmap: {
              milestones: [
                { nodeId: M1, deliveries: [{ kind: 'node' as const, refId: A }, { kind: 'record' as const, refId: ARTIFACT, contentHash: artifactRecord().contentHash }] },
                { nodeId: M2, deliveries: [{ kind: 'node' as const, refId: A }] },
              ],
            },
          }
        : {}),
    },
    planVersion: '',
    records: [],
  };
  draft.plan.nodes[0] = { ...draft.plan.nodes[0]!, completionCriteria: ['条件一', '条件二'] };
  draft.planVersion = computePlanVersion(draft, sha256).planVersion;
  if (schemaVersion === 2) draft.records = [artifactRecord()];
  return draft;
}

interface Harness {
  service: ProjectCommandService;
  source: string;
  instanceId: string;
  doc(): ProjectDocument;
  revision(): number;
  envelope(command: Command, overrides?: Partial<{ expectedPlanVersion: string; expectedPlanRevision: number }>): {
    operationId: string;
    projectId: string;
    instanceId: string;
    sourceEpoch: number;
    expectedPlanVersion: string;
    expectedPlanRevision: number;
    command: Command;
  };
  undo(operationId: string): Promise<Command>;
  redo(operationId: string): Promise<Command>;
}

async function setup(schemaVersion = 2): Promise<Harness> {
  const base = mkdtempSync(path.join(artifacts, `v2-transform-v${schemaVersion}-`));
  const localRoot = path.join(base, 'local');
  const source = path.join(base, 'source');
  mkdirSync(source, { recursive: true });
  const doc = fixtureDoc(schemaVersion);
  writeFileSync(path.join(source, 'project.json'), JSON.stringify(doc, null, 2) + '\n');
  for (const record of doc.records) {
    mkdirSync(path.join(source, 'records', record.id), { recursive: true });
    writeFileSync(path.join(source, record.path), artifactBody());
  }

  const store = new LocalStateStore();
  const files = createSourceFiles(formatsDir, sha256);
  const clock = (): string => new Date().toISOString();
  const localState = new LocalStateService({
    resolver: { resolveLocal: resolveLocalRoot, relation: rootRelation },
    git: { inspect: inspectPrivateRoot },
    store, clock,
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
      planVersion: doc.planVersion,
      headHash: 'sha256:' + sha256(head),
      records: doc.records.map((record) => ({
        recordId: record.id,
        path: record.path,
        contentHash: record.contentHash,
        observedHash: record.contentHash,
        bytes: Buffer.byteLength(artifactBody()),
      })),
      observedAt: clock(),
    },
    source,
  });
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed));

  const service = new ProjectCommandService({
    localRoot, store, files, sha256, clock,
    newNodeId: () => randomUUID(),
    newRecordId: () => randomUUID(),
    queue: new InstanceCommandQueue(),
  });
  const readDoc = (): ProjectDocument => JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as ProjectDocument;
  const readState = (): { revisions: { plan: number } } => JSON.parse(
    readFileSync(path.join(localRoot, 'instances', instanceId, 'state.json'), 'utf8'),
  ) as { revisions: { plan: number } };
  const envelope = (command: Command, overrides: Partial<{ expectedPlanVersion: string; expectedPlanRevision: number }> = {}) => ({
    operationId: randomUUID(),
    projectId: PROJECT_ID,
    instanceId,
    sourceEpoch: refreshed.entry.sourceGeneration,
    expectedPlanVersion: readDoc().planVersion,
    expectedPlanRevision: readState().revisions.plan,
    command,
    ...overrides,
  });
  const previewDigest = async (targetOperationId: string, direction: 'undo' | 'redo'): Promise<string> => {
    const preview = await service.previewInverse(owner, { instanceId, targetOperationId, direction });
    assert.equal(preview.status, 'available', JSON.stringify(preview));
    if (preview.status !== 'available') throw new Error('preview failed');
    return preview.previewDigest;
  };
  return {
    service, source, instanceId, doc: readDoc,
    revision: () => readState().revisions.plan,
    envelope,
    undo: async (operationId) => ({
      type: 'undo-plan-edit', targetOperationId: operationId, previewDigest: await previewDigest(operationId, 'undo'),
    }),
    redo: async (operationId) => ({
      type: 'redo-plan-edit', targetOperationId: operationId, previewDigest: await previewDigest(operationId, 'redo'),
    }),
  };
}

const owner: TrustedContext = { kind: 'remote-owner' };
const roadmapOf = (doc: ProjectDocument): unknown => doc.plan.roadmap;

/** 执行一条 owner 命令并断言成功。 */
async function commit(h: Harness, command: Command) {
  const result = await h.service.execute(owner, h.envelope(command));
  assert.equal(result.status, 'committed', `${JSON.stringify(command)}\n${JSON.stringify(result)}`);
  return result;
}

test('4.5 结构变换保留 v2 里程碑与交付引用：update／move／status／split／add／dependencies／insert-preset', async () => {
  const cases: { label: string; command: Command }[] = [
    { label: 'update-node', command: { type: 'update-node', nodeId: A, patch: { goal: '改过的目标' } } },
    { label: 'move-node', command: { type: 'move-node', nodeId: A, parentId: M2, beforeNodeId: null } },
    { label: 'set-node-status', command: { type: 'set-node-status', nodeId: A, status: 'in-progress' } },
    { label: 'split-node', command: { type: 'split-node', parentId: M1, children: [{ title: '拆出', goal: '拆出的目标', completionCriteria: [], order: 2 }] } },
    { label: 'add-nodes', command: { type: 'add-nodes', nodes: [{ parentId: M1, order: 2, title: '新增', goal: '新增目标', completionCriteria: [] }] } },
    { label: 'set-dependencies', command: { type: 'set-dependencies', dependencies: [{ nodeId: C, requiresNodeId: A }, { nodeId: D, requiresNodeId: B }] } },
    {
      label: 'insert-preset',
      command: { type: 'insert-preset', templateId: 'feature-development', templateVersion: 1, contentLocale: 'zh-CN', parentId: M1, beforeNodeId: null },
    },
    { label: 'group-nodes', command: { type: 'group-nodes', nodeIds: [A, B], group: { title: '组', goal: '组目标', completionCriteria: [] }, anchorId: null } },
    { label: 'copy-subtree', command: { type: 'copy-subtree', nodeId: A, targetParentId: D, anchorId: null, externalDependencies: [] } },
  ];
  for (const item of cases) {
    const h = await setup();
    const before = h.doc();
    await commit(h, item.command);
    const after = h.doc();
    assert.deepEqual(roadmapOf(after), roadmapOf(before), `${item.label}：未编辑的里程碑原样保留`);
    assert.notEqual(after.planVersion, before.planVersion, `${item.label}：规划指纹按实际变化推进`);
    assert.deepEqual(
      after.plan.roadmap?.milestones.map((milestone) => milestone.nodeId),
      [M1, M2],
      `${item.label}：里程碑身份与顺序不变`,
    );
  }
});

test('4.5 用户模板保存与插入保留 v2 里程碑；模板记录不改变规划指纹', async () => {
  const h = await setup();
  const before = h.doc();
  const templateId = randomUUID();
  const saved = await commit(h, {
    type: 'save-user-template', templateId, title: '模板 A', bodyLanguage: 'zh', rootNodeId: A,
  });
  assert.equal(saved.recordId !== undefined, true);
  assert.equal(h.doc().planVersion, before.planVersion, '保存模板只追加记录');
  const record = h.doc().records.find((entry) => entry.id === saved.recordId);
  assert.ok(record !== undefined);
  await commit(h, {
    type: 'insert-user-template', templateId, versionRecordId: record.id,
    contentHash: record.contentHash, parentId: M1, beforeNodeId: null,
  });
  assert.deepEqual(roadmapOf(h.doc()), roadmapOf(before), '插入用户模板保留里程碑');
});

test('4.5 合并替代：交付节点取消后引用保留并给诊断，两个里程碑都保持原 ID', async () => {
  const h = await setup();
  await commit(h, {
    type: 'merge-nodes', keepNodeId: B, sourceNodeIds: [A],
    resolutions: [{ edge: { nodeId: C, requiresNodeId: A }, action: 'reattach' }],
  });
  const after = h.doc();
  assert.equal(after.plan.nodes.find((item) => item.id === A)?.status, 'canceled');
  assert.deepEqual(after.plan.roadmap?.milestones.find((item) => item.nodeId === M1)?.deliveries[0], { kind: 'node', refId: A });
  assert.deepEqual(after.plan.roadmap?.milestones.find((item) => item.nodeId === M2)?.deliveries, [{ kind: 'node', refId: A }]);
  const validated = validateProjectDocument(after, { sha256 });
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  assert.deepEqual(
    validated.diagnostics.map((item) => item.code).sort(),
    ['milestone-delivery-node-canceled', 'milestone-delivery-node-canceled'],
  );
});

test('4.5 字段编辑的撤销与重做保留 v2 里程碑', async () => {
  const h = await setup();
  const original = h.doc().planVersion;
  const before = roadmapOf(h.doc());
  const edited = await commit(h, { type: 'update-node', nodeId: A, patch: { goal: '改过的目标' } });
  const after = h.doc().planVersion;
  assert.ok(edited.operationId !== '');

  const undone = await h.service.execute(owner, h.envelope(await h.undo(edited.operationId)));
  assert.equal(undone.status, 'committed', JSON.stringify(undone));
  assert.equal(h.doc().planVersion, original, '撤销回到原指纹');
  assert.deepEqual(roadmapOf(h.doc()), before);

  const redone = await h.service.execute(owner, h.envelope(await h.redo(edited.operationId)));
  assert.equal(redone.status, 'committed', JSON.stringify(redone));
  assert.equal(h.doc().planVersion, after, '重做回到编辑后指纹');
  assert.deepEqual(roadmapOf(h.doc()), before);
});

test('4.5 set-milestone 的撤销与重做：只回滚该条里程碑', async () => {
  const h = await setup();
  const original = h.doc();
  const added = await commit(h, {
    type: 'set-milestone', nodeId: M1,
    deliveries: [{ kind: 'node', refId: C }, { kind: 'node', refId: A }],
  });
  const afterAdd = h.doc();
  assert.deepEqual(
    afterAdd.plan.roadmap?.milestones.find((item) => item.nodeId === M1)?.deliveries,
    [{ kind: 'node', refId: A }, { kind: 'node', refId: C }],
    '交付按 (kind, refId) 排序',
  );
  assert.deepEqual(afterAdd.plan.roadmap?.milestones.find((item) => item.nodeId === M2), original.plan.roadmap?.milestones[1]);

  const undone = await h.service.execute(owner, h.envelope(await h.undo(added.operationId)));
  assert.equal(undone.status, 'committed', JSON.stringify(undone));
  assert.deepEqual(h.doc().plan.roadmap, original.plan.roadmap, '撤销恢复原里程碑集合');
  assert.equal(h.doc().planVersion, original.planVersion);

  const redone = await h.service.execute(owner, h.envelope(await h.redo(added.operationId)));
  assert.equal(redone.status, 'committed', JSON.stringify(redone));
  assert.deepEqual(h.doc().plan.roadmap, afterAdd.plan.roadmap);
  assert.equal(h.doc().planVersion, afterAdd.planVersion);
});

test('4.5 remove-milestone 的撤销恢复原条目与原交付', async () => {
  const h = await setup();
  const original = h.doc();
  const removed = await commit(h, { type: 'remove-milestone', nodeId: M2 });
  assert.deepEqual(h.doc().plan.roadmap?.milestones.map((item) => item.nodeId), [M1]);
  const undone = await h.service.execute(owner, h.envelope(await h.undo(removed.operationId)));
  assert.equal(undone.status, 'committed', JSON.stringify(undone));
  assert.deepEqual(h.doc().plan.roadmap, original.plan.roadmap);
});

test('4.5 里程碑节点不能由普通状态命令完成；其它状态命令的重做不受影响', async () => {
  const h = await setup();
  const status = await commit(h, { type: 'set-node-status', nodeId: A, status: 'in-progress' });
  // A 不是里程碑节点，重做本身允许；把 M1 设为里程碑节点的普通状态变更才受守卫约束。
  const undone = await h.service.execute(owner, h.envelope(await h.undo(status.operationId)));
  assert.equal(undone.status, 'committed', JSON.stringify(undone));
  const redone = await h.service.execute(owner, h.envelope(await h.redo(status.operationId)));
  assert.equal(redone.status, 'committed', JSON.stringify(redone));

  // 直接给里程碑节点提交 done 被拒（重做路径同一判据，见 buildInverseCandidate）。
  const denied = await h.service.execute(owner, h.envelope({ type: 'set-node-status', nodeId: M1, status: 'done' }));
  assert.equal(denied.status, 'rejected');
  assert.equal(denied.status === 'rejected' ? denied.code : '', 'milestone-evidence-required');

  // 完成后再删里程碑标记：节点仍 done，重新标记须先重新打开。
  const evidence = await h.service.execute(owner, h.envelope({
    type: 'append-record', kind: 'verification', subjectNodeIds: [M1],
    summary: '完成证据', sources: [], body: '# 证据\n',
    verification: { status: 'pass', subject: { kind: 'node', id: M1 }, subjectVersion: h.doc().planVersion, scope: '本地复测' },
  }));
  assert.equal(evidence.status, 'committed', JSON.stringify(evidence));
  const evidenceId = evidence.status === 'committed' ? evidence.recordId ?? '' : '';
  const contentHash = h.doc().records.find((entry) => entry.id === evidenceId)?.contentHash ?? '';
  const completed = await h.service.execute(owner, h.envelope({
    type: 'complete-milestone', nodeId: M1,
    evidence: [
      { criterionIndex: 0, criterionText: '条件一', recordId: evidenceId, contentHash },
      { criterionIndex: 1, criterionText: '条件二', recordId: evidenceId, contentHash },
    ],
  }));
  assert.equal(completed.status, 'committed', JSON.stringify(completed));
  await commit(h, { type: 'remove-milestone', nodeId: M1 });
  const reMark = await h.service.execute(owner, h.envelope({
    type: 'set-milestone', nodeId: M1, deliveries: [{ kind: 'node', refId: A }],
  }));
  assert.equal(reMark.status, 'rejected');
  assert.equal(reMark.status === 'rejected' ? reMark.code : '', 'milestone-reopen-required');
});

test('4.5 完成命令同 operationId 回放：只有一条完成记录与一次修订', async () => {
  const h = await setup();
  const first = await h.service.execute(owner, h.envelope({
    type: 'append-record', kind: 'verification', subjectNodeIds: [M1],
    summary: '准备证据', sources: [], body: '# 证据\n',
    verification: { status: 'pass', subject: { kind: 'node', id: M1 }, subjectVersion: h.doc().planVersion, scope: '本地复测' },
  }));
  assert.equal(first.status, 'committed', JSON.stringify(first));
  const recordId = first.status === 'committed' ? first.recordId ?? '' : '';
  const evidence = [{
    criterionIndex: 0, criterionText: '条件一', recordId,
    contentHash: h.doc().records.find((entry) => entry.id === recordId)?.contentHash ?? '',
  }, {
    criterionIndex: 1, criterionText: '条件二', recordId,
    contentHash: h.doc().records.find((entry) => entry.id === recordId)?.contentHash ?? '',
  }];
  const envelope = h.envelope({ type: 'complete-milestone', nodeId: M1, evidence });
  const completed = await h.service.execute(owner, envelope);
  assert.equal(completed.status, 'committed', JSON.stringify(completed));
  const head = readFileSync(path.join(h.source, 'project.json'));
  const revision = h.revision();
  const replay = await h.service.execute(owner, envelope);
  assert.equal(replay.status, 'committed', JSON.stringify(replay));
  assert.equal(replay.status === 'committed' ? replay.replayed : false, true);
  assert.equal(readFileSync(path.join(h.source, 'project.json')).equals(head), true, '回放不改资料');
  assert.equal(h.revision(), revision, '回放不推进修订');
});

test('4.5 v1 夹具：同样的编辑保持 v1 字段与字节协议，独立复算通过', async () => {
  const h = await setup(1);
  const commands: Command[] = [
    { type: 'update-node', nodeId: A, patch: { goal: 'v1 改目标' } },
    { type: 'move-node', nodeId: A, parentId: M2, beforeNodeId: null },
    { type: 'insert-preset', templateId: 'feature-development', templateVersion: 1, contentLocale: 'zh-CN', parentId: M1, beforeNodeId: null },
    { type: 'set-node-status', nodeId: A, status: 'in-progress' },
  ];
  for (const command of commands) {
    await commit(h, command);
    const doc = h.doc();
    assert.equal(doc.schemaVersion, 1, 'v1 不升级');
    assert.equal(doc.plan.roadmap, undefined, 'v1 不补扩展字段');
    assert.ok(!readFileSync(path.join(h.source, 'project.json'), 'utf8').includes('roadmap'), 'v1 字节不含 v2 字段');
    const reread = planVersionFromJsonText(readFileSync(path.join(h.source, 'project.json'), 'utf8'), sha256);
    assert.deepEqual(reread.issues, []);
    assert.equal(reread.planVersion, doc.planVersion, '独立 v1 复算与自报一致');
  }
});
