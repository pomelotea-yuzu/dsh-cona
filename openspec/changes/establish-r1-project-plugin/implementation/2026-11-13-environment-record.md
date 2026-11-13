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

## profile 安装与启动实测（tasks 2.3，2026-11-13 实测）

- `npm pack`：46 文件 tarball（`artifacts/pack/dsh-cona-project-0.1.0.tgz`，门禁排除目录），解包后 `check:manifest --packed` 通过；无相邻上游源码参与。
- 安装：`dsh plugin --profile cona-r1-test add <tarball>`（CLI 首用时自动新建独立 profile `~/.dsh/profiles/cona-r1-test/`），profile 内 pnpm **11.28.5** 执行安装，**未因 engines.dsh/engines.node 拒装**；peer 警告符合预期（cordis/dsh-tools/typert-protocol 由宿主运行时注入）。注意：同名同版本重复 add 会被 pnpm 跳过，重装需先 remove 再 add。
- `--dump-config`：组合层出现 `# == dsh-cona-project` → `- id: cona-project, name: dsh-cona-project`（cordis.patch.yml 插件行生效）；profile 根 `dsh.profile.bundles = [@deepseek-ai/dsh-base, dsh-cona-project]`。
- **启动实测**：`dsh --profile cona-r1-test` 启动成功、进程持续存活（45s timeout 击杀，exit=124）、零激活告警；插件激活日志输出 `[dsh-cona-project] host apply; node = v24.21.0`——**宿主进程实际 Node 即自带的 24.21.0**（与 runtime.json 记录一致），engines.dsh="0.2.2-rc.2" 通过宿主兼容判定。
- 调试过程修复两处（均已随本轮提交）：函数插件访问 `ctx.tools` 需声明 inject（cordis `Inject.resolve(plugin.inject)`，函数与模块两层都声明）；工具 schema 的 `required` 必须是对象级数组（dsh-tools 强制 JSON Schema 子集，property 内布尔 `required` 报 JsonSchemaError）。

## 待实测（保持 untested）

- Client 导航与 Client factory 加载观察（需 GUI 交互；第二轮已证 profile 缺 Web 应用，boot graph/资产已验，浏览器内激活仍未验证）。
- 真实 Remote invocation / principalOf / ToolRunContext 映射（2.4；第二轮已用 browser peer 调通 probe，non-owner 与工具上下文未测）。
- 共享实例与多 profile 并存结果（2.3 收尾；第二轮已证 profile 内无共享 peer 副本，多 profile 并存未测）。

## 第二轮验证：外部测试 2.3（2026-11-13 晚）

测试者未改动个人 profile；因命令沙箱禁止写 `~/.dsh`，全部安装/启动在独立 `DSH_HOME`（`artifacts/r1-2.3-test/home-*`）内复现，证据留在 `artifacts/r1-2.3-test/`（门禁排除目录）。开发命令：clean 检出构建用 `pnpm build`（pnpm 12.18.0，即 DSH 运行时自带 11.28.5 按 packageManager 自升级；系统 Node v26.13.0），pack 用 `pnpm pack --pack-destination`，profile 安装用 `dsh plugin --profile cona-r1-test add <tgz>`。

### 发现并已修复的问题（洁净检出无法复现 2.3 的“构建并 pack”）

1. **测试仍指向旧 `dist/` 布局**：`test/cli.test.ts` 的 CLI 路径是 `dist/src/cli/validate.js`。洁净检出没有 `dist/`，0 项能跑；本仓之所以曾报 79 项全过，是因为工作区残留了布局重构前（16:40）的未跟踪 `dist/`，测试实际跑的是旧构建产物。
2. **CLI `init` 的包根上溯级数错误**：`src/cli/validate.ts` 从 `import.meta.url` 上溯 3 级（旧 `dist/src/cli` 深度），`lib/cli` 布局下解析到 `packages/`，`init` 读 `packages/formats/...` 报 ENOENT（exit 2）。
3. **`pnpm build` 不生成 Typert 产物**：`build` 原先只有 tsc + client；洁净检出 pack 得 42 项，缺 `lib/typert.host.{js,d.ts}` 与三个 `typert.remote-client.*`，但 `check:manifest` 仍通过——原先只核对 `files` 数组文本，不核对产物是否存在，也未查 `exports` 目标。

修复：CLI 上溯改 2 级并更新 README 命令；`build` 追加 `node scripts/generate-typert.mjs`，并加 `prepack: npm run build`（实测删空 `lib/` 后直接 `pnpm pack` 仍产出完整包）；`check:manifest` 增加包内与 `--packed` 解包目录的 exports/files 存在性检查。修复后实测：79/79 测试、typecheck、boundaries、protocol-sync、`check-repo --all` 全过；`pnpm pack` 47 项（含 Typert 5 文件与 pnpm 自动带入的根 LICENSE），`check:manifest --packed` 通过。

### 2.3 剩余缺口：cona-r1-test 没有 Web 应用，Client 无法加载

- 自定义 profile 的默认组合是 `DEFAULT_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base"]`（`packages/util/official-bundles/src/bundles.ts:45`）；`cona-r1-test` 的 `dsh.profile.bundles` 只有 base + 插件。`dsh --profile cona-r1-test` 实测只打印 `[dsh-cona-project] host apply; node = v24.21.0`，进程存活但不开 HTTP、无页面——之前的“启动成功、零告警”成立，但这份 profile 从结构上不可能观察 Client。
- 真实 profile 已按用户授权改动：重装本轮修复版 tarball（47 文件），并把 `@deepseek-ai/dsh-web-app` 加入 `dsh.profile.bundles`（安装自带 bundle，非 npm 依赖；未触碰 desktop）。改动前备份见 `artifacts/r1-2.3-test/profile-backup/`；装好的包内 CLI `init` 已实测可用。
- 加入 `@deepseek-ai/dsh-web-app` 后：`dsh --profile cona-r1-test --port 0 --no-open` 打印 `http://127.0.0.1:65180/?token=…`；`GET /` 跟随 303 后 200；`__DSH_BOOT__` 76 个 entry 中含 `dsh-cona-project`（第二个 application batch，URL `plugins/??dsh-cona-project/client.js&rev=d1d94585a03c`），该 bundle HTTP 200（1433 字节，`__ModuleLoader__.load` 包装完整）。
- **真实 profile 复测**：`dsh --profile cona-r1-test --port 0 --no-open` → `dsh web: http://127.0.0.1:65337/?token=…`，页面 200（41314 字节），boot graph 76 entries、`dsh-cona-project` entry `plugins/??dsh-cona-project/client.js&rev=967847feb140`；该 bundle 200（1433 字节）；Remote probe 返回同上（owner、v24.21.0）。启动无告警。
- 离线按 loader 契约执行服务端下发的 bundle：注册 id=`dsh-cona-project`、`apply` 可调用并输出 `[dsh-cona-project] client factory loaded`。这是产物契约级验证，**不是**浏览器激活证据。
- Remote 探针（真实 HTTP 调用，非静态）：带浏览器 cookie `POST /api/conaDiagnostic/probe`，body `{"type":"client-request","rpcId":…,"method":"conaDiagnostic/probe","payload":{"args":{}}}` → `{"ok":true,"value":{"hasInvocation":true,"peerPrincipal":{"kind":"owner"},"service":"conaDiagnostic","runtime":{"nodeVersion":"v24.21.0"}}}`。`principalOfResult` 缺省符合协议（`principalOf` 对 owner 返回 undefined，`packages/vendor/dsh-typert-protocol/src/principal.ts:14`）。
- 共享实例：profile 的 `node_modules` 只有 `dsh-cona-project` 与 `zod`，无 `@deepseek-ai/*` 副本；cordis/dsh-tools/typert-protocol 由宿主注入，工具注册通过宿主 schema 校验。

证据文件（本机 `artifacts/r1-2.3-test/`，不入库）：`cleanroom.sh`（洁净检出脚本）、`boot-base.log`（无 Web 应用启动）、`boot-web.log`（web 应用启动与 URL）、`index.html`、`boot-graph.json`、`client-bundle.js`、`probe-browser-peer.json`、`repo-test*.log`；独立 home 为 `home-a`（base-only）、`home-b`（加 web-app）。

### 浏览器内 Client 激活（2026-11-13 18:57，用户 Safari 实测）

- 打开 `http://127.0.0.1:65337/?token=…` 后，Safari 控制台出现 `[dsh-cona-project] client factory loaded`，来源标为 `apply — index.ts:13`：Client factory 已在真实浏览器中加载并执行 apply，2.3 的 Client 观察闭合。
- 同一控制台还有两类非插件故障，记录以免误判：WebSocket `ws://127.0.0.1:65337/api/remote.mux` 报 `closed due to suspension`（Safari 后台标签挂起；同一服务端 HTTP Remote probe 仍成功）；`/assets/*.js.map` 404（打包页面不提供 source map，仅因打开检查器才请求）。

### 仍未验证

- non-owner principal、agent 缺失／归属不唯一的绑定拒绝（2.4，均已实测记录为 blocked；其余 2.4 项已测，见下节）。


## 2.4 映射实测（2026-11-13 晚，API 驱动真实会话）

详细记录与事件序列见 [2.4 映射实测记录](2026-11-13-2.4-mapping-record.md)。要点：

- **Remote invocation（owner）**：浏览器 cookie 与 `/connect` API cookie 均返回 `hasInvocation:true`、`peerPrincipal:{kind:"owner"}`、`service:"conaDiagnostic"`、`runtime.nodeVersion:"v24.21.0"`；`principalOfResult` 缺省符合协议（owner 时 `principalOf` 为 undefined）。
- **无 invocation 的 ToolRunContext**：真实会话调 `cona_diag_context` 得 `agentId=SessionId`、`callId` 单次、`signalAborted*` 与 `waitedMs`；`ToolExecution` 本身只有 `callId/rootCallId/agent/signal`，没有 invocation/principal。
- **queue**：运行中第二条 prompt 以 `agent/inbox/spliced target=next-turn` 排队，不打断当前 turn，turn 结束后作为下一 turn 消费。
- **steer**：运行中 steer 以 `target=next-step` 在 step 边界注入；在飞工具不被 abort（实测 `delayMs=15000` 完整等满、`abortedAtEnd=false`），迟到工具结果仍进入同一 turn。
- **cancel**：取消信号 112ms 内到达工具（`abortedAtEnd=true`），宿主把结果替换为 `Error: tool call aborted`，`turn/end {"kind":"aborted","reason":{"kind":"user"}}`。
- **重启**：kill 后重启宿主（pid 17719→17882），resume 同一会话：历史保留，`agentId` 不变，`callId` 换代。
- **blocked**：non-owner principal（`PrincipalMap` 仅 owner；唯一非 owner 面是需独立服务与 OAuth 的 liveshare `share-viewer`）；agent 缺失／归属不唯一的绑定拒绝（R1 无绑定层，属第 6 段）。
- 上轮提交的 Client 自动探针已回退：洁净构建 `TS2307`（tsc 先于 generate）＋运行时 `require("@deepseek-ai/dsh-typert-protocol/remote-info")` 未在模块表而 `dsh.client.inject=[]`；2.4 的 Remote 证据改用真实 `/api` 载体。
- 由此触发 [R1 范围修订](../scope-amendment.md)（2.4→2.4a/2.4b、V25→V25a/V25b、design 增 DSH 行为前提表），已按工作流交第 2 轮 review；通过前 2.4a 不勾选、2.4b 保持 blocked。


## 2.5 门禁与插件 CI（2026-11-13）

- 根 `package.json` 新增 `check:ci`：`node scripts/check-repo.mjs --all && pnpm build && pnpm typecheck && pnpm test:run && pnpm check:plugin && pnpm check:manifest`；插件 `test` 拆出 `test:run`（`tsc -p tsconfig.test.json && node --test lib-test/test/*.test.js`），构建只跑一次。
- 本地实测（PATH 指向宿主自带 Node）：`node v24.21.0`、`pnpm 12.18.0`；`pnpm install --frozen-lockfile` 通过；`pnpm check:ci` exit 0——洁净度 147 文件 0 问题、链接 68 篇 0 问题、双语 5 对 0 问题、build/typecheck、**79/79 测试**、包边界、协议同步、manifest 全过。
- CI：`.github/workflows/ci.yml` 改为 pnpm 12.18.0 + Node 24.21.0、`pnpm install --frozen-lockfile` + `pnpm check:ci`；`.workflow/ci.yml`（Gitee Go）自装 Node 24.21.0、`npm i -g pnpm@12.18.0`（npmmirror 源）、install + `check:ci`，保持单条 `&&` 链（沿用 Gitee 单条不短路教训）。
- 未验证：GitHub Actions 与 Gitee Go 的**远端实跑**本机无法执行；只做了 YAML 语法解析（Ruby YAML 通过）与本地同一命令链验证。远端 runner、镜像源与 pnpm 全局安装行为保持 `untested`，不能记成 CI 已通过。
