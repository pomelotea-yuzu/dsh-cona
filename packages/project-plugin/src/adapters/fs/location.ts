// 位置解析适配器（tasks 3.1）：把 application 的定位计划落实为绝对路径。
// 只用 node:path 与 node:os，不硬编码盘符或分隔符；不改动目标内容，不执行 Git 操作。

import os from 'node:os';
import path from 'node:path';
import type { LocationIssue, LocationPlan } from '../../application/location.js';
import type { LocationView } from '../../application/ports.js';

export interface LocationAdapterOptions {
  /** 用于折叠显示路径的 home；默认 os.homedir()，测试可注入固定值。 */
  homeDir?: string;
}

export type ResolveLocationResult =
  | { ok: true; location: LocationView }
  | { ok: false; issues: LocationIssue[] };

/** 显示路径：home 前缀折叠为 `~`，其余保留绝对路径；不做大小写或 symlink 归一。 */
export function toDisplayPath(target: string, homeDir: string = os.homedir()): string {
  const separator = path.sep;
  if (target === homeDir) return '~';
  const prefix = homeDir.endsWith(separator) ? homeDir : homeDir + separator;
  if (target.startsWith(prefix)) return '~' + separator + target.slice(prefix.length);
  return target;
}

function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment === '..');
}

/**
 * 用户输入的绝对路径基础检查：拒绝 NUL、`..` 段与相对路径。
 * 资料根与本机根共用同一套输入规则；realpath／大小写／符号链接在 3.3 补。
 */
export function validateAbsoluteInput(basePath: string): LocationIssue[] {
  const issues: LocationIssue[] = [];
  if (basePath.includes('\0')) {
    issues.push({ code: 'location-path-invalid', message: '位置路径含 NUL 字符' });
  }
  if (hasParentSegment(basePath)) {
    issues.push({ code: 'location-path-escapes', message: '位置路径含 `..` 段，拒绝按父目录解析' });
  }
  if (!path.isAbsolute(basePath)) {
    issues.push({ code: 'location-root-not-absolute', message: '位置基准必须是绝对路径，不接受相对路径或当前目录推断' });
  }
  return issues;
}

/**
 * 解析定位计划。拒绝：含 NUL、含 `..` 段、非绝对基准。
 * 不静默把相对路径补成当前进程目录——那会让位置取决于启动目录。
 */
export function resolveLocation(plan: LocationPlan, options: LocationAdapterOptions = {}): ResolveLocationResult {
  const homeDir = options.homeDir ?? os.homedir();
  const issues = validateAbsoluteInput(plan.basePath);
  if (issues.length > 0) return { ok: false, issues };

  const base = path.resolve(plan.basePath);
  const root = plan.segments.length === 0 ? base : path.join(base, ...plan.segments);
  return {
    ok: true,
    location: { kind: plan.kind, root, displayPath: toDisplayPath(root, homeDir) },
  };
}

/** 已有资料根的显示形式；仅折叠 home，不推断它属于哪种位置。 */
export function describeRoot(root: string, options: LocationAdapterOptions = {}): LocationView {
  const homeDir = options.homeDir ?? os.homedir();
  const absolute = path.resolve(root);
  return { root: absolute, displayPath: toDisplayPath(absolute, homeDir) };
}
