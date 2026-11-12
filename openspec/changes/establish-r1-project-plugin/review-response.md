# 第 1 轮 review 处理与提案复查

日期：2026-11-12。外部审阅原文见 [review.md](review.md)，原文保留不改；作者收到用户“可以看 review 了”的交接后进行本轮修订。本记录是编写 Agent 的逐项处理和复查，不是外部第 2 轮审阅，不改写原 review 的“需修订后复查”结论。按现行工作流，作者解决意见、复查后提交提案；当前不开展产品实现。

## 逐项处理

本轮采纳 A1、A2、B1–B4、C1–C5，没有将影响契约的问题延期到实现。

| 编号 | 处理结果与位置 | 复查边界 |
|---|---|---|
| A1 | [design §5](design.md#5-应用接口与命令封套)新增 Remote／工具／其他进程内三类入口判据，可信上下文为适配器捕获的判别联合；§6 第 1 步按入口分派，§7 保持工具与 WorkRun 匹配。聊天 spec 新增无 invocation 的合法工具、空 principalOf／伪造主体、缺 agent 三个场景；tasks 2.4、V25 要求真实实测 | owner 必须有真实合法 invocation／peer；工具不得借 owner 权限，也不因缺 invocation 自动拒绝；agent 缺失拒绝新绑定并记 blocked。源码已核对，运行仍 untested |
| A2 | 新增 [v1-plan 正文](formats/v1/plan-canonicalization.md)和 [17 个强制向量](formats/v1/plan-vectors.json)，明确字节编码、UTF-16 递归键序、集合白名单、精确整数、null／布尔、未知字段等；design §3 引用为规范工件，要求随包及资料分发。公开资料 spec、tasks 1.3／1.5、V11 加入独立实现复算 | 用独立 Python 编码构造向量，再用未导入主编码函数的 Node 实现核算；12 个正向字节／散列匹配、5 个负向拒绝。这只验证提案工件，不将 V11 或 N15 产品能力标 pass |
| B1 | V37 现要求串行包含 V32 重连和 V04 卸载／重装，并核对资料及历史回执；tasks 7.1／7.2 和矩阵映射同步 | 单项各自 pass 不能代替组合脚本；旧 WorkRun 重装后不得恢复写资格。全部运行 untested |
| B2 | proposal 范围段、矩阵映射与完成判据、路线图 R1 对应行明确树／规划摘要是 R1 的第二投影，R2 再验实际路线图 UI | 不把摘要一致当作路线图已实现或已验收；N12 整体方向保留 |
| B3 | 公开资料 spec 新增全新本机环境首次接入场景，tasks 3.1 和矩阵 V38 独立覆盖：仅外部 v1 文件、原 id 保留、新本机实例、不依赖原数据库、不导入授权／回执 | 本机新根基础接入不代替 R2 Git 协作或 R6 真实跨环境；运行 untested |
| B4 | 下节补录原编写工具为独立安装的 OpenSpec 1.17.0、本轮准确版本／命令／输出摘要；config 标注 R1 所用版本，工作流增加版本化交接要求。外部 review 的 2.0.0 补跑单列归属 | 原编写结果来自本聊天的实际工具输出，不是用 review 的 latest 结果补冒；本轮重新运行 1.17.0。2.0.0 未由作者重跑，不升级工具或混同结论 |
| C1 | design §1 去掉“系统 Node 26”固定前提；tasks 2.1／2.3 要求二进制与补丁版本；[宿主复审](../../../docs/research/2026-11-11-dsh-host-capability-review.md)与[开工复核](../../../docs/reviews/2026-11-12-dsh-rc2-development-readiness.md)分别保留环境观察并补说明 | 本轮 shell 实测 v26.13.0，随包独立二进制 v24.21.0；review 的 v22.22.2 保留为其环境观察，缺当时 PATH 不推断升级／降级；未启动 Host，不代表 Host 实际使用版本 |
| C2 | design §7 补工具 agent 可选性、缺失即拒绝绑定条件，并补 Agent.id 的 types.ts:18 与工具 contracts.ts:188 等固定源码链接；tasks 2.4／V25 同步 | 缺 agent／归属不唯一显式为 blocked 条件，不通过模型补值。实际工具映射 untested |
| C3 | design §1 和 tasks 2.2 列全 manifest 字段，tasks 2.1 分别验证包管理器 engines 和宿主 includePrerelease 兼容处理 | 不假定字符串比较或安装／启动判据相同；依赖安装和真实启动仍 untested |
| C4 | proposal、tasks、矩阵、config、change 索引、AGENTS、文档地图／决定索引／路线图／架构／产品及中英 README 同步为第 1 轮外审后修订、待实施；workflow.md 与 review／response 随提案一同纳入本次提交 | 不写外部二次放行，不把提案提交当产品完成；原 review 内的历史“未提交”描述保持原样 |
| C5 | [接入调研新增静态补核](../../../docs/research/2026-11-11-dsh-project-management-review.md#2026-11-12-r1-审阅修订身份与请求边界静态补核)，登记 principalOf、可选 agent、Agent.id、rpcId、claimed／pre-step、home 解析和兼容检查源码事实 | 每项都注明只读 rc.2 源码、运行 untested；design 不把符号存在当真实接入通过 |

原 review 引用工作流“第 9／11／14 条”是其当时行级定位表述；当前工作流正文是六步编号及后续规则，处理依据为“保留 review、逐项修订、复查后再提交”的实际条款，不改动审阅原文来修正其定位。

## 校验工具与可复现入口

本 change 编写及本轮复查使用**本机独立安装的 `@fission-ai/openspec@1.17.0`**，不在本仓创建产品 package.json 或装插件依赖。`OPENSPEC_CLI` 是本次工具安装目录下 `node_modules/@fission-ai/openspec/bin/openspec.js` 的实际绝对路径；其他环境可先安装完全相同的 1.17.0 版本并设置该变量，或用 `npx --yes @fission-ai/openspec@1.17.0` 替代 `node "$OPENSPEC_CLI"`。不得使用 latest 复现本次结论。

在本仓根目录执行的精确参数：

```sh
node "$OPENSPEC_CLI" --version
node "$OPENSPEC_CLI" validate establish-r1-project-plugin --type change --strict --no-interactive --json
node scripts/check-repo.mjs --all
git diff --cached --check
```

本轮命令调用环境为 login shell 的 `/usr/local/bin/node`，`--version` 实测 `v26.13.0`；另直接调用桌面应用 primary-runtime 的 `dependencies/node/bin/node --version` 得 `v24.21.0`。二者仅用于标识校验与前置环境，不证明插件安装、运行时或跨平台兼容。

## 原编写阶段记录（补录）

本聊天前一编写轮的实际工具输出如下，原始记录未因补录而改标运行结果：

| 检查 | 版本／参数与输出摘要 |
|---|---|
| OpenSpec 严格校验 | 1.17.0；上述 validate 参数，`valid: true`、`issues: []`，1 项通过／0 失败 |
| 全部新文件仓库门禁 | 因 --all 洁净度读取 Git 索引，实际工作区暂存区保持空，用包含 73 个已跟踪及非忽略新文件的临时仓库快照运行门禁；洁净度 0／0、32 自测通过、i18n 自测通过、链接 53 篇 0 问题、双语 5 对 0 问题 |
| 改动空白检查 | 在同一快照中限定本轮 25 个新增／修改文件检查，通过；未改历史 product-decisions.md 的原有末尾空行 |
| 外部 review 补跑 | review 记载临时 CLI 2.0.0 严格校验通过，归外部审阅 Agent；其直接工作区门禁只计 61 个索引文件／42 篇文档，不能替代作者对全部新工件的快照检查 |

## 本轮复查结果

协议向量已由独立 Node 实现核算：12 个正向的 canonical 字节及 SHA-256 全部匹配，5 个负向按预期拒绝；中文／键序／缩进／输入转义／物理集合排序／记录追加为同一散列，业务 order 或目标变化为不同散列。未执行产品 schema、文件发布、DSH／Agent 运行，不勾选 tasks，也不修改 V01–V38 的 untested。

本轮已运行 OpenSpec 1.17.0 严格校验，输出 `valid: true`、`issues: []`，1 项通过／0 失败。全部本轮工件已纳入实际 Git 索引，`node scripts/check-repo.mjs --all` 检查 77 个文件：洁净度 0 失败／0 警告、32 项自测通过，i18n 自测通过、链接 56 篇 0 问题、双语 5 对 0 问题；`git diff --cached --check` 通过。提交 hook 另对最终暂存快照重跑仓库门禁。

静态结构复核为 6 个能力、31 个 Requirement、74 个 Scenario；34 项实现任务均未勾选，38 个运行矩阵条目全为 untested。原 review 的 SHA-256 保持 `39e07a8ea73c4416960f447ce6071d9990cb3caeed585ecfcbad4ade8a8c19ba`，未篡改外部评审。此次提交包含审阅工作流、原提案、外部 review、本响应及修订工件，未发现仍需延期处理的提案级阻塞项；运行可行性仍按任务前置实验检验。
