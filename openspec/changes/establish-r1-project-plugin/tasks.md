# R1 实现任务

状态：已收到[第 1 轮外部 review](review.md)并按意见修订，处理见 [review-response](review-response.md)；2026-11-13 起按用户授权进入实施，第 1 段（格式、领域与无宿主校验）完成，第 2 段中 2.1／2.2 完成（npm 已发布 0.2.2-rc.2 类型包与 typert-generator，类型与生成改走 npm 精确版本 + vendored protocol 源面，typert.host／remote-client 产物已生成，build／typecheck／test 79 项／check:manifest／仓库门禁全过），2.3 已完成（洁净构建/打包、独立 home 安装、宿主与 Remote 探针、浏览器内 Client 激活，见环境记录第二轮），2.4a 完成（第 2 轮 review 放行，见 [范围修订](scope-amendment.md)），2.4b 拆口径（绑定／归属部分 6.2／6.5 复测计入 R1，non-owner 为 R1 边界），2.5 完成（`pnpm check:ci` 接入，本地以 Node v24.21.0 实跑通过；远端流水线未实跑），见 [接手记录](implementation/2026-11-13-handoff.md)；第 3 段 3.1 完成（三种资料位置、实际路径与 Git 只读状态、外部 v1 基础接入，见 [3.1 记录](implementation/2026-11-14-3.1-positions.md)），3.2 完成（本机根、注册表与实例聚合、锁与私有根检查，见 [3.2 记录](implementation/2026-11-14-3.2-local-state.md)），3.3–3.5 完成（路径范围、三态发布与中断注入、完整基线与显式刷新，见 [3.3–3.5 记录](implementation/2026-11-14-3.3-3.5-scope-publish-refresh.md)），第 3 段收口；第 4 段 4.1 完成（命令封套、访问校验、不可变变换、每实例队列，见 [4.1 记录](implementation/2026-11-14-4.1-command-envelope.md)），4.2 完成（意图／回执幂等与稳定生成 id，见 [4.2 记录](implementation/2026-11-14-4.2-idempotency.md)），4.3 完成（prepared／publishing／committed 阶段与中断注入，见 [4.3 记录](implementation/2026-11-14-4.3-phases.md)），4.4 起未开始。协议正文和向量是已交付的提案工件，其复算不勾选实现任务；不得把工件齐备或静态校验当成产品已完成。

## 1. 格式、领域与无宿主校验

- [x] 1.1 建立 `packages/project-plugin/` 的领域／应用／适配器／Client／Host 目录及接口边界；以类型检查和导入检查确认领域不依赖 Node、React、Cordis，产出包边界说明。（`BOUNDARIES.md`、`tsconfig.domain.json`（types: []）、`scripts/check-boundaries.mjs`；application/ports.ts 为草案接口，随第 3–6 段细化）
- [x] 1.2 实现 v1 Project／WorkNode schema、稳定 id、顺序和依赖规则；以重复 id、缺失父节点、树环、依赖环、批量拆分整体拒绝测试验证，并交付最小合法资料样例。（`formats/v1/sample-project.json`（planVersion 已回填真值）+ `formats/v1/project-v1.schema.json` + `test/domain.test.ts`；协议向量确认 v1 允许多根森林，故未加单根限制）
- [x] 1.3 按已交付的 `formats/v1/plan-canonicalization.md`／`plan-vectors.json` 实现 v1-plan 指纹；主实现与第二份不依赖主序列化函数的独立实现均须复算全部正向向量及拒绝负向向量，覆盖 UTF-16 键序、中文／转义、精确整数、集合白名单、记录追加和业务重排；提案向量核算不代替本项产品实现验证。（`test/vectors.test.ts`：43 项全部通过，主实现与 `plan-fingerprint-alt.ts` 交叉复算一致；独立性边界记录于 BOUNDARIES.md——共享 strict-json 解析与领域校验，序列化路径完全独立）
- [x] 1.4 实现记录索引、正文哈希、完成条件和验证来源校验；以孤立正文不发布、子节点完成不推导父完成、外部验证不冒充本机复测及失效引用测试验证。（`validate.ts` 完成条件规则、`records.ts` 孤立正文与验证来源分类、`test/domain.test.ts`、`test/cli.test.ts` 孤立正文端到端）
- [x] 1.5 提供包内 schema、资料 README 模板与独立校验命令，将协议正文／强制一致性向量随包及资料根分发；在无 DSH 服务的进程中校验样例及错误／未知字段资料，确认其他实现仅凭公开协议可复算，不加载宿主、浏览器或模型服务，不执行资料脚本或远程引用。（`src/cli/validate.ts`（check / check-file / compute-plan-version / init）、`formats/v1/project-README.template.md`、`scripts/check-protocol-sync.mjs`；CLI 已实测：样例通过、10 个错误 fixture 以稳定码拒绝、孤立正文与哈希不符正文拒绝）

## 2. 构建与接入前置实验

- [x] 2.1 建立根 workspace、锁文件及固定依赖声明；冻结安装前记录实际 Node 二进制绝对路径和补丁版本、包管理器版本，低于要求时显式选择并实测兼容运行时，再核对 DSH rc.2／共享 peer／依赖引擎；分别实测包管理器与宿主对 `engines.dsh: "0.2.2-rc.2"` 的安装及启动判定，不可用依赖记 fail／blocked，不改浮动版本。（2026-11-13：workspace/锁文件/依赖冻结与核对完成，见[环境记录](implementation/2026-11-13-environment-record.md)；engines.dsh 安装/启动判定实测随 2.3 进行）
- [x] 2.2 配置 Host ESM、Client factory 与自有 Typert contribution 生成；构建／类型及包清单检查必须核对 dsh.bundle.patch、dsh.client.platform="web"、Client inject／external、exports["./client"]、engines.dsh／node、共享 peer／开发副本和 files 资源完整，构建不读取相邻上游 monorepo 配置。（2026-11-13：npm rc.2 类型包可用，`engines.dsh` 安装/启动判定实测随 2.3 进行）
- [x] 2.3 在没有相邻上游源码的检出目录构建并 pack；在独立 home／profile 安装 tarball，实际观察 Host、Client 导航与 Remote 探针，分别记录开发命令及宿主实际使用的 Node 二进制／补丁版本、DSH 版本和共享实例结果，不能仅用 shell 版本或随包元数据代替实际 Host 观察。（2026-11-13 晚第二轮：修复洁净检出 3 个阻断——测试与 CLI 仍指旧 dist 布局、build 不生成 Typert 产物、manifest 不查产物存在——后，洁净检出 79 测试与 47 文件 tarball 可复现；独立 DSH_HOME 安装、宿主 apply 日志 Node v24.21.0、boot graph 含 dsh-cona-project 且客户端 bundle 200、Remote probe 真实 HTTP 调用返回 owner principal；已在 cona-r1-test 加入 web-app 并复测页面/boot graph/客户端 bundle/Remote probe；浏览器内 Client 激活由用户在 Safari 控制台观察到 `[dsh-cona-project] client factory loaded`（apply，index.ts:13），故勾选。前提：profile 组合须含 Web 应用 bundle（`@deepseek-ai/dsh-web-app`），默认自定义 profile 不含，Client 不可观察。证据与命令见环境记录第二轮。）
- [x] 2.4a 用最小诊断插件分开实测真实 owner Remote invocation 与无 invocation 的真实 ToolRunContext，并交付消息消费／turn／取消／结束的映射结论（含 queue、steer、迟到工具与重启）；确认 principalOf 为空不单独授权，工具路径不因缺 invocation 被拒、也不凭 principalOf 取得 owner 权限，不以自报身份补缺口。（2026-11-13 API 驱动真实会话实测完成：owner Remote、ToolRunContext、queue、steer（含迟到工具）、cancel、重启映射；见 [2.4 映射记录](implementation/2026-11-13-2.4-mapping-record.md)。第 2 轮 review 在 R2-A1／C1／C2 处理后放行，故勾选。）
- [ ] 2.4b（blocked，拆口径）实测绑定准入与 non-owner 拒绝。（i）工具无 invocation 但绑定有效可按有限范围准入；agent 缺失／归属不唯一拒绝新绑定——R1 只有诊断探针、无绑定/准入层，第 6 段实现后复测，**计入 R1，不享完成例外**（6.2／6.5 已显式承接）。（ii）non-owner／伪造主体拒绝——单用户部署仅 owner 身份面（唯一非 owner 为 liveshare `share-viewer`，需独立部署），保持 R1 边界；其 blocked 不阻 R1 完成，随 change 归档带入 R2+ 边界记录。不得用进程内伪造 principal 补测。
- [x] 2.5 增加插件 build、typecheck、必要 test 与格式／资源检查入口，并接入现有仓库门禁和插件 Node CI；运行整条计划 `pnpm check:ci` 验证，说明实际 Node 版本，不移除原有洁净度与双语检查。（2026-11-13：根 `check:ci` = `check-repo --all` + build + typecheck + `test:run` + boundaries + protocol-sync + check:manifest；GitHub CI 与 Gitee Go 改为 Node 24.21.0 + pnpm 12.18.0，本地以 Node v24.21.0／pnpm 12.18.0 实跑 `pnpm check:ci` 通过（79 测试）；GitHub Actions run #4/#5/#6 实跑 success；Gitee Go 首次因 npm 11.19 拦截 pnpm install scripts 失败，改 `--allow-scripts=pnpm` 后复跑通过（用户观察，Gitee 无公开日志入库）。）

## 3. 公开资料与本机文件后端

- [x] 3.1 实现三种资料位置选择、实际路径展示与 Git 状态只读检测；分别创建／接入同格式资料，另用全新本机根首次接入外部 v1 资料，验证沿用原 project／node id、不要求原数据库、不导入旧实例回执或授权；核对无代码目录可建项目、非空目标不覆盖，补位置与基础接入说明，不能以此代替 R2／R6 协作试用。（2026-11-14：`application/location.ts` + `source-service.ts`、`adapters/fs/{location,git-status,project-json,source-files}.ts`、`cli/source.ts`；三位置同格式字节一致、`validate.js check` 通过、外部 v1 接入沿用原 id 且目录不新增文件、非空目标拒绝、Git 四态只读观察；10 项新测试，Node v22.22.2 与宿主 Node v24.21.0 各 89/89，`pnpm check:ci` 全过。真实宿主 profile（V05／V38 的 H 部分）未做，矩阵保持 untested；见[3.1 记录](implementation/2026-11-14-3.1-positions.md)）
- [x] 3.2 实现本机根配置、注册表和单实例聚合存储；测试根隔离、私有内容不入公开头、项目内已跟踪私有根被拒绝、同项目双目录隔离、重复写者及遗留锁处理，补本机数据边界说明。（2026-11-14：`application/local-state.ts`、`adapters/fs/{local-root,local-state,git-guard,git-run}.ts`、`cli/local.ts`；根隔离三向拒绝、Git 私有根三分支（忽略／未忽略／已跟踪）、登记复用与身份变化拒绝、双目录两实例、公开头字节不变、遗留锁 `--force` 与进程内 `local-writer-duplicate`、损坏注册表不覆盖；12 项新测试，Node v22.22.2 与宿主 v24.21.0 各 101/101，`pnpm check:ci` 全过。真实宿主 profile 与路径范围（realpath／symlink／大小写）未做，见[3.2 记录](implementation/2026-11-14-3.2-local-state.md)）
- [x] 3.3 实现根范围／相对引用校验与文件读取；测试越界、symlink、hardlink、大小写及权限错误，记录实际平台结果，未测平台保持 untested。（2026-11-14：`domain/relative-path.ts` 协议校验、`adapters/fs/path-scope.ts` 逐段 symlink／中间段目录／目标类型／写目标 hardlink／realpath 复核／范围读取／目录列举／大小写冲突检测；8 项新测试。平台记录：macOS APFS（大小写不敏感）下同目录无法并存仅大小写不同的两个文件，冲突检测返回 0 组；FIFO、权限（chmod 000）与 symlink 已实测；Linux／Windows 实测未做，保持 untested。见[3.3–3.5 记录](implementation/2026-11-14-3.3-3.5-scope-publish-refresh.md)）
- [x] 3.4 实现不可变正文写入、同目录头替换及本机聚合替换，返回明确三态；注入写入前、rename 前后、回读和本机确认失败，观察 not-published／published／unknown 及隔离行为，并写明断电保证限制。（2026-11-14：`adapters/fs/atomic-write.ts` + `publish.ts`；资料头 `published／not-published／unknown`、正文 `written／already-present／conflict`、本机聚合 `saved／not-saved／unknown-state`。注入写入前／rename 前→not-published 且清理临时文件；rename 后／回读前→unknown 且文件已替换；外部改字节→unknown（reread）。孤立正文在资料头引用前报 `orphan-body`，发布后通过。断电限制已写入 README 与 BOUNDARIES：仅临时文件 + rename + 回读，无目录 fsync，不宣称断电安全）
- [x] 3.5 实现重读完整资料基线及显式刷新；用外部顺序追加记录、未知 schema、冲突标记、非法树、同路径项目身份变化测试验证不被旧缓存覆盖，并补外部编辑暂停／校验／刷新说明。（2026-11-14：`application/baseline.ts` 读头字节哈希 + 逐条正文核对；`LocalStateService.refresh` 计算 changes 并推进源代际；`local refresh` 命令。6 项新测试覆盖首次基线、无变化、外部追加、仅排版变化、未知 schema／冲突标记／非法树／正文哈希不符／身份变化；失败不推进代际。外部编辑“暂停→校验→刷新→继续”写入 README）

## 4. 统一命令、幂等与恢复

- [x] 4.1 实现规划与私有记录命令封套、访问校验、不可变变换和每实例提交队列；测试 UI／工具同规则、过程记录不推动规划版本、真实规划冲突和完成命令条件，补接口说明。（2026-11-14：`domain/commands.ts`（update-node／set-node-status／记录索引追加，`applyPlanCommand` 重算指纹 + 完整校验）、`application/command-queue.ts`、`application/command-service.ts`、`cli/command.ts`；8 项新测试覆盖双修订、两入口同规则与伪造上下文拒绝、记录只推状态且原规划基线仍可用、过期 planVersion／revision 冲突、done 需条件与验证记录、源代际与身份、并发队列只成功一条、正文／头失败结局。幂等回执与 prepared／publishing／committed 阶段属 4.2–4.5，见[4.1 记录](implementation/2026-11-14-4.1-command-envelope.md)）
- [x] 4.2 实现先查原意图／回执的幂等协议与稳定生成 id；以响应丢失、同 id 不同参数／归属、未授权回执查询、无业务变化和重启后原样重试测试验证。（2026-11-14：聚合新增 `OperationRecord`（摘要、归属、状态、原始输入基线、稳定生成 id、结果快照），执行前写 pending 意图、完成后写回执；`getReceipt` 按归属隔离。8 项新测试覆盖原样重试返回历史结果且不写盘、同 id 换参数 `operation-mismatch`、换归属 `forbidden`、回执越权查询拒绝、无业务变化只推状态修订、重启后重放、未决意图不重跑、意图写入失败不发布；另修复 CLI “重试取当前基线”导致误判的问题——记录保存原始基线并优先回取。见[4.2 记录](implementation/2026-11-14-4.2-idempotency.md)）
- [x] 4.3 实现 prepared／publishing／committed 阶段及正文→资料头→回执顺序；在各边界中断进程并重开，验证未引用正文不发布、意图失败不发布、通知失败不撤回提交。（2026-11-14：`OperationRecord` 增 `prepared`（候选头全文／哈希、正文清单、预算结果）与四阶段状态；`command-service` 按 prepared→publishing→正文→头→回执 顺序执行，未决记录阻塞新命令，回执未落盘改为待核对，通知失败被吞掉不影响结果。9 项新测试覆盖：正文先于头、prepared／publishing／正文／头 not-published 各自结局、头 unknown 停 publishing 且重开后被 `instance-blocked` 阻止、回执失败 `stage=receipt`、通知失败仍 committed、prepared 保留候选头供恢复核对。自动恢复属 4.4，见[4.3 记录](implementation/2026-11-14-4.3-phases.md)）
- [ ] 4.4 实现精确候选核对、恢复回执与双修订一次性完成；测试完成前后反复重启不重复推进计数，并测试旧基线重现、分叉、Git 顺序回退后只查历史不重放。
- [ ] 4.5 实现 pending-reconciliation 诊断及本机 unknown-state 隔离；实际文件后端注入未知结果，确认停止对应源写入／实例读写、保留操作 id，补只读诊断及离线恢复说明。

## 5. 面板、快照与本地化

- [ ] 5.1 实现完整快照查询及先订阅再回读协议；测试读取中变更、混合资料拒绝、已知最高修订追读和树／规划摘要一致，交付 Remote 契约说明。
- [ ] 5.2 实现小树、详情、目标编辑、节点新增、变更原因与位置展示；在实际 profile 中经统一命令保存并回读，保存失败或冲突时草稿保留且不标已保存。
- [ ] 5.3 实现 Client 连接代际、源代际、stateRevision 和草稿分离；以旧连接／旧源／乱序快照／旧回执测试和真实断线重连验证不覆盖新状态或丢编辑。
- [ ] 5.4 注册完整中英 UI 字典与包元信息，加入 key／占位符／固定文案检查；故意缺失 key 的反例应失败，实际安装包能读取全部资源，补 locale 边界说明。
- [ ] 5.5 实测运行中语言切换、英文回退、重启选择、长文本、数量及记录时间；核对节点选择、未提交输入、项目原文和版本不变，字典重载不重复注册。

## 6. 聊天、可信绑定与真实 Agent

- [ ] 6.1 实现多对多聊天关系及创建／复用／打开流程；在真实宿主中验证实际 Session id、空会话复用、失效关联和双实例隔离，并测试创建结果未知时不盲目再建聊天，补使用说明。
- [ ] 6.2 实现工作意图、真实消息准入映射与活动 WorkRun；依据 2.4 结论测试排队消息不覆盖当前目标、浏览 B 不改变 A、同轮不明确归属拒绝绑定、私有授权不随公开资料导入。（显式承接 2.4b（i）／V25b（i）：实现绑定层后复测绑定准入与 agent 缺失／归属不唯一的拒绝，复测结果计入 R1。）
- [ ] 6.3 实现 project_read／apply／record／receipt 工具及输出 schema；通过真实工具调用与伪造参数反例验证 Session／WorkRun／授权字段无效，绑定外写入被拒绝，补工具协议说明。
- [ ] 6.4 实现有来源动态上下文和明确接续；测试建议／决定／未核查项区分、新材料不静默改目标、提交后新基线绑定、旧并行调用不能借新权限。
- [ ] 6.5 实现结束、取消、卸载和 Host 重启的绑定失效；真实观察 queue／steer／turn 终态与工具 abort，核对新写入停止、在途发布待核对和 Client 断线不取消 Host，缺少可信链路时记录 blocked。（显式承接 2.4b（i）／V25b（i）：同一绑定层下复测 agent 缺失／归属不唯一的拒绝，复测结果计入 R1。）
- [ ] 6.6 用真实 Agent 在明确允许的节点内根据新信息新增或拆分并记录原因；面板回读实际结果，换回关联聊天并重启检查身份／记录保留，不能用手工调用工具替代该演示。

## 7. 整体交付核查

- [ ] 7.1 从预构建 tarball 重走“安装→中英小树→保存→聊天→Agent 调整→UI 已提交→Client 断线重连完整回读→重启恢复→卸载及重新安装→核对原资料／回执”，将 V32 和 V04 作为 V37 的必做步骤；在三种位置验证资料边界，记录实际环境、重复步骤和证据定位，重装后旧 WorkRun 不恢复写资格。
- [ ] 7.2 作为 7.1 的组合脚本部分，验证最终包卸载／重载无重复服务、监听、导航或字典，重新安装及 Client 重连后原资料和历史回执仍一致；结合在途命令中断确认无未知状态被吞掉。
- [ ] 7.3 对照六份 specs 和 validation-matrix 逐项核对实际结果，运行 OpenSpec 严格校验、仓库门禁及插件完整检查；手写结论和未解决项回写本 change 及 R1 路线图，原始运行证据留本机，fail／blocked 不改标 pass。

## Workflow follow-up

- 第 1 轮外部审阅已落 `review.md`，作者按其修订并在 `review-response.md` 记录处理和校验，复查通过后按工作流提交；提交保存的是已审阅修订的提案，不代表外部二次放行、产品实现或归档。这些步骤不计入产品实现任务进度。
- 保留原 review，不填写虚构审阅者或勾选任务。实施遵循用户的实际授权；当前仅处理提案 review。
- 实施验证完成后按项目流程处理 change 归档；提案提交、tasks 全勾和 R1 达成分别核对，不自动 push 或打 tag。
