# dsh-cona-project

DSH-Cona 项目管理插件（R1）。当前已交付第 1 段：v1 公开资料格式、领域校验与无宿主校验命令。

- 边界与决定：[BOUNDARIES.md](BOUNDARIES.md)
- 公开协议：[formats/v1/plan-canonicalization.md](formats/v1/plan-canonicalization.md)（随包分发，资料根携带副本）
- 强制一致性向量：[formats/v1/plan-vectors.json](formats/v1/plan-vectors.json)
- 合法样例：[formats/v1/sample-project.json](formats/v1/sample-project.json)

## 命令

```bash
pnpm build              # 编译 dist/
pnpm typecheck          # 全量 + domain 隔离（types: []）类型检查
pnpm check:boundaries   # domain 无 Node/React/Cordis 导入检查
pnpm check:protocol-sync # 包内协议工件与 change 工件逐字节一致
pnpm test               # 编译 + 全部测试（向量复算 43 项、领域规则 22 项、CLI 端到端 14 项）

node lib/cli/validate.js check <root>                        # 校验资料根
node lib/cli/validate.js check-file <project.json>           # 校验单文件
node lib/cli/validate.js compute-plan-version <file> [--print-canonical]
node lib/cli/validate.js init <dir>                          # 建立资料根骨架
```

独立校验命令在无 DSH 服务的纯 Node 进程运行，不加载宿主、浏览器或模型服务，不执行资料根内的脚本或远程引用；其他实现仅凭公开协议与一致性向量即可复算规划指纹。

## 实现状态

第 1 段（tasks 1.1–1.5）完成；构建接入、文件后端、命令恢复、面板同步、聊天绑定与整体核查（tasks 2–7）未开始，见 change `openspec/changes/establish-r1-project-plugin/tasks.md`。
