# R2 顶部项目入口与接续验证矩阵

编写于 2026-11-18。A 为自动测试，F 为实际文件后端或真实工作副本，H 为固定 DSH 真实宿主与预构建安装包。组合项须达到所列层级才标 `pass`。按[工作流](../../../../docs/development/workflow.md)记录环境、重复步骤和实际结果。当前 13 项均为 `untested`。

| ID | [增量场景](specs/project-overview-resume/spec.md) | 方法与观察点 | 状态 |
|---|---|---|---|
| O01 | 从不同宿主页面打开项目 | H · 聊天页、非聊天页、窄窗口和侧栏收放时验证入口、点击区域、展开层及宿主控件 | `untested` |
| O02 | 用键盘开合并保留编辑 | H · 键盘展开、焦点进入、Escape 收起、焦点返回，核对树和接续草稿及宿主输入。从 A、B 分别进入既有树编辑器，核对面板、实际实例、节点与草稿。确认打开树后概览收起，返回后位置正确。卸载重装无重复入口或监听 | `untested` |
| O03 | 切换资料实例时旧响应迟到 | A＋H · 注入 A 迟到快照和旧通知，切 B 并重连。对照 A→B、B 重连和 B→A 的 `follow`／`followClose`、代际及活动句柄数，核对各次切换后只有一个浏览句柄。测试同 project id 的不同目录、未登记实例及非 owner 请求。回到 A 验证草稿 | `untested` |
| O04 | 实例不可用或没有接续记录 | F＋H · 核对无配置且无登记、默认配置失败且尚无登记、已登记但资料不可读、可读但无接续四种结果。已登记不可读行和树入口禁用并给出原因，其他可读实例可选 | `untested` |
| O05 | 保存并重读最新记录 | F＋H · 分别缺少停点或下一步，核对草稿保留和公开文件、修订不变。预览与实际公开文件一致且无本机字段。B 先后保存两条，切 A 再重启后返回 B，核对 A 隔离、B 展示最新记录，旧记录和来源仍可读。复算 planVersion，v1 校验器通过，只有 B 的状态修订推进 | `untested` |
| O06 | 响应丢失或提交基线过期 | F＋H · 在回执处断开 Client 再重试，核对只追加一次。注入规划变化和源代际切换，核对冲突与原草稿。旧回执不得把 Git 回退的记录重新显示为当前 | `untested` |
| O07 | 摘要已保存但聊天指针未保存 | F · 在公开提交后注入本机指针失败或结果未知，核对分项状态和隔离。明确失败可对原记录重试，检查公开记录数和 id 不变 | `untested` |
| O08 | 有历史证据且基线已变 | F＋H · 在原本干净的 project-directory 实例保存接续并立即回读，确认仅资料目录写入时无代码漂移提示。分别改变规划、仓库 HEAD 和工件字节，核对待核对范围。纯规划实例明确显示代码未核对。pass／fail／blocked／untested 维持原样，建议与已确认安排可辨 | `untested` |
| O09 | 接续记录未知或证据无法验证 | F＋H · 较新普通 `execution-note` 被跳过。最新带标记候选的未知版本、超限、坏结构及哈希不符分别显示原因，核对只选取一条候选并且从未显示旧接续。另测有效卡片缺证据、工作副本映射缺失和脏树时摘要维持可读 | `untested` |
| O10 | 查阅有效或越界的代码和工件引用 | F＋H · 打开有效记录与工作副本内文件，覆盖删除、其他实例、向上跳转和符号链接越界。公开文本中的路径或命令不触发操作 | `untested` |
| O11 | 多个关联聊天时打开选定会话 | H · A 有活动 WorkRun 时浏览并保存 B，核对 A 目标、队列及另一 Client 订阅。B 的节点关联两个真实会话，打开确切 Session，核对发送数和 WorkRun。验证 B 的插件开始动作禁用，B 会话无 A 活动绑定时工具拒绝，A 显式发起工作走 R1 准入 | `untested` |
| O12 | 原聊天已失效或从干净环境接入 | F＋H · 解绑或删除后回读，再把公开资料交给干净 profile，放入同名会话。按文件检查公开结构无私有指针、Session 或执行授权，摘要仍可读 | `untested` |
| O13 | 在编辑中切换宿主语言 | A＋H · 字典校验，真实切换中英与日语回退。核对长文本、日期、空态、错误状态和草稿原文 | `untested` |

## 1.1 宿主探针注记（2026-11-19）

任务 1.1 在真实 DSH `0.2.2-rc.2` 隔离 profile + 预构建包上完成候选路径探针，结论见 [实施记录](implementation/2026-11-19-1.1-host-probe.md)：`shell.overlay` root slot 实渲染并可见（含窄窗口/跨页）、`layout`／`uiWorkspace` 可注入、`selectPanel('cona-project')` 在 slot 注册后落到 R1 既有树编辑器、`openSession` 落到指定 Session。这证明 **O01／O02／O11 的宿主接入路径可用**，但产品按钮、键盘收起、草稿保留与安全复查尚未实现，故三条产品场景仍保持 `untested`，不因探针改标 pass。selectPanel 的注册时机约束带入任务 2.2。

## 2.1 多实例运行时注记（2026-11-19）

任务 2.1 的 Host 层完成，见 [实施记录](implementation/2026-11-19-2.1-instance-runtime.md)：`conaOverview` owner 入口实测可列出同 projectId 两实例、按 instanceId 读快照（B 按需装配）、未登记实例 `forbidden`、R1 `conaProject` Remote 不受影响；6 项单测覆盖实例隔离与不可读诊断。这支撑 **O03（实例路由/未登记拒绝）与 O04（不可读诊断）的后端能力**，但订阅切换的迟到事件丢弃、草稿隔离与「保存 B 时 A 不变」依赖 2.2/3.x 的 UI 与接续写入，三条产品场景仍保持 `untested`，不因后端完成改标 pass。

## 2.2 概览 UI 注记（2026-11-19）

任务 2.2 主体完成，见 [实施记录](implementation/2026-11-19-2.2-overview-ui.md)。真实浏览器实测通过的可观察项：顶部按钮可见/展开（O01）、两实例列表、Escape 收起+焦点返回与键盘展开（O02）、窄窗口、进入所选实例 B 的树编辑器显示 B 的资料（浏览隔离，关联 O11）、不可读实例禁用+诊断（O04）。**但** O13（运行中语言切换）、草稿按实例保留的 UI 复测、跨页保留未做，故 O01/O02/O13 的产品场景状态仍保持 `untested`，不因部分可观察项通过改标 pass。

## 3.1 接续记录注记（2026-11-19）

任务 3.1 的格式与保存闭环完成，见 [实施记录](implementation/2026-11-19-3.1-resume-record.md)：真实文件后端证实带前缀 execution-note 经 append-record 保存、只推进状态修订、索引候选选取、正文哈希核对、解析往返、同 operationId 幂等只一条、普通记录不误选；不可读分支各有稳定码。这支撑 **O05（保存并重读）与 O06（响应丢失/基线过期的幂等部分）的后端能力**，但聊天指针分项（O07）、共享预览、针对接续命令的故障注入、卡片 UI 未做，故对应产品场景仍保持 `untested`，不因格式/保存闭环完成改标 pass。

## 3.2 接续卡片与代码观察注记（2026-11-19）

任务 3.2 三段完成，见实施记录（[3.2a 卡片投影](implementation/2026-11-19-3.2-resume-card.md)／[3.2b 保存 UI](implementation/2026-11-19-3.2-resume-save.md)／[3.2c 代码观察](implementation/2026-11-19-3.2-work-copy.md)）。真实浏览器实测通过的可观察项：A 卡片齐全/B 空态与诊断（O04 部分分句）、表单保存→回执→卡片刷新→幂等重试（O05 部分分句：必填缺失保留草稿、预览带前缀、修订只推进状态）、`workCopyRoots` 映射下 HEAD+脏计数显示与资料目录排除、纯映射缺失实例显示"代码未核对：未配置"（O08 部分分句）、坏 marker/坏 JSON/版本未知/超限的领域级诊断单测与哈希不符集成测试（O09 部分分句）。**但** O04 的无配置/默认配置失败分支、O05 的 B 双条保存与重启返回、O08 的分别改变规划/HEAD/工件字节的核对矩阵、O09 的浏览器级损坏正文注入均未跑；O10（引用查阅/越界）未实现。故 O04–O09 产品场景仍保持 `untested`，不因部分可观察项通过改标 pass。

## 3.3 聊天指针与导航注记（2026-11-20）

任务 3.3 的代码与单测完成，见 [实施记录](implementation/2026-11-20-3.3-chat-pointer-navigation.md)：本机指针 `ResumeChatPointer`（recordId+contentHash↔linkId，幂等、版本限定、隔离同口径）16 项文件后端单测；`conaOverview` 的 `resumeChats`/`linkResume`/`resumeChatTarget` 入口与卡片指针三态；client 保存表单聊天选择、部分保存（O07 的 F 层分项：指针失败→partial→重试只调 linkResume、公开记录数不变）5 项控制器单测；打开前 Host 复查（版本变化/链接缺失/会话不可见稳定码）后仅用 `uiWorkspace.openSession` 导航；中英 8 键 + `check:locale`。这支撑 **O07 的 F 层、O11/O12 的后端与复查能力**。但真实宿主 H 层（打开确切 Session、多聊天选择、A 有 WorkRun 时保存 B 的隔离核对、解绑/干净 profile 回读、运行中语言切换）未跑，O07/O11/O12/O13 产品场景仍保持 `untested`，不因代码与单测完成改标 pass。

## 3.3 真机探针注记（2026-11-20）

任务 3.3 H 层实测完成并勾选，见 [真机探针记录](implementation/2026-11-20-3.3-host-probe.md)。probe-36 16/16：保存时从多条本机链接明确选一（宿主空白会话复用语义下用 linkChat 构造两个真实会话）→ 指针 `linked` 精确匹配 → 点击「打开原聊天」经 `resumeChatTarget` 复查（确切 sessionId）→ 会话界面真实出现（O11 核心分句）；解绑回读摘要保留 +「原聊天在此不可用」（O12 前半）。probe-37 7/7：干净 profile 摘要可读 + 无打开动作 + 原会话不在 + 公开 records 无 session-/linkId/workRunId/resumePointer 字样 + 旧实例 `forbidden` + 当前实例 `pointer-not-here`（O12 后半；探针发现干净 profile 语义缺口并以「savedAt 早于登记时刻」判据修复）。probe-38 7/7：en 渲染 + ja 英文回退 + zh 对照 + 无原始 key 泄漏（O13 回退分句）。探针另修复卡片刷新早于指针写的时序 bug。**O07/O11/O12/O13 产品场景仍保持 `untested`**（不改标 pass）：O07 的故障注入由单测覆盖（F 层分项）；O11 的 A 有 WorkRun 保存 B/开始动作禁用/工具拒绝与 O13 的运行中切换 UI 属 4.1 闭环。

## 4.1 宿主闭环注记（2026-11-20）

任务 4.1 的 H 层闭环完成，见 [实施记录](implementation/2026-11-20-4.1-host-closed-loop.md)；六段真实宿主探针合计 50/50（baseline 7、work 8、main 14、restart 7、clean 8、locale 6）。固定 DSH `0.2.2-rc.2`、预构建 tarball（sha256 `038f4c75…475338`）、独立 profile、Playwright Chromium，宿主 Node `v24.21.0`。

- **O11 可验分句（H pass）**：A 的生效 WorkRun（`workPrepare→start→consumed`，targets/version/effective 正确）在浏览 B、`conaOverview/execute` 保存 B 接续后逐项不变；A 的两条 Client `follow` 订阅前后存活；A 公开记录未被 B 停点污染；重启后旧 WorkRun `effective=false`、无运行复活、A 资料树与记录保留、A/B 接续卡片回读成功。
- **O12（H pass）**：新建干净 home 自动登记 `89c33dd3…`@proj-b（空聚合），接续摘要可读 +「原聊天在此不可用」+ 无打开动作；旧实例 `forbidden`、`pointer-not-here`、宿主会话列表无原 Session；proj-b 全部 10 个公开记录文件无 `session-`/`linkId`/`workRunId`/`resumePointer` 私有字段。
- **O13（H pass）**：账号菜单→设置→语言 English 运行中切换，`<html lang>` zh-CN→en、概览文案英文化、无原始 key、面板仍交互、无页面错误；切换持久化到 `cordis.patch.yml.preference=en`。
- **O11 未测分句（保持 untested）**：B 会话无 A 绑定时工具拒绝、B 的插件开始动作禁用、B 节点关联两个真实会话并打开确切 Session——design §2 明确「切换运行实例与 B 自动 WorkRun 留后续 change」，`conaOverview` 无 `createChat/linkChat`，B 无本机聊天链接，H 层无法构造；工具准入由 R1 6.2/6.3 覆盖，多聊天打开由 3.3 probe-36 在 A 上覆盖。不冒充通过。
- 观测到的约束（非产品失败）：`overview-service.ts:245` 卡片投影硬编码 `connectionGeneration:0`，配置实例 A 被 `conaProject/follow` 推进代际后其概览卡片短暂 `stale-connection`；B 实例独立状态不受影响。留给 R6 试用确认。
- O01–O10 状态不因 4.1 改变；O10（引用查阅/越界）不在 4.1 场景内，维持 `untested`。

## 4.2 R1 回归注记（2026-11-20）

任务 4.2 完成，见 [实施记录](implementation/2026-11-20-4.2-r1-regression.md)。R1 三项回归在 R2 预构建包（sha256 `038f4c75…475338`）上复跑合计 **21/21**：V15 实例不符 6/6（overview 未登记实例、follow 实例不符、execute 项目不符均 `forbidden`，同 operationId 换参数 `operation-mismatch`）、V32 重连 8/8（follow 订阅、断线、重订阅、代际推进、草稿保留、树回读、落盘；R2 面板路由由 `conaProject/*` 变为 `conaOverview/*`，语义不变）、V37 卸载重装 7/7（同实例、11 节点/10 记录/planVersion/草稿/聊天链接保留、旧 WorkRun `effective=false`）。这些回归支撑 O03（未登记/非 owner 拒绝）、O11 隔离结论在 R2 下不退化；不改变本 change 各场景状态。

门禁按 CI 固定版本核对：OpenSpec 1.17.0 严格校验 1/1、pnpm 12.18.0 相符；宿主自带 Node `24.21.0` 二进制下 check-repo（118 篇 0 问题）与 305/305 测试通过；shell 默认 Node 22.22.2 与 CI 差异已用宿主 Node 补跑消除。诚实边界：V37 真实 Agent split+record 分句因本机隔离 home 无 LLM 凭证受阻（`blocked`），R1 历史 pass 为当时临时凭证证据，本轮不伪造；可重复步骤与宿主限制写入实施记录留 R6。

## 编写交接

2026-11-18 在本机使用 Node `26.13.0` 与独立安装的 OpenSpec `1.17.0`。`openspec validate add-project-overview-and-resume --type change --strict --no-interactive --json` 返回 `valid: true`，1 项通过，0 问题。`node scripts/check-repo.mjs --all` 在包含新增文件和索引改动的临时 Git 快照中通过，洁净度 0 失败、0 警告，文档链接与双语检查均为 0 问题。13 个增量场景与 O01–O13 逐项对应。

两位原审阅者已确认放行，待实施。真实宿主首先核查顶部挂载、树编辑器和指定 Session 导航，随后按矩阵执行产品验收。
