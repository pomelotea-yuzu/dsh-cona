# add-project-overview-and-resume 外部审阅

## 审 2 · QoderCN（独立外部 Agent，非 DSH） · 2026-11-18

独立给出结论，未读取或参考审 1 意见（审阅时 review.md 尚不存在）。只读审阅，不实施；本文件为审 2 唯一交付。

### 范围与方法

- 通读 [proposal](proposal.md)、[design](design.md)、[增量 spec](specs/project-overview-resume/spec.md)、[tasks](tasks.md)、[validation-matrix](validation-matrix.md) 及 `openspec/changes/README.md` 的状态改动。
- 对照 R1 六份 specs、插件源码（`packages/project-plugin/src/`）、[产品设计草案](../../../../docs/product/2026-11-11-project-management-design.md)、[开发路线图](../../../../docs/engineering/2026-11-12-plugin-development-roadmap.md) 与 [R1 验证矩阵](../../archive/2026-11-19-establish-r1-project-plugin/validation-matrix.md) 逐项核对术语、机制与需求来源。
- 独立复跑校验（非转述作者结果）：
  - `npx --yes @fission-ai/openspec@1.17.0 validate add-project-overview-and-resume --type change --strict --no-interactive --json`：`valid: true`，1 项通过／0 失败，`issues: []`。与编写交接同版本。
  - `node scripts/check-repo.mjs --all` 在包含全部已跟踪文件、README 改动与新 change 目录的临时 Git 快照（242 个待查文件）中运行：洁净度 0 失败／0 警告，32 项自测通过，链接门禁 99 篇 0 问题，双语门禁 5 对 0 问题。快照用后已删除。
  - 本会话 shell Node 实测 `v26.13.0`，与交接记录一致；CI 固定 24.21.0 的差异属环境边界，见 B3。

### 确认通过项

1. **工件与映射齐备。** 13 个增量场景与 O01–O13 逐项对应，tasks 1.1–4.2 覆盖全部 13 项；全部 `untested`，无预勾选、无预填 review。A/F/H 分层与 R1 实践一致（宿主 UI 项 H、指针失败注入 F、乱序 A＋H）。
2. **术语与 R1 实现一致，关键语义有源码支撑。**
   - `append-record` 只推进 `stateRevision`、不动 `planRevision`（`src/application/command-service.ts:726-730`），支持 spec「接续保存只更新记录状态修订」。
   - `appendRecordIndex` 尾部追加且拒绝重复 id（`src/domain/commands.ts:77-85`），支持「索引尾部向前选取」与「重试后至多一条记录」。
   - `operationId` 幂等、`sourceEpoch`／`expectedPlanVersion` 基线、unknown-state 隔离、每实例串行队列均有 R1 实现与规格依据；聊天 `linkId` 关联存于本机实例聚合（`src/application/local-state.ts:149,167`、`src/application/conversations.ts`），公开／私有分离符合可移植设计。
   - 结构化 JSON 块写入 `execution-note` 正文、卡片只解析经 v1 内容与正文哈希核对的块：v1 正文为不可变 UTF-8 Markdown、散列覆盖实际字节，该扩展不破坏 v1 校验器读取，兼容声明成立。
3. **需求来源真实。** 顶部入口与首版卡片内容（停点／成果／下一步／决定／来源／原聊天）与产品设计草案 §项目入口与面板、§首版“接着上次做”卡片逐条对应；「浏览不改运行目标」「不按同名会话误连」「历史验证不当当前通过」均保留。R2 后续项（树移动重排、Git 双副本、位置迁移、路线图）的切分与路线图 R2 一致。
4. **宿主接入态度诚实。** `shell.overlay`／`uiWorkspace.openSession` 明确为候选路径，先运行探针、失败回写修订，与产品草案静态核查结论（「不能把有全局浮层当成布局适配已通过」）一致；未把静态可见当运行通过。
5. **安全边界保留。** 公开文本中的路径／命令不触发操作（O10）、越界／失效引用关闭动作、干净 profile 无私有指针／Session／授权（O12）、导航不恢复旧执行授权（O11），与 R1 可信执行边界一致。
6. **红线无违反。** 无 push/tag 计划、无平台原生 API 假定、未测项保持 untested。

### 问题

#### A1 · Host 多实例路由是实质扩展，现状、改动面与 R1 契约归属未写明（须处理）

- 事实：R1 Host 是懒装配**单运行时**（`src/host/project-service.ts:145-149`，失败结果被记忆），`follow` 与 `execute` 对非配置实例显式返回 `forbidden`（`project-service.ts:223-226,270-275`）；R1 矩阵 V15 已把「实例不符均 forbidden」记为部分实测。
- 事实：design §2 要求新项目界面的快照、订阅、保存、导航「均显式指定实例」，tasks 2.1 要求「显式实例路由」。这必然改变上述拒绝语义，并要求 Host 支持多个已登记实例的打开与服务。
- 问题：design 未写明运行时扩展方式——多运行时并存还是切换复用？浏览 B 时 A 的运行中 WorkRun、命令队列与订阅如何不受扰动（design 只有「新浏览选择与运行实例分开」一句结论）？proposal 声明「Modified Capabilities：无」：R1 panel-sync spec 文本按「资料实例」泛化书写、字面不冲突，但 R1 已验证的拒绝行为发生变化，tasks 4.2 只泛写「R1 回归」，未列受影响项。
- 要求：design §2 补运行时扩展方案与隔离机制；明确该变化归属——给 `project-panel-sync`／`project-command-commit` 补 MODIFIED 增量，或在 proposal 论证为何不构成规格修改并列出须复跑的 R1 验证项（至少 V15 的实例不符分支，及 follow 相关项）。「未登记／不可访问实例仍拒绝」须保持为显式验收点（O03 的「无访问资格请求」应点名覆盖）。

#### A2 · 接续标记的存放位置、选取成本与不可读回退语义未定义（须处理）

- 事实：v1 索引条目只含 id／kind／summary／subjectNodeIds／sources／内容哈希等（`src/domain/commands.ts:77-85` 及 v1 schema），无接续标记字段；design §3 的标记在正文 JSON 块内。
- 问题一：「从索引尾部向前找最后一条有接续标记的记录」若标记只在正文，选取须逐条读正文并核哈希。标记如何被索引级识别（summary 约定？仍用 `execution-note` kind 逐条探测？）、读取上限与成本未说明。产品草案只承诺不重扫全部聊天，记录选取策略也应在 design 写明。
- 问题二：最新带标记记录格式未知时，design 倾向「显示不可读」，spec O09 未明确是否回退到更早的可读接续。两处须写成同一语义（建议明确不回退、不可读即当前态，避免实现分歧）。

#### B1 · 「进入既有树编辑器」缺显式验证点（建议）

spec Req1 MUST「能进入既有树编辑器」，tasks 2.2 交付入口，但 O01／O02 观察点未点名「点击入口实际打开 R1 树编辑器、位置与草稿保留」。建议在 O02 补一句观察点，避免入口只验存在不验落点。

#### B2 · repositoryId→本机工作副本映射的来源未定义（建议）

design §4 依赖「当前实例显式的本机工作副本映射」。R1 现有实例位置（`project-directory` 的 codeRoot，`src/application/location.ts:23`）与公开 `project.repositories` 声明，但没有现成的 repositoryId→本机路径映射结构。该映射由实例位置派生（单仓库）还是新增本机登记（多仓库）、由哪个任务交付，design／tasks 未写明；若是新本机结构应落到 tasks 3.2 并说明其受实例聚合与私有根检查约束。

#### B3 · 运行环境版本记录（建议，不阻塞）

编写与本次复核均为 Node v26.13.0，CI 固定 24.21.0。tasks 4.2 执行 `pnpm check:ci` 时按 R1 约定记录实际二进制绝对路径与补丁版本，不把 shell 版本当宿主运行版本。

### 结论

**有条件放行。** 方向、范围切分、验收设计与 R1 复用整体成立，校验独立复跑通过。A1（多实例扩展与 R1 契约归属）、A2（接续标记与不可读语义）须由作者修订并在 review-response 记录依据；B1–B3 建议一并处理。修订后按工作流由原审阅者确认；涉及「Modified Capabilities：无」的取舍若与审 1 冲突，交用户裁决。审 2 不承担执行。

---

## 审 2 · QoderCN · 2026-11-18 · 复审（第 2 轮）

范围：作者按双审意见修订后的 proposal、design、增量 spec、tasks、validation-matrix 及 [review-response](review-response.md)。逐条核对审 2 原 A1／A2／B1–B3 的处理，并抽查审 1 各条回复与修订稿是否一致；不代替审 1 给出其确认。只读复审，不实施。

### 逐条确认（审 2 原意见）

- **A1 · 已处理。** design §2 如实写明现状（`host/index.ts:328-329` 单一记忆化 runtime、`follow`／`execute` 对非配置实例 `forbidden`，均已对照源码核实），方案为新增 owner 概览入口与既有 Remote 分离、按 `instanceId` 按需共享运行时、配置实例复用已打开 runtime、闲置可释放；浏览／保存 B 不替换 A 的 WorkRun、队列与其他 Client 订阅，工具与宿主事件仍绑 A（`work-events.ts:9` 的「多实例事件路由属 R2」注释与此一致）。proposal「Modified：无」现有论证：既有 Remote 拒绝语义不变，新行为由新增能力规格约定——成立。tasks 4.2 点名复跑 V15 实例不符分支、V32、V37；O03 覆盖未登记实例与非 owner 拒绝，O11 覆盖 A 活动 WorkRun 下浏览／保存 B 的隔离。
- **A2 · 已处理。** 标记落在现有 `summary` 字段的保留前缀 `[cona:resume] `（`domain/types.ts:86`、`validate.ts:338` 核实 summary 为必填字符串、无模式约束，前缀兼容 v1，不改索引字段与 `schemaVersion`）；快照本就返回含 summary 的完整索引、不含正文（`snapshot.ts:73-74`），索引级选取可行。选取规则可执行：尾部向前、kind＋前缀双匹配、跳过普通记录、首个候选即停、最多解码一条、64 KiB 上限、失败显示原因且**不回退**——design §3 与 spec O09 场景语义一致，O09 观察点覆盖普通记录跳过、未知版本／超限／坏结构／哈希不符及「从未显示旧接续」。
- **B1 · 已处理。** tasks 1.1 增补 `layout` 注入与 `ctx.layout.selectPanel` 探针（现 client 只 inject `slots`／`locale`，`client/index.ts:20` 核实，探针确有必要）；O02 验证从 A／B 分别进入既有树编辑器的面板落点、实例、节点、草稿与返回位置；spec Req1 增加不可读实例禁用入口并附原因。
- **B2 · 已处理。** design §4 明确新增仅用户可编辑的本机 Host 配置，按 `instanceId`＋`repositoryId` 绑定工作副本根，只匹配该实例公开声明的仓库，支持空配置与多仓库，无隐式回退；tasks 3.2 交付并复用安全根检查；O09／O10 覆盖缺映射与其他实例映射。
- **B3 · 已处理。** tasks 4.1 区分宿主内进程与编写环境；4.2 记录门禁 Node 实际二进制路径、补丁版本、pnpm 与宿主 Node 版本，按 CI 固定 24.21.0／12.18.0 核查。

### 抽查审 1 回复与修订稿一致性

A3 列表策略（禁用行＋诊断，spec Req2／design §2／O04 三处同词）、A4 树编辑器落点、B2 订阅句柄观察点（O03 记录 follow／followClose、代际与唯一浏览句柄）、B3 资料目录写入排除与纯规划提示（design §4 按规范相对路径排除、O08 实测无误报、spec Req4 增 MUST）、B4 必填项（trim 后非空、Host 拒绝、O05 核对公开文件与修订不变、预览排除本机字段）均已落实到工件，与 review-response 所述一致。未发现回复声称已改而工件未改的条目。

### 独立复跑（修订稿）

- OpenSpec `1.17.0`（npx 固定版本）严格校验：`valid: true`，1 项通过／0 失败，`issues: []`。
- 含修订稿与 README 改动的临时 Git 快照门禁：244 个待查文件，洁净度 0 失败／0 警告，32 项自测通过，链接 101 篇 0 问题，双语 5 对 0 问题。快照用后已删除。与 review-response「修订后校验」一致。
- 结构核对：6 Requirement、13 Scenario ↔ O01–O13 逐项对应，tasks 覆盖全部 13 项（含区间写法），13 项仍全部 `untested`，无预勾选。

### 遗留观察（不阻塞，供实施记录）

1. 工作副本映射配置自身的存放位置及其与私有根检查的关系未在 design 点名（现只写被映射根的校验）；建议 tasks 3.2 实施记录写明实际存放与检查路径。
2. 保留前缀可能被外部写入的普通记录占用：design 已定义该情形按候选不可读处理且不回退，O09 覆盖，行为闭合；实施时注意诊断文案区分「资料诊断」与「接续不可读」两个阶段。

### 结论

**确认放行。** 审 2 原 A1／A2 与 B1–B3 全部按意见落实，修订未引入新的范围或验收缺口，校验独立复跑通过。双审确认尚待审 1 复审；两份确认齐备后由作者按工作流复跑校验并提交。审 2 不承担执行。

---

## 审 1 · DSH · 2026-11-18

本节写在审 2 节之后；写入前 review.md 已含审 2 结论。以下事实均另行对照 change 工件、R1 源码与固定 DSH `0.2.2-rc.2` 源码快照，未把审 2 的具体意见当作核验依据；与审 2 主题重合处给出独立证据。本节编号只在本节内使用。审阅只读：除本文件外未修改 change 工件，未实施、未提交、未 push／tag。

### 审阅范围与方法

- 通读 [proposal](proposal.md)、[design](design.md)、[增量 spec](specs/project-overview-resume/spec.md)、[tasks](tasks.md)、[validation-matrix](validation-matrix.md) 及 `openspec/changes/README.md` 的状态改动。
- 对照 R1 六份 specs、R1 源码（`packages/project-plugin/src/`）、[R1 验证矩阵](../../archive/2026-11-19-establish-r1-project-plugin/validation-matrix.md)、[产品设计草案](../../../../docs/product/2026-11-11-project-management-design.md#项目入口与面板)、[开发路线图 R2](../../../../docs/engineering/2026-11-12-plugin-development-roadmap.md#r2项目树协作与工作接续) 与 [工作流](../../../../docs/development/workflow.md)。
- 对照本机固定 DSH `0.2.2-rc.2` 源码快照 `Developer/tools/deepseek-harness/`，只做静态事实核对，不当作运行证据。
- 独立复跑校验；未启动真实宿主，矩阵 13 项仍全部 `untested`。

### 校验与环境

| 项目 | 命令／方法 | 结果 |
|---|---|---|
| OpenSpec change 严格校验 | `~/Developer/tools/openspec/node_modules/.bin/openspec validate add-project-overview-and-resume --type change --strict --no-interactive --json`（1.17.0） | `valid: true`；1 项通过／0 失败／`issues: []` |
| 仓库门禁 | 在含新 change 与 README 改动的临时 Git 快照运行 `node scripts/check-repo.mjs --all` | `pass`；0 失败；32 项自测通过；链接 100 篇 0 问题；双语 5 对 0 问题 |
| 工件静态核对 | 逐份解析 Requirement／Scenario／O 条目／tasks | 6 个 Requirement、13 个 Scenario，与 O01–O13 一一对应；tasks 1.1–4.2 覆盖全部 13 项；全部未勾选、全部 `untested` |
| 真实宿主与插件运行 | 未启动 | 本审阅不产生运行证据；`pnpm check:ci` 未跑（本 change 无非文档代码改动） |

环境：macOS；shell Node `v26.13.0`；OpenSpec `1.17.0`；DSH 快照根包 `0.2.2-rc.2`。CI 固定的 Node `24.21.0` 未运行，Windows 标题栏／窄窗口的宿主控件差异未验证，均属环境边界。

### 确认通过项

1. **工件与场景映射完整。** 13 个增量场景与 O01–O13 逐项对应，tasks 覆盖全部场景；无预勾选、无预填 review-response；A／F／H 分层符合 R1 实践。
2. **R1 关键语义有源码支撑。** `append-record` 只把 impact 置为 `state`，不动规划修订（`application/command-service.ts:726-730`）；索引尾部追加且拒绝重复 id（`domain/commands.ts:77-85`）；`RecordIndexEntry` 字段为 id／kind／subjectNodeIds／path／contentHash／summary／sources／verification（`domain/types.ts:78-90`）。设计对「接续保存只推进状态修订」「重试后至多一条记录」的复用成立。
3. **DSH 接入候选路径确实存在。** rc.2 快照 `packages/client/ui-layout/src/client/index.ts:107` 声明 root 作用域 list 型 `shell.overlay`，`AppFrame.tsx:281,328` 挂载 overlay 层；`packages/client/ui-layout/README.md:36` 写明 `ctx.layout.selectPanel(id)` 选择 root `main` keyed 面板；`packages/client/ui-workspace/README.md:86` 写明 `ctx.uiWorkspace.openSession(target)`。design 把二者称为「候选路径、须运行探针」是诚实的，没有把静态存在当成运行通过。
4. **需求来源与切片切分成立。** 产品草案第 51–59、63–79 行要求窗口顶部入口、当前浏览项目概览、卡片内容、浏览不改变运行目标、原聊天不可用时仍读摘要；路线图 R2 第 61–71 行把树移动重排、Git 双副本、位置迁移和路线图放在后续。proposal 的 R2 首切片范围与之一致。
5. **安全边界保留。** 公开文本中的路径／命令不触发操作（O10）、越界或失效引用关闭动作、干净 profile 无私有指针／Session／授权（O12）、导航不恢复旧执行授权（O11），与 R1 `portable-project-data`／`project-conversation-context` 一致；未发现 push／tag 或平台原生 API 计划。
6. **校验独立通过。** OpenSpec 严格校验和包含新增文件的仓库门禁均通过；未发现命名、链接、双语或洁净度问题。

### 问题

#### A1 · 多实例的运行时模型与「运行目标」未定义，R1 单实例契约会变化（须处理）

- 事实：R1 Host 只有一份记忆化 runtime（`host/index.ts:329`），Remote、Agent 工具（`:349`）与宿主事件观察者（`:331-333`）共用；`follow` 对非配置实例返回 `forbidden`（`host/project-service.ts:218-226`），`execute` 同样（`:264-275`）；工具按 `runtime.value.work.captureBinding(sessionId)` 绑定（`host/project-tools.ts:244-247`）。`host/work-events.ts:12` 明确写着「R1 单实例装配；多实例事件路由属 R2」。
- 问题：design §2 要求新界面的快照、订阅、保存、导航「均显式指定实例」，但没有给出运行时扩展方式：每实例一个 runtime，还是切换／复用？浏览 B 时 A 的 WorkRun、命令队列、事件观察者和 `follow` 订阅如何不受扰动？B 的聊天里 Agent 调用 `project_*` 时，工具仍绑 A（可能写错资料）、被拒绝，还是要求切换运行实例？用户从 B 的聊天「显式发起新的工作」时，运行目标怎么变？proposal「Modified Capabilities：无」也未说明 R1 V15「实例不符 forbidden」部分实测行为变化后的复跑范围（V15 见 R1 矩阵第 23 行；V32／V37 已 pass，第 41／46 行）。
- 影响：只给 Remote 加 `instanceId` 而不改 runtime，B 的读取／保存无法工作；简单切换或复制 runtime 会破坏 A 的运行中队列／订阅；把 B 会话的工具继续绑 A 则可能写错资料，违背 R1 可信执行边界。
- 要求：design §2 增补运行时方案。建议按实例按需打开、可回收的 runtime；运行 WorkRun 仍固定 R1 配置实例；工具与事件观察者继续绑运行实例；Remote 读写按 `instanceId` 路由并复核注册／可读性。明确本切片是否只做「浏览只读」：若是，写明非运行实例的 Agent 工具调用被拒绝、保存／读取走显式实例、运行实例不变；若允许切换运行实例，写出切换步骤、旧 WorkRun／队列／订阅的处理与失败回退。proposal 论证「Modified：无」或补 R1 增量；tasks 4.2 列出 V15（实例不符分支）、V32／V37 的 follow／重连回归项；O03 或 O05 增加「A 有活动 WorkRun 时浏览／保存 B，A 的 WorkRun 目标、队列、订阅不变」观察点。

#### A2 · 接续标记无索引级入口，选取成本与「不可读是否回退」未定义（须处理）

- 事实：v1 索引字段被严格限定（`domain/validate.ts:31,37-38`），`RecordIndexEntry` 没有接续标记（`domain/types.ts:78-90`）；设计把结构化字段放进正文 JSON 块（design §3），而现有快照只返回索引条目（`application/snapshot.ts:511-546`），不返回正文；`execution-note` 与普通过程记录共用同一 kind。
- 问题：design 说「从索引尾部向前找最后一条有接续标记的记录」，但没有定义正文层面的识别方式、单次最多读多少条、遇到普通 `execution-note` 是否继续、最新一条带标记但 JSON 不可读时是否回退到更早的可读记录。spec O09 写「最新接续格式无法解析 → 格式错误单独显示为不可读」，design §3 写「候选格式未知或无法解读时说明接续记录不可读」，两处既可能读成「停止并显示不可读」，也可能读成「跳过坏记录继续向前」；实现会分歧。产品草案第 75 行只承诺「不在每次展开时重新扫描全部聊天」，没有承诺不扫描记录正文。
- 要求：把选取写成可执行规则：从索引尾部开始，跳过无标记记录；遇到第一条带标记记录即停止，解析成功则用它，失败则显示不可读且不回退（与 spec 一致）；给出读取上限，或可验证的本地缓存策略（本地缓存必须按公开索引／哈希复核，外部编辑后失效）；明确标记的正文语法、版本与普通 `execution-note` 的区分。不要改 v1 索引字段或 `schemaVersion`——严格校验会拒绝未知字段（`validate.ts:37-38`）。O09 增加两个观察点：较新位置有普通 `execution-note` 时仍选到上一条接续；最新带标记记录不可读时不回退且保留错误原因。

#### A3 · 「只列出可访问实例」与「不可读实例显示诊断」冲突（须处理）

- 事实：spec Req2 写「概览 MUST 只列出当前调用方可访问的已登记实例」；design §2 写「配置或登记失败时对应实例显示诊断，其他可用实例仍可选择」；O04 又要求「已登记实例不可读」时显示诊断。R1 当前只有 owner 一个可信主体（`host/project-service.ts` 的 `OWNER`），没有按用户／调用方的实例 ACL。
- 问题：若「可访问」指文件可读，不可读实例会被过滤，用户看不到诊断，与 design／O04 冲突；若指有权限，spec 应说明「可访问」是授权而非可读，并分别定义未登记、无权限、不可读三种状态。默认兼容的 R1 配置实例本身不可读时是否仍出现？O04 的「一个实例不可读」如何被选中？
- 要求：统一列表策略并与 O04 对齐。建议列出 owner 可见的全部已登记条目，逐条标注可读／不可读／未配置；不可读条目保留为非可选行并显示诊断；默认 R1 配置实例始终出现（即使不可读）。若坚持「只列可访问」，则把 O04 的不可读状态改为「已选实例在读取后变得不可读」，并去掉「诊断行」预期。无论选哪种，spec／design／matrix 三处用同一词。

#### A4 · 「进入既有树编辑器」缺验收落点与实例归属（须处理）

- 事实：spec Req1 MUST「概览 MUST 能进入既有树编辑器」；R1 树面板注册在 root `main` keyed slot（`client/index.ts` 的 `PANEL_ID = 'cona-project'`），DSH rc.2 用 `ctx.layout.selectPanel(id)` 选择（`ui-layout/README.md:36`）；R1 client 当前只 inject `slots`／`locale`（`client/index.ts:21`），没有 `layout`；tasks 1.1 只探顶部挂载、键盘、跨页可见性和会话导航，没有探面板选择；O01／O02 也没有「点击树编辑器入口后实际打开哪个面板、哪个实例」的观察点。
- 问题：入口可以「存在」而点击无落点，或在浏览 B 时打开 A 的树；tasks 2.2 只说「树编辑器入口」，未写它和实例选择、草稿、收起的关系。这会绕开本切片最核心的入口需求。
- 要求：tasks 1.1 增补 `ctx.layout.selectPanel`／等效面板导航的探针与 inject 声明核验；O01／O02 增加观察点：从 B 概览点击树编辑器 → B 的树、所选节点与草稿；从 A → A；不可读实例入口禁用并说明原因；打开后概览收起／返回时保留位置。实现若不能复用 R1 main 面板，须说明为何仍满足「既有树编辑器」。

#### B1 · repositoryId→本机工作副本映射缺来源与任务归属（建议）

`RepositoryDecl` 只有 `id`／`label`（`domain/types.ts:22-25`）；`project-directory` 的 `codeRoot` 是位置基准（`application/location.ts:23-24,64`），本机注册表条目只有 `sourceRoot`／`sourceKind`（`application/local-state.ts:52-64`），没有 repositoryId→路径结构。design §4 直接使用「当前实例显式的本机工作副本映射」。建议明确：单仓库是否直接由实例位置派生；多仓库是否新增本机登记／配置（须落 tasks 3.2，受实例聚合、私有根与路径范围检查约束）；否则 design 应声明本切片只支持单仓库，多仓库留到 R2 后续。O10 的「映射属于其他实例」需要一个可构造的映射来源，不能只靠路径猜测。

#### B2 · 订阅释放与重新订阅缺少观察点（建议）

design §2 要求「切换时释放旧订阅，丢弃迟到结果」；O03 只验证回到 A 后「实际订阅恢复」和迟到响应丢弃，没有验证旧订阅已关闭、没有重复订阅／监听。O02 的卸载重装检查覆盖进程级清理，不覆盖 A↔B 切换。建议在 O03 记录 `follow`／`followClose` 的实际调用与活动句柄数：A→B 关闭 A，B→A 关闭 B 且只保留一个新句柄；迟到的 A 事件不进入 B 的卡片／草稿。若实现按连接代际／选择代际丢弃，也记录相应代际值。

#### B3 · 代码观察的「资料写入不误报」与纯规划项目无验收（建议）

design §3／§4 要求代码探测区分「已知项目资料写入」与代码变化，无法可靠区分时显示待核对；也要求无代码工作副本的纯规划项目只显示规划基线并说明代码未核对。O08 只改变规划、HEAD 和工件字节，未覆盖「在 project-directory 实例保存接续后，`.dsh-cona-project` 的写入不被当成代码漂移」，也未覆盖纯规划项目。建议在 O08 或 O09 增加：保存一条接续后立即回读，代码基线不变、无误报待核对；把 `.dsh-cona-project`（`application/location.ts` 的 `PROJECT_DATA_DIRNAME`）排除在代码观察外；纯规划实例只显示规划基线并明示代码未核对。

#### B4 · 保存必填项与空态行为未验收（建议）

design §3 要求至少填写停点和下一步；spec Req3 只写「允许保存」，没有规定缺项时的行为；O05 只测两次有效保存，O04 的空态是「没有接续记录」，不是「编辑表单不完整」。建议补观察：停点或下一步为空时保存动作禁用或明确拒绝、不写公开记录、保留草稿；预览只显示实际将要共享的字段，本机聊天指针与机器路径不出现在预览／公开文件。这个反例很小，但能防止「空接续」成为最新记录并遮住上一条。

### 结论

**有条件放行。** 方向、范围切分、验收设计和 R1 复用整体成立；OpenSpec 严格校验与包含新增文件的仓库门禁独立通过；未发现红线违反。A1–A4（本节）须由作者修订并在 `review-response.md` 逐条记录依据；B1–B4 建议一并处理。A1 涉及「非运行实例是否只读」与 R1 契约取舍，若与审 2 或用户目标冲突，交用户裁决，不由作者自行选边。修订后由原审阅者确认；审 1 不承担执行，不预填 review-response。

---

## 审 1 · DSH · 2026-11-18 · 复审（第 2 轮）

范围：作者按双审意见修订后的 [proposal](proposal.md)、[design](design.md)、[增量 spec](specs/project-overview-resume/spec.md)、[tasks](tasks.md)、[validation-matrix](validation-matrix.md)、[review-response](review-response.md) 及 README 状态改动。只读复审，不实施；本节只确认审 1 原意见，不代替审 2 第 2 轮结论。

### 独立复核

- OpenSpec `1.17.0` 严格校验：`valid: true`，1 项通过／0 失败，`issues: []`。
- 含修订稿与 review-response 的临时 Git 快照运行仓库门禁：244 个待查文件，洁净度 0 失败／0 警告，32 项自测通过，链接 101 篇 0 问题，双语 5 对 0 问题。
- 结构核对：6 个 Requirement、13 个 Scenario 与 O01–O13 对应；8 项 tasks 全未勾选；13 项仍全部 `untested`。
- 对照源码复核 R1 单 runtime、`follow`／`execute` 对非配置实例 `forbidden`、`summary` 为必填字符串且无模式约束等事实；本轮未启动真实宿主，不产生运行证据。

### 逐条确认

- **A1 · 已处理。** design §2 新增 owner 专用概览入口与既有 Remote 分离；按 `instanceId` 按需共享 runtime、配置实例复用已打开 runtime、闲置可释放；项目工具与宿主事件仍绑配置实例 A；B 的界面禁用插件项目工作；同一 Session 的既有 A 绑定不迁移；切换运行实例与 B 的自动 WorkRun 明确留后续 change。proposal「Modified：无」补了论证并列出 V15 实例不符分支、V32、V37 的复跑要求；tasks 2.1／4.1／4.2 与 O03／O11 补齐观察点。
- **A2 · 已处理。** `execution-note.summary` 使用保留前缀 `[cona:resume] `；从已接纳索引尾部按 kind＋前缀选取首个候选，跳过普通记录，最多解码一条候选及 64 KiB 正文；候选失败显示原因并停止选取，不回退。正文以 `<!-- cona:resume v1 -->` 加带版本 JSON 块定义；不改 v1 索引字段与 `schemaVersion`。spec O09 覆盖普通记录跳过、未知版本／超限／坏结构／哈希不符及不显示旧接续。
- **A3 · 已处理。** spec Req2、design §2 与 O04 统一为 owner 的本机登记列表：已登记但不可读保留禁用行并给诊断；配置实例打开前失败且无登记时显示独立配置诊断；无配置且无登记显示未配置；未登记或非 owner 的定向访问拒绝且不返回列表／诊断；明确不需要应用层实例 ACL。
- **A4 · 已处理。** spec Req1 增加「进入所选实例的既有树编辑器」和不可读实例禁用；tasks 1.1 增补 `layout` 注入与 `ctx.layout.selectPanel`／等效入口探针；design §1 指定候选导航并写明打开前确认选择代际、成功后收起概览；O02 从 A／B 核对面板、实际实例、节点与草稿，O04 核对不可读实例入口禁用。
- **B1 · 已处理。** design §4 新增按 `instanceId`＋`repositoryId` 绑定工作副本根的仅用户可编辑本机 Host 配置，校验根路径与 Git 工作副本，只匹配实例公开声明的仓库，支持空配置与单／多仓库，禁止公开资料根、其他实例映射与聊天目录的隐式回退；tasks 3.2 交付，O09／O10 覆盖缺映射与其他实例映射。
- **B2 · 已处理。** O03 记录 A→B、B 重连、B→A 的 `follow`／`followClose`、代际与活动句柄数，要求各次切换后只有一个浏览句柄；O11 单独核对 A 的另一 Client 订阅及 A 的目标／队列不变。
- **B3 · 已处理。** design §4 增加按已核对规范相对路径排除归属本实例的资料目录写入，无法可靠判定时待核对；spec Req4 增 MUST，纯规划实例必须说明代码未核对；O08 增加「保存接续后无误报代码漂移」和纯规划实例观察。
- **B4 · 已处理。** spec Req3 要求停点、下一步非空，缺项提示并保留草稿；design 要求 trim 后非空、Host 拒绝保存；O05 分别验证缺停点／缺下一步时草稿保留、公开文件与修订不变，并核对预览与实际公开文件一致且不含本机字段。

### 遗留观察（不阻塞）

1. **A2 措辞可再收紧。** design §3「若需另读候选则按同一快照的路径及哈希复核」中的「另读候选」易被读成再读第二个候选；同段「最多解码一个候选」和「不回退」已定语义，建议实施记录或措辞改为「另读该候选正文」。O09 已覆盖，不影响放行。
2. **B1 配置存放位置。** design 只写了被映射工作副本根的校验，未点名新 Host 配置自身放在哪个本机根、是否受私有根检查；建议 tasks 3.2 的实施记录写明（与审 2 遗留观察一致）。
3. **A1／Req5 的界面观察对象。** spec Req5 要求 B 的界面明示「项目工作入口不可用」，O11 写「B 的插件开始动作禁用」；当前 R1 树面板没有独立的「开始工作」控件。实施时需明确该提示落在哪个控件／文案，避免 O11 没有可观察对象。

### 结论

**确认放行。** 审 1 原 A1–A4、B1–B4 均已落实到工件，未发现新的目标、契约或验收缺口；上述遗留观察不阻塞实施记录。双审确认齐备，作者可按工作流复跑校验并在用户安排下提交；审 1 不承担执行。