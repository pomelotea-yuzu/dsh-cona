# R2 收尾 change 归档收尾核对

日期：2026-11-24。范围：`complete-r2-project-workflow` 归档前最终核对。结论：可归档。全部 tasks 已勾、双审已确认、真终端门禁与 OpenSpec 严格校验均通过；J04/J07 的未测分句按矩阵保留 `untested` 随归档封存，不放宽、不冒充通过。

## 归档前置条件

| 项 | 状态 | 依据 |
|---|---|---|
| 双审 | 已确认 | 2026-11-22 获 DSH 与 GLM（Trae）双审确认，见 [review.md](../review.md) 与 [review-response.md](../review-response.md)。 |
| tasks | 全部勾选 | 5.1–5.8 共 34 项子任务全部完成；逐条见 [tasks.md](../tasks.md) 与各阶段 `implementation/2026-11-2{3,4}-*.md` 记录。 |
| 真终端门禁 | 通过 | `pnpm check:ci`（Node 24.21.0／pnpm 12.18.0）由用户真终端执行通过，2026-11-24 确认；会话内 53 项失败均为沙箱删除守卫、无断言失败。见 [5.8 记录](2026-11-24-5.8-r1-regression-and-final.md)。 |
| OpenSpec 严格校验 | 10/10 | `openspec validate --all --strict --no-interactive --json`：1 change + 9 specs 全部 valid、0 issues。 |
| 仓库门禁 | 放行 | `node scripts/check-repo.mjs --all`：洁净度失败 0／警告 0，文档链接 180 篇 0 问题，双语登记 0 问题。 |
| 工作树 | 干净 | HEAD `fe3329c`，本地提交、未 push、未打 tag。 |

## 验证矩阵最终状态

| 组合项 | 状态 | 要点 |
|---|---|---|
| J01 固定宿主/包/profile | `pass` | 最终包 `7dcc48b3…`，隔离 profile 安装与中英入口实测；真终端门禁通过。 |
| J02 Git/回退/迁移 | `pass` | 5.2 全链路 H。 |
| J03 多会话聊天 | `pass` | 5.4 H。 |
| **J04 草稿/引用/故障** | **`untested`** | 5.6 已取得跨页草稿、迟到响应、旧代际、三项基线变化、同号回执等 H 分句；O07 指针失败 H 注入、O10 越界引用点击 H、O08 卡片独立「需要核对范围」提示、T11 升级移除旧版本 H 未做，组合判据未齐，不放宽。 |
| J05 活动 WorkRun 改规划 | `pass` | 5.4 H。 |
| J06 验证回读 | `pass` | 5.5 H。 |
| **J07 原能力回归** | **`untested`** | O01–O13／T01–T14 共 27 行已逐列影响判定与源码入口依据；O07/O09/O10 保留 A/F，O08/O10/T04/T11 为部分，组合项不放宽。 |
| **J08 R1 组合回归** | `pass` | 5.8 最终包上 V15／V32／V37／V04 实测。 |
| J09 R2 同项目连续交付 | `pass` | 5.7 owner→外部 Agent→B 合并→干净 profile 授权写入。 |

增量场景 C01–C09、E01–E12、W01–W06、M01–M05 的逐条状态与证据见 [validation-matrix.md](../validation-matrix.md)；所有 `pass` 均附实际证据，`untested` 均写明缺口，无 `fail`。

## 增量 specs 归档合并清单

| 增量 spec | 主 specs 状态 | 合并方式 |
|---|---|---|
| `portable-project-data` | 已存在 | 并入 R2 收尾新增的刷新/回退/迁移/格式条款 |
| `project-tree-editing` | 已存在 | 并入手工编辑、用户模板与撤销/重做条款 |
| `project-conversation-context` | 已存在 | 并入实例聊天、配置实例工作与结构授权条款 |
| `project-overview-resume` | 已存在 | 并入聊天关联、接续重绑与卡片条款 |
| `project-roadmap` | **新增 capability** | 随归档加入主 `openspec/specs/project-roadmap/spec.md` |

归档后主 specs 共 10 项（原 9 + 新增 `project-roadmap`）；归档目录保留全部 proposal/design/tasks/specs/review/review-response/validation-matrix/implementation 与证据索引，公开资料与运行证据在 gitignore 的 `artifacts/`，不随归档入库。

## 归档后边界

- 归档**不改变**任何验证状态；J04/J07 的未测分句随归档封存，事后若补需另开 change。
- 最终验收包 sha256 `7dcc48b35cb68c27bb29acfd0fdda1313585cb2bdd49439dc5a937eaa581f672`（`artifacts/r2-final-h/pack/final/dsh-cona-project-0.1.0.tgz`），归档后如需复测按 [5.8 记录](2026-11-24-5.8-r1-regression-and-final.md) 的 PATH 配置在真终端执行。
- 不 push、不打 tag；本地提交后由用户手动同步双远程。
