// 本机根解析（tasks 3.2）：把 planLocalRoot 的分段落实为绝对路径，并判断两个根的关系。
// 与资料位置共用输入规则；realpath／大小写／符号链接细化在 3.3。

import os from 'node:os';
import path from 'node:path';
import type { LocalRootPlan, LocalRootView } from '../../application/local-state.js';
import type { LocalIssue, RootRelation } from '../../application/ports.js';
import { toDisplayPath, validateAbsoluteInput } from './location.js';

export interface LocalRootAdapterOptions {
  homeDir?: string;
}

export function resolveLocalRoot(
  plan: LocalRootPlan,
  options: LocalRootAdapterOptions = {},
): { ok: true; root: LocalRootView } | { ok: false; issues: LocalIssue[] } {
  const homeDir = options.homeDir ?? os.homedir();
  const issues = validateAbsoluteInput(plan.basePath);
  if (issues.length > 0) return { ok: false, issues };
  const base = path.resolve(plan.basePath);
  const root = plan.segments.length === 0 ? base : path.join(base, ...plan.segments);
  return { ok: true, root: { root, displayPath: toDisplayPath(root, homeDir) } };
}

/**
 * 关系判定：相同、互相包含（任一方向）或互不相关。
 * 只做字符串层面的路径比较；符号链接与大小写差异留给 3.3 的 realpath 检查。
 */
export function rootRelation(sourceRoot: string, localRoot: string): RootRelation {
  const a = path.resolve(sourceRoot);
  const b = path.resolve(localRoot);
  if (a === b) return 'same';
  const separator = path.sep;
  if (a.startsWith(b + separator) || b.startsWith(a + separator)) return 'nested';
  return 'disjoint';
}
