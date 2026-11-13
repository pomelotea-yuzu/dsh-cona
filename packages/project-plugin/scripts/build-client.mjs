#!/usr/bin/env node
// Client factory 构建（tasks 2.2）：esbuild cjs bundle + closure-factory 包装。
// 产物格式对齐宿主 loader：window.__ModuleLoader__.load({ id, factory: (require) => {...} })，
// external（inject 声明的 @deepseek-ai/*）经注入 require 解析。不导入上游 tsdown.client.ts。
// 用法：node scripts/build-client.mjs

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(packageRoot, 'dist', 'client');

await build({
  entryPoints: [path.join(packageRoot, 'src', 'client', 'index.ts')],
  outfile: path.join(outDir, 'client.browser.js'),
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  // 共享宿主模块经注入 require 解析，不内联；宿主注入清单由 manifest dsh.client.inject 声明。
  external: ['@deepseek-ai/*'],
  sourcemap: 'external',
  minify: false,
  logLevel: 'info',
  banner: {
    js: [
      'window.__ModuleLoader__.load({ id: "dsh-cona-project", factory: (require) => {',
      'var module = { exports: {} }; var exports = module.exports;',
    ].join('\n'),
  },
  footer: {
    js: 'return module.exports; } });',
  },
});

process.stdout.write(`client factory 已产出：${path.join('dist', 'client', 'client.browser.js')}\n`);
