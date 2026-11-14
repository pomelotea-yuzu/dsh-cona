# dsh-cona-project 包边界说明（tasks 1.1）

包名 `dsh-cona-project`（design §1，组合包、四层目录）。本文记录 R1 已落地的边界与验证方式；接口签名为草案，随第 3–6 段任务细化。

## 目录与依赖边界

| 目录 | 依赖及职责 | 边界验证 |
|---|---|---|
| `src/domain/` | JSON 数据结构、纯变换、树／依赖／完成条件校验、v1-plan 指纹；**无 Node、Cordis、React** | `tsconfig.domain.json`（`types: []`、纯 ES2022 lib）+ `scripts/check-boundaries.mjs` |
| `src/application/` | 命令、查询、可信调用上下文、提交及恢复；调用 ports 和领域核心 | 3.1 `SourceService`；3.2 `LocalStateService`；3.5 基线与 `refresh`；4.1 `ProjectCommandService` 与每实例队列；回执与恢复在 4.2–4.5；5.1 `ProjectSnapshotService` 与 `InMemoryChangeStream` |
| `src/adapters/` | 文件、本机状态、DSH 会话和身份映射、Remote／工具入口 | 3.1／3.2 位置、Git、资料头、本机状态与锁；3.3 范围解析；3.4 原子替换与三态发布；Remote 在 3.6 |
| `src/client/` | 面板、编辑草稿与保存状态机、传输（`PanelTransport`）、字典；不写文件或复制业务规则 | 5.2 `panel-controller`／`http-transport`／`ProjectPanel`；`test/panel-controller.test.ts`；边界脚本禁 `node:` |
| `src/host/` | Cordis 服务装配、依赖注入和生命周期 | 第 2 段实现 |
| `src/cli/` | 独立校验命令：纯 Node，无 DSH 服务 | `test/cli.test.ts` |
| `formats/v1/` | JSON Schema、资料 README 模板、协议正文与向量副本、合法样例 | `scripts/check-protocol-sync.mjs` |

## 已落地的决定

- **严格 JSON 解析与领域校验由主实现与独立指纹实现共享**；独立性要求（协议 §5）针对**序列化函数**：`plan-fingerprint-alt.ts` 不 import 主实现的 `encodeCanonical`／`quoteCanonical`／`utf16Compare`／`sortProjectionWhitelists`，比较器与引号编码逐码元手写，两条路径对全部向量交叉复算。
- **内容哈希注入**：domain 通过 `Sha256Fn` 端口接收 SHA-256，Node crypto 由 CLI／适配器注入，domain 保持无 Node 依赖。
- **UTF-8 编码手写实现**（`canonical/utf8.ts`）：domain 不依赖 TextEncoder／Buffer；孤立代理在编码前已被 strict-json 拒绝。
- **UUID 形态**：小写 RFC-4122 v4（`crypto.randomUUID` 输出形态），定义于 `validate-constants.ts`。
- **engines.node `>=24.9.0`** 为设计起点（design §1）；本机开发实测：系统 Node `/usr/local/bin/node` = v26.13.0（满足），沙箱开发环境自带 Node 22.22.2（低于声明线，仅用于开发期测试运行，正式验证与 CI 以 Node 24+ 为准）。实际宿主 Node 核对在 tasks 2.1/2.3 完成，结果回写 change。
- CLI 临时目录放在包内 `artifacts/`（仓库门禁禁止 `os.tmpdir()` 与机器绝对路径；`artifacts/` 已被 .gitignore 与洁净度门禁排除在跟踪之外）。

## 尚未验证（保持 untested）

- 独立包构建、tarball 安装与真实宿主加载（第 2 段）。
- 意图日志、幂等回执与恢复状态机（4.x）；3.4 只做单步三态与注入观察。
- 断电持久性：只有临时文件 + rename + 回读，没有目录 fsync，未做突然断电试验。
- 面板同步、i18n、聊天绑定与真实 Agent 演示（第 5–6 段）。

## 3.1 落地的边界（资料位置与基础接入）

| 文件 | 责任 | 不做什么 |
|---|---|---|
| `src/application/location.ts` | 位置种类白名单、必填基准、相对分段（不拼平台路径） | 不读文件、不解析绝对路径、不发现仓库后自动换位置 |
| `src/application/source-service.ts` | preview／create／attach 编排、非空拒绝、写入后回读核对 | 不登记本机实例、不写回执、不做命令幂等（3.2／3.4） |
| `src/adapters/fs/location.ts` | 用 `node:path` 落实绝对根；拒绝相对、`..`、NUL；home 折叠显示 | 不做 realpath／大小写／符号链接范围检查（3.3） |
| `src/adapters/fs/git-status.ts` | `rev-parse`／`ls-files`／`check-ignore`／`status` 只读观察 | 不执行 add／commit／checkout／config；不知道就 unknown |
| `src/adapters/fs/project-json.ts` | 固定键序序列化、同目录临时文件 + rename、回读字节核对 | 不宣称断电安全，不给 unknown 三态（3.4） |
| `src/adapters/fs/source-files.ts` | 资料根检查、格式资源复制（`COPYFILE_EXCL` 不覆盖） | 不判断项目合法性（领域校验负责） |

三条约束：

- 创建即生成一个根节点：v1 领域校验要求至少一个根（`root-count`），空 `nodes` 不是合法资料；「空规划哨兵」属命令层（3.4），不是空树文件。
- 接入是纯读取：不写注册表／回执／授权，返回 `registry: "pending-3.2"` 明示未持久化。
- 位置解析在 application 与 adapters 之间分工：种类与分段是应用语义，绝对路径与分隔符是平台语义。

## 3.2 落地的边界（本机根、注册表与实例聚合）

| 文件 | 责任 | 不做什么 |
|---|---|---|
| `src/application/local-state.ts` | 本机根计划、根隔离判定、注册表／聚合形状、`register／list／show` 编排 | 不拼路径、不直接读写文件、不做命令回执（3.4） |
| `src/adapters/fs/local-root.ts` | 绝对根解析与显示；`same／nested／disjoint` 关系 | 不做 realpath 与大小写归一（3.3） |
| `src/adapters/fs/local-state.ts` | `registry.json`、`instances/<id>/state.json` 原子写、`lock.json` 独占锁、进程内写者登记 | 不按超时抢占遗留锁；不在锁外写注册表 |
| `src/adapters/fs/git-guard.ts` | 私有根检查：仓库内必须无已跟踪文件且被 ignore 覆盖 | 不改 `.gitignore`、不 add；git 不可用时标 `checked: false` |
| `src/adapters/fs/git-run.ts` | 只读 Git 子进程调用（状态与私有根共用） | 不封装任何写操作 |

三条约束：

- 公开资料与本机运行数据物理分离：注册表与聚合存放绝对路径、实例 id、修订号，这些字段一律不进 `project.json`。
- 注册顺序：先写实例聚合，再写注册表；注册表不得指向不存在的聚合。发现注册表指向缺失聚合时拒绝复用，不自动重建实例。
- 锁语义：进程内同根第二个写者直接拒绝（`local-writer-duplicate`）；跨进程用 `wx` 独占创建 `lock.json`（`local-lock-held`），遗留锁只能通过 `--force` 或持有者 token 显式释放。

## 3.3–3.5 落地的边界

| 文件 | 责任 | 不做什么 |
|---|---|---|
| `src/domain/relative-path.ts` | 公开相对引用分段协议（拒绝绝对、盘符、反斜杠、NUL、`.`／`..`、编码绕过） | 不碰文件系统、不判断存在性 |
| `src/adapters/fs/path-scope.ts` | 逐段 symlink 检查、中间段目录检查、目标类型、写目标 hardlink、realpath 复核、范围读取与目录列举、大小写冲突检测 | 不做大小写归一或自动重命名；不跟随 symlink |
| `src/adapters/fs/atomic-write.ts` | 同目录临时文件 + rename + 回读，三态结果与阶段 | 不做目录 fsync；不宣称断电安全；rename 后异常一律 `unknown` |
| `src/adapters/fs/publish.ts` | 正文内容寻址写入（幂等／冲突）、资料头三态发布 | 不定发布顺序（4.x 命令层保证先正文后头） |
| `src/application/baseline.ts` | 头字节哈希、逐条正文核对、冲突标记识别 | 不改磁盘、不返回部分基线 |
| `src/application/local-state.ts`（refresh） | 以磁盘基线更新观察与源代际，计算 changes | 不复用旧缓存；身份变化拒绝刷新；不自动合并外部改动 |

三条约束：

- **unknown 不是失败**：`unknown`／`unknown-state` 表示无法确认，不得当“未提交”重试，也不得标成“已提交”。
- **顺序由命令层负责**：3.4 提供单步可观察结果，正文 → 头 → 本机回执的整体顺序与恢复在 4.x。
- **范围校验在每次读写**：读资料头、读正文、写头、写正文都经 `path-scope`，不缓存“已检查”结论。

## 4.1 落地的边界（命令封套与访问校验）

| 文件 | 责任 | 不做什么 |
|---|---|---|
| `src/domain/commands.ts` | `update-node`／`set-node-status`／记录索引追加的不可变变换；`applyPlanCommand` 重算指纹并跑完整校验 | 不生成 id、不读写文件、不做授权 |
| `src/application/command-queue.ts` | 每实例串行队列（失败不阻塞后续） | 不自动重试、不合并命令 |
| `src/application/command-service.ts` | 可信上下文判据、封套形态校验、提交前重读、双修订推进、三态结局；4.2 幂等重放与回执查询；4.3 四阶段与未决阻塞；4.4 候选核对与恢复；4.5 隔离触发与只读诊断 | 隔离只有显式解除，不做一键忽略或自动清理 |

四条约束：

- **两种入口、两套判据**：`remote-owner` 与 `agent-work` 分别校验，缺上下文不降级；业务参数不能伪造身份或归属。
- **提交前必重读**：不信任内存或命令自报的规划内容；磁盘 `planVersion` 与封套不一致即 `plan-conflict`。
- **先正文后头**：记录命令先写不可变正文，失败则不发布头；头结果 `unknown` 返回 `pending-reconciliation`，不改修订。
- **修订语义**：规划命令 `plan+1 / state+1`；记录命令仅 `state+1`，`planVersion` 不变。
- **幂等在冲突判断之前**：先查 `(instanceId, operationId)`，同摘要同归属返回历史结果；不同摘要或归属拒绝；未决保持待核对。
- **原样重发需要原基线**：记录保存 `expectedPlanVersion／expectedPlanRevision／sourceEpoch`，不接受“重读当前基线再当重试”。
- **阶段先落盘再写文件**：`prepared` 保存候选头全文与正文清单，`publishing` 之后才写正文与头；任一阶段未确认即停在原阶段，不自动续写。
- **未决阻塞**：同实例存在 `prepared`／`publishing` 记录时不接受新命令（`instance-blocked`），由显式 `recover` 解除。
- **恢复不重放业务命令**：只比对磁盘与候选；匹配才补回执，不匹配一律待核对。`prepared` 只标未发布，历史 `committed` 只返结果。
- **隔离标记独立于聚合**：写在 `quarantine/<instanceId>.json`，因此聚合损坏时仍能读到原因与保留的 operationId；解除必须显式确认。

## 5.1 落地的边界（快照与失效流）

| 文件 | 责任 | 不做什么 |
|---|---|---|
| `src/application/change-stream.ts` | 进程内水位、连接代际、订阅分发、代际替换关闭旧流 | 不读磁盘、不做授权、不携带内容；跨进程与重启后恢复不在范围 |
| `src/application/snapshot.ts` | 一致读取（两次聚合 + 完整基线）、追读已知修订、树／摘要同源派生、`read`／`follow` 编排 | 不写资料、不写聚合、不写隔离标记；不在追读失败时返回树 |

四条约束：

- **通知不是内容来源**：失效流只传修订号；内容必须回读快照，避免第二条内容来源与本地草稿冲突。
- **不输出半新半旧快照**：两次聚合读取之间修订／源代际变化即重读；重试耗尽返回 `unsynced` 且无树。
- **同步状态必须显式**：`source-drift` 时给磁盘一致内容但标 `not-synced + requiresRefresh`；本机无观察基线时标 `basis: current-read`，不冒充已验收基线。
- **代际与修订分开**：`sourceEpoch` 是替换边界（不比较大小）；`stateRevision` 同代际内单调；旧代际请求 `stale-connection`。

## 5.2 落地的边界（宿主 Remote 与实例打开）

| 文件 | 责任 | 不做什么 |
|---|---|---|
| `src/host/bootstrap.ts` | 配置形态校验（只接受绝对路径）、校验资料后登记／复用实例、仅在磁盘变化时刷新基线 | 不猜目录、不扫描磁盘找项目、不改资料头；失败不建立半可用实例 |
| `src/host/project-service.ts` | `conaProject` Remote 准入（owner invocation）、参数补齐、转交应用服务 | 不做一致性读取或命令逻辑；缺 invocation 不降级；`follow` 未暴露 |

四条约束：

- **配置即选择**：资料根来自 profile 配置的绝对路径，面板不做位置选择与迁移。
- **启动期不无条件刷新**：刷新会推进源代际，而代际是订阅侧替换边界；只在缺失或与磁盘不一致时刷新。
- **失败不阻塞宿主**：配置错误、资料不合法只体现在 `status.error`，插件其余部分照常加载。
- **Remote 边界只放稳定结构**：`ProjectSnapshot.local` 用计数而非 `unknown[]`；边界类型必须从 `./types` 子路径导出（生成器约束）。

## 5.2 面板落地的边界

| 文件 | 责任 | 不做什么 |
|---|---|---|
| `src/client/panel-controller.ts` | 草稿基线、保存三步（规划 → 原因记录 → 回读）、冲突／未知保留、`isDirty／isSaved` | 不渲染、不直接发请求、不自动合并冲突 |
| `src/client/http-transport.ts` | `/api/conaProject/*` 编解码、`TransportError` 归一 | 不缓存快照、不做业务判断 |
| `src/client/ProjectPanel.tsx` | 小树／详情／目标编辑／原因／位置／保存状态栏 | 不做保存规则；order 由控制器计算 |

三条约束：

- **渲染与规则分离**：草稿与保存规则可脱离浏览器测试；React 组件只读状态、调方法。
- **保草稿优先于好看**：冲突、待核对、传输异常都不清草稿、不标已保存；未知结果复用原 operationId。
- **传输可替换**：面板只依赖 `PanelTransport`；当前 HTTP 载体与后续 Remote 代理互不影响面板逻辑。
- **代际先于内容**：先判连接代际，再判源代际，最后判修订；旧代际答复即使修订更高也不采纳。
- **换代不比较修订**：`sourceEpoch` 只作替换边界；否则刷新后修订更小会被误判为旧数据。
- **轮询不等于订阅**：当前用 5 秒轮询检测失效，不宣称已实现推送；`follow` 接入前不勾选依赖“重新订阅”的验证项。
