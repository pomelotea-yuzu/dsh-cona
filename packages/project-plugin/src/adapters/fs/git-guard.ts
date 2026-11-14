// 私有根检查（tasks 3.2）：本机运行根若落在 Git 工作副本内，必须处于不跟踪区域。
// 只读：ls-files / check-ignore / rev-parse；不改 .gitignore、不 add。

import path from 'node:path';
import type { PrivateRootCheck } from '../../application/local-state.js';
import { runGit } from './git-run.js';

export interface GitGuardOptions {
  gitBin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * 判断本机根是否可安全承载私有数据：
 * - 不在仓库内：可写，`checked: true`；
 * - 在仓库内：必须无已跟踪文件且被 ignore 覆盖，否则由调用方拒绝；
 * - git 不可用：`checked: false`，调用方不得把它显示成“已核查安全”。
 */
export function inspectPrivateRoot(localRoot: string, options: GitGuardOptions = {}): PrivateRootCheck {
  const bin = options.gitBin ?? 'git';
  const timeoutMs = options.timeoutMs ?? 2000;
  const git = (args: string[]) => runGit(bin, localRoot, args, timeoutMs, options.env);

  const top = git(['rev-parse', '--show-toplevel']);
  if (!top.ok) {
    return { inRepository: false, trackedFiles: [], ignored: 'unknown', checked: false };
  }
  const repositoryRoot = top.stdout.trim();
  const relative = path.relative(repositoryRoot, path.resolve(localRoot));
  const gitPath = relative === '' ? '.' : relative.split(path.sep).join('/');

  // tracked：cwd 为 localRoot，pathspec 用 `.`（相对 cwd，不能用仓库相对路径，否则会拼错层级）。
  const tracked = runGit(bin, localRoot, ['ls-files', '--', '.'], timeoutMs, options.env);
  const trackedFiles =
    tracked.ok && tracked.stdout.trim() !== ''
      ? tracked.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '')
      : [];

  if (trackedFiles.length > 0) {
    return { inRepository: true, repositoryRoot, trackedFiles, ignored: 'unknown', checked: true };
  }

  // ignored：cwd 为仓库根，pathspec 用仓库相对路径（目录规则只在正确层级匹配）。
  const checkIgnore = (target: string) => runGit(bin, repositoryRoot, ['check-ignore', '-q', '--', target], timeoutMs, options.env);
  let ignored: boolean | 'unknown' = 'unknown';
  const direct = checkIgnore(gitPath);
  if (direct.ok) {
    ignored = true;
  } else if (direct.status === 1) {
    // 目录规则（如 `ignored-local/`）只在带尾斜杠的其中一种形式上匹配，两种都试。
    const withSlash = checkIgnore(gitPath.endsWith('/') ? gitPath : `${gitPath}/`);
    if (withSlash.ok) ignored = true;
    else if (withSlash.status === 1) ignored = false;
  }
  return { inRepository: true, repositoryRoot, trackedFiles, ignored, checked: ignored !== 'unknown' };
}
