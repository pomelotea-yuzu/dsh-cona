# R1 范围修订（2026-11-13，待第 2 轮外部 review）

> 本文是 2.4 实施中实测驱动的验收范围修订，不是实现进度声明。按项目工作流，修订完成后先交用户安排其他 Agent 审阅，审阅结果记入 `review.md`，处理依据记入 `review-response.md`，复查通过后才提交。本文不预填审阅意见。

## 触发事实

2.4 的原验收项要求实测“owner/non-owner principal”“工具无 invocation 但绑定有效可有限准入”与“agent 缺失／归属不唯一拒绝新绑定”。实测与源码核对表明这些前提在当前 R1 不成立：

1. **单用户部署没有 non-owner 身份面**：`PrincipalMap` 只定义 `owner`（`packages/typert/protocol/src/types.ts:455`）；唯一的非 owner 是 liveshare 的 `share-viewer`，需要独立部署的 Liveshare 服务（owner host + gateway worker + Relay；浏览器 OAuth 契约由部署方实现，见 `liveshare-protocol/README.md:29` 与 `identity/types.ts:35`），本机没有。浏览器 cookie 与 `/connect` API cookie 实测都是 owner。
2. **R1 没有绑定/准入层**：R1 只是诊断插件（Remote `conaDiagnostic/probe` + `cona_diag_context` 工具），绑定与“有限范围准入”属第 6 段（tasks 6.2／6.5）。原验收项指向尚不存在的代码。
3. **2.3 的 Client 观察依赖组合前提**：自定义 profile 默认只有 `@deepseek-ai/dsh-base`；不加 `@deepseek-ai/dsh-web-app` 就没有页面，Client 不可能加载。

按仓库红线，non-owner 与绑定准入不能用进程内伪造 principal、静态推理或自报身份补成 pass。

## 修订内容

| 文件 | 修订 |
|---|---|
| `tasks.md` | 2.4 拆成 2.4a（R1 可测：owner Remote、无 invocation 的 ToolRunContext、queue／steer／迟到／cancel／重启映射）与 2.4b（blocked，不属 R1，转第 6 段复测：non-owner、绑定准入、agent 缺失／归属不唯一拒绝绑定）。2.3 补组合前提（须含 `@deepseek-ai/dsh-web-app`）。 |
| `validation-matrix.md` | V25 拆成 V25a（owner Remote 与工具上下文映射，`pass`）与 V25b（`blocked`，内部再拆口径：i 绑定准入／agent 缺失归属拒绝，第 6 段复测并**计入 R1**；ii non-owner，R1 边界，**不阻 R1 完成**但随归档带入 R2+）。完成判据增加 V25b 例外条款，反例映射同步 V25a／V25b。 |
| `design.md` §7 | 增加“DSH 行为前提与验证状态”表：owner-only、工具路径无 invocation、queue 到 next-turn、steer 不 abort 在飞工具、cancel 替换结果并 aborted/user、Agent.id＝SessionId 稳定、callId 单次、profile 组合前提、R1 无绑定层。原“运行链路仍未验证”改为区分已验证与未验证。 |

## 不变项（防止借修订放水）

- 非 owner 拒绝、绑定准入、agent 缺失／归属不唯一的拒绝行为**仍是目标能力**，只是不在 R1 验收；保持 `blocked`，不改为 `pass`。
- 不新增“伪造 principal 测试”一类的替代证据；不以源码推断代替运行观察。
- 本次修订不改变 R1 已交付的实现范围，也不把 2.4b 计入完成度。

## 依据

- 实测：[2.4 映射记录](implementation/2026-11-13-2.4-mapping-record.md)、[环境记录第二轮](implementation/2026-11-13-environment-record.md)。
- 源码：`packages/typert/protocol/src/types.ts:455-461`（PrincipalMap）、`packages/core/tools/src/contracts.ts:175-203`（ToolExecutionInput）、`liveshare-protocol/README.md:29` 与 `src/identity/types.ts:35`（独立部署与 OAuth 契约）。

## 供审阅者判断的问题

1. 把 non-owner 与绑定准入移出 R1 验收、转第 6 段复测，是否接受？还是 R1 必须依赖真实 Liveshare 部署（会显著扩大范围）？
2. V25a 以“owner Remote + 工具上下文 + turn 映射”为 R1 验收，是否足够覆盖原 V25 的意图？
3. 2.4a 在修订通过后勾选、2.4b 保持 blocked，是否同意这种拆分方式？

## 第 2 轮审阅后状态（2026-11-13）

- 审阅裁决：接受将 non-owner 与绑定准入移出 2.4 验收；R1 不依赖真实 Liveshare 部署。
- 按 R2-A1 拆清：绑定准入与 agent 缺失／归属不唯一（V25b-i）必须在 6.2／6.5 复测并计入 R1；non-owner（V25b-ii）保持 R1 边界，其 blocked 不阻 R1 完成，随归档带入 R2+。
- R2-C1／C2 已修订；2.4a 在放行后勾选。逐项处理见 [review-response](review-response.md)。
