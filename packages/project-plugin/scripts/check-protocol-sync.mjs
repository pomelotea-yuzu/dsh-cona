#!/usr/bin/env node
// 协议同步检查（tasks 1.5）：包内 formats/v1 的协议正文与向量必须与 change 工件逐字节一致。
// 在无 change 目录的检出（独立发布包）中跳过并提示。
// 用法：node scripts/check-protocol-sync.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changeFormats = path.resolve(packageRoot, '..', '..', 'openspec', 'changes', 'establish-r1-project-plugin', 'formats', 'v1');
const packageFormats = path.join(packageRoot, 'formats', 'v1');

const files = ['plan-canonicalization.md', 'plan-vectors.json'];
const failures = [];

for (const name of files) {
  const changePath = path.join(changeFormats, name);
  const packagePath = path.join(packageFormats, name);
  let changeBytes;
  try {
    changeBytes = readFileSync(changePath);
  } catch {
    process.stdout.write(`跳过：未找到 change 工件 ${name}（独立检出）。\n`);
    continue;
  }
  const packageBytes = readFileSync(packagePath);
  if (!changeBytes.equals(packageBytes)) {
    failures.push(`${name} 与 change 工件不一致`);
  }
}

if (failures.length > 0) {
  process.stderr.write(failures.map((line) => `- ${line}`).join('\n') + '\n');
  process.exitCode = 1;
} else {
  process.stdout.write('协议工件与 change 工件逐字节一致。\n');
}
