# dsh-cona · 接手索引（AGENTS.md）

> 默认中文。当前方向与已定边界查 `docs/knowledge/decisions.md`；设计草案中的建议不等于已定决定。

文档命名：未定稿内容使用 `yyyy-mm-dd-<english-name>.md`，确定后再升为无日期的定稿；索引、固定文件与历史迁移例外见 `docs/README.md`。

## 一句话

以 DSH 为 Agent 底座、以项目代码开发为主要场景的项目管理插件，支持用户直接搭建与拼接项目树、流程／骨架模板、多对多聊天关联和 Agent 自主规划；视频制作等偶发需求可按需加入项目。R1 六个能力（公开资料格式、命令提交与恢复、面板同步、多对多聊天与可信 Agent、i18n、插件接入）均已实现并经活动 change 的 tasks 与运行记录核对；核心闭环 V37／V32／V04 pass，矩阵其余条目按 A/F/H 分层保留实测或 untested 记录，以 change 的 tasks 与 validation-matrix 为最新执行结论，不以本段摘要为准。

用户已认可项目树与目标／时间路线图共用规划的整体设计；首版 i18n 完整支持简体中文与英文，其他宿主语言回退英文。具体实现仍待验证。

用户要求项目资料可选项目／DSH／自定义目录，支持 Git 多人跨环境协作、其他 Agent 可读与新机器 DSH 接续。公开资料与本机会话、授权及回执分开，格式与恢复方案仍待验证。

R1（`openspec/changes/archive/2026-11-19-establish-r1-project-plugin/`）已于 2026-11-19 归档：六份能力 specs 并入主 `openspec/specs/`，核心闭环 V37／V32／V04 pass；tasks 34/35（2.4b 按 R1 边界 blocked 例外）、1 项 blocked、28 项 untested 如实随归档保留，逐条状态以归档内 tasks、validation-matrix 与 [7.3 收尾核对](openspec/changes/archive/2026-11-19-establish-r1-project-plugin/implementation/2026-11-17-7.3-final-audit.md) 为准。第 1–7 段实施记录见该归档目录 `implementation/`。

R2 首切片 `openspec/changes/archive/2026-11-20-add-project-overview-and-resume/` 已于 2026-11-20 归档：增量 spec `project-overview-resume`（6 Req／13 Scenario）并入主 `openspec/specs/`、纯新增未改 R1 规范；13 个验证场景状态保持 `untested`、实测证据入矩阵注记，8 项 tasks 全部勾选（1.1/2.1/2.2/3.1 的仍待子项经复核已由后续覆盖；2.2 的草稿切回/跨页 UI 实测仍缺，在矩阵 O02 保持 `untested`、不放宽）。4.1 H 层闭环 50/50、4.2 R1 回归 21/21，V37 真实 Agent 分句无凭证 `blocked`；逐条见该归档的 validation-matrix 与 [收尾核对](openspec/changes/archive/2026-11-20-add-project-overview-and-resume/implementation/2026-11-20-archive-final-audit.md)。

R2 第二切片 `openspec/changes/archive/2026-11-22-add-project-tree-editing-and-composition/` 已于 2026-11-22 归档：增量 spec `project-tree-editing`（6 Req／14 Scenario）并入主 `openspec/specs/`、纯新增未改既有规范；17 项 tasks 全部勾选，矩阵 T01/T02/T03/T05/T06/T07/T08/T09/T10/T14 为 `pass`，T04（B 无建聊天入口，Session 分句）、T11（H 层中断/迟到响应）、T13（无 verification 记录可核）保持 `untested`，T12 真实 Agent 分句因 profile 未登录 `blocked`（owner 侧 7/7 有 H 证据）。固定 DSH `0.2.2-rc.2` 宿主实测包 sha256 `8c4f26ce…08ff17ddd`，焦点恢复缺陷于 4.x 修复；逐条见该归档的 validation-matrix 与 [收尾核对](openspec/changes/archive/2026-11-22-add-project-tree-editing-and-composition/implementation/2026-11-22-archive-final-audit.md)。

R2 收尾 `openspec/changes/archive/2026-11-24-complete-r2-project-workflow/` 已于 2026-11-24 归档：五份增量 specs 并入主 `openspec/specs/`（新增 `project-roadmap`，更新其余四份），全部实施任务 5.1–5.8 勾选，J01／J08／J09 `pass`，J04／J07 因 5.6 未做的 H 分句保持 `untested` 不放宽。完整 `pnpm check:ci` 已由用户真终端通过（Node 24.21.0／pnpm 12.18.0）；归档后 OpenSpec 严格校验 10/10。最终验收包 sha256 `7dcc48b3…`；见 [归档核对](openspec/changes/archive/2026-11-24-complete-r2-project-workflow/implementation/2026-11-24-archive-final-audit.md) 与 [交接](openspec/changes/archive/2026-11-24-complete-r2-project-workflow/implementation/2026-11-24-handoff.md)。逐条状态以归档的 tasks 与 validation-matrix 为准。

当前活动 change 为 [add-project-analysis](openspec/changes/add-project-analysis/proposal.md)，涵盖 R3 首切片项目分析与复盘，以及 GitHub Actions／Gitee Go 共同的 Git 测试夹具故障。2026-11-25 已完成 DSH 和 GLM 复核及提交前修订；2026-11-28 第 1 组实施完成（tasks 1.1–1.5、CI01–CI03 均 `pass`；CI02／CI03 依据用户真终端确认两条远程绿灯，run ID／流水线标识与工具版本实测值未取），修复提交 `cbbd4f5` 已同步双远程。同日第 2 组完成静态核对、keyless 机制探针与接入模块代码，并在隔离 profile 的真 DSH `0.2.2-rc.2` 上部分实测：preset 注册、实际 Session 与作用域、守卫、pre-step、原生/PTC 执行器对照；实测修复 `ctx.effect` 立即释放保护与随包 patch 缺 `config` 两处问题。普通 API key 已补跑真实模型回合（绑定会话调用允许集工具成功、无绑定被守卫拒绝），并修复「pre-step 把工具续步当未认领而拦死回合」（step>1 放行、终态全拒）。同日还实测定案允许能力注册位置（分析 Session 的 agent scope，preset 层用 `restrict({allow: []})` 只裁剪继承工具）并新增 Host 侧派发前核对（执行器/可见集/守卫）。随后第 3 组（tasks 3.1–3.5）完成：仓库映射冻结、只读范围预览、有序枚举与观察指纹、集中限额、范围内读取凭证与引用复核，真实文件测试 8 项，插件门禁 563/563。第 4 组（4.1–4.6）已完成：本机分析记录、专用 preset 新建、首消息发送与响应丢失回读、执行保护/身份认领、停止/终态、重启恢复与历史 pre-step 拒绝（真宿主创建／发送／恢复探针通过）。第 5 组（5.1–5.4）也已完成：验证记录索引与正文凭证、报告校验/保存/覆盖、报告列表/详情、来源复核，并把四个真实分析能力工具（background/scope_files/verification/save_report）注册到分析 Agent 的 scope；真宿主经真实 `tools.execute` 验证四个工具与报告保存，插件门禁 611/611。A01／A02／A03／A06／A08／A09／A10／A11／A13／A14／A15 仍保持 `untested`（缺概览/报告/来源 UI 与真实模型回合），tasks 2.1–2.3 与 A04/A05/A07 亦未勾选；第 6–8 组待安排，真实进程重启与真实 Agent 回合留 8.1。证据见 [真宿主记录](openspec/changes/add-project-analysis/implementation/2026-11-28-2.x-real-host.md)、[作用域记录](openspec/changes/add-project-analysis/implementation/2026-11-28-2.x-scope-and-executor.md) 与 [第 3 组记录](openspec/changes/add-project-analysis/implementation/2026-11-28-3.x-analysis-scope.md)。

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
