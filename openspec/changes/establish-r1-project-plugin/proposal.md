# R1：项目管理插件贯通实验

日期：2026-11-12。状态：第 1 轮外部审阅已完成，已按 [review](review.md) 修订，处理与复查记录见 [review-response](review-response.md)。按[工作流](../../../docs/development/workflow.md)修订复查后提交提案；尚未实施，运行场景均为 `untested`，不将作者复查写成外部二次审阅或产品验收。

## Why

当前只有项目管理设计与 DSH 静态调研，尚不能证明独立插件可加载、可靠保存可移植资料，或让真实聊天中的 Agent 在正确目标内更新规划。需要以固定 DSH `0.2.2-rc.2` 跑通最小闭环，为 R2–R6 提供实际接入与恢复依据。

## What Changes

- 建立独立构建与预构建安装包，验证 Host、Client、自有 Remote、生命周期和中英资源；以独立测试 profile 运行，不修改个人 profile 或宿主核心。
- 提供最小 Project／WorkNode 规划、稳定身份、显式顺序与依赖校验；UI 和 Agent 共用应用服务，支持创建、编辑、新增及批量拆分节点并保存原因。
- 定义首版公开 JSON／Markdown 协议与无 DSH 的校验入口；项目目录、DSH 数据目录和自定义目录保存同格式资料，实际位置可见，私有数据独立。
- 实现规划内容指纹、本机双修订、资料实例／源代际、持久意图与回执、提交失败及中断恢复；未知结果先核对，响应丢失不重复创建。
- 接入节点与聊天的多对多关系、真实工具上下文、活动 WorkRun 和有来源的动态上下文；浏览节点不改变运行目标，重启不从历史记录恢复授权。
- 提供完整快照回读、乱序防护、重连及未提交编辑保留；从首个面板支持中英、其他宿主语言回退英文。
- 将 R1 必须场景逐项映射到验证矩阵，区分自动测试、真实 Host 检查和完整 Agent 演示；所有运行结果待执行后填写。

本 change 覆盖 R1，按“文件协议／独立包／提交恢复 → 真实聊天与 Agent”分段实施。完整拖放与拼接、复制和撤销、跨副本 Git 协作及位置迁移、路线图界面、持续分析、SDD 提醒、模板和骨架仍按 R2–R6 推进。路线图原“树与路线图显示一致”的 R1 口径明确收敛为树／规划摘要共用快照，R2 再验证实际路线图 UI，不能以摘要测试宣称路线图已验收。R1 补做外部 v1 首次接入的身份保留基础检查，不提前验收 R2／R6 协作。记录追加只用于验证版本与发布边界，不提前建设完整分析产品。

## Capabilities

### New Capabilities

- `plugin-integration`：固定宿主版本的独立安装、Host／Client／Remote 加载与卸载清理。
- `portable-project-data`：可移植资料格式、三种位置、私有数据隔离、稳定规划身份与校验。
- `project-command-commit`：统一命令、版本冲突、幂等回执、文件发布和中断恢复。
- `project-conversation-context`：多对多聊天关联、可信执行绑定、目标上下文和绑定失效。
- `project-panel-sync`：最小项目面板、权威快照、重连与乱序保护。
- `plugin-localization`：中英 UI、英文回退、插件元信息及内容语言隔离。

### Modified Capabilities

无。现有 `workspace-recovery-prototype` 是历史文件恢复参考，不作为本次增量修改对象。

## Impact

实现阶段预计新增 `packages/project-plugin/`、根构建／锁文件、格式说明与样例、必要测试及插件 CI；沿用纯 Node ESM、跨平台路径边界，浏览器输出按 DSH Client 协议构建。DSH 依赖、共享运行时及 Node 兼容性须通过安装与运行核查；当前仓库门禁不构成插件兼容证据。

R1 的公开格式会成为后续能力的读取基础，但不是把全部未来模型一次性定死。可信请求身份或加载链无法成立时，记录具体受阻项，修订受影响设计并重新审阅，不能放宽边界宣称 R1 完成。

范围依据：[开发路线图](../../../docs/engineering/2026-11-12-plugin-development-roadmap.md)、[总体架构](../../../docs/architecture/2026-11-11-project-development-architecture.md)、[资料协议草案](../../../docs/architecture/2026-11-12-project-data-portability.md)、[i18n 草案](../../../docs/architecture/2026-11-12-plugin-i18n-design.md)、[开工复核](../../../docs/reviews/2026-11-12-dsh-rc2-development-readiness.md)。
