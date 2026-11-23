// R2 收尾 4.2：显式启用扩展规划（A/F 层）。
// 覆盖：预览只读（目标版本、身份、验证记录影响）；owner 确认后发布 v2 空里程碑集合且
// 项目／节点／记录身份与验证受检版本不变；同 operationId 重发返回原回执、只推进一次修订；
// 已启用后预览与发布都拒绝；预览后外部改写（仅排版）拒绝发布；取消不写盘；
// agent 与缺可信上下文都拒绝；v1 普通编辑保持 v1 协议，旧 v1 schema 对 v2 给未知格式诊断。

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
import { planVersionFromJsonText } from '../src/domain/canonical/plan-fingerprint.js';
import type { ProjectDocument, RecordIndexEntry, Sha256Fn, WorkNode } from '../src/domain/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const formatsDir = path.join(packageRoot, 'formats', 'v1');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');
const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const R1 = '00000000-0000-4000-8000-000000000101';
const NODE_A = '00000000-0000-4000-8000-000000000103';
const NODE_B = '00000000-0000-4000-8000-000000000104';
const VERIFY_CURRENT = '00000000-0000-4000-8000-000000000201';
const VERIFY_HISTORY = '00000000-0000-4000-8000-000000000202';
const PREVIOUS_VERSION = 'sha256:' + 'd'.repeat(64);

function node(id: string, parentId: string | null, order: number, title: string): WorkNode {
  return { id, parentId, order, title, goal: `${title} 的目标`, completionCriteria: [], status: 'todo' };
}

function bodyOf(recordId: string): string {
  return `# 验证 ${recordId}\n\n正文示例。\n`;
}

function verificationEntry(recordId: string, subjectId: string, subjectVersion: string, summary: string): RecordIndexEntry {
  const bytes = new TextEncoder().encode(bodyOf(recordId));
  const contentHash = 'sha256:' + sha256(bytes);
  return {
    id: recordId,
    kind: 'verification',
    subjectNodeIds: [subjectId],
    path: `records/${recordId}/${contentHash.slice('sha256:'.length)}.md`,
    contentHash,
    summary,
    sources: [],
    verification: { status: 'pass', subject: { kind: 'node', id: subjectId }, subjectVersion, scope: '本地测试' },
  };
}

function fixtureDoc(): ProjectDocument {
  const draft: ProjectDocument = {
    schemaVersion: 1,
    project: { id: PROJECT_ID, title: '启用扩展夹具', goal: '测试', constraints: ['无'], repositories: [] },
    plan: {
      nodes: [
        node(R1, null, 0, '根'),
        node(NODE_A, R1, 0, 'A'),
        node(NODE_B, R1, 1, 'B'),
      ],
      dependencies: [{ nodeId: NODE_B, requiresNodeId: NODE_A }],
    },
    planVersion: '',
    records: [],
  };
  draft.planVersion = computePlanVersion(draft, sha256).planVersion;
  draft.records = [
    verificationEntry(VERIFY_CURRENT, NODE_A, draft.planVersion, '当前版本的验证'),
    verificationEntry(VERIFY_HISTORY, NODE_B, PREVIOUS_VERSION, '旧版本的验证'),
  ];
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
  state(): { operations: { operationId: string; status: string }[]; revisions: { plan: number; state: number } };
  envelope(command: Command, overrides?: Partial<{ expectedPlanVersion: string; expectedPlanRevision: number }>): {
    operationId: string;
    projectId: string;
    instanceId: string;
    sourceEpoch: number;
    expectedPlanVersion: string;
    expectedPlanRevision: number;
    command: Command;
  };
  preview(): ReturnType<ProjectCommandService['previewRoadmapEnable']>;
  reread(): { ok: boolean; planVersion: string; issues: { code: string }[] };
}

async function setup(): Promise<Harness> {
  const base = mkdtempSync(path.join(artifacts, 'roadmap-enable-'));
  const localRoot = path.join(base, 'local');
  const source = path.join(base, 'source');
  mkdirSync(source, { recursive: true });
  const doc = fixtureDoc();
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
  const readState = () => JSON.parse(
    readFileSync(path.join(localRoot, 'instances', instanceId, 'state.json'), 'utf8'),
  ) as { operations: { operationId: string; status: string }[]; revisions: { plan: number; state: number } };
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
    state: readState,
    envelope,
    preview: () => service.previewRoadmapEnable({ kind: 'remote-owner' }, { instanceId }),
    reread: () => {
      const text = readFileSync(path.join(source, 'project.json'), 'utf8');
      const result = planVersionFromJsonText(text, sha256);
      return {
        ok: result.issues.length === 0,
        planVersion: result.planVersion,
        issues: result.issues.map((issue) => ({ code: issue.code })),
      };
    },
  };
}

/** 预览并返回确认摘要（大多数用例都需要它）。 */
async function previewDigest(h: Harness): Promise<string> {
  const preview = await h.preview();
  assert.equal(preview.status, 'available', JSON.stringify(preview));
  if (preview.status !== 'available') throw new Error('preview failed');
  return preview.impact.previewDigest;
}

test('4.2 预览：给出目标版本、身份与验证记录影响，且不写资料与本机状态', async () => {
  const h = await setup();
  const before = h.head();
  const beforeRevision = h.revision();
  const beforeState = JSON.stringify(h.state());
  const preview = await h.preview();
  assert.equal(preview.status, 'available', JSON.stringify(preview));
  if (preview.status !== 'available') return;
  const impact = preview.impact;
  assert.equal(impact.current.schemaVersion, 1);
  assert.equal(impact.target.schemaVersion, 2);
  assert.notEqual(impact.target.planVersion, impact.current.planVersion, '启用产生新规划指纹');
  assert.equal(impact.milestoneCount, 0);
  assert.deepEqual(impact.identities, { projectId: PROJECT_ID, nodeCount: 3, recordCount: 2 });
  assert.deepEqual(
    impact.verifications.map((item) => [item.recordId, item.currentlyCurrent]),
    [[VERIFY_CURRENT, true], [VERIFY_HISTORY, false]],
  );
  assert.match(impact.previewDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(h.head(), before, '预览不改资料字节');
  assert.equal(h.revision(), beforeRevision);
  assert.equal(JSON.stringify(h.state()), beforeState, '预览不写本机聚合');
});

test('4.2 确认：发布 v2 空里程碑，项目／节点／依赖／记录身份与受检版本不变', async () => {
  const h = await setup();
  const before = h.doc();
  const preview = await h.preview();
  assert.equal(preview.status, 'available', JSON.stringify(preview));
  if (preview.status !== 'available') return;
  const revisionBefore = h.revision();
  const result = await h.service.execute(
    { kind: 'remote-owner' },
    h.envelope({ type: 'enable-roadmap', previewDigest: preview.impact.previewDigest }),
  );
  assert.equal(result.status, 'committed', JSON.stringify(result));
  const after = h.doc();
  assert.equal(after.schemaVersion, 2);
  assert.deepEqual(after.plan.roadmap, { milestones: [] });
  assert.equal(after.project.id, before.project.id);
  assert.deepEqual(after.plan.nodes, before.plan.nodes, '节点身份与顺序原样保留');
  assert.deepEqual(after.plan.dependencies, before.plan.dependencies, '执行依赖不变');
  assert.deepEqual(
    after.records.map((record) => [record.id, record.path, record.contentHash, record.verification?.subjectVersion]),
    before.records.map((record) => [record.id, record.path, record.contentHash, record.verification?.subjectVersion]),
    '记录身份与受检版本保持原值',
  );
  assert.equal(after.planVersion, preview.impact.target.planVersion, '指纹与预览给出的一致');
  assert.equal(h.revision(), revisionBefore + 1, '一次发布只推进一次规划修订');
  const reread = h.reread();
  assert.equal(reread.ok, true, JSON.stringify(reread.issues));
  assert.equal(reread.planVersion, after.planVersion);

  const roadmap = await h.service.roadmapState({ kind: 'remote-owner' }, { instanceId: h.instanceId });
  assert.equal(roadmap.status, 'ok');
  assert.equal(roadmap.status === 'ok' ? roadmap.roadmap.enabled : false, true);
  assert.equal(roadmap.status === 'ok' ? roadmap.roadmap.schemaVersion : 0, 2);
  assert.deepEqual(roadmap.status === 'ok' ? roadmap.roadmap.milestones : null, []);
});

test('4.2 同 operationId 重发：返回原回执，不产生第二次发布', async () => {
  const h = await setup();
  const digest = await previewDigest(h);
  const envelope = h.envelope({ type: 'enable-roadmap', previewDigest: digest });
  const first = await h.service.execute({ kind: 'remote-owner' }, envelope);
  assert.equal(first.status, 'committed', JSON.stringify(first));
  const headAfterFirst = h.head();
  const revisionAfterFirst = h.revision();

  const second = await h.service.execute({ kind: 'remote-owner' }, envelope);
  assert.equal(second.status, 'committed', JSON.stringify(second));
  assert.equal(second.status === 'committed' ? second.replayed : false, true);
  assert.equal(h.head(), headAfterFirst, '重发不改资料');
  assert.equal(h.revision(), revisionAfterFirst, '重发不推进修订');
  assert.equal(h.state().operations.length, 1, '同一 operationId 只有一条回执');
});

test('4.2 已启用：预览与再次发布都返回 roadmap-already-enabled，且不改资料', async () => {
  const h = await setup();
  const digest = await previewDigest(h);
  const first = await h.service.execute({ kind: 'remote-owner' }, h.envelope({ type: 'enable-roadmap', previewDigest: digest }));
  assert.equal(first.status, 'committed', JSON.stringify(first));
  const headAfter = h.head();

  const again = await h.preview();
  assert.equal(again.status, 'rejected');
  assert.equal(again.status === 'rejected' ? again.code : '', 'roadmap-already-enabled');

  const publish = await h.service.execute(
    { kind: 'remote-owner' },
    h.envelope({ type: 'enable-roadmap', previewDigest: digest }),
  );
  assert.equal(publish.status, 'rejected');
  assert.equal(publish.status === 'rejected' ? publish.code : '', 'roadmap-already-enabled');
  assert.equal(h.head(), headAfter, '拒绝发布不改资料');
});

test('4.2 预览后外部改写（仅排版）：确认返回 preview-mismatch，资料保持 v1；重新预览后可发布', async () => {
  const h = await setup();
  const digest = await previewDigest(h);
  // 外部只改排版：规划语义不变（planVersion 仍合法），但资料字节已变。
  const current = h.doc();
  writeFileSync(path.join(h.source, 'project.json'), JSON.stringify(current, null, 4) + '\n');
  const headBefore = h.head();

  const stale = await h.service.execute({ kind: 'remote-owner' }, h.envelope({ type: 'enable-roadmap', previewDigest: digest }));
  assert.equal(stale.status, 'rejected');
  assert.equal(stale.status === 'rejected' ? stale.code : '', 'preview-mismatch');
  assert.equal(h.doc().schemaVersion, 1, '未发布 v2');
  assert.equal(h.head(), headBefore, '拒绝时资料字节原样');

  const retryDigest = await previewDigest(h);
  const published = await h.service.execute(
    { kind: 'remote-owner' },
    h.envelope({ type: 'enable-roadmap', previewDigest: retryDigest }),
  );
  assert.equal(published.status, 'committed', JSON.stringify(published));
  assert.equal(h.doc().schemaVersion, 2);
});

test('4.2 取消：只预览不提交，资料字节与修订保持原样', async () => {
  const h = await setup();
  const before = h.head();
  const revisionBefore = h.revision();
  await previewDigest(h);
  // 取消是界面动作：不调用 execute。
  assert.equal(h.head(), before);
  assert.equal(h.revision(), revisionBefore);
  assert.equal(h.doc().schemaVersion, 1);
});

test('4.2 准入：agent-work 与缺可信上下文都不能启用扩展', async () => {
  const h = await setup();
  const digest = await previewDigest(h);
  const envelope = h.envelope({ type: 'enable-roadmap', previewDigest: digest });
  const agent: TrustedContext = { kind: 'agent-work', workRunId: 'run-1', bindingVersion: 1, instanceId: h.instanceId };
  const deniedAgent = await h.service.execute(agent, envelope);
  assert.equal(deniedAgent.status, 'rejected');
  assert.equal(deniedAgent.status === 'rejected' ? deniedAgent.code : '', 'forbidden');
  const deniedMissing = await h.service.execute(undefined, envelope);
  assert.equal(deniedMissing.status, 'rejected');
  assert.equal(deniedMissing.status === 'rejected' ? deniedMissing.code : '', 'forbidden');
  assert.equal(h.doc().schemaVersion, 1);
  // 摘要形态非法也拒绝（不进入提交）。
  const bad = await h.service.execute({ kind: 'remote-owner' }, h.envelope({ type: 'enable-roadmap', previewDigest: 'sha256:short' }));
  assert.equal(bad.status, 'rejected');
  assert.equal(bad.status === 'rejected' ? bad.code : '', 'operation-mismatch');
});

test('4.2 v1 普通编辑保持 v1 协议；旧 v1 schema 对 v2 给未知格式诊断', async () => {
  const h = await setup();
  const edited = await h.service.execute(
    { kind: 'remote-owner' },
    h.envelope({ type: 'update-node', nodeId: NODE_A, patch: { goal: '改过的目标' } }),
  );
  assert.equal(edited.status, 'committed', JSON.stringify(edited));
  const doc = h.doc();
  assert.equal(doc.schemaVersion, 1, '普通编辑不升级格式');
  assert.equal(doc.plan.roadmap, undefined, 'v1 不补扩展字段');
  assert.equal(doc.plan.nodes.find((item) => item.id === NODE_A)?.goal, '改过的目标');
  assert.ok(!h.head().includes('roadmap'), 'v1 字节协议不出现 v2 字段');
  assert.equal(h.reread().ok, true, '独立 v1 复算仍通过');

  // 旧 v1 读方按 schema 判未知格式：schemaVersion const 1 且禁止未知字段。
  const schema = JSON.parse(readFileSync(path.join(formatsDir, 'project-v1.schema.json'), 'utf8')) as {
    properties: { schemaVersion: { const: number } };
    additionalProperties: boolean;
  };
  assert.equal(schema.properties.schemaVersion.const, 1);
  assert.equal(schema.additionalProperties, false);
});
