# decisions.md · 关键决策速查

> 默认中文。**本表只是索引，不新增决定**。当前方向来自 2026-11-11 用户需求，以及 2026-11-12 的版本基线、路线图认可、首版 i18n 和资料位置／跨 Agent 协作要求，见[项目管理设计草案](../product/2026-11-11-project-management-design.md)；沿用边界来自 Cona `product-decisions.md` §6，工程纪律来自原 Cona `development/workflow.md`。
> 设计建议不因写入文档或门禁通过就成为已定决定。被后续方向替代的历史范围见下表。

## 当前方向（2026-11-11 起，2026-11-12 补充）

| # | 用户明确的方向与需求 | 来源 |
|---|---|---|
| N01 | 以 DSH 为 Agent 底座扩展项目管理，主要服务项目代码开发及相关文档工作；视频制作只是偶发需求，可按需加入项目。默认使用过程、模板与验证案例围绕代码开发设计；文件回溯不作为架构驱动力 | [当前方向与设计起点](../product/2026-11-11-project-management-design.md) |
| N02 | 支持预设与用户自建流程，项目与大阶段可以继续拆分；骨架可在项目开始或后续阶段应用，模板可从已有项目提炼 | 同上 |
| N03 | Agent 能依据新内容与信息自主调整大小阶段；具体默认交互与授权策略待讨论 | 同上 |
| N04 | 阶段与聊天多对多关联，一个阶段可关联多个聊天，一个聊天也可关联多个阶段 | 同上 |
| N05 | 为未来官方 Super-agent 准备项目数据与接入边界；本轮不自研 Super-agent 或多 Agent 调度系统，不预设尚未发布的协议 | 同上 |
| N06 | 用户通常使用 OpenSpec 一类的 SDD 开发范式，希望加入功能规范与开发提醒；简单任务不需要强制走完整 SDD 流程。提醒须有开关，关闭后不主动催促或自动重开；默认值、设置范围及具体触发与关联方式待讨论 | [代码开发与 SDD 工作流](../product/2026-11-11-project-management-design.md) |
| N07 | 从零项目包含调研、竞品对照等工作；已有项目可在专门聊天中做项目分析，开发进行中也可再次分析，评估规划调整 | [使用过程基线](../product/2026-11-11-project-management-design.md) |
| N08 | 用户授权 Agent 先形成完整架构和默认项目树颗粒度；探索与实施边界等通过实践优化，用户自身建议也作为可检验的起点，不逐项预先定死 | [设计起点](../product/2026-11-11-project-management-design.md)、[架构草案](../architecture/2026-11-11-project-development-architecture.md) |
| N09 | 项目界面和功能集成在 DSH 软件内；Host 项目服务为宿主插件逻辑，面板为 DSH 内部界面，不要求另开网站、独立应用或单独部署后端 | [架构目标](../architecture/2026-11-11-project-development-architecture.md) |
| N10 | 用户可以直接修改项目阶段，像搭积木一样搭建与拼接项目树；拖放、组合、复制等具体交互及依赖处理采用设计基线，待实践优化 | [动态项目树](../product/2026-11-11-project-management-design.md)、[用户搭建与拼接](../architecture/2026-11-11-project-development-architecture.md) |
| N11 | 在本插件开发出第一个版本之前，用户不再更新本机 DSH 软件；本阶段调研、设计与实现统一以 DSH `0.2.2-rc.2` 为固定基线，不跟随上游后续预发布版本 | 2026-11-12 用户明确要求；[版本同步与复核](../research/2026-11-11-dsh-project-management-review.md) |
| N12 | 用户认可项目树、目标路线图和时间路线图共用一份规划的整体设计；时间可逐步补充，展示、依赖与日期分别表达，Agent 调整有原因且进展围绕成果；具体界面和排期能力继续细化 | 2026-11-12 用户明确认可；[路线图设计](../product/2026-11-12-project-roadmap-design.md) |
| N13 | 插件支持 i18n；用户选择首版完整支持简体中文和英文，其他宿主语言回退英文 | 2026-11-12 用户要求及语言范围选择；[i18n 接入草案](../architecture/2026-11-12-plugin-i18n-design.md) |
| N14 | 项目可能由多人在不同环境协作；用户按项目选择资料存于项目目录并可经 Git 管理，或存于 DSH 数据目录／自定义目录，保留位置选择权 | 2026-11-12 用户明确要求；[资料位置与协作设计](../architecture/2026-11-12-project-data-portability.md) |
| N15 | 不要求协作者都使用 DSH；保存的项目资料须让其他 Agent 可读，另一台机器的 DSH 取得资料后可直接接入并继续工作 | 2026-11-12 用户补充要求；同上 |

具体使用流程、数据模型、存储方案、界面与实施顺序已有[第一版架构基线](../architecture/2026-11-11-project-development-architecture.md)，均待实践检验；没有插件运行验证结论。

2026-11-12 后续讨论补充了[本项目开发路线图草案](../engineering/2026-11-12-plugin-development-roadmap.md)。路线图整体设计与首版语言范围已按 N12／N13 记录；具体里程碑安排、界面细节、排期策略及 i18n 实现方案仍待实践验证，不能将整份草案视为逐项定稿。

同日用户授权根据纸面评审修订架构，后续又明确 N14／N15。现行[架构基线](../architecture/2026-11-11-project-development-architecture.md)保留四层、可信执行绑定、完整快照与跨分支里程碑；数据协议改为可移植资料与本机运行数据分离，以规划内容指纹核对跨环境基线，本机修订仅用于实例内同步。公开资料与私有回执通过持久意图及恢复核对衔接，取代早期“全部状态同一个宿主原子头”的设想。R1／R2 已纳入反例，尚无运行证据。

## 沿用的决定（来自 2026-11-10 转向与封存决定）

| # | 决定 | 来源 |
|---|---|---|
| D01 | Cona 到此封存，不再继续开发；后续工作转入新仓库 `dsh-cona`（由用户在 macOS 端创建），本仓库不改名、不删除，保留为 M0 验证档案 | [§6](../product/product-decisions.md) |
| D02（沿用部分） | 不再做独立桌面 Agent 产品；保持 DeepSeek Harness（DSH）插件形态。原来的能力范围限定已被当前项目管理方向替代 | [§6](../product/product-decisions.md)、[当前方向](../product/2026-11-11-project-management-design.md) |
| D03 | **不自研沙箱**：隔离与执行由 DSH 宿主提供；AppContainer／精确 ACL／Job Object／命名管道窄通道方案整体废弃 | [§6](../product/product-decisions.md) |
| D04 | 开发环境转 macOS；插件保持跨平台——**纯 Node ESM，不调用平台原生 API，不硬编码盘符与路径分隔符** | [§6](../product/product-decisions.md) |
| D05 | 新建 `dsh-cona`，GitHub／Gitee 各一份 | [§6](../product/product-decisions.md) |
| D07 | 证据适用范围：归档 change 的 24 通过／1 受阻只在 Windows 原型 driver 下成立；**E 系列与 P 系列结论不随新路线继承** | [§6](../product/product-decisions.md) |
| D08 | **F01–F08 的规范与设计可作参考**，但代码移植后须重测路径语义（symlink、APFS 大小写、hardlink、权限位） | [§6](../product/product-decisions.md) |
| D09 | `prototypes/`、`output/` 及 `docs/engineering/`、`docs/research/`、`docs/collab/` 按提交边界仅本机保留；Windows 原型与运行证据不入库、不作为新插件的已验证能力 | [§6](../product/product-decisions.md) |
| D10 | 原 Cona 的 `openspec/config.yaml` 保留历史原貌，**不再用于生成新提案**（本仓 `openspec/config.yaml` 为新建文件，不在此列） | [§6](../product/product-decisions.md) |

## 被替代或不作为当前前提的内容

| 历史内容 | 当前适用性 |
|---|---|
| D02 的“只提供检查点／交付／回退” | 已被 2026-11-11 项目管理方向替代；历史原文保留，不能据此排除项目规划需求 |
| D06 的 `Config.dataRoot` | 针对旧文件版本存储与账本，不预定新项目布局。当前按 N14 支持三种资料位置；公开文件格式及本机存储依数据专题设计，宿主领域存储仅作本机运行数据候选 |
| F01–F08 | 文件恢复专题参考，不是当前项目管理产品的首版验收范围或前置实现要求 |

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
