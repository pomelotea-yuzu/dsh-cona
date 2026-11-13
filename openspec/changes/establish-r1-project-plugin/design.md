# R1 技术设计

## Context

动机与范围见 [proposal](proposal.md)。本设计已按[第 1 轮外部审阅](review.md)修订，逐项处理见 [review-response](review-response.md)；这些是提案层面的修订，不表示外部审阅者已复审修订稿、用户逐项确认或 DSH 接入已经通过。固定宿主 `0.2.2-rc.2`，源码提交 `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`；本仓尚无插件代码、workspace 或安装依赖。

现行架构已经要求公开资料与本机运行数据分离。早期单宿主原子头不再适用；不能以 rename、宿主写队列或测试替身证明跨介质事务、任意外部并发写入或断电安全。

## Goals / Non-Goals

- 用一个组合包完成 R1 小树闭环，领域模块可在没有 DSH 的 Node 环境中校验；按模块分层，不为四层拆四个发布包。
- 文件发布与本机状态使用明确接口和可注入失败点；命令成功、进程执行成功和节点完成分开。
- 只实现 R1 使用到的协议。R2 的完整编辑器、迁移和跨工作副本协作，R3 的完整分析，R4 的 SDD，R5 的模板与骨架不在本次实现中。
- R1 不交付路线图 UI 或日期排期；共享快照的第二投影用规划摘要测试，避免为验收“视图一致”提前加入路线图功能。

## Decisions

### 1. 一个组合包，四层目录

拟定包名 `dsh-cona-project`，目录 `packages/project-plugin/`，Host 入口 `src/host/index.ts`，浏览器入口 `src/client/index.tsx`，独立校验入口 `src/cli/validate.ts`。

| 目录 | 依赖及职责 |
|---|---|
| `src/domain/` | JSON 数据结构、纯变换、树／依赖／完成条件校验；无 Node、Cordis 或 React |
| `src/application/` | 命令、查询、可信调用上下文、提交及恢复；调用 ports 和领域核心 |
| `src/adapters/` | 文件、本机状态、DSH 会话和身份映射、Remote／工具入口 |
| `src/client/` | 面板、编辑草稿、同步状态机、字典；不写文件或复制业务规则 |
| `src/host/` | Cordis 服务装配、依赖注入和生命周期 |
| `formats/v1/` | JSON Schema、README 协议模板及可分发样例；不复制私有存储 schema |

核心接口为 `ProjectSourcePort`、`LocalStatePort`、`ConversationPort`、`ExecutionContextPort`、`ChangeNotificationPort`；时间、id 和内容哈希由应用层注入。选择一个包是为了减少第三方加载变量；后续确有复用需求再拆库。

根目录建立 pnpm workspace、锁文件、TypeScript 与自包含构建配置。使用 TypeScript ESM 源码、Node ESM Host 产物；Client 编为宿主 loader 所需的 lazy CJS factory。`engines.dsh` 精确为 `0.2.2-rc.2`。插件最低 Node 声明先以 `>=24.9.0` 为设计起点，必须在依赖解析后核对其是否足够；CI 至少覆盖 Node 24，记录实际宿主及开发所用二进制和补丁版本。系统 Node 与仓库文档 CI Node 均不作插件兼容证据；shell 版本随 Agent 环境可能不同，不能把一次记录当成机器永久状态。

DSH 开发包精确固定 `0.2.2-rc.2`；Cordis、React 等其他包按固定宿主清单选择并锁定实际版本，不假定它们也有同名版本。共享实例依赖同时声明 peer 和开发副本，不原样使用上游 `workspace:*`。注册表缺包、引擎不兼容或 peer 解析异常均是前置检查失败，不能默默跟随上游版本；需要改方案时先修订本设计。

Client 构建不导入上游 `packages/client/tsdown.client.ts`，只实现此包需要的 factory 包装、external、产物检查和生命周期内样式，不移植整套 monorepo 构建框架。共享 external 依据固定宿主模块表及 `dsh.client` 声明核对；自有生成 contribution 内联。包导出 Host、`./client`、`./remote`、校验命令及必要格式资源，使用预构建 tarball 验证安装，不要求安装时 prepare 或开发服务器。

manifest 必查字段为 `type: "module"`、`dsh.bundle.patch`、`dsh.client.platform: "web"`、Client 所需 `inject`／非默认 external 声明、`exports["./client"]` 的实际构建产物、`engines.dsh: "0.2.2-rc.2"`、`engines.node`、共享包 peer／开发副本，以及包含全部入口和资源的 `files`。宿主使用 `semver.satisfies(..., { includePrerelease: true })` 判断 DSH 范围；冻结安装时还须分别观察包管理器的 engines 处理与宿主安装／启动结果，不把精确版本当简单字符串比较或默认两者行为相同。

### 2. 资料位置与本机状态后端

选择位置的 UI 明确显示最终路径。R1 创建后位置固定，迁移交给 R2；可以分别创建／接入三种位置，但不会自动发现后覆盖已有绑定。

| 数据 | R1 默认布局 |
|---|---|
| 项目目录资料 | 代码根下 `.dsh-cona-project/`；创建前预览，可另选明确目录 |
| DSH 目录资料 | 宿主 home 的 `data/dsh-cona/projects/<projectId>/` |
| 自定义资料 | 用户明确选择的资料根，直接放协议入口 |
| 本机运行数据 | 宿主 home 的 `data/dsh-cona/local/`，可经插件 `localDataRoot` 明确改为本机绝对目录 |

默认路径通过固定版本 `@deepseek-ai/dsh-home-paths` 的 `dshHomePath()` 与 `node:path` 拼接，不硬编码用户目录、盘符或分隔符。资料根不可与本机运行根相同或互相包含；本机根位于代码工作副本时，检查其明确处于不跟踪区域，发现已跟踪内容则拒绝写入私有记录并说明处理方法，不自动改 Git 配置。`.dsh-cona/` 继续只作本仓实验落点，不作为公开格式名。

**本次选择独立文件型 `LocalStatePort`，不把 storageDomain 作为生产后端。** 它保存版本化的本机注册表和每实例聚合 `instances/<instanceId>/state.json`；单实例聚合包含双修订、资料定位代际、聊天关系、WorkRun 历史、意图／回执及最近有效观察。完整完成回执与修订在同一次本机聚合替换中保存，避免回执已完成而计数尚未推进。首版不清理历史回执；容量是已知限制。

这是对候选方案的选择：storageDomain 的根由后端路由管理，尚不能据此支持用户单独指定插件本机根。独立文件后端使公开／私有协议和失败语义对齐，也避免为了 R1 改宿主其他领域配置；代价是必须自己验证文件替换与隔离状态。接口保留替换能力，不同时实现两套后端。`unknown-state` 是本插件接口的结果码，不把注入该结果的测试误报成宿主 storageDomain 已运行验证。

注册表保存规范化资料根、项目 id、instanceId 和本机逻辑仓库映射；注册先持久化，再允许创建命令，不在丢失注册信息时重用旧实例。接入同一路径核对项目 id，项目身份变化时拒绝静默复用；同项目不同目录生成不同实例。重启保留双修订及 instanceId，生成新的源代际；Client 重连只改变连接代际，不无故更新 Host 源代际。

在进程内按规范化资料根排除重复写者；本机根用独占锁文件防止同一根的双 Host，并在异常遗留时要求明确离线核对后释放，不自动按超时抢锁。不同 `localDataRoot` 管同一公开根不在支持范围；接入界面和说明明确单写者前提，不声称获得跨所有进程的文件锁。

### 3. 公开格式 v1 与规划指纹

资料根包含 `README.md`、`project.json`、`schema/project-v1.schema.json`、`protocol/plan-canonicalization.md`、`protocol/plan-vectors.json` 及 `records/`。README 说明权威入口、版本、如何顺序编辑／校验及私有数据边界。DSH 插件校验以安装包内的协议／schema 版本为依据；资料携带副本供阅读和独立实现，不得执行资料根内的校验脚本或远程 schema。这不要求其他 Agent 加载插件：独立实现按公开协议和一致性向量自行校验、复算即可。

`project.json` v1 固定顶层为 `schemaVersion`、`project`、`plan`、`planVersion`、`records`：

| 字段 | v1 内容 |
|---|---|
| `schemaVersion` | 整数 `1` |
| `project` | `id`、`title`、`goal`、`constraints: string[]`、`repositories: {id, label}[]`；无磁盘路径 |
| `plan.nodes` | `{id, parentId, order, title, goal, completionCriteria: string[], status}` 数组；根的 parentId 为 null，同级 order 从 0 连续 |
| `plan.dependencies` | `{nodeId, requiresNodeId}` 有向关系集合，不由展示顺序生成 |
| `planVersion` | `sha256:<lowercase-hex>`，由下述规划投影重新计算 |
| `records` | `{id, kind, subjectNodeIds, path, contentHash, summary, sources, verification?}` 索引集合 |

id 使用 UUID，应用层分配并在意图中持久化；领域层不自行随机。节点状态值为 `todo / in-progress / blocked / done / canceled`。拆分保留父 id，批量新增子节点，父状态不从子节点推导；不支持破坏历史的硬删除。`completionCriteria` 可逐步补充，但进入 `done` 必须有非空条件、显式对应记录及所需检查结果，不能只因轮次结束。取消保留节点与历史。

v1 记录类型为 `plan-change / analysis-note / execution-note / verification`：仅提供发布摘要和版本分离所需的最小追加能力，完整分析模型留到 R3。正文为不可变 UTF-8 Markdown，路径 `records/<recordId>/<contentHash-hex>.md`，散列覆盖实际字节；索引引用包含观察哈希。`sources` 只接受公开记录 id 或 `{repositoryId, relativePath, observedHash?}`，不写本机消息 id；无法共享的原始聊天来源留在私有记录，公开摘要标注其来源未公开。`verification` 保存 `pass / fail / blocked / untested`、受检对象引用及版本、范围；导入结论显示为外部来源，不等于本机复测。

`plan-change` 正文记录理由、输入规划版本和业务改动，避免把候选资料头哈希写入其自身内容。公开记录只在用户明确发布时产生；Agent 修改规划所需的简短原因通过当前授权允许发布的规划变更记录保存，未经允许的聊天引文不附带发布。R1 UI 将“保存规划及变更理由”作为明确动作，提供共享内容预览。

规范化协议 `v1-plan` 的规范正文为 [formats/v1/plan-canonicalization.md](formats/v1/plan-canonicalization.md)，强制向量为 [plan-vectors.json](formats/v1/plan-vectors.json)。它们是本 change 的协议工件，实施时原样随格式资源和资料阅读入口分发，不仅存在于测试中。

协议明确：严格解析及值域；仅三条路径按集合排序的白名单；递归 UTF-16 码元键序；中文／非 ASCII 原样、控制字符和引号／反斜杠的唯一转义、斜杠不转义、U+2028／U+2029 原样、UTF-8 无 BOM；整数／负零、布尔／null 的序列化；最后 SHA-256。未知字段先拒绝，不能先投影后静默略过。用逐键写入的序列化器，不能假定“插入已排序键后 JSON.stringify 整个对象”在整数样式键上保序。

向量涵盖中文、键序／缩进／输入转义变化、集合物理顺序、记录追加、同级重排和目标变化，以及序列化边界值。每个向量附精确 canonical UTF-8 文本与期望散列，要求第二份独立实现复算一致；本轮协议向量核算只验证文档工件，插件运行矩阵仍为 untested。文件自报值不匹配则只读诊断，独立校验命令提供显式“计算期望指纹”输出，不暗中修复文件。

完整读写基线另记原资料头字节哈希和每个引用正文哈希，不能用 `planVersion` 替代。未知格式和字段按不支持处理，保留文件，不写回丢字段。时间与跨分支交付关系尚未进入 v1；R2 扩展须显式升 schema 并迁移，旧插件拒绝静默重写。R1 只在树与依赖上验证关系规则，不宣称已有完整跨分支交付能力。

### 4. 文件访问与发布边界

资料读写限定用户选定的根；代码资料引用按本机逻辑仓库映射解析，R1 不提供任意代码修改工具。公开 relativePath 统一为 `/` 分段协议，拒绝绝对路径、盘符、反斜杠、空段、`.`／`..`、NUL 和编码绕过；磁盘拼接交给 `node:path`。访问前重新核对 realpath／最近存在祖先及最终目标，拒绝资料树内符号链接、非常规文件及可观察的多硬链接写目标；记录大小写冲突和实际平台限制。不同平台分别补证，不从设计推断兼容。

正文采用内容寻址不可变文件，已存在同名正文必须逐字节匹配；禁止就地覆盖原正文。资料头和本机聚合采用同目录唯一临时文件、写入／关闭／必要同步、rename 替换、重新读取核对。发布前重读完整基线并检查运行资格；文件适配器返回 `not-published / published / unknown`，本机端返回 `saved / not-saved / unknown-state`，并携带失败阶段。

单个本地文件替换不是两个目录的事务，进程中断检查不等于突然断电的持久保证。rename 后、回读前异常属于 unknown；目录同步不受支持时明确记录环境限制，不降格为已证明断电安全。不通过复制后删除模拟跨盘原子 rename；临时文件始终与目标同目录。

外部编辑与 Git 操作遵守“暂停插件写入 → 外部编辑 → 独立校验 → 刷新接纳 → 重新开始工作”。刷新不得沿用受影响旧绑定；任意进程同时改同目录不受支持，提交前重读不消除最后核对至系统调用之间的竞态。

### 5. 应用接口与命令封套

以下是插件内部及自有 Remote 的计划契约，不宣称为 DSH 已有方法。Remote namespace 为 `conaProject`。**Remote 与 Agent 工具是两条不同的可信主体来源；只有 UI Remote 路径的 R1 范围限定为 owner，不把该判据用于工具。** rc.2 的 `principalOf()` 对 owner Remote 和无 invocation 的进程内调用都返回 undefined，因此仅该函数为空不能证明任何授权。

| 入口 | 主体准入判据 | 应用层身份与处理 |
|---|---|---|
| UI Remote | 必须是宿主实际生成的 `ctx.invocation`，peer 主体合法；`peer.principal.kind === "owner"` 且 `principalOf(invocation) === undefined` | 适配器生成 `remote-owner` 身份；仍核对项目访问、源与命令，不授予工具 owner 身份 |
| 非 owner 或无 invocation 的 Remote 入口调用 | 非 owner 在 R1 拒绝；缺 invocation、缺合法 peer 或仅业务参数声称 owner 均拒绝 | 不降级成进程内 owner，不自动转入工具路径 |
| Agent 工具 | 由宿主实际 `ToolRunContext` 捕获可选 `agent`、callId／token／signal，并匹配实际 Agent 对象、活动 turn、WorkRun 与捕获绑定版本 | 生成 `agent-work` 身份；没有 Remote invocation 是正常情况，不因其缺失拒绝，也不因 principalOf 为空取得 owner 权限；缺 agent 或归属不唯一则拒绝新绑定并记 blocked |
| 其他进程内／恢复代码 | 不从调用者自报 origin、Remote 主体或 WorkRun 构造外部写主体 | 恢复只走明确的内部恢复接口，不能借 owner 身份重新执行模型命令 |

可信上下文是适配器在入口处捕获的只读判别联合 `remote-owner | agent-work`，与模型／Remote 的业务参数分开传入应用服务。统一提交逻辑按联合类型分派访问与资格校验，共用领域与持久协议，不共用一个“owner 或为空即放行”的判断。工具路径的真实 Agent 缺失与 Remote 路径 invocation 缺失是不同拒绝原因；上述运行映射在真实诊断插件验证前均为 untested。

| 接口 | 用途 |
|---|---|
| `sources.register / sources.open / sources.refresh` | 选择并登记资料源、打开／刷新、校验与生成源代际；不隐式迁移 |
| `projects.snapshot / projects.follow` | 完整快照与只读失效通知，均核对访问范围 |
| `projects.execute / projects.receipt` | 执行命令和查询原回执，所有写入口共用应用提交序列 |
| `conversations.link / conversations.open` | 本机多对多关联及打开实际聊天；会话创建结果独立记账 |
| `work.prepare / work.start / work.stop` | 准备范围预览、明确开始运行、请求取消并观察终态 |

规划封套包含 `operationId, projectId, instanceId, sourceEpoch, expectedPlanVersion, expectedPlanRevision, command`。创建项目使用先登记的空源实例及空规划哨兵 `empty`／规划修订 0，只有不存在权威头时允许 `create-project`；首次成功后修订从 1 开始。读取到非空目录或另一项目时拒绝覆盖。

命令类型为 `create-project / add-nodes / update-node / split-node / set-dependencies / set-node-status / append-record / link-conversation`。私有关系命令和过程追加核对自己的观察版本，不以无关规划外记录推动规划冲突。`split-node` 一次给出全部新子节点与期望映射；由应用生成 id，不接受模型指定新节点身份来覆盖旧节点。依赖、状态改变均是明确规划命令。

返回结果联合为 `committed / rejected / pending-reconciliation`。`committed` 携带原生成 id、原提交版本、恢复来源和回执 id；`rejected` 携带稳定码、参数及可公开的当前基线；`pending-reconciliation` 携带原操作 id、阶段与诊断，不能显示为可安全换 id 重试。稳定错误码至少区分 `plan-conflict / source-changed / invalid-project / unsupported-format / forbidden / binding-expired / operation-mismatch / persistence-failed / unknown-state`。

Agent 工具为 `project_read / project_apply / project_record / project_receipt`，读取并应用同样服务。工具参数不提供可生效的身份或授权字段，拒绝未知参数；所有成功输出声明可校验 JSON schema，并由宿主工具流水线处理。原调用归属由适配器提供：本机主体、实例、WorkRun 稳定 id 和原绑定版本；连接／重新准入的临时 request id 不进入业务请求摘要。重试工具须明确引用原操作归属并由当前访问身份核查，不能自行转移他人的操作。

### 6. 意图、回执与恢复状态机

每实例一个提交队列，最多存在一个未决发布意图；未决时阻止后续写入，查询只返回已核实内容或标明未同步缓存。进入序列后：

1. 按入口捕获的可信主体类型分派校验：Remote 核对真实 owner invocation，工具核对真实 Agent／执行归属；二者各自核对访问范围和格式，不调用同一个 owner 判断。生成规范化请求摘要，包含命令、业务参数、输入基线和原操作归属，不包含重连临时标识。
2. 查 `(instanceId, operationId)`。已完成且摘要／归属一致，返回历史结果；不一致拒绝；未决进入核对。此步骤先于新写绑定和当前规划冲突判断，但仍需当前读取权限。
3. 无原意图时，检查当前绑定、源代际与规划基线。重读完整源；若仅增加记录，按最新索引重新构造，若规划变了则冲突；非法资料停止源写入。
4. 生成候选聚合和 id，校验并持久保存 `prepared` 意图，包含原／候选头和正文指纹、候选头字节、生成 id、计划修订和业务结果。
5. 持久写入 `publishing` 阶段，发布不可变正文；重新核对原完整基线及活动资格，然后替换公开头并读回。不能证明未开始替换的异常保留未知。
6. 在一份新的本机聚合中同时保存完成回执、最终双修订和观察基线，标记 `committed`。只有这一步明确成功才返回正常提交成功；通知随后发送，通知失败不撤回事实。

纯私有命令直接在本机聚合内保存业务结果、回执和状态修订，不进行公开发布；原操作查询顺序一致。共享记录追加可只推进状态修订，公开头变化仍核对完整基线；修改原记录使用观察哈希，不能覆盖他人新增索引。

| 持久阶段／观察 | 恢复处理 |
|---|---|
| `committed` | 返回历史结果，不向当前 Git 分支重放 |
| `prepared` 且已证明未进入 publishing | 标记未发布／终止，保留操作 id；若需再执行使用明确的新命令，不隐式重放 |
| `publishing`，当前全部发布内容准确匹配候选 | 在实例队列中完成 `reconciled` 回执及计划修订一次；标注内容经核对，不证明作者或外部执行 |
| `publishing`，当前等于原基线、部分匹配或已分叉 | `pending-reconciliation`，不能排除发布后回退，不自动重试／覆盖 |
| 本机 state 无法可靠读取或返回 unknown-state | 隔离该实例存储，停止其读写，Client 只可保留未同步缓存 |

完成回执和修订一起替换，因此恢复重做“完成”不会重复推进计数；完成前崩溃仍看到原意图，候选修订保存在其中。未知本机落盘先重开并验证文件，不能继续信任旧内存对象。未决处置通过只读诊断、离线核对和保留原资料的显式恢复执行；不得提供一键“忽略后换 id 重跑”。R1 至少能自动核对精确候选、恢复已完成回执，并对无法判定情形稳定停止；复杂分叉的自动合并不属于 R1。

### 7. 真实聊天、请求准入与活动 WorkRun

先保存本机聊天关系，再准备明确工作意图：目标集合、允许 `add / update / split / dependencies / record / status` 中哪些动作、原因可发布范围和输入规划基线。用户在 UI 的“开始工作”确认这份具体范围，或通过已有可信工作入口沿用已授权范围；不强迫每次合法拆分再次审批。R1 不实现自然语言自动扩大权限，绑定外变更先保留为建议。

需要创建聊天时调用宿主会话入口并记录实际返回 id；发送成功只表示进入 inbox。新建聊天是文件协议以外的动作：先持久记录打开／创建意图，记录返回结果；创建后结果未知时查宿主列表并待核对，不自动再创建第二个聊天。单纯打开已有聊天不激活写绑定。

固定源码中已确认的候选映射：

| 宿主事实 | 接入方式与待实测边界 |
|---|---|
| `ToolRunContext` 继承的 `agent?: Agent`，及 callId／token／signal | agent 可缺失；必须取得真实 Agent 并唯一映射活动执行才能新建绑定，否则拒绝并记 blocked；不能从模型参数构造 |
| `Agent.id: SessionId` 声明在 `core/agent/src/types.ts:18` | 关联实际会话；同时核对本进程 Agent 对象身份，重启对象不是原活动执行 |
| `principalOf` 对 owner 及无 invocation 都返回 undefined | 只供 Remote 判据的一部分；工具按 §5 独立准入，不能仅凭空值取得 owner 或任何写资格 |
| Session prompt 的 `requestId` 保存为消息 `source.rpcId` | 为插件创建的工作请求登记期望消息来源，只在宿主实际消费时绑定；rpcId 不是秘密令牌或授权本身 |
| `agent/inbox/claimed` 给出消息和 turn；`agent/pre-step` 给出实际 agent／turn／step／signal | 将本机待执行意图与已消费消息对应，首次匹配启动 WorkRun；排队 next-turn 只登记，未消费不改绑定 |
| Session `turn/start`／`turn/end`、Agent 状态和 abort | 用持久终态和活动上下文共同撤销绑定，不把 `agent/turn-stopping` 预告当已终止 |
| `systemPrompt.context` 可按真实 Agent 提供动态内容 | 在实际准入边界注入有来源目标，提示文本不参与授权判断 |

这些接口存在不证明可以无歧义映射全部轮次。实现前置实验必须覆盖 queue、steer、同轮多个输入、cancel、工具迟到和 Host 重启；不能取得唯一执行归属时，拒绝新绑定或将该入口标 blocked。`source.rpcId` 由 Client 提供，匹配时还必须核对当前实例、本机已登记工作意图、实际 Agent、消息消费及 owner 来源，不能仅凭消息里有同名 id 授权。

活动身份键采用 `(Host 启动代际, 实际 Agent 对象, SessionId, turn)`；每次工具执行捕获不可变绑定快照及版本，提交前再次核对该捕获版本仍有效，不读取一个可随选中节点变化的全局 currentNode。范围改变／外部资料重载创建新绑定并保留接续记录，旧调用无法取得新权限。

一次规划命令成功后，服务可为同一活动 WorkRun 生成仅更新已接受规划基线的新绑定版本并返回；目标范围和动作集合不自动扩大。下一次工具调用必须在新可信执行边界取得该版本，已捕获旧版本的并行／迟到调用被拒绝。新创建子节点若需成为后续执行目标，必须显式接续纳入，不能从“能创建子节点”推导出无限扩权。

取消请求立即停止新写准入并观察真实终态，已进入文件发布的命令按第 6 节完成核对；UI 断线不取消 Host 工作。Host 重启只恢复历史及未决意图，所有活动绑定失效，需新的真实请求边界重新建立。工具从 R1 起按独占方式注册，不主动加入并行工具执行，但仍测试排队与迟到调用。

源码依据（固定提交）：[可选工具 Agent](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/core/tools/src/contracts.ts#L188)、[Agent.id 声明](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/core/agent/src/types.ts#L18)、[消息消费](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/core/agent/src/runtime-types.ts#L329)、[pre-step](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/core/agent/src/runtime-types.ts#L351)、[会话请求来源](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/api/session-controller/src/index.ts#L485)、[principalOf](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/typert/protocol/src/principal.ts#L14)。只读源码事实已回写[接入调研](../../../docs/research/2026-11-11-dsh-project-management-review.md)。其中 owner Remote、工具上下文与 turn 映射已由 2026-11-13 实测覆盖；非 owner 与绑定准入仍未验证（见下表）。

#### DSH 行为前提与验证状态（2026-11-13 实测）

| 前提 | 状态 | 证据 |
|---|---|---|
| 单用户部署的调用主体只有 owner；`PrincipalMap` 仅 `owner` | 已核对源码＋实测 | `packages/typert/protocol/src/types.ts:455`；2.4 记录 |
| 非 owner 仅 liveshare `share-viewer`，需独立部署的 Liveshare 服务（owner host + gateway worker + Relay；浏览器 OAuth 契约由部署方实现） | 已核对源码 | `liveshare-protocol/README.md:29`、`identity/types.ts:35`；本机无该服务 |
| UI Remote（浏览器/API cookie）是真实 owner invocation；`principalOf` 对 owner 为 undefined | 已实测 | 2.4 记录 |
| 工具路径无 invocation；ToolRunContext 只有 callId/rootCallId/agent/signal | 源码＋实测 | `packages/core/tools/src/contracts.ts:175-203`；2.4 记录 |
| queue 投递到 next-turn，不打断当前 turn | 已实测 | 2.4 记录 |
| steer 在 step 边界注入，不 abort 在飞工具；迟到结果仍进入本 turn | 已实测 | 2.4 记录 |
| cancel 使工具 signal abort，宿主把结果替换为错误，`turn/end` 为 aborted/user | 已实测 | 2.4 记录 |
| `Agent.id`＝SessionId 跨重启稳定；callId 每次执行换代 | 已实测 | 2.4 记录 |
| 自定义 profile 默认不含 Web 应用；需显式加入 `@deepseek-ai/dsh-web-app` 才能观察 Client | 已实测 | 环境记录第二轮 |
| R1 没有绑定/准入层；绑定与“有限范围准入”属第 6 段 | 设计事实 | tasks 6.2／6.5 |

非 owner 与绑定准入保持 `blocked`，不以进程内伪造 principal 补测；复测条件见 [范围修订](scope-amendment.md)。

### 8. 快照与面板同步

快照包含 `projectId, instanceId, sourceEpoch, schemaVersion, planVersion, planRevision, stateRevision`、完整小树／记录索引、本机关联和同步状态。应用先读取本机版本，再读取头及全部引用并复核哈希，最后核对本机版本和资料基线；变化则重读。若持续变化无法取得一致结果，返回明确未同步，不输出半新半旧快照。

Client 先建立失效流，收到 ready 后回读。流在相同实例／源代际内报告已知最高 stateRevision；加载中遇新通知则继续读至覆盖。源代际变更是替换边界，不比较其大小；旧流关闭，按新的 source descriptor 重新订阅／回读。每次请求捕获 connectionGeneration 和 source descriptor，返回时先核对代际，再核对单调 stateRevision。重连重建流并完整回读。

本地草稿单独保存基线、字段修改和选中节点，不随权威快照直接清空。版本冲突保留草稿并展示差异，R1 不自动合并复杂编辑；历史回执更新操作展示，不替换当前快照。公开发布尚待本机完成时禁止产生“已保存”快照；旧缓存明确标未同步。树及规划摘要从同一快照派生，以自动测试核查未来路线图共用数据的基础。

### 9. i18n 与时间

使用宿主 locale，不加第二个语言选择器。命名空间 `dsh-cona.project`，`zh`／`en` 字典按同一类型 key 约束，并校验命名占位符；`locale/zh.json`／`en.json` 单独提供包元信息。Client 生命周期内注册并清理，组件渲染时翻译，导航使用动态 label。其他宿主语言回退英文，固定文案使用对应语言的数字格式。

Host 只返回稳定码与参数，项目名称、目标、原因和聊天保持原文。R1 若显示操作时间，只存 UTC instant 并按明确显示时区用 Intl 格式化；记录格式显示时区，语言不决定时区。目标日期与时间轴不在 v1 中，不能为了显示时间把日历日期保存为 UTC 午夜。

### 10. 验证、证据与分段交付

详细矩阵见 [validation-matrix](validation-matrix.md)，任务见 [tasks](tasks.md)。顺序为格式／领域 → 独立包与身份能力前置检查 → 文件提交与恢复 → 面板同步／i18n → 聊天与真实 Agent → 完整演示。加载、身份可行性实验尽早进行，失败时不继续堆叠受影响业务代码。

每组任务随实现落必要测试与协议说明。自动测试覆盖纯领域、字节指纹、状态机及 Client；文件注入覆盖明确失败与 unknown；实际 profile 验证安装、Remote、重连、会话及真实工具上下文。替身通过只证明替身边界，不能替代真实 DSH／Agent 运行。门禁增加构建、类型和必要测试，保留现有洁净度／链接／双语检查；Node 24 为插件 CI 基线候选，实际版本记录在结论中。

## Risks / Trade-offs

- [第三方依赖或 Client 模块协议不成立] → 先做独立包加载前置实验，不修改宿主核心绕过；必要方案变化回写 change 并复审。
- [请求／turn 无法可信对应] → 收窄到可核查入口并明确受阻；缺少真实 Agent 闭环时 R1 保持未完成，不信模型字段补齐。
- [文件型私有后端需要自证失败语义] → 以单实例聚合替换保存回执和修订，注入所有持久边界，unknown-state 隔离实例；不冒充已验证宿主存储。
- [公开头和本机记录跨介质半提交] → 持久意图、候选内容核对和稳定待核对状态；不保证跨协作者全局恰好一次。
- [顺序外部编辑与发布仍有竞态] → 明确单写者及暂停／刷新边界，拒绝未知内容，保留未提交编辑；不宣称任意外部并发安全。
- [v1 尚不含时间和交付关系] → 保留稳定 id、明确拒绝未知字段，R2 用版本迁移扩展，不以预留任意 JSON 字段制造兼容承诺。
- [路径与平台差异] → 用 Node 跨平台 API 并测 symlink、hardlink、大小写和权限；未运行的平台保持 untested。

## Migration Plan

1. 第 1 轮外部审阅已完成；本轮按 `review.md` 修订，记录 `review-response.md` 并复查后提交，不实施产品代码。修订稿尚无外部二次复审，不将作者复查写为外部放行。
2. 实施时先建立独立 home／profile 和临时项目目录；不得重置个人 profile，不安装到用户日常环境验证。
3. R1 没有已有产品数据需要自动迁移。创建前检查目标目录，接入只接受 v1 并保留原 id；不解析历史 Cona 数据库。
4. 验证结束卸载测试包，保留需审计的本机结论；运行原始证据放忽略的实验目录，手写结果回写本 change 与路线图。卸载保留资料和回执，不以删除资料实现回滚。
5. 发布候选仅为本机预构建实验包，未获指令不推送、打 tag 或发布注册表。R2 若改格式，另写显式兼容和迁移 change。
