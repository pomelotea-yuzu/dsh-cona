# DSH rc.2 插件开工前复核

日期：2026-11-12。性质：对本仓提交 `1645beb` 的版本同步记录作独立静态复核，并补测本机版本；不新增产品决定，不代表插件加载或业务运行验证通过。

## 结论与范围

可以按用户指定的 DSH `0.2.2-rc.2` 基线开始插件开发。已查看的源码未发现必须修改 DSH 核心或推翻现有项目管理架构的依据；独立包构建、安装、Host／Client 加载和业务联动仍须实测。

本次阅读了决定索引、产品与架构草案、两份接入调研、历史边界和仓库门禁，并核对本机 rc.2 源码中的安装协议、Client 模块格式、布局、Remote 挂载、Typert 生成与领域存储。没有重新下载归档、重做 rc.1／rc.2 全量差异比对或重新向官方取样；先前的归档校验结论仍归属于[当天首次复核](../research/2026-11-11-dsh-project-management-review.md#2026-11-12-源码快照校验与差异复核)。

同日后续要求已扩展为可选资料位置、Git 多人协作、其他 Agent 可读与新机器 DSH 接续。下文领域存储核查保留当时事实，其作为全部项目数据存储的候选地位已调整；现行[数据专题](../architecture/2026-11-12-project-data-portability.md)采用公开文件协议，storageDomain 只作本机运行数据候选，不能据此宣称跨介质原子提交。

## 本次实测

| 检查 | 观察结果 |
|---|---|
| 已安装桌面应用 | `DeepSeek Harness.app` 的 `Info.plist`：`CFBundleShortVersionString = 0.2.2-rc.2` |
| 本机源码快照 | 根包与 `apps/cli/package.json` 均为 `0.2.2-rc.2`，Node 要求均为 `>=24.9.0` |
| 系统开发 Node | 当前 shell 的 `node --version`：`v26.13.0`；此前 Agent 记录的 `v22.22.2` 不是本次观察值 |
| 桌面随包运行时 | `runtime/versions.json` 与 `runtime/primary-runtime/runtime.json` 声明 Node `24.21.0`、pnpm `11.28.5`；直接执行 primary-runtime 的 Node 二进制得到 `v24.21.0` |
| Git hook 配置 | `core.hooksPath = .githooks` |
| 仓库门禁 | `node scripts/check-repo.mjs --all` 通过；洁净度、链接、双语检查均为零问题，洁净度及双语自测通过 |

随包运行时的元数据和二进制版本不等于当前桌面 Host 进程实际使用的 Node 版本，本次没有读取运行中进程来作此判断。系统 Node、随包 primary-runtime 与仓库 CI 的 Node 20 也不能互相替代兼容性证据。

## 开发时需要落实的前提

### 1. 固定版本要落实到包声明与依赖

本阶段建议组合包显式声明 `engines.dsh: "0.2.2-rc.2"`，所用 DSH 开发依赖与锁文件也固定到核查过的版本，不能用 `latest` 或宽范围暗中跟随上游。宿主源码中的兼容检查优先使用 `engines.dsh`，存在该字段时不再用 DSH peer 范围替代判断。

需要共享宿主实例的依赖按官方约定声明 peer，并在本仓提供开发副本；不能把上游 `workspace:*` 原样当作第三方仓库的可安装版本。首次安装仍须验证依赖解析及共享实例，本次没有查询注册表发布情况或安装依赖。

依据：[组合包安装约定](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/docs/user/develop/basic/publish.zh.md)、[兼容检查实现](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/boot/app-boot/src/plugin-compatibility.ts)。

### 2. 浏览器面板需要 DSH 模块产物

`dsh.bundle` 与配置 patch 负责 Host 组合，不能单独代替 Client 声明。带面板的包还须声明 `dsh.client.platform: "web"`，导出构建好的 `./client`，并进入宿主 Loader 的扫描范围。

rc.2 浏览器加载器使用 lazy CJS factory 表，上游产物通过 `window.__ModuleLoader__.load({ id, factory })` 注册。不能仅输出普通 ESM 文件就假定能加载；Host 仍采用 Node ESM。React、Cordis 等共享模块使用宿主模块表，其他依赖按其规则内联或声明精确 external，避免重复运行时实例。

上游 Client 构建助手依赖 monorepo 内部文件，本仓需要自包含的构建配置。独立面板的 `main` root keyed slot 与 `sidebar.panellist` 接入位置仍成立，但这只是接口存在的静态结论。

依据：[Client 模块协议](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/docs/subsystems/client-modules.zh.md)、[Client 构建配置](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/client/tsdown.client.ts)、[共享模块表](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/client/web/src/platform.ts)。

### 3. 自有 Remote 需要生成并挂载

原调研对此已有正确提醒。本次确认 `ctx.remote.$mount(contribution)` 提供第三方挂载位置，Typert generator 也公开构建插件；独立仓库仍须准备其分析配置、生成产物和 Client 挂载，不能假定内置 API assembly 会发现本插件的方法。

依据：[Client Gateway 实现](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/api/gateway/src/client/index.ts)、[Typert 构建插件](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/typert/generator/src/tsdown-plugin.ts)。

### 4. 存储排队不替代项目校验

`storageDomain` 可以继续作为持久化候选，但写入 API 不负责项目树合法性或授权，也不能仅凭 schema 声明就假定每次写入均重新校验。读取的记录是内存中对象本身，不可原地修改；否则可能在持久化成功前改变权威读取结果。

项目服务应先构造并校验新的聚合，在同一提交序列中核对修订与幂等信息，持久化成功后发布。底层 `update` 有单记录排队变换能力，不能据此承诺任意跨记录或跨文件事务；`unknown-state` 会隔离该领域，UI 须显示待恢复或错误状态。现有架构的服务层串行提交方向与此相符。

依据：[领域存储实现](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/storage/storage-domain/src/domain.ts)。

## 第一个开发切片

沿用现有架构，先在独立测试 profile 中验证：本仓可独立构建并打包 → Host 与 Client 加载 → 项目面板显示持久树 → 节点创建或打开关联聊天 → Agent 通过同一项目服务读写 → UI 显示已提交状态 → 重启接续。

首轮同时覆盖保存失败、重复请求、过时修订、错误会话绑定及切换浏览节点不改变运行目标。进入插件构建后补充符合 DSH 基线的 Node 构建／测试检查；当前 Node 20 文档门禁通过不能当作插件兼容通过。

这只是开工验证顺序，不缩减首版产品需求。模板、持续分析、SDD 等继续按现有架构分段实施。第三方安装、加载、重连、持久化恢复和 Agent 联动本次全部为 `untested`；未启动 DSH、未加载自制插件、未修改个人 profile。
