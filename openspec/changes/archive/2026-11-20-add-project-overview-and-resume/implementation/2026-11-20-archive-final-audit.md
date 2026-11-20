# 归档前收尾核对（2026-11-20）

状态：归档前收尾核对完成，归档后复核修订（2026-11-20 晚）。对照增量 spec 的 6 个 Requirement／13 个 Scenario 与 validation-matrix 的 13 个 O 条目逐项核对，核对 OpenSpec 严格校验与门禁，确认可归档。结论：**13/13 Scenario 全部有对应 O 条目，无遗漏；13 个 O 场景状态均保持 `untested`（H/F/A 层证据写入注记、不放宽改标 pass）；8 项 tasks 全部勾选，其中 1.1／2.1／2.2／3.1 的仍待子项经复核已由后续任务覆盖，未实测的分句在矩阵与任务注记中如实保留**。

**归档后勾选复核**：初版曾把 4 项「主体完成、仍待子项转交后续」的任务（1.1／2.1／2.2／3.1）保持未勾选。经用户质疑复核 R1 归档惯例（34 项勾选、仅 1 项真 `blocked` 留空）与本 change 3.3 的先例（部分场景转交 4.1 时即勾选），确认 task 勾选记的是**交付完成**、场景 `untested` 是**独立维度**，二者不应混同。逐项复核仍待项：1.1 的键盘焦点/产品概览/安全复查由 2.2／3.2／3.3 覆盖；2.1 的草稿隔离/迟到响应/保存 B 不变由 2.2／6 项隔离单测／4.1 覆盖；3.1 的指针/预览/卡片/部分成功由 3.2／3.3／4.1 覆盖；2.2 的 O13 由 4.1 覆盖，唯「草稿切回仍在」「跨页保留」两项 H 层 UI 实测仍缺（仅单测+DOM 证据）——该两项按诚实口径在矩阵 O02 保持 `untested`、任务勾选注记如实说明，不因勾选而放宽为 pass。据此 8 项 tasks 全部勾选。

## 一、Scenario ↔ O 条目映射（13/13 覆盖）

增量 spec `project-overview-resume/spec.md` 的 6 个 Requirement（窗口级项目入口、以资料实例隔离概览、显式保存可移植接续记录、以可核查来源呈现历史接续、聊天导航沿用可信执行边界、概览使用宿主语言）展开为 13 个 Scenario，与矩阵 O01–O13 一一对应，无孤立 Scenario：

| Scenario | O | 方法 | 表状态 | 实测证据（注记） |
|---|---|---|---|---|
| 从不同宿主页面打开项目 | O01 | H | untested | 1.1 顶部 slot/跨页 DOM + 2.2 展开实测 |
| 用键盘开合并保留编辑 | O02 | H | untested | 2.2 Escape/焦点返回、键盘展开；草稿/跨页 UI 未测 |
| 切换资料实例时旧响应迟到 | O03 | A+H | untested | 2.1 6 项隔离单测 + 4.2 V15 拒绝回归；迟到事件 UI 未测 |
| 实例不可用或没有接续记录 | O04 | F+H | untested | 2.1/2.2 不可读诊断、A 卡片/B 空态 |
| 保存并重读最新记录 | O05 | F+H | untested | 3.1/3.2 保存-回读-幂等、4.1 B 保存回读 |
| 响应丢失或提交基线过期 | O06 | F+H | untested | 3.1 幂等/基线单测；故障注入 UI 未测 |
| 摘要已保存但聊天指针未保存 | O07 | F | untested | 3.3 部分保存 F 层分项单测 |
| 有历史证据且基线已变 | O08 | F+H | untested | 3.2c 代码观察三态实测；规划/HEAD/工件变化矩阵未全跑 |
| 接续记录未知或证据无法验证 | O09 | F+H | untested | 3.2 领域级诊断单测 + 哈希不符集成测试 |
| 查阅有效或越界的代码和工件引用 | O10 | F+H | untested | 本 change 场景外，未测 |
| 多个关联聊天时打开选定会话 | O11 | H | untested | 3.3 probe-36 + 4.1 WorkRun 隔离；B 会话工具拒绝/建会话未测 |
| 原聊天已失效或从干净环境接入 | O12 | F+H | untested | 3.3 probe-37 + 4.1 干净 profile 8/8 |
| 在编辑中切换宿主语言 | O13 | A+H | untested | 3.3 probe-38 + 4.1 运行中切换 6/6 |

## 二、任务勾选状态（8 项全勾选，仍待项逐项复核）

tasks 8 项现已全部勾选。初版曾留 4 项未勾选，经归档后复核 R1 惯例与 3.3 先例，确认「task 勾选＝交付完成、场景 untested＝独立维度」，据此补齐勾选并在各项注记写明仍待子项的最终去向：

| 任务 | 主体证据 | 仍待子项 | 最终覆盖情况 |
|---|---|---|---|
| 1.1 | 1.1 探针：overlay/注入/selectPanel/openSession 全通 | 键盘 Escape/产品概览交互与安全复查属 2.2/3.3 | 2.2 实测 Escape+焦点返回、3.2 产品概览、3.3 打开前复查；已覆盖 |
| 2.1 | 2.1 Host 层 + 6 项隔离单测 | 草稿隔离（随 2.2）、保存 B 时 A 目标不变（随 3.x） | 2.2/4.1 草稿切换实测、4.1 真机 A WorkRun/队列/订阅逐项不变；已覆盖 |
| 2.2 | 2.2 主体浏览器实测 | O13 运行中切换、「A 填草稿→切 B→切回草稿仍在」UI、跨页保留 | O13 由 4.1 实测；后两项**仍无 H 层 UI 实测**（仅 controller 单测 + root fixed DOM），在矩阵 O02 保持 untested，勾选注记如实说明 |
| 3.1 | 3.1 格式与保存闭环 + 9 项测试 | 聊天指针/预览/卡片（3.2/3.3）、部分成功/未知状态注入 | 3.2/3.3 完成前项，部分成功由 3.3 控制器单测与 4.1 干净 profile 覆盖；已覆盖 |

**勾选口径**：参照 R1 归档（34 项勾选、仅 1 项真 `blocked` 留空、28 项 untested 随归档）与本 change 3.3（部分场景转交 4.1 时即勾选），task 勾选记录的是**产品交付完成**，验证场景的 pass/untested/blocked 由矩阵独立记录。2.2 两项无 UI 实测的分句**不因勾选而放宽为 pass**——矩阵 O02 仍为 `untested`，并在任务注记与本报告第三节如实保留。产品能力结论以注记中的 H/F/A 证据与矩阵状态为准，不以勾选数冒充验收通过。

## 三、诚实边界汇总（随归档保留）

1. **O10**：代码/工件引用查阅与越界，本 change 场景外，未测。
2. **O11 未测分句**：B 会话工具拒绝、B 开始动作禁用、B 关联两会话打开确切 Session——design §2 留后续 change，`conaOverview` 无建聊天入口，H 层无法构造。
3. **O02/O03/O06 的 UI 分句**：草稿跨实例 UI 实测、迟到响应 UI、故障注入 UI 未做（controller 单测覆盖）。
4. **O08 矩阵**：规划/HEAD/工件字节分别变化的核对矩阵未全跑。
5. **V37 真实 Agent 分句**（4.2）：本机无 LLM 凭证受阻 `blocked`，R1 历史 pass 为临时凭证证据。
6. **resumeCandidate 代际约束**（4.1 观测）：硬编码 `connectionGeneration:0`，A 被 `conaProject/follow` 推进代际后概览卡片短暂 `stale-connection`，留 R6 试用确认。

## 四、门禁与归档就绪

- OpenSpec `1.17.0`：`validate add-project-overview-and-resume --type change --strict --no-interactive --json` → `valid: true`，1/1 passed。
- `pnpm check:ci`：全链通过（check-repo、build、typecheck、305/305 测试、边界、协议同步、locale、manifest）。
- CI 固定版本核对（4.2）：pnpm `12.18.0`、宿主 Node `24.21.0`（Node 24 下 check-repo 118 篇 0 问题、305/305），shell Node `22.22.2` 差异已补跑消除。
- 产物与运行证据：实施记录 12 篇在 change 目录，探针脚本/JSON 留本机 `artifacts/r2-probe/`、`artifacts/r2-regression/`（不入库）。

归档动作：增量 spec 并入主 `openspec/specs/`，change 目录移入 `openspec/changes/archive/`，更新归档索引；不改变上述任何 pass/untested/blocked 判定。
