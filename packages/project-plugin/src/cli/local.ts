// 本机根与注册表命令（tasks 3.2）：纯 Node，无 DSH 服务。
// 用法：
//   local.js root    (--dsh-home <dir> | --local-root <dir>) [--source <资料根>]
//   local.js register --local-root <dir> --source <资料根> --project-id <uuid> --kind <kind> [--plan-version <sha256:...>]
//   local.js list    --local-root <dir>
//   local.js show    --local-root <dir> --instance <instanceId>
//   local.js release-lock --local-root <dir> (--force | --token <token>)
// 输出一行 JSON；失败退出码 1，用法错误 2。
// 不写公开资料、不执行 Git 提交；遗留锁必须显式释放，不自动按超时抢占。

import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { LocalStateService } from '../application/local-state.js';
import type { LocationKind } from '../application/location.js';
import { LocalStateStore } from '../adapters/fs/local-state.js';
import { inspectPrivateRoot } from '../adapters/fs/git-guard.js';
import { resolveLocalRoot, rootRelation } from '../adapters/fs/local-root.js';

function usage(): string {
  return [
    '用法:',
    '  local.js root    (--dsh-home <dir> | --local-root <dir>) [--source <资料根>]',
    '  local.js register --local-root <dir> --source <资料根> --project-id <uuid> --kind <kind>',
    '  local.js list    --local-root <dir>',
    '  local.js show    --local-root <dir> --instance <instanceId>',
    '  local.js release-lock --local-root <dir> (--force | --token <token>)',
  ].join('\n') + '\n';
}

function buildService(): LocalStateService {
  return new LocalStateService({
    resolver: { resolveLocal: resolveLocalRoot, relation: rootRelation },
    git: { inspect: inspectPrivateRoot },
    store: new LocalStateStore(),
    clock: () => new Date().toISOString(),
    newInstanceId: () => randomUUID(),
  });
}

function rootRequest(values: Record<string, unknown>): { dshHome?: string; localDataRoot?: string } {
  const request: { dshHome?: string; localDataRoot?: string } = {};
  if (typeof values['dsh-home'] === 'string') request.dshHome = values['dsh-home'];
  if (typeof values['local-root'] === 'string') request.localDataRoot = values['local-root'];
  return request;
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'dsh-home': { type: 'string' },
      'local-root': { type: 'string' },
      source: { type: 'string' },
      'project-id': { type: 'string' },
      kind: { type: 'string' },
      'plan-version': { type: 'string' },
      instance: { type: 'string' },
      token: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
  });
  const command = positionals[0];
  if (command === undefined) {
    process.stderr.write(usage());
    return 2;
  }
  const service = buildService();

  try {
    if (command === 'root') {
      const result = await service.ensureRoot({
        ...rootRequest(values),
        ...(typeof values['source'] === 'string' ? { sourceRoot: values['source'] } : {}),
      });
      process.stdout.write(JSON.stringify({ command, ...result }) + '\n');
      return result.ok ? 0 : 1;
    }
    if (command === 'register') {
      if (
        typeof values['local-root'] !== 'string' ||
        typeof values['source'] !== 'string' ||
        typeof values['project-id'] !== 'string' ||
        typeof values['kind'] !== 'string'
      ) {
        process.stderr.write('register 需要 --local-root、--source、--project-id 与 --kind\n' + usage());
        return 2;
      }
      const result = await service.register({
        localDataRoot: values['local-root'],
        sourceRoot: values['source'],
        sourceKind: values['kind'] as LocationKind,
        projectId: values['project-id'],
        ...(typeof values['plan-version'] === 'string' ? { planVersion: values['plan-version'] } : {}),
      });
      process.stdout.write(JSON.stringify({ command, ...result }) + '\n');
      return result.ok ? 0 : 1;
    }
    if (command === 'list') {
      const result = await service.list(rootRequest(values));
      process.stdout.write(JSON.stringify({ command, ...result }) + '\n');
      return result.ok ? 0 : 1;
    }
    if (command === 'show') {
      if (typeof values['instance'] !== 'string') {
        process.stderr.write('show 需要 --instance\n' + usage());
        return 2;
      }
      const result = await service.show({ ...rootRequest(values), instanceId: values['instance'] });
      process.stdout.write(JSON.stringify({ command, ...result }) + '\n');
      return result.ok ? 0 : 1;
    }
    if (command === 'release-lock') {
      const localRoot = values['local-root'];
      if (typeof localRoot !== 'string') {
        process.stderr.write('release-lock 需要 --local-root\n' + usage());
        return 2;
      }
      const store = new LocalStateStore();
      const result = await store.releaseLock(localRoot, {
        force: values['force'] === true,
        ...(typeof values['token'] === 'string' ? { expectedToken: values['token'] } : {}),
      });
      process.stdout.write(JSON.stringify({ command, ...result }) + '\n');
      return result.ok ? 0 : 1;
    }
    process.stderr.write(`未知命令：${command}\n` + usage());
    return 2;
  } catch (error) {
    process.stderr.write(`本机状态命令执行失败：${(error as Error).message}\n`);
    return 2;
  }
}

process.exitCode = await main();
