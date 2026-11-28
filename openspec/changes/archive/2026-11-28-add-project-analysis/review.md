# add-project-analysis 外部审阅

## 审 1 · DSH · 2026-11-25

审阅者身份：change 未记录作者姓名；[proposal](proposal.md#L3) 只写“作者稿”，[AGENTS.md](../../../../AGENTS.md) 记“2026-11-25 编写”。本会话为独立 DSH 上下文，未参与该 change 的编写。若作者为 DSH 会话，本节即[工作流](../../../../docs/development/workflow.md)所称“同模型独立上下文”，不是作者自查；若作者为其他 Agent，本节为独立审 1。只读审阅，未修改 change 工件；本次只新增本文件。

### 范围与方法

- 通读 [proposal](proposal.md)、[design](design.md)、[增量 spec](specs/project-analysis/spec.md)、[tasks](tasks.md) 与 [validation-matrix](validation-matrix.md)。
- 对照主 specs：[portable-project-data](../../../specs/portable-project-data/spec.md)、[project-overview-resume](../../../specs/project-overview-resume/spec.md)、[project-conversation-context](../../../specs/project-conversation-context/spec.md)、[project-tree-editing](../../../specs/project-tree-editing/spec.md)、[plugin-localization](../../../specs/plugin-localization/spec.md)。
- 对照文档：[决策](../../../../docs/knowledge/decisions.md)、[产品设计](../../../../docs/product/2026-11-11-project-management-design.md#接入已有项目与再次分析)、[路线图](../../../../docs/engineering/2026-11-12-plugin-development-roadmap.md#r3项目分析与自主规划)、[总体架构](../../../../docs/architecture/2026-11-11-project-development-architecture.md)、[资料可移植](../../../../docs/architecture/2026-11-12-project-data-portability.md)、[工作流](../../../../docs/development/workflow.md)。
- 对照源码：`packages/project-plugin/test/refresh-acceptance.test.ts`、`src/host/session-directory.ts`、`src/host/project-tools.ts`、`src/application/local-state.ts`、`.github/workflows/ci.yml`、`.workflow/ci.yml`。
- 对照固定宿主 DSH `0.2.2-rc.2` 源码快照：`packages/core/tools/src/index.ts` 的 `restrict()`／`guard()`、`pipeline.ts` 的分派顺序、`packages/core/tool-executor-ptc/src/index.ts`、`packages/ptc-runtime/ptc-runtime-node/` 与 `packages/sandbox/sandbox-policy/README.zh.md`。
- 未启动真实 DSH 宿主；17 个产品场景与 3 条 CI 验收均保持 `untested`。本审阅只做静态核对、源码取证和本地自动测试，不产生产品通过、远程门禁或真实 Agent 结论。

### 复跑校验

本会话默认 Node 为 `v26.13.0`、Git 为 `2.54.0`；以下结果不替代 CI 固定的 Node `24.21.0`／pnpm `12.18.0` 结论。

| 命令或检查 | 环境与实际结果 |
|---|---|
| `openspec validate --all --strict --no-interactive --json`（OpenSpec `1.17.0`） | `11/11` 通过、`0` 失败；活动 change `add-project-analysis` 与 10 份主 spec 均 `valid` |
| `node scripts/check-repo.mjs --all` | 379 个待查文件；洁净度失败 0／警告 0，自测 40 项通过；链接门禁 182 篇文档 0 问题；双语门禁 5 对 0 问题 |
| `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=init.defaultBranch GIT_CONFIG_VALUE_0=master node --test --test-name-pattern=git-unmerged lib-test/test/refresh-acceptance.test.js` | 复现日志中的失败：`checkout --quiet main` 报 `pathspec 'main' did not match any file(s) known to git` |
| 同上，`GIT_CONFIG_VALUE_0=main` | `1/1` 通过 |
| `node --test lib-test/test/*.test.js` | `tests 529`、`pass 529`、`fail 0`，与两份 CI 日志的 529 项总数一致 |
| `git --version` | 本机 `2.54.0`；Gitee Go 的 Git 版本未在 change 或日志中记录 |

补充说明：check-repo 的 182 篇是 Git 索引内文档，新增的 5 个 change 文件尚未跟踪，`182 + 5 = 187`，与交接中“187 篇文档”口径一致；新增文件的相对链接和两个标题锚点已人工核对。完整 `pnpm check:ci` 未在本会话重跑（PATH 无 pnpm，且默认 Node 不是 24.21.0），不能把上表当作 CI 结论。

### 确认通过项

1. **工件齐备、计数一致。** proposal／design／5 个 Requirement 的增量 spec／tasks／validation-matrix 齐全；17 个产品 Scenario 与 CI01–CI03 共 20 条矩阵行逐一对应；8 组 32 项任务全部未勾选、矩阵全部 `untested`；没有预填 review、预勾选或把计划写成已完成。
2. **CI 根因与测试事实可复现。** `setupGit()` 用 `git init --quiet` 继承运行器默认分支，冲突用例却固定切回 `main`（[test](../../../../packages/project-plugin/test/refresh-acceptance.test.ts#L120)、[test](../../../../packages/project-plugin/test/refresh-acceptance.test.ts#L405)）；本地以 `master` 复现同一 `pathspec` 失败、以 `main` 通过，529 项测试总数也与日志一致。修复方向（显式初始分支并保留真实未合并索引）正确。
3. **方向与已定边界一致。** 分析入口对应 N07 的专门聊天，固定 DSH `0.2.2-rc.2` 对应 N11，首版中英资源对应 N13，报告只留本机、可移植摘要和规划应用留给后续 change，符合 N14／N15 与资料可移植设计；R3 明确写为“首切片”，未把规划应用或 R3 整体完成当作本 change 交付。
4. **固定宿主接点的静态理解基本准确。** `restrict()` 要求 agent 作用域、`guard()` 在 pre-execute 策略与审批后执行、全局守卫对每个 agent 调用求值、PTC 嵌套调用走同一 pipeline，均与 rc.2 源码相符；A04／A05 用普通 Session 对照和真实调用拒绝来验收，方向正确。
5. **验证设计分层诚实。** 矩阵按自动、真实文件、固定宿主、真实 Agent 标注环境；A10 的实例隔离、A11–A14 的依据状态、A15 的来源回看、A16 的复盘独立 ID 都有对应任务；没有用文档校验或本地测试冒充产品验收。

### 问题

| ID | 级别 | 摘要 |
|---|---|---|
| A1 | 必改 | `restrict()`／`guard()` 未覆盖 PTC 程序内的直接文件读写，只读与范围边界可被绕过 |
| A2 | 应改 | 修复依赖 Git ≥ 2.28，但 Gitee Go 的 Git 版本未核对，旧版本会让夹具直接失败 |
| A3 | 应改 | 来源回看只覆盖路径失效，未覆盖“路径有效但内容已变”，历史引用可能显示成当前文本 |
| A4 | 应改 | 项目记录／验证记录的读取、交付与引用校验未写清，产品要求的“实际验证记录”可能落空 |
| A5 | 建议 | 完成／中断后的分析 Session 是否接受新用户消息未定义，存在旧绑定被继续使用的歧义 |

#### A1（必改）· PTC 程序内的直接文件读写绕过了工具守卫

- **事实。** [design](design.md#L49-L50) 把只读边界落在 `restrict()` 的可见工具与 `guard()` 的逐次调用上；[tasks 2.2](tasks.md#L16) 要求验证“启用的组合工具路径”。rc.2 的 PTC 执行器让 `run_code` 成为唯一可直接调用的工具（`packages/core/tool-executor-ptc/src/index.ts` 的 `reject` 与 `describe`），程序内的 `import("node:fs/promises").readFile/writeFile` 不是工具调用，不经过 `guard()`；`restrict()` 也不能指名 `run_code`（`packages/core/tools/src/index.ts` 会拒绝保留名）。PTC 的 `vm-script` 说明写明“context 不是安全边界”，而 DSH 文件沙箱是 DSH 源码 `packages/sandbox/README.zh.md` 所述的“文件效果策略”：`read-only` 只拒绝写入，不限制读取。
- **影响。** 在启用 PTC 的 profile 中，分析会话即使所有工具调用都被拒绝，程序仍可读取范围外文件、在范围内写入文件；任务 2.2 只测嵌套工具拒绝即可“通过”，但 A05／A06 的只读与范围边界已经被绕过。这比普通文件工具遗漏更隐蔽，也不在“保护不可用时分析入口不可用”的现有 fallback 触发条件内。
- **建议。** 在设计中明确分析会话使用不含 PTC／`run_code` 的专用 preset 或等价组合（首选），或拒绝 `run_code` 且不提供任何代码执行工具；不能只靠 `restrict()` 隐藏。若固定宿主无法创建非 PTC 会话，按既有 fallback 让概览显示分析执行不可用。把“PTC 程序直接读范围外文件、写范围内外文件”加入 2.2、8.1 与 A05 的证据，记录实际拒绝、程序正文是否进入和执行后文件状态。

#### A2（应改）· 修复依赖 Git ≥ 2.28，但 Gitee Go 的 Git 版本未核对

- **事实。** [design](design.md#L9-L10) 记录 GitHub 为 Git `2.56.1`，Gitee 行只记录 Node／pnpm；修复方案使用 `git init --quiet --initial-branch=main`（[design](design.md#L12)），`--initial-branch` 需要 Git 2.28 及以上。Gitee 日志未给 Git 版本，[tasks 1.5](tasks.md#L11) 只在失败后复跑。
- **影响。** 若 Gitee Go 镜像的 Git 低于 2.28，夹具会在 `git init` 阶段直接失败；1.5 才在远程发现要多跑一轮，且容易把兼容性失败误判为产品回归。修复目标正是恢复两个远程，不能只以 GitHub 的 Git 版本为准。
- **建议。** 在 1.1、1.3、1.4、1.5 与 CI02／CI03 中记录 `git --version`；低于 2.28 时改用 `git init` 后 `git symbolic-ref HEAD refs/heads/main`（或经核对的等价写法），保留真实合并冲突与 `git-unmerged` 诊断断言。Gitee 复跑前先完成这一兼容性判断。

#### A3（应改）· 来源回看未覆盖“路径有效但内容已变”

- **事实。** [design](design.md#L64) 的读取凭证包含所见内容哈希和行范围；[A15](specs/project-analysis/spec.md#L65-L68) 只列映射失效、删除、越界、替换为符号链接；[tasks 5.4](tasks.md#L41) 同样只列失效映射、移除文件和符号链接。A11 只核对报告的依据状态，不核对点击来源后的展示。
- **影响。** 文件仍在但已修改（或行号移动）时，用户点击来源可能看到当前文本，却把历史报告的引用当作同一证据；这违反“来源回看”和“历史凭证保留”的证据语义，也会让 A11 的“依据已变”只停留在状态标签上。
- **建议。** 打开来源时按凭证哈希与行范围复核；不一致时显示历史凭证／变更警告，或拒绝把当前文本标为原引用，并在状态中说明具体来源变化。把该情形加入 A15、5.4 与 6.2 的测试，覆盖同路径修改、行号移动和删除后重建三种情况。

#### A4（应改）· 项目记录／验证记录的读取与引用凭证未写清

- **事实。** [产品设计](../../../../docs/product/2026-11-11-project-management-design.md#接入已有项目与再次分析) 要求分析代码、文档、已有 spec／change、当前规划和实际验证记录；[design](design.md#L40) 允许读取“规划背景和允许引用的已有验证记录”，[design](design.md#L72) 允许用“有效项目记录”支撑事实。但四类分析能力（[design](design.md#L54)）只列项目背景、文件索引、文件正文和报告提交；读取凭证表（[design](design.md#L71)）只描述文件路径、行范围与摘要，没有记录正文的交付与校验规则；[tasks 5.1](tasks.md#L38) 只写“可核对项目记录”。
- **影响。** 实现者可以只把规划当“项目背景”，不交付验证记录正文；或者让 Agent 引用记录 ID 而不核对 `contentHash`／`subjectVersion`，使 A09 的“无效引用”和“历史验证状态”无法稳定验收。产品要求的“实际验证记录”可能实际落空。
- **建议。** 明确项目记录（至少 `verification`）是否属于“项目背景”能力、如何交付正文、如何以记录 ID＋`contentHash`＋`subjectVersion` 校验引用、如何计入报告覆盖；补 5.1／5.2 与 A09 的证据。若首切片不读取验证记录，应在 proposal 的 Impact 和 spec 中明说，而不是保留一个无法验收的“允许引用”。

#### A5（建议）· 完成或中断后的分析 Session 是否接受新消息未定义

- **事实。** [design](design.md#L58) 说重启加载分析会话归属和工具保护后才接受分析工作，既有消息与报告仅作为历史；[A07](specs/project-analysis/spec.md#L41-L44) 只覆盖停止、换源、重启后旧会话尝试读取或提交，没有覆盖正常完成后用户在该 Session 继续输入。
- **影响。** 分析 Session 是真实聊天，用户可以在已完成会话里继续发消息。实现可能沿用旧分析绑定继续读取，或静默形成第二个分析请求，与“每轮独立 Session、新分析走概览”不一致；测试也无法判断这是允许的追问还是越界。
- **建议。** 明确完成后仅作历史导航（输入禁用或重定向到概览），或允许有限只读追问但不得形成第二个终稿；在 7.2 与 A07 增加一条实测，并让 UI 标识“历史分析”状态。

### 其他建议

- [proposal](proposal.md#L37) 的“187 篇文档的链接和双语门禁问题各 0”把两个范围写在一起：链接门禁是 187 篇文档，双语门禁只覆盖 5 对登记文档。建议分开表述，避免读成全量双语检查。
- Requirement 1 说“为具有本机工作副本映射的配置实例提供分析入口”，A02 又要求没有有效映射时显示原因；建议明确入口是“隐藏”还是“显示为不可用并给原因”，避免两种读法分叉。
- A11 的“旧建议提示重新核对”建议加“如有建议”，否则无建议的报告也会被要求显示旧建议提示。
- change 未记录作者姓名，也没有单独的 author-handoff；建议在 proposal 或交接中补作者／会话标识，便于双审和后续追溯。

### 结论

**有条件放行。** 方向、R3 首切片边界、CI 根因与 20 条验收矩阵整体成立；OpenSpec 11/11、仓库门禁 0/0、CI 失败根因与 529 项测试均已独立复现。A1 是提交与实施前必须解决的安全边界，A2–A4 应在提交前补齐设计与验收，A5 为建议。请作者按[工作流](../../../../docs/development/workflow.md)在 `review-response.md` 逐条记录处理与位置，修订后重跑 OpenSpec 严格校验和仓库门禁，再由审 1 复核；双审齐备或用户裁决前不提交。17 个产品场景与 3 条 CI 验收仍全部 `untested`，本审阅不产生任何产品通过或远程门禁结论。

## 审 2 · GLM · 2026-11-25

审阅者身份：GLM-5.3，独立外部 Agent 会话，未参与该 change 的编写与审 1。审 1 一节已在 [review.md](review.md) 中，本审阅阅读后未代填或修改其意见；对其引用的关键事实（CI 失败、固定宿主工具语义）逐项做了独立取证，并补充本审阅自己的发现。只读审阅，未修改 change 工件；本次只追加本节。

### 范围与方法

- 通读 [proposal](proposal.md)、[design](design.md)、[增量 spec](specs/project-analysis/spec.md)、[tasks](tasks.md) 与 [validation-matrix](validation-matrix.md)，核对 17 条 Scenario、32 项任务与 20 条矩阵行的对应关系。
- 对照主 specs 与文档：[project-overview-resume](../../../specs/project-overview-resume/spec.md)、[project-conversation-context](../../../specs/project-conversation-context/spec.md)、[决策](../../../../docs/knowledge/decisions.md)（N07／N11／N13–N15）、[工作流](../../../../docs/development/workflow.md)。
- 对照本仓源码：`packages/project-plugin/test/refresh-acceptance.test.ts`、`src/adapters/fs/path-scope.ts`、`src/domain/relative-path.ts`。
- 对照本机 DSH `0.2.2-rc.2` 源码快照（`~/Developer/tools/deepseek-harness`）：`packages/core/tools/src/index.ts`、`packages/ptc-runtime/ptc-runtime-node/README.zh.md`、`packages/sandbox/sandbox-policy/README.zh.md`。
- 未启动真实 DSH 宿主；17 个产品场景与 3 条 CI 验收保持 `untested`。本审阅只做静态核对、源码取证与本地测试复跑，不产生产品通过、远程门禁或真实 Agent 结论。

### 复跑校验

本会话 Node `v26.13.0`、Git `2.54.0 (Apple Git-157)`，PATH 无 openspec／pnpm；以下结果不替代 CI 固定 Node `24.21.0`／pnpm `12.18.0` 的结论，OpenSpec 严格校验未在本会话复跑（以审 1 的 11/11 记录及编写交接为准，实施阶段须以交付提交重跑）。

| 命令或检查 | 实际结果 |
|---|---|
| `env … init.defaultBranch=master node --test --test-name-pattern=git-unmerged lib-test/test/refresh-acceptance.test.js` | 复现两份日志的失败：`error: pathspec 'main' did not match any file(s) known to git`，用例失败退出 |
| 同上，`init.defaultBranch=main` | `tests 1 / pass 1 / fail 0` |
| `node --test lib-test/test/*.test.js` | `tests 529 / pass 529 / fail 0`，与两份 CI 日志的 529 项总数一致 |
| 夹具源码核对 | `setupGit()` 在 [test](../../../../packages/project-plugin/test/refresh-acceptance.test.ts#L120) 用 `git init --quiet`；`1.3 git-unmerged` 在 [test](../../../../packages/project-plugin/test/refresh-acceptance.test.ts#L405) 写死 `checkout --quiet main` |
| `validateRelativePath`／`resolveInScope` | 均存在并被既有读路径复用（[path-scope.ts](../../../../packages/project-plugin/src/adapters/fs/path-scope.ts#L44)），design 的复用声明属实 |

### 确认通过项

1. **结构完整、计数一致。** 5 个 Requirement／17 个 Scenario、8 组 32 项任务（5+3+5+6+4+3+3+3）与 20 条矩阵行逐一对上；任务全部未勾选、矩阵全部 `untested`，无预填 review 或把计划写成已完成。
2. **CI 根因真实、修复方向正确。** 失败与通过两种配置均在本机独立复现，根因与 [design](design.md#先修复双远程-ci) 一致；“显式初始分支＋同一常量、保留真实冲突与 `git-unmerged` 断言”的修复方向不改变被测语义。
3. **方向与已定边界一致。** 分析入口对应 N07 专门聊天、固定宿主对应 N11、中英资源对应 N13、报告只留本机并推迟可移植摘要对应 N14／N15；R3 明示“首切片”，未把规划应用或发布语义夹带进本 change。
4. **审 1 A1 的技术事实独立核实成立。** DSH rc.2 的 `restrict()` 要求 agent 作用域、保留名 `run_code` 不能被注册也不能被 restrict 指名（`packages/core/tools/src/index.ts` 的 L146／L165／L177）；PTC 运行时 `vm-script` 明确支持 `await import("node:fs/promises")` 且写明“context 不是安全边界”（`ptc-runtime-node/README.zh.md` L72）；文件沙箱 `read-only` 策略只拒写不限读（`sandbox-policy/README.zh.md` L122–L125）。PTC 程序内的直接文件访问确实绕过 `guard()`，只读与范围边界按现有 design 会落空。
5. **验证分层诚实。** 矩阵按自动、真实文件、固定宿主、真实 Agent 标注环境；修复与产品验收分开（CI01–CI03 与 A01–A17），无以本地测试冒充宿主验收的条目。

### 问题

| ID | 级别 | 摘要 | 与审 1 的关系 |
|---|---|---|---|
| B1 | 必改 | PTC `run_code` 路径绕过工具守卫，只读与范围边界可被架空 | 事实同 A1，本审阅独立取证确认，并细化实施断言要求 |
| B2 | 应改 | 修复依赖 Git ≥ 2.28，Gitee Go 的 Git 版本未核对 | 同 A2，补充偏差先例 |
| B3 | 应改 | 来源回看未覆盖“路径有效但内容已变” | 同 A3，spec／tasks 条文已核对属实 |
| B4 | 应改 | 验证记录的交付与引用校验未写清，A09 可能落空 | 同 A4 |
| B5 | 建议 | “无关过程记录”无可测判据 | 本审阅新增 |
| B6 | 建议 | 完成或中断后的分析 Session 是否接受新消息未定义 | 同 A5 |
| B7 | 建议 | PTC 越界写的测试断言需按沙箱模式区分，避免误记守卫生效 | 本审阅新增（B1 细化） |

#### B1（必改）· PTC 程序内的直接文件读写绕过工具守卫

[design](design.md#L49-L50) 把只读边界全部落在 `restrict()`／`guard()` 的工具调用链上，但 rc.2 中启用 PTC 的会话可经 `run_code` 在 `vm-script` 内直接 `await import("node:fs/promises")` 读写文件，不构成工具调用、不经过 `guard()`，且 `restrict()` 无法指名 `run_code`。后果：分析会话即使所有工具调用都被拒绝，程序仍可读取任意路径，A05 的只读边界与 A06 的范围越界、A08 的覆盖与凭证语义全部被架空。必须在设计中明确分析会话使用不含 PTC／代码执行的专用 preset（或拒绝代码执行工具），不能只靠 `restrict()` 隐藏；固定宿主无法实现时按既有 fallback 显示分析执行不可用。同时把该路径加入任务 2.2／8.1 与 A05 的证据。

#### B2（应改）· Gitee Go 的 Git 版本未核对

修复使用 `git init --initial-branch=main`，需要 Git ≥ 2.28；[design](design.md#L9-L10) 只记录了 GitHub 的 Git `2.56.1`，Gitee 行连 Git 版本都没有。该流水线已经出现过“镜像 Node 工具目录没有 24.21.0、回退安装”的工具链偏差先例，Git 版本偏差风险不是假设。应在 1.4／1.5 与 CI02／CI03 记录 `git --version`，低于 2.28 时改用 `git symbolic-ref HEAD refs/heads/main` 或等价方案；Gitee 复跑前先完成该判断。

#### B3（应改）· 来源回看只处理“打不开”，不处理“打开后内容已变”

[A15](specs/project-analysis/spec.md#L65-L68) 与 [tasks 5.4](tasks.md#L41) 的失败列表均为映射失效、删除、越界、替换为符号链接——这些是导航层面打不开的情形。文件仍在但内容或行号已变时，用户会看到当前文本并被当作历史证据，违反“历史凭证保留”的语义，A11 的“依据已变”也只停在标签上。应按凭证哈希与行范围复核，不一致时显示历史凭证或变更警告，并把同路径修改、行号移动、删除后重建三种情形补入 A15／5.4／6.2。

#### B4（应改）· 验证记录的读取与引用凭证未定义

产品设计要求分析“实际验证记录”，[design](design.md#L40) 允许读取“允许引用的已有验证记录”，但四类分析能力与读取凭证表都没有定义记录正文的交付方式和引用校验（记录 ID＋`contentHash`＋`subjectVersion`）。实现者可以只把规划当“项目背景”而从不交付验证记录正文，使 A09 的“无效引用”“历史验证状态”没有稳定判据。应明确 `verification` 记录是否属于分析能力、如何交付与校验；若首切片不读取，应在 proposal Impact 与 spec 中明说，删去无法验收的“允许引用”。

#### B5（建议）· “无关过程记录”缺可测判据

依据状态表（[design](design.md#L84)）用“无关过程记录增加……不触发过时”定义“当前”，A13 的验收也是“仅追加与规划无关的过程记录”。但“无关”只有隐式含义，测试无法区分“无关”与“有关”：追加一条被规划引用的记录（若存在此机制）算哪一类？建议把判据落成可测条件——例如“追加后 planVersion 与规划投影均不变即为无关”，并让 A13／6.2 的用例按该判据构造。

#### B6（建议）· 完成或中断后的分析 Session 输入策略未定义

分析 Session 是真实聊天，用户可在已完成的会话里继续输入。[design](design.md#L58) 只定义了重启后的行为（历史导航、新分析走概览），A07 也只覆盖停止／换源／重启，未覆盖正常完成后继续发消息。应明确完成后仅历史导航或允许有限只读追问，并在 7.2／A07 增加一条实测与 UI 状态标识。

#### B7（建议）· PTC 测试断言需按文件沙箱模式区分

B1 的越界读在 `read-only` 文件沙箱下不受进程级拦截，是主要风险；但越界写在 `read-only` 模式会被进程级文件策略拒绝——此时“程序写文件失败”不能记作工具守卫生效的证据，反之在 `workspace-write` 或沙箱不可用的部署下写路径也须实测。任务 2.2／8.1 的证据应区分“guard() 拒绝工具调用”与“进程沙箱拦截副作用”两层，避免误判。

### 其他建议

- change 未记录作者姓名或会话标识（同审 1 建议），双审的作者分离与后续追溯都依赖它，应在 proposal 或交接中补。
- proposal “187 篇文档的链接和双语门禁问题各 0”合并了两个不同范围的门禁（链接全量、双语仅登记对），建议分开表述（同审 1）。
- Requirement 1 “提供分析入口”与 A02 “缺少映射显示原因”存在“隐藏入口”与“显示不可用”两种读法，应明确一种（同审 1）。

### 结论

**有条件放行。** 与审 1 结论一致但基于本会话独立取证：CI 夹具根因在两种 `init.defaultBranch` 配置下分别复现失败与通过，全量 529 项测试通过，`restrict()`／PTC 运行时／文件沙箱的语义在 rc.2 源码中逐条核实，B1 必改成立。作者须先解决 B1，并在提交前补齐 B2–B4 的设计与验收；B5–B7 为建议。请按[工作流](../../../../docs/development/workflow.md)在 `review-response.md` 逐条记录处理与位置，修订后重跑 OpenSpec 严格校验与仓库门禁；双审已齐，经确认或用户裁决后再提交。17 个产品场景与 3 条 CI 验收仍全部 `untested`，本审阅不产生任何产品通过或远程门禁结论。

### 审 2 复核 · GLM · 2026-11-25

范围：通读修订后的 proposal、design、增量 spec、tasks、validation-matrix 及 [review-response](review-response.md)，对作者新引入的宿主接点与修复方案做独立取证，不重复首轮已复现的 CI 失败与 529 项测试。

逐条核对结果：

- **B1／A1（必改）已解决。** [执行器设计](design.md#分析会话的执行器) 改为专用 preset＋作用域原生执行器＋守卫＋不可用 fallback，spec R2／A05、任务 2.1–2.3／4.4／8.1 同步。rc.2 事实核实：`agentPreset` 存在于 `packages/core/agent/src/index.ts`（L86）与 session 类型；`setExecutor()` 为作用域注册、每作用域唯一、`selectExecutor` 取近层后回退部署默认（`packages/core/tools/src/index.ts` L325 起）；`NativeToolExecutor` 直接执行可见能力、无 PTC。方案技术上成立。
- **B2／A2（应改）已解决。** 夹具改为 `git init --quiet` 后、首次提交前 `git symbolic-ref HEAD refs/heads/main`，不依赖 Git 2.28。本会话以两种 `init.defaultBranch` 配置独立验证：均成功切回 `main`、merge exit 1、3 条未合并索引，产生真实冲突。两远程与 CI01–CI03 均加 `git --version`；Gitee 旧日志 Git 版本明示未知，与实际相符。
- **B3／A3（应改）已解决。** [历史来源](design.md#验证记录与历史来源) 按当前哈希与原行范围复核；A15 与任务 5.4、6.2 覆盖同路径改写、行号移动、删后重建与记录正文／元数据变化，默认呈历史凭证、显式操作才看当前文件。
- **B4／A4（应改）已解决。** verification 索引与正文读取进入 spec R3 的 MUST；四项凭证（记录 ID、`contentHash`、验证主体、`subjectVersion`）校验落入 design、任务 5.1／5.2 与 A09；`readScopedFile` 在本仓 `src/adapters/fs/source-files.ts` 已存在，引用属实。
- **B5（建议）已解决。** A13 与任务 6.2 的“无关记录”落成可测判据：未引用＋`planVersion` 与既有引用凭证不变。
- **B6／A5（建议）已解决。** A07 扩到完成后新输入；`agent/pre-step` 的 `PreStepDecision` 含 `{ kind: 'reject' }`（`packages/core/agent/src/runtime-types.ts` L139–146），后台拒绝步骤不进模型的接法可行。
- **B7（建议）已解决。** 任务 2.2／8.1 与 A05 要求标注沙箱模式、执行器拒绝与沙箱副作用拒绝分别取证，明示“单有文件未变化或沙箱拒写不能证明没有代码被执行”。
- **其余建议均已落实。** proposal 补作者（Codex）；门禁按“189 篇链接／登记的 5 对双语”分开表述；spec R1 明确入口“条件缺失时显示不可用及原因”；A11 改为“如有建议则提示重新核对”。

结构复核：32 项任务（5+3+5+6+4+3+3+3）全未勾选、17 个 Scenario、20 条矩阵行全 `untested`，计数一致；review-response 内部链接锚点与 design 各新章节标题一一对应。

残留（微小修，不阻塞）：proposal L3 “`[作者回应](review-response.md)所属里程碑`”缺一个分隔符（空格或句号），提交前顺手修即可；本 review 首轮两节引用的 design 行号锚点因修订漂移，属时点记录不改。

**复核通过。** B1 必改与 B2–B4 应改均已按承诺落实且技术事实独立核实成立，B5–B7 采纳到位。作者修订稿已重跑 OpenSpec 11/11 与仓库门禁 0/0（以 review-response 记录为准，提交前如再有改动须重跑）。按[工作流](../../../../docs/development/workflow.md)待审 1 亦复核后即可提交；执行器与历史会话拒绝目前只有静态取证，实施阶段须以任务 2.2／2.3／8.1 的隔离实测兑现。17 个产品场景与 3 条 CI 验收保持 `untested`，本复核不产生产品或远程门禁结论。

## 审 1 复核（第 2 轮） · DSH · 2026-11-25

复核者身份：同前，独立 DSH 上下文；作者身份已在 [proposal](proposal.md#L3) 记录为 Codex，本节仍不代填审 2。只读复核，未修改工件。审 2 的 B1–B7 确认仍由 GLM 出具；本节核对作者修订位置与可执行性，并对 A1–A5 作审 1 确认。

### 复核范围与方法

- 重读修订后的 [proposal](proposal.md)、[design](design.md)、[增量 spec](specs/project-analysis/spec.md)、[tasks](tasks.md)、[validation-matrix](validation-matrix.md) 与 [作者回应](review-response.md)，逐项对照原审 A1–A5、B1–B7。
- 在 DSH rc.2 源码快照核对新引入的接点：`SessionController.create` 的 `agentPreset`、`ToolsService.setExecutor()` 的近层选择、`packages/core/tool-executor-native`、`packages/core/agent/src/runtime-types.ts` 的 `agent/pre-step`，以及 PTC／沙箱语义。
- 未启动真实 DSH 宿主；17 个产品场景与 3 条 CI 验收仍全部 `untested`。本复核只做静态核对与本地测试，不产生产品通过或远程门禁结论。

### 复跑校验

本会话 Node `v26.13.0`、Git `2.54.0`；OpenSpec 为独立安装的 `1.17.0`。以下结果不替代 CI 固定 Node `24.21.0`／pnpm `12.18.0` 的结论。

| 命令或检查 | 环境与实际结果 |
|---|---|
| `openspec validate --all --strict --no-interactive --json` | `11/11` 通过、`0` 失败；修订后的 change 与 10 份主 spec 均 `valid` |
| 暂存本 change 全部工件、`AGENTS.md` 与索引后运行 `node scripts/check-repo.mjs --staged` | 386 个待查文件；洁净度失败 0／警告 0，自测 40 项通过；链接门禁 188 篇文档 0 问题；双语门禁 5 对 0 问题。运行后已取消暂存 |
| 在临时库分别以 `init.defaultBranch=master`、`main` 执行 `git init --quiet` 后 `git symbolic-ref HEAD refs/heads/main`，提交、建 `branch-x` 并切回 | 两组初始分支均为 `main`，提交成功，`branch-x` 可创建，切回 `main` 成功 |
| 已编译产物 `node --test lib-test/test/*.test.js` | `tests 529`、`pass 529`、`fail 0` |
| DSH rc.2 源码核对 | `SessionCreateRequest`／`SessionCreateValue` 均有 `agentPreset`；`setExecutor()` 按 scope 取最近层；`tool-executor-native` 插件调用 `setExecutor`；`agent/pre-step` 可返回 `{kind:'reject'}`；PTC 程序可直接 `import("node:fs/promises")`，`read-only` 只限制写入 |

链接门禁实测为 188 篇，与 [作者回应](review-response.md#L22) 的 189 篇相差 1；这可能是快照是否计入 `artifacts/README.md` 等被跳过目录的口径差异，不影响 0 问题的结论，但应回填一致数字。

### 逐项确认

- **A1／B1 已落实。** [design](design.md#L54-L56) 已把执行器选择作为第一道边界：分析 preset 使用 `tool-executor-native`，PTC 程序正文明确不在工具守卫覆盖内，`read-only` 只限制写入；[spec](specs/project-analysis/spec.md#L22-L24) 的 Requirement 2 与 [A05](specs/project-analysis/spec.md#L31-L34)、[tasks 2.1–2.3](tasks.md#L15-L17)／[4.4](tasks.md#L32)／[8.1](tasks.md#L57)、[矩阵 A05](validation-matrix.md#L14) 都要求在正文前拒绝并分别记录工具拒绝与沙箱副作用。源码核实 `agentPreset` 创建、`setExecutor()` 近层覆盖、原生执行器插件、`agent/pre-step` 与 PTC 直接文件访问的语义均成立；执行器或守卫无法核对时回退为入口不可用，符合必改要求。
- **A2／B2 已落实。** [design](design.md#L12) 改为 `git init --quiet` 后 `git symbolic-ref HEAD refs/heads/main`，[tasks 1.1–1.5](tasks.md#L7-L11) 与 [CI01–CI03](validation-matrix.md#L7-L9) 都要求记录 `git --version` 并保留真实冲突。两组默认分支的临时库实测成立，且不再依赖 Git 2.28。
- **A3／B3 已落实。** [design](design.md#L76) 增加当前哈希、原行范围和验证记录凭证的复查；[spec A15](specs/project-analysis/spec.md#L65-L68)、[tasks 5.4](tasks.md#L41)／[6.2](tasks.md#L46)／[7.2](tasks.md#L52) 与 [矩阵 A15](validation-matrix.md#L24) 已覆盖同路径改写、行号移动、删后重建及验证记录变化，并要求显式操作才打开当前正文。
- **A4／B4 已落实。** [design](design.md#L74) 定义同实例、同代际的 `verification` 索引与绑定正文入口，核对记录 ID、`contentHash`、主体、`subjectVersion` 与实际字节；[spec](specs/project-analysis/spec.md#L46-L48) 的 Requirement 3、[A09](specs/project-analysis/spec.md#L55-L58)、[tasks 5.1](tasks.md#L38)／[5.2](tasks.md#L39)／[8.1](tasks.md#L57) 与 [矩阵 A09](validation-matrix.md#L18) 已覆盖无效引用、错误哈希／受检版本、正文缺失和历史状态。
- **A5／B6 已落实。** [design](design.md#L60) 明确完成、中断或重启后的 Session 进入历史状态，宿主聊天页可输入时由 `agent/pre-step` 拒绝新模型步骤；[spec A07](specs/project-analysis/spec.md#L41-L44)、[tasks 2.3](tasks.md#L17)／[4.6](tasks.md#L34)／[7.2](tasks.md#L52) 与 [矩阵 A07](validation-matrix.md#L16) 已覆盖完成、中断、换源、重启后的输入、读取和保存。
- **B5 已落实。** [design](design.md#L96) 与 [spec A13](specs/project-analysis/spec.md#L84-L87)、[task 6.2](tasks.md#L46)、[矩阵 A13](validation-matrix.md#L22) 已把判据落成可测条件：追加未引用记录且 `planVersion` 与既有引用凭证不变时保持当前，范围外改动同样不触发过时。
- **B7 已落实。** [design](design.md#L56) 与 [tasks 2.2](tasks.md#L16)／[8.1](tasks.md#L57)、[矩阵 A05](validation-matrix.md#L14) 已要求分别记录工具拒绝与沙箱副作用拒绝，避免把 `read-only` 拒写误记成执行器／守卫生效。

### 剩余问题

| ID | 级别 | 摘要 |
|---|---|---|
| R1 | 微小修 | [proposal](proposal.md#L3) 的 `[作者回应](review-response.md)所属里程碑` 缺断句，读成“作者回应所属里程碑” |
| R2 | 微小修 | [作者回应](review-response.md#L22) 的链接门禁 189 篇与本次暂存快照实测 188 篇不一致，应回填一致口径 |
| R3 | 应改 | Requirement 2 的允许集合只写“范围核对的读取”，未列设计已允许的项目背景与验证记录读取，与 A09 冲突 |
| R4 | 建议 | 专用分析 preset 的注册／组成与注册失败路径未写明，A1 的执行器修复缺少落地位置 |
| R5 | 建议 | 分析创建应明确绕开 R2 空白 Session 复用，避免分析注入已建链接的空聊天 |

#### R1（微小修）· proposal 第 3 行链接后缺断句

[proposal](proposal.md#L3) 现为“……待复核。 [外部审阅](review.md) · [作者回应](review-response.md)所属里程碑为 R3 首切片……”。链接后直接接“所属”，会读成“作者回应所属里程碑”。在链接后加“。”或“；”，或把“所属里程碑”另起一句即可；不影响技术结论。

#### R2（微小修）· 链接门禁计数回填

暂存同一批工件（含 `review.md`、`review-response.md`）后实测链接门禁 188 篇、0 问题；[作者回应](review-response.md#L22) 记录 189 篇。差异很可能来自快照是否计入被跳过的 `artifacts/README.md` 等文件，但交接数字应可复核。请以实际暂存快照回填 188，或说明 189 的快照范围；不影响门禁结论。

#### R3（应改）· Requirement 2 的允许集合与设计不一致

[spec Requirement 2](specs/project-analysis/spec.md#L22-L24) 只写“只允许经过范围核对的读取和本机报告保存”，但 [design](design.md#L54) 允许“项目背景、索引、受限文件读取、验证记录读取和本机报告保存”，[proposal](proposal.md#L14) 的同一句也只列“范围内读取、同实例已校验的验证记录正文和私有报告保存”，未列项目背景／规划背景；[A09](specs/project-analysis/spec.md#L55-L58) 更要求读取并核对 `verification` 正文。规范应把允许集合写成“项目背景（规划与同实例已校验的验证记录）＋经范围核对的文件读取＋本机报告保存”，proposal 的允许集合同步列全，否则实现者可依据 Requirement 2 拒绝验证记录或规划背景读取，使 A09 无法验收。

#### R4（建议）· 补分析 preset 的注册与组成

[design](design.md#L47) 已说明通过 `agentPreset` 选择专用组合，[design](design.md#L54) 已规定原生执行器与允许能力，但没有写明插件在何处注册该 preset（例如 `agentPresets.register` 或随包提供的 preset 定义）、由哪些模块组成，以及注册／解析失败时如何回退。`SessionController.create({ agentPreset })` 只有在 preset 已注册时才可执行；建议在 2.1 或 4.2 明确注册路径、preset 组成（原生执行器＋允许工具，不含 PTC／Shell／编辑）和失败诊断，避免实施时才发现接点缺失。

#### R5（建议）· 分析创建绕开空白会话复用

现有 `packages/project-plugin/src/host/session-directory.ts` 的 `createSession()` 会在同 cwd 找到空白 Session 时复用其 ID。如果分析创建沿用该路径，可能把分析绑定注入一个已被普通聊天链接、但尚未发消息的空白会话；`agentPreset` 也可能与既有会话的组合冲突。建议在 4.2／A01 增加“分析不复用空白会话，或核对空白会话未关联且无既有 preset”的用例，并在设计中写明。

### 复核结论

**技术结论通过。** A1–A5／B1–B7 均已按同一口径落实；OpenSpec `11/11`、暂存仓库门禁 0 问题、529 项测试通过、`symbolic-ref` 初始分支方案实测成立，A1 的 `agentPreset`／原生执行器接点也与 rc.2 源码一致。R1、R2 是提交前的微小修，R3 是提交前应改的规范一致性条文；R4、R5 是实施时的建议，不改变本次技术结论，但应在 2.1／4.2 的任务记录中确认。作者完成 R1–R3 并在 [作者回应](review-response.md) 追加第 2 轮记录后即可提交；审 2 的最终确认仍由 GLM 出具。17 个产品场景与 3 条 CI 验收仍全部 `untested`，本复核不产生任何产品通过或远程门禁结论。

## 审 1 确认（第 3 轮） · DSH · 2026-11-25

确认者身份：同前，独立 DSH 上下文；作者为 Codex，GLM 复核节已在同一 review。本轮只确认 DSH 审 1 的 R1–R3 与 R4／R5，不代 GLM 作最终确认。

### 确认范围与结果

- **R1 已修。** [proposal](proposal.md#L1-L3) 把审阅链接放在首段末，“所属里程碑”另起一段；原“作者回应所属里程碑”的断句问题不再存在。
- **R2 已修。** [proposal](proposal.md#L37) 按最终 `--staged` 快照记 188 篇；[作者回应](review-response.md#L33) 解释了独立快照 189 篇（带 `.git`，`git ls-files` 计入 `artifacts/README.md`）与 `--staged` 检出快照 188 篇（无 `.git`，目录扫描跳过 `artifacts/`）的口径差异。两种口径均 0 问题，数字现在可复核。
- **R3 已修。** [spec Requirement 2](specs/project-analysis/spec.md#L22-L24) 的允许集合已列为“规划背景＋同实例已校验验证记录索引及正文＋经范围核对的文件列举和读取＋本机报告保存”；[proposal](proposal.md#L14) 与 [design](design.md#L56) 使用同一集合，A09 的验证记录读取不再与允许集合冲突。
- **R4 已落实为设计。** [design](design.md#L54) 明确随包 `cordis.patch.yml` 声明 `@deepseek-ai/dsh-agent-preset`，稳定 ID `cona-project-analysis`，由原生执行器和分析模块组成，PTC／Shell／编辑／代理不装配；注册失败诊断进入 [task 2.1](tasks.md#L15) 与 [A05](validation-matrix.md#L14)。
- **R5 已落实为设计。** [design](design.md#L47) 使用 `SessionController.create({ workspaceId, agentPreset })` 且省略 `sessionId`；[task 4.2](tasks.md#L30) 与 [A01](validation-matrix.md#L10) 用已关联的普通空白 Session 验证分析不复用、不改变其关联。

### 复跑校验

| 检查 | 环境与实际结果 |
|---|---|
| `openspec validate --all --strict --no-interactive --json` | OpenSpec `1.17.0`：`11/11` 通过、`0` 失败 |
| `node scripts/check-repo.mjs --all` | 洁净度失败 0／警告 0，自测 40 项通过；链接门禁 189 篇 0 问题；双语门禁 5 对 0 问题 |
| `node --test lib-test/test/*.test.js` | `tests 529`、`pass 529`、`fail 0` |
| 提交内容 | `git show --stat` 为 9 个工件／索引文件，包含 proposal、design、spec、tasks、matrix、review、review-response；未改产品源码 |

### 确认结论

**审 1 确认通过。** R1–R3 已修复，R4／R5 已在设计、任务和矩阵落实，未发现新的技术阻塞。本次提交包含双方审阅记录、作者第二轮回应、全部 change 工件与本节确认；提交哈希以本次修订后的提交为准。执行器选择、历史会话拒绝、preset 注册和空白会话隔离目前仍只有纸面设计，必须由实施阶段的 2.1／2.2／2.3／4.2／8.1 隔离实测兑现；17 个产品场景与 3 条 CI 验收保持 `untested`，本确认不产生产品通过或远程门禁结论。
