# 归档前收尾核对（2026-11-22）

状态：归档前收尾核对完成。对照增量 spec `project-tree-editing` 的 6 个 Requirement／14 个 Scenario 与验证矩阵 T01–T14 逐项核对，复核 tasks 17 项勾选、OpenSpec 严格校验与全量门禁，确认可归档。结论：**14/14 Scenario 一一对应 T 条目、无遗漏；10 项 `pass`、3 项 `untested`（T04／T11／T13）、1 项 `blocked`（T12 真实 Agent 分句）按实测保留，不因归档或勾选放宽；17 项 tasks 全部勾选，交付内容均有实现记录与证据**。

## 一、Scenario ↔ T 条目映射（14/14 覆盖）

增量 spec 6 个 Requirement 展开为 14 个 Scenario，与矩阵 T01–T14 一一对应，无孤立 Scenario：

| Scenario | T | 矩阵状态 | 主要证据 |
|---|---|---|---|
| 同级前移后移及回到原位置 | T01 | `pass` | 1.x 领域单测 + 2.x 文件后端 + 4.2 真实宿主根组/同级拖放与键盘 |
| 键盘和拖放预览及取消 | T02 | `pass` | 3.1/3.4 控制器用例 + 4.2 等价预览、取消与焦点恢复（4.x 修复） |
| 切换实例或宿主页面保留各自草稿 | T03 | `pass` | 3.4 控制器用例 + 4.3 五分句实测 |
| 移动有后代、成果和聊天的子树 | T04 | `untested` | A/F 与 H 跨父移动/成果保留已测；B 无建聊天入口，聊天 Session 分句未核 |
| 拒绝无效的根、父节点或位置 | T05 | `pass` | 1.1 多根夹具 + 2.2 真实文件后端非法输入与文件字节核对 |
| 插入预设并独立再次插入 | T06 | `pass` | 1.2/1.3 + 2.2 + 4.2 两次插入、预览字段与 v1 回读 |
| 拒绝不可用或无效的模板输入 | T07 | `pass` | 1.2 预设校验 + 2.1/4.1 `treePresets` 载荷与拒绝码 |
| 多实例和可信身份校验 | T08 | `pass` | 2.1 准入单测 + 4.1/4.3 错实例与跨实例请求拒绝 |
| 工作运行中修改同实例的树 | T12 | `blocked` | owner 分句 7/7 有 H 证据；真实 Agent 分句无登录凭证 |
| 用户确认前已发生其他规划或源变化 | T09 | `pass` | 2.2 A/F + 4.3 旧基线冲突与新基线重确认 |
| 确认后断线并重试模板插入 | T10 | `pass` | 2.3 A/F + 4.3 同 `operationId` 重发、待同步与仅重读 |
| 发布途中中断或旧响应迟到 | T11 | `untested` | 2.3/3.4 的 A/F 故障注入覆盖；H 层进程中断/迟到响应未注入 |
| 更新后重启并读取已有接续资料 | T13 | `untested` | v1 备份校验、历史记录与干净进程卡片回读通过；无 verification 记录可核，H `execute` 基线竞争未通过 |
| 编辑期间切换宿主语言 | T14 | `pass` | 3.2 字典/控制器 + 4.2 zh→en→日本語三语言实测 |

## 二、任务勾选状态（17 项全勾选）

| 段 | 任务 | 交付与证据 |
|---|---|---|
| 1.x | 1.1–1.3（3 项） | 领域移动变换、版本化预设、ID 实例化；`test/tree-editing.test.ts`，见 [1.x 记录](2026-11-22-1.x-domain-transforms.md) |
| 2.x | 2.1–2.4（4 项） | 服务接入、真实文件后端、持久意图、WorkRun 边界；`test/tree-commands.test.ts`，见 [2.x 记录](2026-11-22-2.x-service-authorization.md) |
| 3.x | 3.1–3.4（4 项） | 树编辑器拖放/键盘、预设列表、提交回读、实例草稿；`test/panel-structure.test.ts`，见 [3.x 记录](2026-11-22-3.x-client-interaction.md) |
| 4.x | 4.1–4.6（6 项） | 真实宿主环境、正常路径、异常与隔离、活动 WorkRun、回归与收口；见 [4.x 记录](2026-11-22-4.x-host-validation.md) 与 `artifacts/r4-probe/*.json`（本机） |

勾选口径与前两次归档一致：task 勾选记**交付完成**，矩阵 `pass`／`untested`／`blocked` 是**独立验证维度**。4.x 的未测与受阻分句不因任务勾选而改标通过。

## 三、诚实边界汇总（随归档保留）

1. T04：B 实例按既有边界无建聊天入口，跨父移动的成果/依赖/ID 已核，子树内多对多聊天 Session 分句未测，不用 owner RPC 冒充。
2. T11：候选持久化后中断、发布结果未知与升级移除预设版本由 2.3 的 A/F 故障注入覆盖；H 层未注入真实进程中断与跨实例迟到响应。
3. T12：验证 profile 未登录（界面显示 `Add API Key`／`Sign in`），真实 Agent 的旧基线、最新快照基线与越范围写拒绝均 `blocked`；owner 侧 7/7 有 H 证据。
4. T13：A/B 公开资料无 `kind=verification` 记录，卡片显示代码观察与停点，但历史验证状态无可核对对象；4.5 末段 `conaOverview/execute` 因基线竞争未取得 H 层回执分句。
5. 已知代际现象：概览 `resumeCandidate` 内部 `connectionGeneration: 0`，树面板 follow 推进全局代际后概览显示 `stale-connection`；卡片回读在新启动且未建 follow 的宿主进程完成，留 R6 确认。
6. 4.x 修复：3.x 声称已实现的「取消预览后焦点恢复」实际缺失，本次在 `ProjectPanel.tsx` 增加 `data-cona-node` 并按草稿 nodeId 恢复焦点，重建包后复测通过。

## 四、门禁与归档就绪

- OpenSpec `1.17.0`：`validate add-project-tree-editing-and-composition --type change --strict --no-interactive --json` → `valid: true`，1/1 passed。
- `pnpm check:ci`：全链通过（check-repo、build、typecheck、341/341 测试、边界、协议同步、locale、manifest）。
- 预构建包：最终 sha256 `8c4f26ce3d0b33fdea790a3f9f8f2340847af418419647f37126c4086ff17ddd`；宿主 `0.2.2-rc.2`、Node `v24.21.0`、pnpm `12.18.0`（本机 Node `v22.22.2` 的差异已由宿主 Node 与 CI 门禁覆盖）。
- 产物与证据：实施记录 4 篇、探针脚本与 JSON 留本机 `artifacts/r4-probe/`（不入库）。

归档动作：增量 spec `project-tree-editing`（6 Req／14 Scenario）并入主 `openspec/specs/`，change 目录移入 `openspec/changes/archive/2026-11-22-add-project-tree-editing-and-composition/`，更新归档与索引；不改变任何 pass／untested／blocked 判定。
