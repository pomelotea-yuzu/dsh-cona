# 2026-11-22 作者交接

作者为 Codex 会话。[提案](proposal.md)、[设计](design.md)、五组增量规范、[任务](tasks.md)与[验证矩阵](validation-matrix.md)已根据第二轮复核修订。GLM（Trae）第二轮复核通过，DSH 第三轮确认通过。实施由用户按[仓库工作流](../../../../docs/development/workflow.md)另行安排。 [双审结论](review.md#L345)

## 提案中的范围选择

- 资料迁移沿用本机实例身份，两个工作副本各有本机实例。Git 工作由各协作者执行。
- 用户模板先做项目内选段、版本化保存与插入，采用可移植的记录正文。手工分组和合并先支持同父级普通节点。撤销及重做覆盖本 change 上线后产生的 owner 内容与结构编辑。
- 按 2026-11-22 用户裁决，其他浏览实例可建立本机聊天关系。新环境将 B 配为启动配置实例后执行。显式运行切换留待后续，Agent 结构命令各自限制动作和实际位置。
- 按同一裁决，本次路线图覆盖里程碑、交付引用和目标视图，目标日期／时间视图留待后续独立 change。v2 仅新增里程碑扩展，严格 v1 继续支持普通编辑。 [审阅中的用户裁决](review.md#L86)
- 验收绑定固定 DSH。隔离 profile 的真实 Agent 登录、非 DSH Agent 与可控制的宿主中断环境按任务 0.1 核对，记录在当前验收包下实际可观测的能力。

## 编写校验

本地 macOS arm64，使用固定宿主自带 Node `24.21.0`、pnpm `12.18.0` 和 OpenSpec `1.17.0`。

| 检查 | 结果 |
|---|---|
| `openspec validate complete-r2-project-workflow --type change --strict --no-interactive --json` | 1 项通过，0 问题 |
| `node scripts/check-repo.mjs --staged` 与 `--all` | 独立 Git 快照含原审阅、作者回应、修订工件及索引。两种模式均查 308 个文件，洁净度 0 失败／0 警告，自测 32 项通过。链接分别检查 146／147 篇，双语与链接均 0 问题 |
| `pnpm check:ci` | 现有插件门禁通过，341/341 项测试通过 |
| 任务与场景覆盖核对 | 5 组增量规范的 30 个 Scenario 与矩阵逐一对应。矩阵 39 项含 9 项联合与回归场景，均有任务引用。30 项任务均有交付、完成检查和证据入口 |

链接数差异来自 `artifacts/README.md`。`--all` 用 Git 文件列表涵盖该文档，`--staged` 的临时检出会跳过 `artifacts/`。外部 review 中两个 Markdown 硬换行保留原样，其余拟提交内容通过 `git diff --cached --check`。

编写阶段的校验覆盖提案工件和现有代码。30 项实施任务待执行，39 个矩阵场景均为 `untested`。
