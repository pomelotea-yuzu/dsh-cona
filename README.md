# dsh-cona

[English](README.en.md)

DSH（DeepSeek Harness）插件方向的新仓库，由已封存仓库 **Cona** 转向而来。

## 状态

- 2026-11-10 初始化：只建立仓库结构、索引与门禁，**未编写插件代码、未安装依赖、未立 change**。
- 转向与封存的最终决定：[产品决定记录 §6](docs/product/product-decisions.md)。
- 仍有效的决定速查：[docs/knowledge/decisions.md](docs/knowledge/decisions.md)。
- 可复用的行为依据：[文件版本／交付／回退规范](openspec/specs/workspace-recovery-prototype/spec.md)（Cona F01–F08，仅作参考，跨平台路径语义须重测）。
- 原仓库的封存状态：[项目状态](docs/development/project-status.md)。

## 方向

- 产品形态：DSH 插件，只提供检查点／交付／回退；不再做独立桌面 Agent 产品。
- 不自研沙箱：隔离与执行由 DSH 宿主提供。
- 插件保持跨平台：纯 Node ESM，不调用平台原生 API，不硬编码盘符与路径分隔符。
- 开发环境：macOS；数据落点由新插件的 `Config.dataRoot` 指定，取值待定。

以上均为原仓库 `product-decisions.md` §6 已定决定，本仓库不重新讨论。

## 仓库与协作

- 结构仿照 `~/Developer/layress`；门禁脚本、CI、模板与 i18n 清单沿用其骨架并按本仓库改名。
- 远程：Gitee + GitHub 双端，实际地址以 `git remote -v` 为准；push 与 tag 由用户手动执行。
- 许可证：**待定**，本仓库暂不放 `LICENSE`。

## 目录

| 目录 | 用途 |
|---|---|
| `docs/` | 文档、已定决定与封存说明 |
| `openspec/` | 规范与 change |
| `apps/`、`packages/`、`scripts/` | 代码、包与仓库门禁脚本（代码位当前仅占位） |
| `i18n/`、`datasets/`、`artifacts/` | 术语与清单、夹具、一次性产物 |
