// 快照查询 CLI（tasks 5.1）：在无宿主进程中读取完整快照，用于实测一致读取与追读行为。
// 用法：
//   snapshot.js read --local-root <dir> --instance <id> [--generation <n>] [--min-state-revision <n>]
//                    [--trusted remote-owner|agent-work] [--work-run <id>] [--binding-version <n>]
//   snapshot.js follow --local-root <dir> --instance <id> [--wait <ms>]
// follow 只打印 ready 与订阅建立结果（无 UI 时常驻监听无意义），用于核对代际与水位。
// 输出一行 JSON；未同步、拒绝或用法错误退出码非 0。

import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { InMemoryChangeStream } from '../application/change-stream.js';
import { ProjectSnapshotService, type SnapshotDeps } from '../application/snapshot.js';
import type { TrustedContext } from '../application/command-service.js';
import { LocalStateStore } from '../adapters/fs/local-state.js';
import { createSourceFiles } from '../adapters/fs/source-files.js';
import type { Sha256Fn } from '../domain/types.js';

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');

function usage(): string {
  return [
    '用法:',
    '  snapshot.js read --local-root <dir> --instance <id> [--generation <n>] [--min-state-revision <n>]',
    '                [--trusted remote-owner|agent-work] [--work-run <id>] [--binding-version <n>]',
    '  snapshot.js follow --local-root <dir> --instance <id>',
  ].join('\n') + '\n';
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'local-root': { type: 'string' },
      instance: { type: 'string' },
      generation: { type: 'string' },
      'min-state-revision': { type: 'string' },
      trusted: { type: 'string' },
      'work-run': { type: 'string' },
      'binding-version': { type: 'string' },
    },
  });
  const commandName = positionals[0];
  if (commandName !== 'read' && commandName !== 'follow') {
    process.stderr.write(usage());
    return 2;
  }
  const localRoot = values['local-root'];
  const instanceId = values['instance'];
  if (typeof localRoot !== 'string' || typeof instanceId !== 'string') {
    process.stderr.write('需要 --local-root 与 --instance\n' + usage());
    return 2;
  }

  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const stream = new InMemoryChangeStream();
  const deps: SnapshotDeps = {
    localRoot,
    store: new LocalStateStore(),
    files: createSourceFiles(path.join(packageRoot, 'formats', 'v1'), sha256),
    sha256,
    clock: () => new Date().toISOString(),
    stream,
  };
  const service = new ProjectSnapshotService(deps);
  const trusted: TrustedContext =
    values['trusted'] === 'agent-work'
      ? {
          kind: 'agent-work',
          workRunId: typeof values['work-run'] === 'string' ? values['work-run'] : '',
          bindingVersion: typeof values['binding-version'] === 'string' ? Number(values['binding-version']) : 0,
          instanceId,
        }
      : { kind: 'remote-owner' };

  if (commandName === 'follow') {
    const followed = await service.follow(trusted, { instanceId });
    if (followed.status === 'following') {
      followed.close();
      process.stdout.write(
        JSON.stringify({
          command: commandName,
          status: followed.status,
          connectionGeneration: followed.connectionGeneration,
          ready: followed.ready,
        }) + '\n',
      );
      return 0;
    }
    process.stdout.write(JSON.stringify({ command: commandName, ...followed }) + '\n');
    return 1;
  }

  const generation = typeof values.generation === 'string' ? Number(values.generation) : 1;
  const minStateRevision =
    typeof values['min-state-revision'] === 'string' ? Number(values['min-state-revision']) : undefined;
  const result = await service.read(trusted, {
    instanceId,
    connectionGeneration: Number.isSafeInteger(generation) ? generation : 1,
    ...(minStateRevision === undefined || !Number.isSafeInteger(minStateRevision) ? {} : { minStateRevision }),
  });
  process.stdout.write(JSON.stringify({ command: commandName, ...result }) + '\n');
  return result.status === 'snapshot' && result.snapshot.sync.status === 'synced' ? 0 : 1;
}

process.exitCode = await main();
