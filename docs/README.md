# docs/ · 文档地图

本目录结构仿照 `layress/docs/`。当前包含项目管理插件设计与架构草案、DSH 接入调研、决定索引，以及从 Cona 迁移的历史记录与文件恢复规范参考；其余目录仍为占位索引。

## 当前阅读入口

- [决定索引](knowledge/decisions.md)：当前方向、沿用边界与被替代内容。
- [项目管理设计草案](product/2026-11-11-project-management-design.md)：用户明确需求与待讨论设计；当前方向已确认，使用流程和实现尚未定稿。
- [项目开发管理架构草案](architecture/2026-11-11-project-development-architecture.md)：集成在 DSH 内的第一版完整设计基线，覆盖调研、持续分析、聊天接续、项目服务和分段验证；通过实践优化，尚未实现。
- [DSH 项目管理接入调研](research/2026-11-11-dsh-project-management-review.md)：面板、数据、聊天与 Agent 接口的静态核查，不是运行验证。

## 文档命名与定稿

2026-11-11 用户明确约定：

- 尚未定稿的设计、讨论、调研与评审文档使用 `yyyy-mm-dd-<english-name>.md`，英文名称用小写单词与连字符连接，例如 `2026-11-11-project-management-design.md`。
- 内容确定后，再升级为不带日期前缀的定稿文件，并同步更新引用；整理成文或检查通过不等于已经定稿。
- `README.md` 等目录索引、仓库固定说明、平台约定的模板文件，以及 OpenSpec 的结构性文件名按各自用途保留；无日期不意味着其中引用的草案已获确认。
- 原样迁移的 Cona 历史记录与规范保留原路径；其适用性以文档说明和后续决定为准，不因文件名无日期而视为新插件定稿。

## 从 Cona 原样迁移（不改一字）

| 文件 | 内容 |
|---|---|
| `product/product-decisions.md` | Cona 历史决定，含 §6「项目转向与封存（2026-11-10，最终决定）」；插件形态等边界沿用，“只提供检查点／交付／回退”的范围已被当前项目管理方向替代 |
| `development/project-status.md` | 原仓库封存状态与 M0 历史记录（仅历史，不作当前依据） |
| `../openspec/specs/workspace-recovery-prototype/spec.md` | 历史 F01–F08 文件版本／交付／回退规范，仅作文件恢复专题参考，不是当前项目管理首版范围 |

`knowledge/decisions.md` 是本仓库新建的**索引**，汇总当前用户明确方向和历史原文中沿用的边界，并列出被替代与不继承项；它不新增决定。

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
| `architecture/` | 架构说明 | 含项目开发管理架构草案 |
| `development/` | 开发工作流与状态 | 含原仓库封存状态 |
| `engineering/` | 工程计划与过程 | 占位 |
| `guide/` | 使用者文档 | 占位 |
| `knowledge/` | 决定速查与经验 | 含 `decisions.md` |
| `product/` | 产品设计与决定 | 含原 Cona 决定记录与项目管理插件设计草案 |
| `research/` | 调研 | 含项目管理插件接入调研与宿主能力专题复审 |
| `reviews/` | 评审记录 | 占位 |
