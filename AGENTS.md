# dsh-cona · 接手索引（AGENTS.md）

> 默认中文。当前方向与已定边界查 `docs/knowledge/decisions.md`；设计草案中的建议不等于已定决定。

文档命名：未定稿内容使用 `yyyy-mm-dd-<english-name>.md`，确定后再升为无日期的定稿；索引、固定文件与历史迁移例外见 `docs/README.md`。

## 一句话

以 DSH 为 Agent 底座、以项目代码开发为主要场景的项目管理插件，支持用户直接搭建与拼接项目树、流程／骨架模板、多对多聊天关联和 Agent 自主规划；视频制作等偶发需求可按需加入项目。当前已有公开资料格式、三种资料位置、本机注册表与实例聚合、三态发布与显式刷新（第 1、3 段）；面板、聊天绑定与 Agent 工具未实现。

用户已认可项目树与目标／时间路线图共用规划的整体设计；首版 i18n 完整支持简体中文与英文，其他宿主语言回退英文。具体实现仍待验证。

用户要求项目资料可选项目／DSH／自定义目录，支持 Git 多人跨环境协作、其他 Agent 可读与新机器 DSH 接续。公开资料与本机会话、授权及回执分开，格式与恢复方案仍待验证。

当前活动提案：`openspec/changes/establish-r1-project-plugin/`，覆盖 R1 插件贯通实验；第 1 轮外部审阅已完成并按意见修订，第 2 段完成（2.1–2.5；2.4b 的绑定/归属复测待第 6 段，non-owner 为 R1 边界），第 3 段 3.1 完成（三种资料位置、实际路径与 Git 只读状态、外部 v1 基础接入，见 change 内 `implementation/2026-11-14-3.1-positions.md`），3.2 完成（本机根、注册表、实例聚合、锁与私有根检查，见 `implementation/2026-11-14-3.2-local-state.md`），3.3–3.5 完成（路径范围、三态发布与中断注入、完整基线与显式刷新，见 `implementation/2026-11-14-3.3-3.5-scope-publish-refresh.md`），第 3 段收口；4.1 完成（命令封套、访问校验、不可变变换、每实例队列，见 `implementation/2026-11-14-4.1-command-envelope.md`），4.2 完成（意图／回执幂等与稳定生成 id，见 `implementation/2026-11-14-4.2-idempotency.md`），4.3 完成（prepared／publishing／committed 阶段与中断注入，见 `implementation/2026-11-14-4.3-phases.md`），4.4 起未开始；处理见 change 内的 `review-response.md`。

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
