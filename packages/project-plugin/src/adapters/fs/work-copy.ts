// 工作副本只读观察适配器（tasks 3.2 第三段）：按实例配置的工作副本根读取
// HEAD commit id 与工作区未提交条目数，排除实例公开资料目录下的条目。
// 只执行只读 git 查询（rev-parse/status），不做 add/commit/checkout/config 等写操作；
// 排除资料目录是为了只呈现"代码"变化，不把本实例自己的公开资料写入计入观察。

import path from 'node:path';
import { runGit, type GitRun } from './git-run.js';

/** 工作副本观察结果：observed 携带 HEAD 与排除资料目录后的未提交条目数。 */
export type WorkCopyObservation =
  | { status: 'observed'; head: string; dirtyCount: number }
  | { status: 'unavailable'; reason: string };

export interface WorkCopyOptions {
  gitBin?: string;
  timeoutMs?: number;
  /** 额外环境变量（如 GIT_CEILING_DIRECTORIES），测试用于隔离上溯查找。 */
  env?: NodeJS.ProcessEnv;
}

/** porcelain 行的路径段：取状态码之后；rename 行取 `->` 前的源路径。 */
function pathPortion(line: string): string {
  let rel = line.slice(3).trim();
  const renameAt = rel.indexOf(' -> ');
  if (renameAt >= 0) rel = rel.slice(0, renameAt);
  // git 对含空格路径加引号；只做保守去引号，不做转义还原（观察计数允许保守）。
  if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);
  return rel;
}

/**
 * 观察工作副本：HEAD + 工作区脏计数（排除 excludeRoots 下的条目）。
 * 任何探测失败都返回 unavailable，不猜测；调用方据此显示"代码未核对"。
 */
export function observeWorkCopy(
  root: string,
  excludeRoots: readonly string[],
  options: WorkCopyOptions = {},
): WorkCopyObservation {
  const bin = options.gitBin ?? 'git';
  const timeoutMs = options.timeoutMs ?? 2000;
  const git = (args: string[]): GitRun => runGit(bin, root, args, timeoutMs, options.env);
  const top = git(['rev-parse', '--show-toplevel']);
  if (!top.ok) return { status: 'unavailable', reason: 'not-a-work-copy' };
  const head = git(['rev-parse', 'HEAD']);
  if (!head.ok) return { status: 'unavailable', reason: 'no-commits' };
  const status = git(['status', '--porcelain', '--', '.']);
  if (!status.ok) return { status: 'unavailable', reason: 'status-failed' };
  const excludes = excludeRoots.map((item) => path.resolve(item));
  let dirtyCount = 0;
  for (const line of status.stdout.split('\n')) {
    if (line.trim() === '') continue;
    const abs = path.resolve(root, pathPortion(line));
    if (excludes.some((base) => abs === base || abs.startsWith(base + path.sep))) continue;
    dirtyCount += 1;
  }
  return { status: 'observed', head: head.stdout.trim(), dirtyCount };
}
