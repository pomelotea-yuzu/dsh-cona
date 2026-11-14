// 公开类型子路径（Remote 边界约定）：Remote 方法的边界类型必须从非根
// 类型子路径导出（生成器 publicRemoteType 检查），供 remote-client 产物引用。
export type { ConaProbeResult } from './host/diagnostic-service.js'
export type { ConaToolObservation } from './host/index.js'
export type {
  ConaExecuteRequest,
  ConaProjectStatus,
  ConaSnapshotRequest,
} from './host/project-service.js'
// 方法结果里出现的应用层类型同样需要可从该子路径取得。
export type {
  Command,
  CommandResult,
  CommandEnvelope,
  RejectedCommand,
  PendingCommand,
  CommittedCommand,
} from './application/command-service.js'
export type { ProjectSnapshot, SnapshotResult, PlanSummary, SnapshotSync } from './application/snapshot.js'
