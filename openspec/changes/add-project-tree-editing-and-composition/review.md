# add-project-tree-editing-and-composition 外部审阅

## 审 1 · DSH · 2026-11-20

审阅者身份：本会话为 DSH 侧独立上下文，未参与该 change 的编写（本会话无编写记录）。change 内未声明作者；[交接](2026-11-20-author-handoff.md)表明由 DSH 会话编写，故按工作流标注为“同模型独立上下文”。若作者并非 DSH 会话，请按实际作者身份更正标注。只读审阅，不实施；本文件为审 1 唯一交付，不代填审 2，也不代表审 2。

**第 2 轮复审更正：** [审阅处理](review-response.md#L3)与更新后的[交接](2026-11-20-author-handoff.md#L3)明确作者为 **Codex 会话**，不是 DSH；本轮是 DSH 独立会话对非 DSH 作者的审阅，首轮“同模型独立上下文”的保守标注不成立，以本更正为准。

### 范围与方法

- 通读 [proposal](proposal.md)、[design](design.md)、[增量 spec](specs/project-tree-editing/spec.md)、[tasks](tasks.md)、[validation-matrix](validation-matrix.md)、[author-handoff](2026-11-20-author-handoff.md)，以及 `AGENTS.md`／`openspec/changes/README.md` 的索引改动。
- 对照主 specs：[project-command-commit](../../specs/project-command-commit/spec.md)、[project-panel-sync](../../specs/project-panel-sync/spec.md)、[project-overview-resume](../../specs/project-overview-resume/spec.md)、[project-conversation-context](../../specs/project-conversation-context/spec.md)、[plugin-localization](../../specs/plugin-localization/spec.md)、[portable-project-data](../../specs/portable-project-data/spec.md)。
- 对照源码：`packages/project-plugin/src/domain/`（types／validate／transforms／commands）、`application/`（command-service／work／snapshot／baseline／local-state）、`host/`（overview-service／project-service／project-tools／owner-admission）、`client/`（panel-controller／project-overview-controller），以及 [v1 schema](../../../packages/project-plugin/formats/v1/project-v1.schema.json)、[plan-vectors.json](../../../packages/project-plugin/formats/v1/plan-vectors.json)、[plan-canonicalization.md](../../../packages/project-plugin/formats/v1/plan-canonicalization.md)、[resume.ts](../../../packages/project-plugin/src/domain/resume.ts#L37)。
- 对照文档：[工作流](../../../docs/development/workflow.md)、[决策](../../../docs/knowledge/decisions.md)、[产品设计](../../../docs/product/2026-11-11-project-management-design.md#动态项目树)、[架构](../../../docs/architecture/2026-11-11-project-development-architecture.md#用户搭建与拼接)、[路线图](../../../docs/engineering/2026-11-12-plugin-development-roadmap.md)、[i18n 设计](../../../docs/architecture/2026-11-12-plugin-i18n-design.md)。
- 只做静态与自动测试核对，未启动真实 DSH 宿主；14 个产品场景仍全部 `untested`。不把 CI 通过当作产品通过。

### 复跑校验

| 命令 | 环境与实际结果 |
|---|---|
| `openspec validate add-project-tree-editing-and-composition --type change --strict --no-interactive --json` | OpenSpec 1.17.0、Node 24.21.0：`valid: true`，1 项通过、0 失败、`issues: []` |
| `node scripts/check-repo.mjs --all` | 暂存 change 与两个索引改动后运行（门禁读索引；运行后取消暂存）：285 个待查文件；洁净度失败 0／警告 0；链接门禁 128 篇 0 问题；双语门禁 5 对 0 问题 |
| `pnpm check:ci` | Node 24.21.0、pnpm 12.18.0；build、typecheck、305/305 测试、包边界、协议同步、locale、manifest 全部通过，exit 0 |

交接中的 OpenSpec 1.17.0、check-repo 0/0、305/305 均独立复现。本会话 shell 默认 Node 为 v26.13.0；以上命令使用 DSH 自带 Node 24.21.0 与 pnpm 12.18.0，与交接的 CI 版本一致。CI 只验证现有代码，不验证本 change 的未来实现。

### 确认通过项

1. **工件与映射齐备，状态诚实。** proposal／design／一份增量 spec／tasks／validation-matrix／author-handoff 齐全；6 项需求、14 个场景与 T01–T14 逐一对应；17 项 tasks 均未勾选，14 项矩阵均为 `untested`；审阅开始前无 `review.md`，无预填 review、无预勾选。计数与交接一致。
2. **范围与产品路线图一致。** 同级重排、子树移动、内置流程插入落在 R2 第二切片；用户模板、分组、合并、复制、撤销／重做、文件骨架与项目提炼明确留给后续，产品设计中的“像搭积木一样搭建与拼接”没有被扩大解释为一次交付全部交互。
3. **数据结构与 R1 协议复用合理。** 继续使用 v1 的 `parentId`／`order`／节点与依赖字段，不新增公开字段；移动只改父子与同级顺序，节点 ID、记录和聊天引用不变；插入生成新 ID、`todo` 起始、内部依赖映射，发布结果可由旧 v1 读者读取。这与 [架构的搭建与拼接](../../../docs/architecture/2026-11-11-project-development-architecture.md#用户搭建与拼接) 的方向一致。
4. **提交与恢复基础成立。** 现有 `ProjectCommandService` 已有每实例串行队列、提交前重读、持久意图、回执、三态发布、双修订和恢复核对；`requestDigest` 覆盖命令与基线，`allocateIds`／`replay` 支持原 `operationId` 返回原结果，新操作号生成独立子树。新增命令可以复用这些机制，`tasks` 2.2／2.3 的验证点也落在这些机制上。
5. **owner／实例准入方向成立。** `conaOverview` 已有 owner 准入、实例登记核对与 `projectId` 校验；`conaProject` 为配置实例的 owner 入口；新增命令只由 `remote-owner` 发起，符合“现有 Agent 不因新入口扩权”的意图。`project_apply` 的 `PLANNING_TYPES` 白名单仍只允许原有五类命令（[project-tools.ts](../../../packages/project-plugin/src/host/project-tools.ts#L164)），新增命令不会自动成为 Agent 工具。
6. **界面与 i18n 方向成立。** 拖放与键盘菜单共用位置模型、预览与已保存可辨、取消恢复焦点、按实例隔离草稿、连接／源代际／修订守卫，均能挂到现有 `PanelController` 与 `project-overview-controller` 上；中英字典与英文回退沿现有 locale 方案。
7. **验收设计分层清楚。** A／F／H 分层、T01–T14 的观察点、矩阵 `pass` 门槛与运行记录要求，延续 R1／R2 首切片的做法；未把静态校验、替身或 CI 当作宿主实测。
8. **索引改动正确。** `AGENTS.md` 的活动 change 指向本目录，`openspec/changes/README.md` 新增一行且状态为“待独立双审”，旧的“当前无活动 change”已删除；仓库门禁与链接检查通过。

### 问题

| ID | 级别 | 摘要 |
|---|---|---|
| A1 | 必改 | 设计／spec 把“v1 要求单根”当作事实，与现有实现和协议向量不符 |
| A2 | 必改 | “项目根”未定义；根级同级重排与“根不可移动”互相牵扯 |
| A3 | 必改 | owner 改变规划后，活动 WorkRun 如何取得“接受当前基线的绑定”没有实现路径 |
| A4 | 必改 | T13／spec 要求接续卡片提示“规划基线已变”，但现有接续记录不保存规划基线 |
| B1 | 应改 | Agent 结构能力被收窄为 owner-only，但未写明这是本切片的显式延期 |
| B2 | 应改 | “共享一份草稿”与“切换语言后新开预览”的交互未对齐 |
| B3 | 应改 | “成功展示以有效回读为依据”与现有 `save()` 行为不一致，失败态未定义 |
| B4 | 应改 | 预设 ID／版本类型与预览读取契约未定义 |
| C1 | 建议 | 结构操作的变更原因与“受影响节点”未说明 |
| C2 | 建议 | “两份预设”“按矩阵单列真实 Agent 所需证据”“预设键……”等措辞需澄清 |

#### A1 · v1 根规则写错（须处理）

- **事实。** [design](design.md#L5) 写“v1 要求单根”，[spec](specs/project-tree-editing/spec.md#L24) 写“发布结果 MUST 符合 v1 单根、连续同级顺序和父子无环规则”。但当前实现只拒绝“零个根”，不拒绝多根：[validate.ts](../../../packages/project-plugin/src/domain/validate.ts#L182-L186) 在 `rootIds.length === 0` 时报 `root-count`，注释明确写“协议向量（plan-zh-base）确认 v1 允许多根森林”；[transforms.ts](../../../packages/project-plugin/src/domain/transforms.ts#L14) 也写“v1 允许多根森林”。[plan-vectors.json](../../../packages/project-plugin/formats/v1/plan-vectors.json) 的 `plan-zh-base` 是正向向量，含三个 `parentId: null`、`order` 0／1／2 的根节点；[v1 schema](../../../packages/project-plugin/formats/v1/project-v1.schema.json) 没有“恰好一个根”的约束。源码与协议向量都比 design 的概括更权威（[AGENTS.md 权威性](../../../AGENTS.md#权威性)）。
- **影响。** 这条错误的验收规则会让实现者或验证者把合法的多根 v1 资料判为不合规，或者为了“单根”做不必要的迁移；T01／T05 也不会覆盖多根文件。现有 [validate.ts](../../../packages/project-plugin/src/domain/validate.ts#L5) 顶部注释也写“单根树”，与同文件 183 行冲突，说明该错误容易在实现时被继承。
- **要求。** 把规则改成 v1 实际规则：至少一个根、每个父节点下的同级 `order` 从 0 连续（含 `null` 根组）、父子无环、依赖两端存在且无环。若产品确实要“单项目根”，把它写成独立的产品约束，并说明多根 v1 文件如何进入本切片（拒绝、要求先人工归并、还是保留森林并限制操作）；不要把它冒充为 v1 的格式要求。T01／T05 至少增加一个多根夹具，或明确声明多根输入不在本切片验收范围。

#### A2 · “项目根”与根级同级重排未定义（须处理）

- **事实。** [spec](specs/project-tree-editing/spec.md#L5) 要求“同级重排”，[spec](specs/project-tree-editing/spec.md#L24) 只允许移动“现有非根节点”，[spec](specs/project-tree-editing/spec.md#L34) 又要求拒绝“移动项目根”。[design](design.md#L17-L19) 写“活动项目根可作为目标父节点，根自身只能留在根位置”“将根移走……拒绝”。在 v1 允许森林的前提下，“项目根”是哪一种节点没有定义：是所有 `parentId: null` 的节点，还是树中的第一个根？根与根之间算不算“同级”？
- **影响。** 如果所有 `parentId: null` 都是“根”，那么根与根之间的重排就是被 Req 1 承诺、又被 Req 2 禁止的“同级重排”；如果只有第一个根是“项目根”，其他根可以移动，但 Req 2 的“非根节点”又写窄了。实现者无法从文本确定 T01／T05 应使用哪种夹具，也无法确定多根资料是否允许重排。
- **要求。** 明确“根节点 = `parentId` 为 `null` 的节点”，并二选一：  
  (a) 支持根级同级重排（目标父节点可为 `null`，只改根组 `order`），把 Req 2 的输入从“非根节点”改为“任意现有节点”，并单独拒绝把根移到非 `null` 父节点、把非根移成新根等会改变根集合的移动；或  
  (b) 明确“根级同级重排不在本切片”，把 Req 1 的“同级重排”限定为非根同级，并说明多根 v1 文件进入时的行为。  
  无论哪种，都应在 design、Req 1／2、tasks 1.1、T01／T05 中使用同一口径。

#### A3 · 活动 WorkRun 的“接受当前基线”没有实现路径（须处理）

- **事实。** [design](design.md#L30) 写“规划变化后的旧写请求按现有基线规则处理，重新取得写资格仍走已有准入”，[spec](specs/project-tree-editing/spec.md#L61-L62) 写“继续写入须按已有规则取得接受当前基线的绑定”。但当前代码的准入是严格相等：[work.ts](../../../packages/project-plugin/src/application/work.ts#L635-L643) 要求命令的 `expectedPlanVersion`／`expectedPlanRevision`／`sourceEpoch` 与 `run.acceptedBaseline` 完全一致，否则 `binding-expired`。`acceptedBaseline` 只在**该运行自己的**规划提交成功后由 `afterPlanCommit` 推进（[work.ts](../../../packages/project-plugin/src/application/work.ts#L652-L671)）；`captureBinding` 只读取旧值（[work.ts](../../../packages/project-plugin/src/application/work.ts#L529-L574)）；`continueScope` 只增加目标、推进绑定版本，不更新 `acceptedBaseline`（[work.ts](../../../packages/project-plugin/src/application/work.ts#L727)）。同一会话存在活动运行时，新消息消费会被 `deferred`，不能并行开新运行。  
  因此，owner 通过树编辑器移动或插入后，Agent 即使 `project_read` 拿到新的 `planVersion`／`planRevision`，`project_apply` 仍会因绑定已接受基线过旧而 `binding-expired`。现有测试“6.4 提交后新基线绑定”只覆盖该运行自己提交后的推进，没有覆盖 owner 外部提交。`project_read` 文档称其用于“取得后续写入所需的明确最新基线”（[tool-protocol.md](../../../packages/project-plugin/docs/tool-protocol.md#L21)），在 owner 改变规划后与准入实际行为冲突。
- **影响。** T12 的“继续写入须按已有规则取得接受当前基线的绑定”、tasks 2.4 的“显式取得当前写资格仍走既有准入”、tasks 4.4 的“显式续权”都无法按字面执行：当前唯一可行的“新绑定”是结束当前运行后，由新的 owner 工作意图／运行在真实边界重建；活动运行内没有“接受当前基线”的入口。若作者想表达“运行内可继续”，则需要新增机制；若想表达“只能等新运行”，则 T12／2.4／4.4 的措辞必须改成这个可执行步骤，不能写成“已有规则”。
- **要求。** 二选一并落到 design／spec／tasks：  
  (a) 增加 owner 专用的“接受当前基线”或新绑定版本机制，保持 targets／allowedActions 不变，只更新 acceptedBaseline 与绑定版本，并补任务和测试；或  
  (b) 明确 owner 规划变化后，活动运行只保留目标、绑定范围与历史，写入资格停止；继续写入须等运行结束，由新的可信边界建立绑定。把 T12、tasks 2.4／4.4 改成“旧基线拒绝、运行内不续权、新运行重新捕获”的可验收描述。  
  同时修正 `project_read`／tool-protocol 的“最新基线即可写入”表述，避免 Agent 按文档操作后被拒。

#### A4 · T13 的“接续卡片提示规划基线已变”缺少数据与实现（须处理）

- **事实。** [spec](specs/project-tree-editing/spec.md#L86) 要求“接续卡片按既有规则保留历史结果并提示规划基线已变”，[matrix](validation-matrix.md#L19) T13 要求“卡片显示原有验证状态及规划待核对原因”。但现有接续载荷 [ResumePayload](../../../packages/project-plugin/src/domain/resume.ts#L37-L58) 只有停点、下一步、成果、决定、未解决问题与历史验证引用，没有保存 `planVersion`／规划基线；`resumeCandidate` 返回 `payload + codeObservation + chat`（[overview-service.ts](../../../packages/project-plugin/src/host/overview-service.ts#L229-L277)），没有规划基线对比；保存路径把接续写成 `execution-note`，没有写入规划基线或 verification（[project-overview-controller.ts](../../../packages/project-plugin/src/client/project-overview-controller.ts#L308-L390)）。R2 首切片的 [O08 矩阵](../archive/2026-11-20-add-project-overview-and-resume/validation-matrix.md#L14) 仍是 `untested`，[收尾核对](../archive/2026-11-20-add-project-overview-and-resume/implementation/2026-11-20-archive-final-audit.md#L20) 明确“规划/HEAD/工件变化矩阵未全跑”，3.2c 实施记录也只交付代码观察（[3.2c](../archive/2026-11-20-add-project-overview-and-resume/implementation/2026-11-19-3.2-work-copy.md)）。R2 design 虽写“对照保存时的 planVersion”，但当前代码没有该字段。
- **影响。** T13 的“提示规划基线已变”无法由现有数据产生；如果按现状执行，只能验证“历史验证状态 + 代码观察”，不能验证规划基线。把它写成“既有规则”会让执行者误以为该能力已存在，或用一个无法复现的观察点交差。
- **要求。** 二选一：  
  (a) 在本 change 增加任务：在接续记录中保存可移植的规划基线（例如 `ResumePayload` 的可选字段，或既有 verification 的 `subjectVersion`），读取时与当前快照比较并给出“规划已变”的待核对状态；同时补格式兼容、旧记录无基线、解析失败与 T13 的验证。  
  (b) 从 spec／T13 删除“提示规划基线已变”，把 T13 限定为“历史验证状态 + 当前代码观察／未核对”，并明确注明规划基线核对仍属 R2 O08 的未测项，本切片不宣称覆盖。  
  无论哪种，tasks 4.5 的“核对原聊天与历史验证状态”需要与 spec／T13 同步，不能只改一处。

#### B1 · Agent 结构能力被收窄但未写明延期（建议处理）

- **事实。** 产品设计写“Agent 可提出或执行新增、拆分、重排、合并、替换、取消与重新打开节点”（[产品设计](../../../docs/product/2026-11-11-project-management-design.md#动态项目树)），架构也把“拖动／缩进／移出”和“插入流程块”放在用户与 Agent 共用的提交协议中（[架构](../../../docs/architecture/2026-11-11-project-development-architecture.md#用户搭建与拼接)）。本 change 明确“移动和插入由 owner 发起”（[proposal](proposal.md#L14)），spec 也要求“由受信 owner 发起”（[spec](specs/project-tree-editing/spec.md#L52)）；Agent 工具白名单仍只有原五类命令（[project-tools.ts](../../../packages/project-plugin/src/host/project-tools.ts#L164)）。
- **影响。** 如果这是有意的 R2 安全取舍，读者会从“现有 Agent 在原有动作和目标授权内继续使用既有工具”读出一半信息：Agent 不能用新命令，但原因与后续计划没有写。若这是无意收窄，则与产品基线冲突。
- **要求。** 在 proposal 的“后续范围”或 design 的 Non-Goals 中明确写“本切片先只开放 owner 入口；Agent 发起的移动／插入留待后续（原因：…）”，并说明 Agent 现有新增／拆分／改状态不受影响。若决定本切片就支持 Agent，则补动作映射、目标范围、根级新增拒绝、绑定与测试；不要只留一句“既有工具”。

#### B2 · 一份草稿与“切换语言后新开预览”的交互未对齐（建议处理）

- **事实。** [design](design.md#L32) 写“结构草稿与既有节点编辑共享面板的待保存编辑。开始另一编辑时显式保留原草稿或先由用户处理原草稿”，[spec](specs/project-tree-editing/spec.md#L20) 写“应用提示用户处理已有节点内容草稿后再开始另一编辑”。现有 `PanelDraft` 注释明确“同一时间只保留一份，避免合并冲突”（[panel-controller.ts](../../../packages/project-plugin/src/client/panel-controller.ts#L24)）。[design](design.md#L39) 又写“切换宿主语言时保留待保存正文……用当前语言重新选择模板即可创建新的预览”，[spec](specs/project-tree-editing/spec.md#L94-L95)／T14 则写“再保存原预览并新开一个预设预览”。
- **影响。** “显式保留原草稿”可以被读成“同时保留内容草稿和结构草稿”，与一份草稿模型冲突；切换语言后“即可创建新预览”也可能被读成在旧预览未保存时直接替换。T03／T14 的步骤因此有两种执行方式，结论会不同。
- **要求。** 统一为“同一时间一份草稿；已有内容草稿时先保存或放弃，再开始结构编辑”，并把 T14 的步骤写成“先保存（或明确放弃）中文预览，再切换语言、重新选择模板创建新预览”；或者明确允许每实例多份结构预览，并补面板模型与 T03／T14 的对照测试。不要只用“保留原草稿”这一句覆盖两种语义。

#### B3 · “成功展示以有效回读为依据”与现有 `save()` 行为不一致（建议处理）

- **事实。** [spec](specs/project-tree-editing/spec.md#L66) 要求“成功展示 MUST 以已确认回执及有效回读为依据”；[design](design.md#L37) 写“提交成功后从权威快照显示新结构”。现有 `save()` 在提交后调用 `reloadQuietly`，无论回读成功与否都把状态标为 `saved`；`reloadQuietly` 只捕获异常并 `markOffline`（[panel-controller.ts](../../../packages/project-plugin/src/client/panel-controller.ts#L304-L356)、[同文件](../../../packages/project-plugin/src/client/panel-controller.ts#L463-L470)）。tasks 3.3 已写“成功状态依赖有效回读”，但 design／spec 没有定义回读失败时的可见状态。
- **影响。** 结构保存可能显示“已保存”而界面仍是旧树，违反本 spec 的成功条件；如果实现只改结构保存，节点编辑仍保留旧行为，验收口径会分叉。
- **要求。** 定义“回执已提交、回读失败／未同步”时的状态（例如 `pending-read`／`saved-unverified`，提供重试，不显示普通 `saved`），并说明本 change 只改结构保存还是同时修正既有保存路径；把该状态加入 T09／T10 或 tasks 3.3 的观察点。若无法在本次修正，应把 spec 的成功条件收窄到“回执已确认且至少一次有效快照”，并如实标注剩余风险。

#### B4 · 预设 ID／版本类型与预览读取契约未定义（建议处理）

- **事实。** [design](design.md#L24) 只写“稳定 ID 和不可变版本”，[spec](specs/project-tree-editing/spec.md#L38) 要求“明确版本”，请求要提交“预设 ID、准确版本、选定正文语言及目标位置”（[design](design.md#L31)），但没有定义 ID／版本的类型、版本比较方式、预览读取的 Remote／载荷，也没有说明预设内容放在哪个随包文件。tasks 3.2 只写“接入预设列表和插入预览”，2.1 只写“预设读取”。
- **影响。** 客户端与 Host 的契约、`requestDigest` 的稳定值、未知版本／不可用版本的拒绝码都要等实现时临时决定，容易出现预览与提交版本不一致或无法复现。
- **要求。** 在 design 中给出最小契约：预设 ID 的类型（如稳定字符串）、版本的类型与比较（如正整数）、可选语言集合、预览载荷（层级／标题／目标／完成条件／依赖／来源）、读取入口的 owner／实例校验，以及这些值如何进入命令与摘要。tasks 至少把“预览读取入口”和“版本校验”落到 2.1 或 3.2 的可核验项。

#### C1 · 结构操作的变更原因与“受影响节点”未说明（建议）

- **事实。** 架构要求“用户与 Agent 操作共用第 9 节的提交协议，记录来源、原因和受影响节点”（[架构](../../../docs/architecture/2026-11-11-project-development-architecture.md#用户搭建与拼接)）。现有面板的变更原因记录以 `draft.nodeId` 作为 `subjectNodeIds`（[panel-controller.ts](../../../packages/project-plugin/src/client/panel-controller.ts#L341-L363)）；移动的受影响节点可能包括移动子树根、原父级、目标父级与两侧兄弟，插入的新节点 ID 又由 Host 分配、回执不返回。本 change 没有说明结构操作是否沿用变更原因，以及 `subjectNodeIds` 取哪些节点。
- **建议。** 明确“沿用现有变更原因；移动以移动根（必要时加目标父级）为主体，插入以目标父级为主体；新节点 ID 不在客户端回执中，故不写入 subject”，或明确“结构操作不写变更原因，留待后续”。后者需要与架构的“记录原因”说明差异。

#### C2 · 措辞与覆盖建议（建议）

- [tasks](tasks.md#L28) 4.2 写“插入两份预设”，但 design 只提供一个「功能开发」预设，spec 也只要求“至少一个”。请改成“两次插入同一预设”，或明确第二个预设的内容与版本。
- [tasks](tasks.md#L30) 4.4 写“按矩阵单列真实 Agent 所需证据”，但 [T12](validation-matrix.md#L18) 只有 A＋H 一行，没有真实 Agent 的单独观察点。请把“真实 Agent 所需证据”落到 T12 的分句，或说明 T12 的 WorkRun 可以由 owner 探针建立、不要求真实 Agent。
- [design](design.md#L25) “预设键用于实例化映射，宿主会话、授权和历史验证沿用既有存储”把实例化映射与会话／授权／历史验证混在一句，读者无法判断哪些是新增私有状态、哪些是沿用。请拆成“预设键只在一次实例化内映射到新 ID；生成的 ID 与候选头记入既有持久意图；不新增会话或授权存储”。
- [spec](specs/project-tree-editing/spec.md#L90) 的“其他宿主语言回退英文”与 [T07](validation-matrix.md#L13) 的“不支持的正文语言”拒绝需要区分：前者是 UI 语言回退，后者应是请求正文语言不在预设可用集合时的拒绝。建议明确“客户端先按 UI 语言回退到预设可用语言再提交；Host 只接受预设声明的语言，其余拒绝”，并把 T14 的“当前语言”改成“当前可用语言”。

### 结论

**有条件放行。** 方向、范围切分、v1 数据复用、R1／R2 提交与准入复用、A／F／H 验收设计整体成立，编写校验已独立复跑通过；工件齐备、状态诚实、无预勾选或预填 review。

**提交前须处理 A1–A4：** v1 根规则与根级语义（A1／A2）、活动 WorkRun 在 owner 规划变化后的写资格（A3）、T13 的接续规划基线（A4）。这四项都会直接影响实现口径或验收可执行性，不能只作为措辞建议。**B1–B4 建议一并处理或明确记为后续：** Agent 结构能力的显式延期、一份草稿与语言预览的交互、有效回读失败态、预设 ID／版本与预览契约。**C1–C2 为措辞与覆盖建议。**

修订后请作者在 `review-response.md` 逐条记录依据与位置，重新运行 OpenSpec 严格校验、`node scripts/check-repo.mjs --all` 与 `pnpm check:ci`，并由原审阅者确认；涉及根语义、Agent 结构权限或 R2 接续格式的取舍若与审 2 冲突，交用户裁决。审 2 尚未给出，双审未齐前不得提交；审阅者不承担实施。

## 审 2 · Qoder Desktop Agent（QoderCN） · 2026-11-20

审阅者身份：本会话为 Qoder Desktop 侧独立 Agent，与 DSH 侧不同模型，未参与该 change 的编写。change 内未声明作者；[交接](2026-11-20-author-handoff.md)表明由 DSH 会话编写。开始审阅时本文件已存在审 1 节；本节每项问题均由本会话独立对源码、协议向量与主 specs 取证后给出，未以审 1 结论代替证据，不代填审 1 意见，也不代表审 1 确认。只读审阅，不实施；本节为审 2 唯一交付。

### 范围与方法

- 通读 [proposal](proposal.md)、[design](design.md)、[增量 spec](specs/project-tree-editing/spec.md)、[tasks](tasks.md)、[validation-matrix](validation-matrix.md)、[author-handoff](2026-11-20-author-handoff.md)，以及 `AGENTS.md`／`openspec/changes/README.md` 的索引改动（git diff 核对）。
- 对照主 specs：[project-command-commit](../../specs/project-command-commit/spec.md)、[project-panel-sync](../../specs/project-panel-sync/spec.md)、[project-overview-resume](../../specs/project-overview-resume/spec.md)。
- 对照源码（均本会话逐行读取）：[validate.ts](../../../packages/project-plugin/src/domain/validate.ts#L168-L216)、[transforms.ts](../../../packages/project-plugin/src/domain/transforms.ts#L14)、[resume.ts](../../../packages/project-plugin/src/domain/resume.ts#L10-L55)、[work.ts](../../../packages/project-plugin/src/application/work.ts#L529-L816)（captureBinding／authorizeAgentCommand／afterPlanCommit／continueScope／commandAction）、[command-service.ts](../../../packages/project-plugin/src/application/command-service.ts#L255-L287)（requestDigest／execute 准入／noBusinessChange／allocateIds／replay／afterPlanCommit 调用点）、[local-state.ts](../../../packages/project-plugin/src/application/local-state.ts#L84-L92)、[overview-service.ts](../../../packages/project-plugin/src/host/overview-service.ts#L229-L277)、[project-tools.ts](../../../packages/project-plugin/src/host/project-tools.ts#L164)、[panel-controller.ts](../../../packages/project-plugin/src/client/panel-controller.ts#L24-L37)（PanelDraft／save／reloadQuietly／appendReason）、[v1 schema](../../../packages/project-plugin/formats/v1/project-v1.schema.json)、[plan-vectors.json](../../../packages/project-plugin/formats/v1/plan-vectors.json)（脚本解析 plan-zh-base）、[tool-protocol.md](../../../packages/project-plugin/docs/tool-protocol.md#L21)。
- 对照文档：[工作流](../../../docs/development/workflow.md)、[产品设计](../../../docs/product/2026-11-11-project-management-design.md#动态项目树)、[架构](../../../docs/architecture/2026-11-11-project-development-architecture.md#用户搭建与拼接)、[路线图](../../../docs/engineering/2026-11-12-plugin-development-roadmap.md)。
- 只做静态与自动测试核对，未启动真实 DSH 宿主；14 个产品场景仍全部 `untested`，不把 CI 通过当作产品通过。

### 复跑校验

| 命令 | 环境与实际结果 |
|---|---|
| `openspec validate add-project-tree-editing-and-composition --type change --strict --no-interactive --json` | OpenSpec 1.17.0（`~/Developer/tools/openspec` 独立安装）：`valid: true`，1 项通过、0 失败、`issues: []` |
| `node scripts/check-repo.mjs --all` | 暂存 change 目录与两个索引改动后运行（门禁经 `checkout-index` 读索引；运行后取消暂存恢复原状）：洁净度失败 0／警告 0，自测 32 项通过；链接门禁 128 篇 0 问题；双语门禁 5 对 0 问题 |
| `pnpm check:ci` | 宿主自带 Node `24.21.0`（`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node`）与 pnpm `12.18.0`（同包 `dependencies/pnpm`），经临时 PATH shim 调用；build、typecheck、305/305 测试、包边界、协议同步、locale、manifest 全部通过，exit 0 |

本会话 shell 默认 Node 为 v26.13.0 且无全局 pnpm／openspec；以上命令均改用与 CI 固定版本一致的宿主二进制与独立 OpenSpec 1.17.0，交接中的三项结果独立复现。追加本节后再暂存复跑 check-repo 覆盖最终 review.md（链接 0 问题），随后取消全部暂存；审阅前后工作区内容不变、无遗留暂存。CI 只验证现有代码，不验证本 change 的未来实现。

### 确认通过项

1. **工件齐备、状态诚实。** 6 项需求、14 个场景与 T01–T14 逐一对应；17 项 tasks 均未勾选，14 项矩阵均为 `untested`；无作者预填 review（审 1 节为外部审阅记录）、无预勾选；计数与交接一致。索引改动正确：AGENTS.md 活动 change 指向本目录，README 新增行状态“待独立双审”。
2. **范围切分与 R2 路线图一致。** 同级重排、子树移动、内置流程插入为本切片；用户模板、分组、合并、复制、撤销／重做、文件骨架明确留后续，未把产品设计的“搭积木”扩大为一次交付全部交互。
3. **v1 字段复用与无变化回执语义成立。** 移动只改 `parentId`／`order`，节点 ID、记录与聊天引用不变；现有 [noBusinessChange 判定](../../../packages/project-plugin/src/application/command-service.ts#L727-L729)（候选指纹等于基线 → impact `state`、规划修订不推进）支持 design 的“原位动作保持原值”；同级 order 从 0 连续按父分组（含 `null` 根组）校验（[validate.ts](../../../packages/project-plugin/src/domain/validate.ts#L200-L216)）。
4. **提交与恢复机制复用成立。** [requestDigest](../../../packages/project-plugin/src/application/command-service.ts#L255-L265) 覆盖命令与输入基线、不含 operationId；[replay](../../../packages/project-plugin/src/application/command-service.ts#L593-L608) 同号换参数拒绝、原号返回原结果；[allocateIds](../../../packages/project-plugin/src/application/command-service.ts#L1023-L1028) 在意图中固定新 ID，支持插入重试同一批节点。tasks 2.2／2.3 的验证点落在这些机制上。
5. **owner／实例准入与 Agent 不扩权方向成立。** `conaOverview` 的 deny／requireId／resolveInstance 保护读取与写入；[remote-owner 路径不走工作绑定](../../../packages/project-plugin/src/application/command-service.ts#L276-L283)，两条入口判据独立；[PLANNING_TYPES](../../../packages/project-plugin/src/host/project-tools.ts#L164) 仍只允许原五类命令，[commandAction](../../../packages/project-plugin/src/application/work.ts#L187-L202) 无新命令动作映射，新增命令不会自动成为 Agent 工具。
6. **验收分层清楚。** A／F／H 分层、矩阵 `pass` 门槛与运行记录要求延续 R1／R2 做法；未把静态校验或替身当宿主实测。

### 问题

| ID | 级别 | 摘要 |
|---|---|---|
| 2-A1 | 必改 | design／spec 把“v1 要求单根”当作事实，与校验器、协议向量和 schema 不符 |
| 2-A2 | 必改 | “项目根”未定义；根级同级重排、根集合变更（含非根移成新根）均无口径 |
| 2-A3 | 必改 | owner 结构提交后，活动 WorkRun 没有“接受当前基线”的实现路径，且与架构“单纯重排不停止工作”存在张力 |
| 2-A4 | 必改 | T13／spec 的“提示规划基线已变”无数据来源；主 spec 该 MUST 在 R2 首切片尚未实现 |
| 2-B1 | 应改 | Agent 结构能力收窄为 owner-only，未写明是本切片显式延期 |
| 2-B2 | 应改 | 一份草稿模型与“显式保留原草稿”“当前语言新开预览”未对齐 |
| 2-B3 | 应改 | “成功展示以有效回读为依据”与现有 `save()` 行为不一致，回读失败态未定义 |
| 2-B4 | 应改 | 预设 ID／版本类型、可用语言集合、预览读取契约与“已不可用版本”语义未定义 |
| 2-C1 | 建议 | 结构操作的变更原因主体未说明；回执不返回新节点 ID，插入主体需另定 |
| 2-C2 | 建议 | tasks 4.2“两份预设”、4.4“真实 Agent 证据”、design 预设键句需澄清 |

#### 2-A1 · v1 根规则写错（须处理）

- **事实。** [design](design.md#L5) 写“v1 要求单根”，[spec](specs/project-tree-editing/spec.md#L24) 写“发布结果 MUST 符合 v1 单根……”。本会话核对：[validate.ts](../../../packages/project-plugin/src/domain/validate.ts#L182-L186) 仅在 `rootIds.length === 0` 时报 `root-count`，183 行注释明确“协议向量（plan-zh-base）确认 v1 允许多根森林”；[transforms.ts](../../../packages/project-plugin/src/domain/transforms.ts#L14) 同；脚本解析 [plan-vectors.json](../../../packages/project-plugin/formats/v1/plan-vectors.json) 的 `plan-zh-base` 正向向量含三个 `parentId: null`、`order` 0／1／2 的根（阶段1／2／3）；[v1 schema](../../../packages/project-plugin/formats/v1/project-v1.schema.json) 的 `plan.nodes` 仅为数组，无任何根数约束。另 [validate.ts](../../../packages/project-plugin/src/domain/validate.ts#L168) 行注释仍写“单根”，与 183 行自相矛盾，实现时易被继承。
- **影响。** 按此验收会把合法多根 v1 资料判为不合规，或引发不必要的“单根化”迁移；T01／T04／T05 夹具（“根的空阶段”等）全部默认单根，多根输入无覆盖。
- **要求。** 改写为 v1 实际规则：至少一个根、每个父节点（含 `null` 根组）下同级 `order` 从 0 连续、父子无环、依赖两端存在且无环。若产品要“单项目根”，写成独立产品约束并说明多根 v1 文件的进入方式（拒绝／先归并／保留森林并限制操作）；T01／T05 增加多根夹具，或明确声明多根输入不在本切片验收范围。顺手修正 validate.ts:168 的过时注释可列为实施任务。

#### 2-A2 · 根语义与根集合变更未定义（须处理）

- **事实。** [spec Req 1](specs/project-tree-editing/spec.md#L5) 无条件承诺“同级重排”，[Req 2](specs/project-tree-editing/spec.md#L24) 把移动输入限定为“现有非根节点”，[Req 2 反例](specs/project-tree-editing/spec.md#L33) 又拒绝“移动项目根”；[design](design.md#L17) 写“活动项目根可作为目标父节点，根自身只能留在根位置”。在 v1 允许多根的前提下，“项目根”指全部 `parentId: null` 节点还是第一个根未定义；根与根之间的重排是否属于被承诺又被禁止的“同级重排”无法判定。此外 design 的位置模型以 `parentId` 表示目标父节点，但**目标父节点能否为 `null`（把非根移成新根）未定义**，[design 拒绝清单](design.md#L19) 也未列此项——这会改变根集合，与“单根”产品假设直接相关。
- **影响。** 实现者无法确定 T01／T05 夹具与拒绝码；多根资料能否重排、非根能否提升为根，两种读法都成立，验收结论会分叉。
- **要求。** 明确“根节点 = `parentId` 为 `null` 的节点”，并二选一：(a) 支持根级同级重排（目标父节点可为 `null` 且仅改根组 `order`），Req 2 输入改为“任意现有节点”，单独拒绝根移到非 `null` 父级、非根移成新根等改变根集合的移动；(b) 明确根级操作不在本切片，Req 1 限定为非根同级，并说明多根文件进入时的行为。无论哪种，design、Req 1／2、tasks 1.1、T01／T05 同一口径，并把“非根→新根”明确列入允许或拒绝。

#### 2-A3 · 活动 WorkRun 在 owner 结构提交后无续权路径（须处理）

- **事实。** [spec](specs/project-tree-editing/spec.md#L62) 写“继续写入须按已有规则取得接受当前基线的绑定”，[design](design.md#L33)、[tasks 2.4](tasks.md#L16)／[4.4](tasks.md#L30)、T12 同。本会话核对：[authorizeAgentCommand](../../../packages/project-plugin/src/application/work.ts#L634-L644) 要求命令基线与 `run.acceptedBaseline` 严格相等，否则 `binding-expired`；[afterPlanCommit](../../../packages/project-plugin/src/application/work.ts#L652-L672) 只推进**该运行自己**提交后的基线，且[调用点仅在 `ctx.kind === 'agent-work'`](../../../packages/project-plugin/src/application/command-service.ts#L913-L923)——owner（remote-owner）提交不触发任何运行的基线推进；[captureBinding](../../../packages/project-plugin/src/application/work.ts#L561-L574) 只读旧值；[continueScope](../../../packages/project-plugin/src/application/work.ts#L790-L798) 只增目标、bump 绑定版本，不更新 `acceptedBaseline`；现有测试“同会话已有活动绑定时另一消息消费：意图保留待执行（deferred）”确认不能并行开新运行。因此 owner 移动／插入后，活动运行内 Agent 即使 `project_read` 拿到新基线，写入仍被拒，运行内不存在“接受当前基线”的入口。[tool-protocol.md](../../../packages/project-plugin/docs/tool-protocol.md#L21) 称 `project_read` 用于“取得后续写入所需的明确最新基线”，在 owner 外部提交后误导。另 [架构](../../../docs/architecture/2026-11-11-project-development-architecture.md#L167) 明确“单纯重排不停止工作”，[产品设计](../../../docs/product/2026-11-11-project-management-design.md#L185) 要求按影响选择“继续／追加说明／等待边界／停止重派”；严格基线相等使 owner 重排事实上停止活动运行的写入，与该意图存在张力。
- **影响。** T12“按原准入显式取得适用资格”、tasks 2.4“显式取得当前写资格仍走既有准入”、4.4“显式续权”均无法按字面执行；现有唯一可行路径是运行结束后由新的可信边界重建绑定。
- **要求。** 二选一并落到 design／spec／tasks：(a) 新增 owner 专用“接受当前基线”机制（targets／allowedActions 不变，仅更新 acceptedBaseline 与绑定版本），补任务与测试；(b) 明确 owner 规划变化后活动运行写入资格停止、运行内不续权，继续写入须等新运行重建绑定，把 T12／2.4／4.4 改成该可验收步骤。若选 (b)，须说明与架构“单纯重排不停止工作”的差异处理（如按变更影响调用既有工作接续规则、提示用户），不能只写“按现有基线规则”。同时修正 tool-protocol 的“最新基线即可写入”表述。

#### 2-A4 · T13 的“规划基线已变”缺少数据与实现（须处理）

- **事实。** [spec](specs/project-tree-editing/spec.md#L86) 要求“接续卡片按既有规则保留历史结果并提示规划基线已变”，T13 要求“卡片显示原有验证状态及规划待核对原因”。本会话核对：[ResumePayload](../../../packages/project-plugin/src/domain/resume.ts#L37-L55) 只有停点、下一步、成果、决定、未解决问题与历史验证引用，无 `planVersion`／规划基线字段；[模块头注释](../../../packages/project-plugin/src/domain/resume.ts#L10) 明确“严格校验拒绝未知字段”，新增字段涉及正文版本与旧记录兼容；[resumeCandidate](../../../packages/project-plugin/src/host/overview-service.ts#L268-L276) 返回 `payload + codeObservation + chat`，无规划基线对比。主 spec [project-overview-resume](../../specs/project-overview-resume/spec.md#L57) 已 MUST“规划……基线变化……提示待核对”，但 R2 首切片归档时 O08 仍 `untested`、实际只交付代码观察——该能力是**规范已要求、代码未实现**，不是“既有规则”。
- **影响。** T13 的规划基线观察点无法由现有数据产生；写成“既有规则”会让执行者误以为能力已存在，或用不可复现的观察点交差。
- **要求。** 二选一：(a) 本 change 增加任务：在接续记录保存可移植规划基线（处理正文版本兼容、旧记录无基线、解析失败），读取时与当前快照比较给出“规划已变”待核对，并补 T13 验证；(b) 从 spec／T13 删除规划基线提示，把 T13 限定为“历史验证状态 + 当前代码观察／未核对”，明确规划基线核对仍属 R2 O08 未测项、本切片不宣称覆盖——注意 (b) 不消除主 spec 的 MUST，只是不在本切片验收。无论哪种，tasks 4.5 与 spec／T13 同步修改。

#### 2-B1 · Agent 结构能力收窄未写明延期（建议处理）

- **事实。** [产品设计](../../../docs/product/2026-11-11-project-management-design.md#L179) 写“Agent 可提出或执行新增、拆分、重排、合并、替换、取消与重新打开节点”，[架构](../../../docs/architecture/2026-11-11-project-development-architecture.md#L165) 把拖放／插入放在用户与 Agent 共用提交协议中。本 change [proposal](proposal.md#L14)／[spec](specs/project-tree-editing/spec.md#L52) 限定 owner 发起；[PLANNING_TYPES](../../../packages/project-plugin/src/host/project-tools.ts#L164) 仍五类、[commandAction](../../../packages/project-plugin/src/application/work.ts#L187-L202) 无新命令映射。
- **影响。** “现有 Agent 在原有动作和目标授权内继续使用既有工具”只传达了一半信息：Agent 不能用新命令，但这是有意安全取舍还是无意收窄、后续何时开放，读者无法判断。
- **要求。** 在 proposal“后续范围”或 design Non-Goals 明确“本切片仅开放 owner 入口；Agent 发起的移动／插入留待后续（原因：……）”，并说明 Agent 现有新增／拆分／改状态不受影响。若本切片即支持 Agent，则补动作映射、目标范围、根级限制、绑定与测试。

#### 2-B2 · 一份草稿与语言切换预览未对齐（建议处理）

- **事实。** [PanelDraft](../../../packages/project-plugin/src/client/panel-controller.ts#L24) 注释“同一时间只保留一份，避免合并冲突”，kind 仅 `update-goal`／`add-node`。[design](design.md#L32) 写“开始另一编辑时显式保留原草稿或先由用户处理原草稿”——“显式保留”可被读成同时保留内容与结构两份草稿；[spec](specs/project-tree-editing/spec.md#L20) 则写“提示用户处理已有节点内容草稿后再开始另一编辑”。[design](design.md#L39) 写“用当前语言重新选择模板即可创建新的预览”，[spec](specs/project-tree-editing/spec.md#L94-L95) 写“再保存原预览并新开一个预设预览”“新预览可使用当前可用语言”；预设正文仅中英（[design](design.md#L24)），第三种宿主语言下“当前语言”不可用。
- **影响。** T03／T14 存在两种执行方式，结论不同；结构草稿需要新的 draft kind，与一份草稿模型的关系必须写明。
- **要求。** 统一为“同一时间一份草稿；已有内容草稿时先保存或放弃，再开始结构编辑”；T14 步骤写成“先保存（或明确放弃）中文预览，再切换语言、以当前可用语言重新选择模板创建新预览”；design 的“当前语言”改为“当前可用语言”。若允许多份结构预览，则补面板模型与对照测试。

#### 2-B3 · 成功展示与回读失败态（建议处理）

- **事实。** [spec](specs/project-tree-editing/spec.md#L66) 要求“成功展示 MUST 以已确认回执及有效回读为依据”。现有 [save()](../../../packages/project-plugin/src/client/panel-controller.ts#L354-L356) 在提交后调用 `reloadQuietly`，无论回读成功与否都标 `saved`；[reloadQuietly](../../../packages/project-plugin/src/client/panel-controller.ts#L463-L470) 失败只 `markOffline`，界面可能仍是旧树。tasks 3.3 已写“成功状态依赖有效回读”，但 design／spec 未定义回读失败时的可见状态。
- **影响。** 结构保存可能显示“已保存”而树未更新，违反本 spec 成功条件；只改结构保存会使节点编辑与结构保存验收口径分叉。
- **要求。** 定义“回执已确认、回读失败／未同步”的状态（如 `saved-unverified`／`pending-read`，提供重试，不显示普通 `saved`），说明本 change 是否同时修正既有保存路径，并把该状态加入 T09／T10 或 tasks 3.3 观察点；若本次不修正，收窄 spec 成功条件并如实标注剩余风险。

#### 2-B4 · 预设契约未定义（建议处理）

- **事实。** [design](design.md#L24-L25) 只写“稳定 ID 和不可变版本”；ID／版本类型、版本比较、可用语言集合、预览读取的 Remote 方法与载荷形状、预设随包文件位置均未定义；[spec](specs/project-tree-editing/spec.md#L38) 的“已不可用版本”缺少可用性语义（是否仅当前包所带版本可用？升级后旧版本如何处理？）。tasks 2.1“预设读取”、3.2“接入预设列表”无可核验契约。[design](design.md#L26) 已写恢复不依赖重启后安装的预设内容，方向正确但未与版本可用性衔接。
- **影响。** 客户端／Host 契约、`requestDigest` 稳定值、未知／不可用版本的拒绝码都要实现时临时决定，预览与提交版本可能不一致。
- **要求。** design 给出最小契约：预设 ID 类型（如稳定字符串）、版本类型与比较（如正整数）、可用语言集合、预览载荷（层级／标题／目标／完成条件／依赖／来源）、读取入口的 owner／实例校验、版本可用性定义，以及这些值如何进入命令与摘要；tasks 把“预览读取入口”与“版本校验”落到 2.1 或 3.2 的可核验项。

#### 2-C1 · 结构操作的变更原因主体（建议）

- **事实。** [架构](../../../docs/architecture/2026-11-11-project-development-architecture.md#L165) 要求共用提交协议“记录来源、原因和受影响节点”。现有面板以 `[draft.nodeId]` 作为 `subjectNodeIds`（[panel-controller.ts](../../../packages/project-plugin/src/client/panel-controller.ts#L341-L342)）；移动的受影响节点含移动根、原／目标父级及两侧兄弟；插入的新节点 ID 由 Host 分配，且 [OperationResultSnapshot](../../../packages/project-plugin/src/application/local-state.ts#L84-L92) 不返回 nodeIds，客户端无法从回执取得插入主体。
- **建议。** 明确“沿用变更原因；移动以移动根（必要时加目标父级）为主体，插入以目标父级为主体；新节点 ID 不在回执中，不写入 subject”，或明确结构操作暂不写原因并说明与架构的差异。

#### 2-C2 · 措辞与覆盖（建议）

- [tasks 4.2](tasks.md#L28)“插入两份预设”与 design 只有一个「功能开发」预设、T06“相同版本再插一次”不符，改为“两次插入同一预设”，或定义第二个预设。
- [tasks 4.4](tasks.md#L30)“按矩阵单列真实 Agent 所需证据”，但 T12 只有 A＋H 一行、无真实 Agent 分句；把该证据落到 T12 分句，或说明 T12 的 WorkRun 可由 owner 探针建立、不要求真实 Agent。
- [design](design.md#L25)“预设键用于实例化映射，宿主会话、授权和历史验证沿用既有存储”把新增私有状态与沿用存储混在一句，建议拆为“预设键只在一次实例化内映射到新 ID；生成的 ID 与候选头记入既有持久意图；不新增会话或授权存储”。

### 结论

**有条件放行。** 方向、范围切分、v1 字段复用、R1／R2 提交与准入复用、A／F／H 验收设计整体成立；编写校验三项均独立复现；工件齐备、状态诚实、无预勾选。

**提交前须处理 2-A1–2-A4：** v1 根规则与根语义（含非根→新根）、owner 结构提交后活动 WorkRun 的写资格路径、T13 接续规划基线的数据来源。这四项直接决定实现口径与验收可执行性。**2-B1–2-B4 建议一并处理或明确记为后续：** Agent 结构能力显式延期、一份草稿与语言预览、回读失败态、预设契约。**2-C1–2-C2 为措辞与覆盖建议。**

本会话与审 1 的问题方向高度重合，系对同一批工件独立取证的收敛结果；本节补充了根集合变更（非根→新根）、架构“单纯重排不停止工作”的张力、预设版本可用性语义与回执不含 nodeIds 的证据，未发现与审 1 结论冲突之处。作者修订后请在 `review-response.md` 逐条记录依据与位置（两份 review 的问题可合并回应，但须分别指明对应 ID），重新运行三项校验，由两位原审阅者分别确认；涉及根语义、Agent 结构权限或接续格式取舍的冲突交用户裁决。双审意见已齐但均为有条件放行，作者修订并经确认前不得提交；审阅者不承担实施。

---

## 审 1 · DSH · 2026-11-20 · 复审（第 2 轮）

### 复审范围

- 作者身份以 [审阅处理](review-response.md#L3) 与更新后的[交接](2026-11-20-author-handoff.md#L3) 为准：**Codex 会话**；本会话为 DSH 独立模型，未参与编写。首轮“同模型独立上下文”的保守标注已在上一节更正。
- 通读修订后的 [proposal](proposal.md)、[design](design.md)、[增量 spec](specs/project-tree-editing/spec.md)、[tasks](tasks.md)、[validation-matrix](validation-matrix.md)、[author-handoff](2026-11-20-author-handoff.md)、[review-response](review-response.md) 及 [tool-protocol](../../../packages/project-plugin/docs/tool-protocol.md#L21) 的 diff；逐条核对审 1 的 A1–A4／B1–B4／C1–C2 与审 2 的 2-A1–2-A4／2-B1–2-B4／2-C1–2-C2 是否按同一口径收敛。
- 只做静态与自动测试核对，未启动真实 DSH 宿主；14 个产品场景仍全部 `untested`，不把 CI 当产品验证。

### 复跑校验

| 命令 | 环境与实际结果 |
|---|---|
| `openspec validate add-project-tree-editing-and-composition --type change --strict --no-interactive --json` | OpenSpec 1.17.0、Node 24.21.0：`valid: true`，1 项通过、0 失败 |
| `node scripts/check-repo.mjs --all` | 暂存 change、两个索引与 `tool-protocol.md` 后运行：286 个待查文件；洁净度失败 0／警告 0；链接 129 篇 0 问题；双语 5 对 0 问题 |
| `pnpm check:ci` | Node 24.21.0、pnpm 12.18.0：build、typecheck、305/305 测试、包边界、协议同步、locale、manifest 全部通过，exit 0 |

作者交接的三项结果均独立复现；CI 只验证现有代码，不验证本 change 的未来实现。

### 逐项确认

| ID | 状态 | 复核依据 |
|---|---|---|
| A1／2-A1 | 已处理 | [design](design.md#L5) 改为“v1 支持一个或多个根”，[spec](specs/project-tree-editing/spec.md#L24) 改为“至少一个根、各同级组 order 连续、父子无环、依赖端点有效且无环”；[tasks 1.1](tasks.md#L7) 明确多根夹具并校正 v1 校验注释；[T01](validation-matrix.md#L7)／[T04](validation-matrix.md#L10)／[T05](validation-matrix.md#L11) 使用多根资料。与 `plan-zh-base` 及 [validate.ts](../../../packages/project-plugin/src/domain/validate.ts#L182-L186) 的实际行为一致。 |
| A2／2-A2 | 已处理 | [design](design.md#L17-L19) 定义根组（`parentId: null`）可在组内重排；根降子、非根升根、缺失节点、错误组锚点、自身锚点均拒绝；[spec](specs/project-tree-editing/spec.md#L24) 与 [T01](validation-matrix.md#L7)／[T05](validation-matrix.md#L11) 同口径；非根目标父节点为现有节点，插入不新建根。 |
| A3／2-A3 | 已处理 | [design](design.md#L38-L40) 选择“运行继续、写入等旧运行结束后的新运行”；[spec](specs/project-tree-editing/spec.md#L52) 与 [T12](validation-matrix.md#L18) 分别核对旧运行两条拒绝路径（旧基线冲突、最新快照基线仍被绑定拒绝）和新运行按当前规划重新绑定；[tasks 2.4](tasks.md#L16)／[4.4](tasks.md#L30) 与 [tool-protocol](../../../packages/project-plugin/docs/tool-protocol.md#L21) 同步。原“已有规则接受当前基线”的不可执行表述已删除。 |
| A4／2-A4 | 已处理 | [spec](specs/project-tree-editing/spec.md#L86) 与 [T13](validation-matrix.md#L19) 改为历史验证状态 + 当前代码观察／未核对原因；[design](design.md#L60) 明确规划基线保存／对比仍属 R2 首切片 O08 未完成部分、主规范要求保留；不再宣称本切片覆盖规划基线提示。 |
| B1／2-B1 | 已处理 | [proposal 后续范围](proposal.md#L33) 明确 Agent 发起的移动／插入延期并说明后续授权范围；[design](design.md#L11) 同；Agent 现有新增、拆分、状态工具不变。 |
| B2／2-B2 | 已处理 | [design](design.md#L34) 明确每实例一份草稿、先保存核对或放弃再开始另一份；[design](design.md#L50) 明确原预览保存／放弃后用当前可用语言新建、第三种语言用 `en`；[spec](specs/project-tree-editing/spec.md#L20) 与 [T03](validation-matrix.md#L9)／[T14](validation-matrix.md#L20)、[tasks 3.4](tasks.md#L23)／[4.2](tasks.md#L28) 对齐。 |
| B3／2-B3 | 已处理 | [design](design.md#L35) 定义“已提交，待同步”、同源有效回读条件（项目／实例／源代际／修订覆盖／同修订指纹）和仅重读；[spec](specs/project-tree-editing/spec.md#L66) 与 [T10](validation-matrix.md#L16)、[tasks 3.3](tasks.md#L22)／[4.3](tasks.md#L29) 覆盖结构操作与既有节点编辑两条保存路径。 |
| B4／2-B4 | 已处理 | [design](design.md#L24-L28) 给出 `feature-development`、正整数版本、`zh-CN`／`en`、`treePresets` 两入口、预览字段、四个模板错误码、请求摘要和升级后恢复；[spec](specs/project-tree-editing/spec.md#L38)、[T07](validation-matrix.md#L13)／[T11](validation-matrix.md#L17)、[tasks 2.1](tasks.md#L13)／[2.3](tasks.md#L15) 对应。 |
| C1／2-C1 | 已处理 | [design](design.md#L42-L44) 明确移动／重排以移动节点、插入以目标父节点为原因主体，原因独立操作号、部分成功和单独重试；[spec](specs/project-tree-editing/spec.md#L66)、[T10](validation-matrix.md#L16)、[tasks 3.3](tasks.md#L22) 对应。 |
| C2／2-C2 | 已处理 | [tasks 4.2](tasks.md#L28) 改为“两次插入同一预设”；[T12](validation-matrix.md#L18)／[tasks 4.4](tasks.md#L30) 有真实 Agent 分句和缺凭证 blocked；[design](design.md#L27) 拆开实例化键／持久意图／既有存储；[spec](specs/project-tree-editing/spec.md#L90) 与 [T14](validation-matrix.md#L20) 区分 UI 回退与正文语言。 |

### 本轮剩余问题

**R1（须补，验收观察点）· 活动工作提示未落到矩阵／T12。** [spec](specs/project-tree-editing/spec.md#L52) 要求“对实际推进规划基线的结构操作，面板 MUST 提示如果有活动工作，规划写入需在原运行结束后……”。[tasks 3.1](tasks.md#L20) 有“提示规划变化对当前工作后续写入的影响”，但其“对应”只列 T01／T02／T04／T05；[T12](validation-matrix.md#L18) 的 A＋H 观察点只记目标／状态／范围／基线和读写拒绝，[tasks 4.4](tasks.md#L30) 也只记原目标／绑定／状态／读写结果。该 MUST 目前没有矩阵观察点。建议在 T12 或 T02 的 H 观察点加“面板显示有活动工作时写入需等旧运行结束、从当前规划起新运行”，并把 3.1／4.4 的对应关系补上；这是验收完整性，不改变设计。

**R2（须补，显示观察点）· 预设来源未落到 UI 任务／T06。** [spec](specs/project-tree-editing/spec.md#L38) 要求预览“展示其来源、准确版本……”并提供“可用正文语言”。[tasks 3.2](tasks.md#L21) 目前只写“显示版本、层级、目标、完成条件和内部依赖”，没有“来源 `builtin`”；[T06](validation-matrix.md#L12) 也只核对层级／正文／内部依赖。[tasks 2.1](tasks.md#L13) 已核对 `treePresets` 载荷与可用语言，但 UI 显示来源仍无观察点。建议在 3.2 与 T06／T07 补“来源 builtin、可用正文语言（或语言选择）”；同样不改变设计。

**R3（须改，文案）· 提案第 3 行语序。** [proposal](proposal.md#L3) 现为“……待两位审阅者复审。 [审阅处理](review-response.md)属于 R2 的第二个产品切片。”链接插在“属于”前，读成“审阅处理属于 R2 第二个切片”。建议改为“本 change 属于 R2 的第二个产品切片；[审阅处理](review-response.md)。……”或把链接移到句末。属微小修，不影响技术结论。

**R4（建议）· 提案 Impact 补一句既有节点编辑回读对齐。** [spec](specs/project-tree-editing/spec.md#L66) 与 [design](design.md#L35) 把回读判据扩到既有节点编辑；[review-response](review-response.md#L13) 也说明两种保存路径。提案 [What Changes](proposal.md#L12)／[Impact](proposal.md#L28) 目前只泛写回读未同步，建议补“同时把既有节点编辑的已保存判据对齐为同源有效回读”，避免读者以为只影响树操作。属范围透明，不改变能力。

**R5（建议）· 活动工作提示是通用文案还是条件显示。** [design](design.md#L40) 说“若有活动工作”；面板快照只有历史 `workRunCount`，没有活动运行状态；`workList` 是既有 owner Remote，但不在 [PanelTransport](../../../packages/project-plugin/src/client/api.ts#L41-L54) 的现有接口里。若提示是固定文案，建议写明“通用提示”；若要条件显示，在 3.1／3.3 补活动运行查询（`workList`／等价字段）与观察点。否则 R1 的提示在 H 层可能只验证到静态文案。

**R6（建议）· 无效目标位置的错误码。** [design](design.md#L26) 只列 `template-not-found`／`template-version-unavailable`／`template-locale-unsupported`／`template-invalid`；[spec](specs/project-tree-editing/spec.md#L47) 与 [T07](validation-matrix.md#L13) 还要核对“无效目标位置”的错误码。建议补一句“位置错误沿用既有结构校验错误码（如 parent-not-found／invalid-anchor）”，或在 design 列出新码；否则 T07 的“错误码”观察点不完整。

**R7（建议）· 交接的 check-repo 范围漏了工具协议改动。** [handoff](2026-11-20-author-handoff.md#L17-L18) 写“包含新增文件及两个索引改动”，未提 `packages/project-plugin/docs/tool-protocol.md`；[review-response](review-response.md#L25) 已写“工具协议改动”。建议交接同步，避免复审按旧范围误判。

**R8（建议）· 任务 1.1 的“根规则注释”指两处。** [validate.ts](../../../packages/project-plugin/src/domain/validate.ts#L5) 与[同文件](../../../packages/project-plugin/src/domain/validate.ts#L168) 都写“单根”，[tasks 1.1](tasks.md#L7) 只说“根规则注释”。建议写“校正两处（文件头与结构校验）注释”，避免只改一处。

**R9（可选）· `project_read` 的 binding 输出没有已接受基线。** [tool-protocol](../../../packages/project-plugin/docs/tool-protocol.md#L21) 已正确说明写入需与运行已接受基线一致，但 `ProjectReadOutput.binding` 只含 workRunId／bindingVersion／turn／targets／allowedActions；Agent 在 owner 改变规划后只能凭记忆知道旧基线。建议后续把 `acceptedBaseline` 加入 read 输出或 `binding-expired` 详情；不影响本切片验收，但能减少重复拒绝。

**R10（可选）· 插入不新建根的口径。** [design](design.md#L17) 要求插入目标为现有父节点；[spec](specs/project-tree-editing/spec.md#L38) 同。提案 [What Changes](proposal.md#L11) 的“插入所选位置”容易被读成可在根组插入。建议在 proposal／design 明写“插入不新建根；根组插入留后续”，或说明根节点作为父节点即顶层插入。

### 结论

**有条件放行（技术结论通过）。** A1–A4、B1–B4、C1–C2 与审 2 的对应项均已按同一口径修订：v1 多根规则、根组重排与根集合边界、活动 WorkRun 的“运行继续／写入走新运行”、接续 O08 口径、Agent 延期、一份草稿、回读待同步、预设契约、原因主体和措辞均已落地。OpenSpec、check-repo 与 CI 独立复跑通过；14 个场景仍全部 `untested`，未把文档／CI 当产品验证。

**提交前须补 R1、R2 两处验收观察点，并修正 R3 的提案语序；R4–R10 为不阻塞提交的建议。** 两处观察点只是把已写的 design／spec MUST 落到 tasks／T12／T06，不需要改设计；修正后在 [review-response](review-response.md) 加第 2 轮回应并重跑三项校验即可。审 2 仍需独立确认其 2-A1–2-C2 的修订（本复审不代审 2）；双审确认前不得提交。审阅者不承担实施。

## 审 2 · Qoder Desktop Agent（QoderCN） · 2026-11-20 · 复审（第 2 轮）

### 复审范围

- 作者身份以 [review-response](review-response.md#L3) 与更新后的[交接](2026-11-20-author-handoff.md#L3) 为准：**Codex 会话**；首轮据交接推断为 DSH 编写，据此更正。本会话未参与编写与修订。
- 通读修订后的 [proposal](proposal.md)、[design](design.md)、[增量 spec](specs/project-tree-editing/spec.md)、[tasks](tasks.md)、[validation-matrix](validation-matrix.md)、[author-handoff](2026-11-20-author-handoff.md)、[review-response](review-response.md) 与 [tool-protocol](../../../packages/project-plugin/docs/tool-protocol.md#L21) 的 git diff；逐条独立核对 2-A1–2-C2 的修订是否落到可执行口径，并对新设计声明补充源码取证。
- 开始时本文件已存在审 1 复审节；本节结论由本会话独立取证给出，与审 1 复审的收敛或分歧均如实标注，不代审 1 确认。
- 只做静态与自动测试核对，未启动真实 DSH 宿主；14 个产品场景仍全部 `untested`，17 项 tasks 均未勾选，不把 CI 当产品验证。

### 复跑校验

| 命令 | 环境与实际结果 |
|---|---|
| `openspec validate add-project-tree-editing-and-composition --type change --strict --no-interactive --json` | OpenSpec 1.17.0：`valid: true`，1 项通过、0 失败、`issues: []` |
| `node scripts/check-repo.mjs --all` | 暂存 change 目录、两个索引与 `tool-protocol.md` 后运行（门禁读索引；运行后取消暂存）：286 个待查文件；洁净度失败 0／警告 0，自测 32 项通过；链接门禁 129 篇 0 问题；双语门禁 5 对 0 问题 |
| `pnpm check:ci` | 宿主自带 Node `24.21.0` 与 pnpm `12.18.0`（临时 PATH shim，与 CI 固定版本一致；本会话 shell 默认 Node v26.13.0）：build、typecheck、305/305 测试、包边界、协议同步、locale、manifest 全部通过，exit 0 |

作者回应中的三项结果独立复现。追加本节后再暂存复跑 check-repo 覆盖最终 review.md，随后取消全部暂存；审阅前后工作区内容不变。CI 只验证现有代码，不验证本 change 的未来实现。

### 逐项确认

| ID | 状态 | 复核依据 |
|---|---|---|
| 2-A1 | 已处理 | [design](design.md#L5) 改为“v1 支持一个或多个根”，[spec](specs/project-tree-editing/spec.md#L24) 改为至少一个根、各同级组（含根组）order 从 0 连续、父子无环、依赖端点有效且无环，与 [validate.ts](../../../packages/project-plugin/src/domain/validate.ts#L182-L216) 及 `plan-zh-base` 三根正向向量一致；[tasks 1.1](tasks.md#L7) 多根夹具并校正旧注释，T01／T04／T05 均用多根资料。 |
| 2-A2 | 已处理 | [design](design.md#L17-L19) 定义根组＝`parentId: null`，根只在根组内重排；根降子、非根升根、缺失节点、跨组锚点、自身锚点均拒绝；非根移动与插入的目标父节点为现有节点（插入不新建根）。[spec](specs/project-tree-editing/spec.md#L24)／[反例](specs/project-tree-editing/spec.md#L33)、T01／T05 同口径；首轮补充的“非根→新根”已明确拒绝。 |
| 2-A3 | 已处理 | [design 新节](design.md#L38-L40) 采用“运行继续执行和读取、写入等旧运行结束后从当前规划显式发起新运行”。本会话补充取证：[effectiveRun](../../../packages/project-plugin/src/application/work.ts#L1119-L1121) 只看 status＋bootGeneration，owner 提交不失效运行，读取路径（captureBinding／buildContext）不受影响；旧基线＝已接受基线时准入通过、在[提交重读](../../../packages/project-plugin/src/application/command-service.ts#L708-L718)处 `plan-conflict`，最新基线则在[准入](../../../packages/project-plugin/src/application/work.ts#L634-L644)处 `binding-expired`——两条拒绝路径的描述与代码顺序一致；`continueScope` 不更新基线。“单纯重排不发送停止指令”回应了架构“单纯重排不停止工作”的张力（运行不停、写入走新运行）。[spec](specs/project-tree-editing/spec.md#L52)／[场景](specs/project-tree-editing/spec.md#L61-L62)、T12（含真实 Agent 分句与缺凭证 blocked）、tasks 2.4／4.4、[tool-protocol](../../../packages/project-plugin/docs/tool-protocol.md#L21) 同步。 |
| 2-A4 | 已处理 | [spec](specs/project-tree-editing/spec.md#L86)／T13 改为历史验证状态＋当前代码观察或未核对原因；[design](design.md#L60) 明确规划基线保存／对比仍属 R2 首切片 O08 未完成部分、主规范 MUST 保留；tasks 4.5 同步。不再宣称“既有规则”已覆盖规划基线。 |
| 2-B1 | 已处理 | [proposal 后续范围](proposal.md#L33) 明确 Agent 移动／插入延期及后续授权需覆盖原位置、目标位置与新节点；[design](design.md#L11) 同；既有新增／拆分／状态工具准入不变。 |
| 2-B2 | 已处理 | [design](design.md#L34) 每实例一份草稿、先保存并完成核对或明确放弃再开始另一份；[design](design.md#L50) 原预览保存／放弃后以当前可用语言新建、第三种语言用 `en`；[spec](specs/project-tree-editing/spec.md#L20)／[T14 场景](specs/project-tree-editing/spec.md#L94-L95)、T03／T14、tasks 3.4／4.2 对齐。 |
| 2-B3 | 已处理 | [design](design.md#L35) 定义「已提交，待同步」、同源有效回读条件（项目／实例／源代际匹配、修订覆盖回执、同修订指纹相符）、仅重读不重提、换源回执为历史；[spec](specs/project-tree-editing/spec.md#L66) 明确覆盖结构操作与既有节点编辑两条保存路径；T10 对两条路径注入回读失败，tasks 3.3／4.3 对应。 |
| 2-B4 | 已处理 | [design](design.md#L24-L28) 给出 `feature-development`、正安全整数版本精确匹配、`treePresets` 两入口及 owner／实例核对、预览载荷字段、`zh-CN`／`en`、四个模板错误码、参数进入请求摘要、新操作仅限当前包版本、恢复不依赖升级后预设内容；tasks 2.1／2.3、T07／T11 落到可核验项。 |
| 2-C1 | 已处理 | [design](design.md#L42-L44) 移动／重排以移动节点、插入以目标父节点为原因主体；原因在结构确认且同源回读后以独立操作号保存，部分成功可辨、单独重试；[spec](specs/project-tree-editing/spec.md#L66)、T10、tasks 3.3 对应。 |
| 2-C2 | 已处理 | [tasks 4.2](tasks.md#L28)“两次插入同一预设”；T12／tasks 4.4 有真实 Agent 分句与 blocked 口径；[design](design.md#L27-L28) 拆开实例化键映射、持久意图与沿用的本机存储；[spec](specs/project-tree-editing/spec.md#L90) 区分 UI 回退与正文可用语言。 |

### 本轮剩余问题

以下均经本会话独立取证；与审 1 复审的 R1–R8 方向收敛（对应关系括注），无结论冲突。

**2-R1（须补，验收观察点）· 活动工作提示 MUST 无矩阵观察点。** [spec](specs/project-tree-editing/spec.md#L52) 要求面板对实际推进基线的结构操作 MUST 提示“有活动工作时规划写入需在原运行结束后从当前规划显式发起新运行”。[tasks 3.1](tasks.md#L20) 有该提示交付，但“对应”只列 T01／T02／T04／T05；[T12](validation-matrix.md#L18) 观察点只有目标／状态／范围／基线与读写拒绝，[tasks 4.4](tasks.md#L30) 同。建议在 T12（或 T02）H 观察点加“面板显示该提示”，并补 3.1／4.4 的对应关系。（＝审 1 R1）

**2-R2（须补，验收观察点）· 预设来源与可用语言未落到 UI 任务／T06。** [spec](specs/project-tree-editing/spec.md#L38) 要求预览展示来源、准确版本并提供可用正文语言；[tasks 3.2](tasks.md#L21) 只写版本／层级／目标／完成条件／内部依赖，无来源 `builtin` 与可用语言；[T06](validation-matrix.md#L12)／[T07](validation-matrix.md#L13) 亦无该观察点（2.1 只核对 Host 载荷）。建议补入 3.2 与 T06／T07。（＝审 1 R2）

**2-R3（须改，微小修）· 提案第 3 行语序。** [proposal](proposal.md#L3)“……待两位审阅者复审。 [审阅处理](review-response.md)属于 R2 的第二个产品切片。”读成“审阅处理属于 R2 第二切片”。把链接移到句末或重组句子。（＝审 1 R3）

**2-R4（建议）· 活动工作提示的数据路径未定义。** [PanelTransport](../../../packages/project-plugin/src/client/api.ts#L44-L54) 只有 status／snapshot／execute／follow，无活动运行查询；快照的 [workRunCount](../../../packages/project-plugin/src/application/snapshot.ts#L549) 计全部运行（含历史），不能判定“有活动工作”。若提示为通用静态文案，请在 design 写明；若要条件显示，在 3.1／3.3 补活动运行查询（`workList` 或快照等价字段）与观察点，否则 2-R1 的 H 层只能验到静态文案。（＝审 1 R5）

**2-R5（建议）· 无效目标位置的错误码。** [design](design.md#L26) 只列四个模板错误码；T07 还要核对“无效目标位置”的错误码。补一句“位置错误沿用既有结构校验错误码”或列出新码。（＝审 1 R6）

**2-R6（建议）· 交接的 check-repo 范围漏工具协议改动。** [handoff](2026-11-20-author-handoff.md#L18) 写“新增文件及两个索引改动”，未提 `tool-protocol.md`；review-response 已写。建议交接同步。（＝审 1 R7）

**2-R7（建议）· 旧注释有两处。** [validate.ts:5](../../../packages/project-plugin/src/domain/validate.ts#L5) 与 [validate.ts:168](../../../packages/project-plugin/src/domain/validate.ts#L168) 都写“单根”；[tasks 1.1](tasks.md#L7) 的“根规则注释”建议写明两处，避免只改一处。（＝审 1 R8）

**2-R8（建议）· 提案 Impact 补回读判据对齐的范围透明。** 2-B3 的修订把「已提交，待同步」判据扩到既有节点编辑保存路径，属行为变更；建议在 [proposal Impact](proposal.md#L28) 补一句，避免读者以为只影响树操作。（＝审 1 R4）

审 1 复审的 R9（read 输出补 acceptedBaseline）与 R10（提案明写插入不新建根）为可选项：design／spec 口径已清楚，本会话无异议，不阻塞本切片。

### 结论

**有条件放行（技术结论通过）。** 2-A1–2-A4／2-B1–2-B4／2-C1–2-C2 全部按可执行口径落实：v1 多根规则与根组边界、活动 WorkRun“运行继续／写入走新运行”（两条拒绝路径与代码一致）、接续 O08 口径、Agent 显式延期、一份草稿、回读待同步态、预设契约、原因主体与措辞均已修订并经源码取证；三项校验独立复跑通过；14 个场景仍全部 `untested`，状态诚实。

**提交前须补 2-R1、2-R2 两处验收观察点并修正 2-R3 语序；2-R4–2-R8 为不阻塞提交的建议。** 两处观察点只是把已写的 spec MUST 落到 tasks／矩阵，不改设计。作者请在 review-response 追加第 2 轮回应（分别对应两份复审的 ID）并重跑三项校验，由两位原审阅者分别确认后提交；双审确认前不得提交。本轮与审 1 复审无结论冲突，无需用户裁决。审阅者不承担实施。

---

## 审 1 · DSH · 2026-11-20 · 复核（第 3 轮）

### 复核范围

- 只核对第 2 轮审 1 的 R1–R10 与审 2 的 2-R1–2-R8 是否在最新稿中逐项落地；通读 [proposal](proposal.md)、[design](design.md)、[tasks](tasks.md)、[validation-matrix](validation-matrix.md)、[author-handoff](2026-11-20-author-handoff.md)、[review-response](review-response.md) 的“第 2 轮复核回应”，并对照 [spec](specs/project-tree-editing/spec.md)、[tool-protocol](../../../packages/project-plugin/docs/tool-protocol.md#L21) 与现有源码。
- 只做静态与自动测试核对，未启动真实 DSH 宿主；14 个产品场景仍全部 `untested`，17 项 tasks 均未勾选。

### 逐项确认

| ID | 状态 | 复核依据 |
|---|---|---|
| R1／2-R1 | 已补 | [T12](validation-matrix.md#L18) 的 H 观察点已含“会改变规划的预览及确认保存后的面板提示，明确活动工作结束后从当前规划发起新运行才能继续规划写入”；[tasks 4.4](tasks.md#L30) 同步，[tasks 3.1](tasks.md#L20) 的“对应”已列 T12 并写明 4.2／4.4。 |
| R2／2-R2 | 已补 | [tasks 3.2](tasks.md#L21) 显示 `builtin`、准确版本、可用正文语言与本次所用语言；[tasks 4.2](tasks.md#L28)、[T06](validation-matrix.md#L12)、[T07](validation-matrix.md#L13) 分别核对界面显示与 `treePresets` 载荷字段。 |
| R3／2-R3 | 已改 | [proposal 首段](proposal.md#L3) 已改为“本 change 属于 R2 的第二个产品切片…… [审阅处理]”链接移到句末，语序正确。 |
| R4／2-R8 | 已补 | [proposal Impact](proposal.md#L28) 明写“结构操作与既有节点编辑共用保存判据，回执确认后须有同源有效回读才显示普通已保存”。 |
| R5／2-R4 | 已补 | [design](design.md#L40) 把提示定义为固定条件句“如果有活动工作，后续规划写入需等原运行结束，再从当前规划显式发起新工作”，随会改变规划的预览及确认保存结果显示；不再依赖活动运行查询，R1 的 H 观察点与文案一致。 |
| R6／2-R5 | 已补 | [design](design.md#L26) 明确位置错误沿用结构校验诊断：父节点为空/不存在 `parent-not-found`，锚点不存在/不属于目标组 `invalid-anchor`；[T07](validation-matrix.md#L13) 逐项核对。 |
| R7／2-R6 | 已补 | [handoff](2026-11-20-author-handoff.md#L18) 的 check-repo 范围已含 `tool-protocol.md` 改动，与 [review-response](review-response.md#L49) 一致。 |
| R8／2-R7 | 已补 | [tasks 1.1](tasks.md#L7) 明确校正 `domain/validate.ts` 文件头与结构校验前两处根规则注释，对应 [validate.ts:5](../../../packages/project-plugin/src/domain/validate.ts#L5) 与 [validate.ts:168](../../../packages/project-plugin/src/domain/validate.ts#L168)。 |
| R9 | 延后，接受 | [review-response](review-response.md#L44) 说明 `acceptedBaseline` 属 Agent 工具输出契约，留待该契约变更评估；当前用 [T12](validation-matrix.md#L18) 核对旧基线与最新快照基线的两条拒绝路径。R9 原为可选建议，不阻塞本切片。 |
| R10／复核可选 | 已补 | [proposal](proposal.md#L13) 改为“插入所选父节点下的同级位置”，与 [design](design.md#L17)、[spec](specs/project-tree-editing/spec.md#L38) 的现有父节点约束一致。 |

### 复跑校验

| 命令 | 环境与实际结果 |
|---|---|
| `openspec validate add-project-tree-editing-and-composition --type change --strict --no-interactive --json` | OpenSpec 1.17.0、Node 24.21.0：`valid: true`，1 项通过、0 失败 |
| `node scripts/check-repo.mjs --all` | 暂存 change、两个索引与 `tool-protocol.md` 后运行：286 个待查文件；洁净度失败 0／警告 0；链接 129 篇 0 问题；双语 5 对 0 问题 |
| `pnpm check:ci` | Node 24.21.0、pnpm 12.18.0：build、typecheck、305/305 测试、包边界、协议同步、locale、manifest 全部通过，exit 0 |

三项结果与作者第 2 轮复核记录一致，均独立复现；CI 只验证现有代码，不验证本 change 的未来实现。

### 结论

**审 1 确认放行。** 第 2 轮 R1–R3、R4–R8、R10 与审 2 的 2-R1–2-R8 均已落地；R9 按可选建议延后且理由成立。v1 多根与根组边界、活动 WorkRun“运行继续／写入走新运行”、活动工作条件句提示、T06 的预设来源与语言、T07 的位置诊断、既有节点编辑回读判据和提案语序均已核对；工件状态、`untested` 口径与 17 项未勾选 tasks 保持诚实。

14 个产品场景仍未执行，17 项 tasks 仍未勾选；本确认只表示提案与验收设计可提交，不表示实现或产品验证通过。审 2 的第 2 轮 2-R1–2-R8 仍需其独立确认；作者可在 [review-response](review-response.md) 追加本轮确认记录，待双审齐备后更新 `AGENTS.md`／`openspec/changes/README.md` 索引并按工作流提交。审阅者不承担实施。

## 审 2 · Qoder Desktop Agent（QoderCN） · 2026-11-20 · 复核（第 3 轮）

### 复核范围

- 通读[第 2 轮复核回应](review-response.md#L30-L49)与修订后的 [proposal](proposal.md)、[design](design.md)、[tasks](tasks.md)、[validation-matrix](validation-matrix.md)、[author-handoff](2026-11-20-author-handoff.md)；增量 spec 本轮未改动（与第 2 轮已确认文本一致），无规范漂移。
- 逐条独立核对 2-R1–2-R8 的补项及可选项 R9／R10 的处理；开始时本文件已存在审 1 第 3 轮确认节，本节结论由本会话独立取证给出，不代审 1 确认。
- 只做静态与自动测试核对，未启动真实 DSH 宿主；14 个产品场景仍全部 `untested`，17 项 tasks 均未勾选。

### 复跑校验

| 命令 | 环境与实际结果 |
|---|---|
| `openspec validate add-project-tree-editing-and-composition --type change --strict --no-interactive --json` | OpenSpec 1.17.0：`valid: true`，1 项通过、0 失败、`issues: []` |
| `node scripts/check-repo.mjs --all` | 暂存 change 目录、两个索引与 `tool-protocol.md` 后运行（门禁读索引；运行后取消暂存）：286 个待查文件；洁净度失败 0／警告 0；链接门禁 129 篇 0 问题；双语门禁 5 对 0 问题 |
| `pnpm check:ci` | 宿主自带 Node `24.21.0` 与 pnpm `12.18.0`（临时 PATH shim，与 CI 固定版本一致）：build、typecheck、305/305 测试、包边界、协议同步、locale、manifest 全部通过，exit 0 |

作者第 2 轮校验记录与审 1 第 3 轮复跑结果均独立复现。追加本节后再暂存复跑 check-repo 覆盖最终 review.md，随后取消全部暂存；审阅前后工作区内容不变。CI 只验证现有代码，不验证本 change 的未来实现。

### 逐项确认

| ID | 状态 | 复核依据 |
|---|---|---|
| 2-R1 | 已补 | [T12](validation-matrix.md#L18) H 层新增“会改变规划的预览及确认保存后的面板提示”观察点；[tasks 3.1](tasks.md#L20) 交付条件句提示并把对应关系补到 T12（H 层见 4.2／4.4）；[tasks 4.4](tasks.md#L30) 实测该提示。spec 的活动工作提示 MUST 已有可验收落点。 |
| 2-R2 | 已补 | [tasks 3.2](tasks.md#L21)／[4.2](tasks.md#L28) 显示内置来源 `builtin`、准确版本、可用正文语言与本次所用语言；[T06](validation-matrix.md#L12) 核对预览四字段，[T07](validation-matrix.md#L13) 核对 `treePresets` 载荷对应字段。 |
| 2-R3 | 已改 | [proposal](proposal.md#L3) 首段先说明所属切片与复审状态，审阅链接移到句末，语序问题消除。 |
| 2-R4 | 已补 | [design](design.md#L40) 明确提示为固定条件句文案（原文引出），随会改变规划的结构预览及已确认保存结果显示，不依赖活动运行查询；与 [spec](specs/project-tree-editing/spec.md#L52) 的 MUST 一致，原位操作不触发。PanelTransport 无需新增接口，首轮顾虑消除。 |
| 2-R5 | 已补 | [design](design.md#L26) 位置错误沿用结构校验诊断：父节点为空或不存在 `parent-not-found`，锚点不存在或跨组 `invalid-anchor`；[T07](validation-matrix.md#L13) 逐项核对。 |
| 2-R6 | 已补 | [handoff](2026-11-20-author-handoff.md#L18) check-repo 范围已含 change、两份审阅、作者回应、两个索引与 `tool-protocol.md` 改动，与本轮实际快照一致。 |
| 2-R7 | 已补 | [tasks 1.1](tasks.md#L7) 明确校正 `domain/validate.ts` 文件头与结构校验前两处根规则注释（[validate.ts:5](../../../packages/project-plugin/src/domain/validate.ts#L5)、[validate.ts:168](../../../packages/project-plugin/src/domain/validate.ts#L168)）。 |
| 2-R8 | 已补 | [proposal Impact](proposal.md#L28) 明示结构操作与既有节点编辑共用“回执确认后须有同源有效回读才显示普通已保存”的判据，范围透明。 |
| R9（可选） | 延后，接受 | [回应](review-response.md#L44) 说明 `acceptedBaseline` 输出属 Agent 工具契约变更，留待该契约变更评估；T12 已覆盖旧基线与最新快照基线两条实际拒绝路径。原为可选建议，不阻塞本切片。 |
| R10（可选） | 已补 | [proposal](proposal.md#L13) 改为“插入所选父节点下的同级位置”，与 design／spec 的现有父节点约束一致，插入不新建根。 |

本轮未发现新问题；与审 1 第 3 轮确认无结论分歧。

### 结论

**审 2 确认放行。** 第 2 轮 2-R1–2-R8 全部落地并经独立核对，可选项 R9 延后理由成立、R10 已补；首轮 2-A1–2-C2 的技术修订维持第 2 轮确认结论。三项校验独立复跑通过；工件齐备、14 个场景 `untested`、17 项 tasks 未勾选的状态诚实。

双审确认至此齐备。本确认只表示提案与验收设计可提交，不表示实现或产品验证通过；作者可在 review-response 记录双审确认，更新 `AGENTS.md`／`openspec/changes/README.md` 索引后按工作流提交（push 与 tag 仍须用户明确指示）。实施由用户另行安排，审阅者不承担实施。
