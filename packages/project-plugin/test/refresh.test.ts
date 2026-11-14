// 完整基线与显式刷新测试（tasks 3.5）。
// 覆盖：首次建立基线、无变化刷新、外部追加记录、仅排版变化、未知 schema、冲突标记、
// 非法树、正文哈希不符、同路径身份变化；均以磁盘为准，不复用旧缓存。
// 临时目录放在包内 artifacts/。

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePlanVersion } from '../src/domain/canonical/plan-fingerprint.js';
import type { ProjectDocument, Sha256Fn } from '../src/domain/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const localCli = path.join(packageRoot, 'lib', 'cli', 'local.js');
const sample = path.join(packageRoot, 'formats', 'v1', 'sample-project.json');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SAMPLE_PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const SAMPLE_NODE_ID = '00000000-0000-4000-8000-000000000002';
const OTHER_PROJECT_ID = '66666666-6666-4666-8666-666666666666';
const RECORD_ID = '77777777-7777-4777-8777-777777777777';

function run(cli: string, args: string[]): { status: number; json: Record<string, unknown> } {
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    status = err.status ?? 1;
    stdout = err.stdout ?? '';
  }
  return { status, json: JSON.parse(stdout) as Record<string, unknown> };
}

interface RefreshResult {
  ok: boolean;
  changes?: {
    initial: boolean;
    headChanged: boolean;
    planVersionChanged: boolean;
    recordsAdded: string[];
    recordsRemoved: string[];
    recordsChanged: string[];
  };
  aggregate?: {
    source: { generation: number };
    lastObservation: { planVersion: string; headHash: string; records: { path: string }[]; observedAt: string } | null;
  };
  entry?: { sourceGeneration: number };
  issues?: { code: string; message: string }[];
}

function codes(result: RefreshResult): string[] {
  return (result.issues ?? []).map((issue) => issue.code);
}

function setup(name: string): { base: string; localRoot: string; source: string; instanceId: string } {
  const base = mkdtempSync(path.join(artifacts, name));
  const localRoot = path.join(base, 'local');
  const source = path.join(base, 'source');
  mkdirSync(source, { recursive: true });
  copyFileSync(sample, path.join(source, 'project.json'));

  const registered = run(localCli, [
    'register',
    '--local-root', localRoot,
    '--source', source,
    '--project-id', SAMPLE_PROJECT_ID,
    '--kind', 'custom',
  ]);
  assert.equal(registered.status, 0, JSON.stringify(registered.json));
  const entry = (registered.json as { entry?: { instanceId: string } }).entry;
  assert.ok(entry !== undefined);
  return { base, localRoot, source, instanceId: entry.instanceId };
}

function refresh(ctx: { localRoot: string; source: string; instanceId: string }): { status: number; json: RefreshResult } {
  const result = run(localCli, [
    'refresh',
    '--local-root', ctx.localRoot,
    '--instance', ctx.instanceId,
    '--source', ctx.source,
  ]);
  return { status: result.status, json: result.json as unknown as RefreshResult };
}

function readDoc(source: string): ProjectDocument {
  return JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as ProjectDocument;
}

function writeDoc(source: string, doc: ProjectDocument, indent = 2): void {
  doc.planVersion = computePlanVersion(doc, sha256).planVersion;
  writeFileSync(path.join(source, 'project.json'), JSON.stringify(doc, null, indent) + '\n');
}

function appendExternalRecord(source: string, bodyText: string): string {
  const body = Buffer.from(bodyText, 'utf8');
  const contentHash = 'sha256:' + sha256(new Uint8Array(body));
  const recordPath = `records/${RECORD_ID}/${contentHash.slice(7)}.md`;
  mkdirSync(path.join(source, 'records', RECORD_ID), { recursive: true });
  writeFileSync(path.join(source, ...recordPath.split('/')), body);

  const doc = readDoc(source);
  doc.records = [
    ...doc.records,
    {
      id: RECORD_ID,
      kind: 'analysis-note',
      subjectNodeIds: [SAMPLE_NODE_ID],
      path: recordPath,
      contentHash,
      summary: '外部追加',
      sources: [],
    },
  ];
  // records 不参与规划投影：planVersion 不变，但头字节会变。
  writeFileSync(path.join(source, 'project.json'), JSON.stringify(doc, null, 2) + '\n');
  return recordPath;
}

test('刷新：首次建立完整基线，源代际推进且不覆盖注册身份', () => {
  const ctx = setup('refresh-first-');
  const first = refresh(ctx);
  assert.equal(first.status, 0, JSON.stringify(first.json));
  const changes = first.json.changes;
  assert.equal(changes?.initial, true);
  assert.equal(changes?.headChanged, true);
  assert.equal(changes?.planVersionChanged, true);
  assert.deepEqual(changes?.recordsAdded, []);
  assert.match(first.json.aggregate?.lastObservation?.headHash ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.json.aggregate?.lastObservation?.planVersion, first.json.aggregate?.lastObservation?.planVersion);
  assert.equal(first.json.aggregate?.source.generation, 2);
  assert.equal(first.json.entry?.sourceGeneration, 2);

  const second = refresh(ctx);
  assert.equal(second.status, 0, JSON.stringify(second.json));
  assert.equal(second.json.changes?.initial, false);
  assert.equal(second.json.changes?.headChanged, false);
  assert.equal(second.json.changes?.planVersionChanged, false);
  assert.equal(second.json.aggregate?.source.generation, 3);
});

test('刷新：外部顺序追加记录被接纳，且不被旧缓存覆盖', () => {
  const ctx = setup('refresh-append-');
  assert.equal(refresh(ctx).status, 0);

  const recordPath = appendExternalRecord(ctx.source, '# 外部追加的分析\n');
  const afterAppend = refresh(ctx);
  assert.equal(afterAppend.status, 0, JSON.stringify(afterAppend.json));
  assert.equal(afterAppend.json.changes?.headChanged, true);
  assert.equal(afterAppend.json.changes?.planVersionChanged, false, '记录追加不改变规划指纹');
  assert.deepEqual(afterAppend.json.changes?.recordsAdded, [recordPath]);
  assert.equal(afterAppend.json.aggregate?.lastObservation?.records.length, 1);

  // 再刷新：磁盘未变，不应把旧基线重新算成“新增”。
  const repeat = refresh(ctx);
  assert.equal(repeat.status, 0);
  assert.deepEqual(repeat.json.changes?.recordsAdded, []);
  assert.equal(repeat.json.aggregate?.lastObservation?.records.length, 1);
});

test('刷新：仅排版变化时头字节变而规划指纹不变', () => {
  const ctx = setup('refresh-indent-');
  assert.equal(refresh(ctx).status, 0);

  const doc = readDoc(ctx.source);
  writeFileSync(path.join(ctx.source, 'project.json'), JSON.stringify(doc, null, 4) + '\n');
  const result = refresh(ctx);
  assert.equal(result.status, 0, JSON.stringify(result.json));
  assert.equal(result.json.changes?.headChanged, true);
  assert.equal(result.json.changes?.planVersionChanged, false);
});

test('刷新：未知 schema、冲突标记与非法树都拒绝，且不改本机基线', () => {
  const ctx = setup('refresh-reject-');
  const first = refresh(ctx);
  assert.equal(first.status, 0);
  const generation = first.json.aggregate?.source.generation;

  // 未知 schema：schemaVersion 2。
  const doc = readDoc(ctx.source);
  writeFileSync(
    path.join(ctx.source, 'project.json'),
    JSON.stringify({ ...doc, schemaVersion: 2 }, null, 2) + '\n',
  );
  const unsupported = refresh(ctx);
  assert.equal(unsupported.status, 1);
  assert.equal(codes(unsupported.json).includes('invalid-schema-version'), true, JSON.stringify(unsupported.json));

  // 冲突标记：行首 `<<<<<<<`。
  writeFileSync(path.join(ctx.source, 'project.json'), readFileSync(sample, 'utf8') + '<<<<<<< HEAD\n');
  const conflicted = refresh(ctx);
  assert.equal(conflicted.status, 1);
  assert.deepEqual(codes(conflicted.json), ['source-conflict-markers']);

  // 非法树：父节点不存在（先把上一步的冲突标记文件恢复为合法 JSON）。
  copyFileSync(sample, path.join(ctx.source, 'project.json'));
  const broken = readDoc(ctx.source);
  broken.plan.nodes[1]!.parentId = '00000000-0000-4000-8000-00000000ffff';
  writeDoc(ctx.source, broken);
  const invalid = refresh(ctx);
  assert.equal(invalid.status, 1);
  assert.equal(codes(invalid.json).includes('parent-not-found'), true, JSON.stringify(invalid.json));

  // 三次失败都不得推进基线。
  const shown = run(localCli, ['show', '--local-root', ctx.localRoot, '--instance', ctx.instanceId]);
  assert.equal(shown.status, 0);
  const aggregate = (shown.json as { aggregate?: { source: { generation: number } } }).aggregate;
  assert.equal(aggregate?.source.generation, generation);
});

test('刷新：正文哈希不符拒绝，不把被改写的正文当成基线', () => {
  const ctx = setup('refresh-body-');
  const recordPath = appendExternalRecord(ctx.source, '# 正文\n');
  assert.equal(refresh(ctx).status, 0);

  writeFileSync(path.join(ctx.source, ...recordPath.split('/')), '# 被改写\n');
  const result = refresh(ctx);
  assert.equal(result.status, 1);
  assert.deepEqual(codes(result.json), ['body-hash-mismatch']);
});

test('刷新：同一路径项目身份变化拒绝，注册表与基线不变', () => {
  const ctx = setup('refresh-identity-');
  assert.equal(refresh(ctx).status, 0);

  const doc = readDoc(ctx.source);
  doc.project.id = OTHER_PROJECT_ID;
  writeDoc(ctx.source, doc);

  const result = refresh(ctx);
  assert.equal(result.status, 1);
  assert.deepEqual(codes(result.json), ['source-identity-changed']);

  const registry = JSON.parse(readFileSync(path.join(ctx.localRoot, 'registry.json'), 'utf8')) as {
    instances: { projectId: string; sourceGeneration: number }[];
  };
  assert.equal(registry.instances[0]?.projectId, SAMPLE_PROJECT_ID);
  assert.equal(registry.instances[0]?.sourceGeneration, 2, '失败刷新不得推进源代际');
});
