// 资料文件适配器（tasks 3.1）：检查资料根、放置随包格式资源、读写公开资料头。
// 三种位置共用本实现，位置差异只在 adapters/fs/location.ts 的解析结果。

import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SourceFilesPort, RootInspection } from '../../application/ports.js';
import type { Sha256Fn } from '../../domain/types.js';
import { readProjectDocument } from './project-json.js';
import { readInScope } from './path-scope.js';
import { publishProjectDocument, writeBodyImmutable } from './publish.js';

/** 随包格式资源在资料根内的相对落点（design §3）。 */
export const FORMAT_ASSET_FILES: readonly { source: string; target: string }[] = [
  { source: 'project-README.template.md', target: 'README.md' },
  { source: 'project-v1.schema.json', target: 'schema/project-v1.schema.json' },
  { source: 'plan-canonicalization.md', target: 'protocol/plan-canonicalization.md' },
  { source: 'plan-vectors.json', target: 'protocol/plan-vectors.json' },
];

/** 只描述磁盘现状：不判断项目是否合法，也不因存在其他文件就推断资料归属。 */
export async function inspectRoot(root: string): Promise<RootInspection> {
  let info;
  try {
    info = await stat(root);
  } catch {
    return { root, exists: false, isDirectory: false, entries: [], hasProjectJson: false };
  }
  if (!info.isDirectory()) {
    return { root, exists: true, isDirectory: false, entries: [], hasProjectJson: false };
  }
  let entries: string[];
  try {
    entries = (await readdir(root)).sort();
  } catch {
    entries = [];
  }
  return { root, exists: true, isDirectory: true, entries, hasProjectJson: entries.includes('project.json') };
}

/**
 * 放置格式资源并建立 records/。使用 COPYFILE_EXCL：目标已存在即失败，不静默覆盖别人的资料。
 */
export async function copyFormatAssets(root: string, formatsDir: string): Promise<void> {
  await mkdir(path.join(root, 'records'), { recursive: true });
  await mkdir(path.join(root, 'schema'), { recursive: true });
  await mkdir(path.join(root, 'protocol'), { recursive: true });
  for (const asset of FORMAT_ASSET_FILES) {
    await copyFile(path.join(formatsDir, asset.source), path.join(root, ...asset.target.split('/')), constants.COPYFILE_EXCL);
  }
}

/** 组装端口实现；formatsDir 指向安装包内的 formats/v1。 */
export function createSourceFiles(formatsDir: string, sha256: Sha256Fn): SourceFilesPort {
  return {
    inspect: inspectRoot,
    copyFormatAssets: (root: string) => copyFormatAssets(root, formatsDir),
    readDocument: async (root: string) => {
      const result = await readProjectDocument(root, sha256);
      return result.ok ? { ok: true, doc: result.doc } : { ok: false, issues: result.issues };
    },
    readHead: async (root: string) => {
      const scoped = await readInScope(root, 'project.json');
      if (!scoped.ok) {
        return {
          ok: false,
          issues: scoped.issues.map((issue) => ({ code: issue.code, path: 'project.json', message: issue.message })),
        };
      }
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(scoped.bytes);
        return { ok: true, bytes: scoped.bytes, text };
      } catch {
        return { ok: false, issues: [{ code: 'invalid-utf8', path: 'project.json', message: 'project.json 不是合法 UTF-8' }] };
      }
    },
    readScopedFile: async (root: string, relativePath: string) => {
      const scoped = await readInScope(root, relativePath);
      if (!scoped.ok) {
        return {
          ok: false,
          issues: scoped.issues.map((issue) => ({ code: issue.code, path: relativePath, message: issue.message })),
        };
      }
      return { ok: true, bytes: scoped.bytes };
    },
    writeDocument: async (root, doc, hooks) => {
      const result = await publishProjectDocument(root, doc, hooks);
      if (result.status === 'published') return { ok: true, headHash: result.headHash ?? '' };
      return {
        ok: false,
        status: result.status === 'not-published' ? 'not-published' : 'unknown',
        issues: [
          {
            code: result.status === 'not-published' ? 'publish-not-published' : 'publish-unknown',
            path: 'project.json',
            message: `${result.stage}${result.detail === undefined ? '' : `：${result.detail}`}`,
          },
        ],
      };
    },
    writeBody: (root, recordId, contentHash, bytes, hooks) =>
      writeBodyImmutable(root, recordId, contentHash, bytes, hooks === undefined ? {} : { hooks }),
  };
}
