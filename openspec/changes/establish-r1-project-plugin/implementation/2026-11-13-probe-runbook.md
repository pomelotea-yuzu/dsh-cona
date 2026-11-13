# R1 2.4 探针执行手册（交给 DSH / 用户在真实会话中执行）

> 目的：完成 tasks 2.4 剩余项——无 invocation 的真实 ToolRunContext、queue／steer／迟到工具／重启映射、non-owner principal。
> 前提：`cona-r1-test` profile 已含 web-app bundle（2.3 第二轮完成）；本轮已重装含 Client 自动探针的新 tarball（commit `fba1536`）。
> 纪律：结论只写实测事实；不把静态核对当运行证据；做不到的项记 blocked/untested 并写明原因。结果回写[环境记录](2026-11-13-environment-record.md)「2.4 实测」一节。

## Phase 0：确认环境

1. 重装最新包（Client bundle 已含自动探针）：
   ```sh
   cd packages/project-plugin && pnpm build
   npm pack . --pack-destination ../../artifacts/pack
   dsh plugin --profile cona-r1-test remove dsh-cona-project
   dsh plugin --profile cona-r1-test add ../../artifacts/pack/dsh-cona-project-0.1.0.tgz
   ```
2. 启动 web：`dsh --profile cona-r1-test --port 0 --no-open`，记下 URL 与 token。
3. 浏览器打开 URL，devtools console 过滤 `[dsh-cona-project]`。

## Phase 1：Client 侧真实 Remote invocation（owner）

自动执行：页面加载后 console 依次应出现

- `client factory loaded`
- `remote contribution mounted (conaDiagnostic/probe)`
- `probe ok (attempt N): {...}`

**记录**整段 JSON。判读标准：

| 字段 | 期望（owner peer） | 含义 |
|---|---|---|
| `hasInvocation` | `true` | 网关挂了真实 invocation（对照 2.3 HTTP 直调） |
| `peerPrincipal` | `{"kind":"owner"}` | 调用方身份 |
| `principalOfResult` | 字段缺省 | owner 时 `principalOf` 返回 undefined（协议语义） |
| `runtime.nodeVersion` | `v24.21.0` | 宿主进程 |

若出现 `probe threw`/`remote-error`：记原文，重试一次再判。

## Phase 2：工具侧无 invocation 的 ToolRunContext

在该 web profile 里新建会话，发送：

> 请调用 cona_diag_context 工具，并原样告诉我它的输出。

**记录**工具输出 JSON（agentId／callId／signalAborted／capturedAt）。判读：

| 字段 | 期望 | 含义 |
|---|---|---|
| `agentId` | 非 null 字符串 | ToolRunContext 带 Agent.id（= SessionId） |
| `callId` | 非 null | 本次调用链 id |
| `signalAborted` | `false` | 正常执行未被取消 |

## Phase 3：queue / steer / 迟到工具

按顺序在**同一会话**做三轮，每轮都让模型先调 `cona_diag_context`：

1. **queue**：发出「调 cona_diag_context 然后总结当前项目结构」后，**不等回答**立刻发第二条消息（如「只总结第一步」）。记录：第二条是否排队（不打断）、两轮的 callId 是否不同、agentId 是否一致。
2. **steer**：发出长任务指令，模型执行中用 steer（打断改向）改指令。记录：steer 后是否产生新 callId；被打断侧的 signalAborted 是否变 `true`。
3. **迟到工具**：构造让旧调用在新指令后返回的场景（如 steer 后旧工具结果到达）。记录：迟到结果如何呈现、agentId 归属哪个 turn。

## Phase 4：重启映射

调一次 `cona_diag_context` 记录 agentId → 重启宿主（`dsh --profile cona-r1-test` 重新起）→ 同一会话（resume）再调一次。记录：resume 后 agentId 是否稳定、callId 是否换代、Client 探针（Phase 1 日志）是否重放。

## Phase 5：non-owner principal（尽力而为）

- 尝试面：无 cookie 的新隐身窗口访问同 URL（预期连页面都进不去→记录 401/拒绝形态）；若 DSH 支持第二身份/访客会话，用它调 probe。
- **允许 blocked**：若单用户部署无法构造 non-owner peer，记 blocked 并写明原因（如「gateway 仅认 owner cookie，无第二身份面」），留给第 4/6 段的授权设计验证。

## 汇总

全部结果回写环境记录「2.4 实测」一节，并按 tasks.md 措辞勾选；工具/Remote 映射结论写完后同步更新 [知识库踩坑文档](../../../../docs/knowledge/2026-11-13-dsh-typert-plugin-gotchas.md)（如有新契约）。
