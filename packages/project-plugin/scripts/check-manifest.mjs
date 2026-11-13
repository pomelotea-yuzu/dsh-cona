#!/usr/bin/env node
// manifest 必查字段检查（tasks 2.2，design §1）：构建前与 pack 后各跑一次。
// 必查：type=module、dsh.bundle.patch、dsh.client.platform=web、Client inject/external、
// exports["./client"]、engines.dsh=0.2.2-rc.2、engines.node、共享 peer/dev 双声明、files 完整。
// 用法：node scripts/check-manifest.mjs [--packed <tarball>]

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

check(manifest.type === 'module', 'type 必须是 module');
check(manifest.engines?.dsh === '0.2.2-rc.2', 'engines.dsh 必须精确为 0.2.2-rc.2');
check(typeof manifest.engines?.node === 'string' && manifest.engines.node.startsWith('>=24'), 'engines.node 必须声明 >=24 起');
check(manifest.main === 'dist/src/host/index.js', 'main 必须指向 Host ESM 入口');
check(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch 必须声明');
check(manifest.dsh?.client?.platform === 'web', 'dsh.client.platform 必须是 web');
check(Array.isArray(manifest.dsh?.client?.inject), 'dsh.client.inject 必须声明（可为空数组）');
check(existsSync(path.join(packageRoot, 'cordis.patch.yml')), 'cordis.patch.yml 必须存在');
check(manifest.exports?.['.'] === './dist/src/host/index.js', 'exports["."] 必须指向 Host 入口');

// Client 入口与产物（closure factory）。
check(manifest.exports?.['./client'] === './dist/client/client.browser.js', 'exports["./client"] 必须指向 factory 产物');
const clientEntry = path.join(packageRoot, 'dist', 'client', 'client.browser.js');
check(existsSync(clientEntry), 'client factory 产物缺失（先运行 build）');
if (existsSync(clientEntry)) {
  const factoryText = readFileSync(clientEntry, 'utf8');
  check(factoryText.includes('window.__ModuleLoader__.load({ id: "dsh-cona-project", factory: (require) => {'), 'client factory 缺少 __ModuleLoader__.load 包装');
  check(factoryText.trimEnd().endsWith('return module.exports; } });'), 'client factory 缺少 module.exports 收尾');
}

// 共享宿主包 peer/dev 双声明（发布文档要求）。
const peers = manifest.peerDependencies ?? {};
const devDeps = manifest.devDependencies ?? {};
for (const [name, range] of Object.entries(peers)) {
  if (name.startsWith('@deepseek-ai/')) {
    check(range !== 'workspace:*' && range !== 'workspace:~' && range !== 'workspace:^', `${name} peer 不得使用上游 workspace: 协议（须精确版本）`);
    check(devDeps[name] !== undefined, `${name} 必须同时声明 peerDependencies 与 devDependencies`);
  }
}

// files 资源完整性：dist 与 formats 都必须随包分发。
for (const required of ['dist', 'formats']) {
  check((manifest.files ?? []).includes(required), `files 必须包含 ${required}`);
}

// --packed：检查 tarball 解包目录（由调用方先 npm pack 并解包）。
const packedIndex = process.argv.indexOf('--packed');
if (packedIndex !== -1) {
  const dir = path.resolve(process.argv[packedIndex + 1]);
  check(existsSync(path.join(dir, 'package.json')), `tarball 缺 package.json`);
  check(existsSync(path.join(dir, 'formats', 'v1', 'plan-canonicalization.md')), 'tarball 缺协议正文');
  check(existsSync(path.join(dir, 'formats', 'v1', 'plan-vectors.json')), 'tarball 缺一致性向量');
  check(existsSync(path.join(dir, 'formats', 'v1', 'project-v1.schema.json')), 'tarball 缺 schema');
  const hostEntry = manifest.main;
  check(existsSync(path.join(dir, hostEntry)), `tarball 缺 Host 产物 ${hostEntry}`);
  const clientPath = manifest.exports['./client'];
  if (clientPath) {
    check(existsSync(path.join(dir, clientPath)) || !existsSync(path.join(dir, 'dist', 'src', 'client')), 'tarball Client 产物与 exports 声明不一致');
  }
}

if (failures.length > 0) {
  process.stderr.write(failures.map((line) => `- ${line}`).join('\n') + '\n');
  process.exitCode = 1;
} else {
  process.stdout.write('manifest 必查字段检查通过。\n');
}
