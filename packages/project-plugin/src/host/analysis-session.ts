// 分析 Session 的宿主适配器（tasks 4.2-4.3）：用专用 preset 新建 Session，
// 不复用同 cwd 的空白普通会话；返回宿主实际身份与实际 preset。
//
// 与 session-directory.ts 的 createSession 区分：那条路径服务普通聊天，会按 cwd
// 复用空白会话；分析必须每次新建（省略 sessionId），否则可能把分析绑定注入已关联
// 的普通空白会话（A01／R5）。

import type { Context } from '@deepseek-ai/cordis'
import type { AnalysisSessionPort, DirectorySession } from '../application/ports.js'

interface SessionControllerLike {
  create(request: {
    sessionId?: string;
    cwd?: string;
    workspaceId?: string;
    agentPreset?: string;
  }): Promise<{ sessionId: unknown; agentPreset?: unknown }>;
  list(signal?: AbortSignal): Promise<{ items?: ReadonlyArray<Record<string, unknown>> }>;
  prompt?(request: {
    sessionId: string;
    requestId: string;
    mode: 'queue' | 'steer';
    content: readonly { type: 'text'; text: string }[];
  }, signal: AbortSignal): Promise<{ accepted?: unknown }>;
  cancel?(request: { sessionId: string }): { accepted?: unknown } | Promise<{ accepted?: unknown }>;
}

interface AgentLike {
  readonly id?: unknown;
  readonly session?: {
    snapshotEvents?(): ReadonlyArray<{
      readonly type?: unknown;
      readonly data?: {
        readonly source?: { readonly kind?: unknown; readonly rpcId?: unknown };
        readonly inserted?: ReadonlyArray<{ readonly source?: { readonly kind?: unknown; readonly rpcId?: unknown } }>;
      };
    }>;
  };
}
interface AgentsLike {
  get(sessionId: string): AgentLike | undefined;
}

interface WorkspaceLike {
  id: string;
  attachSession(sessionId: string): Promise<void>;
}
interface WorkspaceRegistryLike {
  resolveByPath(path: string): Promise<WorkspaceLike | undefined>;
  create(path: string, title?: string): Promise<WorkspaceLike>;
}

export type AnalysisSessionPortResult =
  | { ok: true; port: AnalysisSessionPort }
  | { ok: false; message: string };

/** 目录不可用时的占位：所有创建以稳定错误拒绝，不猜 Session。 */
export function unavailableAnalysisSessionPort(message: string): AnalysisSessionPort {
  return {
    async createAnalysisSession() {
      throw new Error(message);
    },
    async listSessions() {
      throw new Error(message);
    },
    async promptFirstMessage() {
      throw new Error(message);
    },
    async cancelSession() {
      throw new Error(message);
    },
  };
}

/**
 * 读取宿主 sessionController 组装分析会话端口。cwd 由每次创建请求提供（冻结仓库根），
 * 有工作区登记表时优先用 workspaceId 并 attachSession，使新会话进入宿主可见列表。
 */
export function analysisSessionPort(ctx: Context): AnalysisSessionPortResult {
  const controller = (ctx as Context & { sessionController?: SessionControllerLike }).sessionController;
  if (controller === undefined) {
    return { ok: false, message: '宿主未提供 sessionController 服务（inject 缺失或宿主版本不符）' };
  }
  const context = ctx as Context & { get?: <T>(name: string) => T | undefined };
  const workspaces = typeof context.get === 'function'
    ? context.get<WorkspaceRegistryLike>('workspaceRegistry')
    : undefined;

  async function workspaceOf(cwd: string): Promise<WorkspaceLike | undefined> {
    if (workspaces === undefined) return undefined;
    const existing = await workspaces.resolveByPath(cwd);
    if (existing !== undefined) return existing;
    return workspaces.create(cwd);
  }

  return {
    ok: true,
    port: {
      async createAnalysisSession(input) {
        const workspace = await workspaceOf(input.cwd);
        const value = await controller.create({
          agentPreset: input.agentPreset,
          ...(workspace === undefined ? { cwd: input.cwd } : { workspaceId: workspace.id }),
          // 刻意不传 sessionId：分析每次新建，不复用空白普通会话。
        });
        const sessionId = value?.sessionId;
        if (typeof sessionId !== 'string' || sessionId === '') {
          throw new Error('宿主 create 未返回有效 sessionId');
        }
        if (workspace !== undefined) {
          try {
            await workspace.attachSession(sessionId);
          } catch (error) {
            console.warn(`[dsh-cona-project] 分析会话 ${sessionId} 未能登记到工作区 ${workspace.id}：${(error as Error).message}`);
          }
        }
        return {
          sessionId,
          ...(typeof value.agentPreset === 'string' && value.agentPreset !== ''
            ? { agentPreset: value.agentPreset }
            : {}),
        };
      },
      async listSessions(): Promise<readonly DirectorySession[]> {
        const value = await controller.list();
        const out: DirectorySession[] = [];
        for (const item of value?.items ?? []) {
          const sessionId = item['sessionId'];
          if (typeof sessionId !== 'string' || sessionId === '') continue;
          out.push({
            sessionId,
            blank: item['blank'] === true,
            running: item['running'] === true,
            updatedAt: typeof item['updatedAt'] === 'number' ? item['updatedAt'] : 0,
            cwd: typeof item['cwd'] === 'string' ? item['cwd'] : null,
          });
        }
        return out;
      },
      async promptFirstMessage(input) {
        if (typeof controller.prompt !== 'function') {
          throw new Error('宿主 sessionController 未提供 prompt（版本不符）');
        }
        await controller.prompt({
          sessionId: input.sessionId,
          requestId: input.requestId,
          mode: 'queue',
          content: [{ type: 'text', text: input.text }],
        }, new AbortController().signal);
        return { accepted: true as const };
      },
      async cancelSession(input) {
        if (typeof controller.cancel !== 'function') {
          throw new Error('宿主 sessionController 未提供 cancel（版本不符）');
        }
        await controller.cancel({ sessionId: input.sessionId });
        return { accepted: true as const };
      },
    },
  };
}
