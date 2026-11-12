# DSH 项目管理插件接入调研

日期：2026-11-11。性质：源码与发行包静态调研；实现建议供后续设计讨论，**不代表插件运行验证通过**。

## 本次目标与版本

用户在本次讨论中重新明确方向：以项目规划驱动工作，主要服务项目代码开发及相关文档工作；视频制作为偶发需求，可按需加入项目。支持可扩展的项目树、预设流程、用户自建流程，以及在创建项目或后续节点应用项目骨架。项目树允许多层阶段与工作项，不要求工作类型互斥；使用过程与验证案例优先围绕代码开发。

旧 Cona 的完整 Agent 设计作为需求来源。文件版本回溯是后来加入的能力，不作为本次产品定位或架构的前提；此前围绕检查点／交付／回退的[宿主能力复审](2026-11-11-dsh-host-capability-review.md)保留为专题参考。

原始调研（2026-11-11）固定至当时最新 Release 条目 `dsh-v0.2.2-rc.1`，对应提交 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`；该版本为预发布版，当时本机桌面应用版本一致。

2026-11-12 版本同步：上游已发布 `dsh-v0.2.2-rc.2`（2026-11-11T11:33:06Z，仍标记为 prerelease），用户已把本机桌面应用更新到该版本，本机完整源码快照也已替换，对应提交 `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`。用户同时明确：**在本插件开发出第一个版本之前不再更新本机 DSH 软件，本阶段以 `0.2.2-rc.2` 为固定基线**，不跟随上游后续预发布版本。下文上游链接已同步固定至 rc.2 提交；本文结论仍按 2026-11-11 的核查范围保留，未因版本更新重做全量审计或运行验证。

源码包按用户指定保存在本机 `Developer/tools/deepseek-harness/`，不进入本项目仓库；此前的 rc.1 快照已移入系统废纸篓。完整归档不包含 Git 历史或已安装依赖；源码完整下载不代表已逐行审计整个上游。

本次不安装依赖、不加载自制插件、不修改个人 DSH profile。静态发现与运行证据分别记录。

## 2026-11-12 源码快照校验与差异复核

- rc.1（2026-11-11 当时记录）：压缩包 40,619,126 字节（约 38.74 MiB），普通文件内容约 135.59 MiB，解压目录约 186 MiB；gzip 全量校验、归档路径与链接检查、逐文件比对落盘的 20,273 个普通文件均完成；根包版本 `0.2.2-rc.1`，压缩包 SHA-256 `416750920b64272899259c26b2fa0a4341132c9c19b43337da502ab7ebd599f1`。
- rc.2（本次下载）：归档 42,714,449 字节（约 40.73 MiB），普通文件内容 149,508,995 字节（约 142.58 MiB），解压目录约 194 MiB。经 GitHub 归档镜像加速下载，gzip 全量校验通过；归档含 20,996 个普通文件、13 个链接、2,915 个目录，成员路径与链接目标均在归档根内；逐文件对照压缩包校验落盘内容，0 处差异。根包与 CLI 包版本均为 `0.2.2-rc.2`，本次归档 SHA-256 `d376fe64ec4b7c9b5837fb1155ed3a48e7e0e5f5b0aae0b91d9fb836daa8c20e`。归档不含 Git 历史或已安装依赖。
- 与官方交叉核对：按 rc.2 固定提交从官方 raw 源取回 6 个文件（根包清单、CLI 包清单、`fs-sandbox` 源码、`workspace` 领域声明、组合包安装文档、Agent Team 文档）逐字节比对，全部一致。镜像只用于加速下载，不作为内容依据；未逐行审计整个上游。
- 两版差异（本机快照逐文件哈希比对）：新增 1,056、移除 334、变更 3,379 条路径（20,286 → 21,008）。对 33 条关键上游路径（含本文、配套复审与设计草案的引用，以及根包／CLI 清单）逐一检查：32 条在 rc.2 仍存在；`packages/experimental/agent-team/README.zh.md` 迁至 `packages/team/agent-team/README.zh.md`，[设计草案](../product/2026-11-11-project-management-design.md)中的对应链接与表述已同步。本文结论所依赖的核心接口源码（`fs/fs-sandbox`、`session/session-checkpoint-policy`、`workspace/workspace/src/spec.ts`、`storage/storage-domain/src/domain.ts`、`client/ui-layout/src/client/index.ts`、`api/gateway/src/client/index.ts`、Todo／Workflow 与组合包安装文档）在两版之间字节未变；部分 README 有更新，已抽查与结论直接相关的语句，未发现推翻本文判断的改动。
- rc.2 发布说明中与本文相关的条目：Git Worktree 审阅与创建等待放宽；SubAgent 具名／多层协作、AgentTeam 按会话开启；可选插件加载失败不再阻断 Web 页面、未运行插件状态更明确；侧栏插件入口可收纳进「更多」。§2 的 `sidebar.panellist` 注册与 root 作用域 `main` keyed slot 结论在 rc.2 仍成立，新增的 `sidebar.panellist.actions` 只影响入口收纳。这些属于发布说明与静态抽查，不等于「建议的最小接入实验」已通过，表中各项仍为 `untested`。

## 结论摘要

从已核查的接口看，项目管理插件存在明确接入位置：主面板与导航入口、独立持久数据领域、生成式 Host／Client API、会话创建与控制、模型工具及动态上下文。暂未发现本需求必须修改 DSH 核心的依据；第三方包的完整构建、加载与联动仍需最小实验。

DSH 的 Workspace、Todo 与 Workflow 分别解决目录分组、会话内待办和一次脚本编排。它们不能直接替代长期、跨会话、可嵌套的项目树。插件需要拥有自己的项目语义，并关联可复用的宿主对象。

## 1. 项目实体：关联 Workspace，保留项目自己的身份

`workspaceRegistry` 维护命名目录、有序项目列表和会话成员关系。其持久记录主要包含 `path`、`title`、`sessionIds` 与时间戳。创建要求目录已经存在；规范路径用于唯一性，一个会话只能属于一个 Workspace。

这适合提供工作目录和聊天分组，但不能直接表达阶段树、依赖、流程实例或模板。用户的逻辑项目也可能包含多个目录、非文件工作或不同类型成果。

建议独立设计插件 Project／WorkNode，显式关联 Workspace、Session 和文件引用。项目与 Workspace 是一对一还是一对多，属于待定产品选择；不要从目录注册表的结构直接推导产品限制。

还需处理宿主记录生命周期：移除 Workspace 不删除磁盘目录和聊天，重新添加同一目录会产生新 Workspace 身份。插件不应把“路径相同”当成历史关联始终有效。

依据：[Workspace 领域声明](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/workspace/workspace/src/spec.ts)、[服务约定](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/workspace/workspace/README.zh.md)。

## 2. 可视化：主面板已有扩展入口

布局插件声明 root 作用域的 `main` keyed slot，`conversation` 是聊天保留 key。侧边栏通过 `sidebar.panellist` 注册与主面板同 id 的入口，`ctx.layout.selectPanel(id)` 选择已注册面板。可据此提供项目树专用界面，无需自建桌面壳。

全局主面板不自动取得某个 Session binding。项目树要显示哪些项目、选中哪个节点，以及打开何种会话，需要由插件明确管理，不能借用“当前聊天”隐式代表项目状态。

建议先采用一个项目管理入口，面板内部呈现树与节点详情；聊天联动复用宿主导航。节点内嵌聊天属于可选增强，需要核查 Session reference 生命周期与同一会话多处编辑的约束。

依据：[布局 slot 声明与注册](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/client/ui-layout/src/client/index.ts)、[侧边栏入口](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/client/ui-sidebar/README.zh.md)、[Web Client 架构](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/docs/subsystems/web-client.zh.md)。

## 3. 长期状态：可研究复用宿主领域存储

`storageDomain` 允许包通过 `defineDomain` 声明带 schema 与版本的数据领域，再经 `ctx.storageDomain.open(spec)` 打开。读取来自已校验内存，写入按领域串行排队，后端持久化成功后更新内存并发出 `domain/changed`。

它为跨重启项目数据提供候选基础，初版无需先引入一套数据库。模板实例、节点、关联记录等具体布局仍未确定。

需要注意：领域写入排队不自动等于任意跨记录事务，也不等于与磁盘骨架创建原子提交。树移动、批量应用流程、文件生成后记账等操作，要选择可核查的提交单位和中断处理规则。Agent 与用户并发更新也需要项目修订号等冲突判断。

依据：[领域运行时](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/storage/storage-domain/src/domain.ts)、[领域服务说明](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/storage/storage-domain/README.zh.md)。

## 4. 界面与 Agent：共同调用项目服务

DSH 使用 Cordis 提供插件服务与生命周期。Host 方法可用 Typert Remote 声明并生成类型化 Client 调用；模型侧可通过 `ctx.tools.register(defineTool(...))` 注册工具。官方安装文档支持在独立包中声明 `dsh.bundle`，通过 profile 加载组合包；浏览器部分另有 `dsh.client` 声明。因此独立仓库开发与分发存在官方路径，不需要先把插件做成 DSH 仓库内置功能。

建议项目服务拥有全部项目变更规则，UI 的 Remote 方法与 Agent 工具调用同一服务。Agent 提交结构化请求，由程序检查节点身份、树关系、版本和允许的动作；不通过解析自然语言“已经完成”直接改写权威状态。

候选能力包括读取项目／节点、提出拆分、调整节点、关联材料、提交成果与申请状态变更。哪些可以直接执行、哪些需要用户审阅，是后续交互设计问题，不在此预设全部自动批准或全部人工批准。

完整源码进一步确认：内置 Client assembly 显式挂载自己选用的 Remote contribution，通用 Client Gateway 也公开 `ctx.remote.$mount(contribution)`。因此第三方命名空间需要自己的贡献生成与挂载，不能假定声明一个 Host 方法后浏览器会自动发现它。完整打包与调用链仍需单独实验。

依据：[Remote 协议](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/typert/protocol/README.zh.md)、[Client contribution 挂载](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/api/gateway/src/client/index.ts)、[工具注册](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/core/tools/README.zh.md)、[组合包打包与安装](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/docs/user/develop/basic/publish.zh.md)。

## 5. 聊天与当前节点：支持关联，但要显式绑定

Session Controller 提供创建、恢复、列举、发送、取消与历史等操作。`uiWorkspace.startSession` 还能准备未发送草稿，便于把节点目标交给用户查看后开始工作。

创建请求可能复用合格的空白会话，也可能返回新会话；插件必须记录实际返回的 Session id，不能预先假定创建了新会话。一个节点可关联多个讨论／执行会话；同一会话能否跨多个节点工作、当前工作节点如何切换，需要单独设计。

`systemPrompt.context` 支持由当前请求上下文动态生成模型材料，并在请求准入时刷新。可研究注入项目目标、节点目标、必要上级背景、约束与成果索引；详细项目树按工具读取，避免每一步都注入全部内容。

运行中切换节点时，已经执行的步骤与旧目标仍然属于原上下文。界面选中节点、会话绑定节点和 Agent 当前执行对象不能混为一个全局变量。

发送工作请求成功只代表消息已经准入／入队；某个 Agent 轮次结束也不自动表示项目阶段完成。项目节点的完成条件、成果记录与用户验收仍由插件业务定义。同会话 Goal 服务可作为以后持续执行的候选，它拥有修订号和会话内目标状态，不是跨会话项目调度器；是否接入以及如何激活需要另行设计，初版不必重写 Agent 循环。

依据：[Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/api/session-controller/README.zh.md)、[工作区 UI 服务](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/client/ui-workspace/README.zh.md)、[动态上下文类型与服务](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/core/system-prompt/src/index.ts)。

## 6. Todo 与 Workflow 的复用边界

| 宿主能力 | 已核查的作用与限制 | 对项目树的含义 |
|---|---|---|
| Todo | 一个 Agent 会话的扁平清单，每次整表替换；投影在 `turn/start` 清空；不支持共享项目树 | 可保留为节点内短期执行清单，不作为项目状态真源 |
| Workflow | 一次 JavaScript 编排脚本，支持 agent、parallel、pipeline、phase；引擎不保存可重启续跑的脚本状态，也不提供已保存流程模板 | 可作为部分节点的执行方式候选，不能直接承载长期项目流程 |
| Workflow 运行视图 | 工具包装层记录运行及成员事件，界面可回放成运行／阶段／成员树 | 可借鉴树形展示；历史运行记录不等于可编辑、可持续推进的项目树 |

这里不把“引擎没有重启续跑”误写为“宿主没有工作流历史”：工具与 UI 层已经有持久运行展示。

依据：[Todo 源码](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/todo/tool-todo/src/index.ts)、[Workflow](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/workflow/workflow/README.zh.md)、[运行树视图](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/client/ui-workflow-run/README.zh.md)。

## 7. 流程模板与文件骨架需要插件自己的产品语义

已查阅模块没有提供可直接等同于本需求的“项目流程＋任意节点文件骨架＋从已有项目提炼模板”完整接口。此结论仅限已核查范围，不宣称整个上游没有相关代码。

DSH profile 模板用于启动组合和插件配置；Agent preset 用于选择 Agent 能力。两者与用户希望复用的项目结构、阶段树不同，不能仅凭名称复用为项目模板。

建议继续区分：

- 流程模板：节点层次、默认目标、输入与成果要求。
- 骨架模板：目录、初始文件与可替换参数。
- 项目预设：把前两者按常见场景组合。

模板实例与模板版本分开管理。已有项目提炼出的模板应经过参数化与内容筛选；应用到已有目录时先核查目标和冲突。生成骨架的权限、实际文件操作及运行验证另行研究，不假定普通文件服务已覆盖所有目录和二进制需求。

## 建议的最小接入实验

这份列表用于验证接入，不是插件首版产品范围的定稿。所有实验当前均为 `untested`。

| 实验 | 需要观察的结果 |
|---|---|
| 第三方包加载 | 固定 DSH 版本，Host 与 Client 都正确加载；卸载后资源清理 |
| 项目树主面板 | 独立导航入口、树节点选择，切换到聊天后再回来状态正确 |
| 持久化与重连 | 保存一棵小树，重启与 Client 重连后恢复；错误不显示为保存成功 |
| 用户与 Agent 共用服务 | 双方修改同一节点，经同一规则检查；过期修订不覆盖新修改 |
| 会话与节点绑定 | 创建／复用／重新打开聊天都关联实际 Session；新会话不误继承其他节点 |
| 独立项目分析与持续复盘 | 在 DSH 内发起专门分析聊天，保存带来源与覆盖范围的发现；开发途中可再次分析；旧建议不覆盖新规划，分析请求不暗中修改代码 |
| 模型上下文 | Agent 读到当前绑定节点的目标和约束，切换节点后的生效边界可核查 |
| 模板实例化 | 给已有节点装入子树，不改动公共模板；失败与重试不重复生成节点 |
| SDD 提醒与工件关联 | 关闭后聊天与 UI 均无主动提醒，重启／新聊天／范围扩大不自动重开；仍可主动使用 SDD 并查看关联；启用时简单任务不打断，对功能变化按规则提醒，单次跳过不重复催促；已有仓库门禁保持有效；节点、change、spec 和验证证据关系可查询 |
| 文件骨架应用 | 新目录与已有目录分别验证，冲突可预览，中断后能核查实际生成项 |

最先值得验证的技术闭环是：**独立面板显示一棵持久项目树 → 节点打开关联聊天 → Agent 通过受校验工具读取／更新该节点 → 界面看到已提交状态**。

该实验成功后，再细化模板体系、阶段推进、依赖关系、成果组织与用户审批体验。无需先复建完整 Agent，也无需把文件版本系统列为项目树接入的前置条件。

后续形成的[项目开发管理架构草案](../architecture/2026-11-11-project-development-architecture.md)把这些候选接口组织为 DSH 内部插件的第一版设计基线，加入持续项目分析、上下文接续和实践反馈切片。该设计没有新增运行证据，不表示上述实验已通过。
