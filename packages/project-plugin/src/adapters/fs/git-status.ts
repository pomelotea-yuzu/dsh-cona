// Git 只读观察适配器（tasks 3.1）：只查询仓库位置、跟踪／忽略状态与工作区脏状态。
// 不执行 add／commit／checkout／config 等写操作；不因发现仓库元信息就改变资料位置。

import os from 'node:os';
import type { GitStateView, GitTrackState } from '../../application/ports.js';
import { runGit, type GitRun } from './git-run.js';
import { toDisplayPath } from './location.js';

export interface GitStatusOptions {
  gitBin?: string;
  timeoutMs?: number;
  homeDir?: string;
  /** 用于判断跟踪状态的相对路径；默认 project.json。 */
  projectFile?: string;
  /** 额外环境变量（如 GIT_CEILING_DIRECTORIES），测试用于隔离上溯查找。 */
  env?: NodeJS.ProcessEnv;
}

/**
 * 读取资料根的 Git 状态。`available` 表示 root 位于某个 Git 工作树内；
 * 资料根本身可以不是仓库根，跟踪状态按 `projectFile` 相对 root 判断。
 * 任何探测失败都返回 unknown，不猜测。
 */
export function readGitStatus(root: string, options: GitStatusOptions = {}): GitStateView {
  const bin = options.gitBin ?? 'git';
  const timeoutMs = options.timeoutMs ?? 2000;
  const projectFile = options.projectFile ?? 'project.json';
  const git = (args: string[]): GitRun => runGit(bin, root, args, timeoutMs, options.env);

  const top = git(['rev-parse', '--show-toplevel']);
  if (!top.ok) {
    const reason =
      top.errorCode === 'ENOENT' ? 'git-unavailable' : top.errorCode === 'ETIMEDOUT' ? 'probe-failed' : 'not-a-repository';
    return { available: false, trackState: 'unknown', dirty: 'unknown', reason };
  }
  const repositoryRoot = top.stdout.trim();
  const repositoryRootDisplay = toDisplayPath(repositoryRoot, options.homeDir ?? os.homedir());

  let trackState: GitTrackState = 'unknown';
  const tracked = git(['ls-files', '--error-unmatch', '--', projectFile]);
  if (tracked.ok) {
    trackState = 'tracked';
  } else if (tracked.status === 1) {
    const ignored = git(['check-ignore', '-q', '--', projectFile]);
    if (ignored.ok) trackState = 'ignored';
    else trackState = ignored.status === 1 ? 'untracked' : 'unknown';
  }

  let dirty: boolean | 'unknown' = 'unknown';
  const status = git(['status', '--porcelain', '--', '.']);
  if (status.ok) dirty = status.stdout.trim() !== '';

  return { available: true, repositoryRoot, repositoryRootDisplay, trackState, dirty };
}
