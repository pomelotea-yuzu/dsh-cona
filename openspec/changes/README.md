# openspec/changes/ · 变更提案

活动 change 放这里。编写、外部审阅及提交顺序见 [Change 工作流](../../docs/development/workflow.md)：写完不立即提交，其他 Agent 在 change 内写 `review.md`，编写 Agent 修订、记录处理并复查后再提交。

| Change | 里程碑 | 状态 |
|---|---|---|
| [establish-r1-project-plugin](archive/2026-11-19-establish-r1-project-plugin/proposal.md) | R1：插件贯通实验 | 7.3 收尾完成，核心闭环 V37／V32／V04 pass，六份能力 specs 已并入主 [specs](../specs/)；1 项 blocked、28 项 untested 随归档保留，见 [R1 收尾核对](archive/2026-11-19-establish-r1-project-plugin/implementation/2026-11-17-7.3-final-audit.md)。2026-11-19 已归档 |
| [add-project-overview-and-resume](archive/2026-11-20-add-project-overview-and-resume/proposal.md) | R2 首切片｜顶部项目概览与工作接续 | 双审确认放行，4.1 H 层闭环 50/50、4.2 R1 回归 21/21；13 个场景状态保持 `untested`、证据入注记，见 [复审结论与实施记录](archive/2026-11-20-add-project-overview-and-resume/review-response.md#复审结论与实施记录) 与 [收尾核对](archive/2026-11-20-add-project-overview-and-resume/implementation/2026-11-20-archive-final-audit.md)。2026-11-20 已归档 |
| [add-project-tree-editing-and-composition](archive/2026-11-22-add-project-tree-editing-and-composition/proposal.md) | R2 第二切片｜项目树编辑与流程拼接 | 双审确认放行，17 项 tasks 全部勾选；矩阵 10 项 `pass`、T04/T11/T13 `untested`、T12 真实 Agent 分句 `blocked`。4.x 真实宿主包 sha256 `8c4f26ce…08ff17ddd`，焦点恢复缺陷已修复并复测；见 [收尾核对](archive/2026-11-22-add-project-tree-editing-and-composition/implementation/2026-11-22-archive-final-audit.md)。2026-11-22 已归档 |
| [complete-r2-project-workflow](archive/2026-11-24-complete-r2-project-workflow/proposal.md) | R2 收尾｜资料协作、树与模板、多实例工作、路线图与联合验收 | 2026-11-24 已归档：全部实施任务完成，真终端 `pnpm check:ci` 通过、OpenSpec 严格校验 10/10；J01／J08／J09 `pass`，J04／J07 的 H 缺口保持 `untested`。[最终确认](archive/2026-11-24-complete-r2-project-workflow/review.md#L345) · [审阅回应](archive/2026-11-24-complete-r2-project-workflow/review-response.md) · [tasks](archive/2026-11-24-complete-r2-project-workflow/tasks.md) · [归档核对](archive/2026-11-24-complete-r2-project-workflow/implementation/2026-11-24-archive-final-audit.md)。**当前无活动 change**。 |
