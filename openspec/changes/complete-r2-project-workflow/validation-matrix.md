# R2 收尾验证矩阵

2026-11-22 编写。A 为自动测试，F 为真实文件及 Git，H 为固定 DSH `0.2.2-rc.2` 上安装预构建插件包的实际场景。以下为本 change 的待验计划。前两个 R2 切片及 R1 的历史结果在原矩阵中保留。按场景执行后记录运行环境、包哈希、真实动作和实际观测。组合场景要求所列分句证据齐备后标 `pass`。 [实施任务](tasks.md)

## 公开资料与协作

| ID | [增量场景](specs/portable-project-data/spec.md) | 层级与判据 | 状态 |
|---|---|---|---|
| C01 | 干净环境接入合并后的资料 | F＋H · 非 DSH Agent 从公开 README 独立读改 JSON 与 Markdown，合并后在 B 预览及接入。比对稳定 ID、本机映射、历史接续与验证、两实例私有数据隔离 | `untested` |
| C02 | 外部编辑与并发草稿核对 | A＋F＋H · 同计数异指纹、未提交修改、仅追加和预览后变化。分别注入索引缺失、同 ID 改写、缺正文、正文哈希失配，核对稳定诊断、原快照、草稿及停写 | `pass`（2026-11-23 A/F 层：诊断码、预览接纳分离与停写由 10 项自动测试与夹具 F 层实测覆盖，见 [1.1–1.3 记录](implementation/2026-11-23-1.1-1.3-source-acceptance.md)；H 层待 5.2 补） |
| C03 | Git 语义冲突和历史回退 | A＋F＋H · 真 Git 文本合并成环，修正后重取。用同仓库历史 commit 树的头和全部正文证明可确认的回退。伪历史及字节失配保持停写。核对旧操作号、迟到响应、源代际与副本隔离 | `pass`（2026-11-23 A/F 层：git-unmerged／dependency-cycle／回退两步确认／伪历史拒绝／副本隔离由真实 Git 测试覆盖，旧操作号重发沿既有幂等机制，见 [1.1–1.3 记录](implementation/2026-11-23-1.1-1.3-source-acceptance.md)；H 层待 5.2 补） |
| C04 | 三种位置迁移保持身份 | F＋H · 三种位置间迁移并携旧配置重启。核对同一实例命令只落新根，原根哈希保留。外部编辑旧根不改变当前实例，明确重接入后作为独立副本 | `pass`（2026-11-23 A/F 层：项目→DSH→自定义→项目三跳循环、身份与代际推进、旧根指纹保留、`source-location-mismatch`、显式重接入独立实例、`startup-location` 迁移解析与歧义拒绝由 `migration.test.ts` 与 CLI 独立进程用例覆盖，见 [1.4–1.5 记录](implementation/2026-11-23-1.4-1.5-migration.md)；宿主重启 H 层待 5.2 补） |
| C05 | 迁移中断和目标冲突 | F＋H · 复测旧 registry／state、复制期间并发命令与登记、目标冲突、四个持久断点。至少一次实际宿主重启，核对唯一生效定位、意图、回执、代际和目标哈希 | `pass`（2026-11-23 A/F 层：schema 1→2 升级保留登记、四个持久断点 hooks 注入与恢复、取消只清理核对过的候选、候选／目标意外内容拒绝、`migration-in-progress` 拒刷新、登记占用拒绝、重复确认摘要核对、`migration-work-pending`、CLI 独立进程恢复链路由 `migration.test.ts` 覆盖，见 [1.4–1.5 记录](implementation/2026-11-23-1.4-1.5-migration.md)；实际宿主重启 H 层待 5.2 补） |
| C06 | 排版与过程记录变化 | A＋F · 两版本仅排版／过程记录变化保持指纹，规划语义变化更新指纹。模板版本追加保持指纹 | `untested` |
| C07 | 伪造指纹或未知格式 | A＋F · 伪造指纹、未知字段和版本走独立校验及 Host 写入入口，核对拒绝和原文件哈希 | `untested` |
| C08 | 第二份独立实现复算 | A＋F · 两个版本均对比主实现、独立实现和公开样例的字节、指纹及错误输出 | `untested` |
| C09 | v1 继续编辑并显式启用扩展 | A＋F＋H · 原 v1 普通编辑及旧校验器、启用取消与冲突、回读失败和重复请求、v2 旧读者停写。核对稳定 ID 和正文。旧验证保留原受检版本且不成为当前 v2 证据 | `untested` |

## 树编辑与模板

| ID | [增量场景](specs/project-tree-editing/spec.md) | 层级与判据 | 状态 |
|---|---|---|---|
| E01 | 编辑条件并分组拆分 | A＋F＋H · 条件回读、选择同父节点分组、分组后拆分。核对父子、顺序、ID、依赖以及非法批保持零发布 | `pass`（2026-11-23 A 层：条件保存回读、分组锚点定位／成员相对顺序／原子树 ID 与依赖保留、拆分父节点状态条件保留、空选择／跨父级／根节点／无效锚点／部分非法整批拒绝且输入头指纹不变、端到端 owner 单次修订提交与 agent 直达 `forbidden`，由 `group-nodes.test.ts` 覆盖，见 [2.1 记录](implementation/2026-11-23-2.1-node-editing-grouping.md)；面板多选/位置选择/预览确认与焦点还原已随 2.6 接入（见 [2.6 记录](implementation/2026-11-23-2.6-tree-editor-ui.md)），H 层待 5.3 补） |
| E02 | 合并保留来源和替代关系 | A＋F＋H · 解析公开替代记录、按原 ID 定位保留节点，原历史与聊天保留。撤销读清除记录，重做读新关系。成环或冲突不可见部分结果。独立校验替代／解除样例，包括错误引用和重复解除 | `pass`（2026-11-23 A 层：合并后来源原 ID 保留为 canceled、后代移入保留节点、依赖 keep/reattach/drop 三处置与未处置拒绝、自依赖环拒绝；端到端 owner 单次权威头发布替代记录（正文可解析、摘要前缀、subjectNodeIds 覆盖）、同号原样重发返回原回执且不重复发布、agent 直达 `forbidden`；独立校验器正例／解除通过、clear 引用错误与重复解除拒绝，见 [2.2 记录](implementation/2026-11-23-2.2-merge-copy.md)。撤销追加 clear、重做产生新 replace 已随 2.3 逆向命令复测，见 [2.3 记录](implementation/2026-11-23-2.3-undo-redo.md)；聊天保留随 5.3 补 H） |
| E03 | 复制只有模板化的规划内容 | A＋F＋H · 有状态及关联的子树复制，选择外部依赖，模拟回执丢失重试。核对新 ID、内部映射、初始状态及原关联 | `pass`（2026-11-23 A 层：新子树 todo、内部依赖按新 ID 映射、外部依赖按确认接入且未列出不接入、ID 数量／目标父／锚点／源缺失校验、原树与原依赖不动，由 `merge-copy.test.ts` 覆盖，见 [2.2 记录](implementation/2026-11-23-2.2-merge-copy.md)；回执丢失重试沿既有意图机制（同号幂等已在合并命令验证）；聊天与成果关联保留随 5.3 补 H） |
| E04 | 保留无关编辑的撤销和重做 | A＋F＋H · 重启后核对字段、树、模板插入和里程碑关联的逆向及重做，保留无关编辑。比较新修订、已有历史和原回执 | `pass`（2026-11-23 A/F 层：字段编辑的 undo/redo 保留无关字段且各只增一次规划修订、重启后新服务可从聚合读取历史与逆向并重新预览、模板插入的整批生成节点按原身份移除、结构移动的往返、合并撤销追加 clear 与重做新 replace（E02 注记）、逆向数据只读本机且不进公开资料，由 `undo-redo.test.ts` 7 项覆盖，见 [2.3 记录](implementation/2026-11-23-2.3-undo-redo.md)；里程碑关联的 set-milestone 尚未实现，按任务在 4.5 补测；H 层待 5.3 补） |
| E05 | 后续修改或引用使逆向不安全 | A＋F＋H · 旧操作无逆向信息、后续触碰字段、新增关系、活动工作及换源分别核对限制。逆向信息不进公开资料 | `pass`（2026-11-23 A/F 层：旧操作无逆向信息 `unavailable`、触碰字段已改 `inverse-field-changed`、生成节点被公开记录引用 `inverse-node-in-use`、活动 WorkRun `inverse-work-active`、换源 `source-changed`、确认预览过期 `preview-mismatch`、同号重放只回读原回执、不可逆场景保留资料字节与修订，由 `undo-redo.test.ts` 覆盖，见 [2.3 记录](implementation/2026-11-23-2.3-undo-redo.md)；逆向信息只写 state.json；H 层待 5.3 补） |
| E06 | 保存用户模板并从另一副本复用 | A＋F＋H · 两版本随 Git 到 B，以模板 ID、版本记录 ID 和哈希选旧版并插入两次。核对单语言原文、中英与英文回退、独立 ID、依赖和模板记录分类 | `pass`（2026-11-23 A/F 层：子树抽取只用局部键、省略对外依赖、项目节点 UUID 与私有数据不进正文；正文构造/解析往返保留作者原文；保存两版各只推进一次状态修订、`planVersion` 与规划修订不变、摘要前缀 `[cona:template] `、`subjectNodeIds` 为空（WorkRun 上下文按主题过滤，模板记录不会成为规划变更或成果）、v1 校验器回读；异步目录按三元组精确读取 `source:"user"` 条目；同一模板在两个父/锚点位置各插入一批 todo 节点与内部依赖、单次规划修订、v1 回读、原树不动，插入可撤销，由 `user-template.test.ts` 与 `insert-user-template.test.ts` 覆盖，见 [2.4 记录](implementation/2026-11-23-2.4-user-templates.md) 与 [2.5 记录](implementation/2026-11-23-2.5-insert-user-template.md)；跨副本 Git 随 5.2、H 层待 5.3 补） |
| E07 | 模板版本变化、无效正文或重试 | A＋F＋H · 版本不存在、记录 ID 或哈希不匹配、无效正文、目标冲突各有诊断。已提交回执丢失后原样重试，重复生成次数为零 | `pass`（2026-11-23 A/F 层：三元组不符返回 `template-version-unavailable` 且不回退近似版本；损坏正文（哈希不符）与孤立记录（正文不存在）被目录过滤；未知版本、额外字段、非法语言、重复键、非单根、父键无效、依赖成环均被严格解析拒绝；作者原文不随 UI 语言变化；插入路径核对 `template-version-unavailable`（版本不存在）、`template-version-mismatch`（哈希或 templateId 不符）、`template-invalid`（正文 version=2）、`parent-not-found`（null/缺失父）、`invalid-anchor`（锚点不在目标同级组）；源变化 `source-changed` 与基线冲突 `plan-conflict` 保留草稿不改文件；断联同号原样重试只回读原回执、重启后查询一致、同号改参 `operation-mismatch`，不重复生成。由 `user-template.test.ts` 与 `insert-user-template.test.ts` 覆盖，见 [2.4 记录](implementation/2026-11-23-2.4-user-templates.md) 与 [2.5 记录](implementation/2026-11-23-2.5-insert-user-template.md)） |
| E08 | 多实例和可信身份校验 | A＋H · B owner 有效，错实例、非 owner、未登记、不可读及缺动作或位置权限拒绝。原入口仍工作 | `pass`（2026-11-23 A 层：owner 准入与错实例／未登记拒绝沿用既有用例；新增工作入口只对启动配置实例开放（`work-entry-unavailable`，不静默换实例），结构命令在缺工作端口的 agent 上下文硬性 `forbidden`；缺 `move`／`insert` 动作、源／目标越权、根组未授权、模板未授权分别给稳定码。见 [3.3 记录](implementation/2026-11-23-3.3-agent-structural.md)。H 层真实宿主身份与拒绝码复测随 5.4） |
| E09 | 工作运行中修改同实例的树 | A＋F＋H · 原位预览与实际编辑前后比较运行目标及绑定，真实 Agent 的两种原运行写法均被拒，新工作获准写入 | `pass`（2026-11-23 A/F 层：owner 原位预览／结构变更后运行目标与绑定版本保持不变（2.4 既有）；结构命令下旧捕获版本写 → `binding-expired`，owner 改基线后原运行仍可捕获与读上下文、同一运行拿新基线写 → `binding-expired`，结束旧运行并显式发起新运行后同一写入获准；Agent 合法提交只推进绑定版本与已接受基线，目标集合不变。见 [3.3 记录](implementation/2026-11-23-3.3-agent-structural.md)。真实 Agent 的 H 层证据随 5.4／J05 补） |
| E10 | 插入预设并独立再次插入 | A＋F＋H · v1 与 v2 均在两个位置插入原内置预设，核对 v1 旧校验器、v2 里程碑与交付原值和现有信封兼容 | `untested` |
| E11 | 拒绝不可用或无效的模板输入 | A＋F · 复核不可用内置版本、无效结构、语言及锚点诊断，拒绝时磁盘和规划修订保持原值 | `pass`（2026-11-23 A/F 层：用户模板插入的版本不存在、哈希/身份不符、正文无效、父节点 null/不存在、锚点不属于目标同级组分别返回稳定码；全部拒绝后磁盘字节与规划修订保持；内置 `insert-preset` 原协议与失败诊断回归通过（见 `tree-commands.test.ts` 与 `insert-user-template.test.ts`）。内置预设无效结构/语言诊断沿用 2.1 既有覆盖，见 [2.5 记录](implementation/2026-11-23-2.5-insert-user-template.md)） |
| E12 | 原子候选与原操作回执 | A＋F · 结构及衍生正文同一权威头。非法子步骤、发布前中断与无操作保留原头。回执丢失返回原 ID、双修订和结果，同号换参数拒绝 | `pass`（2026-11-23 A/F 层：`unified-command-receipt.test.ts` 10 项。请求摘要覆盖业务载荷与基线（位置／模板版本／锚点／记录三元组／组成与合并处置／复制目标／模板子树根／逆向目标／验证结论逐项改参均产生不同摘要，字面量顺序不影响，基线三项任一变化即变摘要）；合并的规划候选与替代正文只经一次 `writeDocument` 与一次 `writeBody`（hooks 计数各 1），回执 `recordId`＝意图 `generated.recordId`＝索引条目 id、正文实际哈希＝索引 `contentHash`、候选头与磁盘一致，双修订各只 +1；`append-record` 带 `verification` 同样单头单正文、只推进状态修订、规划指纹不变；分组无衍生正文（1 头 0 正文）；插入预设的 `generated.nodeIds` 与磁盘新节点集合一致且重发返回同一修订；非法子步骤（合并未处置依赖）退回 `unresolved-dependency` 且不写正文／不改头／不落意图；头发布前中断（publish `beforeRename` 注入）退回 `persistence-failed`，头与记录索引保持，先落的正文不进索引；回执丢失（第三次聚合替换注入失败）返回 `pending-reconciliation`／stage `receipt`，`recover` 按候选匹配返回原 operationId、规划指纹、双修订 2/2 与原记录 id，`getReceipt` 与原样重发同源且不重复发布；同号改位置／模板版本／验证结论／逆向目标分别 `operation-mismatch` 且字节与修订不变；原位移动只推进状态修订、头字节与指纹保持。见 [2.7 记录](implementation/2026-11-23-2.7-unified-command-receipt.md)；4.x 的路线图格式与里程碑命令按 4.1／4.3／4.5 复用同一契约复测，H 层（真实宿主同号重发与中断）随 5.x 补） |

## 聊天与执行

| ID | [增量场景](specs/project-conversation-context/spec.md) | 层级与判据 | 状态 |
|---|---|---|---|
| W01 | 独立实例中的多个真实会话 | A＋H · B 两会话的实际导航、双向查询、错误关联拒绝、解绑及无执行副作用。中英与英文回退下保留用户填写的用途 | `pass`（2026-11-23 A 层：概览九个 `conaOverview/chat*` 入口按 instanceId 定向到该实例聊天服务；会话目录按实例 cwd 过滤，另一副本的会话与无 cwd 会话不可见、不可冒领（`session-not-visible`）；同会话不同用途为多条链接、同用途合并节点（6.1 既有）；解绑支持整条与按节点裁剪；打开走 `openTarget` 复查后只调宿主导航，控制器用例断言快照与命令调用数为 0（无执行副作用）；用途按用户原文展示与提交，中英 key 一致（check:locale）。见 [3.1 记录](implementation/2026-11-23-3.1-instance-chats.md)。两会话真实导航与操作前后事实随 5.4 H 层补） |
| W03 | 从接续摘要发起多节点新工作 | A＋H · 独立 profile 将 B 设为配置实例并重绑，比较准备、消费后的范围、来源和旧验证。确认另一个聊天、未选节点和迟到请求被拒 | `pass`（2026-11-23 A 层：概览四个 `conaOverview/work*` 入口只对启动配置实例开放（否则 `work-entry-unavailable`，不静默换实例），会话须经聊天目录核对属于本实例工作区；`previewWork` 只读给出目标条件、直接依赖（目标外端点带标题）、约束、基线、与目标相交的公开记录／聊天入口，同会话目标外节点只进背景与建议条目，源代际／基线／缺节点记 `unverified`，预览前后聚合与修订不变；确认按 `prepare → start` 用同一意图与基线，`startWork` 支持“该会话下一条消息”的会话域确认（不预知 rpcId），绑定仍只在真实消费边界形成，运行后其他消息 `unmatched`，同会话多意图 `ambiguous-intent` 不建运行。见 [3.2 记录](implementation/2026-11-23-3.2-work-preview.md)。H 层（干净 profile 配 B、真实消息消费、工具读结果一致、旧验证待核对）随 5.4 补） |
| W04 | 获准和越界的移动及插入 | A＋F＋H · 配置实例真实 Agent 使用 `move`／`insert`，检查缺动作、源／目标／同级越权、无根组许可的重排、精确版本、新 ID 和旧绑定拒绝。即使有根组重排和插入许可，两类 `parentId: null` 仍返回 `parent-not-found`，获准的现有父节点可正常插入 | `pass`（2026-11-23 A/F 层：`work-structure.test.ts` 9 项覆盖——影响范围按当前轮廓解析（子树／源组后移同级／目的组插入点起同级／根组标记）；缺动作 `forbidden`、源与目标越权 `structure-scope-denied`、根级重排缺许可 `root-group-not-allowed`（授予后发布一次且不放开子节点升根）、无模板授权／版本不符／用户模板哈希不符 `template-not-authorized`；两类 `parentId: null` 在持有 insert＋根组＋精确版本时仍 `parent-not-found` 且无候选无生成节点；获准父节点下内置模板插入单次修订、生成 ID 独立、运行目标集合不变、绑定版本 +1；旧捕获版本与新基线写法 `binding-expired`，显式新运行可写。见 [3.3 记录](implementation/2026-11-23-3.3-agent-structural.md)。真实 Agent 工具提交与读视图核对的 H 层随 5.4 补） |
| W05 | [多个关联聊天时打开选定会话](specs/project-overview-resume/spec.md) | A＋H · B 卡片打开所选 Session，A 目标、队列及订阅原样。B 的项目工作入口仍不可用，未建立 A 可信绑定的工具请求被拒 | `pass`（2026-11-23 A 层：卡片与聊天列表的打开都先经 Host 复查链接与宿主实际 Session，通过后只调 `uiWorkspace.openSession`；控制器用例断言该路径不读快照、不发命令，A 的运行目标／队列／订阅不参与；实例行 `configured` 只对启动配置实例为真，界面据此显示工作入口不可用；未建立 A 可信绑定的工具请求仍按 R1 绑定入口拒绝（既有 `project-tools` 用例）。见 [3.1 记录](implementation/2026-11-23-3.1-instance-chats.md)。真实宿主下 A 活动运行与独立订阅不变的观测随 5.4 补） |
| W06 | [原聊天已失效或从干净环境接入](specs/project-overview-resume/spec.md) | F＋H · 同名及失效会话、明确重绑和实际 Session 导航，中英／英文回退提示，接续原文、发送数及运行保持 | `pass`（2026-11-23 A 层：指针缺失区分 `pointer-not-here` 与 `unlinked`，失效链接显示不可打开；卡片在 `unlinked`／不可用时给显式重绑按钮，`chatRebindResume` 先核对记录版本（不符 `record-version-changed`）再以记录主语节点建立／复用链接，链接身份经宿主会话列表核对后写指针，同名但属其他工作区的会话因 cwd 过滤不可认领；重绑与诊断文案中英齐备、用户用途原文保留。见 [3.1 记录](implementation/2026-11-23-3.1-instance-chats.md)。公开资料仅在干净 profile 的实测（接续原文、发送数与运行保持）随 5.4 补，F 层的 Git 传递随 5.2） |

## 项目路线图

| ID | [增量场景](specs/project-roadmap/spec.md) | 层级与判据 | 状态 |
|---|---|---|---|
| M01 | 目标视图同步与实例隔离 | A＋H · 树及目标视图与工具读取版本一致。检查成果、条件、依赖、进展、阻塞、下一步与聊天的有来源或空态。重连、浏览切换、旧响应、语言及导航不执行 | `untested` |
| M02 | 跨分支交付引用与独立达成 | A＋F＋H · 多里程碑复用、源移动或替代保留原 ID，替代目标可查。缺条件、v1 证据和普通状态写拒绝。逐项当前证据和范围齐备才在一次发布记录完成与前后受检版本。独立校验通过样例并拒绝错误的证据 ID、哈希及版本 | `untested` |
| M03 | 核对新增与历史交付引用 | A＋F＋H · 自引用、重复、非法新增及外部移除里程碑节点拒绝。取消及替代保留历史。外部使交付失效、哈希不符时记录原 ID 和诊断 | `untested` |
| M05 | v2 树编辑保留交付规划 | A＋F＋H · A／F 穷举新旧规划变换，v2 比对未修改的扩展，v1 保持旧协议。H 实测改目标、移动及模板插入后的快照与持久回读 | `untested` |

## 联合验收与归档回归

| ID | 原矩阵与主路径 | 层级与判据 | 状态 |
|---|---|---|---|
| J01 | 固定宿主、隔离 profile 和产物 | F＋H · 核对版本、包哈希、安装、非 DSH Agent、可复现的合法 v1 夹具和实际登录后的工具调用条件 | `blocked`（2026-11-23：F 部分 pass——版本、包哈希、安装冒烟、v1 夹具齐备，见 [0.x 记录](implementation/2026-11-23-0.x-env-and-fixture.md)；H 部分因隔离 profile 未登录 blocked，真实 Agent 凭证补齐后复测） |
| J02 | Git 接入、回退与迁移组合 | F＋H · 从外部修改到 B 概览回读，跨真实 Git 回退和迁移重启检查版本、链接范围、独立实例与唯一写入位置 | `untested` |
| J03 | O11、T04 · 其他实例真实聊天 | H · 在 B 有两个实际聊天的子树上做跨父移动，观察两个确切 Session、真实多对多链接、成果与节点身份，核对 A 运行不变 | `untested` |
| J04 | O02/O03/O06/O07/O08/O10、T11 · 草稿、引用、故障 | F＋H · 概览跨页草稿与迟到响应。丢失保存响应／过期、公开摘要与本机指针部分成功。分别改变规划、HEAD、工件。有效与越界引用。准备后终止进程、未知发布、重启与旧响应 | `untested` |
| J05 | T12 · 活动 WorkRun 修改规划 | H · 真实 Agent 依次核对旧基线、新快照基线仍被绑定拒绝、越范围，结束旧运行后由新 WorkRun 成功写入 | `untested`（2026-11-23 A 层前置证据：旧捕获版本与新基线写法均 `binding-expired`、owner 改基线后原运行可读、结束旧运行后新运行可写，见 [3.3 记录](implementation/2026-11-23-3.3-agent-structural.md)；真实 Agent 的 H 层随 5.4） |
| J06 | T13、O08/O12 · 验证回读 | F＋H · 以带 `verification` 的原 v1 资料验证更新后重启、历史状态、代码观察、成功保存回执、公开记录哈希和本机聊天入口。测概览/树订阅切换时的连接代际 | `untested` |
| J07 | O01–O13、T01–T14 · 原能力回归 | A＋F＋H · 必复跑 O02/O03/O06/O07/O08/O10/O11/O12/O13、T01–T14。分别覆盖来源刷新、候选与回执、v2 的树变换、其他实例聊天、授权、布局与语言。其他 O 行逐项列受影响入口或保留历史依据 | `untested` |
| J08 | V15/V32/V37/V04 · R1 组合回归 | F＋H · 实例不符拒绝、重连、真实 Agent 授权内拆分及追加记录、UI 同源提交回读、重启与卸载重装，引用真实工具证据 | `untested` |
| J09 | R2 同项目连续交付 | F＋H · 同项目保存自建流程及里程碑，外部 Agent 改读 v2，Git 合并至 B。独立干净 DSH profile 把 B 配为启动配置实例，重绑并获准写入，比对树、目标视图与重启快照 | `untested` |

归档场景基线见 [O01–O13](../archive/2026-11-20-add-project-overview-and-resume/validation-matrix.md)、[T01–T14](../archive/2026-11-22-add-project-tree-editing-and-composition/validation-matrix.md) 与 [R1 验证矩阵](../archive/2026-11-19-establish-r1-project-plugin/validation-matrix.md)。对新版本仍受宿主能力限制的分句记录具体条件和结论。完成度按新包、当前范围及实际证据核对。
