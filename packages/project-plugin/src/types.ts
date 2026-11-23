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
  MoveNodeCommand,
  InsertPresetCommand,
  PresetCatalog,
} from './application/command-service.js'
export type { PresetDescriptor, PresetContentLocale, PresetNodeRef, PresetNodeText, PresetContent, PresetDependencyRef } from './domain/presets.js'
export type { ProjectSnapshot, SnapshotResult, PlanSummary, SnapshotSync, StreamEventView, FollowResult } from './application/snapshot.js'
// follow 订阅（V32）：Remote follow/followEvents/followClose 的边界类型。
export type { FollowOutcome } from './host/project-service.js'
export type { FollowHandleView, FollowEventBatch } from './host/follow-sessions.js'
// 聊天关联（tasks 6.1）：Remote chats/createChat/linkChat/unlinkChat/reconcileChats 的边界类型。
export type {
  ConversationOutcome,
  ChatsView,
  LinkView,
} from './application/conversations.js'
export type {
  ConaCreateChatRequest,
  ConaLinkChatRequest,
  ConaUnlinkChatRequest,
} from './host/project-service.js'
// 工作意图与 WorkRun（tasks 6.2）：Remote workList/workPrepare/workStart/workStop/workObserve 的边界类型。
// 有来源上下文与接续（tasks 6.4）：Remote workContext/workContinue 的边界类型。
export type {
  AdmissionResult,
  ContinueScopeRequest,
  ContextItem,
  WorkAction,
  WorkContext,
  WorkListView,
  WorkOutcome,
} from './application/work.js'
export type {
  ConaWorkObserveRequest,
  ConaWorkPrepareRequest,
  ConaWorkStartRequest,
} from './host/project-service.js'
// R2 任务 2.1：conaOverview Remote 边界类型（owner 多实例概览入口）。
export type { OverviewInstanceRow } from './host/instance-runtime-registry.js'
export type {
  OverviewListResult,
  ConaOverviewSnapshotRequest,
  ConaOverviewExecuteRequest,
  ConaOverviewFollowRequest,
  ResumeCardResult,
  ConaResumeCandidateRequest,
  CodeObservationView,
} from './host/overview-service.js'
export type { OwnerDenial } from './host/owner-admission.js'
// R2 任务 3.1/3.2：接续正文载荷（Remote resumeCard 边界类型）。
export type { ResumePayload, ResumeVerification, NextStepKind } from './domain/resume.js'
// R2 任务 3.3：接续聊天指针（Remote resumeChats/linkResume/resumeChatTarget 边界类型）。
export type { ResumeChatPointerView } from './application/resume-chat.js'
export type {
  ResumeChatChoiceView,
  ResumeChatsResult,
  ResumeLinkResult,
  ResumeChatTargetResult,
  ConaResumeChatsRequest,
  ConaLinkResumeRequest,
  ConaResumeChatTargetRequest,
  TreePresetsResult,
} from './host/overview-service.js'
// R2 收尾 1.4/1.5：位置迁移与接入登记（conaOverview migration*/register* 边界类型）。
export type { LocationKind } from './application/location.js'
export type {
  MigrationOutcome,
  MigrationPreviewResult,
} from './application/migration.js'
export type {
  MigrationRecord,
  MigrationReceipt,
  MigrationStatus,
} from './application/local-state.js'
export type {
  RegisterPreviewResult,
  RegisterSourceResult,
  ConaRegisterSourceRequest,
  ConaMigrationRequest,
  ConaMigrationRecoverRequest,
  MigrationOpResult,
  MigrationPreviewOpResult,
  MigrationListOpResult,
  LocalIssueView,
} from './host/overview-service.js'
