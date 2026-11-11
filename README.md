# dsh-cona

[English](README.en.md)

以 DSH（DeepSeek Harness）为 Agent 底座、以项目代码开发为主要场景的项目管理插件，由已封存仓库 **Cona** 转向而来。

## 状态

- 2026-11-11：已整理项目管理设计草案、第一版架构基线与 DSH 接入静态调研；**未编写插件代码、未安装依赖、未立活动 change，接入能力尚未运行验证**。
- 当前需求与设计建议：[项目管理插件设计草案](docs/product/2026-11-11-project-management-design.md)。方向已确认，具体使用流程与实现方案待讨论。
- 第一版架构：[项目开发管理架构草案](docs/architecture/2026-11-11-project-development-architecture.md)，覆盖调研、持续分析、项目树和聊天接续；默认方式通过实践优化。
- 当前方向与仍有效边界：[docs/knowledge/decisions.md](docs/knowledge/decisions.md)。
- 宿主接入依据：[DSH 项目管理插件接入调研](docs/research/2026-11-11-dsh-project-management-review.md)（静态调研）。
- 历史转向与封存决定：[产品决定记录 §6](docs/product/product-decisions.md)；其中仅提供文件恢复能力的范围已被当前方向替代。
- 文件恢复专题参考：[文件版本／交付／回退规范](openspec/specs/workspace-recovery-prototype/spec.md)（Cona F01–F08，非当前产品范围承诺，移植时须重测跨平台路径语义）。
- 原仓库的封存状态：[项目状态](docs/development/project-status.md)。

## 方向

- 产品形态：DSH 项目管理插件，以动态项目树组织项目代码开发及相关文档工作；视频制作等偶发需求可按需加入项目。
- 界面和项目逻辑集成在 DSH 软件内，通过内部项目入口关联宿主聊天；不要求另开网站、独立应用或单独部署后端。
- 支持预设与用户自建流程、创建时或后续阶段应用文件骨架，以及从已有项目提炼模板。
- 用户可直接编辑项目树，像搭积木一样调整阶段、插入和拼接流程；具体交互待实践验证。
- 阶段与聊天多对多关联；Agent 能依据新信息自主调整规划，具体交互与授权策略待讨论。
- 为未来官方 Super-agent 保留接入边界，本轮不自研多 Agent 调度系统；文件回溯不作为架构驱动力。
- 不做独立桌面 Agent 产品，不自研沙箱。执行与隔离复用 DSH；插件自身的 Host 读写不能假定自动受会话沙箱保护。
- 插件保持跨平台：纯 Node ESM，不调用平台原生 API，不硬编码盘符与路径分隔符。
- 开发环境：macOS；项目数据存储与部署落点待设计，宿主领域存储为候选。

用户明确需求与设计建议分别标注在设计草案中；索引同步不表示整份设计已定稿。

## 仓库与协作

- 结构仿照 layress 仓库的骨架；门禁脚本、CI、模板与 i18n 清单沿用其骨架并按本仓库改名。
- 远程：Gitee + GitHub 双端（当前合并在一条 `origin` 的两个 push 地址，实际配置以 `git remote -v` 为准）；push 与 tag 由用户手动执行。
- 许可证：[MIT](LICENSE)。

## 目录

| 目录 | 用途 |
|---|---|
| `docs/` | 文档、已定决定与封存说明 |
| `openspec/` | 规范与 change |
| `apps/`、`packages/`、`scripts/` | 代码、包与仓库门禁脚本（代码位当前仅占位） |
| `i18n/`、`datasets/`、`artifacts/` | 术语与清单、夹具、一次性产物 |
