# dsh-cona-project 包边界说明（tasks 1.1）

包名 `dsh-cona-project`（design §1，组合包、四层目录）。本文记录 R1 已落地的边界与验证方式；接口签名为草案，随第 3–6 段任务细化。

## 目录与依赖边界

| 目录 | 依赖及职责 | 边界验证 |
|---|---|---|
| `src/domain/` | JSON 数据结构、纯变换、树／依赖／完成条件校验、v1-plan 指纹；**无 Node、Cordis、React** | `tsconfig.domain.json`（`types: []`、纯 ES2022 lib）+ `scripts/check-boundaries.mjs` |
| `src/application/` | 命令、查询、可信调用上下文、提交及恢复；调用 ports 和领域核心 | 第 3–4 段实现 |
| `src/adapters/` | 文件、本机状态、DSH 会话和身份映射、Remote／工具入口 | 第 3–6 段实现 |
| `src/client/` | 面板、编辑草稿、同步状态机、字典；不写文件或复制业务规则 | 第 5 段实现 |
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
- 文件发布、本机聚合替换与恢复状态机（第 3–4 段）。
- 面板同步、i18n、聊天绑定与真实 Agent 演示（第 5–6 段）。
