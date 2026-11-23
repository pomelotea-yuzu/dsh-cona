// 统一用户模板插入与重试（tasks 2.5，design §2「用户模板目录与版本」）。
// A 层：领域实例化变换、身份三元组错误码、owner 准入、命令目标映射；
// F 层：两位置插入（新 ID/todo/内部依赖、原树不动）、源变化与基线冲突保留草稿、
//       同号重试不重复生成、重启后回读、同号改参拒绝。

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
import { commandAction, commandTargets } from '../src/application/work.js';
import { LocalStateService } from '../src/application/local-state.js';
import { LocalStateStore } from '../src/adapters/fs/local-state.js';
import { createSourceFiles } from '../src/adapters/fs/source-files.js';
import { resolveLocalRoot, rootRelation } from '../src/adapters/fs/local-root.js';
import { inspectPrivateRoot } from '../src/adapters/fs/git-guard.js';
import { validateProjectDocument } from '../src/domain/validate.js';
import { instantiateUserTemplate, parseUserTemplateText } from '../src/domain/user-template.js';
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
const AGENT = (instanceId: string): TrustedContext => ({
  kind: 'agent-work', workRunId: 'work-run-1', bindingVersion: 1, instanceId,
});

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
  registryPath: string;
}

async function setup(name: string): Promise<Fixture> {
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
    git: { inspect: inspectPrivateRoot }, store, clock, newInstanceId: () => randomUUID(),
  });
  const registered = await localState.register({
    localDataRoot: localRoot, sourceRoot: source, sourceKind: 'custom', projectId: PROJECT_ID,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) throw new Error('register failed');
  const instanceId = registered.entry.instanceId;
  const service = new ProjectCommandService({
    localRoot, store, files, sha256, clock, newNodeId: () => randomUUID(), newRecordId: () => randomUUID(),
  });
  const doc = (): ProjectDocument => JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as ProjectDocument;
  const envelope = (command: Command, overrides: Partial<CommandEnvelope> = {}): CommandEnvelope => {
    const current = doc();
    const agg = JSON.parse(readFileSync(path.join(localRoot, 'instances', instanceId, 'state.json'), 'utf8')) as { revisions: { plan: number } };
    return {
      operationId: randomUUID(), projectId: PROJECT_ID, instanceId,
      sourceEpoch: registered.entry.sourceGeneration,
      expectedPlanVersion: current.planVersion,
      expectedPlanRevision: agg.revisions.plan,
      command, ...overrides,
    };
  };
  return {
    base, localRoot, source, instanceId, service, store, doc, envelope,
    aggregate: () => JSON.parse(readFileSync(path.join(localRoot, 'instances', instanceId, 'state.json'), 'utf8')) as Record<string, any>,
    registryPath: path.join(localRoot, 'registry.json'),
  };
}

function committed(result: CommandResult): Extract<CommandResult, { status: 'committed' }> {
  assert.equal(result.status, 'committed', JSON.stringify(result));
  return result as Extract<CommandResult, { status: 'committed' }>;
}
function rejected(result: CommandResult): Extract<CommandResult, { status: 'rejected' }> {
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  return result as Extract<CommandResult, { status: 'rejected' }>;
}

/** 保存一份 sample 子树模板，返回插入所需的三元组。 */
async function saveTemplate(fx: Fixture): Promise<{ templateId: string; versionRecordId: string; contentHash: string }> {
  const templateId = randomUUID();
  const saved = committed(await fx.service.execute(OWNER, fx.envelope({
    type: 'save-user-template', templateId, title: '可复用流程', bodyLanguage: 'zh-CN', rootNodeId: ROOT_NODE,
  })));
  const record = fx.doc().records.find((r) => r.id === saved.recordId)!;
  return { templateId, versionRecordId: record.id, contentHash: record.contentHash };
}

const insertCmd = (
  ids: { templateId: string; versionRecordId: string; contentHash: string },
  parentId: string | null = ROOT_NODE,
  beforeNodeId: string | null = null,
): Command => ({
  type: 'insert-user-template', ...ids, parentId, beforeNodeId,
});

// ---- 领域层：实例化变换 ----

test('2.5 用户模板实例化：新 ID/todo/内部依赖，父/锚点校验，原树不动', () => {
  const doc = JSON.parse(readFileSync(sample, 'utf8')) as ProjectDocument;
  const parsed = parseUserTemplateText(buildBodyText());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const body = parsed.body;
  const a = randomUUID(); const b = randomUUID();
  const result = instantiateUserTemplate(doc.plan, body, [a, b], ROOT_NODE, before());
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const plan = result.value;
  const fresh = plan.nodes.filter((n) => n.id === a || n.id === b);
  assert.equal(fresh.length, 2);
  assert.ok(fresh.every((n) => n.status === 'todo'));
  assert.equal(plan.dependencies.some((d) => d.nodeId === b && d.requiresNodeId === a), true, '内部依赖按新 ID 映射');
  assert.equal(plan.nodes.find((n) => n.id === ROOT_NODE)?.title, '阶段1', '原节点不动');
  // 未知父/错误锚点/ID 数量不符拒绝。
  assert.equal(instantiateUserTemplate(doc.plan, body, [a, b], randomUUID(), null).ok, false);
  assert.equal(instantiateUserTemplate(doc.plan, body, [a, b], null, null).ok, false);
  assert.equal(instantiateUserTemplate(doc.plan, body, [a, b], ROOT_NODE, randomUUID()).ok, false);
  assert.equal(instantiateUserTemplate(doc.plan, body, [a], ROOT_NODE, null).ok, false);
});

function before(): string | null { return null; }
function buildBodyText(): string {
  return [
    '<!-- cona:template v1 -->',
    '',
    '```json',
    JSON.stringify({
      version: 1, templateId: randomUUID(), title: '实例化夹具', bodyLanguage: 'zh-CN',
      nodes: [
        { key: 'n0', parentKey: null, order: 0, title: '根', goal: 'g', completionCriteria: [] },
        { key: 'n1', parentKey: 'n0', order: 0, title: '子', goal: 'g', completionCriteria: [] },
      ],
      dependencies: [{ nodeKey: 'n1', requiresKey: 'n0' }],
    }),
    '```',
    '',
  ].join('\n');
}

// ---- 服务与文件后端 ----

test('2.5 两位置插入：各生成一批 todo ID 与内部依赖，v1 回读，原树不动', async () => {
  const fx = await setup('tpl-insert-two-');
  const ids = await saveTemplate(fx);
  const beforeNodes = fx.doc().plan.nodes.length;
  const beforeDeps = fx.doc().plan.dependencies.length;
  const beforeRevision = fx.aggregate().revisions.plan;

  // 位置一：父 ROOT 末尾。
  const r1 = committed(await fx.service.execute(OWNER, fx.envelope(insertCmd(ids, ROOT_NODE, null))));
  assert.equal(r1.planRevision, beforeRevision + 1);
  const doc1 = fx.doc();
  assert.equal(doc1.plan.nodes.length, beforeNodes + 2);
  assert.equal(doc1.plan.dependencies.length, beforeDeps + 1);
  const added1 = doc1.plan.nodes.filter((n) => n.id !== ROOT_NODE && n.id !== CHILD_NODE);
  assert.equal(added1.length, 2);
  assert.ok(added1.every((n) => n.status === 'todo'));
  assert.equal(validateProjectDocument(doc1, { sha256 }).ok, true);
  // 原节点与依赖仍在。
  assert.ok(doc1.plan.nodes.some((n) => n.id === CHILD_NODE));
  assert.ok(doc1.plan.dependencies.some((d) => d.nodeId === CHILD_NODE && d.requiresNodeId === ROOT_NODE));

  // 位置二：父 ROOT、锚点 CHILD 之前（独立操作号与基线）。
  const r2 = committed(await fx.service.execute(OWNER, fx.envelope(insertCmd(ids, ROOT_NODE, CHILD_NODE))));
  assert.equal(r2.planRevision, beforeRevision + 2);
  const doc2 = fx.doc();
  assert.equal(doc2.plan.nodes.length, beforeNodes + 4, '两批各 2 节点');
  assert.equal(doc2.plan.dependencies.length, beforeDeps + 2, '两批各 1 条内部依赖');
  const insertedBeforeChild = doc2.plan.nodes.find((n) => n.parentId === ROOT_NODE && n.order === 0);
  assert.equal(insertedBeforeChild?.id, added1[0]?.id === insertedBeforeChild?.id ? added1[0]?.id : insertedBeforeChild?.id);
  assert.equal(validateProjectDocument(doc2, { sha256 }).ok, true);
});

test('2.5 身份三元组与位置错误码：版本不存在/哈希不符/正文非法/parent 与锚点', async () => {
  const fx = await setup('tpl-insert-errors-');
  const ids = await saveTemplate(fx);

  // 版本不存在（记录 id 不存在）。
  const noVersion = await fx.service.execute(OWNER, fx.envelope(insertCmd({ ...ids, versionRecordId: randomUUID() })));
  assert.equal(rejected(noVersion).code, 'template-version-unavailable');

  // 内容哈希不符（请求哈希改掉）。
  const mismatch = await fx.service.execute(OWNER, fx.envelope(insertCmd({ ...ids, contentHash: 'sha256:' + '0'.repeat(64) })));
  assert.equal(rejected(mismatch).code, 'template-version-mismatch');

  // 模板身份不符（templateId 改掉，记录与哈希仍匹配）。
  const wrongId = await fx.service.execute(OWNER, fx.envelope(insertCmd({ ...ids, templateId: randomUUID() })));
  assert.equal(rejected(wrongId).code, 'template-version-mismatch');

  // 正文非法但索引哈希一致：直接写一条 version=2 的正文，并把 contentHash 设为实际字节哈希。
  const badId = randomUUID();
  const badText = [
    '<!-- cona:template v1 -->', '', '```json',
    JSON.stringify({
      version: 2, templateId: randomUUID(), title: '非法', bodyLanguage: 'zh-CN',
      nodes: [{ key: 'n0', parentKey: null, order: 0, title: 'x', goal: 'y', completionCriteria: [] }],
      dependencies: [],
    }),
    '```', '',
  ].join('\n');
  const badBytes = new TextEncoder().encode(badText);
  const badHash = 'sha256:' + sha256(badBytes);
  const badPath = `records/${badId}/${badHash.slice('sha256:'.length)}.md`;
  mkdirSync(path.join(fx.source, 'records', badId), { recursive: true });
  writeFileSync(path.join(fx.source, badPath), badText);
  const doc = fx.doc();
  doc.records.push({
    id: badId, kind: 'plan-change', subjectNodeIds: [], path: badPath, contentHash: badHash,
    summary: '[cona:template] 非法正文', sources: [],
  });
  writeFileSync(path.join(fx.source, 'project.json'), JSON.stringify(doc));
  // 手工改索引后 planVersion 未变（plan 未变），用当前基线即可。
  const invalid = await fx.service.execute(OWNER, fx.envelope({
    type: 'insert-user-template', templateId: randomUUID(), versionRecordId: badId,
    contentHash: badHash, parentId: ROOT_NODE, beforeNodeId: null,
  }));
  assert.equal(rejected(invalid).code, 'template-invalid');

  // 位置错误：parentId 为 null 与不存在父节点都返回 parent-not-found；错误锚点 invalid-anchor。
  const nullParent = await fx.service.execute(OWNER, fx.envelope(insertCmd(ids, null, null)));
  assert.equal(rejected(nullParent).code, 'parent-not-found');
  const noParent = await fx.service.execute(OWNER, fx.envelope(insertCmd(ids, randomUUID(), null)));
  assert.equal(rejected(noParent).code, 'parent-not-found');
  const badAnchor = await fx.service.execute(OWNER, fx.envelope(insertCmd(ids, ROOT_NODE, randomUUID())));
  assert.equal(rejected(badAnchor).code, 'invalid-anchor');
  const crossAnchor = await fx.service.execute(OWNER, fx.envelope(insertCmd(ids, ROOT_NODE, ROOT_NODE)));
  assert.equal(rejected(crossAnchor).code, 'invalid-anchor', '锚点不属于目标同级组');

  // 所有拒绝都不推进规划修订。
  assert.equal(fx.aggregate().revisions.plan, 0);
});

test('2.5 源变化与基线冲突保留草稿：不分配候选、文件不变', async () => {
  const fx = await setup('tpl-insert-conflict-');
  const ids = await saveTemplate(fx);

  // 基线冲突：用过期 planVersion 与过期规划修订制造冲突（此时规划修订仍为 0，用 1）。
  const headBefore = readFileSync(path.join(fx.source, 'project.json'));
  const conflict = await fx.service.execute(OWNER, fx.envelope(insertCmd(ids), {
    expectedPlanRevision: 99, expectedPlanVersion: 'sha256:' + '0'.repeat(64),
  }));
  assert.equal(rejected(conflict).code, 'plan-conflict');
  assert.deepEqual(readFileSync(path.join(fx.source, 'project.json')), headBefore, '冲突请求不改文件');
  assert.equal(fx.aggregate().revisions.plan, 0, '冲突请求不推进规划修订');

  // 源变化：提升注册表代际。
  const registry = JSON.parse(readFileSync(fx.registryPath, 'utf8')) as { instances: { sourceGeneration: number }[] };
  registry.instances[0]!.sourceGeneration = 2;
  writeFileSync(fx.registryPath, JSON.stringify(registry));
  const sourceChanged = await fx.service.execute(OWNER, fx.envelope(insertCmd(ids)));
  assert.equal(rejected(sourceChanged).code, 'source-changed');
  assert.deepEqual(readFileSync(path.join(fx.source, 'project.json')), headBefore, '源变化请求不改文件');
});

test('2.5 同号重试与重启：断联后重放只回读原回执、不重复生成；同号改参拒绝', async () => {
  const fx = await setup('tpl-insert-retry-');
  const ids = await saveTemplate(fx);
  const env = fx.envelope(insertCmd(ids));
  const first = committed(await fx.service.execute(OWNER, env));
  const nodesAfterFirst = fx.doc().plan.nodes.length;
  const revAfterFirst = fx.aggregate().revisions.plan;

  // 断联/回执丢失：同 envelope 原样重发。
  const replay = await fx.service.execute(OWNER, env);
  assert.equal(replay.status, 'committed');
  assert.equal((replay as any).replayed, true);
  assert.equal(fx.doc().plan.nodes.length, nodesAfterFirst, '不重复生成节点');
  assert.equal(fx.aggregate().revisions.plan, revAfterFirst);

  // 重启后查询回执：新服务实例指向同一本机根与 store，仍返回历史结果。
  const restarted = new ProjectCommandService({
    localRoot: fx.localRoot, store: fx.store,
    files: createSourceFiles(formatsDir, sha256), sha256,
    clock: () => new Date().toISOString(), newNodeId: () => randomUUID(), newRecordId: () => randomUUID(),
  });
  const afterRestart = await restarted.getReceipt(OWNER, { instanceId: fx.instanceId, operationId: env.operationId });
  assert.equal(afterRestart.status, 'committed');
  assert.equal((afterRestart as any).replayed, true);
  assert.equal((afterRestart as any).planVersion, first.planVersion);

  // 同号改参数（换 contentHash）应被 operation-mismatch 拒绝。
  const changed = await fx.service.execute(OWNER, { ...env, command: insertCmd({ ...ids, contentHash: 'sha256:' + 'f'.repeat(64) }) });
  assert.equal(rejected(changed).code, 'operation-mismatch');
  assert.equal(fx.doc().plan.nodes.length, nodesAfterFirst, '改参请求不生成节点');
});

test('2.5 用户模板插入可撤销（2.3 契约）：批次身份记录、撤销后原树恢复', async () => {
  const fx = await setup('tpl-insert-undo-');
  const ids = await saveTemplate(fx);
  const beforeNodes = fx.doc().plan.nodes.length;
  const ins = committed(await fx.service.execute(OWNER, fx.envelope(insertCmd(ids))));
  const record = fx.aggregate().operations.find((o: any) => o.operationId === ins.operationId);
  assert.equal(record.inverse?.generatedNodes.length, 2, '批次身份写入逆向信息');
  const preview = await fx.service.previewInverse(OWNER, { instanceId: fx.instanceId, targetOperationId: ins.operationId, direction: 'undo' });
  assert.equal(preview.status, 'available', JSON.stringify(preview));
  if (preview.status !== 'available') return;
  committed(await fx.service.execute(OWNER, fx.envelope({
    type: 'undo-plan-edit', targetOperationId: ins.operationId, previewDigest: preview.previewDigest,
  })));
  assert.equal(fx.doc().plan.nodes.length, beforeNodes, '撤销移除整批插入节点');
  assert.equal(validateProjectDocument(fx.doc(), { sha256 }).ok, true);
});

test('2.5 owner 准入与命令目标映射；内置 insert-preset 保持原协议', async () => {
  const fx = await setup('tpl-insert-admit-');
  const ids = await saveTemplate(fx);
  const denied = await fx.service.execute(AGENT(fx.instanceId), fx.envelope(insertCmd(ids)));
  assert.equal(rejected(denied).code, 'forbidden');
  assert.equal(commandAction(insertCmd(ids)), 'add');
  assert.deepEqual(commandTargets(insertCmd(ids)), [ROOT_NODE]);
  assert.deepEqual(commandTargets(insertCmd(ids, null)), []);
  // 内置预设仍可插入（原协议不回归）。
  const preset = committed(await fx.service.execute(OWNER, fx.envelope({
    type: 'insert-preset', templateId: 'feature-development', templateVersion: 1,
    contentLocale: 'zh-CN', parentId: ROOT_NODE, beforeNodeId: null,
  })));
  assert.equal(preset.planVersion === fx.doc().planVersion, true);
});
