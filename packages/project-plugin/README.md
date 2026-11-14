# dsh-cona-project

DSH-Cona 项目管理插件（R1）。当前已交付第 1 段（v1 公开资料格式、领域校验与无宿主校验命令）、第 3 段全部（位置与接入、本机根与注册表、路径范围、三态发布、基线与刷新）与 4.1（命令封套、访问校验、不可变变换、每实例队列）。

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

# 记录命令：正文哈希与路径由应用层计算
node lib/cli/command.js run --local-root <目录> --instance <id> \
  --command '{"type":"append-record","kind":"analysis-note","subjectNodeIds":["<节点>"],"summary":"结论","sources":[],"body":"# 正文\n"}'
```

可选参数：`--expected-plan-version`／`--expected-plan-revision`（覆盖默认的当前基线，用于复现冲突）、`--epoch`、`--trusted remote-owner|agent-work`、`--work-run`、`--binding-version`。

要点：

- **封套**：`operationId`、`projectId`、`instanceId`、`sourceEpoch`、`expectedPlanVersion`、`expectedPlanRevision`、`command`。缺字段或形态非法一律 `operation-mismatch`。
- **访问校验**：UI Remote 与 Agent 工具是两条判据；缺可信上下文直接 `forbidden`，不降级为进程内 owner。工具要求真实 `workRunId`、正数绑定版本且实例一致。
- **同一提交序列**：两种入口都经 `ProjectCommandService`，先核对实例 → 源代际 → 双修订 → 重读权威资料 → 变换 → 先正文后头 → 本机聚合。入口不同不改变任何校验。
- **双修订**：规划命令推进 `planRevision + stateRevision`；记录命令只推进 `stateRevision`，`planVersion` 不变，因此记录之后仍可用原规划基线提交规划修改。
- **不可变变换**：命令只描述结构，新节点 id 由应用层生成；变换不修改输入，失败整体拒绝。
- **队列**：同一实例串行、不同实例并行；并发命令中只有基线成立的那条成功，其余 `plan-conflict`，不会交错写坏资料。
- **结局**：`committed` 表示资料与本机聚合都明确成功；`rejected` 带稳定码与当前基线；`pending-reconciliation` 表示发布结果未知，必须保留原 operationId 核对，不换 id 重试。
- **本阶段未做**：幂等回执与 `(instanceId, operationId)` 查询、`prepared／publishing／committed` 持久阶段、崩溃恢复与 unknown-state 隔离（4.2–4.5）。

## 实现状态

第 1 段（1.1–1.5）、第 3 段（3.1–3.5）与 4.1 完成；4.2 起未开始，见 change `openspec/changes/establish-r1-project-plugin/tasks.md`。
