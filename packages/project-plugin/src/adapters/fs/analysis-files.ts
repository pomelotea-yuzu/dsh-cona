// 分析范围的只读文件适配器（tasks 3.1-3.5，design「文件范围、枚举和读取凭证」）。
//
// 只做只读文件系统与只读 Git 查询：检查映射目录、枚举稳定顺序、跳过 Git 内部
// 与「被忽略的未跟踪」路径、取得内容指纹、稳定读取完整字节。
// 不读符号链接目标、不跟随链接、不写任何文件。

import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AnalysisLimits, ObservationEntry, ObservationExclusion, ObservationIssue, ScopeSelection } from '../../domain/analysis.js';
import type { Sha256Fn } from '../../domain/types.js';
import type {
  AnalysisEnumeration,
  AnalysisEnumerationResult,
  AnalysisFileBytesResult,
  AnalysisFilesPort,
  AnalysisRepositoryInspection,
} from '../../application/ports.js';
import { validateRelativePath } from '../../domain/relative-path.js';
import { resolveInScope } from './path-scope.js';
import { runGit } from './git-run.js';

export interface AnalysisFilesOptions {
  readonly sha256: Sha256Fn;
  readonly gitBin?: string;
  readonly timeoutMs?: number;
  /** 额外环境变量（如 GIT_CEILING_DIRECTORIES），测试用于隔离上溯查找。 */
  readonly env?: NodeJS.ProcessEnv;
}

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function issue(pathValue: string | null, code: string, message: string): ObservationIssue {
  return { path: pathValue, code, message };
}

/** 逐段判断路径是否进入 `.git`（只读分析不接受 Git 内部对象）。 */
function entersGitInternal(relativePath: string): boolean {
  return relativePath.split('/').includes('.git');
}

/** 按 UTF-16 码元比较，跨平台稳定；不依赖 locale。 */
function compareName(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createAnalysisFiles(options: AnalysisFilesOptions): AnalysisFilesPort {
  const sha256 = options.sha256;
  const bin = options.gitBin ?? 'git';
  const timeoutMs = options.timeoutMs ?? 2000;
  const git = (root: string, args: string[]) => runGit(bin, root, args, timeoutMs, options.env);

  const inspectRepository = async (absolutePath: string): Promise<AnalysisRepositoryInspection> => {
    let realRoot: string;
    try {
      realRoot = await realpath(absolutePath);
    } catch (error) {
      const code = errnoOf(error);
      if (code === 'ENOENT') return { ok: false, code: 'analysis-repository-missing', message: '仓库映射指向的目录不存在' };
      if (code === 'EACCES' || code === 'EPERM') return { ok: false, code: 'analysis-repository-permission-denied', message: '无权限访问仓库映射目录' };
      return { ok: false, code: 'analysis-repository-unreadable', message: (error as Error).message };
    }
    try {
      const info = await stat(realRoot);
      if (!info.isDirectory()) {
        return { ok: false, code: 'analysis-repository-not-directory', message: '仓库映射指向的不是目录' };
      }
    } catch (error) {
      return { ok: false, code: 'analysis-repository-unreadable', message: (error as Error).message };
    }
    const top = git(realRoot, ['rev-parse', '--show-toplevel']);
    if (!top.ok) return { ok: true, root: realRoot, git: null };
    const head = git(realRoot, ['rev-parse', 'HEAD']);
    return {
      ok: true,
      root: realRoot,
      git: { ...(head.ok && head.stdout.trim() !== '' ? { head: head.stdout.trim() } : {}) },
    };
  };

  const enumerate = async (
    root: string,
    scope: ScopeSelection,
    limits: AnalysisLimits,
  ): Promise<AnalysisEnumerationResult> => {
    const entries: ObservationEntry[] = [];
    const exclusions: ObservationExclusion[] = [];
    const issues: ObservationIssue[] = [];

    let startAbs: string;
    let prefix = '';
    let singleFile = false;
    if (scope.kind === 'root') {
      try {
        const info = await stat(root);
        if (!info.isDirectory()) return { ok: false, code: 'analysis-scope-not-directory', message: '仓库根不是目录' };
      } catch (error) {
        return { ok: false, code: 'analysis-scope-unreadable', message: (error as Error).message };
      }
      startAbs = root;
    } else {
      const checked = validateRelativePath(scope.path);
      if (!checked.ok) return { ok: false, code: `analysis-${checked.error.code}`, message: checked.error.message };
      if (entersGitInternal(scope.path)) {
        return { ok: false, code: 'analysis-scope-git-internal', message: '不接受 Git 内部对象作为分析范围' };
      }
      const resolved = await resolveInScope(root, scope.path, {
        mode: 'read',
        target: scope.kind === 'file' ? 'file' : 'directory',
      });
      if (!resolved.ok) {
        const first = resolved.issues[0];
        return { ok: false, code: first?.code ?? 'analysis-scope-unreadable', message: first?.message ?? '范围不可读' };
      }
      startAbs = resolved.absolutePath;
      prefix = scope.path;
      singleFile = scope.kind === 'file';
    }

    // Git 观察：仓库根与 HEAD 只作附注；被忽略的未跟踪路径不进入观察内容。
    const ignored = new Set<string>();
    let gitState: AnalysisEnumeration['git'];
    const top = git(root, ['rev-parse', '--show-toplevel']);
    if (!top.ok) {
      gitState = { status: 'unavailable', reason: gitUnavailableReason(top) };
    } else {
      const headOut = git(root, ['rev-parse', 'HEAD']);
      const head = headOut.ok && headOut.stdout.trim() !== '' ? headOut.stdout.trim() : undefined;
      gitState = { status: 'observed', ...(head === undefined ? {} : { head }) };
      const ignoredOut = git(root, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard']);
      if (!ignoredOut.ok) {
        issues.push(issue(null, 'analysis-git-ignored-unavailable', '无法读取 Git 忽略清单，本次观察可能包含被忽略路径'));
      } else {
        for (const item of ignoredOut.stdout.split('\0')) {
          if (item !== '') ignored.add(item);
        }
      }
    }

    let scanned = 0;
    let truncated = false;

    const observeFile = async (absolutePath: string, relativePath: string): Promise<void> => {
      let before;
      try {
        before = await lstat(absolutePath);
      } catch (error) {
        issues.push(issue(relativePath, 'analysis-file-unreadable', (error as Error).message));
        return;
      }
      if (!before.isFile()) {
        exclusions.push({ path: relativePath, reason: 'special-file' });
        return;
      }
      if (before.size > limits.fileBytes) {
        entries.push({ path: relativePath, kind: 'file', bytes: before.size, hash: null });
        issues.push(issue(relativePath, 'analysis-file-too-large', `文件 ${before.size} 字节超过单文件上限 ${limits.fileBytes}`));
        return;
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(absolutePath));
      } catch (error) {
        const code = errnoOf(error);
        issues.push(issue(
          relativePath,
          code === 'EACCES' || code === 'EPERM' ? 'analysis-file-permission-denied' : 'analysis-file-unreadable',
          (error as Error).message,
        ));
        return;
      }
      // 读取后复核：同一路径在观察期间被替换/改写时不给内容指纹，观察不完整。
      try {
        const after = await lstat(absolutePath);
        if (!after.isFile() || after.size !== bytes.length || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) {
          issues.push(issue(relativePath, 'analysis-file-changed', '观察期间文件发生变化，未取得可信内容指纹'));
          return;
        }
      } catch (error) {
        issues.push(issue(relativePath, 'analysis-file-changed', (error as Error).message));
        return;
      }
      entries.push({ path: relativePath, kind: 'file', bytes: bytes.length, hash: sha256(bytes) });
    };

    const walk = async (directory: string, directoryPrefix: string): Promise<boolean> => {
      let children;
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        const code = errnoOf(error);
        issues.push(issue(
          directoryPrefix === '' ? null : directoryPrefix,
          code === 'EACCES' || code === 'EPERM' ? 'analysis-directory-permission-denied' : 'analysis-directory-unreadable',
          (error as Error).message,
        ));
        return false;
      }
      children.sort((left, right) => compareName(left.name, right.name));
      for (const child of children) {
        const relativePath = directoryPrefix === '' ? child.name : `${directoryPrefix}/${child.name}`;
        if (child.name === '.git') {
          exclusions.push({ path: relativePath, reason: 'git-internal' });
          continue;
        }
        if (child.isDirectory()) {
          if (await walk(path.join(directory, child.name), relativePath)) return true;
          continue;
        }
        // 扫描项数按「非目录项」计：文件、链接、特殊文件都占额度，避免大量排除项绕过上限。
        scanned += 1;
        if (scanned > limits.scanEntries) {
          truncated = true;
          return true;
        }
        if (child.isSymbolicLink()) {
          exclusions.push({ path: relativePath, reason: 'symlink' });
          continue;
        }
        if (!child.isFile()) {
          exclusions.push({ path: relativePath, reason: 'special-file' });
          continue;
        }
        if (ignored.has(relativePath)) {
          exclusions.push({ path: relativePath, reason: 'git-ignored' });
          continue;
        }
        await observeFile(path.join(directory, child.name), relativePath);
      }
      return false;
    };

    if (singleFile) {
      const base = path.basename(startAbs);
      const relativePath = prefix !== '' ? prefix : base;
      if (ignored.has(relativePath)) {
        exclusions.push({ path: relativePath, reason: 'git-ignored' });
      } else {
        scanned += 1;
        await observeFile(startAbs, relativePath);
      }
    } else {
      await walk(startAbs, prefix);
    }

    const value: AnalysisEnumeration = {
      entries,
      exclusions,
      issues,
      truncated,
      git: gitState,
    };
    return { ok: true, value };
  };

  const readBytes = async (
    root: string,
    relativePath: string,
    limits: AnalysisLimits,
    readOptions: { readonly readBytes?: (absolutePath: string) => Promise<Uint8Array> } = {},
  ): Promise<AnalysisFileBytesResult> => {
    const resolved = await resolveInScope(root, relativePath, { mode: 'read', target: 'file' });
    if (!resolved.ok) {
      const first = resolved.issues[0];
      return { ok: false, code: first?.code ?? 'analysis-file-unreadable', message: first?.message ?? '文件不可读' };
    }
    let before;
    try {
      before = await lstat(resolved.absolutePath);
      if (before.size > limits.fileBytes) {
        return {
          ok: false,
          code: 'analysis-file-too-large',
          message: `文件 ${before.size} 字节超过单文件上限 ${limits.fileBytes}`,
        };
      }
    } catch (error) {
      return { ok: false, code: 'analysis-file-unreadable', message: (error as Error).message };
    }

    const reader = readOptions.readBytes ?? (async (absolutePath: string) => new Uint8Array(await readFile(absolutePath)));
    let first: Uint8Array;
    let second: Uint8Array;
    try {
      first = await reader(resolved.absolutePath);
      second = await reader(resolved.absolutePath);
    } catch (error) {
      const code = errnoOf(error);
      return {
        ok: false,
        code: code === 'EACCES' || code === 'EPERM' ? 'analysis-file-permission-denied' : 'analysis-file-unreadable',
        message: (error as Error).message,
      };
    }
    const fullHash = sha256(first);
    if (fullHash !== sha256(second)) {
      return { ok: false, code: 'analysis-file-changed', message: '读取期间文件内容发生变化' };
    }
    const again = await resolveInScope(root, relativePath, { mode: 'read', target: 'file' });
    let after;
    try {
      after = await lstat(resolved.absolutePath);
    } catch (error) {
      return { ok: false, code: 'analysis-file-changed', message: (error as Error).message };
    }
    if (!again.ok || again.absolutePath !== resolved.absolutePath
      || after.size !== first.length || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) {
      return { ok: false, code: 'analysis-file-changed', message: '读取前后路径或文件元数据发生变化' };
    }
    return { ok: true, value: { bytes: first, absolutePath: resolved.absolutePath, fullHash } };
  };

  const decodeText = (bytes: Uint8Array): { ok: true; text: string } | { ok: false; code: 'analysis-file-non-text'; message: string } => {
    if (bytes.subarray(0, 8192).includes(0)) {
      return { ok: false, code: 'analysis-file-non-text', message: '文件含 NUL 字节，按非文本处理' };
    }
    try {
      return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
    } catch {
      return { ok: false, code: 'analysis-file-non-text', message: '文件不是合法 UTF-8 文本' };
    }
  };

  return { inspectRepository, enumerate, readBytes, decodeText };
}

function gitUnavailableReason(run: { errorCode?: string; status: number | null }): string {
  if (run.errorCode === 'ENOENT') return 'git-unavailable';
  if (run.errorCode === 'ETIMEDOUT') return 'git-timeout';
  if (run.status === 128 || run.status === 129) return 'not-a-repository';
  return 'git-unavailable';
}
