# DSH 插件开发与 Typert 生成踩坑契约（0.2.2-rc.2 实测）

> 2026-11-13 在 R1 插件贯通实验中实测得出（tasks 2.1–2.2），全部为本机验证事实，不是推断。适用范围：DSH `0.2.2-rc.2`、从独立插件仓（非 DSH monorepo 内）开发插件、使用 `@deepseek-ai/dsh-typert-generator` 生成 typert 产物。上游改版后需重测。证据原文见 [R1 环境记录](../../openspec/changes/establish-r1-project-plugin/implementation/2026-11-13-environment-record.md)。

## 版本事实（2026-11-13 实测）

- npm 已发布 `@deepseek-ai/*` `0.2.2-rc.2` 全套（含 `.d.ts` 与 `dsh-typert-generator`；tarball 解包确认）。dist-tags：`latest = 0.2.2-rc.1`（旧）、`next = 0.2.2-rc.3`（比桌面应用新）。
- 桌面应用 app.asar 分发**不含 `.d.ts`**（`src/*.ts` 与 `lib/*.js` 都在，类型声明被剥掉）；不能从 asar 拿类型。
- 插件对版开发不要用 `latest`／`next` 标签，按精确版本安装并与宿主 `engines.dsh` 对齐；类型包与运行时包版本不一致比没有类型更危险。

## Typert 生成器契约（每条都踩过）

1. **源面登记是硬前提**：生成器要求 `Remote`／`TypertRemoteService`／`bindTypertRemote` 符号解析到**登记于 workspace `packages/` 目录下的包源文件**。node_modules 的 `.d.ts` 一律视为未登记，Remote 标记静默失效（服务/invocation 收集为 0，产物为空）。
   解法三件套，缺一不可：vendor 协议包源码进 `packages/vendor/<pkg>`（manifest name 须与真实包名一致）＋ 聚合 tsconfig `paths` 指向其 `src` ＋ 聚合 `references` 登记该包。上游 monorepo 就是这么组织的（tsconfig.base paths 把全部 `@deepseek-ai/*` 映射到包 src）。
   注意：运行时不受 paths 影响（paths 不参与 emit），产物仍解析 node_modules 的 npm 副本——vendor 只服务编译期与生成期。
2. **产物布局**：产物写入包的 `lib/` 目录（`lib/typert.<face>.{js,d.ts}`；有 `@Remote` 方法时另有 `lib/typert.remote-client.{js,d.ts,d.ts.map}`）。因此包自身的构建产物也应对齐上游约定：`lib/` 直接镜像 `src/`（tsc `rootDir: "src"`），测试单独编译到不入包的目录。
3. **manifest 契约**：`exports["./typert"]`／`exports["./remote"]` 必须是 `{ types, default }` 对象条件形式且精确指向上述 lib 产物；`files` 必须显式列出每个产物文件（只写 `"lib"` 不够，生成器逐字校验）。生成器 `validateExport` 不满足直接抛错。
4. **每个导出都要能映射回真实 TS 源文件**：`sourcePathForExport` 把 `lib/X` 映射回 `src/X`，映射不到即报「resolves to missing source」。esbuild bundle 之类无源对应物的产物要放在能映射的位置（如 bundle 入口本来就是 `src/client/index.ts`，就输出到 `lib/client/index.js`）。
5. **Remote 边界类型**：
   - 返回类型**禁止 `undefined`**（wire 值是 JSON）——空值用可选字段缺省或 `null` 表达；
   - 边界类型必须从**非根类型子路径**导出（如 `./types`；根导出 `.` 只对 `dsh-util-values` 豁免）——协议自带类型（Principal 等）走协议自己的 `./types`，插件自有类型要自建 `./types` 子路径导出。
6. **merge 冲突**：`dsh-tools` 的类型链会引入 `dsh-session` 的 `.d.ts`，其中对 `@deepseek-ai/dsh-typert-protocol` 接口（TypertResourceMap 等）做了 module augmentation merge；与 vendored 协议源码出现在同一 face program 时报「merged interface contains a declaration outside this face」。当前解法：插件工具定义不 import `dsh-tools` 类型（工具结构由宿主 `tools.register()` 运行时校验兜底，缺 `output.render` 等形态它会 TypeError）。上游若发布面向插件开发的类型包可恢复静态校验。
7. **lib 集合**：协议源码用了 `Disposable`（`Symbol.dispose`），聚合 tsconfig 的 `lib` 需含 `ESNext.Disposable`——host 与 client 两个聚合都要（client 聚合常自带 lib 覆盖，容易漏）。
8. **vendor 包自身**：manifest 需要 `exports`（`./types` 判定会用）；`tsconfig.json` 在 discovery 阶段就会被解析，必须存在。
9. **构建顺序**：生成器靠「lib 产物 → src 源文件」映射扫描导出面，**先 `pnpm build` 再跑生成**。
10. **生成器依赖独立的 TypeScript 副本**（^6.0.3），与插件仓的 TS 版本互不影响；generator 从 npm 装即可，不需要 DSH 源码仓。

## 工程环境注意

- pnpm 12：`pnpm-workspace.yaml` 的 `packages:` 必须列表形式（裸列表报 ERR_PNPM_INVALID_SETTING）；依赖的构建脚本默认拦截，需 `allowBuilds`（如 esbuild）显式放行。
- `node --test` 在 Node 22 不接受目录参数，用文件 glob。
- 包内遗留 `pnpm-lock.yaml` 应删除（workspace 化后锁文件只在根）。
- 生成器报错信息可读性尚可，但「产物为空、无报错」几乎总是源面登记没生效——先查 paths/references/manifest name 三件套，再怀疑别的。

## 关联

- R1 实施细节与接手状态：[R1 接手记录](../../openspec/changes/establish-r1-project-plugin/implementation/2026-11-13-handoff.md)
- 版本基线：N11（固定 `0.2.2-rc.2`，见[决定索引](decisions.md)）
