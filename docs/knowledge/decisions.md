# decisions.md · 关键决策速查

> 默认中文。**本表只是索引，不新增决定**：每条都来自 Cona `docs/product/product-decisions.md` §6 或 `docs/development/workflow.md`，原文见对应链接。
> 被 §6 覆盖的旧决定（§1–§5 中与新路线冲突者）不再有效，不在此表内。

## 仍有效的决定（全部来自 2026-11-10 最终决定）

| # | 决定 | 来源 |
|---|---|---|
| D01 | Cona 到此封存，不再继续开发；后续工作转入新仓库 `dsh-cona`（由用户在 macOS 端创建），本仓库不改名、不删除，保留为 M0 验证档案 | [§6](../product/product-decisions.md) |
| D02 | 不再做独立桌面 Agent 产品；改为 DeepSeek Harness（DSH）插件，**只提供检查点／交付／回退** | [§6](../product/product-decisions.md) |
| D03 | **不自研沙箱**：隔离与执行由 DSH 宿主提供；AppContainer／精确 ACL／Job Object／命名管道窄通道方案整体废弃 | [§6](../product/product-decisions.md) |
| D04 | 开发环境转 macOS；插件保持跨平台——**纯 Node ESM，不调用平台原生 API，不硬编码盘符与路径分隔符** | [§6](../product/product-decisions.md) |
| D05 | 新建 `dsh-cona`，GitHub／Gitee 各一份 | [§6](../product/product-decisions.md) |
| D06 | 版本存储与账本由新插件的 `Config.dataRoot` 指定，具体取值在新仓库定稿 | [§6](../product/product-decisions.md) |
| D07 | 证据适用范围：归档 change 的 24 通过／1 受阻只在 Windows 原型 driver 下成立；**E 系列与 P 系列结论不随新路线继承** | [§6](../product/product-decisions.md) |
| D08 | **F01–F08 的规范与设计可作参考**，但代码移植后须重测路径语义（symlink、APFS 大小写、hardlink、权限位） | [§6](../product/product-decisions.md) |
| D09 | `prototypes/`、`output/` 及 `docs/engineering/`、`docs/research/`、`docs/collab/` 按提交边界仅本机保留；Windows 原型与运行证据不入库、不作为新插件的已验证能力 | [§6](../product/product-decisions.md) |
| D10 | 原 `openspec/config.yaml` 保留历史原貌，**不再用于生成新提案** | [§6](../product/product-decisions.md) |

## 沿用的工程纪律（来自 Cona `docs/development/workflow.md`，原文未整体迁移）

- 用例状态只有 `pass` / `fail` / `blocked` / `untested`，**未测与受阻不得当作通过**。
- 不因负例全被拒绝就宣称安全，也不因功能收益或开销小就掩盖失败；不以放宽边界冒充通过。
- 每个勾选必须有代码、运行证据或明确研究结论；证据本机保留、结论入库，生成物不直接当提案正文。
- 未验证的想法必须显式标注，不得在后续文档中当作可行方案使用。

## 不继承（查证用，不要当作当前依据）

- Cona `docs/product/product-design.md`：独立桌面 Agent 产品的完整设计（含 Electron／SQLite／UI 方案）。
- Cona `docs/architecture/prototype-overview.md`：Windows 受限执行原型的组件与信任边界。
- Cona `docs/development/environment-and-provisioning.md`：一次性提权与卷根授权供给。
- Cona 归档 change 的 `conclusion-report.md`／`validation-matrix.md`／`tasks.md`／`review*.md`：Windows 原型的运行结果。
