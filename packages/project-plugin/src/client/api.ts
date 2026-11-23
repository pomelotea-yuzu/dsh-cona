// Client 面板的应用接口（5.2）：面板只经这些方法读写，不直接碰宿主或文件。
// 类型与宿主 Remote 契约同源（application 层类型以 `import type` 引入，运行时不加载）。

import type {
  Command,
  CommandEnvelope,
  CommandResult,
  InversePreviewRequest,
  InversePreviewResult,
  UndoHistoryResult,
  UserTemplateListResult,
} from '../application/command-service.js';
import type { ProjectSnapshot, SnapshotResult, StreamEventView } from '../application/snapshot.js';
import type { ConaProjectStatus } from '../host/project-service.js';
import type { PresetDescriptor } from '../domain/presets.js';

export type PanelSnapshot = ProjectSnapshot;
/** 随包预设的预览载荷（host treePresets 结果）。 */
export type PresetView = PresetDescriptor;
export type TreePresetsResult =
  | { status: 'listed'; presets: PresetView[] }
  | { status: 'rejected'; code: string; message: string };

export interface SnapshotRequest {
  connectionGeneration: number;
  minStateRevision?: number;
  /** 目标实例；缺省为宿主配置的实例（R1 conaProject 契约）。 */
  instanceId?: string;
}

/** 面板可用的命令请求（与 `conaProject.execute` 的 request 同形）。 */
export interface ExecuteRequest {
  operationId: string;
  command: Command;
  expectedPlanVersion: string;
  expectedPlanRevision: number;
  sourceEpoch?: number;
  /** 目标实例；缺省为宿主配置的实例。 */
  instanceId?: string;
}

/** follow 订阅句柄（V32）：先订阅再回读，事件驱动失效替代纯 snapshot 轮询。 */
export interface FollowHandle {
  subscriptionId: string;
  connectionGeneration: number;
  ready: StreamEventView;
}

export interface FollowEventBatch {
  status: 'events' | 'closed' | 'not-found';
  events: StreamEventView[];
  nextIndex: number;
  closed: boolean;
}

/** 面板传输：实现可以是 HTTP 载体（当前）或宿主生成的 Remote 代理（后续替换）。
 * follow 相关方法可选：旧宿主没有时，controller 回退到 snapshot 定时轮询。 */
export interface PanelTransport {
  status(): Promise<ConaProjectStatus>;
  snapshot(request: SnapshotRequest): Promise<SnapshotResult>;
  execute(request: ExecuteRequest): Promise<CommandResult>;
  /** 随包流程预设列表（owner 入口；按实例路由由载体合并 instanceId）。 */
  treePresets?(): Promise<TreePresetsResult>;
  /** 2.6：统一树编辑器的独立只读回读；旧宿主未挂载时按可选方法降级。 */
  undoHistory?(request: { instanceId: string }): Promise<UndoHistoryResult>;
  userTemplates?(request: { instanceId: string }): Promise<UserTemplateListResult>;
  previewUndo?(request: InversePreviewRequest): Promise<InversePreviewResult>;
  previewUserTemplate?(request: {
    instanceId: string; templateId: string; title: string; bodyLanguage: string; rootNodeId: string;
  }): Promise<
    | { status: 'available'; text: string; summary: string; nodeCount: number }
    | { status: 'rejected'; code: string; message: string }
  >;
  follow?(request: { instanceId?: string; afterStateRevision?: number }): Promise<
    | { status: 'following'; value: FollowHandle }
    | { status: 'rejected'; code: string; message: string }
  >;
  followEvents?(request: { subscriptionId: string }): Promise<FollowEventBatch>;
  followClose?(request: { subscriptionId: string }): Promise<{ closed: boolean }>;
}

export type {
  Command, CommandEnvelope, CommandResult, ProjectSnapshot, SnapshotResult,
  ConaProjectStatus, StreamEventView, PresetDescriptor,
  InversePreviewRequest, InversePreviewResult, UndoHistoryResult, UserTemplateListResult,
};
