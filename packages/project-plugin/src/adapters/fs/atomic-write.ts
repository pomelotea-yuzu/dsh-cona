// 同目录原子替换（tasks 3.4）：临时文件 + rename + 回读，结果三态化。
// 不宣称断电安全：rename 后、回读前的异常一律按 unknown 处理，不猜“已提交”或“未提交”。
// 临时文件始终与目标同目录，避免跨盘 rename；失败时尽力清理临时文件。

import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type AtomicStatus = 'saved' | 'not-saved' | 'unknown';
export type AtomicStage = 'temp' | 'rename' | 'reread' | 'done';

/** 仅用于故障注入测试；生产调用不传。 */
export interface AtomicHooks {
  beforeTempWrite?: () => void | Promise<void>;
  beforeRename?: () => void | Promise<void>;
  afterRename?: () => void | Promise<void>;
  beforeReread?: () => void | Promise<void>;
}

export interface AtomicResult {
  status: AtomicStatus;
  stage: AtomicStage;
  detail?: string;
}

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/**
 * 明显的“未生效”错误：目标或临时文件不存在、跨设备、目标类型冲突。
 * 其余错误（如 EIO）无法证明是否已替换，按 unknown 处理。
 */
function definitelyNotApplied(code: string | undefined): boolean {
  return code === 'ENOENT' || code === 'EXDEV' || code === 'EISDIR' || code === 'ENOTDIR' || code === 'EPERM';
}

export async function replaceAtomicallyChecked(
  target: string,
  data: string | Uint8Array,
  hooks: AtomicHooks = {},
): Promise<AtomicResult> {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${randomUUID()}`);

  try {
    await hooks.beforeTempWrite?.();
    if (typeof data === 'string') {
      await writeFile(temp, data, { encoding: 'utf8', flag: 'wx' });
    } else {
      await writeFile(temp, data, { flag: 'wx' });
    }
  } catch (error) {
    await rm(temp, { force: true });
    return { status: 'not-saved', stage: 'temp', detail: `${errnoOf(error) ?? 'error'}: ${(error as Error).message}` };
  }

  try {
    // 注入钩子在 rename 之前抛错：重命名尚未发生，结果明确为未保存。
    await hooks.beforeRename?.();
  } catch (error) {
    await rm(temp, { force: true });
    return { status: 'not-saved', stage: 'rename', detail: `hook: ${(error as Error).message}` };
  }

  try {
    await rename(temp, target);
  } catch (error) {
    const code = errnoOf(error);
    await rm(temp, { force: true });
    return {
      status: definitelyNotApplied(code) ? 'not-saved' : 'unknown',
      stage: 'rename',
      detail: `${code ?? 'error'}: ${(error as Error).message}`,
    };
  }

  try {
    await hooks.afterRename?.();
  } catch (error) {
    // rename 已成功但已无法继续确认：不宣称结果明确。
    return { status: 'unknown', stage: 'rename', detail: `after-rename: ${(error as Error).message}` };
  }

  try {
    await hooks.beforeReread?.();
    const expected = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    const actual = await readFile(target);
    if (!actual.equals(expected)) {
      return { status: 'unknown', stage: 'reread', detail: '回读字节与写入内容不一致（可能有外部写入）' };
    }
  } catch (error) {
    return { status: 'unknown', stage: 'reread', detail: `${errnoOf(error) ?? 'error'}: ${(error as Error).message}` };
  }

  return { status: 'saved', stage: 'done' };
}
