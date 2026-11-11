# 贡献说明

[English](CONTRIBUTING.en.md)

## 当前范围

本仓库 2026-11-10 初始化；截至 2026-11-11，已有项目管理插件设计草案与 DSH 接入静态调研，尚无产品代码与运行验证。当前方向和沿用边界见 [决定索引](docs/knowledge/decisions.md)，具体方案仍待讨论。许可证为 [MIT](LICENSE)；提交 PR 前请先与维护者确认。

## 提交前

- 本地跑 `node scripts/check-repo.mjs --all`；首次克隆后执行一次 `git config core.hooksPath .githooks`。
- 仓库内的一次性产物进 `artifacts/`，本机实验运行数据可放 `.dsh-cona/`，两者均不入库；手写结论直接写进 `docs/` 对应子目录。这里不预定插件部署后的项目数据位置，存储方案待设计。
- 中英成对的门面文档以 `i18n/docs-manifest.json` 登记为准，同轮维护。

## 纪律

- 当前方向与已定边界查 `docs/knowledge/decisions.md`；区分用户明确需求与草案建议，用户后续修改方向时同步索引。
- 未执行、未测、受阻如实单列，不冒充通过；不以机器 PASS 代替人工验收。
- push 与 tag 归用户，智能体不 push。
