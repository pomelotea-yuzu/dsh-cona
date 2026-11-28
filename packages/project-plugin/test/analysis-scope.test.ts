// 第 3 组（tasks 3.1-3.5）真实文件测试：仓库映射冻结、范围预览、枚举指纹、
// 集中限额、范围内读取与引用凭证。临时目录放在包内 artifacts/；Git 用例只在
// git 可用时运行，并固定初始分支以兼容 CI。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnalysisScopeService, type AnalysisRepositoryMapping } from '../src/application/analysis-scope.js';
import type { AnalysisLimits } from '../src/domain/analysis.js';
import { createAnalysisFiles } from '../src/adapters/fs/analysis-files.js';
import { ReadBudget, DEFAULT_ANALYSIS_LIMITS } from '../src/domain/analysis.js';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const files = createAnalysisFiles({ sha256, env: { GIT_CEILING_DIRECTORIES: artifacts } });
const clock = (): string => '2026-11-28T00:00:00.000Z';

function writeFile(root: string, relativePath: string, content: string | Uint8Array): void {
  const absolute = path.join(root, relativePath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function service(
  instanceId: string,
  repositories: AnalysisRepositoryMapping[],
  sourceGeneration = 1,
  limits?: Partial<AnalysisLimits>,
): AnalysisScopeService {
  return new AnalysisScopeService({
    instanceId,
    sourceGeneration,
    repositories: async () => repositories,
    files,
    sha256,
    clock,
    ...(limits === undefined ? {} : { limits }),
  });
}

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: artifacts };
  execFileSync('git', ['init', '--quiet'], { cwd: dir, env });
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: dir, env });
  return dir;
}

function commitAll(dir: string, message = 'commit'): void {
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: artifacts };
  execFileSync('git', ['add', '-A'], { cwd: dir, env });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', message], { cwd: dir, env });
}

test('3.1 仓库映射：双工作副本各自可选，冻结身份不串根', async () => {
  const base = mkdtempSync(path.join(artifacts, 'analysis-repos-'));
  const rootA = path.join(base, 'copy-a');
  const rootB = path.join(base, 'copy-b');
  writeFile(rootA, 'a.txt', 'copy a\n');
  writeFile(rootB, 'b.txt', 'copy b\n');
  const maps: AnalysisRepositoryMapping[] = [
    { repositoryId: 'repo-a', absolutePath: rootA, updatedAt: '2026-11-28T00:00:00.000Z' },
    { repositoryId: 'repo-b', absolutePath: rootB, updatedAt: '2026-11-28T00:00:00.000Z' },
    { repositoryId: 'repo-missing', absolutePath: path.join(base, 'missing'), updatedAt: '2026-11-28T00:00:00.000Z' },
  ];
  const svc = service('inst-1', maps);

  const repositories = await svc.listRepositories();
  assert.deepEqual(repositories.map((item) => [item.repositoryId, item.status]), [
    ['repo-a', 'available'],
    ['repo-b', 'available'],
    ['repo-missing', 'unavailable'],
  ]);
  assert.equal(repositories[2]?.reason, 'analysis-repository-missing');

  const previewA = await svc.preview({ repositoryId: 'repo-a', scope: { kind: 'root' } });
  assert.equal(previewA.status, 'ok');
  if (previewA.status !== 'ok') return;
  assert.deepEqual(previewA.entries.map((entry) => entry.path), ['a.txt']);
  assert.equal(previewA.repository.repositoryId, 'repo-a');

  const previewB = await svc.preview({ repositoryId: 'repo-b', scope: { kind: 'root' } });
  assert.equal(previewB.status, 'ok');
  if (previewB.status !== 'ok') return;
  assert.deepEqual(previewB.entries.map((entry) => entry.path), ['b.txt']);

  // 同一实例的另一副本不能顶替冻结的仓库根。
  const moved = maps.map((map) => map.repositoryId === 'repo-a' ? { ...map, absolutePath: rootB } : map);
  const movedService = service('inst-1', moved);
  const drifted = await movedService.observe(previewA.selection);
  assert.equal(drifted.status, 'rejected');
  if (drifted.status === 'rejected') assert.equal(drifted.code, 'analysis-mapping-changed');

  const newGeneration = service('inst-1', maps, 2);
  const stale = await newGeneration.observe(previewA.selection);
  assert.equal(stale.status, 'rejected');
  if (stale.status === 'rejected') assert.equal(stale.code, 'analysis-source-changed');

  const missing = await svc.preview({ repositoryId: 'repo-missing', scope: { kind: 'root' } });
  assert.equal(missing.status, 'rejected');
  if (missing.status === 'rejected') assert.equal(missing.code, 'analysis-repository-missing');

  // 映射提供者在同一服务内变化（本机登记更新）也要让旧选择失效。
  maps[0] = { ...maps[0]!, absolutePath: rootB };
  const refreshed = await svc.observe(previewA.selection);
  assert.equal(refreshed.status, 'rejected');
  if (refreshed.status === 'rejected') assert.equal(refreshed.code, 'analysis-mapping-changed');
});

test('3.2 范围预览：仓库根/目录/文件与越界、兄弟前缀、链接和类型', async () => {
  const base = mkdtempSync(path.join(artifacts, 'analysis-preview-'));
  const repo = path.join(base, 'repo');
  writeFile(repo, 'src/a.ts', 'a\n');
  writeFile(repo, 'src/nested/b.ts', 'b\n');
  writeFile(repo, 'src2/c.ts', 'c\n');
  writeFile(repo, 'docs/readme.md', 'd\n');
  symlinkSync(path.join(repo, 'src', 'a.ts'), path.join(repo, 'link.ts'));
  const svc = service('inst-1', [{ repositoryId: 'repo', absolutePath: repo }]);

  const directory = await svc.preview({ repositoryId: 'repo', scope: { kind: 'directory', path: 'src' } });
  assert.equal(directory.status, 'ok');
  if (directory.status !== 'ok') return;
  assert.deepEqual(directory.entries.map((entry) => entry.path), ['src/a.ts', 'src/nested/b.ts']);
  assert.equal(directory.entries.some((entry) => entry.path.startsWith('src2/')), false);

  const single = await svc.preview({ repositoryId: 'repo', scope: { kind: 'file', path: 'src/a.ts' } });
  assert.equal(single.status, 'ok');
  if (single.status !== 'ok') return;
  assert.equal(single.entries.length, 1);

  const root = await svc.preview({ repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(root.status, 'ok');
  if (root.status !== 'ok') return;
  assert.deepEqual(root.entries.map((entry) => entry.path), [
    'docs/readme.md', 'src/a.ts', 'src/nested/b.ts', 'src2/c.ts',
  ]);
  assert.deepEqual(root.exclusions, [{ path: 'link.ts', reason: 'symlink' }]);

  const escape = await svc.preview({ repositoryId: 'repo', scope: { kind: 'file', path: '../outside.txt' } });
  assert.equal(escape.status, 'rejected');
  if (escape.status === 'rejected') assert.match(escape.code, /analysis-path-dot-segment/);

  const absolute = await svc.preview({ repositoryId: 'repo', scope: { kind: 'file', path: '/etc/passwd' } });
  assert.equal(absolute.status, 'rejected');
  if (absolute.status === 'rejected') assert.match(absolute.code, /analysis-path-absolute/);

  const link = await svc.preview({ repositoryId: 'repo', scope: { kind: 'file', path: 'link.ts' } });
  assert.equal(link.status, 'rejected');
  if (link.status === 'rejected') assert.equal(link.code, 'scope-symlink');

  // 逐段检查：中间段是符号链接同样拒绝，不跟随到真实目录。
  symlinkSync(path.join(repo, 'src'), path.join(repo, 'src-link'));
  const segment = await svc.preview({ repositoryId: 'repo', scope: { kind: 'file', path: 'src-link/a.ts' } });
  assert.equal(segment.status, 'rejected');
  if (segment.status === 'rejected') assert.equal(segment.code, 'scope-symlink');

  const directoryAsFile = await svc.preview({ repositoryId: 'repo', scope: { kind: 'file', path: 'docs' } });
  assert.equal(directoryAsFile.status, 'rejected');
  if (directoryAsFile.status === 'rejected') assert.equal(directoryAsFile.code, 'scope-not-regular-file');

  const invalidMap = await service('inst-1', [{ repositoryId: 'repo', absolutePath: path.join(base, 'absent') }])
    .preview({ repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(invalidMap.status, 'rejected');
  if (invalidMap.status === 'rejected') assert.equal(invalidMap.code, 'analysis-repository-missing');
});

test('3.3 枚举与指纹：稳定顺序、Git 内部/忽略排除、同一 HEAD 变化可辨', async () => {
  if (!gitAvailable()) return;
  const base = mkdtempSync(path.join(artifacts, 'analysis-enum-'));
  const repo = initRepo(path.join(base, 'repo'));
  writeFile(repo, '.gitignore', 'ignored/\n*.log\n');
  writeFile(repo, 'ignored/x.txt', 'ignored\n');
  writeFile(repo, 'debug.log', 'debug\n');
  writeFile(repo, 'tracked.log', 'tracked despite ignore\n');
  writeFile(repo, 'src/a.ts', 'a\n');
  writeFile(repo, 'src/b.ts', 'b\n');
  writeFile(repo, 'src/z.ts', 'z\n');
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: artifacts };
  execFileSync('git', ['add', '-f', 'tracked.log'], { cwd: repo, env });
  commitAll(repo, 'init');

  const svc = service('inst-1', [{ repositoryId: 'repo', absolutePath: repo }]);
  const preview = await svc.preview({ repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(preview.status, 'ok');
  if (preview.status !== 'ok') return;
  const paths = preview.entries.map((entry) => entry.path);
  assert.deepEqual(paths, ['.gitignore', 'src/a.ts', 'src/b.ts', 'src/z.ts', 'tracked.log']);
  assert.equal(preview.complete, true);
  assert.equal(preview.truncated, false);
  assert.equal(preview.exclusions.some((item) => item.path === '.git' && item.reason === 'git-internal'), true);
  assert.equal(preview.exclusions.some((item) => item.path === 'debug.log' && item.reason === 'git-ignored'), true);
  assert.equal(preview.exclusions.some((item) => item.path === 'ignored/x.txt' && item.reason === 'git-ignored'), true);

  // 同一 HEAD 下修改：指纹必须变化。
  const headBefore = preview.git.status === 'observed' ? preview.git.head : undefined;
  writeFile(repo, 'src/a.ts', 'a changed\n');
  const changed = await svc.preview({ repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(changed.status, 'ok');
  if (changed.status !== 'ok') return;
  assert.equal(changed.git.status === 'observed' ? changed.git.head : undefined, headBefore);
  assert.notEqual(changed.fingerprint, preview.fingerprint);

  // 增删同样可辨。
  writeFile(repo, 'src/new.ts', 'new\n');
  const added = await svc.observe(changed.selection);
  assert.equal(added.status, 'ok');
  if (added.status !== 'ok') return;
  assert.notEqual(added.fingerprint, changed.fingerprint);
  unlinkSync(path.join(repo, 'src/new.ts'));
  const removed = await svc.observe(changed.selection);
  assert.equal(removed.status, 'ok');
  if (removed.status !== 'ok') return;
  assert.notEqual(removed.fingerprint, added.fingerprint);

  // 输入次序无关：相同布局、不同创建顺序的两棵树指纹相同。
  const first = path.join(base, 'order-a');
  const second = path.join(base, 'order-b');
  writeFile(first, 'x/1.txt', '1\n');
  writeFile(first, 'y/2.txt', '2\n');
  writeFile(second, 'y/2.txt', '2\n');
  writeFile(second, 'x/1.txt', '1\n');
  const firstPreview = await service('inst-a', [{ repositoryId: 'r', absolutePath: first }])
    .preview({ repositoryId: 'r', scope: { kind: 'root' } });
  const secondPreview = await service('inst-b', [{ repositoryId: 'r', absolutePath: second }])
    .preview({ repositoryId: 'r', scope: { kind: 'root' } });
  assert.equal(firstPreview.status, 'ok');
  assert.equal(secondPreview.status, 'ok');
  if (firstPreview.status !== 'ok' || secondPreview.status !== 'ok') return;
  assert.equal(firstPreview.fingerprint, secondPreview.fingerprint);
});

test('3.4 集中限额：扫描截断、单文件超限、读取预算与非文本', async () => {
  const base = mkdtempSync(path.join(artifacts, 'analysis-limits-'));
  const repo = path.join(base, 'repo');
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']) writeFile(repo, name, `${name}\n`);
  writeFile(repo, 'big.txt', 'x'.repeat(200));
  writeFile(repo, 'bin.dat', new Uint8Array([0xff, 0xfe, 0x00, 0x01]));
  writeFile(repo, 'long.txt', 'aaaaaaaaaa\nbbbbbbbbbb\n');
  const svc = service('inst-1', [{ repositoryId: 'repo', absolutePath: repo }], 1, {
    scanEntries: 3,
    fileBytes: 100,
    readBytes: 100,
    readLines: 2,
  });

  const truncated = await svc.preview({ repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(truncated.status, 'ok');
  if (truncated.status !== 'ok') return;
  assert.equal(truncated.truncated, true);
  assert.equal(truncated.complete, false);
  assert.equal(truncated.entries.length, 3);
  assert.deepEqual(truncated.limits, { scanEntries: 3, fileBytes: 100, readBytes: 100, readLines: 2 });

  const tooLarge = await svc.preview({ repositoryId: 'repo', scope: { kind: 'file', path: 'big.txt' } });
  assert.equal(tooLarge.status, 'ok');
  if (tooLarge.status !== 'ok') return;
  assert.equal(tooLarge.entries[0]?.hash, null);
  assert.equal(tooLarge.issues.some((item) => item.code === 'analysis-file-too-large'), true);
  assert.equal(tooLarge.complete, false);

  const rootPreview = await svc.preview({ repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(rootPreview.status, 'ok');
  if (rootPreview.status !== 'ok') return;

  const nonText = await svc.read(rootPreview.selection, { path: 'bin.dat', budget: new ReadBudget(1024) });
  assert.equal(nonText.status, 'rejected');
  if (nonText.status === 'rejected') assert.equal(nonText.code, 'analysis-file-non-text');

  // 预算只够第一行：交付整行并标记按字节截断；预算用尽后下一次读取拒绝。
  const budget = new ReadBudget(10);
  const partial = await svc.read(rootPreview.selection, { path: 'long.txt', budget });
  assert.equal(partial.status, 'ok');
  if (partial.status !== 'ok') return;
  assert.equal(partial.truncated, true);
  assert.equal(partial.reason, 'bytes');
  assert.equal(partial.text, 'aaaaaaaaaa');
  assert.equal(budget.used, 10);
  const exhausted = await svc.read(rootPreview.selection, { path: 'c.txt', budget });
  assert.equal(exhausted.status, 'rejected');
  if (exhausted.status === 'rejected') assert.equal(exhausted.code, 'analysis-read-budget-exhausted');

  // 单行就放不进预算：拒绝而不是交付半行。
  const tiny = new ReadBudget(2);
  const firstLineTooLarge = await svc.read(rootPreview.selection, { path: 'long.txt', budget: tiny });
  assert.equal(firstLineTooLarge.status, 'rejected');
  if (firstLineTooLarge.status === 'rejected') assert.equal(firstLineTooLarge.code, 'analysis-read-budget-exceeded');

  // 特殊文件（FIFO）只记排除原因，不进入观察内容；无 mkfifo 的平台跳过。
  const fifoRepo = path.join(base, 'fifo-repo');
  mkdirSync(fifoRepo, { recursive: true });
  const fifoPath = path.join(fifoRepo, 'pipe');
  let fifoCreated = false;
  try {
    execFileSync('mkfifo', [fifoPath]);
    fifoCreated = true;
  } catch {
    fifoCreated = false;
  }
  if (fifoCreated) {
    const fifoService = service('inst-fifo', [{ repositoryId: 'repo', absolutePath: fifoRepo }]);
    const fifoPreview = await fifoService.preview({ repositoryId: 'repo', scope: { kind: 'root' } });
    assert.equal(fifoPreview.status, 'ok');
    if (fifoPreview.status === 'ok') {
      assert.deepEqual(fifoPreview.exclusions, [{ path: 'pipe', reason: 'special-file' }]);
      assert.equal(fifoPreview.entries.length, 0);
    }
  }

  // 不可读：root 会绕过权限位，跳过。
  if (!(typeof process.getuid === 'function' && process.getuid() === 0)) {
    const locked = path.join(base, 'locked');
    writeFile(locked, 'secret.txt', 's\n');
    const lockedService = service('inst-locked', [{ repositoryId: 'repo', absolutePath: locked }], 1, { fileBytes: 100 });
    chmodSync(path.join(locked, 'secret.txt'), 0o000);
    try {
      const previewLocked = await lockedService.preview({ repositoryId: 'repo', scope: { kind: 'root' } });
      assert.equal(previewLocked.status, 'ok');
      if (previewLocked.status !== 'ok') return;
      assert.equal(previewLocked.issues.some((item) => item.code === 'analysis-file-permission-denied'), true);
      assert.equal(previewLocked.complete, false);
    } finally {
      chmodSync(path.join(locked, 'secret.txt'), 0o644);
    }
  }
});

test('3.5 读取凭证：整文件/行范围/截断，目录与范围外拒绝', async () => {
  const base = mkdtempSync(path.join(artifacts, 'analysis-read-'));
  const repo = path.join(base, 'repo');
  writeFile(repo, 'src/a.ts', 'one\ntwo\nthree\n');
  writeFile(repo, 'src/b.ts', 'other\n');
  const svc = service('inst-1', [{ repositoryId: 'repo', absolutePath: repo }]);

  const preview = await svc.preview({ repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(preview.status, 'ok');
  if (preview.status !== 'ok') return;
  assert.equal('credential' in preview, false);

  const full = await svc.read(preview.selection, { path: 'src/a.ts', budget: new ReadBudget(1024) });
  assert.equal(full.status, 'ok');
  if (full.status !== 'ok') return;
  assert.equal(full.text, 'one\ntwo\nthree');
  assert.deepEqual(
    { start: full.credential.startLine, end: full.credential.endLine, truncated: full.credential.truncated },
    { start: 1, end: 3, truncated: false },
  );
  assert.equal(full.credential.fullHash, sha256(Buffer.from('one\ntwo\nthree\n')));
  assert.equal(full.credential.deliveredHash, sha256(Buffer.from(full.text)));
  assert.equal(full.credential.deliveredBytes, Buffer.byteLength(full.text));

  const range = await svc.read(preview.selection, {
    path: 'src/a.ts', startLine: 2, maxLines: 1, budget: new ReadBudget(1024),
  });
  assert.equal(range.status, 'ok');
  if (range.status !== 'ok') return;
  assert.equal(range.text, 'two');
  assert.deepEqual([range.credential.startLine, range.credential.endLine], [2, 2]);

  const directory = await svc.read(preview.selection, { path: 'src', budget: new ReadBudget(1024) });
  assert.equal(directory.status, 'rejected');
  if (directory.status === 'rejected') assert.equal(directory.code, 'scope-not-regular-file');

  // 文件选择范围外的文件不可读。
  const fileScope = await svc.preview({ repositoryId: 'repo', scope: { kind: 'file', path: 'src/a.ts' } });
  assert.equal(fileScope.status, 'ok');
  if (fileScope.status !== 'ok') return;
  const outside = await svc.read(fileScope.selection, { path: 'src/b.ts', budget: new ReadBudget(1024) });
  assert.equal(outside.status, 'rejected');
  if (outside.status === 'rejected') assert.equal(outside.code, 'analysis-scope-outside');
});

test('3.5 读取期间内容变化：两次读取哈希不同则拒绝且不发凭证', async () => {
  const base = mkdtempSync(path.join(artifacts, 'analysis-unstable-'));
  const repo = path.join(base, 'repo');
  writeFile(repo, 'a.txt', 'stable\n');
  let reads = 0;
  const result = await files.readBytes(repo, 'a.txt', DEFAULT_ANALYSIS_LIMITS, {
    readBytes: async () => {
      reads += 1;
      return Buffer.from(reads === 1 ? 'stable\n' : 'changed\n');
    },
  });
  assert.equal(reads, 2);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'analysis-file-changed');
});

test('3.5 读取期间路径变成符号链接：拒绝且不发凭证', async () => {
  const base = mkdtempSync(path.join(artifacts, 'analysis-unstable-path-'));
  const repo = path.join(base, 'repo');
  writeFile(repo, 'a.txt', 'stable\n');
  writeFile(repo, 'b.txt', 'other\n');
  let reads = 0;
  const result = await files.readBytes(repo, 'a.txt', DEFAULT_ANALYSIS_LIMITS, {
    readBytes: async (absolutePath) => {
      reads += 1;
      if (reads === 2) {
        unlinkSync(absolutePath);
        symlinkSync(path.join(repo, 'b.txt'), absolutePath);
      }
      return Buffer.from('stable\n');
    },
  });
  assert.equal(reads, 2);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'analysis-file-changed');
});

test('3.5 引用复核：当前/内容变化/删除/换成链接/映射变化', async () => {
  const base = mkdtempSync(path.join(artifacts, 'analysis-citation-'));
  const repo = path.join(base, 'repo');
  writeFile(repo, 'src/a.ts', 'one\ntwo\n');
  const maps: AnalysisRepositoryMapping[] = [{ repositoryId: 'repo', absolutePath: repo }];
  const svc = service('inst-1', maps);
  const preview = await svc.preview({ repositoryId: 'repo', scope: { kind: 'root' } });
  assert.equal(preview.status, 'ok');
  if (preview.status !== 'ok') return;
  const read = await svc.read(preview.selection, { path: 'src/a.ts', budget: new ReadBudget(1024) });
  assert.equal(read.status, 'ok');
  if (read.status !== 'ok') return;
  const credential = read.credential;

  assert.deepEqual(await svc.verifyCitation(preview.selection, credential), { status: 'current' });

  const fileScope = await svc.preview({ repositoryId: 'repo', scope: { kind: 'file', path: 'src/a.ts' } });
  assert.equal(fileScope.status, 'ok');
  if (fileScope.status !== 'ok') return;
  const outside = await svc.verifyCitation(fileScope.selection, { ...credential, path: 'src/b.ts' });
  assert.equal(outside.status, 'outside-scope');

  writeFile(repo, 'src/a.ts', 'one\nTWO\n');
  const changed = await svc.verifyCitation(preview.selection, credential);
  assert.equal(changed.status, 'content-changed');
  if (changed.status === 'content-changed') {
    assert.equal(changed.currentHash, sha256(Buffer.from('one\nTWO\n')));
  }

  unlinkSync(path.join(repo, 'src/a.ts'));
  assert.deepEqual(await svc.verifyCitation(preview.selection, credential), { status: 'missing' });

  // 同一路径被替换成指向别处的符号链接：读取按链接拒绝，不用新目标冒充原文件。
  writeFile(repo, 'src/b.ts', 'other\n');
  symlinkSync(path.join(repo, 'src/b.ts'), path.join(repo, 'src/a.ts'));
  const linked = await svc.verifyCitation(preview.selection, credential);
  assert.equal(linked.status, 'inaccessible');
  if (linked.status === 'inaccessible') assert.equal(linked.code, 'scope-symlink');

  const movedService = service('inst-1', [{ repositoryId: 'repo', absolutePath: path.join(base, 'other') }]);
  const moved = await movedService.verifyCitation(preview.selection, credential);
  assert.equal(moved.status, 'mapping-changed');

});
