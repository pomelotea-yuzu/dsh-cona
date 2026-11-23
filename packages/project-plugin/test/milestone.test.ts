// R2 收尾 4.3：里程碑与交付引用编辑 + 正式完成（A/F 层）。
// 覆盖：v2 才允许编辑；共享成果与排序无关指纹；自引用/跨项目/缺失/哈希/重复/非法 kind 的新增拒绝；
// 既有失效引用保留为待核对；取消与合并替代给诊断且引用保留；移动后引用不变；
// 普通状态命令不能完成里程碑；remove-milestone 只删条目；
// complete-milestone 逐项证据（顺序、原文、pass、主题、受检版本、哈希）与一次原子发布；
// 完成后改动条件/交付需先重新打开；owner-only 准入。

import { execFileSync } from 'node:child_process';
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
import { computePlanVersion } from '../src/domain/canonical/plan-fingerprint.js';
import { parseMilestoneCompletionText } from '../src/domain/milestone-completion.js';
import { validateProjectDocument } from '../src/domain/validate.js';
import type {
  MilestoneCompletionEvidence,
  ProjectDocument,
  RecordIndexEntry,
  Sha256Fn,
  WorkNode,
} from '../src/domain/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const formatsDir = path.join(packageRoot, 'formats', 'v1');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const M = '00000000-0000-4000-8000-000000000101';
const A = '00000000-0000-4000-8000-000000000102';
const B = '00000000-0000-4000-8000-000000000103';
const C = '00000000-0000-4000-8000-000000000104';
const REC_PASS_1 = '00000000-0000-4000-8000-000000000201';
const REC_PASS_2 = '00000000-0000-4000-8000-000000000202';
const REC_FAIL = '00000000-0000-4000-8000-000000000203';
const REC_OTHER = '00000000-0000-4000-8000-000000000204';
const REC_OLD = '00000000-0000-4000-8000-000000000205';
const DELIVERY_RECORD = '00000000-0000-4000-8000-000000000206';
const PREVIOUS_VERSION = 'sha256:' + 'd'.repeat(64);

function node(id: string, parentId: string | null, order: number, title: string, status: WorkNode['status'] = 'todo'): WorkNode {
  return { id, parentId, order, title, goal: `${title} 的目标`, completionCriteria: [], status };
}

function bodyOf(recordId: string): string {
  return `# 验证 ${recordId}\n\n正文示例。\n`;
}

function verification(
  recordId: string,
  subjectId: string,
  status: 'pass' | 'fail',
  subjectVersion: string,
  scope: string,
  extra: Partial<RecordIndexEntry> = {},
): RecordIndexEntry {
  const bytes = new TextEncoder().encode(bodyOf(recordId));
  const contentHash = 'sha256:' + sha256(bytes);
  return {
    id: recordId,
    kind: 'verification',
    subjectNodeIds: [subjectId],
    path: `records/${recordId}/${contentHash.slice('sha256:'.length)}.md`,
    contentHash,
    summary: `验证 ${recordId}`,
    sources: [],
    verification: { status, subject: { kind: 'node', id: subjectId }, subjectVersion, scope },
    ...extra,
  };
}

function fixtureDoc(schemaVersion = 2): ProjectDocument {
  const draft: ProjectDocument = {
    schemaVersion,
    project: { id: PROJECT_ID, title: '里程碑夹具', goal: '测试', constraints: [], repositories: [] },
    plan: {
      nodes: [
        node(M, null, 0, '里程碑', 'in-progress'),
        node(A, M, 0, '交付 A'),
        node(B, M, 1, '交付 B'),
        node(C, null, 1, '另一分支'),
      ],
      dependencies: [],
      ...(schemaVersion === 2
        ? { roadmap: { milestones: [{ nodeId: M, deliveries: [{ kind: 'node' as const, refId: A }] }] } }
        : {}),
    },
    planVersion: '',
    records: [],
  };
  draft.plan.nodes[0] = { ...draft.plan.nodes[0]!, completionCriteria: ['条件一', '条件二'] };
  draft.planVersion = computePlanVersion(draft, sha256).planVersion;
  if (schemaVersion === 2) {
    draft.records = [
      verification(REC_PASS_1, M, 'pass', draft.planVersion, '本地复测'),
      verification(REC_PASS_2, M, 'pass', draft.planVersion, '交叉核对'),
      verification(REC_FAIL, M, 'fail', draft.planVersion, '未通过'),
      verification(REC_OTHER, A, 'pass', draft.planVersion, '别的节点'),
      verification(REC_OLD, M, 'pass', PREVIOUS_VERSION, '旧版本'),
    ];
    const bytes = new TextEncoder().encode(bodyOf(DELIVERY_RECORD));
    const contentHash = 'sha256:' + sha256(bytes);
    draft.records.push({
      id: DELIVERY_RECORD,
      kind: 'execution-note',
      subjectNodeIds: [A],
      path: `records/${DELIVERY_RECORD}/${contentHash.slice('sha256:'.length)}.md`,
      contentHash,
      summary: '成果记录',
      sources: [],
    });
  }
  return draft;
}

interface Harness {
  service: ProjectCommandService;
  source: string;
  localRoot: string;
  instanceId: string;
  sourceEpoch: number;
  doc(): ProjectDocument;
  head(): string;
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
  diagnostics(): string[];
}

async function setup(schemaVersion = 2): Promise<Harness> {
  const base = mkdtempSync(path.join(artifacts, `milestone-v${schemaVersion}-`));
  const localRoot = path.join(base, 'local');
  const source = path.join(base, 'source');
  mkdirSync(source, { recursive: true });
  const doc = fixtureDoc(schemaVersion);
  writeFileSync(path.join(source, 'project.json'), JSON.stringify(doc, null, 2) + '\n');
  for (const record of doc.records) {
    mkdirSync(path.join(source, 'records', record.id), { recursive: true });
    writeFileSync(path.join(source, record.path), bodyOf(record.id));
  }

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
  const headBytes = readFileSync(path.join(source, 'project.json'));
  const refreshed = await localState.refresh({
    localDataRoot: localRoot,
    instanceId,
    baseline: {
      projectId: PROJECT_ID,
      planVersion: doc.planVersion,
      headHash: 'sha256:' + sha256(headBytes),
      records: doc.records.map((record) => ({
        recordId: record.id,
        path: record.path,
        contentHash: record.contentHash,
        observedHash: record.contentHash,
        bytes: Buffer.byteLength(bodyOf(record.id)),
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
  return {
    service,
    source,
    localRoot,
    instanceId,
    sourceEpoch: refreshed.entry.sourceGeneration,
    doc: readDoc,
    head: () => readFileSync(path.join(source, 'project.json'), 'utf8'),
    revision: () => readState().revisions.plan,
    envelope,
    diagnostics: () => {
      const result = validateProjectDocument(readDoc(), { sha256 });
      return result.ok ? result.diagnostics.map((item) => item.code) : ['rejected'];
    },
  };
}

const owner: TrustedContext = { kind: 'remote-owner' };
const rejectionCode = (result: { status: string; code?: string }): string =>
  result.status === 'rejected' ? result.code ?? '' : result.status;

const evidenceFor = (items: [string, string][]): MilestoneCompletionEvidence[] =>
  items.map(([recordId, criterionText], index) => {
    const record = fixtureDoc().records.find((entry) => entry.id === recordId);
    assert.ok(record !== undefined);
    return {
      criterionIndex: index,
      criterionText,
      recordId,
      contentHash: record.contentHash,
    };
  });

test('4.3 共享成果：两个里程碑可引用同一交付，条目按 nodeId 排序', async () => {
  const h = await setup();
  const first = await h.service.execute(owner, h.envelope({
    type: 'set-milestone', nodeId: C, deliveries: [{ kind: 'node', refId: A }],
  }));
  assert.equal(first.status, 'committed', JSON.stringify(first));
  const milestones = h.doc().plan.roadmap?.milestones ?? [];
  assert.deepEqual(milestones.map((item) => item.nodeId), [M, C].sort());
  assert.deepEqual(milestones[0]?.deliveries, [{ kind: 'node', refId: A }]);
  assert.deepEqual(milestones[1]?.deliveries, [{ kind: 'node', refId: A }], '同一成果可被多个里程碑引用');
});

test('4.3 交付顺序与写入顺序无关：同一集合产生同一指纹', async () => {
  const h = await setup();
  const recordDelivery = {
    kind: 'record' as const, refId: DELIVERY_RECORD,
    contentHash: fixtureDoc().records.find((entry) => entry.id === DELIVERY_RECORD)?.contentHash ?? '',
  };
  const one = await h.service.execute(owner, h.envelope({
    type: 'set-milestone', nodeId: M, deliveries: [{ kind: 'node', refId: A }, recordDelivery],
  }));
  assert.equal(one.status, 'committed', JSON.stringify(one));
  const versionA = h.doc().planVersion;
  const two = await h.service.execute(owner, h.envelope({
    type: 'set-milestone', nodeId: M, deliveries: [recordDelivery, { kind: 'node', refId: A }],
  }));
  assert.equal(two.status, 'committed', JSON.stringify(two));
  assert.equal(h.doc().planVersion, versionA, '集合相同则指纹相同（无业务变化）');
});

test('4.3 非法新增交付被拒：自引用、缺失节点、缺失记录、哈希失配、重复、非法 kind', async () => {
  const h = await setup();
  const cases: { label: string; deliveries: { kind: 'node' | 'record'; refId: string; contentHash?: string }[]; code: string }[] = [
    { label: '自引用', deliveries: [{ kind: 'node', refId: M }], code: 'milestone-self-delivery' },
    { label: '缺失节点', deliveries: [{ kind: 'node', refId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }], code: 'milestone-delivery-node-missing' },
    { label: '缺失记录', deliveries: [{ kind: 'record', refId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', contentHash: 'sha256:' + 'e'.repeat(64) }], code: 'milestone-delivery-record-missing' },
    { label: '哈希失配', deliveries: [{ kind: 'record', refId: DELIVERY_RECORD, contentHash: 'sha256:' + 'e'.repeat(64) }], code: 'milestone-delivery-hash-mismatch' },
    {
      label: '重复交付',
      deliveries: [{ kind: 'node', refId: A }, { kind: 'node', refId: A }],
      code: 'duplicate-milestone-delivery',
    },
  ];
  for (const item of cases) {
    const before = h.doc().planVersion;
    const result = await h.service.execute(owner, h.envelope({
      type: 'set-milestone', nodeId: M, deliveries: item.deliveries as never,
    }));
    assert.equal(rejectionCode(result), item.code, item.label);
    assert.equal(h.doc().planVersion, before, `${item.label}：资料未变`);
  }
  const badKind = await h.service.execute(owner, h.envelope({
    type: 'set-milestone', nodeId: M, deliveries: [{ kind: 'bogus', refId: A }] as never,
  }));
  assert.equal(rejectionCode(badKind), 'invalid-delivery-kind');
});

test('4.3 v1 资料不能编辑里程碑；owner-only 准入', async () => {
  const h = await setup(1);
  const denied = await h.service.execute(owner, h.envelope({
    type: 'set-milestone', nodeId: A, deliveries: [],
  }));
  assert.equal(rejectionCode(denied), 'roadmap-not-enabled');
  const removed = await h.service.execute(owner, h.envelope({ type: 'remove-milestone', nodeId: A }));
  assert.equal(rejectionCode(removed), 'roadmap-not-enabled');
  const agent: TrustedContext = { kind: 'agent-work', workRunId: 'run-1', bindingVersion: 1, instanceId: h.instanceId };
  const agentDenied = await h.service.execute(agent, h.envelope({
    type: 'set-milestone', nodeId: A, deliveries: [],
  }));
  assert.equal(rejectionCode(agentDenied), 'forbidden');
});

test('4.3 既有失效引用保留为待核对；新增失效引用停写', async () => {
  const h = await setup();
  // 把交付记录改为记录引用，然后外部删除该记录（索引与正文），模拟“来源被移出索引”。
  const withRecord = await h.service.execute(owner, h.envelope({
    type: 'set-milestone', nodeId: M,
    deliveries: [{
      kind: 'record', refId: DELIVERY_RECORD,
      contentHash: fixtureDoc().records.find((entry) => entry.id === DELIVERY_RECORD)?.contentHash ?? '',
    }],
  }));
  assert.equal(withRecord.status, 'committed', JSON.stringify(withRecord));
  const doc = h.doc();
  const trimmed: ProjectDocument = {
    ...doc,
    records: doc.records.filter((entry) => entry.id !== DELIVERY_RECORD),
  };
  writeFileSync(path.join(h.source, 'project.json'), JSON.stringify(trimmed, null, 2) + '\n');

  // 原样保留既有引用：允许（待核对）。
  const kept = await h.service.execute(owner, h.envelope({
    type: 'set-milestone', nodeId: M,
    deliveries: [{
      kind: 'record', refId: DELIVERY_RECORD,
      contentHash: fixtureDoc().records.find((entry) => entry.id === DELIVERY_RECORD)?.contentHash ?? '',
    }],
  }));
  assert.equal(kept.status, 'committed', JSON.stringify(kept));
  assert.deepEqual(h.diagnostics(), ['milestone-delivery-record-missing']);

  // 新增一个同样失效的引用：拒绝。
  const added = await h.service.execute(owner, h.envelope({
    type: 'set-milestone', nodeId: M,
    deliveries: [
      { kind: 'record', refId: DELIVERY_RECORD, contentHash: fixtureDoc().records.find((entry) => entry.id === DELIVERY_RECORD)?.contentHash ?? '' },
      { kind: 'record', refId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', contentHash: 'sha256:' + 'c'.repeat(64) },
    ],
  }));
  assert.equal(rejectionCode(added), 'milestone-delivery-record-missing');
});

test('4.3 取消与合并替代：引用保留、给诊断、不自动改指', async () => {
  const h = await setup();
  // 取消交付节点 B（先把 B 设为交付）。
  const set = await h.service.execute(owner, h.envelope({
    type: 'set-milestone', nodeId: M, deliveries: [{ kind: 'node', refId: A }, { kind: 'node', refId: B }],
  }));
  assert.equal(set.status, 'committed', JSON.stringify(set));
  const canceled = await h.service.execute(owner, h.envelope({ type: 'set-node-status', nodeId: B, status: 'canceled' }));
  assert.equal(canceled.status, 'committed', JSON.stringify(canceled));
  assert.deepEqual(h.diagnostics(), ['milestone-delivery-node-canceled']);
  assert.deepEqual(
    h.doc().plan.roadmap?.milestones.find((item) => item.nodeId === M)?.deliveries,
    [{ kind: 'node', refId: A }, { kind: 'node', refId: B }],
    '取消后引用原样保留',
  );

  // 合并 B 到 A：B 保留为 canceled，交付仍指向 B，不自动改指 A。
  const merged = await h.service.execute(owner, h.envelope({
    type: 'merge-nodes', keepNodeId: A, sourceNodeIds: [B], resolutions: [],
  }));
  assert.equal(merged.status, 'committed', JSON.stringify(merged));
  const deliveries = h.doc().plan.roadmap?.milestones.find((item) => item.nodeId === M)?.deliveries ?? [];
  assert.deepEqual(deliveries, [{ kind: 'node', refId: A }, { kind: 'node', refId: B }]);
});

test('4.3 移动交付节点：引用按稳定 ID 保留', async () => {
  const h = await setup();
  const moved = await h.service.execute(owner, h.envelope({
    type: 'move-node', nodeId: A, parentId: C, beforeNodeId: null,
  }));
  assert.equal(moved.status, 'committed', JSON.stringify(moved));
  assert.deepEqual(h.doc().plan.roadmap?.milestones[0]?.deliveries, [{ kind: 'node', refId: A }]);
  assert.deepEqual(h.diagnostics(), [], '移动后仍可解析');
});

test('4.3 普通状态命令不能完成里程碑；remove-milestone 只删条目', async () => {
  const h = await setup();
  const denied = await h.service.execute(owner, h.envelope({ type: 'set-node-status', nodeId: M, status: 'done' }));
  assert.equal(rejectionCode(denied), 'milestone-evidence-required');
  assert.equal(h.doc().plan.nodes.find((item) => item.id === M)?.status, 'in-progress');

  const removed = await h.service.execute(owner, h.envelope({ type: 'remove-milestone', nodeId: M }));
  assert.equal(removed.status, 'committed', JSON.stringify(removed));
  assert.deepEqual(h.doc().plan.roadmap?.milestones, []);
  assert.deepEqual(
    h.doc().plan.nodes.map((item) => item.id),
    [M, A, B, C],
    '删里程碑不动节点',
  );
});

test('4.3 完成：逐项证据齐备时一次发布节点 done + 完成记录 + 新指纹', async () => {
  const h = await setup();
  const before = h.doc();
  const recordCountBefore = before.records.length;
  const revisionBefore = h.revision();
  const result = await h.service.execute(owner, h.envelope({
    type: 'complete-milestone', nodeId: M,
    evidence: evidenceFor([[REC_PASS_1, '条件一'], [REC_PASS_2, '条件二']]),
  }));
  assert.equal(result.status, 'committed', JSON.stringify(result));
  const after = h.doc();
  assert.equal(after.plan.nodes.find((item) => item.id === M)?.status, 'done');
  assert.deepEqual(after.plan.nodes.find((item) => item.id === M)?.completionCriteria, ['条件一', '条件二']);
  assert.notEqual(after.planVersion, before.planVersion, '完成产生新指纹');
  assert.equal(after.records.length, recordCountBefore + 1, '只追加一条完成记录');
  assert.equal(h.revision(), revisionBefore + 1, '一次发布只推进一次规划修订');
  assert.deepEqual(after.plan.dependencies, before.plan.dependencies, '执行依赖不变');
  assert.deepEqual(after.plan.roadmap, before.plan.roadmap, '里程碑条目不变');

  const record = after.records[after.records.length - 1]!;
  assert.equal(record.kind, 'verification');
  assert.ok(record.summary.startsWith('[cona:milestone-completion] '));
  assert.equal(record.verification?.status, 'pass');
  assert.deepEqual(record.verification?.subject, { kind: 'node', id: M });
  assert.equal(record.verification?.subjectVersion, after.planVersion, '受检版本是完成后的指纹');
  assert.equal(record.contentHash, 'sha256:' + sha256(new TextEncoder().encode(readFileSync(path.join(h.source, record.path), 'utf8'))));

  const parsed = parseMilestoneCompletionText(readFileSync(path.join(h.source, record.path), 'utf8'));
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) return;
  assert.equal(parsed.body.milestoneNodeId, M);
  assert.equal(parsed.body.inputPlanVersion, before.planVersion);
  assert.deepEqual(parsed.body.evidence.map((item) => [item.criterionIndex, item.criterionText, item.recordId]), [
    [0, '条件一', REC_PASS_1],
    [1, '条件二', REC_PASS_2],
  ]);
});

test('4.3 完成拒绝：证据缺项、条件原文不符、非 pass、旧版本、哈希不符、主题不符', async () => {
  const h = await setup();
  const cases: { label: string; evidence: MilestoneCompletionEvidence[]; code: string }[] = [
    { label: '证据缺项', evidence: evidenceFor([[REC_PASS_1, '条件一']]), code: 'milestone-evidence-mismatch' },
    {
      label: '条件原文不符',
      evidence: evidenceFor([[REC_PASS_1, '条件一（改过）'], [REC_PASS_2, '条件二']]),
      code: 'milestone-evidence-mismatch',
    },
    {
      label: '非 pass 记录',
      evidence: evidenceFor([[REC_FAIL, '条件一'], [REC_PASS_2, '条件二']]),
      code: 'milestone-evidence-not-pass',
    },
    {
      label: '旧版本证据',
      evidence: evidenceFor([[REC_OLD, '条件一'], [REC_PASS_2, '条件二']]),
      code: 'milestone-evidence-stale',
    },
    {
      label: '哈希不符',
      evidence: [
        { ...evidenceFor([[REC_PASS_1, '条件一']])[0]!, contentHash: 'sha256:' + 'e'.repeat(64) },
        evidenceFor([[REC_PASS_2, '条件二']])[0]!,
      ],
      code: 'milestone-evidence-unavailable',
    },
    {
      label: '主题不是该节点',
      evidence: evidenceFor([[REC_OTHER, '条件一'], [REC_PASS_2, '条件二']]),
      code: 'milestone-evidence-not-pass',
    },
  ];
  for (const item of cases) {
    const before = h.head();
    const result = await h.service.execute(owner, h.envelope({
      type: 'complete-milestone', nodeId: M, evidence: item.evidence,
    }));
    assert.equal(rejectionCode(result), item.code, item.label);
    assert.equal(h.head(), before, `${item.label}：不写资料`);
  }
});

test('4.3 完成后：再完成拒绝；改条件/交付需先重新打开，重开后允许', async () => {
  const h = await setup();
  const completed = await h.service.execute(owner, h.envelope({
    type: 'complete-milestone', nodeId: M,
    evidence: evidenceFor([[REC_PASS_1, '条件一'], [REC_PASS_2, '条件二']]),
  }));
  assert.equal(completed.status, 'committed', JSON.stringify(completed));

  const again = await h.service.execute(owner, h.envelope({
    type: 'complete-milestone', nodeId: M,
    evidence: evidenceFor([[REC_PASS_1, '条件一'], [REC_PASS_2, '条件二']]),
  }));
  assert.equal(rejectionCode(again), 'milestone-already-complete');

  const editCriteria = await h.service.execute(owner, h.envelope({
    type: 'update-node', nodeId: M, patch: { completionCriteria: ['条件一（新）', '条件二'] },
  }));
  assert.equal(rejectionCode(editCriteria), 'milestone-reopen-required');
  const editDeliveries = await h.service.execute(owner, h.envelope({
    type: 'set-milestone', nodeId: M, deliveries: [{ kind: 'node', refId: C }],
  }));
  assert.equal(rejectionCode(editDeliveries), 'milestone-reopen-required');

  const reopened = await h.service.execute(owner, h.envelope({ type: 'set-node-status', nodeId: M, status: 'in-progress' }));
  assert.equal(reopened.status, 'committed', JSON.stringify(reopened));
  const edited = await h.service.execute(owner, h.envelope({
    type: 'update-node', nodeId: M, patch: { completionCriteria: ['条件一（新）', '条件二'] },
  }));
  assert.equal(edited.status, 'committed', JSON.stringify(edited));
  const replaced = await h.service.execute(owner, h.envelope({
    type: 'set-milestone', nodeId: M, deliveries: [{ kind: 'node', refId: C }],
  }));
  assert.equal(replaced.status, 'committed', JSON.stringify(replaced));
});

test('4.3 独立校验 CLI：完成记录正例通过；证据正文被改后拒绝', async () => {
  const h = await setup();
  const completed = await h.service.execute(owner, h.envelope({
    type: 'complete-milestone', nodeId: M,
    evidence: evidenceFor([[REC_PASS_1, '条件一'], [REC_PASS_2, '条件二']]),
  }));
  assert.equal(completed.status, 'committed', JSON.stringify(completed));
  const cli = path.join(packageRoot, 'lib', 'cli', 'validate.js');
  const run = (): { code: number; out: string } => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [cli, 'check-completion', h.source], { encoding: 'utf8' }) };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      return { code: failure.status ?? -1, out: failure.stdout ?? '' };
    }
  };
  const good = run();
  assert.equal(good.code, 0, good.out);
  const parsed = JSON.parse(good.out) as {
    ok: boolean;
    completions: { milestoneNodeId: string; evidenceCount: number }[];
    issues: { code: string }[];
  };
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.completions.map((item) => [item.milestoneNodeId, item.evidenceCount]), [[M, 2]]);

  // 篡改一条证据的正文：索引哈希与实际字节不符。
  const evidencePath = h.doc().records.find((record) => record.id === REC_PASS_1)?.path ?? '';
  writeFileSync(path.join(h.source, evidencePath), '# 被篡改的证据\n');
  const bad = run();
  assert.equal(bad.code, 1);
  const badResult = JSON.parse(bad.out) as { ok: boolean; issues: { code: string }[] };
  assert.equal(badResult.ok, false);
  assert.ok(
    badResult.issues.some((issue) => issue.code === 'completion-evidence-body-hash-mismatch'),
    JSON.stringify(badResult.issues),
  );
});
