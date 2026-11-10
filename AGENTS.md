# dsh-cona · 接手索引（AGENTS.md）

> 默认中文。已定的事查 `docs/knowledge/decisions.md`，不在文档里重开辩论。

## 一句话

DSH 插件方向的新仓库，由封存仓库 Cona 转向而来；当前只有结构、索引与门禁，无产品代码。

## 权威性

源码 > `openspec/changes/archive/` > `openspec/specs/` > `docs/` > 本文件。

## 必读

- `docs/product/product-decisions.md` §6 —— 转向与封存的最终决定（原文照搬自 Cona）。
- `docs/knowledge/decisions.md` —— 仍有效决定速查与不继承清单。
- `openspec/specs/workspace-recovery-prototype/spec.md` —— F01–F08 规范，仅作参考。
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
