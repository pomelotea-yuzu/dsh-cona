# 项目工具协议（R1：project_read / project_apply / project_record / project_receipt）

> tasks 6.3，design §5。本文说明四个 Agent 工具的身份来源、参数契约、输出 schema 与拒绝语义。
> 工具定义：`src/host/project-tools.ts`（宿主 `tools.register` 结构体）；应用校验全部复用命令／快照服务。

## 1. 身份与准入

| 来源 | 规则 |
|---|---|
| 唯一身份 | 真实 `ToolRunContext.agent.id`（＝SessionId，2.4 实测）经 `WorkService.captureBinding` 映射到唯一生效 WorkRun |
| 参数 | **不提供任何可生效的身份／授权字段**；出现 schema 外的键（含 `sessionId`／`workRunId`／`bindingVersion`／`authorization` 等）一律 `operation-mismatch` 拒绝 |
| 无 invocation | 正常情况；agent 缺失 → `agent-missing`；会话无生效绑定 → `binding-expired`。均不降级、不读 owner 判据 |
| 写准入 | `WorkService.authorizeAgentCommand`：绑定版本当前、目标⊆范围、动作∈允许集、命令基线＝已接受基线（6.2） |
| 读取 | `project_read` 同样需要活动绑定；无绑定不读资料（避免无权读取泄露） |

## 2. 工具与参数

### project_read（只读）
- 参数：无（`additionalProperties: false`，不接受任何键）。
- 输出 `read`：`instanceId / projectId / planVersion / planRevision / stateRevision / sourceEpoch / binding{workRunId, bindingVersion, turn, targets[], allowedActions[]} / nodes[]（完整小树）/ dependencies[] / recordCount / readAt`。
- 用途：读取当前规划、当前版本和绑定范围。后续写入要求当前规划基线与该 WorkRun 的已接受基线一致。owner 写入造成规划变化时，读取仍可用于了解当前规划，已接受基线沿用原运行记录。需要按新规划写入时，待原运行结束后由 owner 从当前规划显式发起新工作。

### project_apply（五类规划命令）
- 参数（全部必填）：`operationId`（UUID v4）、`command`（`add-nodes / update-node / split-node / set-dependencies / set-node-status` 之一）、`expectedPlanVersion`、`expectedPlanRevision`、`sourceEpoch`。
- 拒绝：绑定外目标（`forbidden`）、根级新增（`forbidden`，不在节点目标集合内）、基线与绑定已接受基线不一致（`binding-expired`）、规划冲突／源代际变化（`plan-conflict` / `source-changed`）。
- 成功输出 `committed`：含 `impact / planVersion / planRevision / stateRevision / sourceEpoch / newBindingVersion`。规划提交成功后绑定版本自动 +1（只更新已接受基线，范围与动作不扩大）；**下一次工具调用必须重新捕获**（捕获发生在每次 execute 入口，旧捕获版本在提交时被拒）。

### project_record（记录追加）
- 参数：`operationId`（UUID v4）、`kind`（`plan-change / analysis-note / execution-note / verification`）、`subjectNodeIds`、`summary`、`sources[]`（`repositoryId` 必须是资料头已声明的仓库 id）、`body`（UTF-8 Markdown）、可选 `verification`（`status / subject{kind,id} / subjectVersion / scope`）。
- 基线取自捕获绑定（`acceptedBaseline`）；`impact: state`，不推进绑定版本。
- 幂等：同 `operationId` 原样重试返回原回执（`recordId` 不变）。

### project_receipt（回执查询）
- 参数：`operationId`（UUID v4）。
- 按 origin 隔离：只有同一 WorkRun 归属的操作可查；其他归属返回 `not-found` / `forbidden`，不泄露内容。
- 重试须引用原操作 id，不得换 id 重跑。
- 命中原操作时输出带 `replayed: true`（committed 形态）；首次提交结果不带该字段。

## 3. 输出 schema 约定

- 所有成功与失败输出都是 JSON 对象，`status` 字段区分：`read / committed / rejected / pending-reconciliation`。
- 每个 schema `additionalProperties: false`；committed／rejected／pending 共用 `COMMITTED_SCHEMA`（可选字段按形态缺省），read 用独立 schema。
- `pending-reconciliation`（`operationId / stage / message`）表示发布结果未知：**不能当作失败换 id 重试**，先 `project_receipt` 或离线核对（4.4／4.5 恢复协议）。
- 工具真实注册与真实模型调用的端到端验证随 6.6／7.1（真实 Agent 演示与整体交付核查）；本段交付适配器与准入链路的应用层验证。

## 4. 拒绝码速查

| 码 | 含义 |
|---|---|
| `operation-mismatch` | 参数形状／未知键／非法 kind 等参数层拒绝 |
| `agent-missing` | 工具上下文没有实际 Agent；不从参数补值 |
| `binding-expired` | 无生效绑定／捕获版本过期／基线漂移 |
| `forbidden` | 目标越界、动作不在范围、根级新增 |
| `plan-conflict` / `source-changed` | 提交时磁盘基线与命令基线不一致 |
| `invalid-project` / `unsupported-format` | 提交前重读资料失败 |
| `unknown-state` | 实例已隔离；先离线核对再解除 |
