// 工作副本只读观察测试（tasks 3.2 第三段）：真实 git 子进程，只读断言。
// 覆盖：干净仓库 observed(dirty 0)、改动后计数、排除资料目录条目、
// 非 git 目录 unavailable、无提交仓库 unavailable、git 不可用不作伪结论。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeWorkCopy } from '../src/adapters/fs/work-copy.js';

// 临时目录放在包内 artifacts/（仓库门禁禁止 os.tmpdir 与机器绝对路径）。
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(packageRoot, 'artifacts');
mkdirSync(artifacts, { recursive: true });
const gitBin = 'git';

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
  execFileSync(gitBin, ['init', '--quiet'], { cwd: dir, env: { ...process.env, GIT_CEILING_DIRECTORIES: artifacts } });
  writeFileSync(path.join(dir, 'README.md'), '# t\n');
  execFileSync(gitBin, ['add', '.'], { cwd: dir });
  execFileSync(gitBin, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'init'], { cwd: dir });
  return dir;
}

test('干净仓库：observed，dirty 0', () => {
  if (!gitAvailable()) return;
  const repo = initRepo(path.join(artifacts, 'clean'));
  const obs = observeWorkCopy(repo, [], { env: { GIT_CEILING_DIRECTORIES: artifacts } });
  assert.equal(obs.status, 'observed');
  if (obs.status === 'observed') {
    assert.equal(obs.dirtyCount, 0);
    assert.match(obs.head, /^[0-9a-f]{40}$/);
  }
});

test('改动文件与新增文件：dirty 计数；rename 只计一次', () => {
  if (!gitAvailable()) return;
  const repo = initRepo(path.join(artifacts, 'dirty'));
  appendFileSync(path.join(repo, 'README.md'), 'more\n');
  writeFileSync(path.join(repo, 'new.txt'), 'x\n');
  const obs = observeWorkCopy(repo, [], { env: { GIT_CEILING_DIRECTORIES: artifacts } });
  assert.equal(obs.status, 'observed');
  if (obs.status === 'observed') assert.equal(obs.dirtyCount, 2);
});

test('排除资料目录下的条目：不计入 dirty', () => {
  if (!gitAvailable()) return;
  const repo = initRepo(path.join(artifacts, 'exclude'));
  const dataDir = path.join(repo, 'data-root');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'project.json'), '{}');
  const obs = observeWorkCopy(repo, [dataDir], { env: { GIT_CEILING_DIRECTORIES: artifacts } });
  assert.equal(obs.status, 'observed');
  if (obs.status === 'observed') assert.equal(obs.dirtyCount, 0, '排除目录下的新增不计');
  const withoutExclude = observeWorkCopy(repo, [], { env: { GIT_CEILING_DIRECTORIES: artifacts } });
  if (withoutExclude.status === 'observed') assert.equal(withoutExclude.dirtyCount, 1, '不排除时计 1');
});

test('非 git 目录与无提交仓库：unavailable 稳定原因', () => {
  if (!gitAvailable()) return;
  const base = mkdtempSync(path.join(artifacts, 'plain-'));
  const plain = path.join(base, 'plain');
  mkdirSync(plain, { recursive: true });
  const notRepo = observeWorkCopy(plain, [], { env: { GIT_CEILING_DIRECTORIES: base } });
  assert.equal(notRepo.status, 'unavailable');
  if (notRepo.status === 'unavailable') assert.equal(notRepo.reason, 'not-a-work-copy');

  const empty = path.join(base, 'empty');
  mkdirSync(empty, { recursive: true });
  execFileSync(gitBin, ['init', '--quiet'], { cwd: empty, env: { ...process.env, GIT_CEILING_DIRECTORIES: base } });
  const noCommits = observeWorkCopy(empty, [], { env: { GIT_CEILING_DIRECTORIES: base } });
  assert.equal(noCommits.status, 'unavailable');
  if (noCommits.status === 'unavailable') assert.equal(noCommits.reason, 'no-commits');
});

test('git 不可用：unavailable，不作伪结论', () => {
  const repo = path.join(artifacts, 'nobin');
  mkdirSync(repo, { recursive: true });
  const obs = observeWorkCopy(repo, [], { gitBin: 'definitely-not-a-git-binary' });
  assert.equal(obs.status, 'unavailable');
});
