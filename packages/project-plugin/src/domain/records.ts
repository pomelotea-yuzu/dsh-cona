// 记录辅助（tasks 1.4）：正文发布边界、验证来源分类。
// - 孤立正文不发布：records/ 下未被索引引用的正文文件视为孤立，校验命令报错；
// - 外部验证不冒充本机复测：verification 记录按 sources 分类，含仓库引用即标外部来源。

import type { RecordIndexEntry } from './types.js';

/** 索引引用的全部正文相对路径（/ 分段）。 */
export function referencedBodyPaths(records: readonly RecordIndexEntry[]): Set<string> {
  return new Set(records.map((record) => record.path));
}

/**
 * 磁盘上存在但未被任何索引条目引用的正文（孤立正文）。
 * presentPaths 是 / 分段相对路径（由适配器扫描 records/ 目录得到）。
 */
export function findOrphanBodies(presentPaths: readonly string[], records: readonly RecordIndexEntry[]): string[] {
  const referenced = referencedBodyPaths(records);
  return presentPaths.filter((path) => !referenced.has(path));
}

export type VerificationSourceClass =
  | 'public-chain'
  | 'external-observation'
  | 'unsourced';

/**
 * 验证来源分类：
 * - external-observation：sources 含仓库引用（外部观察），展示时必须标注外部来源；
 * - public-chain：sources 全部为公开记录 id；
 * - unsourced：无来源。
 */
export function classifyVerificationSource(record: RecordIndexEntry): VerificationSourceClass {
  if (record.kind !== 'verification') {
    return 'unsourced';
  }
  let hasPublicRef = false;
  for (const source of record.sources) {
    if (typeof source === 'string') {
      hasPublicRef = true;
    } else {
      return 'external-observation';
    }
  }
  return hasPublicRef ? 'public-chain' : 'unsourced';
}
