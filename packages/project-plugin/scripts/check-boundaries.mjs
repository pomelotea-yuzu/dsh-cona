#!/usr/bin/env node
// 包边界检查（tasks 1.1）：domain 不得依赖 Node、React、Cordis 或任何外部包；
// 其 import 只允许指向 src/domain 内部。client 不得引入 node:。
// 用法：node scripts/check-boundaries.mjs

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function listTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function checkLayer(layerDir, rules, failures) {
  let files;
  try {
    statSync(layerDir);
  } catch {
    return; // 层尚未实现
  }
  for (const file of listTsFiles(layerDir)) {
    const source = readFileSync(file, 'utf8');
    const rel = path.relative(packageRoot, file);
    const importPattern = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g;
    let match;
    while ((match = importPattern.exec(source)) !== null) {
      const spec = match[1];
      for (const rule of rules) {
        if (rule.test(spec, rel)) {
          failures.push(`${rel}: import '${spec}' 违反规则 ${rule.name}`);
        }
      }
    }
  }
}

const failures = [];

const BANNED_EXTERNAL = [
  { name: 'node:', test: (s) => s.startsWith('node:') },
  { name: 'react', test: (s) => s === 'react' || s.startsWith('react/') },
  { name: 'cordis', test: (s) => s.includes('cordis') },
  { name: 'deepseek-ai', test: (s) => s.includes('@deepseek-ai') },
];

// domain：只允许包内相对导入，且必须留在 src/domain 内。
checkLayer(path.join(packageRoot, 'src', 'domain'), [
  ...BANNED_EXTERNAL,
  {
    name: 'domain-internal-only',
    test: (spec, rel) => {
      if (!spec.startsWith('.')) return true;
      const resolved = path.resolve(path.dirname(path.join(packageRoot, rel)), spec);
      return !resolved.startsWith(path.join(packageRoot, 'src', 'domain'));
    },
  },
], failures);

// client：浏览器层禁止 node:。
checkLayer(path.join(packageRoot, 'src', 'client'), [
  { name: 'client-no-node', test: (s) => s.startsWith('node:') },
], failures);

if (failures.length > 0) {
  process.stderr.write(failures.map((line) => `- ${line}`).join('\n') + '\n');
  process.exitCode = 1;
} else {
  process.stdout.write('包边界检查通过：domain 无 Node/React/Cordis 依赖。\n');
}
