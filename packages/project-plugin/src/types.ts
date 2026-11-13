// 公开类型子路径（Remote 边界约定）：Remote 方法的边界类型必须从非根
// 类型子路径导出（生成器 publicRemoteType 检查），供 remote-client 产物引用。
export type { ConaProbeResult } from './host/diagnostic-service.js'
export type { ConaToolObservation } from './host/index.js'
