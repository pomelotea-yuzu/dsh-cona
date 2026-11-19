# V32 follow 订阅与重新订阅（2026-11-17）

状态：V32 由 untested 转 pass。实现 `conaProject/follow` 订阅入口，面板从纯 5 秒 snapshot 轮询改为“先订阅 → ready 回读 → 事件驱动失效”，重连时真正重新订阅。真实浏览器 8/8；插件包 250/250，`pnpm check:ci` 全链通过。证据在本机 `artifacts/r1-v32-test/`（不入库）。

## 背景与决定

V32 原文要求“重新订阅／完整回读看到已提交事实，未提交编辑及基线保留”。此前面板用 5 秒 snapshot 轮询，`conaProject.follow` 未接，5.3 记录据此保持 V32 untested。

1. **typert 原生 stream 无法用于本面板**：`@Remote(..., {mode:'stream'})` 返回 AsyncIterable，但真正的流传输由宿主 client loader 提供；本项目面板走手写 `/api` JSON RPC（`createHttpTransport`），生成的 `typert.remote-client` 只有 zod schema／元信息，无 fetch/ws 载体，无法消费 stream。
2. **HTTP 可拉的订阅句柄**：Host 侧把应用层 `snapshot.follow()` 的 AsyncIterable 泵入有界缓冲（`host/follow-sessions.ts`），新增三个 unary Remote：`follow`（建订阅，返回 subscriptionId + ready + connectionGeneration）、`followEvents`（拉新事件，不阻塞）、`followClose`（释放）。这是真正的服务端订阅对象与事件流，不是把 snapshot 轮询改名。
3. **代际以 host 为权威（实测发现的真 Bug 并修复）**：`InMemoryChangeStream.nextGeneration` 的代际与 client 本地 generation 原本是两个计数器。初次接入时 client 从 1 起、host 已因 API 探测到 8，`snapshot` 带 1 被 `stale-connection` 拒绝，面板卡在 Loading project…。修复：`establishFollow` 拿到 host 的 `connectionGeneration` 后同步到 `state.connection.generation`，后续读取带同一代际。
4. **兼容旧宿主**：`PanelTransport` 的 follow 相关方法为可选；旧宿主或订阅被拒时 `establishFollow` 返回 undefined，controller 回退到原 snapshot 轮询，现有 5.2/5.3 行为与 244 项原测试不变。
5. **资源约束**：句柄上限 16、每句柄事件上限 512，超限淘汰最旧；同实例新订阅关闭旧订阅（与应用层 nextGeneration 一致）；AsyncIterable 耗尽即标记 closed，client 下次 poll 自动重订阅。

## 交付

| 文件 | 内容 |
|---|---|
| `src/host/follow-sessions.ts`（新增） | `FollowSessions`：start/drain/dispose、有界缓冲、同实例旧句柄关闭、事件耗尽标记 closed |
| `src/host/project-service.ts` | 三个 `@Remote`：follow / followEvents / followClose（owner `deny()` 准入；实例一致性；参数校验）；`FollowOutcome` 类型 |
| `src/client/api.ts` | `PanelTransport` 增加可选 follow/followEvents/followClose 与 `FollowHandle`／`FollowEventBatch` 类型 |
| `src/client/http-transport.ts` | 实现三个方法的 HTTP 线协议 |
| `src/client/panel-controller.ts` | `establishFollow()`（先订阅再回读、代际同步）、`open`/`reconnect` 重建订阅、`poll` 事件驱动（有更高修订才回读，无订阅回退轮询）、释放旧订阅 |
| `src/types.ts` | 导出 Remote 边界类型（满足 typert publicRemoteType 检查） |
| `test/follow-v32.test.ts`（新增） | 6 项：句柄 ready/批量拉取/关闭、同实例替换与上限、open 先订阅带水位、poll 有事件才回读、reconnect 重订阅且草稿保留、旧宿主回退 |

## 真实浏览器证据（artifacts/r1-v32-test/）

预构建 tarball 全新 home（含本轮 follow 代码，已核对安装副本与源码 hash 一致），真实宿主 Node v24.21.0、DSH 0.2.2-rc.2，Playwright Chromium en-US。

| 场景 | 结果 |
|---|---|
| 面板用订阅 | 打开面板调 `conaProject/follow` 1 次、`followEvents` 1 次（route 计数），确认不是纯 snapshot 轮询 |
| 断线显示 | 阻断 `/api/conaProject/**` 后面板显示 Disconnected |
| 重新订阅 | 点重连后 follow 调用 1→2、连接代际 7→8（host 代际为权威） |
| 完整回读 | 重连后小树完整（含各阶段节点） |
| 草稿与基线 | 未提交的 Goal 草稿逐字保留，保存后落盘（`project.json` 对应节点目标字节确认） |
| 订阅句柄语义（API 层） | follow 首事件为 ready；重订阅返回新 subscriptionId 且旧句柄 closed；followClose 后再拉为 not-found；afterStateRevision 水位进入 ready |

`v32-result.json`：8/8 通过、0 errors。

## 已知边界

- 宿主重启导致的外壳白屏与草稿不持久化仍存在（宿主层行为，5.3 已记），V32 用网关级 API 中断模拟断线，不杀宿主。
- follow 句柄是进程内内存缓冲：宿主重启即失效，client 下次 poll 收到 not-found 会自动重订阅；不跨进程持久，符合 design §8 的不可靠失效流语义。
- 通知只触发回读，权威内容始终来自 snapshot；事件不携带项目正文。
- V32 转 pass 后 V37（六能力整体闭环）因必做的 V32／V04 均 pass、7.1 已重走完整闭环而转 pass；7.2／7.3 是独立收尾任务。
