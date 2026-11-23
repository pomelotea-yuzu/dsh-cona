// Git 历史只读核对适配器（tasks 1.3）：验证候选 HEAD 是否为真实历史 commit，
// 并逐字节比对历史 commit 树内的公开文件。只读：不 checkout、不 reset、不写任何引用。

import { execFileSync } from 'node:child_process';
import { runGit, type GitRun } from './git-run.js';

export interface GitHistoryOptions {
  gitBin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface GitHistory {
  /** commit 存在且可解析。 */
  commitExists(commit: string): boolean;
  /** commit 是否为另一个 commit 的祖先（含相等）。 */
  isAncestor(ancestor: string, descendant: string): boolean | 'unknown';
  /** 读历史 commit 树内指定相对路径的字节；不存在或不可读返回 null。 */
  commitFileBytes(commit: string, relativePath: string): Uint8Array | null;
}

/** 资料根在仓库内的相对目录（用于把资料根相对路径换算成仓库相对路径）。 */
export function repoRelativePrefix(root: string, repositoryRoot: string): string {
  if (root === repositoryRoot) return '';
  const rel = root.startsWith(repositoryRoot + '/') ? root.slice(repositoryRoot.length + 1) : null;
  return rel === null ? '' : rel + '/';
}

export function createGitHistory(root: string, options: GitHistoryOptions = {}): GitHistory {
  const bin = options.gitBin ?? 'git';
  const timeoutMs = options.timeoutMs ?? 5000;
  const git = (args: string[]): GitRun => runGit(bin, root, args, timeoutMs, options.env);

  // 逐字节读历史文件：不经字符串解码，保证哈希比对与磁盘字节一致。
  const gitBuffer = (args: string[]): Buffer | null => {
    try {
      return execFileSync(bin, args, {
        cwd: root,
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
      }) as Buffer;
    } catch {
      return null;
    }
  };

  const fullHash = (commit: string): string | null => {
    const probe = git(['rev-parse', '--verify', '--end-of-options', commit + '^{}']);
    if (!probe.ok) return null;
    const value = probe.stdout.trim();
    return /^[0-9a-f]{40}$/.test(value) ? value : null;
  };

  return {
    commitExists(commit) {
      return fullHash(commit) !== null;
    },
    isAncestor(ancestor, descendant) {
      const a = fullHash(ancestor);
      const d = fullHash(descendant);
      if (a === null || d === null) return 'unknown';
      const check = git(['merge-base', '--is-ancestor', a, d]);
      if (check.ok) return true;
      if (check.status === 1) return false;
      return 'unknown';
    },
    commitFileBytes(commit, relativePath) {
      const normalized = relativePath.replace(/^\/+/, '');
      const resolved = fullHash(commit);
      if (resolved === null) return null;
      const bytes = gitBuffer(['show', `${resolved}:./${normalized}`]);
      return bytes === null ? null : new Uint8Array(bytes);
    },
  };
}
