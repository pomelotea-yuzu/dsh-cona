// 宿主会话目录适配器（tasks 6.1，design §7）：把 DSH `sessionController` 服务
// 适配成应用层的 `SessionDirectoryPort`。插件进程内直调（同宿主信任域），
// 不经 gateway Remote，也不读 invocation——创建／列举本身不需要主体授权。
//
// 边界：只暴露 create（宿主自动复用可复用的空白会话）与 list（只读，不 resume）；
// prompt／cancel／resolveAgent 等动作留待 6.2／6.3 的绑定与工具段落。

import type { Context } from '@deepseek-ai/cordis'
import type { PlanNodeViewPort, SessionDirectoryPort, SourceFilesPort } from '../application/ports.js'
import { readSourceBaseline } from '../application/baseline.js'
import type { Sha256Fn } from '../domain/types.js'

/** 与 dsh-api-session-controller 的 SessionController 运行时形态对齐的最小结构。 */
interface SessionControllerLike {
  create(request: { sessionId?: string; cwd?: string }): Promise<{ sessionId: unknown }>;
  list(signal?: AbortSignal): Promise<{ items?: ReadonlyArray<Record<string, unknown>> }>;
}

export type SessionDirectoryResult =
  | { ok: true; directory: SessionDirectoryPort }
  | { ok: false; message: string };

/**
 * 读取 ctx.sessionController（需要插件 inject 声明包含 'sessionController'）。
 * `cwd` 绑定为当前实例的资料根：新建会话带 cwd（冷会话在重启后仍可列举），
 * 复用策略按宿主 create 语义实现——先找 cwd 一致的空白会话命名复用，没有才新建；
 * 无论复用还是新建，都以宿主实际返回的 sessionId 为准。
 */
export function sessionDirectory(ctx: Context, cwd: string): SessionDirectoryResult {
  const controller = (ctx as Context & { sessionController?: SessionControllerLike }).sessionController;
  if (controller === undefined) {
    return { ok: false, message: '宿主未提供 sessionController 服务（inject 缺失或宿主版本不符）' };
  }
  return {
    ok: true,
    directory: {
      async createSession() {
        const items = (await controller.list()).items ?? [];
        const blank = items.find(
          (item) => item['blank'] === true && item['cwd'] === cwd && typeof item['sessionId'] === 'string',
        );
        const request =
          blank !== undefined
            ? { sessionId: blank['sessionId'] as string, cwd }
            : { cwd };
        const value = await controller.create(request);
        const sessionId = value?.sessionId;
        if (typeof sessionId !== 'string' || sessionId === '') {
          throw new Error('宿主 create 未返回有效 sessionId');
        }
        return { sessionId };
      },
      async listSessions() {
        const value = await controller.list();
        const items = value?.items ?? [];
        const out: Array<{ sessionId: string; blank: boolean; running: boolean; updatedAt: number; cwd: string | null }> = [];
        for (const item of items) {
          const sessionId = item['sessionId'];
          if (typeof sessionId !== 'string' || sessionId === '') continue;
          out.push({
            sessionId,
            blank: item['blank'] === true,
            running: item['running'] === true,
            updatedAt: typeof item['updatedAt'] === 'number' ? (item['updatedAt'] as number) : 0,
            cwd: typeof item['cwd'] === 'string' ? (item['cwd'] as string) : null,
          });
        }
        return out;
      },
    },
  };
}

/** 目录不可用时的占位实现：所有调用以稳定码拒绝，不抛裸异常。 */
export function unavailableSessionDirectory(message: string): SessionDirectoryPort {
  return {
    createSession: async () => {
      throw new Error(message);
    },
    listSessions: async () => {
      throw new Error(message);
    },
  };
}

/** 当前资料规划节点视图：从已打开实例的资料根重读基线取节点 id 集合。 */
export function planNodeView(
  files: SourceFilesPort,
  sourceRoot: () => string | null,
  sha256: Sha256Fn,
  clock: () => string,
): PlanNodeViewPort {
  return {
    async currentNodeIds() {
      const root = sourceRoot();
      if (root === null) {
        return { ok: false as const, code: 'binding-expired', message: '实例未打开；无法核对节点' };
      }
      const baseline = await readSourceBaseline(files, root, sha256, clock);
      if (!baseline.ok) {
        return {
          ok: false as const,
          code: 'invalid-project',
          message: '资料不可读或引用正文不一致；无法核对节点',
        };
      }
      return { ok: true as const, nodeIds: new Set(baseline.doc.plan.nodes.map((node) => node.id)) };
    },
  };
}
