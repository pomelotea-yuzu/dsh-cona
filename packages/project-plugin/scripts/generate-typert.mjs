#!/usr/bin/env node
// Typert 产物生成（tasks 2.2 剩余，design §1）：调 @deepseek-ai/dsh-typert-generator
// 的 WorkspaceTypertGenerator 对单包生成 lib/typert.* 与 lib/typert.remote-client.*。
// root=仓库根（含 tsconfig.host.json 与 packages/）；产物路径与 package.json
// exports 声明（./typert、./remote）及生成器 validateExport 契约对齐。
// 用法：node scripts/generate-typert.mjs [--check]
//   默认写盘；--check 只跑分析不写产物。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import {
  WorkspaceTypertGenerator,
  writeWorkspaceArtifacts,
  findWorkspaceRoot,
  TypertAnalysisError,
} from '@deepseek-ai/dsh-typert-generator';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const checkOnly = process.argv.includes('--check');

// root 必须同时含 tsconfig.host.json 与 packages/（findWorkspaceRoot 契约）。
const root = existsSync(path.join(repoRoot, 'tsconfig.host.json'))
  && existsSync(path.join(repoRoot, 'packages'))
  ? repoRoot
  : findWorkspaceRoot(packageRoot);

const generator = new WorkspaceTypertGenerator(root, {
  // 仓库门禁已由 tsc 全量校验；生成器只保留 Typert 专属检查。
  checkDiagnostics: false,
  rejectBuildOutputs: true,
});

let artifacts;
try {
  artifacts = generator.generate(['dsh-cona-project']);
} catch (error) {
  if (error instanceof TypertAnalysisError) {
    process.stderr.write(`typert 分析失败：\n${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
  process.exit(process.exitCode ?? 0);
}

if (artifacts.length === 0) {
  process.stderr.write('typert：未发现可生成产物（surface 为空或包未被选中）。\n');
  process.exitCode = 1;
} else {
  if (!checkOnly) writeWorkspaceArtifacts(root, artifacts);
  for (const artifact of artifacts) {
    const hasRemote = artifact.remote !== undefined;
    process.stdout.write(
      `typert(${artifact.face}) ${artifact.package} → ${artifact.packageRoot}/lib/typert.${artifact.face}.{js,d.ts}`
      + (hasRemote ? ' + typert.remote-client.{js,d.ts,d.ts.map}' : '')
      + (checkOnly ? '（--check 未写盘）' : '')
      + '\n',
    );
  }
}

// 生成后核对 files 声明（复刻生成器 validateExport 的断言面，便于本地提前失败）。
const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const requiredFiles = ['lib/typert.host.js', 'lib/typert.host.d.ts'];
const hostArtifact = artifacts.find(artifact => artifact.face === 'host');
if (hostArtifact?.remote !== undefined) {
  requiredFiles.push('lib/typert.remote-client.js', 'lib/typert.remote-client.d.ts', 'lib/typert.remote-client.d.ts.map');
}
const missing = requiredFiles.filter(file => !(manifest.files ?? []).includes(file));
if (missing.length > 0) {
  process.stderr.write(`package.json files 缺少生成产物声明：${missing.join(', ')}\n`);
  process.exitCode = 1;
}
