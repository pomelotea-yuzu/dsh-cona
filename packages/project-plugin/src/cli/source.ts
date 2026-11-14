// 资料位置与基础接入命令（tasks 3.1）：纯 Node，无 DSH 服务、无浏览器、无模型。
// 用法：
//   source.js preview --kind <project-directory|dsh-data|custom> [--code-root <dir>] [--dsh-home <dir>]
//                     [--custom-root <dir>] [--project-id <uuid>]
//   source.js create  --kind <...> --title <标题> [--goal <目标>] [--constraint <约束>]...
//                     [--project-id <uuid>] [--code-root|--dsh-home|--custom-root ...]
//   source.js attach  <资料根> [--kind <...>]
// 输出一行 JSON；失败退出码 1，用法错误 2。
// 本命令不写回执、不登记本机实例（3.2）、不执行 Git 提交（位置只读观察）。

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SourceService } from '../application/source-service.js';
import type { LocationKind, LocationRequest } from '../application/location.js';
import { describeRoot, resolveLocation } from '../adapters/fs/location.js';
import { readGitStatus } from '../adapters/fs/git-status.js';
import { createSourceFiles } from '../adapters/fs/source-files.js';
import type { Sha256Fn } from '../domain/types.js';

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');

function usage(): string {
  return [
    '用法:',
    '  source.js preview --kind <kind> [--code-root <dir>] [--dsh-home <dir>] [--custom-root <dir>] [--project-id <uuid>]',
    '  source.js create  --kind <kind> --title <标题> [--goal <目标>] [--constraint <约束>]... [--project-id <uuid>]',
    '  source.js attach  <资料根> [--kind <kind>]',
    '  kind: project-directory | dsh-data | custom',
  ].join('\n') + '\n';
}

function buildService(): SourceService {
  // lib/cli/source.js → lib → 包根（lib 直接镜像 src）。
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  return new SourceService({
    location: { resolve: resolveLocation, describe: describeRoot },
    files: createSourceFiles(path.join(packageRoot, 'formats', 'v1'), sha256),
    git: { read: (root: string) => readGitStatus(root) },
    sha256,
    newProjectId: () => randomUUID(),
    newNodeId: () => randomUUID(),
  });
}

function requestFrom(values: Record<string, unknown>): LocationRequest {
  const request: LocationRequest = { kind: values['kind'] as LocationKind };
  if (typeof values['code-root'] === 'string') request.codeRoot = values['code-root'];
  if (typeof values['dsh-home'] === 'string') request.dshHome = values['dsh-home'];
  if (typeof values['custom-root'] === 'string') request.customRoot = values['custom-root'];
  return request;
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      kind: { type: 'string' },
      'code-root': { type: 'string' },
      'dsh-home': { type: 'string' },
      'custom-root': { type: 'string' },
      'project-id': { type: 'string' },
      title: { type: 'string' },
      goal: { type: 'string' },
      constraint: { type: 'string', multiple: true },
    },
  });
  const command = positionals[0];
  if (command === undefined) {
    process.stderr.write(usage());
    return 2;
  }

  const service = buildService();
  try {
    if (command === 'preview') {
      if (typeof values['kind'] !== 'string') {
        process.stderr.write('preview 需要 --kind\n' + usage());
        return 2;
      }
      const result = await service.preview({
        ...requestFrom(values),
        ...(typeof values['project-id'] === 'string' ? { projectId: values['project-id'] } : {}),
      });
      process.stdout.write(JSON.stringify({ command, ...result }) + '\n');
      return result.ok ? 0 : 1;
    }
    if (command === 'create') {
      if (typeof values['kind'] !== 'string' || typeof values['title'] !== 'string') {
        process.stderr.write('create 需要 --kind 与 --title\n' + usage());
        return 2;
      }
      const constraints = Array.isArray(values['constraint']) ? (values['constraint'] as string[]) : [];
      const result = await service.create({
        ...requestFrom(values),
        title: values['title'],
        ...(typeof values['goal'] === 'string' ? { goal: values['goal'] } : {}),
        ...(constraints.length > 0 ? { constraints } : {}),
        ...(typeof values['project-id'] === 'string' ? { projectId: values['project-id'] } : {}),
      });
      process.stdout.write(JSON.stringify({ command, ...result }) + '\n');
      return result.ok ? 0 : 1;
    }
    if (command === 'attach') {
      const root = positionals[1];
      if (root === undefined) {
        process.stderr.write('attach 需要资料根路径\n' + usage());
        return 2;
      }
      const kind = typeof values['kind'] === 'string' ? (values['kind'] as LocationKind) : undefined;
      const result = await service.attach(path.resolve(root), kind);
      process.stdout.write(JSON.stringify({ command, ...result }) + '\n');
      return result.ok ? 0 : 1;
    }
    process.stderr.write(`未知命令：${command}\n` + usage());
    return 2;
  } catch (error) {
    process.stderr.write(`资料命令执行失败：${(error as Error).message}\n`);
    return 2;
  }
}

process.exitCode = await main();
