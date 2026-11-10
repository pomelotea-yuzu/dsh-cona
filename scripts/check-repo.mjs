#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 门禁链跨平台：本地 macOS (zsh) 与 CI ubuntu 跑同一条命令链；只用 node:path 与 git 子进程，不依赖 shell 方言。
let snapshot;

try {
  let checkRoot = ROOT;
  let env = process.env;
  if (process.argv.includes('--staged')) {
    const artifacts = path.join(ROOT, 'artifacts');
    mkdirSync(artifacts, { recursive: true });
    snapshot = mkdtempSync(path.join(artifacts, 'staged-checks-'));
    const prefix = `${snapshot.replace(/\\/g, '/')}/`;
    execFileSync('git', ['checkout-index', '--all', `--prefix=${prefix}`], { cwd: ROOT, stdio: 'inherit' });
    const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const index = execFileSync('git', ['rev-parse', '--git-path', 'index'], { cwd: ROOT, encoding: 'utf8' }).trim();
    checkRoot = snapshot;
    env = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: snapshot, GIT_INDEX_FILE: path.resolve(ROOT, index) };
  }
  const checks = [
    ['check-hygiene.mjs', '--all'],
    ['check-hygiene.mjs', '--selftest'],
    ['check-i18n.mjs', '--selftest'],
    ['check-i18n.mjs', '--links'],
    ['check-i18n.mjs'],
  ];
  for (const [script, ...args] of checks) {
    const result = spawnSync(process.execPath, [path.join(checkRoot, 'scripts', script), ...args], {
      cwd: checkRoot, env, stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} catch (error) {
  console.error(`仓库门禁执行失败：${error.message}`);
  process.exitCode = 1;
} finally {
  if (snapshot) rmSync(snapshot, { recursive: true, force: true });
}
