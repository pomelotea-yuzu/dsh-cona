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
import { serializeProjectDocument } from './project-json.js';

/**
 * 随包格式资源在资料根内的相对落点（design §3）。
 * `from` 为随包来源子目录：v1（默认）与 v2；v2 工件随包分发，便于外部编辑者按版本取用。
 */
export const FORMAT_ASSET_FILES: readonly { source: string; target: string; from?: 'v1' | 'v2' }[] = [
  { source: 'project-README.template.md', target: 'README.md' },
  { source: 'project-v1.schema.json', target: 'schema/project-v1.schema.json' },
  { source: 'plan-canonicalization.md', target: 'protocol/plan-canonicalization.md' },
  { source: 'plan-vectors.json', target: 'protocol/plan-vectors.json' },
  // 2.2：结构化替代记录的可移植工件（schema、协议说明含正反例）。
  { source: 'replacement-v1.schema.json', target: 'schema/replacement-v1.schema.json' },
  { source: 'replacement-protocol.md', target: 'protocol/replacement-protocol.md' },
  // 2.4：用户模板的可移植工件（schema、协议说明含正反例）。
  { source: 'user-template-v1.schema.json', target: 'schema/user-template-v1.schema.json' },
  { source: 'user-template-protocol.md', target: 'protocol/user-template-protocol.md' },
  // 4.1：v2 投影（schema、规范化说明、向量与路线图协议）。
  { source: 'project-v2.schema.json', target: 'schema/project-v2.schema.json', from: 'v2' },
  { source: 'plan-canonicalization-v2.md', target: 'protocol/plan-canonicalization-v2.md', from: 'v2' },
  { source: 'plan-vectors-v2.json', target: 'protocol/plan-vectors-v2.json', from: 'v2' },
  { source: 'roadmap-protocol.md', target: 'protocol/roadmap-protocol.md', from: 'v2' },
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
 * `formatsDir` 指向随包 formats/v1；v2 来源解析为同级 formats/v2。
 */
export async function copyFormatAssets(root: string, formatsDir: string): Promise<void> {
  await mkdir(path.join(root, 'records'), { recursive: true });
  await mkdir(path.join(root, 'schema'), { recursive: true });
  await mkdir(path.join(root, 'protocol'), { recursive: true });
  const formatsRoot = path.dirname(formatsDir);
  for (const asset of FORMAT_ASSET_FILES) {
    const sourceDir = asset.from === 'v2' ? path.join(formatsRoot, 'v2') : formatsDir;
    await copyFile(path.join(sourceDir, asset.source), path.join(root, ...asset.target.split('/')), constants.COPYFILE_EXCL);
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
    renderHead: (doc) => {
      const text = serializeProjectDocument(doc);
      return { text, headHash: 'sha256:' + sha256(new TextEncoder().encode(text)) };
    },
    writeBody: (root, recordId, contentHash, bytes, hooks) =>
      writeBodyImmutable(root, recordId, contentHash, bytes, hooks === undefined ? {} : { hooks }),
  };
}
