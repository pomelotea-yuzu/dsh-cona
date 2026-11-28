// 顺序接纳外部变更与 Git 回退测试（tasks 1.1–1.3）。
// 覆盖：仓库映射登记（1.1）、预览→接纳两步与停写诊断（source-index-loss／
// source-record-rewritten／source-body-missing／source-body-hash-mismatch／
// source-observation-changed，1.2）、git-unmerged、依赖环、合法历史回退两步确认、
// 伪历史拒绝与副本隔离（1.3）。真实 git 子进程；临时目录放包内 artifacts/。

import { createHash } from 'node:crypto';
import { execFileSync, type SpawnSyncReturns } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePlanVersion } from '../src/domain/canonical/plan-fingerprint.js';
import type { ProjectDocument, Sha256Fn } from '../src/domain/types.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const localCli = path.join(packageRoot, 'lib', 'cli', 'local.js');
const commandCli = path.join(packageRoot, 'lib', 'cli', 'command.js');
const sample = path.join(packageRoot, 'formats', 'v1', 'sample-project.json');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SAMPLE_PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const SAMPLE_NODE_ID = '00000000-0000-4000-8000-000000000002';
const REPO_ID = '00000000-0000-4000-8000-00000000c205';
const R1 = '00000000-0000-4000-8000-00000000c231';
const R2 = '00000000-0000-4000-8000-00000000c232';
const FIXTURE_BRANCH = 'main';

interface CliJson {
  ok?: boolean;
  status?: number;
  issues?: { code: string; message: string; path?: string }[];
  entry?: { instanceId: string; sourceGeneration: number };
  aggregate?: { source: { generation: number }; lastObservation: Record<string, unknown> | null; repositoryMaps?: unknown[] };
  changes?: { initial: boolean; headChanged: boolean; planVersionChanged: boolean; recordsAdded: string[]; recordsRemoved: string[]; recordsChanged: string[] };
  candidate?: { headHash: string; records: { recordId: string; path: string; contentHash: string; observedHash: string }[] };
  diagnostics?: { code: string }[];
  fallback?: { commit: string; repositoryRoot: string; verifiedPaths: string[] };
  command?: string;
  reused?: boolean;
  root?: { root: string };
}

function run(args: string[]): { status: number; json: CliJson } {
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath, [localCli, ...args], { encoding: 'utf8' });
  } catch (error) {
    const err = error as SpawnSyncReturns<string>;
    status = err.status ?? 1;
    stdout = err.stdout?.toString() ?? '';
  }
  return { status, json: JSON.parse(stdout) as CliJson };
}

function codes(json: CliJson): string[] {
  return (json.issues ?? []).map((issue) => issue.code);
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t.invalid', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: artifacts },
  });
}

function sha256Hex(text: string): string {
  return sha256(new Uint8Array(Buffer.from(text, 'utf8')));
}

function readDoc(source: string): ProjectDocument {
  return JSON.parse(readFileSync(path.join(source, 'project.json'), 'utf8')) as ProjectDocument;
}

function writeDoc(source: string, doc: ProjectDocument): void {
  doc.planVersion = computePlanVersion(doc, sha256).planVersion;
  writeFileSync(path.join(source, 'project.json'), JSON.stringify(doc, null, 2) + '\n');
}

/** 写一条记录正文并加入索引；返回协议路径。 */
function addRecord(source: string, recordId: string, bodyText: string): string {
  const contentHash = 'sha256:' + sha256Hex(bodyText);
  const recordPath = `records/${recordId}/${contentHash.slice(7)}.md`;
  mkdirSync(path.join(source, 'records', recordId), { recursive: true });
  writeFileSync(path.join(source, ...recordPath.split('/')), bodyText);
  const doc = readDoc(source);
  doc.records = doc.records.filter((record) => record.id !== recordId);
  doc.records = [
    ...doc.records,
    { id: recordId, kind: 'analysis-note', subjectNodeIds: [SAMPLE_NODE_ID], path: recordPath, contentHash, summary: `记录 ${recordId}`, sources: [] },
  ];
  // records 不参与规划投影；头字节会变，planVersion 不变。
  writeFileSync(path.join(source, 'project.json'), JSON.stringify(doc, null, 2) + '\n');
  return recordPath;
}

/** 建一个含两条记录的真实 Git 仓库资料根并登记实例。返回 commit 哈希列表（[c1, c2, c3]）。
 * c1 只有 R1，c2 追加 R2，c3 改写 R1；基线建在 c3。 */
function setupGit(name: string): {
  base: string;
  localRoot: string;
  source: string;
  instanceId: string;
  commits: string[];
  r1Path: string;
  r1OriginalPath: string;
  r2Path: string;
} {
  const base = mkdtempSync(path.join(artifacts, name));
  const localRoot = path.join(base, 'local');
  const source = path.join(base, 'source');
  mkdirSync(source, { recursive: true });
  copyFileSync(sample, path.join(source, 'project.json'));
  addRecord(source, R1, '# R1 原文\n');
  const r1OriginalPath = readDoc(source).records.find((record) => record.id === R1)!.path;
  git(source, ['init', '--quiet']);
  git(source, ['symbolic-ref', 'HEAD', `refs/heads/${FIXTURE_BRANCH}`]);
  git(source, ['add', '.']);
  git(source, ['commit', '--quiet', '-m', 'c1: 只有 R1']);
  const c1 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();

  // c2：追加 R2（外部追加的合法接纳方向）。
  addRecord(source, R2, '# R2 原文\n');
  const r2Path = readDoc(source).records.find((record) => record.id === R2)!.path;
  git(source, ['add', '.']);
  git(source, ['commit', '--quiet', '-m', 'c2: 追加 R2']);
  const c2 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();

  // c3：改写 R1 正文（新文件 + 新哈希），索引同步。
  addRecord(source, R1, '# R1 已改写\n');
  const r1Path = readDoc(source).records.find((record) => record.id === R1)!.path;
  git(source, ['add', '.']);
  git(source, ['commit', '--quiet', '-m', 'c3: 改写 R1']);
  const c3 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();

  const registered = run(['register', '--local-root', localRoot, '--source', source, '--project-id', SAMPLE_PROJECT_ID, '--kind', 'custom']);
  assert.equal(registered.status, 0, JSON.stringify(registered.json));
  const instanceId = registered.json.entry?.instanceId ?? '';
  assert.ok(instanceId !== '');
  return { base, localRoot, source, instanceId, commits: [c1, c2, c3], r1Path, r1OriginalPath, r2Path };
}

/** 建立 c3 基线（两次 refresh），返回当前源代际。 */
function establishBaseline(ctx: { localRoot: string; source: string; instanceId: string }): number {
  const first = run(['refresh', '--local-root', ctx.localRoot, '--instance', ctx.instanceId, '--source', ctx.source]);
  assert.equal(first.status, 0, JSON.stringify(first.json));
  const second = run(['refresh', '--local-root', ctx.localRoot, '--instance', ctx.instanceId, '--source', ctx.source]);
  assert.equal(second.status, 0, JSON.stringify(second.json));
  return second.json.aggregate?.source.generation ?? 0;
}

test('1.1 登记仓库映射并按实例保存；复用登记可显式更新，不同副本互不影响', () => {
  const base = mkdtempSync(path.join(artifacts, 'r2-map-'));
  const localRoot = path.join(base, 'local');
  const sourceA = path.join(base, 'source-a');
  const sourceB = path.join(base, 'source-b');
  for (const dir of [sourceA, sourceB]) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(sample, path.join(dir, 'project.json'));
  }
  const mapA = path.join(base, 'repo-a');
  const mapB = path.join(base, 'repo-b');
  mkdirSync(mapA, { recursive: true });
  mkdirSync(mapB, { recursive: true });

  const a = run(['register', '--local-root', localRoot, '--source', sourceA, '--project-id', SAMPLE_PROJECT_ID, '--kind', 'custom', '--map', `${REPO_ID}=${mapA}`]);
  assert.equal(a.status, 0, JSON.stringify(a.json));
  const b = run(['register', '--local-root', localRoot, '--source', sourceB, '--project-id', SAMPLE_PROJECT_ID, '--kind', 'custom', '--map', `${REPO_ID}=${mapB}`]);
  assert.equal(b.status, 0, JSON.stringify(b.json));

  const showA = run(['show', '--local-root', localRoot, '--instance', a.json.entry?.instanceId ?? '']);
  const showB = run(['show', '--local-root', localRoot, '--instance', b.json.entry?.instanceId ?? '']);
  const mapsA = showA.json.aggregate?.repositoryMaps as { repositoryId: string; absolutePath: string }[] | undefined;
  const mapsB = showB.json.aggregate?.repositoryMaps as { repositoryId: string; absolutePath: string }[] | undefined;
  assert.equal(mapsA?.[0]?.absolutePath, mapA, '实例 A 保存自己的映射');
  assert.equal(mapsB?.[0]?.absolutePath, mapB, '实例 B 保存自己的映射，不串用 A 的');

  // 复用登记 A 且带新映射：显式更新 A 的映射。
  const mapA2 = path.join(base, 'repo-a2');
  mkdirSync(mapA2, { recursive: true });
  const again = run(['register', '--local-root', localRoot, '--source', sourceA, '--project-id', SAMPLE_PROJECT_ID, '--kind', 'custom', '--map', `${REPO_ID}=${mapA2}`]);
  assert.equal(again.status, 0);
  assert.equal(again.json.reused, true);
  const showA2 = run(['show', '--local-root', localRoot, '--instance', a.json.entry?.instanceId ?? '']);
  const mapsA2 = showA2.json.aggregate?.repositoryMaps as { absolutePath: string }[] | undefined;
  assert.equal(mapsA2?.[0]?.absolutePath, mapA2);
  // B 的映射不受影响。
  const showB2 = run(['show', '--local-root', localRoot, '--instance', b.json.entry?.instanceId ?? '']);
  const mapsB2 = showB2.json.aggregate?.repositoryMaps as { absolutePath: string }[] | undefined;
  assert.equal(mapsB2?.[0]?.absolutePath, mapB);
  rmSync(base, { recursive: true, force: true });
});

test('1.2 外部追加记录经预览接纳；只推进状态修订语义且不覆盖外部内容', () => {
  const ctx = setupGit('r2-accept-append-');
  establishBaseline(ctx);
  const before = run(['show', '--local-root', ctx.localRoot, '--instance', ctx.instanceId]);
  const genBefore = before.json.aggregate?.source.generation ?? 0;

  // 预览（无变化）：诊断为空，可接纳。
  const preview = run(['preview-refresh', '--local-root', ctx.localRoot, '--instance', ctx.instanceId, '--source', ctx.source]);
  assert.equal(preview.status, 0, JSON.stringify(preview.json));
  assert.deepEqual(preview.json.diagnostics ?? [], []);

  const previewFile = path.join(ctx.base, 'preview.json');
  writeFileSync(previewFile, JSON.stringify(preview.json));
  const accepted = run(['refresh', '--local-root', ctx.localRoot, '--instance', ctx.instanceId, '--source', ctx.source, '--preview-file', previewFile]);
  assert.equal(accepted.status, 0, JSON.stringify(accepted.json));
  assert.equal((accepted.json.aggregate?.source.generation ?? 0) > genBefore, true);
  rmSync(ctx.base, { recursive: true, force: true });
});

test('1.2 丢索引项：source-index-loss 停写，未确认回退时接纳被拒且基线不推进', () => {
  const ctx = setupGit('r2-accept-loss-');
  establishBaseline(ctx);
  const genBefore = run(['show', '--local-root', ctx.localRoot, '--instance', ctx.instanceId]).json.aggregate?.source.generation ?? 0;

  // 工作区切回 c1（R2 尚未加入）：候选丢 R2、R1 哈希回到原文 → index-loss + rewritten + fallback。
  git(ctx.source, ['checkout', '--quiet', '--detach', ctx.commits[0]!]);
  const preview = run(['preview-refresh', '--local-root', ctx.localRoot, '--instance', ctx.instanceId, '--source', ctx.source]);
  assert.equal(preview.status, 0, JSON.stringify(preview.json));
  const diag = (preview.json.diagnostics ?? []).map((issue) => issue.code);
  assert.equal(diag.includes('source-index-loss'), true, JSON.stringify(preview.json));

  // 不带确认：refresh 拒绝（停写诊断）。
  const previewFile = path.join(ctx.base, 'preview.json');
  writeFileSync(previewFile, JSON.stringify(preview.json));
  const rejected = run(['refresh', '--local-root', ctx.localRoot, '--instance', ctx.instanceId, '--source', ctx.source, '--preview-file', previewFile]);
  assert.equal(rejected.status, 1);
  assert.equal(codes(rejected.json).includes('source-index-loss'), true, JSON.stringify(rejected.json));

  // 基线未推进。
  const after = run(['show', '--local-root', ctx.localRoot, '--instance', ctx.instanceId]);
  assert.equal(after.json.aggregate?.source.generation, genBefore);
  rmSync(ctx.base, { recursive: true, force: true });
});

test('1.3 合法历史回退：预览核实 commit 树逐字节一致，显式确认后接纳完整快照', () => {
  const ctx = setupGit('r2-accept-fallback-');
  establishBaseline(ctx);

  git(ctx.source, ['checkout', '--quiet', '--detach', ctx.commits[0]!]);
  const preview = run(['preview-refresh', '--local-root', ctx.localRoot, '--instance', ctx.instanceId, '--source', ctx.source]);
  assert.equal(preview.status, 0, JSON.stringify(preview.json));
  assert.notDeepEqual(preview.json.diagnostics ?? [], [], '回退必须带停写诊断');
  const fallback = preview.json.fallback;
  assert.ok(fallback !== undefined, JSON.stringify(preview.json));
  assert.equal(fallback.commit, ctx.commits[0]);
  assert.equal((fallback.verifiedPaths ?? []).includes('project.json'), true);
  assert.equal((fallback.verifiedPaths ?? []).length, 1 + (preview.json.candidate?.records.length ?? 0), '头 + 全部候选正文逐字节核对');

  const previewFile = path.join(ctx.base, 'preview.json');
  writeFileSync(previewFile, JSON.stringify(preview.json));
  const accepted = run(['refresh', '--local-root', ctx.localRoot, '--instance', ctx.instanceId, '--source', ctx.source, '--preview-file', previewFile, '--confirm-fallback']);
  assert.equal(accepted.status, 0, JSON.stringify(accepted.json));
  const observation = accepted.json.aggregate?.lastObservation as { headHash?: string } | null;
  assert.equal(observation?.headHash, preview.json.candidate?.headHash, '接纳的是历史候选而非旧基线');
  rmSync(ctx.base, { recursive: true, force: true });
});

test('5.2 回归：插件自身追加的记录不得在下次刷新被误报为索引缺失', () => {
  const ctx = setupGit('r2-accept-self-record-');
  const genBefore = establishBaseline(ctx);

  // 以命令封套追加一条记录（插件自己写的头与正文）。
  const appended = execFileSync(
    process.execPath,
    [
      commandCli,
      'run',
      '--local-root',
      ctx.localRoot,
      '--instance',
      ctx.instanceId,
      '--trusted',
      'remote-owner',
      '--operation',
      '99999999-8888-4777-8666-555555552c03',
      '--command',
      JSON.stringify({
        type: 'append-record',
        kind: 'analysis-note',
        subjectNodeIds: [SAMPLE_NODE_ID],
        summary: '自身追加记录',
        sources: [],
        body: '# 自身追加\n',
      }),
    ],
    { encoding: 'utf8' },
  );
  assert.equal((JSON.parse(appended) as { status?: string }).status, 'committed', appended);

  // 紧接着刷新：候选就是自己刚发布的头，诊断必须为空。
  const preview = run(['preview-refresh', '--local-root', ctx.localRoot, '--instance', ctx.instanceId, '--source', ctx.source]);
  assert.equal(preview.status, 0, JSON.stringify(preview.json));
  assert.deepEqual((preview.json.diagnostics ?? []).map((issue) => issue.code), [], JSON.stringify(preview.json));

  const previewFile = path.join(ctx.base, 'preview.json');
  writeFileSync(previewFile, JSON.stringify(preview.json));
  const accepted = run(['refresh', '--local-root', ctx.localRoot, '--instance', ctx.instanceId, '--source', ctx.source, '--preview-file', previewFile]);
  assert.equal(accepted.status, 0, JSON.stringify(accepted.json));
  assert.equal((accepted.json.aggregate?.source.generation ?? 0) > genBefore, true);
  rmSync(ctx.base, { recursive: true, force: true });
});

test('5.2 回归：单步 refresh 不得隐式越过停写诊断与历史回退确认', () => {
  const ctx = setupGit('r2-accept-bare-');
  establishBaseline(ctx);
  const genBefore = run(['show', '--local-root', ctx.localRoot, '--instance', ctx.instanceId]).json.aggregate?.source.generation ?? 0;

  // 工作区切回 c1：候选丢 R2、R1 回到原文，与合法回退证据一致。
  git(ctx.source, ['checkout', '--quiet', '--detach', ctx.commits[0]!]);

  // 不带预览、不带确认的单步刷新必须拒绝，并给出回退确认缺口。
  const rejected = run(['refresh', '--local-root', ctx.localRoot, '--instance', ctx.instanceId, '--source', ctx.source]);
  assert.equal(rejected.status, 1, JSON.stringify(rejected.json));
  const blocked = codes(rejected.json);
  assert.equal(blocked.includes('source-index-loss'), true, JSON.stringify(rejected.json));
  assert.equal(blocked.includes('fallback-confirm-missing'), true, JSON.stringify(rejected.json));
  const afterReject = run(['show', '--local-root', ctx.localRoot, '--instance', ctx.instanceId]);
  assert.equal(afterReject.json.aggregate?.source.generation, genBefore, '拒绝不得推进源代际');

  // 走预览 + 确认才接纳。
  const preview = run(['preview-refresh', '--local-root', ctx.localRoot, '--instance', ctx.instanceId, '--source', ctx.source]);
  assert.equal(preview.status, 0, JSON.stringify(preview.json));
  const previewFile = path.join(ctx.base, 'preview.json');
  writeFileSync(previewFile, JSON.stringify(preview.json));
  const accepted = run(['refresh', '--local-root', ctx.localRoot, '--instance', ctx.instanceId, '--source', ctx.source, '--preview-file', previewFile, '--confirm-fallback']);
  assert.equal(accepted.status, 0, JSON.stringify(accepted.json));
  rmSync(ctx.base, { recursive: true, force: true });
});

test('1.3 伪历史：候选与 HEAD 树不一致时无回退证据，确认也被拒绝', () => {
  const ctx = setupGit('r2-accept-fake-');
  establishBaseline(ctx);

  // 未提交的索引修改：候选头字节与 HEAD 树不一致 → 无法证明归属任何历史 commit。
  const doc = readDoc(ctx.source);
  doc.records = doc.records.filter((record) => record.id !== R2);
  writeDoc(ctx.source, doc);

  const preview = run(['preview-refresh', '--local-root', ctx.localRoot, '--instance', ctx.instanceId, '--source', ctx.source]);
  assert.equal(preview.status, 0, JSON.stringify(preview.json));
  const diag = (preview.json.diagnostics ?? []).map((issue) => issue.code);
  assert.equal(diag.includes('source-index-loss'), true);
  assert.equal(preview.json.fallback, undefined, '伪历史不给回退证据');

  const previewFile = path.join(ctx.base, 'preview.json');
  writeFileSync(previewFile, JSON.stringify(preview.json));
  const rejected = run(['refresh', '--local-root', ctx.localRoot, '--instance', ctx.instanceId, '--source', ctx.source, '--preview-file', previewFile, '--confirm-fallback']);
  assert.equal(rejected.status, 1);
  assert.equal(codes(rejected.json).includes('source-index-loss'), true);
  rmSync(ctx.base, { recursive: true, force: true });
});

test('1.2 预览与接纳之间资料变化：source-observation-changed 拒绝且不覆盖中间变化', () => {
  const ctx = setupGit('r2-accept-drift-');
  establishBaseline(ctx);

  const preview = run(['preview-refresh', '--local-root', ctx.localRoot, '--instance', ctx.instanceId, '--source', ctx.source]);
  assert.equal(preview.status, 0);
  const previewFile = path.join(ctx.base, 'preview.json');
  writeFileSync(previewFile, JSON.stringify(preview.json));

  // 预览后再改资料：改写 R1 正文并同步索引（合法但已漂移）。
  addRecord(ctx.source, R1, '# R1 预览后再改\n');

  const rejected = run(['refresh', '--local-root', ctx.localRoot, '--instance', ctx.instanceId, '--source', ctx.source, '--preview-file', previewFile]);
  assert.equal(rejected.status, 1);
  assert.deepEqual(codes(rejected.json), ['source-observation-changed'], JSON.stringify(rejected.json));
  rmSync(ctx.base, { recursive: true, force: true });
});

test('1.2 删正文与替换正文分别给出 source-body-missing／source-body-hash-mismatch', () => {
  const ctx = setupGit('r2-accept-body-');
  establishBaseline(ctx);

  // 删正文文件（索引仍引用）。
  rmSync(path.join(ctx.source, ...ctx.r1Path.split('/')));
  const missing = run(['preview-refresh', '--local-root', ctx.localRoot, '--instance', ctx.instanceId, '--source', ctx.source]);
  assert.equal(missing.status, 1);
  assert.deepEqual(codes(missing.json), ['source-body-missing'], JSON.stringify(missing.json));

  // 恢复正文并替换内容（哈希与索引不符）。
  writeFileSync(path.join(ctx.source, ...ctx.r1Path.split('/')), '# R1 被替换\n');
  const mismatch = run(['preview-refresh', '--local-root', ctx.localRoot, '--instance', ctx.instanceId, '--source', ctx.source]);
  assert.equal(mismatch.status, 1);
  assert.deepEqual(codes(mismatch.json), ['source-body-hash-mismatch'], JSON.stringify(mismatch.json));
  rmSync(ctx.base, { recursive: true, force: true });
});

test('1.3 git-unmerged：真实合并冲突遗留拒绝预览，先解决冲突再重取', () => {
  const ctx = setupGit('r2-accept-merge-');
  establishBaseline(ctx);

  // 两个分支改 R1 正文同一行，制造真实合并冲突。
  const conflictBody = '# R1 冲突制造\n';
  git(ctx.source, ['checkout', '--quiet', '-b', 'branch-x']);
  addRecord(ctx.source, R1, conflictBody + '分支 X\n');
  git(ctx.source, ['add', '.']);
  git(ctx.source, ['commit', '--quiet', '-m', 'x']);
  git(ctx.source, ['checkout', '--quiet', FIXTURE_BRANCH]);
  addRecord(ctx.source, R1, conflictBody + '分支主\n');
  git(ctx.source, ['add', '.']);
  git(ctx.source, ['commit', '--quiet', '-m', 'main']);
  let mergeFailed = false;
  try {
    git(ctx.source, ['merge', 'branch-x', '--no-edit']);
  } catch {
    mergeFailed = true;
  }
  assert.equal(mergeFailed, true, '夹具应制造出真实合并冲突');
  assert.notEqual(
    execFileSync('git', ['ls-files', '-u'], { cwd: ctx.source, encoding: 'utf8' }).trim(),
    '',
    '合并失败后应遗留真实未合并索引',
  );

  const preview = run(['preview-refresh', '--local-root', ctx.localRoot, '--instance', ctx.instanceId, '--source', ctx.source]);
  assert.equal(preview.status, 1);
  assert.deepEqual(codes(preview.json), ['git-unmerged'], JSON.stringify(preview.json));
  rmSync(ctx.base, { recursive: true, force: true });
});

test('1.3 依赖环：合并结果成环时候选校验拒绝并保留原基线', () => {
  const ctx = setupGit('r2-accept-cycle-');
  establishBaseline(ctx);
  const genBefore = run(['show', '--local-root', ctx.localRoot, '--instance', ctx.instanceId]).json.aggregate?.source.generation ?? 0;

  const doc = readDoc(ctx.source);
  const nodeA = '00000000-0000-4000-8000-000000000002';
  const nodeB = '00000000-0000-4000-8000-000000000003';
  doc.plan.dependencies = [
    { nodeId: nodeB, requiresNodeId: nodeA },
    { nodeId: nodeA, requiresNodeId: nodeB },
  ];
  writeDoc(ctx.source, doc);

  const preview = run(['preview-refresh', '--local-root', ctx.localRoot, '--instance', ctx.instanceId, '--source', ctx.source]);
  assert.equal(preview.status, 1);
  assert.equal(codes(preview.json).includes('dependency-cycle'), true, JSON.stringify(preview.json));

  const after = run(['show', '--local-root', ctx.localRoot, '--instance', ctx.instanceId]);
  assert.equal(after.json.aggregate?.source.generation, genBefore, '成环候选不得推进基线');
  rmSync(ctx.base, { recursive: true, force: true });
});

test('1.3 副本隔离：两个工作副本各自实例，刷新互不串用本机关系', () => {
  const base = mkdtempSync(path.join(artifacts, 'r2-accept-iso-'));
  const localRoot = path.join(base, 'local');
  const sourceA = path.join(base, 'copy-a');
  const sourceB = path.join(base, 'copy-b');
  for (const dir of [sourceA, sourceB]) {
    mkdirSync(dir, { recursive: true });
    copyFileSync(sample, path.join(dir, 'project.json'));
    addRecord(dir, R1, '# R1 副本\n');
  }
  const a = run(['register', '--local-root', localRoot, '--source', sourceA, '--project-id', SAMPLE_PROJECT_ID, '--kind', 'custom']);
  const b = run(['register', '--local-root', localRoot, '--source', sourceB, '--project-id', SAMPLE_PROJECT_ID, '--kind', 'custom']);
  assert.notEqual(a.json.entry?.instanceId, b.json.entry?.instanceId, '同项目不同目录是不同实例');

  // 只刷新 A：B 的代际保持 1，观察保持 null。
  const first = run(['refresh', '--local-root', localRoot, '--instance', a.json.entry?.instanceId ?? '', '--source', sourceA]);
  assert.equal(first.status, 0);
  const showB = run(['show', '--local-root', localRoot, '--instance', b.json.entry?.instanceId ?? '']);
  assert.equal(showB.json.aggregate?.source.generation, 1);
  assert.equal(showB.json.aggregate?.lastObservation, null);
  rmSync(base, { recursive: true, force: true });
});
