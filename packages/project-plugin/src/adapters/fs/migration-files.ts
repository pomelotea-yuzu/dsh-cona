// 迁移文件适配器（tasks 1.4，design §1）：候选目录、复制、装入与核对需要的文件操作。
// 只用 node:fs 与 node:path；来源读取走范围校验（拒绝 symlink 与越界），写入只落
// 服务层给出的候选／目标根（路径来自登记与协议清单，不来自用户自由输入）。

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MigrationFilesPort } from '../../application/migration.js';
import { readInScope } from './path-scope.js';

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** 协议相对路径（`/` 分段）转平台路径；拒绝绝对路径与 `..`，不引入第二套路径规则。 */
function safeRelative(relativePath: string): string | null {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return null;
  if (relativePath.startsWith('/') || relativePath.includes('\\')) return null;
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return null;
  return segments.join(path.sep);
}

export function createMigrationFiles(): MigrationFilesPort {
  return {
    inspect: async (targetRoot) => {
      let info;
      try {
        info = await stat(targetRoot);
      } catch {
        return { exists: false, isDirectory: false, entries: [] };
      }
      if (!info.isDirectory()) {
        return { exists: true, isDirectory: false, entries: [] };
      }
      let entries: string[];
      try {
        entries = (await readdir(targetRoot)).sort();
      } catch {
        entries = [];
      }
      return { exists: true, isDirectory: true, entries };
    },

    ensureDir: async (dir) => {
      await mkdir(dir, { recursive: true });
    },

    removeDir: async (dir) => {
      await rm(dir, { recursive: true, force: true });
    },

    removeFile: async (root, relativePath) => {
      const safe = safeRelative(relativePath);
      if (safe === null) throw new Error(`迁移删除路径不合法：${relativePath}`);
      await rm(path.join(root, safe), { force: true });
    },

    renameDir: async (from, to) => {
      await rename(from, to);
    },

    readFile: async (root, relativePath) => {
      const scoped = await readInScope(root, relativePath);
      if (!scoped.ok) {
        if (scoped.issues.some((issue) => issue.code === 'scope-not-found')) return null;
        const first = scoped.issues[0];
        return {
          ok: false,
          message: `${first?.code ?? 'scope-unreadable'}: ${first?.message ?? relativePath}`,
        };
      }
      return { ok: true, bytes: scoped.bytes };
    },

    writeFile: async (targetRoot, relativePath, bytes) => {
      const safe = safeRelative(relativePath);
      if (safe === null) {
        throw new Error(`迁移写入路径不合法：${relativePath}`);
      }
      const target = path.join(targetRoot, safe);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
    },

    listFiles: async (root) => {
      let rootInfo;
      try {
        rootInfo = await stat(root);
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') return null;
        throw error;
      }
      if (!rootInfo.isDirectory()) return null;
      const out: string[] = [];
      const walk = async (dir: string, prefix: string): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isSymbolicLink()) {
            // 迁移候选／目标内不允许 symlink：直接报告为不合法内容。
            throw new Error(`迁移目录内出现符号链接：${prefix}${entry.name}`);
          }
          if (entry.isDirectory()) {
            await walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
          } else if (entry.isFile()) {
            out.push(`${prefix}${entry.name}`);
          }
        }
      };
      await walk(root, '');
      return out.sort();
    },
  };
}
