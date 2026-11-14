# dsh-cona-project

DSH-Cona 项目管理插件（R1）。当前已交付第 1 段（v1 公开资料格式、领域校验与无宿主校验命令）与第 3 段 3.1（三种资料位置与基础接入）。

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
- **接入**只读：校验格式与领域规则后沿用原项目／节点 id，不要求原数据库，不导入旧机器授权或回执，也不在资料根写入任何本机状态。本机实例登记与回执在 3.2／3.4 落地，当前返回 `registry: "pending-3.2"`。
- **Git 状态**只读观察：`tracked / untracked / ignored / unknown` 与工作区脏状态；不执行 add／commit／checkout，也不改 Git 配置。根不存在或不是目录时不给伪状态（`git: null`）。
- **路径**必须是绝对路径，拒绝 `..` 段与 NUL；相对路径不会被当前进程目录悄悄补全。显示路径只折叠 home 前缀，不做大小写或符号链接归一（范围与越界检查在 3.3）。
- 本命令不写回执、不登记实例、不提交 Git；位置迁移、协作与跨机试用不属于 3.1，见 change 的 3.2／R2／R6。

## 实现状态

第 1 段（tasks 1.1–1.5）与 3.1 完成；3.2–3.5、第 4–7 段未开始，见 change `openspec/changes/establish-r1-project-plugin/tasks.md`。
