# dsh-cona · 接手索引（AGENTS.md）

> 默认中文。当前方向与已定边界查 `docs/knowledge/decisions.md`；设计草案中的建议不等于已定决定。

文档命名：未定稿内容使用 `yyyy-mm-dd-<english-name>.md`，确定后再升为无日期的定稿；索引、固定文件与历史迁移例外见 `docs/README.md`。

## 一句话

以 DSH 为 Agent 底座、以项目代码开发为主要场景的项目管理插件，支持用户直接搭建与拼接项目树、流程／骨架模板、多对多聊天关联和 Agent 自主规划；视频制作等偶发需求可按需加入项目。R1 六个能力（公开资料格式、命令提交与恢复、面板同步、多对多聊天与可信 Agent、i18n、插件接入）均已实现并经活动 change 的 tasks 与运行记录核对；核心闭环 V37／V32／V04 pass，矩阵其余条目按 A/F/H 分层保留实测或 untested 记录，以 change 的 tasks 与 validation-matrix 为最新执行结论，不以本段摘要为准。

用户已认可项目树与目标／时间路线图共用规划的整体设计；首版 i18n 完整支持简体中文与英文，其他宿主语言回退英文。具体实现仍待验证。

用户要求项目资料可选项目／DSH／自定义目录，支持 Git 多人跨环境协作、其他 Agent 可读与新机器 DSH 接续。公开资料与本机会话、授权及回执分开，格式与恢复方案仍待验证。

R1（`openspec/changes/archive/2026-11-19-establish-r1-project-plugin/`）已于 2026-11-19 归档：六份能力 specs 并入主 `openspec/specs/`，核心闭环 V37／V32／V04 pass；tasks 34/35（2.4b 按 R1 边界 blocked 例外）、1 项 blocked、28 项 untested 如实随归档保留，逐条状态以归档内 tasks、validation-matrix 与 [7.3 收尾核对](openspec/changes/archive/2026-11-19-establish-r1-project-plugin/implementation/2026-11-17-7.3-final-audit.md) 为准。第 1–7 段实施记录见该归档目录 `implementation/`。

R2 首切片 `openspec/changes/archive/2026-11-20-add-project-overview-and-resume/` 已于 2026-11-20 归档：增量 spec `project-overview-resume`（6 Req／13 Scenario）并入主 `openspec/specs/`、纯新增未改 R1 规范；13 个验证场景状态保持 `untested`、实测证据入矩阵注记，8 项 tasks 全部勾选（1.1/2.1/2.2/3.1 的仍待子项经复核已由后续覆盖；2.2 的草稿切回/跨页 UI 实测仍缺，在矩阵 O02 保持 `untested`、不放宽）。4.1 H 层闭环 50/50、4.2 R1 回归 21/21，V37 真实 Agent 分句无凭证 `blocked`；逐条见该归档的 validation-matrix 与 [收尾核对](openspec/changes/archive/2026-11-20-add-project-overview-and-resume/implementation/2026-11-20-archive-final-audit.md)。

活动 change [add-project-tree-editing-and-composition](openspec/changes/add-project-tree-editing-and-composition/proposal.md) 为 R2 第二切片，覆盖同级重排、子树移动与内置流程插入，DSH 与 QoderCN 已确认放行，待用户安排实施。

## 权威性

源码 > `openspec/changes/archive/` > `openspec/specs/` > `docs/` > 本文件。

## 必读

- `docs/knowledge/decisions.md` —— 当前方向、仍有效边界与被替代内容。
- `docs/product/2026-11-11-project-management-design.md` —— 用户明确需求与待讨论设计；使用过程尚未定稿。
- `docs/architecture/2026-11-11-project-development-architecture.md` —— DSH 内部插件架构与默认使用过程；2026-11-12 按用户授权修订四层边界、双修订、持久回执、可信执行绑定、快照同步与跨分支里程碑，尚无运行证据。
- `docs/engineering/2026-11-12-plugin-development-roadmap.md` —— 本项目 R1–R6 开发路线图草案，含依赖、交付与完成标准，尚未实施；插件路线图整体设计已认可，具体排期能力待细化。
- `docs/architecture/2026-11-12-plugin-i18n-design.md` —— 首版中英范围已明确，DSH locale 接入、内容语言与时间显示方案待验证。
- `docs/architecture/2026-11-12-project-data-portability.md` —— 三种数据位置、公开文件协议、Git／跨 Agent 接入及本机运行数据隔离；取代早期全部状态共用宿主原子头的设想，尚未实现。
- `docs/research/2026-11-11-dsh-project-management-review.md` —— DSH 接入的静态调研，不是运行验证。
- `docs/product/product-decisions.md` §6 —— Cona 转向与封存的历史原文；“只提供检查点／交付／回退”的范围已被项目管理方向替代。
- `openspec/specs/workspace-recovery-prototype/spec.md` —— 历史 F01–F08 规范，仅作文件恢复专题参考，不是当前产品范围。
- `docs/development/project-status.md` —— 原仓库封存状态（历史记录）。

## 红线

- 不恢复 Cona 的独立桌面 Agent 产品、Windows 自研沙箱、AppContainer／ACL／Job Object／命名管道方案。
- E 系列与 P 系列结论不随新路线继承；不把 Cona 运行证据当作本插件已验证能力。
- 纯 Node ESM、跨平台：不调用平台原生 API，不硬编码盘符与路径分隔符。
- 代码移植后须重测路径语义（symlink、APFS 大小写、hardlink、权限位）。
- 未测、受阻不得当作通过；不以放宽边界冒充通过。
- 未经用户明确指示不 push、不打 tag。

## 门禁

`pnpm check:ci`（仓库门禁 + 插件 build/typecheck/test/边界/协议/manifest；CI 固定 Node 24.21.0、pnpm 12.18.0）；只查仓库门禁为 `node scripts/check-repo.mjs --all`；首次克隆后 `git config core.hooksPath .githooks`。

## Change 工作流

完整约定见 `docs/development/workflow.md`：新建 change 采用双审——DSH 侧独立会话一遍、另一个 Agent 一遍，审阅结果分别写入该 change 的 `review.md`；作者逐条修订并在 `review-response.md` 记录依据，双审确认（或用户裁决）后再提交。作者不得审自己的 change（作者是 DSH 时用独立 DSH 子会话并如实标注），也不得预填 review 或把自查当外部审阅；双审未齐时保持待审阅、未提交。建立后的修订至少一名非作者审阅（微小修豁免）；实施由用户另选执行 Agent，默认不与作者同一角色，审阅者不执行。
