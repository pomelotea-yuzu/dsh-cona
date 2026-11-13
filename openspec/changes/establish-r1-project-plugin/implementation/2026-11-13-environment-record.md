# R1 环境与依赖前置检查记录（tasks 2.1）

日期：2026-11-13。本文件记录任务 2.1 要求的冻结安装前实测事实；全部为本机（macOS，darwin）实测，不是推断。

## 运行时

| 项 | 实测值 | 判定 |
|---|---|---|
| 系统 Node 二进制绝对路径 | `/usr/local/bin/node` | 满足 |
| 系统 Node 版本（补丁版本含在内） | `v26.13.0` | 满足 `engines.node >= 24.9.0` |
| WorkBuddy 沙箱自带 Node | `v22.22.2`（`~/.workbuddy/binaries/node/...`） | 低于声明线；仅用于沙箱内开发期测试运行，不计为插件兼容证据 |
| **宿主自带 Node** | `…/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node`（runtime.json 记录 `24.21.0`） | 宿主实际使用的二进制；2.3 记录以它为准 |
| 包管理器 | `pnpm 12.18.0`（插件仓 packageManager 字段）；宿主 runtime.json 记录 `pnpm 11.28.5` | 待实测 engines 处理（profile 安装时） |
| **dsh CLI** | `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`，`--version` 实测输出 `0.2.2-rc.2` | 可用；组合包登记路径成立 |
| 宿主 DSH 应用 | Info.plist `CFBundleShortVersionString = 0.2.2-rc.2` | 与设计固定版本一致 |
| DSH 源码副本 | `~/Developer/tools/deepseek-harness`，package.json version `0.2.2-rc.2` | 副本非 git 检出，按内容核对；`pnpm install`（仅依赖，不构建）供 typert 生成器与类型解析 |
| DSH home | `~/.dsh/`（profiles/desktop 为个人 profile，**不改动**） | 测试用独立 profile 由 CLI 创建 |

## npm 依赖可用性

| 包 | npm 现状 | 判定 |
|---|---|---|
| `@deepseek-ai/dsh` | 最高 `0.2.2-rc.1` | **fail**：rc.2 未发布；不改浮动版本，不降级 |
| `@deepseek-ai/dsh-base` | `0.0.1-rc.1` | 同上口径 |
| `@deepseek-ai/cordis` | `4.1.0` | 与宿主 rc.2 清单一致，可用 |
| 其余 `@deepseek-ai/dsh-*` | npm 缺 rc.2 | **fail**：见下"处理方式" |

处理方式（design §1：显式选择并实测，不放宽边界）：`engines.dsh: "0.2.2-rc.2"` 与 `peerDependencies` 精确范围不变。类型与开发副本取自已安装应用的 `app.asar`（rc.2 分发含各包 `lib/*.js` 运行产物与 `src/*.ts` 源码，**不含 .d.ts**），解包至本仓 `artifacts/dsh-pkgs/@deepseek-ai/`（门禁排除目录，不入库）；类型解析经 tsconfig paths 指向这些 src。`dsh-typert-generator` 桌面分发未携带，从源码副本运行（仅依赖安装，不构建宿主）。真实宿主验证使用已安装 rc.2 应用与其自带 CLI。

## 宿主兼容判据（源码核对）

`packages/boot/app-boot/src/plugin-compatibility.ts:52`：`semver.satisfies(runtimeVersion, range, { includePrerelease: true })`；`engines.dsh` 存在时单独决定，peer 仅在无 engines.dsh 时检查。精确 `"0.2.2-rc.2"` 范围在 includePrerelease 下匹配运行时 `0.2.2-rc.2`——**静态核对通过；profile 安装与启动实测待 2.3**。

## 插件 manifest（tasks 2.2 静态部分）

- `engines.dsh = "0.2.2-rc.2"`、`engines.node = ">=24.9.0"`；
- `main = dist/src/host/index.js`（Host ESM）；`exports["./client"] = ./dist/client/client.browser.js`；
- `dsh.bundle.patch = ./cordis.patch.yml`（插件行 `- insert: - id: cona-project, name: dsh-cona-project`）；
- `dsh.client.platform = "web"`，`dsh.client.inject = []`（诊断 Client 无宿主 UI 服务依赖）；
- Client factory 产物：esbuild cjs bundle + `window.__ModuleLoader__.load({ id, factory: (require) => {...} })` 包装，external `@deepseek-ai/*` 经注入 require 解析（格式对照 `packages/client/tsdown.client.ts` banner/footer，未导入上游构建框架）；
- 共享宿主包 peer/dev 双声明：peer 已声明，dev 副本待本地构建产物就位后安装（`check:manifest` 当前按预期失败于双声明项）。

## Typert 生成（2.2 剩余）

Host 诊断 Service（`@Remote('probe')`）已落源码；wire 端点产物需经 `@deepseek-ai/dsh-typert-generator` 的 `WorkspaceAnalyzer`（宿主聚合 tsconfig 结构：root + `tsconfig.host.json`/`tsconfig.client.json`）。插件仓聚合配置与生成脚本待宿主源码构建完成后接入，接入结果回写本文件。

## 待实测（保持 untested）

- 包管理器对 `engines.dsh` 的安装判定（profile 内 pnpm）与宿主启动判定分别实测（2.3）。
- 真实 Remote invocation / principalOf / ToolRunContext 映射（2.4）。
- 独立 home/profile 安装 tarball 与导航观察（2.3）。
