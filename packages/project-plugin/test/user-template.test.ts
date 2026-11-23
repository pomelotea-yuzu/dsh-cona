// 用户流程模板的保存与读取（tasks 2.4，design §2「用户模板目录与版本」）。
// A 层：正文正反例、子树抽取只含模板化内容、摘要前缀与记录分类；
// F 层：真实文件后端发布两次只推进状态修订、v1 回读、异步目录与三元组精确读取、
//       损坏/孤立/不支持版本不进目录、owner 准入与 agent 直达拒绝。

import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
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
import {
  USER_TEMPLATE_SUMMARY_PREFIX,
  buildUserTemplateText,
  extractSubtreeTemplate,
  internalDependencies,
  parseUserTemplateText,
  validateUserTemplateBody,
  type UserTemplateBody,
} from '../src/domain/user-template.js';
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
  doc: () => ProjectDocument;
  envelope: (command: Command, overrides?: Partial<CommandEnvelope>) => CommandEnvelope;
  aggregate: () => Record<string, any>;
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
    git: { inspect: inspectPrivateRoot }, store, clock, newInstanceId: () => randomUUID(),
  });
  const registered = await localState.register({
    localDataRoot: localRoot, sourceRoot: source, sourceKind: 'custom', projectId: PROJECT_ID,
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  if (!registered.ok) throw new Error('register failed');
  const instanceId = registered.entry.instanceId;
  const service = new ProjectCommandService({
    localRoot, store, files, sha256, clock, newNodeId: nextNodeId, newRecordId: () => randomUUID(),
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
    base, localRoot, source, instanceId, service, doc, envelope,
    aggregate: () => JSON.parse(readFileSync(path.join(localRoot, 'instances', instanceId, 'state.json'), 'utf8')) as Record<string, any>,
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
const saveCmd = (templateId: string, title: string, bodyLanguage: string, rootNodeId: string = ROOT_NODE): Command => ({
  type: 'save-user-template', templateId, title, bodyLanguage, rootNodeId,
});

// ---- 领域层：正文协议正反例与子树抽取 ----

test('2.4 正文构造/解析往返，严格拒绝未知版本、额外字段、非法语言、重复键与非单根', () => {
  const body: UserTemplateBody = {
    version: 1, templateId: randomUUID(), title: '单语言原文', bodyLanguage: 'zh-CN',
    nodes: [
      { key: 'n0', parentKey: null, order: 0, title: '根', goal: '目标', completionCriteria: [] },
      { key: 'n1', parentKey: 'n0', order: 0, title: '子', goal: '子目标', completionCriteria: ['条件'] },
    ],
    dependencies: [{ nodeKey: 'n1', requiresKey: 'n0' }],
  };
  assert.equal(validateUserTemplateBody(body).ok, true);
  const text = buildUserTemplateText(body);
  assert.ok(text.startsWith('<!-- cona:template v1 -->'));
  const parsed = parseUserTemplateText(text);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.body, body, '往返保留作者原文与结构');

  const invalid = (patch: (b: any) => void): boolean => {
    const b = JSON.parse(JSON.stringify(body)) as any;
    patch(b);
    return validateUserTemplateBody(b).ok === false;
  };
  assert.equal(invalid((b) => { b.version = 2; }), true, '未知版本');
  assert.equal(invalid((b) => { b.author = 'x'; }), true, '额外字段');
  assert.equal(invalid((b) => { b.bodyLanguage = 'zh_CN'; }), true, '非法语言标签');
  assert.equal(invalid((b) => { b.nodes[1].key = 'n0'; }), true, '重复键');
  assert.equal(invalid((b) => { b.nodes[1].parentKey = null; }), true, '非单根');
  assert.equal(invalid((b) => { b.dependencies.push({ nodeKey: 'n0', requiresKey: 'n1' }); }), true, '依赖成环');
  assert.equal(invalid((b) => { b.nodes[1].parentKey = 'nope'; }), true, '父键不存在');
  // 正文缺版本首行或 json 围栏都拒绝。
  assert.equal(parseUserTemplateText(text.replace('<!-- cona:template v1 -->', '<!-- other -->')).ok, false);
  assert.equal(parseUserTemplateText(text.replace('```json', '```text')).ok, false);
});

test('2.4 子树抽取只用局部键、省略对外依赖、原节点身份不进正文', () => {
  const doc = JSON.parse(readFileSync(sample, 'utf8')) as ProjectDocument;
  const extracted = extractSubtreeTemplate(doc.plan, ROOT_NODE);
  const json = JSON.stringify(extracted.nodes);
  assert.equal(json.includes(ROOT_NODE), false, '根身份不进正文');
  assert.equal(json.includes(CHILD_NODE), false, '子节点身份不进正文');
  assert.deepEqual(extracted.nodes.map((n) => n.key), ['n0', 'n1']);
  assert.equal(extracted.nodes[0]?.parentKey, null);
  assert.equal(extracted.nodes[1]?.parentKey, 'n0');
  const deps = internalDependencies(doc.plan, extracted.keyOf);
  // sample 的 CHILD→ROOT 是子树内部依赖，按局部键映射。
  assert.deepEqual(deps, [{ nodeKey: 'n1', requiresKey: 'n0' }]);
  // 对外依赖：端点不在 keyOf 的边被省略。
  const external = internalDependencies({ ...doc.plan, dependencies: [
    ...doc.plan.dependencies, { nodeId: CHILD_NODE, requiresNodeId: randomUUID() },
  ] }, extracted.keyOf);
  assert.equal(external.length, 1, '对外依赖被省略');
  // 未知根返回空。
  assert.deepEqual(extractSubtreeTemplate(doc.plan, randomUUID()).nodes, []);
});

// ---- 服务与文件后端 ----

test('2.4 保存两版：plan-change 摘要前缀、单次状态修订、planVersion 与规划修订不变、v1 回读', async () => {
  const fx = await setup('tpl-save-');
  const versionBefore = fx.doc().planVersion;
  const t1 = randomUUID(); const t2 = randomUUID();
  const r1 = committed(await fx.service.execute(OWNER, fx.envelope(saveCmd(t1, '原文一', 'zh-CN'))));
  assert.ok(r1.recordId, '模板作为记录发布');
  assert.equal(fx.aggregate().revisions.plan, 0, '规划修订不变');
  assert.equal(fx.aggregate().revisions.state, 1, '只推进状态修订');
  assert.equal(fx.doc().planVersion, versionBefore, 'planVersion 不变');
  const rec1 = fx.doc().records.find((r) => r.id === r1.recordId);
  assert.ok(rec1?.summary.startsWith(USER_TEMPLATE_SUMMARY_PREFIX));
  assert.equal(rec1?.kind, 'plan-change');
  assert.deepEqual(rec1?.subjectNodeIds, [], '模板记录不针对具体节点');
  const body1 = readFileSync(path.join(fx.source, rec1!.path), 'utf8');
  assert.equal(parseUserTemplateText(body1).ok, true);
  assert.equal(JSON.stringify(body1).includes(ROOT_NODE), false, '公开正文不含项目节点身份');
  assert.equal(validateProjectDocument(fx.doc(), { sha256 }).ok, true, 'v1 校验器回读');

  const prevPlan = fx.doc().planVersion;
  const r2 = committed(await fx.service.execute(OWNER, fx.envelope(saveCmd(t2, '原文二', 'en'))));
  assert.equal(fx.aggregate().revisions.plan, 0, '第二版仍不推进规划修订');
  assert.equal(fx.aggregate().revisions.state, 2, '第二版再推进一次状态修订');
  assert.equal(fx.doc().planVersion, prevPlan);
  const rec2 = fx.doc().records.find((r) => r.id === r2.recordId);
  const body2 = readFileSync(path.join(fx.source, rec2!.path), 'utf8');
  assert.equal((parseUserTemplateText(body2) as any).body.bodyLanguage, 'en', '第二版保留作者原文');
});

test('2.4 目录与三元组精确读取；损坏、孤立与不支持版本不进目录', async () => {
  const fx = await setup('tpl-list-');
  const t1 = randomUUID();
  const r1 = committed(await fx.service.execute(OWNER, fx.envelope(saveCmd(t1, '目录标题', 'zh-CN'))));
  const rec = fx.doc().records.find((r) => r.id === r1.recordId)!;

  const list = await fx.service.listUserTemplates(OWNER, { instanceId: fx.instanceId });
  assert.equal(list.status, 'committed');
  if (list.status !== 'committed') return;
  assert.equal(list.templates.length, 1);
  const descriptor = list.templates[0]!;
  assert.equal(descriptor.source, 'user');
  assert.equal(descriptor.templateId, t1);
  assert.equal(descriptor.versionRecordId, r1.recordId);
  assert.equal(descriptor.contentHash, rec.contentHash);
  assert.equal(descriptor.title, '目录标题');
  assert.equal(descriptor.bodyLanguage, 'zh-CN');

  const got = await fx.service.getUserTemplate(OWNER, {
    instanceId: fx.instanceId, templateId: t1, versionRecordId: rec.id, contentHash: rec.contentHash,
  });
  assert.equal(got.status, 'committed');
  if (got.status !== 'committed') return;
  assert.equal(got.body.title, '目录标题');
  assert.equal(got.body.bodyLanguage, 'zh-CN', '作者原文不随 UI 语言变化');

  // 三元组任一不符 → 不可用；不回退近似版本。
  const wrong = await fx.service.getUserTemplate(OWNER, {
    instanceId: fx.instanceId, templateId: t1, versionRecordId: rec.id, contentHash: 'sha256:' + '0'.repeat(64),
  });
  assert.equal(wrong.status, 'rejected');
  assert.equal((wrong as any).code, 'template-version-unavailable');

  // 注入一条损坏正文的记录（正文与索引哈希不符）与一条孤立记录（正文文件不存在）。
  // path 保持 records/<id>/<hash-hex>.md 形状，避免被 v1 校验器当作路径错误拒绝。
  const { writeFileSync, mkdirSync: mk } = await import('node:fs');
  const doc = fx.doc();
  const brokenId = randomUUID();
  const brokenHash = 'sha256:' + '1'.repeat(64);
  doc.records.push({
    id: brokenId, kind: 'plan-change', subjectNodeIds: [],
    path: `records/${brokenId}/${'1'.repeat(64)}.md`, contentHash: brokenHash,
    summary: USER_TEMPLATE_SUMMARY_PREFIX + '损坏', sources: [],
  });
  const orphanId = randomUUID();
  doc.records.push({
    id: orphanId, kind: 'plan-change', subjectNodeIds: [],
    path: `records/${orphanId}/${'2'.repeat(64)}.md`, contentHash: 'sha256:' + '2'.repeat(64),
    summary: USER_TEMPLATE_SUMMARY_PREFIX + '孤立', sources: [],
  });
  writeFileSync(path.join(fx.source, 'project.json'), JSON.stringify(doc));
  mk(path.join(fx.source, 'records', brokenId), { recursive: true });
  writeFileSync(path.join(fx.source, 'records', brokenId, `${'1'.repeat(64)}.md`), '不是模板正文且哈希不符');
  const after = await fx.service.listUserTemplates(OWNER, { instanceId: fx.instanceId });
  assert.equal(after.status, 'committed');
  if (after.status !== 'committed') return;
  assert.equal(after.templates.length, 1, '损坏与孤立记录被过滤');
  assert.equal(after.templates[0]?.versionRecordId, r1.recordId);
});

test('2.4 owner 可保存模板，agent 直达与错误子树根被拒', async () => {
  const fx = await setup('tpl-admit-');
  const t1 = randomUUID();
  const denied = await fx.service.execute(AGENT(fx.instanceId), fx.envelope(saveCmd(t1, '直连', 'zh-CN')));
  assert.equal(rejected(denied).code, 'forbidden');
  const missing = await fx.service.execute(OWNER, fx.envelope(saveCmd(t1, '无根', 'zh-CN', randomUUID())));
  assert.equal(rejected(missing).code, 'node-not-found');
  const invalid = await fx.service.execute(OWNER, fx.envelope(saveCmd(randomUUID(), '空白', 'zh-CN')));
  assert.equal(invalid.status, 'committed', '空白标题以外字段合法');
  // 空标题在预览层即被拒（正文构造校验）。
  const preview = await fx.service.previewUserTemplate(OWNER, {
    templateId: randomUUID(), title: '  ', bodyLanguage: 'zh-CN',
    rootNodeId: ROOT_NODE, instanceId: fx.instanceId,
  });
  assert.equal(preview.status, 'rejected');
  assert.equal((preview as any).code, 'template-invalid');
  assert.equal(fx.aggregate().revisions.state, 1, '拒绝的请求不推进修订');
});
