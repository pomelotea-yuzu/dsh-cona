// 公开资料发布（tasks 3.4）：正文不可变写入 + 资料头三态替换。
// 顺序由命令层保证（先正文、再资料头、最后本机回执，4.x）；本文件只提供可观察的单步结果。
// 不宣称断电安全：rename 后无法继续确认时返回 unknown，不猜“已提交”或“未提交”。

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProjectDocument } from '../../domain/types.js';
import { replaceAtomicallyChecked, type AtomicHooks, type AtomicStage } from './atomic-write.js';
import { readInScope, resolveInScope } from './path-scope.js';
import { serializeProjectDocument } from './project-json.js';

export type PublishStatus = 'published' | 'not-published' | 'unknown';

export interface PublishResult {
  status: PublishStatus;
  /** 失败或中止发生的阶段；done 表示完整发布。 */
  stage: AtomicStage;
  detail?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;

function hexOf(contentHash: string): string {
  return contentHash.slice('sha256:'.length);
}

/**
 * 发布资料头：`not-published` 表示可证明未替换，`unknown` 表示无法确认。
 * 调用前应已通过领域校验与范围检查；本函数只负责替换与观察。
 */
export async function publishProjectDocument(
  root: string,
  doc: ProjectDocument,
  hooks: AtomicHooks = {},
): Promise<PublishResult> {
  const scoped = await resolveInScope(root, 'project.json', { mode: 'write' });
  if (!scoped.ok) {
    return {
      status: 'not-published',
      stage: 'temp',
      detail: scoped.issues.map((issue) => issue.code).join(', '),
    };
  }
  const result = await replaceAtomicallyChecked(scoped.absolutePath, serializeProjectDocument(doc), hooks);
  return {
    status: result.status === 'saved' ? 'published' : result.status === 'not-saved' ? 'not-published' : 'unknown',
    stage: result.stage,
    ...(result.detail === undefined ? {} : { detail: result.detail }),
  };
}

export type BodyWriteStatus = 'written' | 'already-present' | 'conflict' | 'not-published' | 'unknown';

export interface BodyWriteResult {
  status: BodyWriteStatus;
  /** 协议路径：`records/<recordId>/<contentHash-hex>.md`。 */
  path: string;
  detail?: string;
}

export interface BodyWriteOptions {
  hooks?: AtomicHooks;
}

/**
 * 写入不可变正文。内容寻址：路径由记录 id 与内容哈希决定。
 * - 已存在且字节一致 → already-present（幂等，不重写）；
 * - 已存在但字节不同 → conflict（不覆盖，保留原正文）。
 * 先正文后资料头由调用方（命令层）保证；孤立正文不得在查询中当作已发布记录。
 */
export async function writeBodyImmutable(
  root: string,
  recordId: string,
  contentHash: string,
  bytes: Uint8Array,
  options: BodyWriteOptions = {},
): Promise<BodyWriteResult> {
  const protocolPath = `records/${recordId}/${HASH_RE.test(contentHash) ? hexOf(contentHash) : 'invalid'}.md`;
  if (!UUID_RE.test(recordId)) {
    return { status: 'not-published', path: protocolPath, detail: '记录 id 不是 UUID v4' };
  }
  if (!HASH_RE.test(contentHash)) {
    return { status: 'not-published', path: protocolPath, detail: 'contentHash 不是 sha256:<hex> 形态' };
  }
  const actual = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  if (actual !== contentHash) {
    return { status: 'conflict', path: protocolPath, detail: '传入字节的哈希与 contentHash 不一致' };
  }

  const directory = `records/${recordId}`;
  const dirScoped = await resolveInScope(root, directory, { mode: 'write', target: 'any' });
  if (!dirScoped.ok) {
    return {
      status: 'not-published',
      path: protocolPath,
      detail: dirScoped.issues.map((issue) => issue.code).join(', '),
    };
  }
  try {
    if (dirScoped.info === null) await mkdir(dirScoped.absolutePath, { recursive: true });
  } catch (error) {
    return { status: 'not-published', path: protocolPath, detail: (error as Error).message };
  }

  const targetScoped = await resolveInScope(root, protocolPath, { mode: 'write' });
  if (!targetScoped.ok) {
    return {
      status: 'not-published',
      path: protocolPath,
      detail: targetScoped.issues.map((issue) => issue.code).join(', '),
    };
  }
  const target = targetScoped.absolutePath;

  try {
    await options.hooks?.beforeTempWrite?.();
    await writeFile(target, bytes, { flag: 'wx' });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      const existing = await readInScope(root, protocolPath);
      if (!existing.ok) {
        return { status: 'unknown', path: protocolPath, detail: existing.issues.map((issue) => issue.code).join(', ') };
      }
      return Buffer.from(existing.bytes).equals(Buffer.from(bytes))
        ? { status: 'already-present', path: protocolPath }
        : { status: 'conflict', path: protocolPath, detail: '同路径已有不同字节的正文' };
    }
    return {
      status: code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' ? 'not-published' : 'unknown',
      path: protocolPath,
      detail: `${code ?? 'error'}: ${(error as Error).message}`,
    };
  }

  try {
    await options.hooks?.beforeReread?.();
    const info = await stat(target);
    if (info.size !== bytes.length) {
      return { status: 'unknown', path: protocolPath, detail: '回读大小与写入不一致' };
    }
    const readBack = await readFile(target);
    if (!readBack.equals(Buffer.from(bytes))) {
      return { status: 'unknown', path: protocolPath, detail: '回读字节与写入不一致' };
    }
  } catch (error) {
    return { status: 'unknown', path: protocolPath, detail: (error as Error).message };
  }
  return { status: 'written', path: protocolPath };
}

/** 供测试与命令层清理：删除正文只在明确未发布时使用，不作为常规路径。 */
export async function removeUnpublishedBody(root: string, protocolPath: string): Promise<void> {
  await rm(path.join(root, ...protocolPath.split('/')), { force: true });
}
