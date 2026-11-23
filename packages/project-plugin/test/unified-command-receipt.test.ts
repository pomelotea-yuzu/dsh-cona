// 2.7 统一命令摘要与原子回执（增量 spec「新规划命令的原子发布及回执」，矩阵 E12）。
// 覆盖：请求摘要覆盖业务载荷与基线；生成 ID 与候选在发布前冻结；含替代／证据正文的动作
// 只经一个权威头发布一份结果；非法子步骤与头发布前中断不暴露部分规划或记录；
// 发布后回执丢失按候选核对取回原 ID、哈希与双修订；同号更参（位置／版本／证据／逆向目标）拒绝；
// 原位无变化保持头、指纹与规划修订。4.x 格式与里程碑命令复用同一契约（4.1／4.3／4.5 复测）。

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProjectCommandService,
  type Command,
  type CommandEnvelope,
  type CommandResult,
  type ProjectCommandDeps,
  type TrustedContext,
} from '../src/application/command-service.js';
import { LocalStateService } from '../src/application/local-state.js';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { createSourceFiles } from '../src/adapters/fs/source-files.js';
import { resolveLocalRoot, rootRelation } from '../src/adapters/fs/local-root.js';
import { inspectPrivateRoot } from '../src/adapters/fs/git-guard.js';
import { FEATURE_DEVELOPMENT_PRESET } from '../src/domain/presets.js';
import { parseReplacementText, REPLACEMENT_SUMMARY_PREFIX } from '../src/domain/replacement.js';
import type { ProjectDocument, Sha256Fn } from '../src/domain/types.js';

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

type Hooks = ProjectCommandDeps['hooks'];

interface StateView {
  revisions: { plan: number; state: number };
  operations: {
    operationId: string;
    status: string;
    rejection?: { code: string };
    generated: { recordId?: string; nodeIds?: string[] };
    prepared?: {
      candidateHead: string;
      candidateHeadHash: string;
      bodies: { recordId: string; contentHash: string; path: string }[];
      planRevision: number;
      stateRevision: number;
      writeHead: boolean;
    };
  }[];
}

interface Fixture {
  base: string;
  localRoot: string;
  source: string;
  instanceId: string;
  store: LocalStateStore;
  service: ProjectCommandService;
  makeService: (hooks?: Hooks) => ProjectCommandService;
  envelope: (command: Command, overrides?: Partial<CommandEnvelope>) => CommandEnvelope;
  /** 提交成功后推进本地基线（与界面草稿的推进同义）。 */
  accept: (result: CommandResult) => Extract<CommandResult, { status: 'committed' }>;
  doc: () => ProjectDocument;
  state: () => StateView;
  headBytes: () => Buffer;
  headHash: () => string;
}

async function setup(name: string): Promise<Fixture> {
  const base = mkdtempSync(path.join(artifacts, name));
  const localRoot = path.join(base, 'local');
  const source = path.join(base, 'source');
  mkdirSync(source, { recursive: true });
  copyFileSync(sample, path.join(source, 'project.json'));

  const store = new LocalStateStore();
  const files = createSourceFiles(formatsDir, sha256);
  const localState = new LocalStateService({
    resolver: { resolveLocal: resolveLocalRoot, relation: rootRelation },
    git: { inspect: inspectPrivateRoot },
    store,
    clock: () => new Date().toISOString(),
    newInstanceId: () => randomUUID(),
  });
  const registered = await localState.register({
    localDataRoot: localRoot, sourceRoot: source, sourceKind: 'custom', projectId: PROJECT_ID,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) throw new Error('register failed');
  const instanceId = registered.entry.instanceId;

  const makeService = (hooks?: Hooks): ProjectCommandService => new ProjectCommandService({
    localRoot, store, files, sha256,
    clock: () => new Date().toISOString(),
    newNodeId: () => randomUUID(),
    newRecordId: () => randomUUID(),
    ...(hooks === undefined ? {} : { hooks }),
  });

  const baseline = { planVersion: '', planRevision: 0 };
  const headBytes = (): Buffer => readFileSync(path.join(source, 'project.json'));
  baseline.planVersion = (JSON.parse(headBytes().toString('utf8')) as ProjectDocument).planVersion;

  const envelope = (command: Command, overrides: Partial<CommandEnvelope> = {}): CommandEnvelope => ({
    operationId: randomUUID(),
    projectId: PROJECT_ID,
    instanceId,
    sourceEpoch: registered.entry.sourceGeneration,
    expectedPlanVersion: baseline.planVersion,
    expectedPlanRevision: baseline.planRevision,
    command,
    ...overrides,
  });

  const doc = (): ProjectDocument => JSON.parse(headBytes().toString('utf8')) as ProjectDocument;
  const state = (): StateView =>
    JSON.parse(readFileSync(path.join(localRoot, 'instances', instanceId, 'state.json'), 'utf8')) as StateView;

  return {
    base, localRoot, source, instanceId, store,
    service: makeService(),
    makeService,
    envelope,
    accept(result) {
      assert.equal(result.status, 'committed', JSON.stringify(result));
      const committed = result as Extract<CommandResult, { status: 'committed' }>;
      baseline.planVersion = committed.planVersion;
      baseline.planRevision = committed.planRevision;
      return committed;
    },
    doc,
    state,
    headBytes,
    headHash: () => 'sha256:' + sha256(headBytes()),
  };
}

function rejected(result: CommandResult): Extract<CommandResult, { status: 'rejected' }> {
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  return result as Extract<CommandResult, { status: 'rejected' }>;
}

function recordDirs(fx: Fixture): string[] {
  const root = path.join(fx.source, 'records');
  return existsSync(root) ? readdirSync(root).sort() : [];
}

function bodyText(fx: Fixture, recordPath: string): string {
  return readFileSync(path.join(fx.source, ...recordPath.split('/')), 'utf8');
}

// ---- 信封与摘要：业务载荷、基线均进入摘要 ----

test('2.7 摘要覆盖业务载荷与基线：新树命令任一参数变化产生不同摘要', async () => {
  const fx = await setup('receipt-digest-');
  const service = fx.service;

  const baseCommand: Command = { type: 'update-node', nodeId: ROOT_NODE, patch: { goal: '目标', title: '标题' } };
  const env = fx.envelope(baseCommand);
  const digest = service.requestDigest(env);
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);

  // 字面量书写顺序不影响摘要（稳定排序）。
  const reordered: Command = { type: 'update-node', nodeId: ROOT_NODE, patch: { title: '标题', goal: '目标' } };
  assert.equal(service.requestDigest(fx.envelope(reordered)), digest, '同业务请求必须同摘要');

  // 基线变化必须改变摘要：否则响应丢失后无法区分“原样重发”与“换了前提”。
  assert.notEqual(service.requestDigest({ ...env, expectedPlanVersion: 'sha256:' + 'a'.repeat(64) }), digest);
  assert.notEqual(service.requestDigest({ ...env, expectedPlanRevision: 1 }), digest);
  assert.notEqual(service.requestDigest({ ...env, sourceEpoch: 2 }), digest);

  const cases: { label: string; command: Command; changed: Command }[] = [
    { label: 'move 位置', command: { type: 'move-node', nodeId: CHILD_NODE, parentId: ROOT_NODE, beforeNodeId: null },
      changed: { type: 'move-node', nodeId: CHILD_NODE, parentId: ROOT_NODE, beforeNodeId: ROOT_NODE } },
    { label: 'insert 版本', command: { type: 'insert-preset', templateId: 'feature-development', templateVersion: 1, contentLocale: 'zh-CN', parentId: ROOT_NODE, beforeNodeId: null },
      changed: { type: 'insert-preset', templateId: 'feature-development', templateVersion: 2, contentLocale: 'zh-CN', parentId: ROOT_NODE, beforeNodeId: null } },
    { label: 'insert 锚点', command: { type: 'insert-preset', templateId: 'feature-development', templateVersion: 1, contentLocale: 'zh-CN', parentId: ROOT_NODE, beforeNodeId: null },
      changed: { type: 'insert-preset', templateId: 'feature-development', templateVersion: 1, contentLocale: 'zh-CN', parentId: ROOT_NODE, beforeNodeId: CHILD_NODE } },
    { label: 'user-template 版本记录', command: { type: 'insert-user-template', templateId: randomUUID(), versionRecordId: randomUUID(), contentHash: 'sha256:' + 'b'.repeat(64), parentId: ROOT_NODE, beforeNodeId: null },
      changed: { type: 'insert-user-template', templateId: randomUUID(), versionRecordId: randomUUID(), contentHash: 'sha256:' + 'c'.repeat(64), parentId: ROOT_NODE, beforeNodeId: null } },
    { label: 'group 锚点与组内容', command: { type: 'group-nodes', nodeIds: [CHILD_NODE], group: { title: '组', goal: 'g', completionCriteria: [] }, anchorId: null },
      changed: { type: 'group-nodes', nodeIds: [CHILD_NODE], group: { title: '另一组', goal: 'g', completionCriteria: [] }, anchorId: null } },
    { label: 'merge 处置', command: { type: 'merge-nodes', keepNodeId: CHILD_NODE, sourceNodeIds: [ROOT_NODE], resolutions: [] },
      changed: { type: 'merge-nodes', keepNodeId: CHILD_NODE, sourceNodeIds: [ROOT_NODE], resolutions: [{ edge: { nodeId: CHILD_NODE, requiresNodeId: ROOT_NODE }, action: 'drop' }] } },
    { label: 'copy 目标', command: { type: 'copy-subtree', nodeId: CHILD_NODE, targetParentId: ROOT_NODE, anchorId: null, externalDependencies: [] },
      changed: { type: 'copy-subtree', nodeId: CHILD_NODE, targetParentId: null, anchorId: null, externalDependencies: [] } },
    { label: 'save-user-template 根', command: { type: 'save-user-template', templateId: randomUUID(), title: 't', bodyLanguage: 'zh-CN', rootNodeId: ROOT_NODE },
      changed: { type: 'save-user-template', templateId: randomUUID(), title: 't', bodyLanguage: 'zh-CN', rootNodeId: CHILD_NODE } },
    { label: 'undo 逆向目标', command: { type: 'undo-plan-edit', targetOperationId: randomUUID(), previewDigest: 'sha256:' + 'd'.repeat(64) },
      changed: { type: 'undo-plan-edit', targetOperationId: randomUUID(), previewDigest: 'sha256:' + 'd'.repeat(64) } },
    { label: 'append-record 证据', command: { type: 'append-record', kind: 'verification', subjectNodeIds: [CHILD_NODE], summary: 'v', sources: [], body: 'body', verification: { status: 'pass', subject: { kind: 'node', id: CHILD_NODE } } },
      changed: { type: 'append-record', kind: 'verification', subjectNodeIds: [CHILD_NODE], summary: 'v', sources: [], body: 'body', verification: { status: 'fail', subject: { kind: 'node', id: CHILD_NODE } } } },
  ];
  for (const item of cases) {
    const before = service.requestDigest(fx.envelope(item.command));
    const after = service.requestDigest(fx.envelope(item.changed));
    assert.notEqual(before, after, `${item.label} 未进入请求摘要`);
  }
});

// ---- 含替代／证据正文的原子发布 ----

test('2.7 合并：规划候选与替代正文只经一个权威头发布，回执 ID 与正文哈希可核对', async () => {
  const fx = await setup('receipt-merge-');
  const added = await fx.service.execute(OWNER, fx.envelope({
    type: 'add-nodes',
    nodes: [{ parentId: ROOT_NODE, order: 1, title: '成员A', goal: 'ga', completionCriteria: [] }],
  }));
  fx.accept(added);
  const memberId = fx.doc().plan.nodes.find((node) => node.title === '成员A')?.id;
  assert.ok(memberId !== undefined);

  const writes = { head: 0, body: 0 };
  const service = fx.makeService({
    publish: { beforeReread: () => { writes.head += 1; } },
    body: { beforeReread: () => { writes.body += 1; } },
  });

  const env = fx.envelope({ type: 'merge-nodes', keepNodeId: CHILD_NODE, sourceNodeIds: [memberId], resolutions: [] });
  const merged = fx.accept(await service.execute(OWNER, env));

  assert.equal(writes.head, 1, '只发布一个权威头');
  assert.equal(writes.body, 1, '只写一份衍生正文');
  assert.ok(merged.recordId !== undefined, '回执携带替代记录 id');

  const doc = fx.doc();
  assert.equal(doc.records.length, 1, '结果只有一条记录');
  const record = doc.records.find((item) => item.id === merged.recordId);
  assert.ok(record !== undefined, '记录索引与回执 id 一致');
  assert.equal(record.kind, 'plan-change');
  assert.ok(record.summary.startsWith(REPLACEMENT_SUMMARY_PREFIX));
  assert.deepEqual(record.subjectNodeIds, [CHILD_NODE, memberId]);

  const text = bodyText(fx, record.path);
  assert.equal('sha256:' + sha256(new TextEncoder().encode(text)), record.contentHash, '正文哈希与索引一致');
  const parsed = parseReplacementText(text);
  assert.equal(parsed.ok, true, JSON.stringify(parsed.ok === false ? parsed.issues : []));
  if (parsed.ok && parsed.body.kind === 'replace') {
    assert.deepEqual(parsed.body.sourceNodeIds, [memberId]);
    assert.equal(parsed.body.replacementNodeId, CHILD_NODE);
  }

  // 一次业务变化只推进一次规划修订；意图中的生成身份与回执、磁盘一致。
  assert.deepEqual(fx.state().revisions, { plan: 2, state: 2 });
  const intent = fx.state().operations.at(-1);
  assert.equal(intent?.generated.recordId, merged.recordId);
  assert.equal(intent?.prepared?.bodies[0]?.contentHash, record.contentHash);
  assert.equal(intent?.prepared?.candidateHeadHash, fx.headHash());
  assert.equal(intent?.prepared?.candidateHead, fx.headBytes().toString('utf8'), '候选头在发布前冻结');
  assert.equal(merged.planVersion, doc.planVersion);
});

test('2.7 证据正文：验证记录与资料头同一次发布，规划修订不推进', async () => {
  const fx = await setup('receipt-verification-');
  const versionBefore = fx.doc().planVersion;
  const writes = { head: 0, body: 0 };
  const service = fx.makeService({
    publish: { beforeReread: () => { writes.head += 1; } },
    body: { beforeReread: () => { writes.body += 1; } },
  });

  const env = fx.envelope({
    type: 'append-record',
    kind: 'verification',
    subjectNodeIds: [CHILD_NODE],
    summary: '复测通过',
    sources: [],
    body: '# 验证\n\n复测通过\n',
    verification: { status: 'pass', subject: { kind: 'node', id: CHILD_NODE } },
  });
  const result = fx.accept(await service.execute(OWNER, env));

  assert.equal(writes.head, 1);
  assert.equal(writes.body, 1);
  assert.equal(result.impact, 'state', '记录追加只推进状态修订');
  assert.equal(result.planRevision, 0, '规划修订不推进');
  assert.equal(result.stateRevision, 1);

  const doc = fx.doc();
  assert.equal(doc.planVersion, versionBefore, '规划指纹保持');
  assert.equal(doc.records.length, 1);
  const record = doc.records[0]!;
  assert.equal(record.id, result.recordId);
  assert.deepEqual(record.verification, { status: 'pass', subject: { kind: 'node', id: CHILD_NODE } });
  const text = bodyText(fx, record.path);
  assert.equal('sha256:' + sha256(new TextEncoder().encode(text)), record.contentHash);
});

test('2.7 生成 ID 与候选在发布前冻结：意图中的 nodeIds 就是磁盘上的新身份', async () => {
  const fx = await setup('receipt-frozen-');
  const env = fx.envelope({
    type: 'insert-preset', templateId: 'feature-development', templateVersion: 1,
    contentLocale: 'zh-CN', parentId: ROOT_NODE, beforeNodeId: null,
  });
  const result = fx.accept(await fx.service.execute(OWNER, env));
  const intent = fx.state().operations.at(-1);
  const frozen = intent?.generated.nodeIds ?? [];
  assert.equal(frozen.length, FEATURE_DEVELOPMENT_PRESET.nodes.length);
  assert.equal(new Set(frozen).size, frozen.length, '生成 ID 不重复');

  const doc = fx.doc();
  const onDisk = new Set(doc.plan.nodes.map((node) => node.id));
  for (const id of frozen) assert.ok(onDisk.has(id), `意图中的 ${id} 必须已发布`);
  assert.equal(intent?.prepared?.candidateHead, fx.headBytes().toString('utf8'));

  // 同号重发返回同一结果，不再分配新身份。
  const replay = await fx.service.execute(OWNER, env);
  assert.equal(replay.status === 'committed' ? replay.replayed : false, true);
  assert.equal(replay.status === 'committed' ? replay.planRevision : -1, result.planRevision);
  assert.equal(fx.doc().plan.nodes.length, doc.plan.nodes.length);
});

// ---- 拒绝与中断不暴露部分结果 ----

test('2.7 非法子步骤：整批拒绝，不写正文、不改头与规划修订', async () => {
  const fx = await setup('receipt-invalid-substep-');
  const added = await fx.service.execute(OWNER, fx.envelope({
    type: 'add-nodes',
    nodes: [{ parentId: ROOT_NODE, order: 1, title: '成员B', goal: 'gb', completionCriteria: [] }],
  }));
  fx.accept(added);
  const memberId = fx.doc().plan.nodes.find((node) => node.title === '成员B')?.id;
  assert.ok(memberId !== undefined);
  // 给来源节点加一条外部依赖，合并时不处置该边 → 领域整批拒绝。
  const withDependency = await fx.service.execute(OWNER, fx.envelope({
    type: 'set-dependencies',
    dependencies: [
      { nodeId: CHILD_NODE, requiresNodeId: ROOT_NODE },
      { nodeId: memberId, requiresNodeId: CHILD_NODE },
    ],
  }));
  fx.accept(withDependency);

  const headBefore = fx.headBytes();
  const recordsBefore = recordDirs(fx);
  const revisionsBefore = fx.state().revisions;
  const operationsBefore = fx.state().operations.length;

  const result = rejected(await fx.service.execute(OWNER, fx.envelope({
    type: 'merge-nodes', keepNodeId: CHILD_NODE, sourceNodeIds: [memberId], resolutions: [],
  })));
  assert.equal(result.code, 'unresolved-dependency');

  assert.deepEqual(fx.headBytes(), headBefore, '资料头保持');
  assert.deepEqual(recordDirs(fx), recordsBefore, '没有写入任何记录正文');
  assert.deepEqual(fx.state().revisions, revisionsBefore);
  assert.equal(fx.state().operations.length, operationsBefore, '非法子步骤不落意图');
});

test('2.7 头发布前中断：不暴露部分规划或记录索引', async () => {
  const fx = await setup('receipt-head-interrupt-');
  const added = await fx.service.execute(OWNER, fx.envelope({
    type: 'add-nodes',
    nodes: [{ parentId: ROOT_NODE, order: 1, title: '成员C', goal: 'gc', completionCriteria: [] }],
  }));
  fx.accept(added);
  const memberId = fx.doc().plan.nodes.find((node) => node.title === '成员C')?.id;
  assert.ok(memberId !== undefined);

  const headBefore = fx.headBytes();
  const recordsBefore = fx.doc().records.length;
  const revisionsBefore = fx.state().revisions;
  const service = fx.makeService({ publish: { beforeRename: () => { throw new Error('injected-head-interrupt'); } } });

  const result = rejected(await service.execute(OWNER, fx.envelope({
    type: 'merge-nodes', keepNodeId: CHILD_NODE, sourceNodeIds: [memberId], resolutions: [],
  })));
  assert.equal(result.code, 'persistence-failed');

  assert.deepEqual(fx.headBytes(), headBefore, '资料头未替换');
  assert.equal(fx.doc().records.length, recordsBefore, '记录索引未变化');
  assert.deepEqual(fx.state().revisions, revisionsBefore, '修订未推进');

  // 正文可能已先落盘（先正文后头），但未进入索引，不属于已发布记录。
  const intent = fx.state().operations.at(-1);
  assert.equal(intent?.status, 'rejected');
  const candidateRecordId = intent?.generated.recordId;
  assert.ok(candidateRecordId !== undefined);
  assert.equal(fx.doc().records.some((item) => item.id === candidateRecordId), false, '孤立正文不作为记录暴露');
});

test('2.7 发布后回执丢失：按候选核对取回原 ID、哈希与双修订，同号重发不再执行', async () => {
  const fx = await setup('receipt-lost-');
  const added = await fx.service.execute(OWNER, fx.envelope({
    type: 'add-nodes',
    nodes: [{ parentId: ROOT_NODE, order: 1, title: '成员D', goal: 'gd', completionCriteria: [] }],
  }));
  fx.accept(added);
  const memberId = fx.doc().plan.nodes.find((node) => node.title === '成员D')?.id;
  assert.ok(memberId !== undefined);

  // 第三次聚合替换（回执阶段）失败：资料已发布，回执未落盘。
  let stateWrites = 0;
  const lossy = fx.makeService({
    state: {
      beforeTempWrite: () => {
        stateWrites += 1;
        if (stateWrites === 3) throw new Error('injected-receipt-loss');
      },
    },
  });
  const env = fx.envelope({ type: 'merge-nodes', keepNodeId: CHILD_NODE, sourceNodeIds: [memberId], resolutions: [] });
  const pending = await lossy.execute(OWNER, env);
  assert.equal(pending.status, 'pending-reconciliation', JSON.stringify(pending));
  assert.equal(pending.status === 'pending-reconciliation' ? pending.stage : '', 'receipt');

  // 资料确已发布，但本机聚合仍停在 publishing。
  const publishedDoc = fx.doc();
  assert.equal(publishedDoc.records.length, 1, '替代记录已随资料头发布');
  const publishedVersion = publishedDoc.planVersion;
  const publishedDigest = fx.headHash();
  const intent = fx.state().operations.at(-1);
  assert.equal(intent?.status, 'publishing');

  const recovered = await fx.service.recover(OWNER, { instanceId: fx.instanceId, operationId: env.operationId });
  assert.equal(recovered.status, 'committed', JSON.stringify(recovered));
  if (recovered.status !== 'committed') return;
  assert.equal(recovered.recovery, 'candidate-matched');
  assert.equal(recovered.replayed, true);
  assert.equal(recovered.operationId, env.operationId, '保留原操作 id');
  assert.equal(recovered.planVersion, publishedVersion, '取回相同规划指纹');
  assert.deepEqual(fx.state().revisions, { plan: 2, state: 2 }, '双修订只补一次');
  assert.equal(recovered.recordId, intent?.generated.recordId, '取回相同记录 id');
  assert.equal(fx.state().operations.at(-1)?.prepared?.candidateHeadHash, publishedDigest);

  const receipt = await fx.service.getReceipt(OWNER, { instanceId: fx.instanceId, operationId: env.operationId });
  assert.equal(receipt.status, 'committed');
  assert.equal(receipt.status === 'committed' ? receipt.recordId : '', recovered.recordId);

  const resent = await fx.service.execute(OWNER, env);
  assert.equal(resent.status, 'committed', JSON.stringify(resent));
  assert.equal(resent.status === 'committed' ? resent.replayed : false, true, '同号原样重发返回原回执');
  assert.equal(fx.doc().records.length, 1, '不重复发布正文');
  assert.deepEqual(fx.state().revisions, { plan: 2, state: 2 });
});

test('2.7 同号更参：位置、版本、证据与逆向目标分别被拒', async () => {
  const fx = await setup('receipt-mismatch-');

  // 位置：已提交的插入换锚点。
  const insertEnv = fx.envelope({
    type: 'insert-preset', templateId: 'feature-development', templateVersion: 1,
    contentLocale: 'zh-CN', parentId: ROOT_NODE, beforeNodeId: null,
  });
  fx.accept(await fx.service.execute(OWNER, insertEnv));
  let bytes = fx.headBytes();
  let revisions = fx.state().revisions;
  const changedAnchor = rejected(await fx.service.execute(OWNER, {
    ...insertEnv,
    command: { ...insertEnv.command, beforeNodeId: CHILD_NODE } as Command,
  }));
  assert.equal(changedAnchor.code, 'operation-mismatch');

  // 版本：同号换模板版本。
  const changedVersion = rejected(await fx.service.execute(OWNER, {
    ...insertEnv,
    command: { type: 'insert-preset', templateId: 'feature-development', templateVersion: 9, contentLocale: 'zh-CN', parentId: ROOT_NODE, beforeNodeId: null },
  }));
  assert.equal(changedVersion.code, 'operation-mismatch');
  assert.deepEqual(fx.headBytes(), bytes, '更参不得写入');
  assert.deepEqual(fx.state().revisions, revisions);

  // 证据：同号换验证结论。
  const recordEnv = fx.envelope({
    type: 'append-record', kind: 'verification', subjectNodeIds: [CHILD_NODE],
    summary: '复测', sources: [], body: '# 复测\n',
    verification: { status: 'pass', subject: { kind: 'node', id: CHILD_NODE } },
  });
  fx.accept(await fx.service.execute(OWNER, recordEnv));
  bytes = fx.headBytes();
  revisions = fx.state().revisions;
  const changedEvidence = rejected(await fx.service.execute(OWNER, {
    ...recordEnv,
    command: { ...recordEnv.command, verification: { status: 'fail', subject: { kind: 'node', id: CHILD_NODE } } } as Command,
  }));
  assert.equal(changedEvidence.code, 'operation-mismatch');
  assert.deepEqual(fx.headBytes(), bytes);
  assert.deepEqual(fx.state().revisions, revisions);

  // 逆向目标：先建两次可撤销编辑，撤销 A 后同号改指 B。
  const opA = fx.envelope({ type: 'update-node', nodeId: ROOT_NODE, patch: { goal: 'A 的目标' } });
  fx.accept(await fx.service.execute(OWNER, opA));
  const opB = fx.envelope({ type: 'update-node', nodeId: CHILD_NODE, patch: { goal: 'B 的目标' } });
  fx.accept(await fx.service.execute(OWNER, opB));

  const preview = await fx.service.previewInverse(OWNER, {
    instanceId: fx.instanceId, targetOperationId: opA.operationId, direction: 'undo',
  });
  assert.equal(preview.status, 'available', JSON.stringify(preview));
  if (preview.status !== 'available') return;

  const undoEnv = fx.envelope({
    type: 'undo-plan-edit', targetOperationId: opA.operationId, previewDigest: preview.previewDigest,
  });
  fx.accept(await fx.service.execute(OWNER, undoEnv));
  bytes = fx.headBytes();
  revisions = fx.state().revisions;
  const changedInverse = rejected(await fx.service.execute(OWNER, {
    ...undoEnv,
    command: { ...undoEnv.command, targetOperationId: opB.operationId } as Command,
  }));
  assert.equal(changedInverse.code, 'operation-mismatch');
  assert.deepEqual(fx.headBytes(), bytes, '更参不得重放逆向变换');
  assert.deepEqual(fx.state().revisions, revisions);
});

test('2.7 原位无变化：头、指纹与规划修订保持', async () => {
  const fx = await setup('receipt-noop-');
  const headBefore = fx.headBytes();
  const versionBefore = fx.doc().planVersion;

  const result = fx.accept(await fx.service.execute(OWNER, fx.envelope({
    type: 'move-node', nodeId: CHILD_NODE, parentId: ROOT_NODE, beforeNodeId: null,
  })));
  assert.equal(result.impact, 'state', '无业务变化只推进状态修订');
  assert.deepEqual(fx.headBytes(), headBefore, '不重写资料头');
  assert.equal(fx.doc().planVersion, versionBefore);
  assert.deepEqual(fx.state().revisions, { plan: 0, state: 1 });
});

test('2.7 预置正文与候选同一结果：批量命令的记录与节点身份同源', async () => {
  // 分支：无衍生正文的批量命令（分组）也走同一意图／回执契约，不额外产生记录。
  const fx = await setup('receipt-batch-');
  const written = { head: 0, body: 0 };
  const service = fx.makeService({
    publish: { beforeReread: () => { written.head += 1; } },
    body: { beforeReread: () => { written.body += 1; } },
  });

  const env = fx.envelope({
    type: 'group-nodes', nodeIds: [CHILD_NODE],
    group: { title: '新组', goal: '归并子项', completionCriteria: [] }, anchorId: null,
  });
  const result = fx.accept(await service.execute(OWNER, env));
  assert.equal(written.head, 1);
  assert.equal(written.body, 0, '分组不产生衍生正文');

  const intent = fx.state().operations.at(-1);
  const groupId = intent?.generated.nodeIds?.[0];
  assert.ok(groupId !== undefined);
  const group = fx.doc().plan.nodes.find((node) => node.id === groupId);
  assert.equal(group?.title, '新组');
  assert.equal(fx.doc().records.length, 0, '分组只发布规划，不追加记录');
  assert.equal(result.planRevision, 1);

  const replay = await fx.service.execute(OWNER, env);
  assert.equal(replay.status === 'committed' ? replay.replayed : false, true);
  assert.equal(fx.state().revisions.plan, 1);
});
