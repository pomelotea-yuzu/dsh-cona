# dsh-cona-project

DSH-Cona 项目管理插件（R1）。当前已交付第 1 段（v1 公开资料格式、领域校验与无宿主校验命令）、第 3 段全部（位置与接入、本机根与注册表、路径范围、三态发布、基线与刷新）、第 4 段全部（命令封套、幂等回执、持久阶段、候选恢复、unknown 隔离）与 5.1（完整快照与先订阅再回读）。

- 边界与决定：[BOUNDARIES.md](BOUNDARIES.md)
- 公开协议：[formats/v1/plan-canonicalization.md](formats/v1/plan-canonicalization.md)（随包分发，资料根携带副本）
- 强制一致性向量：[formats/v1/plan-vectors.json](formats/v1/plan-vectors.json)
- 合法样例：[formats/v1/sample-project.json](formats/v1/sample-project.json)

## 命令

```bash
pnpm build              # 编译 lib/
pnpm typecheck          # 全量 + domain 隔离（types: []）类型检查
pnpm check:boundaries   # domain 无 Node/React/Cordis 导入检查
pnpm check:protocol-sync # 包内协议工件与 change 工件逐字节一致
pnpm test               # 编译 + 全部测试（向量、领域、CLI、位置与接入）
```

### 校验资料（无宿主）

```bash
node lib/cli/validate.js check <root>                        # 校验资料根
node lib/cli/validate.js check-file <project.json>           # 校验单文件
node lib/cli/validate.js compute-plan-version <file> [--print-canonical]
node lib/cli/validate.js init <dir>                          # 建立资料根骨架
```

### 选择位置与接入（无宿主）

```bash
# 预览实际路径与现有内容（不创建目录）
node lib/cli/source.js preview --kind project-directory --code-root <代码根>
node lib/cli/source.js preview --kind dsh-data --dsh-home <宿主 home> --project-id <uuid>
node lib/cli/source.js preview --kind custom --custom-root <资料根>

# 创建（非空目标与已有 project.json 一律拒绝）
node lib/cli/source.js create --kind custom --custom-root <资料根> --title <标题> [--goal <目标>]
node lib/cli/source.js create --kind dsh-data --dsh-home <宿主 home> --title <标题>

# 接入既有资料（沿用原项目／节点 id，只读不改写）
node lib/cli/source.js attach <资料根> [--kind <kind>]
```

输出为一行 JSON，含 `location.root`／`location.displayPath`（home 折叠为 `~`）与 `git` 只读状态。失败退出码 1，用法错误 2。

## 资料位置与基础接入

三种位置保存同一格式，不是三套项目模型；位置由用户明确选择，插件不会因发现仓库元信息就切换。

| 位置 | R1 默认布局 | 说明 |
|---|---|---|
| 项目目录 | `<代码根>/.dsh-cona-project/` | 资料随工作副本保存，可交 Git 管理；也可另选明确目录 |
| DSH 数据目录 | `<宿主 home>/data/dsh-cona/projects/<projectId>/` | 适合无代码目录的早期规划或个人使用 |
| 自定义目录 | 用户明确选择的资料根 | 选定目录本身即协议入口，不再追加子目录 |

要点：

- **创建**只允许空目录或不存在目录；已有 `project.json` 或任何文件都拒绝覆盖并列出内容。创建会放置 `README.md`、`project.json`、`schema/`、`protocol/` 与 `records/`，并生成一个承载项目目标的根节点（v1 要求至少一个根节点）。
- **接入**只读：校验格式与领域规则后沿用原项目／节点 id，不要求原数据库，不导入旧机器授权或回执，也不在资料根写入任何本机状态。本机实例登记在 `local register`（3.2），回执在 3.4；`attach` 返回的 `registry: "pending-3.2"` 表示尚未持久化。
- **Git 状态**只读观察：`tracked / untracked / ignored / unknown` 与工作区脏状态；不执行 add／commit／checkout，也不改 Git 配置。根不存在或不是目录时不给伪状态（`git: null`）。
- **路径**必须是绝对路径，拒绝 `..` 段与 NUL；相对路径不会被当前进程目录悄悄补全。显示路径只折叠 home 前缀，不做大小写或符号链接归一（范围与越界检查在 3.3）。
- 本命令不写回执、不登记实例、不提交 Git；位置迁移、协作与跨机试用不属于 3.1，见 change 的 3.2／R2／R6。

## 本机运行数据

公开资料可进 Git，本机运行数据不进：注册表、实例聚合、锁、后续的聊天绑定与回执都在本机根，不写入 `project.json`。

| 数据 | 位置 | 内容 |
|---|---|---|
| 本机根 | 默认 `<宿主 home>/data/dsh-cona/local/`；可用 `localDataRoot` 改成明确的绝对目录 | `registry.json`、`instances/<instanceId>/state.json`、`lock.json` |
| 注册表 | `<本机根>/registry.json` | `instanceId`、`projectId`、资料根绝对路径、位置种类、源代际、时间 |
| 实例聚合 | `<本机根>/instances/<instanceId>/state.json` | 双修订（plan／state）、聊天关系、WorkRun、意图／回执、最近观察 |

```bash
# 解析并检查本机根（不写注册表）
node lib/cli/local.js root (--dsh-home <宿主 home> | --local-root <目录>) [--source <资料根>]

# 登记或复用实例；同资料根复用、同项目不同目录是不同实例
node lib/cli/local.js register --local-root <目录> --source <资料根> --project-id <uuid> --kind <kind>
node lib/cli/local.js list --local-root <目录>
node lib/cli/local.js show --local-root <目录> --instance <instanceId>

# 显式刷新：重读磁盘完整基线（头字节哈希 + 每条正文哈希），推进源代际
node lib/cli/local.js refresh --local-root <目录> --instance <instanceId> --source <资料根>

# 隔离诊断与解除（unknown-state 后停止该实例读写）
node lib/cli/local.js diagnostics --local-root <目录> --instance <id>
node lib/cli/local.js quarantined --local-root <目录>
node lib/cli/local.js unisolate --local-root <目录> --instance <id> --confirm offline-reviewed

# 恢复核对：prepared 标记未发布；publishing 精确匹配候选则补回执
node lib/cli/command.js recover --local-root <目录> --instance <id> --operation <uuid>

# 遗留锁必须显式释放（不按超时抢占）
node lib/cli/local.js release-lock --local-root <目录> (--force | --token <token>)
```

边界：

- **根隔离**：本机根与公开资料根不得相同或互相包含（任一方向都拒绝），避免私有记录落进可能被提交的目录。
- **私有根在 Git 内**：本机根位于工作副本时，必须无已跟踪文件且被 `ignore` 覆盖，否则拒绝（`local-root-tracked`／`local-root-not-ignored`），不自动改 `.gitignore`。git 不可用时结果标 `checked: false`，不显示为“已核查安全”。
- **单写者**：同一进程内同一根只允许一个写者（`local-writer-duplicate`）；跨进程用 `lock.json` 独占创建（`local-lock-held`）。锁不按超时或 pid 自动抢占，异常遗留需人工确认后 `release-lock`。
- **身份**：同一资料根已登记为另一个 `projectId` 时拒绝静默复用（`registry-project-identity-changed`）；注册表损坏或版本不受支持时只读拒绝，不覆盖原文件。
- **范围外**：不同 `localDataRoot` 管同一公开根、多人同时写同一目录、跨机同步均不在 R1 支持范围；真实宿主 profile 与面板展示待第 5／6 段。

## 路径范围与发布语义

- **相对引用**：统一 `/` 分段；拒绝绝对路径、盘符、反斜杠、NUL、空段、`.`／`..` 与百分号编码绕过。
- **范围解析**：逐段拒绝符号链接，中间段必须是目录，目标须是常规文件；写目标若有多硬链接拒绝（`scope-hardlink`）；realpath 复核最终位置仍在根内。
- **正文**：内容寻址 `records/<recordId>/<contentHash-hex>.md`，已存在必须字节一致（`already-present`），不一致报 `conflict` 且不覆盖。
- **三态发布**：`published`（回读一致）／`not-published`（可证明未替换）／`unknown`（rename 后无法确认、回读不一致）。`unknown` 不等于失败，也不代表已提交；不要据此换 id 重试。
- **本机聚合三态**：`saved`／`not-saved`／`unknown-state`，同样不把 unknown 当失败重试。
- **孤立正文**：正文写入但资料头未引用时，校验报 `orphan-body`，查询不当作已发布记录。
- **断电限制**：以上只有“同目录临时文件 + rename + 回读”，没有目录 fsync，也不跨目录／跨介质成事务；进程被强杀或突然断电时的持久性未证明，不宣称断电安全。

## 公开格式版本（4.1）

- **v1**：`schemaVersion: 1`，`plan` 只含 `nodes` 与 `dependencies`；既有 schema、canonical 字节与向量保持不变。
- **v2**：`schemaVersion: 2`，`plan` 增加 `roadmap`（里程碑与交付引用，可为空集合）。从 v1 启用 v2 会改变
  `schemaVersion` 与投影，因此必然产生新指纹；原 v1 指纹只作为历史。
- **随包工件**：`formats/v2/` 提供 `project-v2.schema.json`、`plan-canonicalization-v2.md`（跨语言规范化说明）、
  `plan-vectors-v2.json`（主实现与独立第二实现都必须复算）与 `roadmap-protocol.md`（可读语义与正反例）。
  它们随插件包分发，并在新建资料根时与 v1 工件一起落盘到 `schema/`、`protocol/`。
- **分派与诊断**：读取先看 `schemaVersion`（1／2，其他拒绝）；v1 出现 `plan.roadmap` 按未知字段拒绝，
  v2 缺 `roadmap` 按缺失字段拒绝。里程碑节点缺失、重复里程碑、重复交付、交付记录缺失或哈希不符、
  伪造指纹都有稳定诊断码（`milestone-node-missing`／`duplicate-milestone`／`duplicate-milestone-delivery`／
  `milestone-delivery-record-missing`／`milestone-delivery-hash-mismatch`／`plan-version-mismatch`）。
- **普通编辑保留扩展**：结构命令与撤销重做原样保留未被编辑的 `roadmap`；里程碑的专门编辑与完成流程见 4.3。
- **显式启用（4.2）**：v1 资料不会被普通编辑升级。启用由 owner 先预览兼容影响（目标版本、节点／记录数量、
  哪些验证记录会按原受检版本转成历史），确认时带预览返回的 `previewDigest` 提交
  `{"type":"enable-roadmap","previewDigest":"sha256:…"}`；发布只创建空里程碑集合，项目、节点、依赖、
  记录身份与验证受检版本不变。预览后资料字节变化返回 `preview-mismatch`，已启用返回 `roadmap-already-enabled`；
  同 `operationId` 重发只回放原回执。启用后无法退回 v1（需要回退按 Git 历史处理）。
- **旧读者行为**：仍按 v1 的读方（含 `formats/v1/project-v1.schema.json`）看到 `schemaVersion: 2` 时应报未知格式
  并**保持文件不动**，不得回写覆盖；升级前请确认所有写方都已支持 v2。
- **独立核对**：`node lib/cli/validate.js check-file <project.json>` 与 `check <资料根>` 对 v1／v2 都可用，
  不依赖 DSH 或本机状态。

## 外部编辑与刷新

外部（Git checkout、其他 Agent、手工编辑）改动资料后按固定顺序处理，不自动合并、不自动重放：

1. **暂停**：停止对该资料源的插件写入（未提交草稿留在 Client，不写入资料头）。
2. **校验**：`node lib/cli/validate.js check <资料根>`；冲突标记、未知 schema、非法树、正文哈希不符都以稳定码拒绝。
3. **刷新**：`node lib/cli/local.js refresh --local-root <目录> --instance <id> --source <资料根>`，以磁盘重读为准更新本机基线，返回 `changes`（头／规划指纹变化、记录新增／删除／改写）。
4. **重新开始**：刷新成功后才继续写入；同路径项目身份变化（`source-identity-changed`）拒绝刷新，需人工核对后另建实例。

刷新始终重读磁盘，不复用旧缓存；失败不推进源代际，也不改动既有基线。

## 命令封套（4.1）

```bash
# 规划命令：add-nodes / update-node / split-node / set-dependencies / set-node-status
node lib/cli/command.js run --local-root <目录> --instance <id> \
  --command '{"type":"add-nodes","nodes":[{"parentId":"<父节点>","order":1,"title":"新节点","goal":"目标","completionCriteria":[]}]}'

# 结构命令（Agent 需对应动作授权）：move-node / insert-preset / insert-user-template
node lib/cli/command.js run --local-root <目录> --instance <id> \
  --command '{"type":"move-node","nodeId":"<节点>","parentId":"<父节点或 null>","beforeNodeId":null}'

# 记录命令：正文哈希与路径由应用层计算
node lib/cli/command.js run --local-root <目录> --instance <id> \
  --command '{"type":"append-record","kind":"analysis-note","subjectNodeIds":["<节点>"],"summary":"结论","sources":[],"body":"# 正文\n"}'

# 启用扩展规划（4.2）：previewDigest 只能由 roadmapPreview 预览得到，CLI 不提供预览，
# 因此该命令只经 owner Remote 发起（conaOverview/roadmapPreview → conaOverview/execute）。
```

可选参数：`--expected-plan-version`／`--expected-plan-revision`（覆盖默认基线，用于复现冲突）、`--epoch`、`--trusted remote-owner|agent-work`、`--work-run`、`--binding-version`、`--operation <uuid>`（固定操作 id，用于重试）。

要点：

- **封套**：`operationId`、`projectId`、`instanceId`、`sourceEpoch`、`expectedPlanVersion`、`expectedPlanRevision`、`command`。缺字段或形态非法一律 `operation-mismatch`。
- **访问校验**：UI Remote 与 Agent 工具是两条判据；缺可信上下文直接 `forbidden`，不降级为进程内 owner。工具要求真实 `workRunId`、正数绑定版本且实例一致。
- **结构命令授权（3.3）**：`move-node`／`insert-preset`／`insert-user-template` 不再静态 owner-only，可由配置实例内的可信 WorkRun 发起，但必须逐项通过：
  - 动作：运行须显式含 `move` 或 `insert`；缺动作 `forbidden`。
  - 位置：按当前计划轮廓核对源父组、移动子树、目的父组、锚点与因归一化而变序的同级节点；任一不在目标集合内 → `structure-scope-denied`。根组内重排另需 `rootGroupAllowed`，否则 `root-group-not-allowed`；非根节点升为根仍由领域拒绝（`child-to-root`）。
  - 插入：必须以现有节点为父；`parentId: null` 一律 `parent-not-found`（即使已授予 insert、根组许可与精确模板版本），且不分配候选、不生成节点。
  - 模板：运行冻结精确授权——内置按 `templateId + templateVersion`，用户模板再带 `versionRecordId + contentHash`；不符 → `template-not-authorized`。旧运行缺 `templates` 字段按空授权读取。
  - 绑定与基线：提交时核对捕获版本与已接受基线；owner 在运行中改了规划，旧运行仍可读，但拿新基线写会被 `binding-expired` 拒绝，需结束旧运行后显式发起新运行。生成节点不加入目标集合。
- **同一提交序列**：两种入口都经 `ProjectCommandService`，先核对实例 → 源代际 → 双修订 → 重读权威资料 → 变换 → 先正文后头 → 本机聚合。入口不同不改变任何校验。
- **双修订**：规划命令推进 `planRevision + stateRevision`；记录命令只推进 `stateRevision`，`planVersion` 不变，因此记录之后仍可用原规划基线提交规划修改。
- **不可变变换**：命令只描述结构，新节点 id 由应用层生成；变换不修改输入，失败整体拒绝。
- **队列**：同一实例串行、不同实例并行；并发命令中只有基线成立的那条成功，其余 `plan-conflict`，不会交错写坏资料。
- **结局**：`committed` 表示资料与本机聚合都明确成功；`rejected` 带稳定码与当前基线；`pending-reconciliation` 表示发布结果未知，必须保留原 operationId 核对，不换 id 重试。
- **幂等（4.2）**：执行前先写 `pending` 意图（含请求摘要、归属、原始输入基线与稳定生成 id），完成后写回执。同 `operationId` 且同摘要、同归属 → 返回历史结果（`replayed: true`），不再写资料、不再推进修订；摘要或归属不同 → `operation-mismatch`／`forbidden`；已有未决意图 → `pending-reconciliation`，不按新命令重跑。
- **原样重发**：摘要包含输入基线，因此重试必须用原请求的 `expectedPlanVersion／expectedPlanRevision／sourceEpoch`。记录里保存了这三项，`--operation` 重试时 CLI 会自动取回；否则重读当前基线会被判 `operation-mismatch`（这是正确行为，不是缺陷）。
- **无业务变化**：规划命令未改变 `planVersion` 时只保存回执并推进 `stateRevision`，不重写资料头；重试不再推进修订。
- **回执查询**：按归属隔离——`agent-work` 只能读同一 `workRunId` 的回执，owner 也不能读工具回执。
- **持久阶段（4.3）**：`prepared`（候选头全文、候选哈希、正文清单、预算结果先落盘）→ `publishing`（明确可能已开始写文件）→ `committed`／`rejected`。正文在 `publishing` 之后写入，先正文后头；回执与双修订在同一次聚合替换中完成。
- **未决即阻塞**：同一实例存在 `prepared`／`publishing` 记录时，新命令返回 `pending-reconciliation(instance-blocked)`，不继续写入；同 `operationId` 重试也只返回待核对。
- **失败结局**：意图或 publishing 落盘失败 → `persistence-failed` 且不写任何文件；正文失败或头 `not-published` → 标 `rejected`（明确未发布）；头 `unknown` → 停在 `publishing`；回执未落盘 → `pending-reconciliation(stage=receipt)`。
- **通知失败不撤回**：提交后的通知异常被吞掉，结果仍是 `committed`，回执可查。
- **恢复（4.4）**：`command recover` 显式核对，不自动重放。
  - `prepared`：可证明未进入发布 → 标记 `not-published`，保留 operationId，需重做时用新命令。
  - `publishing` 且当前资料**精确匹配候选**（头字节哈希 + 每条正文哈希）→ 补回执，双修订按意图预算一次性补齐（`recovery: candidate-matched`），重复恢复只返历史。
  - `publishing` 但当前等于原基线 → `reverted` 待核对（不排除发布后被回退，不宣称未提交）。
  - `publishing` 但已分叉 → `diverged` 待核对，不自动覆盖。
  - `committed` 之后资料被回退（Git 回退）→ 重试／查询／恢复都只返回历史，不重新应用到当前分支。
- **隔离与诊断（4.5）**：本机聚合写入结果未知（`unknown-state`）或不可读时，写独立标记 `quarantine/<instanceId>.json`，该实例的**命令、回执读取、恢复全部停止**；标记与聚合分开保存，聚合损坏时仍可读原因与保留的 operationId。
  - `local diagnostics`：只读报告——隔离状态、未决操作、当前磁盘基线与候选比对、诊断建议；不写任何文件。
  - `local unisolate --confirm offline-reviewed`：必须显式确认已人工核对，插件不提供“一键忽略”。
  - 解除后先用 `command recover` 核对未决操作，再按当前修订发新命令；直接沿用旧基线会被 `plan-conflict` 拒绝。

## 快照与订阅（5.1）

```bash
# 完整快照：一次读取内的一致内容（小树、依赖、记录索引、摘要）+ 本机修订 + 同步状态
node lib/cli/snapshot.js read --local-root <目录> --instance <id> [--generation <n>] [--min-state-revision <n>]

# 订阅失效流：只打印 ready（代际、源代际、已知最高修订）
node lib/cli/snapshot.js follow --local-root <目录> --instance <id>
```

Remote 契约（Cona 自有，namespace `conaProject`）：

| 方法 | 请求 | 结果 |
|---|---|---|
| `conaProject.snapshot` | `{instanceId, connectionGeneration, minStateRevision?}` | `{status:'snapshot',snapshot}`／`{status:'unsynced',reason,attempts,detail}`／`{status:'rejected',code,…}` |
| `conaProject.follow` | `{instanceId, afterStateRevision?}` | 失效流：首个事件 `ready`，其后 `committed／refreshed／source-replaced`；`source-replaced` 后流结束 |

要点：

- **先订阅再回读**：`follow` 拿到 `ready`（含 `connectionGeneration／sourceEpoch／stateRevision`）后，才用 `minStateRevision = ready.stateRevision` 调 `snapshot`。通知只是失效信号，内容一律回读。
- **一致读取**：先读本机聚合 → 读头与全部引用正文并复核哈希 → 再读聚合；两次之间修订／源代际变化就重读。追不上已知修订或存在未决发布时返回 `unsynced`，**不返回半新半旧的树**。
- **同步状态**：`synced`（`basis: local-observation｜current-read`）；磁盘头与本机观察不一致时 `not-synced(source-drift)` + `requiresRefresh: true`，面板不得显示“已保存”。
- **拒绝码**：`forbidden／stale-connection／unknown-state／binding-expired／unsupported-format／invalid-project／body-hash-mismatch／body-missing／source-conflict-markers`。混合资料（头与正文不同版）不返回半截快照。
- **代际与修订**：`sourceEpoch` 变化是替换边界，不比较大小；`stateRevision` 只在同代际内单调。旧代际快照请求直接 `stale-connection`。
- **失效流只在进程内**：Host 重启后水位丢失，靠“重连即完整回读”弥补；跨进程通道不在 R1 范围。

## 宿主 Remote 与实例配置（5.2）

profile 的 `cordis.patch.yml` 里给出两条绝对路径（用户显式选择，插件不猜目录）：

```yaml
- id: cona-project
  config:
    projectRoot: /abs/path/to/project-root     # 公开资料根
    localDataRoot: /abs/path/to/local-root     # 本机运行数据根（可省，默认 <DSH_HOME>/data/dsh-cona/local）
```

宿主启动即校验资料并登记／复用实例；只有磁盘与本机观察不一致时才刷新基线（避免每次启动推进源代际）。未配置时宿主照常启动，`status` 返回 `configured:false` 与原因。

`conaProject` Remote（owner invocation 专属）：

| 方法 | 请求（HTTP `payload.args` 按参数名） | 结果 |
|---|---|---|
| `status` | `{}` | `configured／instanceId／projectId／sourceKind／sourceDisplay／localRootDisplay／created／error` |
| `snapshot` | `{request:{connectionGeneration, minStateRevision?}}` | `SnapshotResult`（含 `source` 位置展示） |
| `execute` | `{request:{operationId, command, expectedPlanVersion, expectedPlanRevision, …}}` | `CommandResult` |

准入：`ctx.invocation` 存在、peer 主体 owner、`principalOf` 为空；其余 `forbidden`，不降级为进程内 owner。`follow` 尚未暴露。

## 面板（5.2）

- 侧栏「项目」入口（`sidebar.panellist`，order 40）打开主区域面板（`main` keyed slot，key `cona-project`）。
- 面板显示：项目标题与同步状态、规划／状态修订、资料位置与本机数据路径、完整小树（缩进 + order + status）、节点详情（含完成条件）、目标编辑、变更原因、保存状态栏。
- 保存经统一命令（`conaProject.execute`）：目标编辑 → `update-node`；新增子节点 → `add-nodes`（order 取同级最大值 +1）；变更原因在规划成功后追加 `plan-change` 记录。
- 草稿规则：保存冲突（`plan-conflict`／`source-changed`）、结果待核对、传输异常一律**保留草稿且不标已保存**；未知结果复用原 operationId 重试；原因记录失败标「部分保存」。
- 传输：当前走宿主 `/api` 载体（`payload.args = {request}`），接口是 `PanelTransport`，可替换为生成的 Remote 代理。
- 同步与重连：面板每 5 秒轮询一次快照（带 `minStateRevision` 追读），并按「连接代际 → 源代际 → 修订」三层守卫应用结果——旧代际答复丢弃、旧源整份丢弃、同代际内更旧修订不覆盖；`sourceEpoch` 变化只作替换边界，不比较大小。
- 断线：只标「连接断开」并保留树与草稿；点「重连」后连接代际 +1 并完整回读，未保存草稿不丢、基线过期会提示「保存可能被拒绝」。
- 宿主重启会让 DSH 外壳整体白屏（需整页重载），草稿不持久化——R1 边界。
- 文案：字典命名空间 `dsh-cona.project`（`src/client/locales/zh.json` 为 key 源，`en.json` 必须同集合）；包元信息在 `locale/*.json`。`node scripts/check-locale.mjs` 核对 key／占位符／空值与业务值，`--selftest` 提供 6 个反例。
- 语言：跟随宿主／浏览器语言（zh、en，其余回退英文）；自动选择不写 `locale.preference`，运行中切换与重启选择属 5.5。

## 实现状态

第 1 段（1.1–1.5）、第 3 段（3.1–3.5）、第 4 段（4.1–4.5）、5.1 与 5.2 完成；5.3 起未开始，见 change `openspec/changes/establish-r1-project-plugin/tasks.md`。
