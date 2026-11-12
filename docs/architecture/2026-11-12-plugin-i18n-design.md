# 插件 i18n 接入与内容语言设计草案

日期：2026-11-12。状态：用户已明确要求插件支持 i18n，并选择首版完整支持简体中文和英文、其他宿主语言回退英文。宿主事实来自固定版本源码静态核查，具体实现建议尚未运行验证，均为 `untested`。

## DSH rc.2 已提供的能力

基线为 `0.2.2-rc.2`，提交 `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`。已阅读 locale README、Host／Client 实现、包元信息读取、官方插件用法与相关检查脚本；本次没有启动 DSH 或加载插件，没有运行上游测试。

| 能力 | 源码与约定中的行为 |
|---|---|
| 内置语言 | `zh`（简体中文）、`en`、`ja`、`es`、`fr`、`de`、`ru`、`pt`（巴西葡萄牙语，也匹配 `pt-PT` 请求） |
| 选择与保存 | 设置 → 常规 → 语言；通过 Host settings 保存 `locale.preference`。没有显式选择时匹配浏览器／桌面壳提供的语言列表，无法匹配时使用英文 |
| 插件字典 | `ctx.locale.register(namespace, { zh, en, ... })` 注册类型化命名空间，基础字典要求 `zh` 和 `en` 完整，其他语言可扩展 |
| UI 翻译 | `ctx.locale.bind(namespace)` 或 Slot 注入的 `t`；Slot 渲染会随 locale／字典 revision 更新，支持运行中切换 |
| 查找与回退 | 先在插件命名空间沿当前语言的 fallback 链查找，再查 `common`，最后显示 key；内置非英文语言回退到 `en` |
| 插件管理页元信息 | 另用可解析的 `locale/en.json`、`locale/zh.json` 中的 `meta.title`、`meta.description` 等；`LocalizedText` 以英文为回退，经 `resolveText` 展示 |
| 扩展与限制 | 可注册额外语言；服务本身不提供复数选择规则或 RTL 布局。注册时已捕获的静态文案不会仅因语言切换自动更新 |

依据：[locale 约定](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/client/locale/README.zh.md)、[Client locale 实现](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/client/locale/src/client/index.ts)、[语言设置 schema](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/client/locale/src/locale-settings.ts)、[包元信息读取](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/boot/app-boot/src/package-meta.ts)。

## 本插件的接入建议

直接使用 DSH 的 locale 选择、持久化和字典注册，不再维护另一套全局语言选择器或单独引入 UI 翻译运行时。首版提供完整 `zh`／`en`；DSH 选择日语等其他语言时，插件命名空间回退英文，宿主自身仍保持用户选择的语言。

从第一个面板开始使用本插件拥有的独立命名空间，例如 `dsh-cona.project`、`dsh-cona.roadmap`；这些是命名示例，尚非已落地 API。避免向 `common` 写入本插件业务词汇或与其他插件争用命名空间。

Client 声明 locale 依赖，字典通过 `ctx.effect` 注册并随卸载清理。资源可组织在本插件的 `src/client/locales/zh.ts` 与 `en.ts`，用类型化 key 集合约束两份字典；按功能增长再拆分。`locale/*.json` 中的插件元信息单独提供，不假定放入 JSON 就会自动注册 UI 字典。

所有产品固定文案进入字典，包括导航、面板标题、按钮、状态标签、错误提示、空态、确认框、工具提示、无障碍标签、图表与路线图标注。组件在渲染时调用 `t`，不能把翻译后的字符串永久存入 Client store；导航与注册表优先使用 label 回调，缺少动态接口的注册项需在切换时明确刷新。

参考：[官方插件字典与 Slot 用法](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/client/ui-message-feedback/src/client/index.ts)、[侧栏面板动态标签](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/client/ui-schedule/src/client/index.ts)。

## 界面语言与项目内容分开

| 内容 | 建议处理 |
|---|---|
| 固定 UI 文案、系统状态与业务错误 | 根据宿主 locale 翻译；Host 返回稳定状态／错误码及结构化参数，Client 负责展示 |
| 用户输入的项目／节点名称、目标、完成条件、决定、分析和聊天 | 原文保存；切换 UI 语言不自动翻译、覆盖或增加规划修订 |
| 内置流程与骨架模板的名称、说明、预览 | 提供中英资源，稳定 template id 与版本不随语言变化 |
| 实例化后的可编辑目标和阶段文字 | 保存实例化时的实际内容与来源；后续 UI 切换不重写用户项目 |
| Agent 的回答、分析和生成文档 | 遵循当前用户请求、聊天上下文与项目语言约定；不能只因 UI 切换就改写内容或全局系统提示词 |
| spec、change、路径、工具名和参数字段 | 保留实际标识；可翻译说明，不翻译协议身份或文件引用 |

例如，一个中文项目在英文 UI 中仍显示用户起的中文项目名，而“进行中”状态显示为 “In progress”。同一项目无需为不同界面语言复制一棵树。

Host 项目服务不依赖浏览器侧 `ctx.locale`。不同 Client 的渲染语言不改变工具协议、项目状态或验证结果。错误码与参数让 UI 可以翻译，也让模型读取一致的机器事实；未知错误使用通用本地化提示，保留可诊断信息。

是否增加单独的“项目默认内容语言”设置、导出时选择语言或翻译已有项目内容，留待实际需要再设计；首版语言支持要求不自动授权这些内容变更。宿主 locale 包的职责是 UI，不会自动设置模型的回答语言；系统提示词另有接入，不能混为一项能力。

跨机器协作使用[可移植项目资料](2026-11-12-project-data-portability.md)，稳定状态码和用户正文不随各人 UI 语言改写。两位协作者可以分别用中英文界面阅读同一份规划；Git 不同步各人的界面语言、Session 或运行授权。资料 README 与 schema 可供其他 Agent 直接读取，不要求其实现 DSH locale。

## 数字、复数与路线图时间

文案采用完整句子和命名占位符，例如 `{count}`、`{title}`，不通过拼接中文语序组成英文。DSH 的插值只负责替换命名参数，数量变化需要显式区分 one／other 等文案，必要时使用 `Intl.PluralRules`，不能假定宿主已提供 ICU MessageFormat。

数字、日期和相对时间通过 `Intl.NumberFormat`、`Intl.DateTimeFormat`、`Intl.RelativeTimeFormat` 格式化。插件展示用的 locale 根据宿主选择及本插件支持范围确定；首版中文使用 `zh-CN`，其他语言的插件文案回退英文时可统一使用英文格式，具体格式在实现中核对。

路线图的时间数据必须与显示语言分离：

- 实际发生时间可保存为 UTC instant，展示时使用明确的时区。
- 目标日期、周或月份是日历值／时间窗口，保留其精度与适用时区，不能一律转换为 UTC 午夜。
- 切换语言只改变排版与标签，不移动日期或重新排期；语言不决定项目时区。
- “未排期”“目标日期”“实际完成”等标签可翻译，时间本身及其期望／约定／事实含义保持稳定。

日期模型和项目时区的具体设置仍由[路线图实施设计](../product/2026-11-12-project-roadmap-design.md)确定，此处明确避免语言切换改变规划语义。

## 工程检查与验收

本仓现有 `i18n/docs-manifest.json` 与 `scripts/check-i18n.mjs` 检查对外文档配对和链接，不构成产品 UI 已支持 i18n 的证据。DSH 自身的检查还覆盖 UI 硬编码、资源 key、占位符和包元信息，但包含 monorepo 路径、源码数量及八语言规则，本插件须建立适合自身范围的检查，不能直接照搬。

R1 建立 UI 字典与类型约束，在有组件与运行环境后加入必要检查和行为测试：

1. 中英 key 完整且对应，插值占位符一致，翻译缺失不会由 `common` 碰巧掩盖。
2. 导航、已打开面板、空态、错误、弹窗及无障碍标签在语言切换后更新，未提交的表单内容与选中节点保留。
3. 日语等其他宿主 locale 下本插件使用英文回退，不篡改宿主语言偏好。
4. 重启后读取宿主选择，卸载／重载不重复注册字典；实际安装包含 UI 资源和元信息。
5. 项目名称、目标、聊天、状态码、节点身份、规划修订与日期值在切换前后保持一致。
6. 英文长文本、数字／复数、时间格式及跨时区日期没有截断、语义改变或越日错误。

R2 的树／路线图、R3 的分析、R4 的提醒／错误、R5 的模板随各功能同步补齐中英资源。R6 核查完整安装包和真实使用过程，不把最后批量翻译作为首版才做的收尾工作。

参考：[UI 文案硬编码检查](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/scripts/verify-client-ui-i18n.ts)、[资源与包元信息检查](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/scripts/verify-locale-metadata.ts)。以上运行验收当前全部为 `untested`，没有新增产品测试代码。
