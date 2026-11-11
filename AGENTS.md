# dsh-cona · 接手索引（AGENTS.md）

> 默认中文。当前方向与已定边界查 `docs/knowledge/decisions.md`；设计草案中的建议不等于已定决定。

文档命名：未定稿内容使用 `yyyy-mm-dd-<english-name>.md`，确定后再升为无日期的定稿；索引、固定文件与历史迁移例外见 `docs/README.md`。

## 一句话

以 DSH 为 Agent 底座、以项目代码开发为主要场景的项目管理插件，支持用户直接搭建与拼接项目树、流程／骨架模板、多对多聊天关联和 Agent 自主规划；视频制作等偶发需求可按需加入项目。当前只有文档、结构与门禁，无产品代码。

## 权威性

源码 > `openspec/changes/archive/` > `openspec/specs/` > `docs/` > 本文件。

## 必读

- `docs/knowledge/decisions.md` —— 当前方向、仍有效边界与被替代内容。
- `docs/product/2026-11-11-project-management-design.md` —— 用户明确需求与待讨论设计；使用过程尚未定稿。
- `docs/architecture/2026-11-11-project-development-architecture.md` —— DSH 内部插件架构与默认使用过程，含持续项目分析、聊天接续与分段验证；用户要求通过实践优化，尚无运行证据。
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

`node scripts/check-repo.mjs --all`；首次克隆后 `git config core.hooksPath .githooks`。
