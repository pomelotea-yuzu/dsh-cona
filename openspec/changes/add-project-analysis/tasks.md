# 实施任务

第 1 组优先。定向门禁通过后可推进第 2 组，远程复跑与产品实施可并行。第 2 组确认固定宿主接点后，先做第 3～5 组闭环，再接第 6～7 组。第 8 组以最终可安装包和交付提交验收。每项记录实际命令或观察，详细场景见 [验证矩阵](validation-matrix.md)。

## 1. 恢复 GitHub Actions 与 Gitee Go

- [x] 1.1 从两个附件核对唯一失败用例和运行工具链。用原源码及 Node 24.21.0 对比 `init.defaultBranch=master` 与 `main`，记录基线、结果和实测 Git 版本；Gitee 附件明确记为 Git 版本未知（CI01）。（2026-11-28：修改前复现 `master` exit 1／0-1、`main` exit 0／1-1；Git `2.54.0 (Apple Git-157)`、Node `v24.21.0`、pnpm `12.18.0`，见[实施记录](implementation/2026-11-28-1.x-ci-fixture.md)）
- [x] 1.2 在 `setupGit()` 的 `git init` 后、首次提交前用 `git symbolic-ref HEAD refs/heads/<夹具分支>` 固定初始分支，与测试切回使用同一常量。核对真实未合并索引、预览失败状态和 `git-unmerged` 诊断（CI01）。（2026-11-28：已增加 `git ls-files -u` 非空断言并保留原预览诊断，见[实施记录](implementation/2026-11-28-1.x-ci-fixture.md#修复)）
- [x] 1.3 记录所用 `git --version`、Node 24.21.0／pnpm 12.18.0。重新编译插件和测试，在 `master`、`main` 各跑定向用例，再跑完整 `pnpm check:ci`（CI01）。（2026-11-28：两组定向均 1/1；完整门禁 exit 0、529/529，见[实施记录](implementation/2026-11-28-1.x-ci-fixture.md#修复后验证)）
- [x] 1.4 在 GitHub Actions 版本步骤打印 `git --version`。用户同步或授权同步后，记录包含修复的 commit、run ID、三项工具版本与门禁结论；发现相关失败时修复并复跑（CI02）。（2026-11-28：修复提交 `cbbd4f5` 已同步，用户真终端确认 GitHub Actions 门禁通过；run ID 与三项工具版本实测值未取，见[实施记录](implementation/2026-11-28-1.x-ci-fixture.md#远程边界与后续)。）
- [x] 1.5 在 Gitee Go 门禁前打印 `git --version`，确认夹具只依赖已具备的 `init` 和 `symbolic-ref`。独立记录包含修复的 commit、流水线、三项工具版本和门禁结论（CI03）。（2026-11-28：同一提交 `cbbd4f5` 已同步，用户真终端确认 Gitee Go 门禁通过；流水线标识与三项工具版本实测值未取，夹具只依赖 `init`／`symbolic-ref` 已核对，见[实施记录](implementation/2026-11-28-1.x-ci-fixture.md#远程边界与后续)。）

## 2. 固定宿主接入验证

> 2026-11-28 阶段进展：静态核对、keyless 机制探针与接入模块已落地，并在隔离 profile 的真 DSH `0.2.2-rc.2` 上部分实测（preset 注册、实际会话与作用域、守卫、pre-step、原生/PTC 执行器对照）；实测同时修复 `ctx.effect` 立即释放保护与随包 patch 缺 `config` 两处问题。同期实测定案允许能力注册位置（分析 Session 的 agent scope）并新增 Host 侧执行前核对，见[作用域记录](implementation/2026-11-28-2.x-scope-and-executor.md)。模型回合、范围语义（3.x/5.x）与重启时序（4.x/6.x）未做，下列三项不勾选、A03/A04/A05/A07 保持 `untested`，见[真宿主记录](implementation/2026-11-28-2.x-real-host.md)与[阶段记录](implementation/2026-11-28-2.x-host-connection.md)。

- [ ] 2.1 验证随包的 `cordis.patch.yml` 如何向 DSH `0.2.2-rc.2` 注册分析 preset，组装原生执行器和分析作用域接入模块。隔离 profile 实测实际 preset、有效作用域、工作区挂载、消息认领、工具主体与宿主终态；注册表缺失、ID 冲突或声明加载／解析失败时核对不可用诊断（A03、A05）。
  - 2026-11-28 真宿主（隔离 profile，DSH 0.2.2-rc.2）：roster 含 `cona-project-analysis`；`create({cwd, agentPreset})` 返回实际 preset 与 cwd；可见工具仅四个允许名；headless 缺 `agentPresets`/`sessionController` 时 preset 行 `pending` 诊断；重复 ID 报 `Duplicate agent preset` 且原条目保留。缺 Host 入口的「不可用」显示（3.x/7.x）与模型回合，见[真宿主记录](implementation/2026-11-28-2.x-real-host.md)。
  - 2026-11-28 补：rc.2 的 `restrict` 只裁剪继承工具；preset 作用域注册的分析能力会被同一限制遮掉，故四个能力由 Host 注册在分析 Session 的 agent scope（preset 层只留原生执行器与守卫/限制/准入）。真宿主对照见[作用域记录](implementation/2026-11-28-2.x-scope-and-executor.md)。另：`plugins: "not-a-list"` 的声明行报 `ValidationError: invalid config`，roster 不含该 preset、既有分析 preset 仍可用；入口不可用显示仍待 7.x。
- [ ] 2.2 在启用 PTC 的隔离对照和普通原生环境验证分析选择原生执行器、普通 Session 使用其原组合。用合成文件测试保留的 PTC 执行入口、通用代码执行、Shell、文件写入和代理转发。记录分派、执行正文未进入、范围外读取未返回、范围内外写入未生效；标注沙箱模式和拒绝所在层（A04、A05）。
  - 2026-11-28 真宿主：分析 Session 选中 `NativeToolExecutor`、PTC Session 选中 `PtcExecutor`；守卫在正文前拒绝 `bash`/`write`/`run_code`（`analysis-tool-not-allowed`），夹具文件哈希不变；PTC 会话 `run_code` 到达 code-run 层（本进程沙箱内返回 `sandbox-unavailable`）。真实模型回合下，绑定会话调用允许集工具成功、无绑定调用返回 `analysis-binding-missing` 且夹具未执行。范围外读取与真实分析工具语义属 3.x/5.x，未测，见[真宿主记录](implementation/2026-11-28-2.x-real-host.md)。
  - 2026-11-28 补：新增 Host 侧 `verifyAnalysisExecution`；真宿主中分析 Session 恰见四个允许名、普通 Session 0 个、PTC Session 核对拒绝 `analysis-executor-not-native:PtcExecutor`；允许工具真实分派成功，`bash`/`run_code` 在正文前拒绝，普通 Session 调用为 `UNKNOWN_TOOL`。见[作用域记录](implementation/2026-11-28-2.x-scope-and-executor.md)。
- [ ] 2.3 验证实际执行器无法核对、守卫不可用、关联未持久化或启动响应丢失时，后台不会派发无保护请求；验证 `agent/pre-step` 在正常完成、中断和重启后的原会话上拦截新输入（A03、A05、A07）。
  - 2026-11-28 真宿主：无绑定/未持久化时守卫 fail-closed；真实 `agent/pre-step` 对错误 `rpcId` 与终止绑定均返回 `turn/end blocked` 且无 `step/start`、未进模型；普通 API key 下匹配 `rpcId` 的真实模型回合完成（工具调用 + 续步 `ok`）；实测修复「续步被当未认领拦截」缺陷（step>1 放行，终态仍全拒）。启动响应丢失与重启后历史会话属 4.x/6.x，未测，见[真宿主记录](implementation/2026-11-28-2.x-real-host.md)。
  - 2026-11-28 补：`verifyAnalysisExecution` 对 PTC 执行器、能力缺失、守卫缺失、未持久化、终态均 fail-closed；错误 `rpcId` 0 个 `step/start`，正确 `rpcId` 进入第 1 步（隔离 home 无凭证以 `MISSING_CREDENTIAL` 结束）；终态绑定下允许工具也被 `analysis-terminal` 拒绝。见[作用域记录](implementation/2026-11-28-2.x-scope-and-executor.md)。

## 3. 本机范围和受检内容观察

- [x] 3.1 接入配置实例的现有仓库映射解析。返回可选逻辑仓库和不可用原因，冻结分析选择的实例、仓库和当前映射身份；用同项目双工作副本证明选择不串到另一个根（A01、A02）。
  - 2026-11-28：`AnalysisScopeService` 解析实例映射并保留不可用原因；预览冻结 `[instanceId, repositoryId, realpath]`。双工作副本不串根、映射移动／移除、资料代际变化、运行时映射更新均拒绝旧选择；真实文件测试 8 项见[第 3 组记录](implementation/2026-11-28-3.x-analysis-scope.md#证据)。概览 Remote／UI 预览属 7.1。
- [x] 3.2 增加只读范围预览，支持一个文件、目录或明确选择仓库根。使用既有范围解析及路径段判断，测试同前缀兄弟目录、`..`、绝对路径、逐段 symlink、失效映射和不合适的目标类型（A01、A02、A06）。
  - 2026-11-28：复用 `validateRelativePath`／`resolveInScope`；根／目录／文件三种范围，兄弟前缀不混入，`..`、绝对路径、最终与中间段链接、失效映射、目录当文件均拒绝，见[第 3 组记录](implementation/2026-11-28-3.x-analysis-scope.md#证据)。
- [x] 3.3 实现有序范围枚举及观察指纹。验证 Git 内部对象和被忽略路径的排除、小项目文件增删改、输入次序无关、同一 HEAD 下变化可辨（A06、A11、A13）。
  - 2026-11-28：按码元排序；`.git`、忽略的未跟踪路径记排除，已跟踪的忽略文件仍纳入；同一 HEAD 下修改／新增／删除改变指纹，两棵同布局不同创建顺序指纹相同，见[第 3 组记录](implementation/2026-11-28-3.x-analysis-scope.md#证据)。
- [x] 3.4 集中定义扫描、单文件和一次分析总读取上限，返回超额、不可读、非文本、特殊文件与枚举截断的原因。以真实文件核对局部报告可生成，未知覆盖可追溯（A06、A08、A14）。
  - 2026-11-28：`AnalysisLimits` 集中定义并可注入小值；扫描截断保留部分条目，单文件超限记 `hash:null` 与原因，不可读／FIFO／非文本各有原因；`ReadBudget` 跨读取累计；`complete`／`issues`／指纹支撑部分覆盖追溯。正式报告生成属第 5 组，见[第 3 组记录](implementation/2026-11-28-3.x-analysis-scope.md#证据)。
- [x] 3.5 增加范围内文件读取与引用校验，按实际返回字节和行范围发凭证。测试只列目录无凭证、截断仅计已交付片段、读取前后文件或路径发生变化、旧引用回看失效（A06、A08、A14、A15）。
  - 2026-11-28：只按整行交付，凭证含整份哈希、交付片段哈希、起止行与字节；预算截断只计交付片段；目录／范围外拒绝；两次读取＋重新解析＋元数据复核捕捉读取期间内容或链接变化；引用复核区分当前／内容变／删除／不可访问／映射变化。UI 导航与报告引用属 5.4／7.2，见[第 3 组记录](implementation/2026-11-28-3.x-analysis-scope.md#证据)。

## 4. 分析 Session 与运行状态

- [x] 4.1 定义本机分析记录、请求标识和绑定状态，兼容之前无分析字段的本机数据；使用现有实例队列，验证首次保存、损坏诊断和旧数据重启可读（A03、A10）。
  - 2026-11-28：`AnalysisRecord`／`analysisRecordsOf`／`AnalysisBindingState` 落地；旧聚合无 `analyses` 归一化为空且不改写磁盘，损坏条目按字段白名单跳过；队列内 `prepared→creating→created` 三次落盘并推进状态修订；隔离实例拒绝分析读写。8 项应用测试与 5 项适配器测试见[第 4 组记录](implementation/2026-11-28-4.x-analysis-session.md)。
- [x] 4.2 实现 owner 确认后冻结输入、创建并登记实际 Session。用专用 preset 新建时省略 `sessionId`，测试同工作区已有普通聊天链接的空白会话保持原样。覆盖取消预览、旧预览重取以及关联未落盘时不发送（A01–A03）。
  - 2026-11-28：`start` 在确认时核对预览指纹与规划版本（过期拒绝且零副作用），专用 preset 新建不传 `sessionId`；真宿主验证同工作区空白普通会话 id 不同、仍 `blank` 且 preset 仍为标准；创建结果未知、关联落盘失败、preset 不符各有稳定拒绝。首消息发送属 4.3，见[第 4 组记录](implementation/2026-11-28-4.x-analysis-session.md)。
- [ ] 4.3 实现受保护的首消息发送和启动查询。记录 Host 请求标识，测试创建或发送响应丢失、同号重试回读、未能核对时不自动重发（A03、A05）。
- [ ] 4.4 按真实消息认领绑定身份。只在核对过的原生执行器、允许工具和活动绑定下读取或保存，拒绝错误 Session、已换源、停止或无绑定调用。普通 Session 独立对照，分析局部注册工具也须走守卫（A04、A05、A07）。
- [ ] 4.5 同步宿主运行、停止请求和真实 `turn/end`。注入取消与提交交错以及迟到工具调用，核对报告发布点与未形成报告的终态（A07、A10）。
- [ ] 4.6 恢复本机分析归属与历史回读。测试完成、中断、重连、重启后打开旧会话及直接继续输入；核对宿主拒绝进入模型、旧绑定失效且历史可回看（A03、A05、A07、A10）。

## 5. 私有报告和来源

- [ ] 5.1 为同实例已捕获的 `verification` 索引接通有界正文读取。核对记录 ID、实际字节 `contentHash`、验证主体、`subjectVersion`，按实际交付范围生成凭证及覆盖；测试未读、正文缺失、哈希错误和缺受检版本（A08、A09）。
- [ ] 5.2 用真实已交付凭证校验报告事实、推断、建议和历史验证；拒绝无效 ID、错误哈希／受检版本与伪造覆盖。提交覆盖同号同载荷／异载荷、持久化失败、响应丢失、取消与换源（A07–A10）。
- [ ] 5.3 提供所选实例的有界报告列表与详情。验证重启后同 ID 回读，另一实例的请求无法获得报告，公开项目树与可移植资料无正文及私有 Session 引用（A10）。
- [ ] 5.4 来源导航前重查映射、当前哈希、原行范围与验证记录凭证。用有效来源、失效映射、删除、符号链接、同路径修改、行号移动、删后重建及记录正文／元数据变化核对原文定位、历史提示及显式打开当前文件（A15）。

## 6. 历史依据与复盘

- [ ] 6.1 保存起始的源代际、映射身份、`planVersion`、范围指纹及必要的 Git 来源。提交和回看分别核对，允许分析期间观察到的代码变化以历史依据随报告保存（A11、A12）。
- [ ] 6.2 实现依据状态和具体原因。测试同 HEAD 下文件增删改、同路径行号变化或删后重建、已引用验证证据变化、观察不可用、规划变化及换源；只追加未引用记录且 planVersion 和既有凭证不变、只改范围外路径应保持当前（A11–A15）。
- [ ] 6.3 实现从历史报告重新确认范围，沿用同一发起通路生成新 ID、真实 Session 和当时的代码及规划基线。验证旧报告可查、二次分析的绑定独立，两个版本能从各自来源回看（A12、A16）。

## 7. 概览 UI 与 i18n

- [ ] 7.1 接入概览的开始分析、仓库与范围选择、预览、确认和取消。显示不可用原因、范围、截断及发送未知状态，检查单次确认和键盘可达性（A01–A03、A06）。
- [ ] 7.2 接入状态、历史列表、覆盖和来源导航。测试重连、切实例、迟到响应、会话不可用时仍可回看、完成或中断后的「历史分析」提示和原会话输入被拒，以及历史来源与当前内容的导航（A07–A10、A15）。
- [ ] 7.3 显示依据状态、变化类别和再次分析入口。补齐简中、英文及第三语言回退资源，检查状态、错误、空态和用户正文在切换宿主语言时的显示（A11–A17）。

## 8. 真实宿主与交付

- [ ] 8.1 用候选提交包在固定 DSH 记录宿主、SHA-256、执行器和沙箱模式。真实 Agent 完成局部分析并读取已有验证正文。复验普通 Session 对照、原生执行器、未允许 PTC／代码调用正文未进入、范围外读未返回及范围内外文件未改；执行器／守卫拒绝和沙箱拒写分别记证据（A01–A09）。
- [ ] 8.2 在同项目分别走重启后回读、同 HEAD 内代码改动、规划变化和再次分析。核对历史与新报告可见、共享数据未包含私有资料、中文英文及回退，逐条登记证据和未测／受阻分句（A10–A17）。
- [ ] 8.3 以交付提交执行 OpenSpec 严格校验、完整 `pnpm check:ci`，并按 GitHub Actions 与 Gitee Go 分别核对最终门禁。归档前核对本地门禁、两条远程和固定宿主结果均能追溯到各自实际提交及环境（CI01–CI03）。
