// 资料根范围与路径校验（tasks 3.3，design §4）。
// 规则：相对引用按 `/` 分段协议校验；逐段拒绝符号链接；最终目标必须是常规文件（或目录）；
// 写目标拒绝多硬链接；realpath 复核最终位置仍在根内。只用 node:fs / node:path。

import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { validateRelativePath } from '../../domain/relative-path.js';

export interface ScopeIssue {
  code: string;
  message: string;
  path?: string;
}

export interface ScopeOptions {
  /** read：目标必须存在；write：允许目标及其尾部不存在（用于新建）。 */
  mode?: 'read' | 'write';
  /** 期望的最终目标类型；默认 file。 */
  target?: 'file' | 'directory' | 'any';
}

export interface ScopeSuccess {
  ok: true;
  /** 解析后的根（realpath）。 */
  root: string;
  /** 根内绝对路径（不改变用户书写的大小写）。 */
  absolutePath: string;
  /** 目标存在时的 lstat 结果。 */
  info: Awaited<ReturnType<typeof lstat>> | null;
}

export type ScopeResult = ScopeSuccess | { ok: false; issues: ScopeIssue[] };

const MAX_BYTES_DEFAULT = 8 * 1024 * 1024;

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/**
 * 把资料根内的相对引用解析为绝对路径，并在读取前核对范围：
 * 逐段 lstat 拒绝 symlink、中间段必须是目录、最终目标类型符合期望、写目标不得有多个硬链接。
 */
export async function resolveInScope(root: string, relativePath: string, options: ScopeOptions = {}): Promise<ScopeResult> {
  const checked = validateRelativePath(relativePath);
  if (!checked.ok) {
    return { ok: false, issues: [{ code: `scope-${checked.error.code}`, message: checked.error.message, path: relativePath }] };
  }
  const mode = options.mode ?? 'read';
  const target = options.target ?? 'file';

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ENOENT') {
      return { ok: false, issues: [{ code: 'scope-root-missing', message: '资料根不存在', path: root }] };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false, issues: [{ code: 'scope-permission-denied', message: '无权限访问资料根', path: root }] };
    }
    return { ok: false, issues: [{ code: 'scope-root-unreadable', message: (error as Error).message, path: root }] };
  }

  let current = realRoot;
  let finalInfo: ScopeSuccess['info'] = null;
  for (let index = 0; index < checked.segments.length; index += 1) {
    const segment = checked.segments[index] as string;
    const isLast = index === checked.segments.length - 1;
    const candidate = path.join(current, segment);
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      const code = errnoOf(error);
      if (code === 'ENOENT') {
        if (mode === 'write') {
          // 写入允许尾部不存在；继续拼接（不存在的段之后必然也不存在）。
          current = candidate;
          continue;
        }
        return { ok: false, issues: [{ code: 'scope-not-found', message: '引用的文件不存在', path: relativePath }] };
      }
      if (code === 'EACCES' || code === 'EPERM') {
        return { ok: false, issues: [{ code: 'scope-permission-denied', message: '无权限读取该路径', path: relativePath }] };
      }
      return { ok: false, issues: [{ code: 'scope-unreadable', message: (error as Error).message, path: relativePath }] };
    }
    if (info.isSymbolicLink()) {
      return {
        ok: false,
        issues: [{ code: 'scope-symlink', message: '资料树内不接受符号链接（逐段检查）', path: relativePath }],
      };
    }
    if (!isLast) {
      if (!info.isDirectory()) {
        return {
          ok: false,
          issues: [{ code: 'scope-not-directory', message: '引用的中间段不是目录', path: relativePath }],
        };
      }
    } else {
      if (target === 'file' && !info.isFile()) {
        return {
          ok: false,
          issues: [{ code: 'scope-not-regular-file', message: '目标不是常规文件', path: relativePath }],
        };
      }
      if (target === 'directory' && !info.isDirectory()) {
        return { ok: false, issues: [{ code: 'scope-not-directory', message: '目标不是目录', path: relativePath }] };
      }
      if (mode === 'write' && info.isFile() && info.nlink > 1) {
        return {
          ok: false,
          issues: [
            {
              code: 'scope-hardlink',
              message: `写目标有 ${info.nlink} 个硬链接，拒绝写入可能影响树外内容`,
              path: relativePath,
            },
          ],
        };
      }
      finalInfo = info;
    }
    current = candidate;
  }

  // realpath 复核：即使逐段已拒绝 symlink，也用系统解析结果确认最终位置仍在根内。
  try {
    const resolved = await realpath(current);
    if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) {
      return {
        ok: false,
        issues: [{ code: 'scope-escape', message: '解析后的路径超出资料根', path: relativePath }],
      };
    }
  } catch (error) {
    const code = errnoOf(error);
    if (!(code === 'ENOENT' && mode === 'write')) {
      return { ok: false, issues: [{ code: 'scope-unreadable', message: (error as Error).message, path: relativePath }] };
    }
  }

  return { ok: true, root: realRoot, absolutePath: current, info: finalInfo };
}

export type ScopedReadResult =
  | { ok: true; bytes: Uint8Array; absolutePath: string }
  | { ok: false; issues: ScopeIssue[] };

/** 读取资料根内的常规文件；超限或范围不合法时拒绝，不读部分内容。 */
export async function readInScope(
  root: string,
  relativePath: string,
  options: { maxBytes?: number } = {},
): Promise<ScopedReadResult> {
  const maxBytes = options.maxBytes ?? MAX_BYTES_DEFAULT;
  const scoped = await resolveInScope(root, relativePath, { mode: 'read', target: 'file' });
  if (!scoped.ok) return scoped;
  try {
    const info = await stat(scoped.absolutePath);
    if (info.size > maxBytes) {
      return {
        ok: false,
        issues: [{ code: 'scope-too-large', message: `文件超过读取上限 ${maxBytes} 字节`, path: relativePath }],
      };
    }
    return { ok: true, bytes: new Uint8Array(await readFile(scoped.absolutePath)), absolutePath: scoped.absolutePath };
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false, issues: [{ code: 'scope-permission-denied', message: '无权限读取该文件', path: relativePath }] };
    }
    return { ok: false, issues: [{ code: 'scope-unreadable', message: (error as Error).message, path: relativePath }] };
  }
}

/** 列出根内某目录的直接子条目（不跟随 symlink）；用于发现记录正文。 */
export async function listInScopeDirectory(
  root: string,
  relativePath: string,
): Promise<{ ok: true; entries: { name: string; isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean }[] } | { ok: false; issues: ScopeIssue[] }> {
  const scoped = await resolveInScope(root, relativePath, { mode: 'read', target: 'directory' });
  if (!scoped.ok) return scoped;
  try {
    const entries = await readdir(scoped.absolutePath, { withFileTypes: true });
    return {
      ok: true,
      entries: entries
        .map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isFile: entry.isFile(),
          isSymbolicLink: entry.isSymbolicLink(),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    };
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false, issues: [{ code: 'scope-permission-denied', message: '无权限列出该目录', path: relativePath }] };
    }
    return { ok: false, issues: [{ code: 'scope-unreadable', message: (error as Error).message, path: relativePath }] };
  }
}

/**
 * 检测目录内仅大小写不同的条目（Git 在不同大小写敏感度的文件系统间交换时出现）。
 * 只报告，不重命名；平台是否允许这种目录由实际文件系统决定。
 */
export async function findCaseConflicts(
  directory: string,
): Promise<{ ok: true; conflicts: { name: string; variants: string[] }[] } | { ok: false; issues: ScopeIssue[] }> {
  try {
    const entries = await readdir(directory);
    const groups = new Map<string, string[]>();
    for (const name of entries) {
      const key = name.toLowerCase();
      const list = groups.get(key);
      if (list === undefined) groups.set(key, [name]);
      else list.push(name);
    }
    const conflicts = [...groups.entries()]
      .filter(([, variants]) => variants.length > 1)
      .map(([key, variants]) => ({ name: key, variants: [...variants].sort() }));
    return { ok: true, conflicts };
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ENOENT') return { ok: true, conflicts: [] };
    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false, issues: [{ code: 'scope-permission-denied', message: '无权限列出目录', path: directory }] };
    }
    return { ok: false, issues: [{ code: 'scope-unreadable', message: (error as Error).message, path: directory }] };
  }
}
