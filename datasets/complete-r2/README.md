# datasets/complete-r2 · R2 收尾协作项目夹具

R2 收尾 change（`complete-r2-project-workflow`）任务 0.2 的可重复夹具。生成脚本幂等、可重置，
产物不入库（出 `artifacts/r2-final/`），本目录只保留脚本与说明。

## 重建

```sh
# 全量重建（覆盖已有产物）
node datasets/complete-r2/build-fixture.mjs --reset

# 自定义产物目录
node datasets/complete-r2/build-fixture.mjs --reset --out artifacts/r2-final

# 只生成、跳过登记自检
node datasets/complete-r2/build-fixture.mjs --reset --skip-selfcheck
```

每次运行覆盖目标目录后重建；manifest 记录本次起始 commit、哈希与自检结果。
脚本末尾自动完成三项自检，任一失败即退出码 1：

1. 旧校验器（`packages/project-plugin/lib/cli/validate.js check`）通过原夹具；
2. 越界负例（`negative/project-escape.json`）被 `invalid-relative-path` 拒绝；
3. 两个工作副本登记后 projectId 相同、instanceId 不同（同项目不同目录 = 不同实例）。

## 产物布局

| 路径 | 内容 |
|---|---|
| `repo/` | 原始仓库，分支 `main`（改动前 v1 基线）与 `feature/external`（外部改动材料） |
| `repo/project/` | v1 资料根：`project.json`、`records/`、`README.md`、`demo-app/` 工件 |
| `copy-a/`、`copy-b/` | 两个独立 Git 工作副本，同名仓库 `demo-app`、不同规范绝对路径 |
| `home-clean/` | 干净 DSH home（空），供 H 层 `DSH_HOME=` 使用 |
| `migrate/project|dsh|custom/` | 三个迁移目标（空目录） |
| `negative/` | 越界工件负例与仓库外目标文件 `outside-secret.md` |
| `selfcheck-local/` | 登记自检用的本机根（保留，可随重建覆盖） |
| `manifest.json` | 起始 commit、头文件与正文哈希、夹具内容索引、自检结果 |

## 夹具 v1 内容

- 两个根节点：`产品设计`、`工程实现`（多根树，供根组授权与跨分支里程碑实测）。
- 子树：`工程实现/实现主节点/实现子项`；内部依赖 `实现子项→实现主节点`；
  外部依赖 `实现主节点→交互稿`、`实现子项→组件清单`（跨根、跨子树）。
- 成果：节点 `组件清单`（`status: done`）+ `analysis-note` 成果记录。
- `kind=verification` 记录：受检 `组件清单`，`subjectVersion` 为受检时 `planVersion`，
  来源为仓库引用（外部观察）。
- 可查工件：记录 sources 指向 `demo-app/docs/checklist.md` 并带 `observedHash`，
  可在当前工作副本核对。
- 接续摘要：`[cona:resume]` 前缀的 `execution-note`，正文按 `formats/v1/resume-v1.md` 三段式。
- 越界工件：`negative/project-escape.json` 用 `../outside-secret.md` 引用仓库外文件，
  独立校验必须拒绝；合法 `project.json` 不含越界引用（保证旧校验器通过）。

## 与任务的对应

- 0.2：本目录 + `artifacts/r2-final/`（矩阵证据 C01、E02、J01、J06 的 F 层基础）。
- 1.1–1.3：`copy-a`、`copy-b` 与 `feature/external` 供接入、外部变更接纳与 Git 合并实测。
- 1.4–1.5：`migrate/` 三个目标供事务化迁移实测。
- 4.x／5.x：`home-clean/` 与 manifest 记录的哈希供 H 层与收尾核对。
