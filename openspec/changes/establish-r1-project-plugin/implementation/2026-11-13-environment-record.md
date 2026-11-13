# R1 环境与依赖前置检查记录（tasks 2.1）

日期：2026-11-13。本文件记录任务 2.1 要求的冻结安装前实测事实；全部为本机（macOS，darwin）实测，不是推断。
**2026-11-13 傍晚更正**：npm 已发布 `0.2.2-rc.2`（含 `.d.ts` 与 `dsh-typert-generator`，实测 tarball 确认），早前「npm 无 rc.2」结论作废；类型与生成改走 npm 精确版本，app.asar 解包与源码副本 install 两条绕路拆除。dist-tags：`latest=rc.1`、`next=rc.3`；按用户决定锁 rc.2 对齐宿主，插件第一版完成后再适配最新版。

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
| DSH 源码副本 | `~/Developer/tools/deepseek-harness`，package.json version `0.2.2-rc.2` | 副本非 git 检出，按内容核对；rc.2 类型/生成包上 npm 后**不再需要**为它跑 install（仅留作源码查阅参考） |
| DSH home | `~/.dsh/`（profiles/desktop 为个人 profile，**不改动**） | 测试用独立 profile 由 CLI 创建 |

## npm 依赖可用性（2026-11-13 傍晚更新）

| 包 | npm 现状 | 判定 |
|---|---|---|
| `@deepseek-ai/dsh` 等全部 `@deepseek-ai/dsh-*` | **`0.2.2-rc.2` 已发布**（tarball 实测含 `.d.ts`；`dsh-typert-generator` 也在） | **可用**，精确版本安装；`next=rc.3` 不用 |
| `@deepseek-ai/cordis` | `4.1.0` | 与宿主 rc.2 清单一致，可用 |
| 早前「npm 无 rc.2」记录 | 当时属实，现已失效 | 结论文本保留于 git 历史 |

处理方式（2026-11-13 傍晚更新，design §1：显式选择并实测，不放宽边界）：`engines.dsh: "0.2.2-rc.2"` 与 `peerDependencies` 精确范围不变。**类型与生成直接取 npm `0.2.2-rc.2` 精确版本**（devDependencies 与 peer 双声明，满足 check:manifest 双声明项）：`@deepseek-ai/cordis@4.1.0`、`@deepseek-ai/dsh-tools@0.2.2-rc.2`、`@deepseek-ai/dsh-typert-protocol@0.2.2-rc.2`、`@deepseek-ai/dsh-typert-generator@0.2.2-rc.2`、`@deepseek-ai/dsh-llm@0.2.2-rc.2`、`zod@4.6.6`（生成产物运行时依赖）。真实宿主验证使用已安装 rc.2 应用与其自带 CLI。

**Typert 源面（source-plane）补充**：生成器要求 Remote/TypertRemoteService 符号解析到登记于 workspace `packages/` 下的协议包**源文件**（上游 monorepo 以 tsconfig paths 把 `@deepseek-ai/*` 映射到包 src）。插件仓复刻该约定：protocol 源码 vendor 于 `packages/vendor/dsh-typert-protocol`（0.2.2-rc.2，MIT，8 文件 1802 行），聚合 tsconfig paths 指向其 src 并登记 references；**运行时不受影响**（paths 不参与 emit，产物仍解析 node_modules 的 npm 副本）。同时确认的生成器契约：产物写入包 `lib/`（`lib/typert.host.{js,d.ts}` + 有 Remote 方法时 `lib/typert.remote-client.{js,d.ts,d.ts.map}`）；exports 必须为 `{ types, default }` 对象形式且 files 显式列出产物文件；`./client` 导出必须映射回真实 TS 源文件；Remote 边界类型禁 `undefined`（空值用字段缺省/null 表达）且必须从非根类型子路径（`./types`）导出；`dsh-tools` 类型链会传入 dsh-session 对 protocol 接口的 merge 与 vendored 源码冲突，工具定义改为不 import dsh-tools、由宿主 `tools.register()` 运行时校验兜底。

生成结果（2026-11-13 实测）：`scripts/generate-typert.mjs`（调 `WorkspaceTypertGenerator`，root=仓库根）产出 `lib/typert.host.{js,d.ts}` 与 `lib/typert.remote-client.{js,d.ts,d.ts.map}`（含 `conaDiagnostic/probe` wire schema）；build（tsc→lib 镜像 src 布局 + esbuild client factory）、typecheck（host/domain/test 三配置）、79 项测试、check:manifest、仓库门禁 `check-repo --all` 全过。

## 宿主兼容判据（源码核对）

`packages/boot/app-boot/src/plugin-compatibility.ts:52`：`semver.satisfies(runtimeVersion, range, { includePrerelease: true })`；`engines.dsh` 存在时单独决定，peer 仅在无 engines.dsh 时检查。精确 `"0.2.2-rc.2"` 范围在 includePrerelease 下匹配运行时 `0.2.2-rc.2`——**静态核对通过；profile 安装与启动实测待 2.3**。

## 插件 manifest（tasks 2.2 静态部分，2026-11-13 傍晚随 lib 布局重构更新）

- `engines.dsh = "0.2.2-rc.2"`、`engines.node = ">=24.9.0"`；
- 产物布局对齐上游：包 `lib/` 直接镜像 `src/`（`main = ./lib/host/index.js`，`exports["."] = ./lib/host/index.js`）；测试单独编译到 `lib-test/`（不入 files）；
- `exports["./client"] = ./lib/client/index.js`（esbuild bundle，映射回 `src/client/index.ts` 满足生成器源面检查）；
- `exports["./types"] = { types: ./lib/types.d.ts, default: ./lib/types.js }`（Remote 边界类型子路径，导出 `ConaProbeResult`／`ConaToolObservation`）；
- `exports["./typert"] = { types: ./lib/typert.host.d.ts, default: ./lib/typert.host.js }`、`exports["./remote"] = { types: ./lib/typert.remote-client.d.ts, default: ./lib/typert.remote-client.js }`（生成器 validateExport 契约）；
- `files`：`lib` + 显式列出 `lib/typert.host.js`、`lib/typert.host.d.ts`、三个 remote-client 文件 + `formats` + `cordis.patch.yml`；
- `dsh.bundle.patch = ./cordis.patch.yml`（插件行 `- insert: - id: cona-project, name: dsh-cona-project`）；
- `dsh.client.platform = "web"`，`dsh.client.inject = []`（诊断 Client 无宿主 UI 服务依赖）；
- Client factory 产物：esbuild cjs bundle + `window.__ModuleLoader__.load({ id, factory: (require) => {...} })` 包装，external `@deepseek-ai/*` 经注入 require 解析（格式对照 `packages/client/tsdown.client.ts` banner/footer，未导入上游构建框架）；
- 共享宿主包 peer/dev 双声明：peer 与 dev 均已声明精确 rc.2，`check:manifest` 通过。

## Typert 生成（2.2 完成）

已由 `scripts/generate-typert.mjs` 完成（详见上文「Typert 源面补充」「生成结果」）。

## 待实测（保持 untested）

- 包管理器对 `engines.dsh` 的安装判定（profile 内 pnpm）与宿主启动判定分别实测（2.3）。
- 真实 Remote invocation / principalOf / ToolRunContext 映射（2.4）。
- 独立 home/profile 安装 tarball 与导航观察（2.3）。
