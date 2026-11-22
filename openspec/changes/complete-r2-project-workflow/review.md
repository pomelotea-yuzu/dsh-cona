# complete-r2-project-workflow 外部审阅

## 审 1 · DSH · 2026-11-22

审阅者身份：本会话为 DSH 侧独立上下文，未参与该 change 的编写。[作者交接](2026-11-22-author-handoff.md#L3)声明作者为 Codex 会话，因此本会话按工作流作为审 1，不属于“同模型自查”。本文件只记录审 1 的结论，不代填审 2；只读审阅，未实施。

### 范围与方法

- 通读 [proposal](proposal.md)、[design](design.md)、五组[增量 specs](specs/)、[tasks](tasks.md)、[validation-matrix](validation-matrix.md) 与[作者交接](2026-11-22-author-handoff.md)。
- 对照主 specs：[portable-project-data](../../specs/portable-project-data/spec.md)、[project-overview-resume](../../specs/project-overview-resume/spec.md)、[project-tree-editing](../../specs/project-tree-editing/spec.md)、[project-conversation-context](../../specs/project-conversation-context/spec.md)、[project-command-commit](../../specs/project-command-commit/spec.md)、[project-panel-sync](../../specs/project-panel-sync/spec.md)、[plugin-localization](../../specs/plugin-localization/spec.md)。
- 对照源码（本会话逐段读取）：`packages/project-plugin/src/domain/`（`types.ts`、`commands.ts`、`transforms.ts`、`validate.ts`、`presets.ts`、`canonical/plan-fingerprint.ts`）、`application/`（`command-service.ts`、`command-queue.ts`、`work.ts`、`local-state.ts`、`baseline.ts`）、`host/`（`index.ts`、`project-service.ts`、`overview-service.ts`、`instance-runtime-registry.ts`、`project-tools.ts`、`session-directory.ts`）与 `formats/v1/plan-canonicalization.md`。
- 对照文档：[工作流](../../../docs/development/workflow.md)、[决策](../../../docs/knowledge/decisions.md)、[路线图草案](../../../docs/engineering/2026-11-12-plugin-development-roadmap.md)、[路线图功能设计](../../../docs/product/2026-11-12-project-roadmap-design.md)、[资料可移植设计](../../../docs/architecture/2026-11-12-project-data-portability.md)、[总体架构](../../../docs/architecture/2026-11-11-project-development-architecture.md)。
- 只做静态与自动测试核对，未启动真实 DSH 宿主；五组 specs 的 30 个产品 Scenario 仍全部 `untested`。CI 只验证现有代码，不验证本 change 的未来实现。

### 复跑校验

本会话 shell 默认 Node 为 `v26.13.0` 且无全局 pnpm／openspec；以下命令改用 DSH 应用包自带 Node `24.21.0`、pnpm `12.18.0` 与独立安装 OpenSpec `1.17.0`。

| 命令 | 环境与实际结果 |
|---|---|
| `openspec validate complete-r2-project-workflow --type change --strict --no-interactive --json` | `valid: true`，1 项通过、0 失败、`issues: []` |
| `node scripts/check-repo.mjs --staged` | 暂存本 change 全部工件、本 `review.md` 和 `openspec/changes/README.md` 后运行（门禁读索引；运行后已取消暂存）：307 个待查文件；洁净度失败 0／警告 0；自测 32 项通过；链接门禁 145 篇 0 问题；双语门禁 5 对 0 问题 |
| `pnpm check:ci` | Node `24.21.0`、pnpm `12.18.0`；build、typecheck、341/341 测试、包边界、协议同步、locale、manifest 全部通过，exit 0 |

交接中的 OpenSpec 1.17.0、check-repo 0/0、341/341 均独立复现。计数核对：5 组增量 specs、17 项 Requirement、30 个 Scenario；任务 29 项全部未勾选；矩阵 39 行（C 9／E 11／W 6／M 4／J 9）全部 `untested`；与本 change 的 `README` 状态和作者交接一致。审阅开始前无 `review.md`，无预填审阅、无预勾选。

### 确认通过项

1. **工件齐备，状态诚实。** proposal／design／五组增量 spec／tasks／validation-matrix／author-handoff 齐全；30 个 Scenario 与 C01–C09、E01–E11、W01–W06、M01–M04 逐一对应，J01–J09 覆盖联合验收；tasks 均保留“交付、完成检查、矩阵证据”三段，没有把计划写成已完成。
2. **总体方向与既有边界一致。** 公开资料继续以 v1 字节规则和独立复算为准，v2 采用显式启用而非静默升级；Git 只读、不自动 commit／merge；将资料位置迁移建模为同一实例的定位变更，避免把 Git 副本接入误当成迁移；聊天仍区分关联与执行绑定。这些都与[资料可移植设计](../../../docs/architecture/2026-11-12-project-data-portability.md)和[总体架构](../../../docs/architecture/2026-11-11-project-development-architecture.md)的既有方向一致。
3. **R2 前两切片的接口被正确复用。** `ProjectCommandService` 的每实例串行队列、`requestDigest`、持久意图、`allocateIds`、`replay`、双修订和同源回读直接支撑本 change 的幂等与恢复目标；`InstanceRuntimeRegistry`、`conaOverview` 的 owner 准入和多实例概览为资料接入、聊天导航与树入口提供了基础；`treePresets`／`insert-preset` 的现有预设路径可作为用户模板的起点。任务与矩阵对这些机制的引用基本准确。
4. **联合验收的分层清楚。** A／F／H 分层、固定 DSH `0.2.2-rc.2`、同一验收包、真实 Git 和隔离 profile 的要求，延续 R1／R2 的做法；前两切片与 R1 的历史结论保留在原矩阵，未把历史证据当作本 change 的通过证据。
5. **仓库门禁与 OpenSpec 严格校验通过。** 本 change 的工件没有触发链接、双语、洁净度或协议门禁；现有 341 项测试未回归。

### 问题

| ID | 级别 | 摘要 |
|---|---|---|
| A1 | 必改 | 新增规划变更没有命令／事务契约：批量树操作、路线图日期与里程碑、撤销／重做都只能落在现有单命令入口之外 |
| A2 | 必改 | 加入 `plan.roadmap` 后，既有全部 `Plan` 变换只返回 `{nodes, dependencies}`；本 change 未要求它们保留 v2 路线图，存在静默丢数据风险 |
| A3 | 必改 | 合并产生的“被替代”关系没有可机读表示，导航替代目标与路线图“待核对”无法稳定实现 |
| A4 | 必改 | 用户模板无法按现有 `insert-preset`／`PresetDescriptor` 协议表达：版本类型、来源、正文语言与校验器都不兼容 |
| A5 | 必改 | Agent 的 `move-node`／模板插入没有接入现有 WorkRun 动作模型和 owner-only 准入；运行切换部分已按 A6 裁决移出 |
| A6 | 已裁决（用户） | 目标日期／基础时间视图与多实例显式运行切换均移出 R2；详见下方 A6 节 |
| B1 | 应改 | 里程碑目标视图的呈现范围比已认可路线图设计窄；日期／时间视图已按 A6 移出 |
| B2 | 应改 | 里程碑“逐项条件／证据／受检版本”没有数据模型；v2 转换改变 `planVersion` 后旧 `subjectVersion` 的语义未定义 |
| B3 | 应改 | v2 里程碑交付的校验与生命周期缺口：缺失节点、取消节点、重复项、记录 `contentHash` 失配和清理规则未写 |
| B4 | 应改 | 迁移排他、持久状态与本地 schema 兼容没有落到可核对的契约 |
| B5 | 应改 | “未解释的索引丢记录”“参考文件暂未稳定”等诊断不可执行，矩阵无法据此判定 |
| B6 | 应改 | 按仓库惯例应在 `AGENTS.md` 登记活动 change；当前只更新了 change 索引 |
| C1 | 建议 | 撤销／重做的范围、保留期、路线图编辑覆盖和“本 change 上线后”限制需要统一 |
| C2 | 建议 | 术语不一致：`insert-preset`／`insert-template`、完成条件／交付条件、配置实例／运行实例 |
| C3 | 建议 | 单 change 29 项任务、39 个矩阵场景，建议明确阶段门禁，降低一次实施与验收的风险 |
| C4 | 建议 | 新增聊天／运行切换／模板界面的 i18n 与模板正文语言需要单独落到验证点 |

#### A1 · 新增规划变更缺少命令／事务契约（须处理）

- **事实。** 现有命令入口是单个 `Command`：[command-service.ts](../../../packages/project-plugin/src/application/command-service.ts#L82-L100) 的联合类型只有 `add-nodes`、`update-node`、`split-node`、`set-dependencies`、`set-node-status`、`move-node`、`insert-preset`、`append-record`；`buildCandidate` 只调用一次 `applyPlanCommand`（[同文件](../../../packages/project-plugin/src/application/command-service.ts#L1069-L1070)），而 `PlanCommand` 也是单命令联合（[commands.ts](../../../packages/project-plugin/src/domain/commands.ts#L88-L105)）。本 change 却要求分组／合并／复制在“同一规划提交中整体接受或拒绝”（[增量 spec](specs/project-tree-editing/spec.md#L3-L20)、tasks 2.1／2.2）、路线图日期和里程碑编辑（[增量 spec](specs/project-roadmap/spec.md#L12-L33)、tasks 4.3／4.4）、撤销／重做（[增量 spec](specs/project-tree-editing/spec.md#L22-L34)、tasks 2.3）。
- **影响。** 实现者只有两条路：用多个现有命令分多次提交，违反“整体接受或拒绝”并造成中间修订；或在命令服务之外自定义操作，绕过 `requestDigest`、`replay`、`allocateIds`、`noBusinessChange`、回执和同源回读。两条路都会让 tasks 的“复用现有意图机制”失去可执行口径，矩阵也无法判断一次操作到底推进几次修订。
- **要求。** 在 design 中给出最小契约：为批量树操作、路线图编辑、撤销／重做分别定义命令类型（或显式的命令数组／复合命令）；说明它们如何进入 `requestDigest`、如何冻结生成 ID、如何判定无业务变化、如何返回原回执、如何与 `OWNER_ONLY_COMMANDS`／Agent 动作映射配合。若选择复合命令，还要说明阶段内失败的整体拒绝和重放语义。tasks 至少补一项“新命令摘要与回执”的验证，矩阵补对应分支。

#### A2 · v2 `plan.roadmap` 与既有变换的保留（须处理）

- **事实。** `Plan` 只有 `nodes` 和 `dependencies`（[types.ts](../../../packages/project-plugin/src/domain/types.ts#L27-L45)）；`addNodes`、`moveNode`、`splitNode`、`setNodeStatus`、`setDependencies`、`instantiateTemplate` 都新建只含这两个字段的 `Plan`（例如 [transforms.ts](../../../packages/project-plugin/src/domain/transforms.ts#L44-L47)、[同文件](../../../packages/project-plugin/src/domain/transforms.ts#L171-L174)、[同文件](../../../packages/project-plugin/src/domain/transforms.ts#L287-L290)）。`applyPlanCommand` 直接把变换结果放回文档并重算指纹（[commands.ts](../../../packages/project-plugin/src/domain/commands.ts#L151-L159)）。本 change 在 design 中把路线图放进 `plan.roadmap`（[design](design.md#L49)），但只在“内置流程实例化”一条 MODIFIED Requirement 里写明“v2 资料 MUST 保留已有路线图字段和引用”（[增量 spec](specs/project-tree-editing/spec.md#L66-L77)）；新增的树编辑、撤销／重做和路线图要求没有普遍要求保留 `roadmap`，矩阵 E01–E07 也只覆盖 v1 树操作。
- **影响。** 一旦 v2 文档带着日期或里程碑，再执行普通的改标题、改条件、移动、拆分、设状态，当前实现形状会把 `roadmap` 丢掉；`planVersion` 随内容变化，用户会看到日期／里程碑消失，而且校验仍可能通过。E10 只测预设插入，无法覆盖这条路径。
- **要求。** 把“所有规划变换保留未知的 v2 规划扩展字段”写成显式要求，或由 `Plan` 类型／变换层统一携带 `roadmap`；为 v2 上的树编辑增加矩阵场景（至少覆盖 `update-node`、`move-node`、`set-node-status`、`split-node`、`add-nodes` 各一次），并断言日期、里程碑与引用在编辑后仍在。修改 `transforms` 后还要证明 v1 路径不新增字段、v1 指纹不变。

#### A3 · “被替代”关系没有可机读表示（须处理）

- **事实。** `WorkNode` 没有 `replacedBy` 或等价字段（[types.ts](../../../packages/project-plugin/src/domain/types.ts#L27-L35)）。design 说“源节点以原 ID 在原分支保留为取消及被替代的历史，计划变更记录指明保留节点”（[design](design.md#L25)），“在原节点仍取消且该替代关系未被逆向操作解除时，导航显示替代目标”（[design](design.md#L29)）；增量 spec 也要求“原节点以原 ID 保留为已取消与被替代”（[增量 spec](specs/project-tree-editing/spec.md#L16-L20)），路线图要求“被替代……已有引用无法核实时 MUST 提示待核对”（[增量 spec](specs/project-roadmap/spec.md#L12-L24)）。
- **影响。** 如果替代关系只写在自由 Markdown 正文里，导航和路线图无法稳定地知道“原节点被谁替代”，只能猜摘要或同名，违反“不靠相同名称自动续接”的既有原则；撤销时也无法判断替代关系是否已解除。E02／M02 的“待核对”“替代目标”缺少可核对的来源。
- **要求。** 明确替代关系的表示：v2 节点字段、独立的替代记录 schema，或 `plan-change` 记录中可严格解析的结构。给出读取路径、旧 v1 数据无该字段时的行为、撤销时如何解除替代、以及路线图引用遇到替代时的显示规则；补 E02／M02 的具体断言。

#### A4 · 用户模板与现有预设协议不兼容（须处理）

- **事实。** 当前 `InsertPresetCommand` 的 `templateVersion` 是 `number`，预设目录是同步的 `resolve(templateId, templateVersion)`（[command-service.ts](../../../packages/project-plugin/src/application/command-service.ts#L69-L100)）；`PresetDescriptor.source` 固定为 `builtin`（[presets.ts](../../../packages/project-plugin/src/domain/presets.ts#L12-L13)），`validatePreset` 要求 `source === 'builtin'` 且同时具备 `zh-CN` 与 `en` 两种正文语言（[presets.ts](../../../packages/project-plugin/src/domain/presets.ts#L78-L87)）。但 design 说用户模板“版本用不可变记录 ID 标识”，插入命令要冻结“模板来源、精确版本、内容哈希及目标锚点”（[design](design.md#L33-L35)）；tasks 2.4／2.5 只写“发布并读取用户模板版本”“接入精确用户模板版本”。本 change 没有说明如何把记录 ID、`contentHash`、来源、单语言正文和已发布索引读取映射到现有命令／目录／校验器。
- **影响。** 直接复用现有 `insert-preset` 会因 `templateVersion` 类型、`source` 校验和双语要求失败；若另加命令又未定义摘要、重放、错误码和预览载荷，预览与提交可能读不同版本，或无法从回执判断生成了哪一批节点。模板正文的 `[cona:template]` 前缀和 schema 也还是未定义的实现细节。
- **要求。** 在 design 中给出最小协议：用户模板的稳定 ID、版本载体（记录 ID＋内容哈希）、来源字段、正文语言集合、`PresetDescriptor` 或独立模板描述类型、读取入口（同步还是异步）、拒绝码；插入命令的字段、摘要、生成 ID、回执与旧版兼容。明确采用 `plan-change` 记录作为模板版本是否只用于格式兼容，并说明它不会污染普通 plan-change 历史或需要额外过滤。tasks 2.4／2.5 和 E06／E07 同步增加“记录 ID／哈希精确匹配”和“单语言正文”观察点。

#### A5 · Agent 的移动／插入动作未接入现有动作模型（须处理；运行实例切换已移出）

- **事实。** 现有 `WorkAction` 只有 `add`、`update`、`split`、`dependencies`、`record`、`status`（[local-state.ts](../../../packages/project-plugin/src/application/local-state.ts#L203-L206)）；`commandAction` 只把 `move-node` 保守映射为 `update`、`insert-preset` 映射为 `add`（[work.ts](../../../packages/project-plugin/src/application/work.ts#L186-L207)），并在注释中说明结构命令由 owner-only 拒绝（[command-service.ts](../../../packages/project-plugin/src/application/command-service.ts#L276-L286)）；`PLANNING_TYPES` 也不含 `move-node`／`insert-preset`（[project-tools.ts](../../../packages/project-plugin/src/host/project-tools.ts#L164-L199)）。本 change 新增 Agent 的 `move-node`／模板插入（[增量 spec](specs/project-conversation-context/spec.md#L30-L37)、[增量 spec](specs/project-tree-editing/spec.md#L52-L64)），design 只写“各自需要明示动作权限”（[design](design.md#L41)），tasks 3.4 没有给出动作名、目标与位置授权、工具入口或 owner-only 的调整方式。
- **影响。** Agent 的移动／插入无法用现有 `allowedActions` 表达，owner-only 集合会直接拒绝它们；若只扩 `PLANNING_TYPES` 而不改动作模型，会绕过动作范围和位置校验。用户裁决已把“显式运行实例切换”移出本 change，因此本条只需解决“配置实例上的 Agent 结构动作”，不要求同 host 多实例工具路由；B 在新环境作为配置实例执行即可。
- **要求。** 为 `move-node`／模板插入定义独立动作名，说明 `commandAction`／`commandTargets`／`OWNER_ONLY_COMMANDS` 如何调整，`project_apply` 的 `PLANNING_TYPES` 如何按动作放行；给出源父组、受影响同级、子树、目的组、根组和模板版本的位置授权检查及稳定错误码。tasks 3.4 和 W04 增加“Agent 使用新动作名”“越权位置被拒”“配置实例内获准写入”的观察点；不再要求 W02 或同 host 切换实例。

#### A6 · 范围扩展（用户已裁决）

- **事实。** 已认可的开发路线图把 R2 的目标／时间视图留待后文安排：R2 段写“以同一规划支撑路线图浏览，具体目标／时间视图按后文安排推进”（[路线图](../../../docs/engineering/2026-11-12-plugin-development-roadmap.md#L71)），实施安排又写“目标日期、时间窗口、时间轴拖动和依赖改期策略先做交互试验，再确定进入哪个 change”（[同文件](../../../docs/engineering/2026-11-12-plugin-development-roadmap.md#L137)）。本 change 把“目标日期编辑与基础时间展示”直接放进 R2 收尾，并在 proposal 中写成用户还需要的能力（[proposal](proposal.md#L5-L15)），但作者交接把它列为“提案中的范围选择”（[交接](2026-11-22-author-handoff.md#L5-L11)），没有引用新的用户授权或决定记录。另，现有 `project-overview-resume` 要求其他实例“界面 MUST 明示项目工作入口不可用”，本 change 改为可显式切换运行实例（[增量 spec](specs/project-overview-resume/spec.md#L3-L13)），这是对已归档 R2 行为的改变。
- **影响。** 若用户没有明确同意，这两项属于把“先试验再确定”的范围提前固化；若用户已经同意，change 应补上依据，避免后续审阅者按旧路线图判断为范围漂移。该问题涉及目标与范围取舍，按工作流应由用户裁决，不应由作者或审阅者自行选边。
- **用户裁决（2026-11-22）。**
  - **目标日期／基础时间视图不纳入本次 R2。** R2 只保留里程碑与交付引用；目标日期、时间视图和日期交互留待后续独立的规划视图 change，先按已认可路线图做交互试验。若本次仍引入 v2，则只为里程碑交付引入；`targetDates` 可以预留但不进入本 change 的验收，不做 M04。
  - **多实例显式运行切换不纳入本次 R2。** 保留已归档的“其他实例项目工作入口不可用”；其他实例仍可浏览、编辑树、保存接续、建立本机聊天和导航聊天。需要在新环境执行时，把 B 配置为当前实例（干净 profile／home）后启动，而不是同 host 切换。
- **作者据此需做的缩减。**
  - proposal：删除目标日期／时间视图和显式运行切换的交付表述，把两者列入“后续范围”，并记录本次用户裁决。
  - design：删除运行实例切换段与目标日期／时间视图段；保留里程碑、交付关联、v2 中与里程碑有关的部分；不再要求同 host 工具／事件路由。
  - specs：`project-conversation-context` 删除“可信的运行实例切换”Requirement；`project-roadmap` 把“同一规划下的目标与时间视图”缩为“同一规划下的目标视图”，删除“基础目标日期管理”Requirement；`project-overview-resume` 保留“其他实例项目工作入口不可用”，只增加聊天关联与显式重绑；`project-tree-editing` 的 Agent 移动／插入仍保留，按 A5 处理。
  - tasks／matrix：移出 3.2（运行切换）与 W02；4.4 缩减为“里程碑目标视图”（去掉时间视图与日期操作），M01 缩减为树与目标视图同步，M04 移出；J09 改为“在独立干净 DSH profile 中把 B 配置为执行实例，重绑聊天并在获准范围写入”，不再写同 host 切换。里程碑相关场景（M01–M03）保留，但需按 B1／B3 收窄目标视图和 v2 校验范围。
  - 在 `docs/knowledge/decisions.md` 或作者交接中记录本次裁决，避免后续按旧路线图重新争论。此裁决已解决原 A6；审 1 不再以“范围未定”为由阻止修订。

#### B1 · 里程碑目标视图内容需对齐已认可设计（建议处理；日期／时间视图已移出）

- **事实。** [路线图功能设计](../../../docs/product/2026-11-12-project-roadmap-design.md)的目标视图包含里程碑、成果、完成条件、关键依赖、实际进展、阻塞、下一步，并可从里程碑打开关联聊天；本 change 的 `project-roadmap` Requirement 只承诺同源快照、定位节点／记录、里程碑与交付来源／确认状态／完成依据（[增量 spec](specs/project-roadmap/spec.md#L3-L24)、[design](design.md#L53)）。按 A6 裁决，目标日期／时间视图已移出，因此本条只剩“里程碑目标视图”的内容范围；M01–M03 也没有“显示依赖／进展／阻塞／下一步”或“打开关联聊天”的观察点。
- **影响。** 容易被读成“目标视图已完成”，但对照已认可设计仍缺关键内容；也可能被实现为只有里程碑列表。
- **建议。** 二选一：补充里程碑目标视图的依赖／进展／阻塞／下一步和聊天入口，并加场景；或在 proposal 的“后续范围”明确本次只交付里程碑列表与交付来源，不宣称覆盖已认可设计的全部目标视图内容。目标日期／时间视图的交互设计留给后续 change，不再在本条要求。

#### B2 · 里程碑证据与受检版本需要数据模型（建议处理）

- **事实。** 现有完成规则只要求 `done` 节点有非空 `completionCriteria`，并存在指向该节点的 `verification.status === 'pass'` 记录（[validate.ts](../../../packages/project-plugin/src/domain/validate.ts#L518-L534)）；`VerificationBlock` 只有 `status`、`subject`、可选 `scope`、`subjectVersion`（[types.ts](../../../packages/project-plugin/src/domain/types.ts#L65-L75)），没有“逐项条件”的结构。design 要求里程碑显式完成时“核对自身每项条件及可追溯的成果或验证记录，保存依据与受检版本，普通状态写入口同样检查该条件”（[design](design.md#L51)），spec 也要求“达成里程碑 MUST 核对自身条件和证据”（[增量 spec](specs/project-roadmap/spec.md#L12-L24)）。此外，v2 转换会把 `schemaVersion` 从 1 改为 2，从而改变 `planVersion`；旧验证记录的 `subjectVersion` 是否会因此被判定失效，change 没有说明。
- **影响。** M02 的“自身缺证据时拒绝完成，有独立依据时方可完成”目前只能落到“任意一条 pass 记录”，无法核对逐项条件；v2 转换后若按 `subjectVersion` 比较，可能把仅格式升级误判为全部历史验证过期，影响接续卡片和目标视图的可信度。
- **建议。** 明确证据模型：是一条 verification 记录覆盖全部条件（用 `scope` 说明），还是按条件拆分；`subjectVersion` 在 v2 转换、普通树编辑和路线图编辑后分别如何计算；`set-node-status` 对里程碑的额外检查如何实现。补 M02／M03 的逐项条件与“仅格式升级不使历史验证变成当前通过”的观察点。

#### B3 · v2 里程碑交付的校验与生命周期（建议处理；日期字段随 A6 移出）

- **事实。** design 定义 `roadmap.milestones` 为 `{nodeId, deliveries}`，`targetDates` 随 A6 移出本次验收；spec 只对交付关联写了“指向本项目其他节点或已发布成果、非自引用、历史缺失待核对”（[增量 spec](specs/project-roadmap/spec.md#L12-L24)）。没有写：里程碑节点或交付引用的 nodeId 必须存在、节点取消后里程碑和交付如何处理、节点被外部移除后 v2 文档是否拒绝、同一节点重复项如何拒绝、记录交付的 `contentHash` 是否必须等于当前索引、里程碑节点被取消后是否清理。
- **影响。** 校验器可能接受悬空的里程碑或交付；外部 Agent 合并后，目标视图可能显示不存在的节点，或 `contentHash` 已变但仍被当作有效交付。M03 只覆盖交付引用，无法发现这些生命周期问题。
- **建议。** 把 v2 里程碑／交付的引用完整性写成明确规则（存在、同项目、非自引用、重复拒绝、记录哈希匹配或显式待核对），并补一个 v2 外部修改／节点取消／记录版本变化的场景。`targetDates` 的校验规则留到后续时间视图 change 再定。

#### B4 · 迁移的排他、状态和本地 schema（建议处理）

- **事实。** design 说迁移“通过现有串行队列封住实例写入”（[design](design.md#L15)），但 `InstanceCommandQueue.run` 只是把任务串行化（[command-queue.ts](../../../packages/project-plugin/src/application/command-queue.ts#L4-L23)），本 change 没有定义迁移任务如何进入该队列、如何在长复制期间阻止新命令、迁移意图在 `InstanceAggregate`／`Registry` 中的字段、状态枚举、取消与重启核对，以及已存在的 `registry.json`／`state.json`（`schemaVersion: 1`）如何兼容新增字段。tasks 1.4／1.5 只写了“建立迁移意图”“四处中断”，没有给出可核对的持久形状。
- **影响。** 实现者可能把迁移意图临时放内存或自造文件，重启核对和队列排他无法验证；复制期间的新命令可能穿插，破坏“唯一有效写入位置”。
- **建议。** 在 design 中列出迁移意图的最小字段与状态机、进入队列的方式、刷新／命令的互斥、取消和恢复规则，以及本机 schema 的版本或兼容读取方式；tasks 1.4／1.5 对应增加“复制期间新命令排队”和“旧聚合无迁移字段”的检查。

#### B5 · 诊断条件不可执行（建议处理）

- **事实。** design 要求对“未解释的索引丢记录”“参考文件暂未稳定”等给出具体诊断（[design](design.md#L11)），但两词都没有判定标准；tasks 1.2 只写“核对候选格式、关系、索引、正文、观察基线及实际 Git 状态”，C02／C03 也没有“如何区分合法回退与未解释丢记录”的步骤。
- **影响。** 执行者无法判断何时应停写、何时应确认回退；矩阵可能用“看到了错误提示”代替“正确区分了合法删除与外部篡改”。
- **建议。** 给出稳定诊断码和判定条件（例如：新索引缺少旧记录且 Git 历史/观察基线不能解释、正文文件缺失、哈希失配分别对应什么），并在 C02／C03 写清观察点。

#### B6 · 活动 change 未登记到接手索引（建议处理）

- **事实。** 本 change 更新了 [openspec/changes/README.md](../README.md#L10)，但没有更新 [AGENTS.md](../../../AGENTS.md)。前两次 change 的提交都把活动 change 写进 `AGENTS.md`（例如 `5797a89` 增加的“活动 change …”行，归档时再替换）；当前 `AGENTS.md` 只写到 R2 第二切片归档，没有指向本 change。`docs/README.md` 的“R1 活动 change”也仍是旧入口（属既有遗留，可顺带修正）。
- **影响。** 新接手的 Agent 从 `AGENTS.md` 看不到当前活动 change，只能翻 `openspec/changes/README.md`；与仓库既有交接习惯不一致。
- **建议。** 在 `AGENTS.md` 增加一行活动 change 索引（或明确说明本 change 由 `openspec/changes/README.md` 承接），并在归档时按惯例替换。

#### C1 · 撤销／重做的范围与保留（建议）

- spec 说“系统 MUST 能为同源的已提交 owner 规划编辑建立……”，design 限定“本 change 上线后通过树与路线图入口提交的 owner 规划编辑”（[design](design.md#L29)），但 spec 没有写“上线后”或“有逆向信息”的前提；tasks 2.3 只列“目标、结构和插入”，没有明确路线图日期／里程碑编辑是否可撤销。撤销记录的保留期、清理、私密数据边界也没有说。
- 建议统一为“只对记录了逆向信息且同源的 owner 操作可撤销”，明确路线图编辑的覆盖，并补一个“旧操作无撤销信息时禁用”的观察点；保留期与清理可以留到实现，但应在 design 写明本机存储边界。

#### C2 · 术语与命名（建议）

- 现有命令是 `insert-preset`，design 多处写 `insert-template`；现有动作是 `instantiate-template`，任务写“模板插入”。`project-roadmap` spec 同时使用“完成条件”和“交付条件”，`project-overview` 同时使用“配置实例”和“运行实例”。建议在 design 开头统一术语表，并在 tasks／spec 使用同一名称，避免实现者和验收者各自理解。

#### C3 · 单 change 体量与阶段门禁（建议）

- 29 项任务、39 个矩阵场景，覆盖资料、树、模板、聊天、执行、路线图与联合验收。change 已声明按 0–5 段推进，但 tasks 没有明确的“阶段出口”条件（例如 1.x 全部 A/F 通过后才进入 2.x）。建议在 tasks 开头加阶段门禁，或把路线图部分拆成独立 change；如果不拆，至少在 review-response 中说明为什么这些能力必须由同一 change 验收。

#### C4 · i18n 与模板正文语言（建议）

- `plugin-localization` 已要求“已交付功能”完整中英，但本 change 新增的聊天／运行切换／模板列表与预览没有单独的场景；`project-conversation-context` 的新增 Requirement 没有 i18n 句子。用户模板正文语言与界面语言的关系也只写在 design（[design](design.md#L33)），没有落到 E06／E07 的观察点。
- 建议在 W01／W05 或 E06 增加“中英切换 + 英文回退 + 用户原文不变”的断言，或在 tasks 3.1／2.4 明确复用现有 locale 资源检查。

### 结论

**有条件放行。** 方向、工件完整度、R1／R2 机制复用和 A／F／H 验收设计整体成立；OpenSpec 严格校验、仓库门禁和 341 项现有测试均已独立复跑通过，30 个产品 Scenario 和 39 个矩阵行仍如实保持 `untested`，没有预勾选或预填审阅。

**提交前须处理 A1–A5：** 新变更命令／事务契约、v2 `roadmap` 的保留、合并替代关系、用户模板协议、Agent 结构动作授权。这五项会直接影响实现口径或验收可执行性。**A6 已由用户于 2026-11-22 裁决：** 目标日期／基础时间视图与多实例显式运行切换均移出 R2；A6 关闭，A5 只保留“配置实例上的 Agent 移动／插入”部分，B1／B3 按里程碑收窄。作者应按 A6 的缩减清单修改 proposal／design／specs／tasks／matrix，并在 `docs/knowledge/decisions.md` 或作者交接记录该裁决。**B2／B4／B5／B6 建议一并处理，或在本 change 中明确记为后续；C1–C4 为措辞、覆盖与体量建议。**

修订后请作者在 `review-response.md` 逐条记录依据与位置，重新运行 OpenSpec 严格校验、包含全部拟提交工件的仓库门禁和 `pnpm check:ci`，并由原审阅者确认。审 2 尚未给出；按工作流，双审未齐前保持待审阅、不提交，审阅者不承担实施。

## 审 2 · GLM（Trae） · 2026-11-22

审阅者身份：另一个 Agent（GLM-5.3，Trae 会话），未参与该 change 的编写与实施。按工作流作为审 2 给出独立结论。审 1 节位于同一文件、本次审阅前已读；对其关键事实断言逐条在源码中独立复核，未照单采纳，问题编号沿用审 1 以便作者统一响应，另以 D 编号列出本审阅新增的问题。只读审阅，未实施。

### 范围与方法

- 通读本 change 全部工件：[proposal](proposal.md)、[design](design.md)、五组[增量 specs](specs/)、[tasks](tasks.md)、[validation-matrix](validation-matrix.md)、[作者交接](2026-11-22-author-handoff.md)。
- 对照主 specs（五组受影响能力及 `project-command-commit`、`project-panel-sync`、`plugin-localization`）与归档矩阵（O01–O13、T01–T14、V15/V32/V37/V04 逐行核对 J 行引用）。
- 对照源码：`domain/commands.ts`、`domain/types.ts`、`domain/presets.ts`、`application/command-service.ts`、`application/local-state.ts`、`application/work.ts`、`host/project-tools.ts`。
- 未启动真实 DSH 宿主；30 个产品 Scenario 与 39 个矩阵行保持 `untested`，本审阅不产生任何实测结论。

### 复跑校验

默认 shell Node `v26.13.0`、无全局 pnpm／openspec；改用 DSH 应用包（`/Applications/DeepSeek Harness.app`）自带 Node `24.21.0` 与 pnpm `12.18.0`（经临时 shim 暴露 `pnpm` 命令）及独立安装 OpenSpec `1.17.0`。

| 命令 | 环境与实际结果 |
|---|---|
| `openspec validate complete-r2-project-workflow --type change --strict --no-interactive --json` | `valid: true`，1 项通过、0 失败、`issues: []` |
| `node scripts/check-repo.mjs --staged` | 暂存本 change 全部工件及 `openspec/changes/README.md` 后运行，运行后取消暂存：洁净度失败 0／警告 0；自测 32 项通过；链接门禁 145 篇 0 问题；双语门禁 5 对 0 问题 |
| `pnpm check:ci` | Node `24.21.0`、pnpm `12.18.0`：`check-repo --all` 0/0、build、typecheck、341/341 测试、包边界、协议同步、locale、manifest 全部通过，exit 0（首次尝试因 `pnpm` 未进子进程 PATH 失败，属本机环境问题，非仓库问题，shim 后完整通过） |

独立重算核对：任务 29 项（0.1–0.2、1.1–1.5、2.1–2.6、3.1–3.4、4.1–4.4、5.1–5.8），全部未勾选且具备交付／完成检查／矩阵证据三段；Scenario 共 30 个（portable 9＝新增 5＋指纹修订 4；tree-editing 11＝新增 7＋修订 4；conversation 新增 4；overview 修订 2；roadmap 4），与矩阵 C9／E11／W6／M4 逐一对应，加 J9 共 39 行，全部 `untested`。矩阵 J03/J04/J05/J06/J07/J08 引用的 O11、O02/O03/O06/O07/O08/O10/O12、T04/T11/T12/T13、V15/V32/V37/V04 均在归档矩阵中逐行存在且含义相符。

### 确认通过项

1. **工件齐备，内部引用一致。** 30 个 Scenario、39 个矩阵行、29 项任务的三方引用经本审阅独立重算一致；tasks 的矩阵证据 ID、J 行对归档场景的引用均准确；状态诚实，无预勾选、无以计划冒充实测。
2. **审 1 A1–A5 的事实基础经源码独立复核全部成立。** 本审阅逐条确认：`PlanCommand` 为单命令联合且 `applyPlanCommand` 单次调用一次变换（[commands.ts](../../../packages/project-plugin/src/domain/commands.ts#L88-L162)）；`Plan` 仅 `{nodes, dependencies}`、`WorkNode` 无替代字段（[types.ts](../../../packages/project-plugin/src/domain/types.ts#L27-L45)）；`PresetDescriptor.source` 固定 `builtin`、`validatePreset` 强制 `zh-CN`＋`en` 双语、`InsertPresetCommand.templateVersion` 为 `number`、目录为同步 `resolve`（[presets.ts](../../../packages/project-plugin/src/domain/presets.ts#L45-L87)、[command-service.ts](../../../packages/project-plugin/src/application/command-service.ts#L73-L123)）；`OWNER_ONLY_COMMANDS`＝{`move-node`,`insert-preset`}（[command-service.ts](../../../packages/project-plugin/src/application/command-service.ts#L92-L93)）、`WorkAction` 不含结构动作（[local-state.ts](../../../packages/project-plugin/src/application/local-state.ts#L204-L206)）、`PLANNING_TYPES` 不含结构命令（[project-tools.ts](../../../packages/project-plugin/src/host/project-tools.ts#L164)）。据此 A1（批量／路线图／撤销重做无命令契约）、A2（v2 `roadmap` 会被现有变换静默丢弃）、A3（替代关系无可机读表示）、A4（用户模板与预设协议不兼容）、A5（Agent 结构动作无法接入现有动作模型）五项必改本审阅同样认定。
3. **A6 用户裁决已具备且可执行。** 裁决内容与缩减清单写在审 1 节内；本审阅确认 change 工件（proposal/design/specs/tasks/matrix）当前仍含目标日期、时间视图与显式运行切换，`docs/knowledge/decisions.md` 亦未见该裁决记录——作者按缩减清单落实并记录依据的工作仍然待做，本审阅不因裁决已存在而降低该项要求。
4. **方向与既有边界一致。** Git 只读、副本各自独立实例、公开／本机数据分离、执行绑定与聊天关联分离、v1 字节规则保留并按版本分派，均与主 specs 及归档决定相符；验收分层（A/F/H、固定宿主 `0.2.2-rc.2`、同一安装包、隔离 profile）延续前两个切片做法。
5. **校验独立复现。** OpenSpec 严格校验、仓库门禁（--staged 含全部拟提交工件）、`pnpm check:ci` 三项均由本审阅在本机独立复跑通过；交接所报 1.17.0、0/0、341/341 与实测一致。

### 新增问题

| ID | 级别 | 摘要 |
|---|---|---|
| D1 | 建议 | C04 判据「尝试两端写入」语义未定：迁移完成后旧根按设计「原样保留」、显式重新接入旧根作独立副本，矩阵应写明「两端写入」各指什么（插件写入只路由到新定位，还是外部写旧根后两实例如何表现），避免执行者各自解读 |
| D2 | 建议 | tasks 5.6 要求对 O01–O13、T01–T14 按「历史证据及当前变更影响」补跑，但没有给出判定「受影响」的口径（例如引入 v2 字段、批量命令或撤销机制后哪些既有场景算受影响）；作者按 A2 补 v2 树编辑场景后应同步给出 5.6 的受影响清单或判定方法，否则 J04/J07 的复跑范围不可核对 |
| D3 | 观察 | [workflow.md](../../../docs/development/workflow.md#L42) 门禁描述仍写「79 项测试」，与当前 341 项不符，属既有文档陈旧、非本 change 缺陷，可顺带更新 |

对审 1 B／C 级问题的独立核对：B6 成立——[AGENTS.md](../../../AGENTS.md) 现无活动 change 行，仅 `openspec/changes/README.md` 已登记；C4 的 i18n 缺口本审阅同样发现（W01–W03、W05/W06 及模板列表界面缺中英断言）；B1–B5、C1–C3 的依据经抽查未见事实错误。

### 结论

**有条件放行。** 工件完整、引用一致、状态诚实，方向与既有规范和归档边界相符；三项校验独立复现通过。**提交前须处理 A1–A5 并落实 A6 裁决的缩减**（含在 `docs/knowledge/decisions.md` 或作者交接记录该裁决）；B1–B6 建议一并处理或明确记为后续；D1–D3 为本审阅新增建议。作者修订后在 `review-response.md` 逐条记录依据与位置，重新运行三项校验，并由两位审阅者确认；双审至此已齐，但在修订与确认完成前保持待审阅、不提交，审阅者不承担实施。

## 审 2 复核（第 2 轮） · GLM（Trae） · 2026-11-22

复核 2026-11-22 修订版。逐项核对[审阅回应](review-response.md)与修订工件，并复跑校验；审 1 侧确认另行给出，本节不代填。

### 逐项核对

| 意见 | 复核结果 |
|---|---|
| A1–A5（必改） | **全部落实。** A1：设计 §2 命令契约给出 8 个新命令的载荷、摘要、冻结 ID、一次权威头原子发布、无变化处理及 owner 准入，新增 spec Requirement「新规划命令的原子发布及回执」、场景 E12 与任务 2.7。A2：设计 §4 与新增「既有规划变换保留里程碑扩展」Requirement（场景 M05）、任务 4.5 穷举新旧变换的保留测试，E10 补 v2 原值断言。A3：`[cona:replacement]` 结构化记录（`sourceNodeIds`／`replacementNodeId`／`clearsRecordId`）可机读，读端按哈希验证的已发布索引投影，旧 v1 无记录时只显示原状态、不推断替代目标，E02／M02 补撤销解除与替代定位断言。A4：内置 `insert-preset` 原协议保留；用户模板走异步目录与 `insert-user-template`，三元组（模板 ID／版本记录 ID／内容哈希）精确匹配、单语言正文、稳定错误码，且模板记录与普通规划历史、接续与 WorkRun 上下文区分。A5：`move`／`insert` 动作、`commandTargets` 影响范围解析、根组单独授权、稳定拒绝码，并按 A6 限定在配置实例 |
| A6（用户裁决） | **缩减已落实。** W02／M04 移除；`project-conversation-context` 删去运行实例切换 Requirement；`project-overview-resume` 保留「项目工作入口不可用」；`plan.roadmap` 只含 `milestones`；J09 改为独立干净环境配置 B；裁决记入 [decisions.md](../../../docs/knowledge/decisions.md) N19、[AGENTS.md](../../../AGENTS.md) 活动行、proposal「后续范围」及交接 |
| B1–B6 | **全部落实。** B1 目标视图补齐成果、条件、直接依赖、进展、阻塞、下一步与聊天入口（M01）；B2 `complete-milestone` 逐项证据协议（条件索引／原文／记录 ID／哈希）、受检版本语义、v1 证据保持历史；B3 悬空里程碑／重复项拒绝、取消与替代保留历史、`milestone-node-missing`（M03）；B4 队列＋本机锁、registry schema 2 迁移状态机与唯一切换点、旧聚合兼容（C04／C05）；B5 七个稳定诊断码及可确认回退的 commit 树判据（C02／C03）；B6 AGENTS.md 活动行＋docs/README.md 旧入口修正 |
| C1–C4 | **全部落实。** C1 撤销限定「同源且已有逆向信息」、旧操作禁用有原因、逆向信息仅本机；C2 术语统一（配置／浏览实例、完成条件、`insert-preset` vs `insert-user-template`）并见设计开头定义；C3 tasks 增加阶段交接表；C4 会话、模板、目标视图 Requirement 及 W01／W06／E06 补中英与回退断言 |
| D1–D3 | **全部落实。** D1 C04 判据改为「实例命令只落新根、外部改旧根不刷新、显式重接入为独立副本」；D2 设计 §5 与 J07 列出固定复跑清单（O02/O03/O06/O07/O08/O10/O11/O12/O13、T01–T14）及其余 O 行的影响核对方式；D3 workflow.md 改为「插件自动测试」 |

### 复跑校验（修订版）

环境同第 1 轮（OpenSpec `1.17.0`；DSH 自带 Node `24.21.0`、pnpm `12.18.0`）。

| 命令 | 实际结果 |
|---|---|
| `openspec validate complete-r2-project-workflow --type change --strict --no-interactive --json` | `valid: true`，0 问题 |
| `node scripts/check-repo.mjs --staged` | 暂存本 change 全部工件（含 review-response）＋5 个配套文档后运行，运行后取消暂存：308 个待查文件，洁净度 0 失败／0 警告；链接门禁 146 篇 0 问题；双语门禁 0 问题；自测 32 项通过 |
| `pnpm check:ci` | build、typecheck、341/341 测试、边界、协议同步、locale、manifest 全部通过，exit 0 |

独立重算：任务实为 **30 项**（0.2 + 1.1–1.5 + 2.1–2.7 + 3.1–3.3 + 4.1–4.5 + 5.1–5.8）；Scenario 30 个（portable 9、tree-editing 12、conversation 3、overview 2、roadmap 4），与矩阵 C9／E12／W5／M4＋J9 共 39 行逐一对应。

### 遗留问题

| ID | 级别 | 摘要 |
|---|---|---|
| R1 | 应改（微小修） | [作者交接](2026-11-22-author-handoff.md)两处仍写「29 项任务」（校验表行与尾段），修订后实为 30 项（新增 2.7、4.5，删去原 3.2，净增 1）。属事实性计数错误，修正两处数字并在 `review-response.md` 记一笔即可，无需再走完整复审。另交接记 check-repo 快照「147 篇文档」，本复核暂存快照实得 146 篇、均为 0 问题，计数口径差异不影响结论，可顺带核对 |

### 结论

**复核通过。** A1–A6、B1–B6、C1–C4、D1–D3 全部核实落实，缩减后的范围与 2026-11-22 用户裁决一致；三项校验在修订版上独立复现通过；30 个产品 Scenario 与 39 个矩阵行仍如实保持 `untested`。仅剩 R1 交接计数小错（微小修，作者自检修正并记录即可）。修正后本审阅者不再保留其他意见；是否提交以审 1 侧复核确认齐备为准，提交与实施按用户指示另行安排。

## 审 1 复审 · DSH · 2026-11-22

审阅者身份：本会话为原审 1，作者按[审阅处理](review-response.md)修订后复核；未参与编写或实施。只读核对，不代填审 2 的复审。

### 复核范围与复跑校验

- 通读修订后的 [proposal](proposal.md)、[design](design.md)、五组增量 specs、[tasks](tasks.md)、[validation-matrix](validation-matrix.md)、[作者交接](2026-11-22-author-handoff.md)与[审阅处理](review-response.md)，以及 `AGENTS.md`、`docs/README.md`、`docs/development/workflow.md`、`docs/knowledge/decisions.md` 的索引／裁决改动。
- 复跑结果：OpenSpec `1.17.0` 严格校验 `valid: true`，1 项通过、0 问题；`node scripts/check-repo.mjs --staged`（暂存全部 17 个拟提交文件）308 个文件、洁净度失败 0／警告 0、自测 32 项通过、链接 146 篇 0 问题、双语 5 对 0 问题；`pnpm check:ci`（Node `24.21.0`、pnpm `12.18.0`）build、typecheck、341/341 测试、边界、协议、locale、manifest 全部通过。
- 修订后计数：17 项 Requirement、30 个 Scenario、39 行矩阵、**30 项任务**（0.1–0.2、1.1–1.5、2.1–2.7、3.1–3.3、4.1–4.5、5.1–5.8），全部未勾选、矩阵全部 `untested`。首轮审阅节中的 29 项及旧 E11／W6 计数保留为历史，以本段为准。
- 作者交接仍写 29 项任务、147 篇文档；本机复跑为 30 项任务、146 篇文档。具体差异见 R1。

### 首轮问题处理核对

| 首轮 | 复审 | 依据 |
|---|---|---|
| A1 命令与事务 | 已落实 | [设计第 2 节](design.md#L37-L54)给出命令表、摘要、冻结 ID、衍生正文、单头发布、无变化处理；tasks 2.7／4.5、E12 |
| A2 v2 字段保留 | 已落实 | [路线图规范](specs/project-roadmap/spec.md#L26-L33)、设计 §4、tasks 4.5、M05 |
| A3 替代关系 | 已落实 | [设计](design.md#L60)的 `[cona:replacement]` 记录、读取与撤销规则；E02／M02；格式文档仍见 R4 |
| A4 用户模板协议 | 已落实 | 异步目录、`insert-user-template`、记录 ID＋哈希、单语言正文；[设计](design.md#L68-L74)、tasks 2.4／2.5、E06／E07 |
| A5 Agent 动作 | 基本落实 | `move`／`insert`、`PLANNING_TYPES`、`commandTargets`、错误码；[设计](design.md#L82-L84)、tasks 3.3、W04；根组插入口径见 R3 |
| A6 范围裁决 | 已落实 | 目标日期／时间视图与同 host 运行切换移出；proposal 后续范围、N19、AGENTS／docs 索引、J09 改写 |
| B1 目标视图 | 已落实 | 成果、条件、直接依赖、进展、阻塞、下一步、聊天入口；规范、M01、tasks 4.4 |
| B2 完成证据 | 已落实 | `complete-milestone` 逐项证据、受检版本、v1 历史；[设计](design.md#L98)、tasks 4.3、M02 |
| B3 交付生命周期 | 已落实 | 悬空、取消、替代、重复、哈希失配；[设计](design.md#L96)、M03 |
| B4 迁移排他 | 已落实 | registry schema 2、状态机、锁与队列、旧聚合读取；[设计](design.md#L22-L33)、tasks 1.4／1.5、C04／C05 |
| B5 刷新诊断 | 已落实 | 稳定诊断码与历史 commit 证据；[设计](design.md#L13-L18)、tasks 1.2／1.3、C02／C03 |
| B6 接手索引 | 已落实 | AGENTS、change 索引、docs 索引均更新 |
| C1 撤销范围 | 已落实 | 仅同源有逆向信息的 owner 编辑；旧操作禁用；tasks 2.3／4.5、E04／E05 |
| C2 命名 | 已落实 | `insert-preset`／`insert-user-template`、完成条件、配置／浏览实例已分开 |
| C3 阶段门禁 | 已落实 | tasks 开头的阶段交接表；遗漏项见 R2 |
| C4 i18n | 已落实 | 新增界面、模板列表与预览、W01／W06、E06 的断言 |
| D1 旧根写入 | 已落实 | C04、tasks 1.5 明确新根写入、外部旧根与重接入 |
| D2 回归范围 | 已落实 | 设计 §5、tasks 5.6、J07 给出固定复跑项与其余判定方式 |
| D3 文档陈旧 | 已落实 | `docs/development/workflow.md` 已改为“插件自动测试” |

### 剩余问题

#### R1 · 任务与文档计数不一致（应改）

- **事实。** [作者交接](2026-11-22-author-handoff.md#L22-L24)两处仍写“29 项任务”，但修订后的 [tasks](tasks.md) 有 **30 项**（新增 2.7、4.5，移除原 3.2 运行切换，净增 1）。交接写“147 篇文档”，本机 `check-repo --staged` 为 **146 篇**、0 问题。
- **影响。** 交接是提交前审计依据；任务数和门禁数对不上会让人怀疑矩阵覆盖或校验快照范围。首轮 review 节的 29 项是历史，不应作为修订后的计数。
- **要求。** 把交接两处 29 改为 30，并核对文档数（若 147 是独立快照中的另一文件，说明范围；否则改为 146）。`review.md` 首轮节可保留原文，但复审节已给出 30 项口径。

#### R2 · 阶段交接表漏列 W04、E10、E11（应改）

- **事实。** [tasks](tasks.md#L11-L13) 的阶段表写阶段 2 为“E01–E07、E12”，漏 E11；阶段 3 为“W01、W03–W06、E08／E09”，漏 W04；阶段 4 为“C06–C09、M01–M03／M05”，漏 E10。这三项在各自任务的“矩阵证据”中都存在（2.5、3.3、4.2／4.5）。
- **影响。** 按阶段表把关时，可能在没有 E11／W04／E10 证据的情况下进入下一阶段，削弱“阶段出口”的作用。
- **要求。** 阶段 2 补 E11，阶段 3 补 W04，阶段 4 补 E10；或说明它们由哪一阶段的哪项任务覆盖。

#### R3 · 根组插入的授权口径（须明确）

- **事实。** [会话规范](specs/project-conversation-context/spec.md#L21-L28)要求“根组变更 MUST 有明确授权”，W04 也把“无根组权限”列为拒绝项；但 [设计](design.md#L82)只写“`rootGroup` 需用户在允许 `move` 的 WorkRun 中单独显式授予，根只允许按现有规则在根组内重排”。这没有说明 Agent 的 `insert`（目标父节点为 `null`）是否同样需要 `rootGroup`：若需要，设计应写“允许 move 或 insert”；若不允许，应明确拒绝根级插入并给稳定错误码。当前 `commandTargets` 对根级插入没有可列出的目标节点，W04 也没有单独断言。
- **影响。** 实现者可能让 Agent 在根组插入而不检查 `rootGroup`，或反过来拒绝一个规范未禁止的合法插入；两种情况都与“根组变更 MUST 有明确授权”不一致。
- **要求。** 二选一并同步设计、规范、tasks 3.3、W04：  
  (a) 根级插入同样要求 `rootGroup`，`commandTargets` 以“根组”作为受检范围，W04 加“无根组权限的根级 insert 被拒”；或  
  (b) 明确 Agent 根级插入不在本 change，返回 `root-group-not-allowed`（或新增稳定码），W04 加对应断言。

#### R4 · 替代／完成记录的公开格式说明（应改）

- **事实。** [设计](design.md#L60)规定 `[cona:replacement]` 记录“严格 JSON”，但只列了 `sourceNodeIds`、`replacementNodeId`、`clearsRecordId` 等字段；[设计](design.md#L98)规定完成记录“以版本标记保存输入指纹、逐项条件和证据引用”，但没有给出严格正文格式。tasks 2.2 只要求“结构化替代记录”，tasks 4.3 只要求“逐项证据协议”；与模板格式不同，tasks 2.4 明确要求发布模板 schema／样例。替代和完成记录都是公开资料，其他 Agent 需要能独立读取和核对。
- **影响。** 读端只能按设计散文猜 JSON 形状，容易出现字段名、版本标记或清除记录解释不一致；`[cona:replacement]` 的清除链和完成证据的逐项映射无法由外部 Agent 稳定复核。
- **要求。** 在 tasks 2.2／4.3（或 4.1 的格式交付）中增加替代记录与完成记录的 schema／样例／版本说明，至少写清版本首行、字段、`clearsRecordId` 语义、完成记录正文结构以及外部校验入口；或明确声明这些正文只供本插件读取、不承诺跨 Agent 机器解析，并相应降低“外部读取可核对”的表述。

#### R5 · “新规划命令”Requirement 漏列模板插入（建议）

- **事实。** [树编辑规范](specs/project-tree-editing/spec.md#L50-L57)的“新规划命令的原子发布及回执”列举“批量树操作、里程碑、格式启用及逆向编辑”，没有列 `insert-user-template`；但模板插入同样是新增命令，tasks 2.5 也要求冻结版本与哈希、复用回执。
- **建议。** 在该 Requirement 中补“模板插入”，或说明用户模板插入由“用户流程模板”Requirement 与 `project-command-commit` 覆盖，避免读者误以为它不受同一原子／回执约束。

#### R6 · N19 的行号锚点与旧计数（建议）

- **事实。** [decisions.md](../../../docs/knowledge/decisions.md) N19 链接到 `review.md#L86`；该行当前是 A6 标题，但 review 续写后行号会漂移。首轮 review 正文中的 29 项和旧 E11／W6 计数仍是历史文本，容易被后来读者当成当前状态。
- **建议。** N19 改用节标题锚点（如 `#a6-范围扩展用户已裁决`）或在正文写“见 review 的 A6 节”；review 开头或复审节保留“首轮计数为历史、修订后为 30 项任务／30 Scenario／39 行”的说明。

### 复审结论

**有条件放行。** 首轮 A1–A6、B1–B6、C1–C4、D1–D3 均已按审阅处理落实；方向、范围裁决、数据契约和验收设计比首轮完整，三项校验复跑通过，30 个 Scenario 与 39 行矩阵仍全部 `untested`。

**提交前须明确 R3 的根组插入授权口径。** R1／R2／R4 为应改，建议与 R3 一并完成；R5／R6 为建议。修订后在 `review-response.md` 追加本轮处理并复跑校验，DSH 可据此确认；GLM（Trae）的复审尚未给出，双审未齐前保持待审阅、不提交。

## 审 1 确认（第 3 轮） · DSH · 2026-11-22

审阅者身份：本会话为原审 1，只核对第二轮 R1–R6 的修订，未参与编写或实施。只读确认，不代填其他审阅者意见。

### 逐项核对

| 第二轮意见 | 确认结果 |
|---|---|
| R1 · 计数 | 已修正。[作者交接](2026-11-22-author-handoff.md#L20-L26)两处均为 30 项任务；`--staged`／`--all` 的 146／147 篇差异已解释为 `artifacts/README.md` 是否进入扫描范围，均 0 问题。当前独立计数为 30 任务／30 Scenario／39 行矩阵。 |
| R2 · 阶段交接 | 已修正。[tasks](tasks.md#L11-L14) 阶段 2 补 E11／E12，阶段 3 补 W04，阶段 4 补 E10；E11、W04、E10 的矩阵证据与任务一一对应。 |
| R3 · 根组插入授权 | 已明确。内置和用户模板的 `parentId` 均须为现有父节点；`parentId: null` 在目标范围求值和候选分配前返回 `parent-not-found`，即使持有 `insert`、精确版本和根组重排许可。设计、会话/树规范、tasks 3.3、W04 口径一致。 |
| R4 · 公开格式 | 已补齐。[设计](design.md#L60-L66)给出 `replace`／`clear` 的版本首行、精确字段、解除规则；[设计](design.md#L105-L115)给出完成记录首行和严格 JSON 结构。tasks 2.2／4.3 要求随包与资料根发布 schema、版本说明、正反例及独立校验入口。 |
| R5 · 命令范围 | 已修正。[树编辑规范](specs/project-tree-editing/spec.md#L50-L52)的“新规划命令的原子发布及回执”已纳入“用户模板插入”。 |
| R6 · 裁决引用 | 已修正。N19 改为指向 review 文档的 A6 节，不再依赖行号；当前计数写在本轮与作者交接，历史审阅保留原文。 |

### 复跑校验

| 命令 | 实际结果 |
|---|---|
| `openspec validate complete-r2-project-workflow --type change --strict --no-interactive --json` | `valid: true`，1 项通过、0 问题 |
| `node scripts/check-repo.mjs --staged` | 暂存 17 个拟提交文件：308 个待查文件；洁净度失败 0／警告 0；自测 32 项通过；链接 146 篇 0 问题；双语 5 对 0 问题 |
| `pnpm check:ci` | Node `24.21.0`、pnpm `12.18.0`：build、typecheck、341/341 测试、包边界、协议同步、locale、manifest 全部通过，exit 0 |

### 确认结论

**DSH 确认通过。** 第一轮 A1–A6、B1–B6、C1–C4、D1–D3 与第二轮 R1–R6 均已落实；范围按 2026-11-22 用户裁决收窄，命令、数据、模板、迁移、证据和公开格式契约齐备。30 个产品 Scenario 与 39 行矩阵仍全部 `untested`，29→30 等旧计数只保留在历史审阅节中；本轮以 30 任务／30 Scenario／39 行为准。

GLM（Trae）的[第二轮复核](review.md#L207)与本次 DSH 确认构成双审齐备，可由用户按工作流安排提交；提交、实施与验收仍由用户决定，本审阅者不执行，也不自行 push／tag。
