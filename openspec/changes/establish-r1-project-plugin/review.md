# R1 change 外部审阅 · 第 1 轮

日期：2026-11-12
审阅对象：`openspec/changes/establish-r1-project-plugin/`（编写完成、尚未提交的提案）
审阅执行：用户本轮安排的外部审阅 Agent，非编写 Agent 自查。本文件按 `docs/development/workflow.md` 第 9 条产生；不预填 `review-response.md`，不虚构审阅者或结论。
审阅性质：纸面与静态核对。未启动 DSH、未加载插件、未运行任何业务场景；change 内所有运行验证仍为 `untested`。本机 `Developer/tools/deepseek-harness/` 的 rc.2 源码快照属仓库外材料，仅用于核对源码事实，不构成运行证据。

## 一、总体意见

**需修订后复查，暂不放行提交。**

A1、A2 属于 `docs/development/workflow.md` 第 11 条「仍影响目标、契约或实施可行性的问题」：前者决定 Agent 写入能否在不绕过绑定的前提下成立，后者决定其他 Agent 能否按公开协议独立复算规划指纹（N15）。两者不能只在 `review-response.md` 里标注「延后」后提交。B、C 类建议一并处理，以免提交后验收口径与依据记录失真。

修订后由编写 Agent 按工作流逐项写 `review-response.md`、重跑校验与门禁、再提交。本轮审阅不代表实施授权变化，也不代表提案已验收或可归档。

## 二、审阅范围与依据

已通读 change 全部 11 个工件：`proposal.md`、`design.md`、`tasks.md`、`validation-matrix.md`、`.openspec.yaml` 及 6 份增量 spec。

对照依据：

- `docs/knowledge/decisions.md` N01–N15、D01–D10 及沿用工程纪律；`AGENTS.md` 红线与门禁。
- `docs/product/2026-11-11-project-management-design.md`、`docs/architecture/2026-11-11-project-development-architecture.md`、`docs/architecture/2026-11-12-project-data-portability.md`、`docs/architecture/2026-11-12-plugin-i18n-design.md`。
- `docs/engineering/2026-11-12-plugin-development-roadmap.md`（R1 范围、必须反例、完成标准）、`docs/product/2026-11-12-project-roadmap-design.md` 相关口径。
- `docs/reviews/2026-11-12-dsh-rc2-development-readiness.md`、`docs/research/2026-11-11-dsh-project-management-review.md`、`docs/research/2026-11-11-dsh-host-capability-review.md`。
- `openspec/config.yaml` 的 rules／conventions、`docs/development/workflow.md`、`docs/README.md` 命名规则。
- 仓库外：本机 DSH `0.2.2-rc.2` 源码快照（根包版本已核对为 `0.2.2-rc.2`），用于抽查 `principalOf`、`ToolRunContext`、`Agent.id`、`source.rpcId`、`dshHomePath()`、`engines.dsh` 兼容检查及 `agent/pre-step`、`agent/inbox/claimed`、`turn/start`、`turn/end` 等符号。

## 三、校验结论

| 项目 | 命令／方法 | 结果 |
|---|---|---|
| OpenSpec change 严格校验 | `npx --yes @fission-ai/openspec@latest validate establish-r1-project-plugin --strict --no-interactive`（CLI 2.0.0） | `pass`；输出 `Change 'establish-r1-project-plugin' is valid`，未改动工作区 |
| 仓库门禁 | `node scripts/check-repo.mjs --all` | `pass`；洁净度 0 失败 0 警告、链接 42 篇 0 问题、双语 5 对 0 问题，自测全通过 |
| 工件结构静态核对 | 逐文件解析标题与场景 | `pass`；6 能力 ↔ 6 specs ↔ proposal Capabilities 一致；31 个 Requirement / 69 个 Scenario，WHEN／THEN 数量逐份匹配；34 项 tasks 全未勾选；37 条 V 场景全 `untested` |
| 编写 Agent 所用 OpenSpec 版本的校验记录 | 查 `openspec/config.yaml`、change 各工件与仓库文档 | `blocked`，见 B4 |
| 插件加载、真实 Host／Agent、文件中断注入等运行验证 | 无插件代码与安装环境 | `untested` |

注：CLI 2.0.0 是本次审阅临时补跑的版本，仓库未声明编写 change 时「所用 OpenSpec 版本」，该结果不能替代编写 Agent 的版本化校验记录。

## 四、问题清单

### A 类 · 必须修订，影响契约或实施可行性

#### A1 · Remote owner 判据与 Agent 工具准入路径混用，`principalOf` 语义陷阱未落成设计规则

- 位置：`design.md` §5（第 102、118、124 行）、§6（第 122–126 行）、§7（第 143–166 行）；`tasks.md` 2.4（第 18 行）；`specs/project-conversation-context/spec.md`「可信调用上下文与有限规划授权」。
- 依据：`design.md` 第 102 行把 R1 默认写绑定定在「宿主 owner 入口、非 owner 拒绝」，并要求「不能把没有 Remote invocation 的调用自动当 owner」；第 124 行又要求所有写入口在统一提交序列的第 1 步「校验可信主体」。第 118 行说明 Agent 工具的调用归属由适配器从 `ToolRunContext` 与 WorkRun 绑定提供。本机 rc.2 快照 `packages/typert/protocol/src/principal.ts:14-17` 显示 `principalOf(invocation)` 对 owner 与「Remote call 之外的可信进程内代码」**都返回 `undefined`**，仅非 owner 返回 Principal；`packages/api/remote-access/src/index.ts:236-238` 显示宿主自身靠 `ctx.invocation === undefined` 单独判定进程内调用。也就是说，`principalOf` 为空无法区分「owner 的 Remote 调用」与「Agent 工具这类无 Remote invocation 的进程内调用」。
- 问题：design 没有把两条准入路径的主体判据分开定义。UI 路径需要「`ctx.invocation` 存在且 `principalOf` 为空 ⇒ owner」；Agent 工具路径**没有** Remote invocation，主体应完全来自 `ToolRunContext` 捕获的实际 Agent／活动 WorkRun 绑定版本，而不是 owner principal。§6 却对两者使用同一个「校验可信主体」步骤。
- 影响：实现时若以 `principalOf(...) === undefined` 判 owner，Agent 工具调用会被误当 owner 而可能跳过 WorkRun 绑定核对，直接违背 N05／架构基线「不信模型自报、不由浏览或历史恢复授权」；若反过来要求「必须存在 Remote invocation 才放行」，则 Agent 工具全部被拒，R1 的 V37 闭环无法完成。这是 R1 最关键的可信执行边界（design 自己也把「请求／turn 无法可信对应」列为风险）。
- 建议：① 在 `design.md` §5／§7 明确写出两条准入路径的判据表，声明 Remote 路径与工具路径是**不同**的可信主体来源，统一提交序列第 1 步按入口分派校验，不得共用一个 owner 判断；明确「无 Remote invocation 的工具调用不得取得 owner 身份，也不得因缺少 invocation 被自动拒绝」。② 把 `ctx.invocation` 存在性 + `principalOf` 组合判据、以及工具路径无 invocation 的实测结果列入 `tasks.md` 2.4 的必须观察项与 V25。③ 在 `specs/project-conversation-context/spec.md` 补一个反例场景：进程内工具调用／伪造 Remote 主体不得仅凭 `principalOf` 为空取得 owner 或任何写资格。④ 该结论须记为 `untested` 直到 2.4 真实诊断插件跑过。

#### A2 · `v1-plan` 规范化序列化规则不足以让其他实现复算同一指纹

- 位置：`design.md` §3（第 81–88 行，尤其第 83、85 行）；`formats/v1/` 交付物（第 29、62 行）；`tasks.md` 1.3、1.5；`specs/portable-project-data/spec.md`「规划指纹与格式兼容」。
- 依据：第 85 行规定「所有对象键按 UTF-16 码元序升序递归序列化为无多余空白的 JSON；值用 JSON 字符串转义和安全整数表示」，第 83 行要求拒绝未知字段、孤立代理字符。spec 要求「读取方 MUST 按公开规范重新计算 `planVersion`」；`docs/architecture/2026-11-12-project-data-portability.md` 第 85 行写明「准确规范化规则与样例在格式 schema 中确定」，N15 要求其他 Agent 不依赖 DSH 即可读改并校验。
- 问题：「JSON 字符串转义」没有定义到可独立实现的程度：非 ASCII（中文）是否原样输出还是 `\uXXXX`、控制字符与 `"`、`\`、`/` 的转义形式、`\u` 大小写、U+2028／U+2029 处理、排序是否覆盖嵌套对象内所有键、哪些数组算「集合」、安全整数之外出现布尔／null 时的处理，均未写死。不同语言的 JSON 序列化器在这些点上默认行为不同，两个实现可以对同一份合法资料算出不同 `planVersion`，而双方都会认为对方「自报指纹不符」。第 86 行只承诺「公开说明和测试提供固定输入／期望散列」，把判据放在测试向量而非协议正文里。
- 影响：直接冲击 N15（其他 Agent 可读可校验）与跨副本基线核对；一旦 R2 引入第二种实现，冲突会在 Git 合并后以「指纹不符」形式爆发，且此时无法判断是谁算错。
- 建议：① 在 `formats/v1/` 的协议文件（而非仅测试）给出可执行的规范化伪代码或明确指定「等价于某语言 JSON.stringify 语义 + 键递归排序」的全部细则，写死字符串转义、键序、集合白名单、数值与布尔／null 的取值范围；② 把固定输入／期望散列（含中文、键序、缩进、记录追加、同级重排、目标变化）作为协议附带的强制一致性向量随资料分发；③ 明确「资料携带的 schema 副本仅供阅读，校验以安装包内版本为准」不排除独立实现，独立实现必须能复算；④ 在 V11 增加「由第二份独立实现复算同一资料得到相同散列」的观察项。

### B 类 · 影响验收完整性，建议修订

#### B1 · R1 端到端判据 V37 与路线图完成标准不对齐

- 位置：`validation-matrix.md` 第 45 行（V37）、第 64 行完成判据；`tasks.md` 7.1（第 56 行）；`docs/engineering/2026-11-12-plugin-development-roadmap.md` 第 38 行。
- 依据：路线图 R1 完成标准明确要求闭环演示「同时核查卸载清理和 Client 重连」；V37 只列「预构建安装→小树保存→关联聊天→真实 Agent 调整→UI 已提交→重启恢复」，7.1 同样未含卸载／重连。卸载／重载在 V04、重连在 V32 各自有条目，但没有组合到端到端脚本。
- 影响：分散条目各自 `pass` 时，仍可能没有验证「已保存资料在卸载后重载、断线重连后仍与已提交事实一致」这一组合行为；完成判据又规定 V 场景含 `untested` 即 R1 不标完成，容易被误读为已覆盖。
- 建议：在 V37 显式引用 V04／V32 作为端到端脚本的必做步骤，或新增一条组合场景；同步补进 `tasks.md` 7.1／7.2，并在矩阵「路线图 R1 必须反例映射」表补一行映射。

#### B2 · 「树与路线图显示一致」的 R1 口径收缩未显式记录

- 位置：`validation-matrix.md` 第 30、39 行（V30／树与摘要一致）、`design.md` 第 14 行、`specs/project-panel-sync/spec.md`「多投影一致」；依据 `docs/engineering/2026-11-12-plugin-development-roadmap.md` 第 54 行。
- 依据：路线图必须场景写「树与路线图显示一致」；R1 不交付路线图 UI，改用「规划摘要」作第二投影，design 与 spec 已各自说明，属于合理收缩。
- 影响：收缩本身没问题，但矩阵映射表把「初读新变更、乱序和旧连接」直接映射为 V30、V31，未注明「本轮以规划摘要代替路线图视图」；R1 通过后容易被读成路线图一致性已验收，与 N12 的范围产生歧义。
- 建议：在 `validation-matrix.md` 映射表该行或「完成判据」加一句口径声明，并在 `proposal.md` 的范围收缩段落点明；R2 再补路线图视图一致性。

#### B3 · 「接入外部已有 v1 资料并沿用原身份」在验证矩阵无独立条目

- 位置：`validation-matrix.md` V05、V06、V12；`design.md` Migration Plan 第 3 条（第 204 行）、§2 第 56 行；依据 `docs/architecture/2026-11-12-project-data-portability.md` 第 60–70 行、N15。
- 依据：design 承诺「接入只接受 v1 并保留原 id」「接入同一路径核对项目 id，项目身份变化时拒绝静默复用」；`tasks.md` 3.1 也写「分别创建／接入同格式资料」。但 V05 是「三种位置创建和重新打开」，V12 是本机同项目双目录隔离，V06 只验证无 DSH 的独立校验命令可读，都没有覆盖「清空本机注册表／换一台机器后首次接入一份外部 v1 资料，沿用原 project／node id、不重建项目、不导入旧实例回执」。
- 影响：N15 的「新机器 DSH 取得资料后可直接接入」在 R1 只被间接覆盖；R2 才做完整 Git 协作不等于 R1 可以完全不验证协议可读性与身份保留。
- 建议：新增一条 R1 场景（例如 V38，方法 F／H），明确与「R2 跨副本 Git 协作」「R6 真实跨环境试用」的边界，避免被误认为提前验收 R2；同时补进 `tasks.md` 3.1 与矩阵反例映射表。

#### B4 · 校验记录缺版本与输出，编写 Agent 的校验结果不可复现

- 位置：`docs/development/workflow.md` 第 21 行；`openspec/config.yaml`；`validation-matrix.md` 第 3 行；本 change 全部工件。
- 依据：工作流要求「校验至少包括所用 OpenSpec 版本的 change 严格校验和 `node scripts/check-repo.mjs --all`」；`validation-matrix.md` 只泛述「编写 change／OpenSpec 校验不改变运行状态」，仓库未声明所用 OpenSpec 版本，change 内也没有记录编写 Agent 的命令、版本与输出。本机 PATH 中没有 `openspec`，本次审阅是用 npx 临时取 CLI 2.0.0 补跑才得到 `pass`。
- 影响：提交后他人无法复现「严格校验已通过」这一交接前提；2.0.0 与编写时实际版本若不同，结论不可互相替代。
- 建议：在 change 内（或 `docs/development/workflow.md`）记录所用 OpenSpec 版本、严格校验命令与输出摘要、门禁输出摘要，并注明本次补跑的 2.0.0 结果；未记录前该项按 `blocked` 处理，不以本次补跑冒充编写 Agent 的交接记录。

### C 类 · 依据准确性与文案一致性

#### C1 · Node 版本口径互相矛盾，且当前环境低于插件前置要求

- 位置：`design.md` 第 33 行；依据 `docs/reviews/2026-11-12-dsh-rc2-development-readiness.md` 第 19 行、`docs/research/2026-11-11-dsh-host-capability-review.md` 第 15、101 行。
- 事实：`rc2-readiness` 记「当前 shell `v26.13.0`；此前 Agent 记录的 `v22.22.2` 不是本次观察值」；`host-capability-review` 记「2026-11-12 复核时 shell 中 `node --version` 为 `v22.22.2`」。本次审阅实测 shell 为 **`v22.22.2`**，与后者一致。design 第 33 行沿用了「不用系统 Node 26」的说法。两份上游依据文档对同日同一指标给出相反记录，且 `v22.22.2` 低于 DSH CLI 要求的 `>=24.9.0`。
- 影响：design 引用的具体值不可靠；更实际的是，当前 shell 环境下 `tasks.md` 2.1／2.3 的冻结安装与独立 profile 前置实验不能直接跑通，需要切到宿主随包运行时（复核记录为 `v24.21.0`）并实测确认。
- 建议：design 去掉「系统 Node 26」这类具体值，改为「以宿主实测运行时为准，系统 Node 与仓库 CI Node 均不作兼容证据」；订正两份上游文档的版本记录或注明观察时间与环境；在 2.1／2.3 明确写出实际使用的 Node 二进制与补丁版本。

#### C2 · 源码依据的定位与字段可选性需补正

- 位置：`design.md` 第 149–168 行（尤其第 153、154、168 行）；`tasks.md` 2.4。
- 事实：本机 rc.2 快照已抽查确认 `ToolRunContext.agent / callId / token / signal`（`packages/core/tools/src/contracts.ts`）、`source.rpcId = request.requestId`（`packages/api/session-controller/src/index.ts:484-490`）、`agent/inbox/claimed`、`agent/pre-step`、`turn/start`、`turn/end`、`principalOf`、`dshHomePath()`、`engines.dsh` 兼容检查均存在，design 的候选映射方向属实。但两处需补正：① `Agent.id: SessionId` 的实际声明在 `packages/core/agent/src/types.ts:18`，design 第 168 行引用的 `packages/core/agent/src/runtime-types.ts` 主要是生命周期／事件类型与 Agent 接口扩充，不是该字段的声明处；② `ToolExecutionInput.agent` 是 `readonly agent?: Agent`（`contracts.ts:188`），**可选**，design 表格写「捕获 Agent 对象」未提缺失情形。
- 影响：依据链接错位会拖慢后续复核；`agent` 缺失正是 design 第 160 行「不能取得唯一执行归属时标 blocked」的触发条件，若不显式列为观察项，前置实验可能漏测。
- 建议：把依据补到文件／行级；在 `tasks.md` 2.4 与 V25 明确「`ToolRunContext.agent` 缺失或不可唯一对应时拒绝新绑定并记 `blocked`」；在 design 保持「只读源码、未运行验证」的标注。

#### C3 · 独立包 manifest 关键字段未在 design 中列全

- 位置：`design.md` §1 第 33、37 行；依据 `docs/reviews/2026-11-12-dsh-rc2-development-readiness.md` 第 38 行、上游 `docs/user/develop/basic/publish.zh.md:66` 与 `packages/boot/app-boot/src/plugin-compatibility.ts:52`。
- 事实：rc2 readiness 要求带面板的包显式声明 `dsh.client.platform: "web"` 并导出构建好的 `./client`；design 第 37 行只写「声明 `dsh.bundle`、web Client 和依赖」及包导出 `./client`，未点名 `dsh.client.platform`。另外 `engines.dsh` 在宿主按 `semver.satisfies(..., { includePrerelease: true })` 求值，精确值 `"0.2.2-rc.2"` 属合法范围写法，但 pnpm／npm 自身对 `engines` 的 prerelease 处理未必一致。
- 建议：在 §1 或 `tasks.md` 2.2 列出必须核对的 manifest 字段清单（`dsh.bundle`、`dsh.client.platform: "web"`、`exports./client`、`engines.dsh`、`engines.node`、peer／开发副本），并在 2.1 冻结安装时实测 `engines.dsh: "0.2.2-rc.2"` 的安装与启动兼容判定，不假定只做字符串比较就能通过。

#### C4 · 审阅落地后的状态文案需同步，工作流文档本身尚未入库

- 位置：`proposal.md` 第 3 行、`tasks.md` 第 63 行、`validation-matrix.md` 第 3 行、`openspec/config.yaml` 第 10 行、`openspec/changes/README.md` 第 7 行、`docs/README.md` 第 8 行、`docs/knowledge/decisions.md` 第 56 行、`docs/engineering/2026-11-12-plugin-development-roadmap.md` 第 3、130 行、`docs/architecture/2026-11-11-project-development-architecture.md` 第 295 行、`docs/product/2026-11-11-project-management-design.md` 第 3 行、`AGENTS.md` 第 15 行、`README.md` 与 `README.en.md` 第 9 行。
- 事实：上述位置均写「待外部审阅／当前没有外部 review／提案待审阅、未提交」。`review.md` 落地后这些描述即过期；提交后「未提交」也不再成立。另据本次 `git status`，`docs/development/workflow.md` 仍为未跟踪（`??`），即本轮交接所依据的工作流规则尚未纳入版本控制。
- 建议：提交前统一改为「已审阅、修订后提交／待实施」等准确状态，中英 README 同步；把 `docs/development/workflow.md` 一并纳入本次提交；状态更新须同时通过双语与链接门禁。

#### C5 · 新增源码事实未回写静态调研文档

- 位置：`design.md` 第 149–168 行；依据 `docs/research/2026-11-11-dsh-project-management-review.md`、`docs/knowledge/decisions.md` 第 61 行。
- 事实：§7 的 `ToolRunContext`、`rpcId`、`agent/pre-step`、`principalOf` 等映射是本 change 新引入的源码事实，本仓静态调研文档未记录；design 只在表尾给了三个 GitHub 固定提交链接并注明「只读源码，未运行上述链路」。按权威性「源码 > docs」，直接引源码并无问题，但后续文档容易把「接口存在」误当成「接入已验证」。
- 建议：把已抽查的符号与语义补记到调研或复核文档，逐条标注「rc.2 只读源码，运行验证 `untested`」；design 保留现有谨慎表述即可。

## 五、已核对无异议

- 范围与 N01–N15、D01–D10 对齐：R1 只做接入与最小闭环，完整拖放／复制／撤销、路线图 UI、分析、SDD、模板骨架、跨副本 Git 协作与位置迁移均明确留到 R2–R6，未以缩小表述冒充通过。
- 红线未触碰：没有恢复独立桌面 Agent、Windows 沙箱或 ACL／Job Object／命名管道方案；未把 E／P 系列结论或 Cona 运行证据当继承；坚持纯 Node ESM、跨平台路径语义、路径语义重测；未宣称断电安全、跨介质原子事务或任意外部并发写入安全；未 push／打 tag。
- 契约自洽：公开／私有数据分离、持久意图三阶段、双修订、幂等回执、`pending-reconciliation` 与 `unknown-state` 隔离、取消与重启不恢复授权、完整快照与代际乱序防护、中英与内容语言隔离，与架构基线和数据可移植草案一致；状态词只使用 `untested`。
- 工作流合规：change 保持未提交、未预建 `review.md`、未填写虚构审阅者、34 项实现任务全未勾选、流程步骤单列在 `Workflow follow-up`，未混入实现进度。
- 工件齐备：proposal／design／6 份增量 spec／tasks／validation-matrix／`.openspec.yaml` 齐全，`schema: spec-driven` 一致；6 个 capability 与 proposal 的 New Capabilities、`specs/` 目录一一对应；每个 Requirement 至少一个 Scenario，WHEN／THEN 成对；矩阵反例映射覆盖路线图 R1 的 10 类必须场景，完成判据明确不删场景。

## 六、提交前必办清单

1. 修订 A1、A2，并在 `review-response.md` 逐项写明处理位置与依据；不采纳时写明理由。
2. 处理或明确延期 B1–B4、C1–C5；B4 的校验记录须补齐版本与输出，未补齐前保持 `blocked`。
3. 重跑所用 OpenSpec 版本的 change 严格校验与 `node scripts/check-repo.mjs --all`，把结果写入交接记录。
4. 同步 C4 的状态文案与 `docs/development/workflow.md` 入库，确认中英双语与链接门禁通过。
5. 确认全部运行验证项仍为 `untested`，无 tasks 被勾选，未执行 push／tag。

## 七、复审说明

按 `docs/development/workflow.md` 第 14 条，若需复审应在本文件追加明确的轮次／范围，并同步更新 `review-response.md`；实质性新增问题不得被本轮结论掩盖。本轮结论只覆盖上述 11 个工件及所列依据，不覆盖后续修订稿、实现代码或运行结果。

---

# R1 change 外部审阅 · 第 2 轮（范围修订专审）

日期：2026-11-13
审阅对象：[scope-amendment.md](scope-amendment.md) 及其对应修订——`tasks.md` 2.3／2.4a／2.4b、`validation-matrix.md` V25a／V25b 与矩阵头、`design.md` §7「DSH 行为前提与验证状态」表；对照证据为 [2.4 映射记录](implementation/2026-11-13-2.4-mapping-record.md)与[环境记录第二轮](implementation/2026-11-13-environment-record.md)。
审阅执行：用户本轮指定的外部审阅 Agent（独立新会话），非编写／实施 Agent 自查；`review-response.md` 本轮未预填，作者逐项处理仍在其侧记录。
审阅性质：纸面与静态核对 + rc.2 源码核对 + 门禁复跑。未重跑 2.4 实测（原始会话证据存于本机 `artifacts/r1-2.4-test/` 等门禁排除目录，第三方只能依据记录文本核对一致性），故对 V25a `pass` 的确认是基于记录与源码交叉核对的可信性判断，不构成独立复测。

## 一、总体意见

**范围修订方向成立：需修订一处验收口径矛盾（R2-A1）与两处依据精度（R2-C1、R2-C2），改完即可提交，无需第 3 轮。**

修订的核心判断经源码与记录交叉核对属实：单用户部署确无 non-owner 身份面、R1 确无绑定/准入层、`principalOf` 为空确实不能单独授权。2.4a 实测证据具体且内部自洽（真实 `/api` 会话、事件 seq 序列、pid／waitedMs／callId 换代均可对账），V25a 记 `pass` 有据。不变项（非 owner 与绑定准入保持 `blocked`、不新增伪造 principal 证据、2.4b 不计完成度）均未放水。

但修订文本里 V25b 的口径存在三处互相打架的表述（见 R2-A1），不修清会导致 R1 完成判定不可执行——要么被永久 `blocked` 卡死，要么被「不属 R1」四个字当成豁免借口。这必须在本轮改掉。

## 二、审阅范围与依据

- 本轮修订的全部落点文件（上列 4 份）+ 两份实测记录 + `review-response.md`（确认未预填第 2 轮）。
- 源码核对（本机 rc.2 快照 `~/Developer/tools/deepseek-harness`，仅只读）：
  - `packages/typert/protocol/src/types.ts:455-461`：`PrincipalMap` 仅 `owner: { kind: 'owner' }`——修订声明属实。
  - `packages/typert/protocol/src/principal.ts:14-17`：`principalOf` 对 owner 与无 Remote invocation 的进程内代码都返回 `undefined`——与 design §7 表、V25a 观察项一致。
  - `packages/core/tools/src/contracts.ts:175-203`：`ToolExecutionInput` 只有 `callId/rootCallId/name/schema?/arguments/agent?/toolSet?/parent?/signal`，无 invocation／principal；`agent` 可选（:188）——与「工具准入须来自 agent/session 归属」一致。
  - `packages/experimental/liveshare-protocol/README.md:29`：协议包为库，「no profile mounts it」，owner host 与 gateway worker 同装、Relay 独立部署；`src/identity/types.ts:35`：浏览器 OAuth 契约由部署方 identity adapter 实现——「需独立部署的 Liveshare 服务」成立（但见 R2-C1 的引用精度问题）。
- 仓库门禁与校验复跑（结果见下表）。

## 三、校验结论

| 项目 | 命令／方法 | 结果 |
|---|---|---|
| 仓库门禁 | `node scripts/check-repo.mjs --all` | `pass`；洁净度 32 项自测过、链接 67 篇 0 问题、双语 5 对 0 问题 |
| OpenSpec change 严格校验 | `npx --yes @fission-ai/openspec@1.17.0 validate establish-r1-project-plugin --type change --strict --no-interactive` | `pass`；与作者补录的 1.17.0 同版本，结论可互相印证 |
| V25a 证据可信性 | 映射记录 × rc.2 源码交叉核对 | `pass`；owner Remote（浏览器 cookie 与 `/connect` API cookie 均 `peerPrincipal:{kind:"owner"}`）、ToolRunContext 无 invocation（agentId=SessionId、callId 单次）、queue=next-turn 不打断、steer=next-step 不 abort 在飞工具、cancel 112ms 内替换结果并 `aborted/user`、重启后 agentId 稳定 callId 换代——全部与源码语义一致，记录含会话 id／pid／事件 seq 可对账 |
| 2.4 实测独立复跑 | 无（artifacts 属本机证据，按项目约定不入库） | `untested`；不构成对 V25a 的独立复测 |
| tasks 2.4a 勾选状态 | 静态核对 | 未勾选，注明「待范围修订 review 通过后勾选」——符合修订问题 3 的承诺 |

## 四、问题清单

### A 类 · 必须修订

#### R2-A1 · V25b「不属 R1」「转第 6 段复测」「blocked 阻完成」三种口径互相矛盾，R1 完成判定不可执行

- 位置：`validation-matrix.md` V25b 行（标「（不属 R1）」、状态 `blocked`）与完成判据（「必须场景 fail／blocked／untested 时，R1 不标完成」，且无任何例外条款）；`tasks.md` 2.4b（「不属 R1，转入第 6 段复测」）；scope-amendment.md 问题 1。
- 问题：V25b 实际捆了两件可分的东西——① agent 缺失／归属不唯一拒绝新绑定：第 6 段（6.2／6.5）实现绑定层后**在 R1 内即可复测**，与 liveshare 无关；② non-owner 拒绝：无真实 Liveshare 部署则 R1 内永远无法复测。当前三处文本组合出两个都不成立的结局：按完成判据字面，V25b 永久 `blocked` ⇒ R1 永不完成；按「不属 R1」字面，V25b 又成了脱离完成判据的豁免项——两读法都通，正是放水空间。
- 影响：R1 达成判定无法执行；且 6.2／6.5 的任务文本只写「依据 2.4 结论测试」，未显式承接 V25b 的复测义务，①可能真的落空。
- 建议（三步，改动小）：① 拆口径写进 V25b 行：agent 缺失／归属不唯一部分**必须**在第 6 段复测（6.2／6.5 文本显式承接），复测前保持 `blocked`；non-owner 部分保持 `blocked`，作为 R1 已声明边界。② 完成判据加一句显式例外：non-owner 复测条件（真实多身份部署）不在 R1 交付范围，其 `blocked` 不阻 R1 完成，但须随 change 归档带入 R2+ 边界记录；agent 缺失／归属不唯一部分不享此例外。③ 据此同步 scope-amendment.md 的「修订内容」表与问题 1 的推荐答案。对修订问题 1 的裁决见下节：**接受移出，R1 不依赖真实 Liveshare 部署**（会显著扩大范围且属 R2+ Git 协作前缀）。

### C 类 · 依据精度

#### R2-C1 · liveshare 引用的「OAuth、数据库、路由」部分字样未核到

- 位置：scope-amendment.md 触发事实 1、design.md §7 表第 2 行。
- 事实：rc.2 快照中 `liveshare-protocol/README.md:29` 可证「独立部署 + gateway worker + Relay + no profile mounts it」，`identity/types.ts:35` 可证「浏览器 OAuth 契约」；但该 README 内无「数据库」「路由」字样。结论（本机无该服务、非 owner 身份面不可得）不受影响。
- 建议：引用收敛为「独立部署的 Liveshare 服务（owner host + gateway worker + Relay，浏览器 OAuth 契约由部署方实现，见 README.md:29 与 identity/types.ts:35）」，删去未核到的「数据库、路由」；design §7 表同步。

#### R2-C2 · 矩阵反例映射表与 V25 字样未随拆分同步

- 位置：`validation-matrix.md`「路线图 R1 必须反例映射」表行「伪造身份、旧绑定和排队请求 | V24、V25、V26」。
- 事实：V25 已拆为 V25a／V25b，该行仍写 V25；完成判据段也未提 V25b 口径（与 R2-A1 一并处理）。
- 建议：改为「V24、V25a、V25b、V26」，与 R2-A1 的例外声明同步写进完成判据。

## 五、对 scope-amendment 三个审阅问题的裁决

1. **non-owner 与绑定准入移出 2.4 验收：接受**，R1 不要求真实 Liveshare 部署。但按 R2-A1 拆清：绑定准入的「agent 缺失／归属不唯一」复测义务落到第 6 段并计入 R1；non-owner 复测保持 `blocked` 并作为 R1 边界带入后续轮次，不以伪造 principal 补测（红线维持）。
2. **V25a 足够覆盖原 V25 意图：是**。原 V25 的可测核心（owner 身份面、工具上下文无 invocation、turn 事件映射）已全部实测；不可测部分显式移入 V25b 且不消失。V26 的插件绑定层隔离行为（待执行 B 不覆盖 A 等）与 2.4a 的宿主事件映射是两层，不重叠、不冲突。
3. **拆分方式：同意**。2.4a 待本审阅放行后勾选、2.4b 保持 `blocked` 且复测义务按 R2-A1 落到 6.2／6.5；勾选时 tasks 状态行、矩阵状态、映射记录三处同步。

## 六、已核对无异议

- 修订触发事实三条全部属实（源码核对 + 环境记录），非「借实测放水」：被移出的验收项确实指向 R1 不存在的前提。
- 2.3 组合前提已补进 tasks 2.3（profile 须含 `@deepseek-ai/dsh-web-app`），与实测一致；Client 回退自动探针的理由（TS2307 构建序、模块表缺 `remote-info`）记录完整，属合理工程决策。
- design §7 新表把「已核对源码」「已实测」「设计事实」三种状态分开标注，取代原笼统的「运行链路仍未验证」，方向正确；原候选映射表保留未删。
- 不变项守住：V25b 未改 `pass`、无伪造 principal 替代证据、2.4a 未提前勾选、修订未扩大 R1 交付范围。
- 映射记录质量：事件 seq 表、双 pid、waitedMs（8001／15001／112ms）、callId 换代等交叉可对账；「迟到工具跨 turn 到达」诚实记为 untested，未混入 pass。
- spec 未随修订改动，属正确决定：spec 描述目标能力（non-owner 场景仍保留），验证状态由矩阵承载，二者分层不冲突。
- 门禁与 1.17.0 严格校验通过；`review.md` 原第 1 轮文本未被改动。

## 七、放行条件

1. 修订 R2-A1（V25b 拆口径 + 完成判据例外 + 6.2／6.5 显式承接 + scope-amendment 同步）。
2. 顺手处理 R2-C1、R2-C2。
3. 作者在 `review-response.md` 记录本轮逐项处理；重跑门禁与 1.17.0 严格校验并记录输出摘要。
4. 完成上述后 2.4a 可勾选，无需第 3 轮审阅（改动属微小修，按工作流豁免再审）；non-owner 复测义务随 change 进入 R2+ 边界记录。
