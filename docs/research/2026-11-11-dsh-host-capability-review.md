# DSH 宿主能力与迁移前提复审

日期：2026-11-11。性质：静态核查与讨论材料，**不新增产品决定，也不代表插件功能已经验证**。

用户明确要求：对从 Windows 独立 Agent 应用转向 DSH 插件、开发迁移至 macOS 后的内容重新严谨检查和讨论。现有文档中的“不重新讨论”不阻止本次复审；历史记录仍按原貌保留。

后续适用性（2026-11-11）：当前已转为[项目管理方向](../product/2026-11-11-project-management-design.md)，文件恢复不是架构驱动力。本文保留为宿主信任边界与文件恢复专题调研，其中关于首版文件恢复流程的建议不作为当前项目管理讨论顺序。

## 版本与核查范围

- 上游：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。
- 核查当日（2026-11-11）GitHub Release 列表的最新条目：[dsh-v0.2.2-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1)，2026-11-04 发布，标记为 **prerelease**。`releases/latest` 接口返回 404；版本取自 Release 列表，不能据此把它称为正式稳定版。2026-11-12 上游已发布 rc.2，见下文「版本同步与复核」。
- 原始 tag 对应提交：`66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`；rc.2 对应提交：`ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`。下文上游链接已同步固定至 rc.2 提交，正文结论仍按 2026-11-11 的核查范围保留。
- 复审时本机已安装的桌面应用：Info.plist 与应用内包清单均为 `0.2.2-rc.1`。当时随应用交付的运行时元数据声明 Node `24.21.0`、pnpm `11.28.5`；CLI 包声明 Node `>=24.9.0`（rc.2 源码包复核仍为 `>=24.9.0`）。2026-11-12 实测本机 Info.plist 已为 `0.2.2-rc.2`，未重新读取 rc.2 发行包内的运行时元数据。
- 本机开发环境另行核查：复审当时 shell 实际使用 Node `26.13.0`（arm64）、npm `11.20.0`，与 Node 官方发行列表当日最新 LTS 一致；macOS PKG 安装记录匹配。DSH 随包 Node 的 `--version` 当时实测为 `24.21.0`。系统开发环境与宿主随包运行时是两套安装。2026-11-12 复核时 shell 中 `node --version` 为 `v22.22.2`，与复审记录不同，属开发环境变化，不改变上述口径区分。
- 已读当时本机发行包内的相关 README、包清单及部分编译后实现；并读取上游文件系统围栏、会话检查点策略、本地子进程提供方的 TypeScript 源码进行交叉核对。未进行发行包与上游源码的完整一致性验证；上游完整目录树下载超时，未完成全仓审计。2026-11-12 已取得完整 rc.2 源码快照并逐文件校验，仍未做全仓逐行审计。
- 发行包包含某个插件不代表当前 profile 已启用它；本次未读取个人会话或配置来确定实际启用组合。
- 未启动 DSH、未加载插件、未修改 DSH 安装或个人配置、未执行破坏性样例。本文所有运行验证项均为 `untested`。

## 版本同步与复核（2026-11-12）

- 上游 [dsh-v0.2.2-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.2) 于 2026-11-11T11:33:06Z 发布，仍标记为 prerelease；用户已更新本机桌面应用（Info.plist 实测 `0.2.2-rc.2`），本机 `Developer/tools/deepseek-harness/` 源码快照也已由 rc.1 替换为 rc.2，旧快照移入系统废纸篓。用户明确在本插件开发出第一个版本之前不再更新本机 DSH 软件，本阶段以 `0.2.2-rc.2` 为固定基线；归档校验数据、逐文件比对与官方 raw 抽样结果见[项目管理接入调研](2026-11-11-dsh-project-management-review.md)的「2026-11-12 源码快照校验与差异复核」。
- 与本文结论直接相关的 rc.2 复核：`fs/fs-sandbox/src/index.ts`、`session/session-checkpoint-policy/src/index.ts`、`util/home-paths/README.zh.md` 字节未变；CLI 包清单有更新，但 `engines.node` 仍为 `>=24.9.0`；`boot/plugin-manager/README.zh.md` 仍写明「已安装的 Host 代码在宿主进程内运行，不受工作区沙箱限制」，并补充「依赖构建脚本仍需单独批准」；`experimental/worktree/README.zh.md` 仍写明创建「仅限本地提交……不复制未提交文件」。§1、§4、§6 与 §7 的判断未被推翻。
- `session-controller`、`ui-workspace`、`system-prompt` 的文档或源码有更新，已抽查「复用合格空白会话并返回实际 Session」「保留未发送草稿」「动态 context」等语句，结论仍成立；未逐行复核这些文件的全部改动。
- rc.2 发布说明中与本文相关的条目：可选插件加载失败不再阻断 Web 页面、未运行插件显示原因；Git Worktree 审阅能力增强与创建等待放宽；停止任务／关闭会话时中止与资源释放的修复。这些是发布说明层面的信息，不构成对子进程停稳、路径竞态或文件恢复能力的运行验证。
- 本次版本同步没有启动 DSH、没有加载插件、没有复跑任何验证项；本文「建议的讨论与验证顺序」中的项目仍全部为 `untested`。

## 主要发现

### 1. 宿主插件与受限命令属于不同信任范围

DSH 插件管理文档明确：安装的 Host 代码在宿主进程内运行，不受工作区沙箱限制。沙箱服务则为受限消费方启动的命令提供逐调用文件策略；策略本身不表达网络、设备、凭据等限制，读取也不能据此视为受限。

因此，“不自研沙箱”可以继续作为路线选择；“宿主已经保护插件的全部读写与备份”则没有成立依据。插件直接使用 Node 文件 API 时，不能假定自动继承当前会话的权限、审批与路径检查。

版本内容与账本是否能被模型调用的命令改写，还取决于存储位置、沙箱模式、额外可写目录及权限升级；仅配置 `dataRoot` 不会产生保护边界。

依据：[插件管理](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/boot/plugin-manager/README.zh.md)、[沙箱约定](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/sandbox/sandbox/README.zh.md)。

### 2. 有工具执行扩展点，但不等于覆盖全部文件写入

DSH 提供 `tools/pre-execute`、`tools/execute`、`tools/post-execute`、`tools/result`。其中 `tools/execute` 可以在调用工具正文前等待持久化屏障，内置会话检查点策略就是实例，因而“快照失败则阻止当前调用”存在可研究的接入位置。

但自定义执行器可以不使用共享流水线；后台任务可在工具返回后继续运行，外部编辑器、其他会话、插件自身以及独立传输也不能仅凭这些事件认定已覆盖。工具批次也可能并发分派。

结论仅为：存在接入候选，尚不能承诺“每次文件变化前都有完整检查点”。需要先定义受保护的执行入口、并发范围和快照一致性条件。

依据：[工具约定](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/core/tools/README.zh.md)、[后台任务](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/jobs/jobs/README.zh.md)、[检查点策略源码](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/session/session-checkpoint-policy/src/index.ts)。

### 3. 宿主的会话检查点不等于文件检查点

`dsh-session-checkpoint-policy` 在模型请求、顶层工具正文及下一步骤前刷新会话持久化。源码调用的是 `ctx.sessions.flush`，不是工作区文件捕获。

它记录执行意图、请求与结果；中断工具以未知结果恢复，不自动重试。该机制不能直接证明文件内容可恢复、交付完成，或外部副作用已经撤销。

插件应明确区分会话恢复与文件恢复，并研究如何关联调用标识、文件版本和交付账本。这里尚未选定格式或存储实现。

依据：[会话检查点策略](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/session/session-checkpoint-policy/README.zh.md)。

### 4. 已有 worktree 能力，但与旧 Cona 工作副本并不等价

实验性 `worktrees.create` 从本地 Git 提交创建新分支和检出目录，再切换当前会话工作目录。暂存、未暂存、未跟踪和被忽略文件均不复制，也不安装依赖；恢复检出目录不能找回从未提交的改动。

它可作为 Git 项目的候选基础，但不能直接满足“导入当前项目完整文件状态”或非 Git 项目保护。Git 元数据由多个 worktree 共享，不能把独立检出目录描述为所有仓库状态相互隔离。

此外，工作目录切换保留已有进程的目录；沙箱策略使用会话不可变的工作区 cwd，创建 worktree 不扩大既有写权限。自定义 worktree 目录是否可写、原项目是否仍可写、旧 shell 是否仍写入原项目，都必须分别核查。

依据：[worktree](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/experimental/worktree/README.zh.md)、[工作目录](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/session/working-directory/README.zh.md)、[沙箱策略](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/sandbox/sandbox-policy/README.zh.md)。

### 5. macOS 上不能据命令结束宣称全部写进程停止

子进程约定区分直接命令结束的 `done` 与受管范围停稳的 `waitForExit()`。本地提供方明确：macOS 使用较弱的进程组／进程树 fallback；逃离进程组或观察范围的后代不保证终止，也不保证阻止 `waitForExit()` 完成。

因此，旧规范中的“确认受限写进程停止后才恢复”需要重新定义覆盖范围。取消会话、收到工具结果或调用进程终止接口，都不能直接推导出整台机器已无写入者。

需要讨论支持合作式任务还是对抗性任务，以及终态未知时怎样等待、拒绝或由用户处理；当前没有验证结论。

依据：[子进程约定](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/subprocess/subprocess/README.zh.md)、[本地提供方及限制](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/subprocess/subprocess-local/README.zh.md)。

### 6. 宿主文件工具没有承诺消除全部路径竞态

`fs-sandbox` 在变更前重新规范化目标并检查可写范围，但文档和源码明确接受重新检查至系统调用之间的剩余 TOCTOU 窗口。它是可信代码对模型输入路径的策略围栏，不是对任意并发路径替换的内核级边界。

旧规范要求在实际写入时防止目标替换与并发覆盖；直接调用宿主文件服务不足以证明已经满足这一要求。“纯 Node ESM、不调用平台原生 API”与这种强保证能否同时实现，需要结合威胁模型、宿主服务及具体算法验证，不能先宣称可行或不可行。

依据：[文件系统围栏源码](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/fs/fs-sandbox/src/index.ts)。

### 7. 数据目录与 Node 版本需要分清插件、宿主和仓库脚本

DSH 主目录解析支持显式配置、`DSH_HOME`、默认 `~/.dsh`。复审时本仓曾同时存在以下口径（保留问题来源，不代表当前文档仍如此规定）：

- [产品决定 §6](../product/product-decisions.md)：`Config.dataRoot` 的具体取值待定。
- [贡献说明](../../CONTRIBUTING.md)：运行时数据只进 `.dsh-cona/`。
- [忽略清单](../../.gitignore)：将 `.dsh-cona/` 称为默认数据根，并写入便携包旁 `data/` 等产品表述。
- [门禁脚本](../../scripts/check-hygiene.mjs)：强制产品代码不使用部分系统用户目录／临时目录 API。

这些规则需要复审其来源与适用范围；宿主默认使用用户主目录不自动决定本插件的数据位置，仓库开发产物目录也不能自动成为插件的部署位置。

后续同步（2026-11-11）：贡献说明与忽略清单已改为仓库本机实验用途，不再把 `.dsh-cona/` 或便携包旁 `data/` 规定为插件部署落点。系统目录门禁暂保留原判据，待项目存储方案确定后再评估；这不构成数据位置或便携能力已经定稿。

本仓 OpenSpec 配置与 CI 使用 Node 20 口径，而该版 DSH CLI 要求 Node `>=24.9.0`。**Node 20 是仓库配置口径，不是本机实装版本**：本机当前开发 Node 为 `26.13.0`，DSH 随包 Node 为 `24.21.0`。这不证明仓库脚本不能在 Node 20 运行；它表明以后需分别记录仓库门禁、插件开发及宿主运行时的兼容范围。

依据：[DSH 主目录库](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/util/home-paths/README.zh.md)、[CLI 包清单](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/apps/cli/package.json)、[Node 官方发行列表](https://nodejs.org/dist/index.json)。

## 旧文件规范的迁移判断

对照 [workspace-recovery-prototype](../../openspec/specs/workspace-recovery-prototype/spec.md)，以下是讨论建议，不是替代规范：

| 旧要求 | 当前需要补齐的前提 |
|---|---|
| 原项目、工作副本与版本存储相互保护 | 确认是否采用副本、保护哪些仓库状态，以及命令对原项目／版本存储的实际权限 |
| 捕获实际文件变化并拒绝不完整恢复点 | 定义接入时机、并发写入规则、内容与元数据范围、容量与失败策略 |
| 授权基线与交付前恢复点 | 确定插件交付与宿主权限／审批如何衔接，以及交付是否仍是副本写回原项目 |
| 回退保护后续编辑 | 定义冲突识别、逐文件处理、同名重建与并发修改的可验证规则 |
| 路径和并发检查有效 | 明确信任范围、进程停止证据及路径竞态保证，不能只写“宿主负责” |
| 中断不冒充完整成功 | 建立文件事实与插件操作账本的恢复协议，区分宿主会话持久化 |
| 恢复边界有说明和证据 | 保留文件恢复与外部副作用的区分，同时明确支持的元数据 |

## 建议的讨论与验证顺序

1. 先确定首版用户流程：直接修改项目后按文件回退，还是在副本中工作再受控交付；是否覆盖非 Git 项目与未提交文件。
2. 明确保证：主要防误操作，还是包含恶意／逃逸命令；保护范围是否包含人工编辑、其他会话与后台进程。
3. 在以上范围内选择宿主服务与插件职责，再讨论文件版本格式、数据落点和实现限制。
4. 建立最小接入实验，逐项记录 `pass` / `fail` / `blocked` / `untested`；当前均为 `untested`：
   - native／PTC／嵌套调用的执行前屏障、失败阻断和取消；明确自定义执行器覆盖范围。
   - 文件快照期间的并发命令、后台任务、其他会话及外部写入。
   - worktree 切换前后的 cwd、写权限、旧 shell、未提交文件及非 Git 输入。
   - macOS 子进程取消、派生与脱离进程组后的可观察停稳边界。
   - 路径替换、symlink、hardlink、大小写、权限位及其他支持范围内的元数据。
   - 快照、交付、恢复期间的存储失败、进程中断与重开核查。

本次结果支持重新审视迁移前提；不构成选择上述任何产品流程、降低旧规范要求或恢复旧 Windows 沙箱方案的决定。
