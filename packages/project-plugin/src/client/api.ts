// Client 面板的应用接口（5.2）：面板只经这些方法读写，不直接碰宿主或文件。
// 类型与宿主 Remote 契约同源（application 层类型以 `import type` 引入，运行时不加载）。

import type { Command, CommandEnvelope, CommandResult } from '../application/command-service.js';
import type { ProjectSnapshot, SnapshotResult } from '../application/snapshot.js';
import type { ConaProjectStatus } from '../host/project-service.js';

export type PanelSnapshot = ProjectSnapshot;

/** 面板可用的命令请求（与 `conaProject.execute` 的 request 同形）。 */
export interface ExecuteRequest {
  operationId: string;
  command: Command;
  expectedPlanVersion: string;
  expectedPlanRevision: number;
  sourceEpoch?: number;
}

/** 面板传输：实现可以是 HTTP 载体（当前）或宿主生成的 Remote 代理（后续替换）。 */
export interface PanelTransport {
  status(): Promise<ConaProjectStatus>;
  snapshot(request: { connectionGeneration: number; minStateRevision?: number }): Promise<SnapshotResult>;
  execute(request: ExecuteRequest): Promise<CommandResult>;
}

export type { Command, CommandEnvelope, CommandResult, ProjectSnapshot, SnapshotResult, ConaProjectStatus };
