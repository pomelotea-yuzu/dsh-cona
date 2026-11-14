// 命令封套 CLI（tasks 4.1）：在无宿主进程中执行一条规划／记录命令，用于实测与故障注入。
// 用法：
//   command.js run --local-root <dir> --instance <instanceId> --command '<json>'
//                  [--source <资料根>] [--epoch <n>]
//                  [--expected-plan-version <sha256:...>] [--expected-plan-revision <n>]
//                  [--trusted remote-owner|agent-work] [--work-run <id>] [--binding-version <n>]
// 命令 JSON 见 README「命令封套」。输出一行 JSON；拒绝或待核对退出码 1。
// 本命令不实现幂等回执与恢复（4.2–4.5），每次调用都是一个新操作。

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ProjectCommandService, type Command, type TrustedContext } from '../application/command-service.js';
import { LocalStateStore } from '../adapters/fs/local-state.js';
import { createSourceFiles } from '../adapters/fs/source-files.js';
import type { Sha256Fn } from '../domain/types.js';

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');

function usage(): string {
  return [
    '用法:',
    "  command.js run --local-root <dir> --instance <id> --command '<json>'",
    '                [--source <dir>] [--epoch <n>] [--expected-plan-version <sha>] [--expected-plan-revision <n>]',
    '                [--trusted remote-owner|agent-work] [--work-run <id>] [--binding-version <n>]',
  ].join('\n') + '\n';
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'local-root': { type: 'string' },
      instance: { type: 'string' },
      source: { type: 'string' },
      command: { type: 'string' },
      epoch: { type: 'string' },
      'expected-plan-version': { type: 'string' },
      'expected-plan-revision': { type: 'string' },
      trusted: { type: 'string' },
      'work-run': { type: 'string' },
      'binding-version': { type: 'string' },
    },
  });
  const commandName = positionals[0];
  if (commandName !== 'run') {
    process.stderr.write(usage());
    return 2;
  }
  const localRoot = values['local-root'];
  const instanceId = values['instance'];
  const commandJson = values['command'];
  if (typeof localRoot !== 'string' || typeof instanceId !== 'string' || typeof commandJson !== 'string') {
    process.stderr.write('run 需要 --local-root、--instance 与 --command\n' + usage());
    return 2;
  }

  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const store = new LocalStateStore();
  const files = createSourceFiles(path.join(packageRoot, 'formats', 'v1'), sha256);
  const service = new ProjectCommandService({
    localRoot,
    store,
    files,
    sha256,
    clock: () => new Date().toISOString(),
    newNodeId: () => randomUUID(),
    newRecordId: () => randomUUID(),
  });

  let command: Command;
  try {
    command = JSON.parse(commandJson) as Command;
  } catch (error) {
    process.stderr.write(`命令 JSON 无法解析：${(error as Error).message}\n`);
    return 2;
  }

  const registry = await store.readRegistry(localRoot);
  const entry = registry.instances.find((item) => item.instanceId === instanceId);
  if (entry === undefined) {
    process.stdout.write(
      JSON.stringify({ command: commandName, status: 'rejected', code: 'binding-expired', message: '本机注册表中没有该实例' }) + '\n',
    );
    return 1;
  }
  const sourceRoot = typeof values['source'] === 'string' ? values['source'] : entry.sourceRoot;
  const aggregate = await store.readAggregate(localRoot, instanceId);
  const head = await files.readHead(sourceRoot);
  if (!head.ok) {
    process.stdout.write(JSON.stringify({ command: commandName, status: 'rejected', code: 'invalid-project', issues: head.issues }) + '\n');
    return 1;
  }
  const planVersion =
    typeof values['expected-plan-version'] === 'string'
      ? values['expected-plan-version']
      : ((JSON.parse(head.text) as { planVersion: string }).planVersion);
  const planRevision =
    typeof values['expected-plan-revision'] === 'string'
      ? Number(values['expected-plan-revision'])
      : (aggregate?.revisions.plan ?? 0);
  const epoch = typeof values['epoch'] === 'string' ? Number(values['epoch']) : entry.sourceGeneration;

  const trusted = values['trusted'] === 'agent-work'
    ? ({
        kind: 'agent-work',
        workRunId: typeof values['work-run'] === 'string' ? values['work-run'] : '',
        bindingVersion: typeof values['binding-version'] === 'string' ? Number(values['binding-version']) : 0,
        instanceId,
      } satisfies TrustedContext)
    : ({ kind: 'remote-owner' } satisfies TrustedContext);

  const result = await service.execute(trusted, {
    operationId: randomUUID(),
    projectId: entry.projectId,
    instanceId,
    sourceEpoch: epoch,
    expectedPlanVersion: planVersion,
    expectedPlanRevision: planRevision,
    command,
  });
  process.stdout.write(JSON.stringify({ command: commandName, ...result }) + '\n');
  return result.status === 'committed' ? 0 : 1;
}

process.exitCode = await main();
