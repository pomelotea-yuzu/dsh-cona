// 本机运行数据文件后端（tasks 3.2，design §2）：注册表、实例聚合与独占锁。
// 布局：<localRoot>/registry.json、<localRoot>/instances/<instanceId>/state.json、<localRoot>/lock.json
// 只用 node:fs 与 node:crypto；不写公开资料，不执行 Git 写操作。

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { InstanceAggregate, Registry } from '../../application/local-state.js';
import type { LocalIssue, LocalLockInfo, LocalStateStorePort } from '../../application/ports.js';

const REGISTRY_FILE = 'registry.json';
const LOCK_FILE = 'lock.json';
const INSTANCES_DIR = 'instances';

/** 稳定错误码的本机状态失败；由服务层转成 issue，不向用户抛裸异常。 */
export class LocalStateError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LocalStateError';
  }
}

/** 进程内写者登记：同一进程不允许两个写者同时持有同一本机根。 */
const inProcessWriters = new Map<string, string>();

export interface LocalStateStoreOptions {
  clock?: () => string;
  pid?: number;
  hostname?: string;
  timeoutMs?: number;
}

function emptyRegistry(): Registry {
  return { schemaVersion: 1, instances: [] };
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temp = `${target}.tmp-${randomUUID()}`;
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw new LocalStateError('local-state-write-failed', (error as Error).message);
  }
}

export class LocalStateStore implements LocalStateStorePort {
  private readonly clock: () => string;
  private readonly pid: number;
  private readonly hostname: string;

  constructor(options: LocalStateStoreOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.pid = options.pid ?? process.pid;
    this.hostname = options.hostname ?? os.hostname();
  }

  async ensureDirs(localRoot: string): Promise<void> {
    try {
      await mkdir(path.join(localRoot, INSTANCES_DIR), { recursive: true });
    } catch (error) {
      throw new LocalStateError('local-root-unwritable', (error as Error).message);
    }
  }

  async readRegistry(localRoot: string): Promise<Registry> {
    const file = path.join(localRoot, REGISTRY_FILE);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyRegistry();
      throw new LocalStateError('local-state-unreadable', (error as Error).message);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new LocalStateError('local-registry-corrupt', `注册表不是合法 JSON：${REGISTRY_FILE}`);
    }
    const registry = parsed as { schemaVersion?: unknown; instances?: unknown };
    if (registry?.schemaVersion !== 1 || !Array.isArray(registry.instances)) {
      throw new LocalStateError('local-registry-unsupported', '注册表版本不受支持；不静默覆盖');
    }
    return { schemaVersion: 1, instances: registry.instances as Registry['instances'] };
  }

  async writeRegistry(localRoot: string, registry: Registry): Promise<void> {
    await writeJsonAtomic(path.join(localRoot, REGISTRY_FILE), registry);
  }

  async readAggregate(localRoot: string, instanceId: string): Promise<InstanceAggregate | null> {
    const file = path.join(localRoot, INSTANCES_DIR, instanceId, 'state.json');
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new LocalStateError('local-state-unreadable', (error as Error).message);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new LocalStateError('local-aggregate-corrupt', `实例聚合不是合法 JSON：${instanceId}`);
    }
    const aggregate = parsed as { schemaVersion?: unknown; instanceId?: unknown };
    if (aggregate?.schemaVersion !== 1 || aggregate.instanceId !== instanceId) {
      throw new LocalStateError('local-aggregate-unsupported', '实例聚合版本或身份不匹配；不静默覆盖');
    }
    return aggregate as InstanceAggregate;
  }

  async writeAggregate(localRoot: string, aggregate: InstanceAggregate): Promise<void> {
    const dir = path.join(localRoot, INSTANCES_DIR, aggregate.instanceId);
    try {
      await mkdir(dir, { recursive: true });
    } catch (error) {
      throw new LocalStateError('local-root-unwritable', (error as Error).message);
    }
    await writeJsonAtomic(path.join(dir, 'state.json'), aggregate);
  }

  async lockInfo(localRoot: string): Promise<LocalLockInfo | null> {
    try {
      const text = await readFile(path.join(localRoot, LOCK_FILE), 'utf8');
      const parsed = JSON.parse(text) as Partial<LocalLockInfo>;
      if (typeof parsed.token !== 'string') return null;
      return {
        pid: typeof parsed.pid === 'number' ? parsed.pid : -1,
        hostname: typeof parsed.hostname === 'string' ? parsed.hostname : 'unknown',
        token: parsed.token,
        acquiredAt: typeof parsed.acquiredAt === 'string' ? parsed.acquiredAt : 'unknown',
        ...(typeof parsed.purpose === 'string' ? { purpose: parsed.purpose } : {}),
      };
    } catch {
      return null;
    }
  }

  async withLock<T>(
    localRoot: string,
    run: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; issues: LocalIssue[] }> {
    const key = path.resolve(localRoot);
    if (inProcessWriters.has(key)) {
      return {
        ok: false,
        issues: [
          {
            code: 'local-writer-duplicate',
            message: '同一进程已持有该本机根的写者；不允许多个写者同时打开同一根',
            path: key,
          },
        ],
      };
    }
    const token = randomUUID();
    const lockPath = path.join(localRoot, LOCK_FILE);
    try {
      await mkdir(localRoot, { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({ pid: this.pid, hostname: this.hostname, token, acquiredAt: this.clock() }, null, 2) + '\n',
        { encoding: 'utf8', flag: 'wx' },
      );
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      if (e.code === 'EEXIST') {
        const info = await this.lockInfo(localRoot);
        const holder = info === null ? '持有者信息不可读' : `pid=${info.pid} host=${info.hostname} since=${info.acquiredAt}`;
        return {
          ok: false,
          issues: [
            {
              code: 'local-lock-held',
              message: `本机根已有写者（${holder}）；本插件不按超时抢占，确认是遗留锁后用 release-lock 显式释放`,
              path: key,
            },
          ],
        };
      }
      throw new LocalStateError('local-lock-failed', e.message);
    }

    inProcessWriters.set(key, token);
    try {
      const value = await run();
      return { ok: true, value };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      return {
        ok: false,
        issues: [{ code: e.code ?? 'local-state-failed', message: e.message ?? '本机状态操作失败', path: key }],
      };
    } finally {
      inProcessWriters.delete(key);
      await rm(lockPath, { force: true });
    }
  }

  async releaseLock(
    localRoot: string,
    options: { force?: boolean; expectedToken?: string },
  ): Promise<{ ok: true; released: boolean } | { ok: false; issues: LocalIssue[] }> {
    const info = await this.lockInfo(localRoot);
    if (info === null) {
      // 锁文件不存在或不可读：仍允许显式 force 清理不可读残留。
      if (options.force === true) {
        await rm(path.join(localRoot, LOCK_FILE), { force: true });
        return { ok: true, released: true };
      }
      return { ok: true, released: false };
    }
    if (options.force !== true && options.expectedToken !== info.token) {
      return {
        ok: false,
        issues: [
          {
            code: 'local-lock-token-mismatch',
            message: '释放遗留锁需要匹配持有者 token，或显式 force；不自动按 pid 或超时判断',
            path: localRoot,
          },
        ],
      };
    }
    await rm(path.join(localRoot, LOCK_FILE), { force: true });
    return { ok: true, released: true };
  }
}
