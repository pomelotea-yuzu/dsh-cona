# docs/ · 文档地图

本目录结构仿照 `layress/docs/`。**本仓库当前只装入从 Cona 迁移来的仍有效决定与规范，其余为占位索引。**

## 从 Cona 原样迁移（不改一字）

| 文件 | 内容 |
|---|---|
| `product/product-decisions.md` | 产品决定记录，含 §6「项目转向与封存（2026-11-10，最终决定）」——本仓库方向的唯一权威来源 |
| `development/project-status.md` | 原仓库封存状态与 M0 历史记录（仅历史，不作当前依据） |
| `../openspec/specs/workspace-recovery-prototype/spec.md` | F01–F08 文件版本／交付／回退规范，与新插件「检查点／交付／回退」直接相关，可作参考 |

`knowledge/decisions.md` 是本仓库新建的**索引**，把上述原文里仍有效的决定摘成速查表，并列出不继承项；它不新增决定。

## 未迁移（按 §6 决定剔除）

| 原 Cona 内容 | 不迁移的原因 |
|---|---|
| `product/product-design.md` | 独立桌面 Agent 产品的统一设计，与新插件路线冲突 |
| `architecture/prototype-overview.md` | Windows 受限执行原型架构，沙箱方案整体废弃 |
| `development/environment-and-provisioning.md` | 一次性提权与卷根授权，随沙箱废弃 |
| `development/workflow.md` | 主体是 Windows 原型的构建／运行／ACL 卫生流程；其中通用的证据纪律已摘进 `knowledge/decisions.md` |
| 原 `docs/README.md`（旧文档地图） | 分层与提交边界是旧仓库口径，由本文件取代 |
| `openspec/specs/windows-execution-prototype/spec.md` | E 系列执行隔离规范，沙箱废弃 |
| `openspec/changes/archive/2026-10-19-.../`（结论、验证矩阵、任务、评审、设计） | E／P 系列结论不随新路线继承；F 系列设计如需取用，回原仓库 archive 单独取 |
| 原 `openspec/config.yaml` | §6 明确「保留历史原貌，不再用于生成新提案」；本仓库 `openspec/config.yaml` 是新建的 |
| `prototypes/`、`output/`、`docs/engineering|research|collab/` | 按提交边界仅本机保留，不入库、不作为已验证能力 |

## 目录用途

| 目录 | 用途 | 当前 |
|---|---|---|
| `architecture/` | 架构说明 | 占位 |
| `development/` | 开发工作流与状态 | 含原仓库封存状态 |
| `engineering/` | 工程计划与过程 | 占位 |
| `guide/` | 使用者文档 | 占位 |
| `knowledge/` | 决定速查与经验 | 含 `decisions.md` |
| `product/` | 产品决定 | 含 `product-decisions.md` |
| `research/` | 调研 | 占位 |
| `reviews/` | 评审记录 | 占位 |
