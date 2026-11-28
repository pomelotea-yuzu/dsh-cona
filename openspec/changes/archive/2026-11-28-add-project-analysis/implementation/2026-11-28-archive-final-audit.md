# add-project-analysis 归档收尾核对

日期：2026-11-28。范围：`add-project-analysis` 归档前最终核对。结论：**可归档**。全部实施任务 1.1–8.3 已勾选，双审已确认，本地门禁、OpenSpec 严格校验与两条远程门禁均有结果；矩阵中 14 条 `untested` 随归档保留，不放宽、不冒充通过。

## 归档前置条件

| 项 | 状态 | 依据 |
|---|---|---|
| 双审 | 已确认 | 2026-11-25 DSH 独立审 1 与 GLM-5.3 审 2 均确认通过，作者逐条修订见 [review.md](../review.md) 与 [review-response.md](../review-response.md)。 |
| tasks | 全部勾选 | 1.1–8.3 共 32 项主任务全部勾选；逐条证据见 [tasks.md](../tasks.md) 与各阶段 `implementation/2026-11-28-*.md`。 |
| 本地门禁 | 通过 | 交付提交 `f47ab59` 上 `pnpm check:ci` exit 0，插件测试 635/635（Node 24.21.0／pnpm 12.18.0）；记录提交后本地门禁复跑仍通过。 |
| GitHub Actions | 通过 | 验收提交 `94c5a66` run `46124292145`（#21）success；记录提交 `4986a39` run `46124545556`（#22）、`6f0ea8d` run `46125659774`（#23）均 success。 |
| Gitee Go | 通过 | 用户真终端确认 `94c5a66` 双远程绿灯；后续仅文档/任务记录变更已同步推送。流水线标识与 Git 版本实测值未取，见 [CI03 注记](../validation-matrix.md)。 |
| OpenSpec 严格校验 | 通过 | `validate add-project-analysis --strict` valid；`validate --changes --strict` 1/1；`validate --specs --strict` 10/10（归档前）。 |
| 工作树 | 干净 | HEAD `6f0ea8d`，已推送双远程。 |

## 真宿主候选包

- 候选包 `dsh-cona-project-0.1.0.tgz` sha256 `9b98657889fbdd39cecef75c0998c0745cdf53083dcb812c8acc5da0d476fbb0`。
- 固定宿主 DSH `0.2.2-rc.2`（app.asar sha256 `1535941c163698d68a0cf45dd06e1ce1a18a308108d9b84076074f35a6e9c39d`），Electron `44.7.0`、Node `24.21.0`。
- 真实 Agent 完成两次分析并保存两轮报告；普通/PTC 对照、执行器、守卫、沙箱、范围外读取、文件未改、重启回读、规划变化、复盘与历史会话拒绝均已取证。详见 [第 8 组记录](2026-11-28-8.x-real-host-delivery.md)。

## 验证矩阵最终状态

| 组合项 | 状态 | 要点 |
|---|---|---|
| CI01 本地 CI 夹具 | `pass` | `master`／`main` 定向 2/2，完整门禁 529/529（第 1 组）。 |
| CI02 GitHub Actions | `pass` | 最终提交 run #21/#22/#23 全 success；Git 版本实测文本未取。 |
| CI03 Gitee Go | `pass` | 用户真终端确认绿灯；流水线标识与工具版本未取。 |
| A01–A03 概览启动 | `untested` | Host 控制器与真实 Session/启动重试已测；真实 Web UI 点击与宿主消息计数未做。 |
| **A04 身份隔离** | **`pass`** | 真实 Agent + 普通/PTC 对照；伪造/过期/错误 Session 均拒绝。 |
| **A05 拒绝写入与未保护执行** | **`untested`** | 全部禁止工具族、执行器与沙箱已测；preset/执行器缺失时入口预检与 UI 不可用展示未做。 |
| **A06 范围越界与部分读取** | **`pass`** | 3.x 真实文件全部路径/限额用例 + 8.1 固定宿主范围内外读取。 |
| A07 终止与历史会话 | `untested` | 停止/终态/pre-step/重启已测；UI 历史提示、停止请求展示与换源分句未做。 |
| A08–A10 报告与重启 | `untested` | 报告覆盖/保存/重启回读已测；混合覆盖、跨进程响应丢失与导出复验未做。 |
| A11–A14 依据状态 | `untested` | 修改/规划/换源已测；固定宿主范围增删、映射移除与不可读场景未复跑。 |
| A15 来源导航 | `untested` | 来源复核与显式当前文件已实现；真实 Web 导航未点击。 |
| **A16 复盘** | **`pass`** | 固定宿主真实 Agent 复盘；新 ID/Session/报告，旧报告保留。 |
| A17 语言切换 | `untested` | 93 个中英 key 由 `check:locale` 核对；第三语言实际显示未测。 |

14 条 `untested` 均有具体缺口说明，随归档封存；不因归档改写为通过。

## 增量 spec 归档合并清单

| 增量 spec | 主 specs 状态 | 合并方式 |
|---|---|---|
| `project-analysis` | **新增 capability** | 5 个 Requirement／17 个 Scenario 随归档加入 `openspec/specs/project-analysis/spec.md` |

归档后主 specs 共 11 项（原 10 + 新增 `project-analysis`）。归档目录保留 proposal/design/tasks/specs/review/review-response/validation-matrix/implementation；真实宿主原始输出在 gitignore 的 `artifacts/r3-8.x-host/`，不随归档入库。

## 归档后边界

- 归档不改变任何验证状态；A01–A03、A05、A07–A15、A17 的未测分句事后补测需另开 change。
- 候选包与原始探针脚本在 `artifacts/r3-8.x-host/`（不入库）；复跑需隔离 profile、隔离 `DSH_HOME` 与真实 API key。
- 两条远程的 run ID 与最终提交以 GitHub API 与用户确认记录为准；Gitee 流水线标识仍缺。
