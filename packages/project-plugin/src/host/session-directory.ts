// 宿主会话目录适配器（tasks 6.1，design §7）：把 DSH `sessionController` 服务
// 适配成应用层的 `SessionDirectoryPort`。插件进程内直调（同宿主信任域），
// 不经 gateway Remote，也不读 invocation——创建／列举本身不需要主体授权。
//
// 边界：只暴露 create（宿主自动复用可复用的空白会话）与 list（只读，不 resume）；
// prompt／cancel／resolveAgent 等动作留待 6.2／6.3 的绑定与工具段落。

import type { Context } from '@deepseek-ai/cordis'
import type { PlanNodeViewPort, SessionDirectoryPort, SourceFilesPort } from '../application/ports.js'
import { readSourceBaseline } from '../application/baseline.js'
import type { ProjectDocument, Sha256Fn } from '../domain/types.js'

/** 与 dsh-api-session-controller 的 SessionController 运行时形态对齐的最小结构。 */
interface SessionControllerLike {
  create(request: { sessionId?: string; cwd?: string; workspaceId?: string }): Promise<{ sessionId: unknown }>;
  list(signal?: AbortSignal): Promise<{ items?: ReadonlyArray<Record<string, unknown>> }>;
}

/** 宿主工作区登记表的最小形态（5.4 H 层实测：会话必须落在已登记工作区里，
 *  否则 Web UI 的会话列表不收录、`openSession` 导航到空态）。 */
interface WorkspaceLike {
  /** 宿主 Workspace 实体的身份字段是 `id`（不是工作区视图的 workspaceId）。 */
  id: string;
  /** 让新建会话进入该工作区；宿主会话列表与导航都以这份记账为准。 */
  attachSession(sessionId: string): Promise<void>;
}
interface WorkspaceRegistryLike {
  resolveByPath(path: string): Promise<WorkspaceLike | undefined>;
  create(path: string, title?: string): Promise<WorkspaceLike>;
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
  // 可选依赖：拿不到工作区登记表时退回只按 cwd 新建（旧宿主行为）。
  const context = ctx as Context & { get?: <T>(name: string) => T | undefined };
  const workspaces = typeof context.get === 'function'
    ? context.get<WorkspaceRegistryLike>('workspaceRegistry')
    : undefined;
  /** 让本实例资料根成为宿主可见工作区；同路径幂等复用。 */
  async function workspaceOf(): Promise<WorkspaceLike | undefined> {
    if (workspaces === undefined) return undefined;
    const existing = await workspaces.resolveByPath(cwd);
    if (existing !== undefined) return existing;
    return workspaces.create(cwd);
  }
  return {
    ok: true,
    directory: {
      async createSession() {
        const items = (await controller.list()).items ?? [];
        const blank = items.find(
          (item) => item['blank'] === true && item['cwd'] === cwd && typeof item['sessionId'] === 'string',
        );
        // create 只接受 workspaceId 或 cwd 之一：有工作区时用 workspaceId（其路径即 cwd）。
        const workspace = await workspaceOf();
        const request =
          blank !== undefined
            ? { sessionId: blank['sessionId'] as string, ...(workspace === undefined ? { cwd } : { workspaceId: workspace.id }) }
            : workspace === undefined
              ? { cwd }
              : { workspaceId: workspace.id };
        const value = await controller.create(request);
        const sessionId = value?.sessionId;
        if (typeof sessionId !== 'string' || sessionId === '') {
          throw new Error('宿主 create 未返回有效 sessionId');
        }
        // 会话只会因工作区记账才出现在宿主会话列表、才能被 openSession 导航；
        // 宿主 sessionController.create 本身不记账（5.4 H 层实测）。
        if (workspace !== undefined) {
          try {
            await workspace.attachSession(sessionId);
          } catch (error) {
            console.warn(`[dsh-cona-project] 会话 ${sessionId} 未能登记到工作区 ${workspace.id}：${(error as Error).message}`);
          }
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
          // 实例归属（3.1）：只列本实例工作区（cwd 与资料根一致）的会话，
          // 使另一副本的会话不可见、不可被冒领；cwd 缺失的会话无法归属，不列出。
          const itemCwd = typeof item['cwd'] === 'string' ? item['cwd'] : null;
          if (itemCwd !== cwd) continue;
          out.push({
            sessionId,
            blank: item['blank'] === true,
            running: item['running'] === true,
            updatedAt: typeof item['updatedAt'] === 'number' ? (item['updatedAt'] as number) : 0,
            cwd: itemCwd,
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
  async function readDoc(): Promise<
    { ok: true; doc: ProjectDocument } | { ok: false; code: string; message: string }
  > {
    const root = sourceRoot();
    if (root === null) {
      return { ok: false, code: 'binding-expired', message: '实例未打开；无法读取规划内容' };
    }
    const baseline = await readSourceBaseline(files, root, sha256, clock);
    if (!baseline.ok) {
      return {
        ok: false,
        code: 'invalid-project',
        message: '资料不可读或引用正文不一致；无法读取规划内容',
      };
    }
    return { ok: true, doc: baseline.doc };
  }
  return {
    async currentNodeIds() {
      const read = await readDoc();
      if (!read.ok) return read;
      return { ok: true as const, nodeIds: new Set(read.doc.plan.nodes.map((node) => node.id)) };
    },
    /** 工作预览（3.2）：目标条件／目标／父级 + 全部规划依赖；仍只取请求的节点。 */
    async planTargets(ids) {
      const read = await readDoc();
      if (!read.ok) return read;
      const wanted = new Set(ids);
      return {
        ok: true as const,
        nodes: read.doc.plan.nodes
          .filter((node) => wanted.has(node.id))
          .map((node) => ({
            id: node.id,
            title: node.title,
            status: node.status,
            goal: node.goal,
            completionCriteria: [...node.completionCriteria],
            parentId: node.parentId,
          })),
        dependencies: read.doc.plan.dependencies.map((edge) => ({
          nodeId: edge.nodeId,
          requiresNodeId: edge.requiresNodeId,
        })),
      };
    },
    /** 结构命令影响范围（3.3）：只投影 id／父级／顺序，不携带任何正文。 */
    async planOutline() {
      const read = await readDoc();
      if (!read.ok) return read;
      return {
        ok: true as const,
        nodes: read.doc.plan.nodes.map((node) => ({ id: node.id, parentId: node.parentId, order: node.order })),
      };
    },
    async nodeDetails(ids) {
      const read = await readDoc();
      if (!read.ok) return read;
      const wanted = new Set(ids);
      // 只取请求的节点与记录索引，不注入整棵树（spec：不能把整棵树无差别注入）。
      return {
        ok: true as const,
        nodes: read.doc.plan.nodes
          .filter((node) => wanted.has(node.id))
          .map((node) => ({ id: node.id, title: node.title, status: node.status })),
        records: read.doc.records.map((record) => ({
          id: record.id,
          kind: record.kind,
          summary: record.summary,
          subjectNodeIds: [...record.subjectNodeIds],
          path: record.path,
        })),
      };
    },
  };
}
