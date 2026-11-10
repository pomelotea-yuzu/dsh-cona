# 贡献说明

[English](CONTRIBUTING.en.md)

## 当前范围

本仓库 2026-11-10 初始化，只有结构、索引与门禁，尚无产品代码。许可证与是否接受外部贡献均未定，提交 PR 前请先与维护者确认。

## 提交前

- 本地跑 `node scripts/check-repo.mjs --all`；首次克隆后执行一次 `git config core.hooksPath .githooks`。
- 一次性产物只进 `artifacts/`，运行时数据只进 `.dsh-cona/`，两者均不入库；手写结论直接写进 `docs/` 对应子目录。
- 中英成对的门面文档以 `i18n/docs-manifest.json` 登记为准，同轮维护。

## 纪律

- 已定决定查 `docs/knowledge/decisions.md`，不在文档里重开辩论。
- 未执行、未测、受阻如实单列，不冒充通过；不以机器 PASS 代替人工验收。
- push 与 tag 归用户，智能体不 push。
