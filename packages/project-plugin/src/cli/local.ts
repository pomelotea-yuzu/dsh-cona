// 本机根与注册表命令（tasks 3.2；1.1–1.3 扩展）：纯 Node，无 DSH 服务。
// 用法：
//   local.js root    (--dsh-home <dir> | --local-root <dir>) [--source <资料根>]
//   local.js register --local-root <dir> --source <资料根> --project-id <uuid> --kind <kind>
//                     [--map <repositoryId>=<本机绝对路径>]...
//   local.js list    --local-root <dir>
//   local.js show    --local-root <dir> --instance <instanceId>
//   local.js preview-refresh --local-root <dir> --instance <instanceId> --source <资料根>
//   local.js refresh --local-root <dir> --instance <instanceId> --source <资料根>
//                    [--preview-file <preview-refresh 输出 JSON>] [--confirm-fallback]
//   local.js diagnostics --local-root <dir> --instance <instanceId>
//   local.js unisolate --local-root <dir> --instance <instanceId> --confirm offline-reviewed
//   local.js quarantined --local-root <dir>
//   local.js release-lock --local-root <dir> (--force | --token <token>)
// 输出一行 JSON；失败退出码 1，用法错误 2。
// 不写公开资料、不执行 Git 提交；遗留锁必须显式释放，不自动按超时抢占。

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readSourceBaseline } from '../application/baseline.js';
import { ProjectCommandService } from '../application/command-service.js';
import { LocalStateService } from '../application/local-state.js';
import type { RefreshPreview } from '../application/local-state.js';
import type { LocationKind } from '../application/location.js';
import { LocalStateStore } from '../adapters/fs/local-state.js';
import { inspectPrivateRoot } from '../adapters/fs/git-guard.js';
import { readGitStatus } from '../adapters/fs/git-status.js';
import { createGitHistory } from '../adapters/fs/git-history.js';
import { resolveLocalRoot, rootRelation } from '../adapters/fs/local-root.js';
import { createSourceFiles } from '../adapters/fs/source-files.js';
import type { Sha256Fn } from '../domain/types.js';

const sha256: Sha256Fn = (bytes) => createHash('sha256').update(bytes).digest('hex');

function usage(): string {
  return [
    '用法:',
    '  local.js root    (--dsh-home <dir> | --local-root <dir>) [--source <资料根>]',
    '  local.js register --local-root <dir> --source <资料根> --project-id <uuid> --kind <kind>',
    '                    [--map <repositoryId>=<本机绝对路径>]...',
    '  local.js list    --local-root <dir>',
    '  local.js show    --local-root <dir> --instance <instanceId>',
    '  local.js preview-refresh --local-root <dir> --instance <instanceId> --source <资料根>',
    '  local.js refresh --local-root <dir> --instance <instanceId> --source <资料根>',
    '                    [--preview-file <preview-refresh 输出 JSON>] [--confirm-fallback]',
    '  local.js diagnostics --local-root <dir> --instance <instanceId>',
    '  local.js unisolate --local-root <dir> --instance <instanceId> --confirm offline-reviewed',
    '  local.js quarantined --local-root <dir>',
    '  local.js release-lock --local-root <dir> (--force | --token <token>)',
  ].join('\n') + '\n';
}

function buildService(): LocalStateService {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const files = createSourceFiles(path.join(packageRoot, 'formats', 'v1'), sha256);
  return new LocalStateService({
    resolver: { resolveLocal: resolveLocalRoot, relation: rootRelation },
    git: { inspect: inspectPrivateRoot },
    store: new LocalStateStore(),
    clock: () => new Date().toISOString(),
    newInstanceId: () => randomUUID(),
    readBaseline: (sourceRoot: string) => readSourceBaseline(files, sourceRoot, sha256, () => new Date().toISOString()),
    gitObserve: (sourceRoot: string) => {
      const view = readGitStatus(sourceRoot, { projectFile: 'project.json' });
      return {
        available: view.available,
        repositoryRoot: view.repositoryRoot,
        headCommit: view.headCommit,
        branch: view.branch,
        unmerged: view.unmerged,
        dirty: view.dirty,
      };
    },
    gitHistory: (sourceRoot: string) => createGitHistory(sourceRoot),
    sha256,
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
      instance: { type: 'string' },
      token: { type: 'string' },
      confirm: { type: 'string' },
      map: { type: 'string', multiple: true },
      'preview-file': { type: 'string' },
      'confirm-fallback': { type: 'boolean', default: false },
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
      const repositoryMaps = (values['map'] ?? [])
        .map((item) => {
          const eq = item.indexOf('=');
          return eq > 0
            ? { repositoryId: item.slice(0, eq).trim(), absolutePath: item.slice(eq + 1).trim() }
            : null;
        })
        .filter((item): item is { repositoryId: string; absolutePath: string } => item !== null);
      const result = await service.register({
        localDataRoot: values['local-root'],
        sourceRoot: values['source'],
        sourceKind: values['kind'] as LocationKind,
        projectId: values['project-id'],
        ...(repositoryMaps.length > 0 ? { repositoryMaps } : {}),
      });
      process.stdout.write(JSON.stringify({ command, ...result }) + '\n');
      return result.ok ? 0 : 1;
    }
    if (command === 'preview-refresh') {
      if (
        typeof values['local-root'] !== 'string' ||
        typeof values['instance'] !== 'string' ||
        typeof values['source'] !== 'string'
      ) {
        process.stderr.write('preview-refresh 需要 --local-root、--instance 与 --source\n' + usage());
        return 2;
      }
      const result = await service.previewRefresh({
        localDataRoot: values['local-root'],
        instanceId: values['instance'],
        source: path.resolve(values['source']),
      });
      process.stdout.write(JSON.stringify({ command, ...result }) + '\n');
      return result.ok ? 0 : 1;
    }
    if (command === 'refresh') {
      if (
        typeof values['local-root'] !== 'string' ||
        typeof values['instance'] !== 'string' ||
        typeof values['source'] !== 'string'
      ) {
        process.stderr.write('refresh 需要 --local-root、--instance 与 --source\n' + usage());
        return 2;
      }
      const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
      const files = createSourceFiles(path.join(packageRoot, 'formats', 'v1'), sha256);
      const baseline = await readSourceBaseline(files, path.resolve(values['source']), sha256, () => new Date().toISOString());
      if (!baseline.ok) {
        process.stdout.write(JSON.stringify({ command, ok: false, issues: baseline.issues }) + '\n');
        return 1;
      }
      // 1.2／1.3：提供预览文件时走「预览→接纳」两步；观察失配与停写诊断由服务在锁内核对。
      let preview: RefreshPreview | undefined;
      const previewFile = values['preview-file'];
      if (typeof previewFile === 'string') {
        const parsed = JSON.parse(readFileSync(previewFile, 'utf8')) as {
          ok?: unknown;
          candidate?: { headHash?: string; records?: RefreshPreview['records'] };
          diagnostics?: RefreshPreview['diagnostics'];
          fallback?: RefreshPreview['fallback'];
        };
        if (parsed.ok !== true || typeof parsed.candidate !== 'object' || parsed.candidate === null) {
          process.stderr.write('preview-file 必须是成功的 preview-refresh 输出 JSON\n');
          return 2;
        }
        preview = {
          headHash: parsed.candidate.headHash ?? '',
          records: parsed.candidate.records ?? [],
          diagnostics: parsed.diagnostics ?? [],
          ...(parsed.fallback !== undefined && parsed.fallback !== null ? { fallback: parsed.fallback } : {}),
        };
      }
      const result = await service.refresh({
        localDataRoot: values['local-root'],
        instanceId: values['instance'],
        baseline: baseline.baseline,
        ...(preview !== undefined ? { preview } : {}),
        ...(values['confirm-fallback'] === true && preview?.fallback !== undefined
          ? { confirmFallback: { commit: preview.fallback.commit } }
          : {}),
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
    if (command === 'diagnostics') {
      const localRoot = values['local-root'];
      const instanceId = values['instance'];
      if (typeof localRoot !== 'string' || typeof instanceId !== 'string') {
        process.stderr.write('diagnostics 需要 --local-root 与 --instance\n' + usage());
        return 2;
      }
      // 只读诊断不写文件；本机 CLI 视为 owner 语境，将来经 Remote 暴露时需另加准入。
      const commandService = new ProjectCommandService({
        localRoot,
        store: new LocalStateStore(),
        files: createSourceFiles(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'formats', 'v1'), sha256),
        sha256,
        clock: () => new Date().toISOString(),
        newNodeId: () => randomUUID(),
        newRecordId: () => randomUUID(),
      });
      const report = await commandService.diagnostics(instanceId);
      process.stdout.write(JSON.stringify({ command, ok: true, ...report }) + '\n');
      return 0;
    }
    if (command === 'unisolate') {
      const localRoot = values['local-root'];
      const instanceId = values['instance'];
      if (typeof localRoot !== 'string' || typeof instanceId !== 'string') {
        process.stderr.write('unisolate 需要 --local-root 与 --instance\n' + usage());
        return 2;
      }
      if (values['confirm'] !== 'offline-reviewed') {
        process.stdout.write(
          JSON.stringify({
            command,
            ok: false,
            issues: [
              {
                code: 'quarantine-release-unconfirmed',
                message: '必须确认已人工核对：--confirm offline-reviewed；本插件不提供一键忽略',
              },
            ],
          }) + '\n',
        );
        return 1;
      }
      const released = await new LocalStateStore().releaseQuarantine(localRoot, instanceId);
      process.stdout.write(JSON.stringify({ command, ok: true, released }) + '\n');
      return 0;
    }
    if (command === 'quarantined') {
      const localRoot = values['local-root'];
      if (typeof localRoot !== 'string') {
        process.stderr.write('quarantined 需要 --local-root\n' + usage());
        return 2;
      }
      const entries = await new LocalStateStore().listQuarantined(localRoot);
      process.stdout.write(JSON.stringify({ command, ok: true, entries }) + '\n');
      return 0;
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
