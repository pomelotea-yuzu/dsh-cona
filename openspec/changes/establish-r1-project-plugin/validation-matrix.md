# R1 验证矩阵

日期：2026-11-12（2026-11-13 更新）。初始为验证计划、下表全部 `untested`；2026-11-13 起按实测更新状态（当前仅 V25a `pass`、V25b `blocked`，其余未动）。第 1 轮外部提案评审见 [review](review.md)，修订及版本化校验记录见 [review-response](review-response.md)。协议向量核算／OpenSpec 校验不改变本表产品运行状态，本文件不代替外部 review。

方法：`A` 为自动业务／Client 测试，`F` 为实际文件后端与中断注入，`H` 为独立 profile 的真实 DSH 检查，`E` 为真实 Agent 端到端。含多种方法的条目须分别记录观察；替身通过不代替真实宿主。运行时追加实际版本、步骤、预期／观察、证据定位与限制，状态仅 `pass / fail / blocked / untested`。

| ID | 对应能力与场景 | 方法 | 必须观察的结果 | 状态 |
|---|---|---|---|---|
| V01 | plugin-integration：独立构建、固定基线 | H | 无相邻上游源码也能冻结安装／构建／pack，实际 Node／DSH 版本明确，不匹配版本拒绝 | untested |
| V02 | plugin-integration：Host／Client 加载 | H | 实际安装包含两端及资源，共享实例无重复，Client 缺入口的反例明确失败 | untested |
| V03 | plugin-integration：Remote | H | 自有 contribution 往返可用，未挂载或断线不显示保存成功 | untested |
| V04 | plugin-integration：隔离、卸载及重载 | H、F | 个人 profile 不改，入口／监听／字典无重复且可清理，资料和回执不删，在途命令保留结果 | untested |
| V05 | portable-project-data：三种位置 | F、H | 同格式同语义，实际位置和可得 Git 状态可见，不静默改位置或自动 Git 操作 | untested |
| V06 | portable-project-data：无代码目录、无 DSH 阅读 | A、F | 可先建逻辑项目；README／schema／独立校验足够，不依赖宿主数据库／模型服务 | untested |
| V07 | portable-project-data：正文发布边界 | A、F | 未引用正文不算发布，资料指令／远程 schema 不自动执行或获取 | untested |
| V08 | portable-project-data：树、依赖、身份 | A | 重复 id、缺父、树环、依赖环及非法引用拒绝，批量拆分全部接受或拒绝 | untested |
| V09 | portable-project-data：完成语义 | A | 过程结束和子节点全完成不标父完成，显式完成核对条件与所需证据 | untested |
| V10 | portable-project-data：公开／私有隔离 | F、H | 三种位置均不泄漏实际 Session、机器路径、授权、草稿或回执，外部结论非本机复测 | untested |
| V11 | portable-project-data：指纹、未知格式 | A、F | 随格式分发的 v1-plan 正文／17 个强制向量可读；主实现及第二份独立实现得到同一字节／散列并拒绝负向输入，排版／记录追加不变、目标／顺序改变；伪造哈希或未知格式不覆盖 | untested |
| V12 | portable-project-data：实例与路径 | A、F | 同项目双目录身份稳定但实例隔离，越界／symlink／hardlink／大小写／权限结果按平台实记 | untested |
| V13 | project-command-commit：统一服务、双修订 | A、F | 过程追加只推进状态，原规划可合法提交且保留新记录；实际规划冲突拒绝 | untested |
| V14 | project-command-commit：幂等响应丢失 | A、F、H | 原样重试及重启后查到原 id／版本，不重复创建，不因自身推进版本误冲突 | untested |
| V15 | project-command-commit：操作归属与回执访问 | A、H | 同 id 不同参数／归属拒绝，无权主体不能读结果，重连可读历史不恢复新写资格 | untested |
| V16 | project-command-commit：无变化、纯查询 | A | 首次无业务变化仅保存新回执并推进状态；查询／已完成重试不推进修订 | untested |
| V17 | project-command-commit：意图／正文／头中断 | F | 意图失败不发布，正文先于头，孤立正文不显示，头可能发布时不能误报未提交 | untested |
| V18 | project-command-commit：候选核对／回执中断 | F | 精确候选可补原回执且修订只推进一次，恢复来源明确，不虚构作者或外部动作 | untested |
| V19 | project-command-commit：旧基线、分叉及 Git 回退 | F | publishing 后原基线重现仍待核对；完成旧回执只作历史，不重放到当前资料 | untested |
| V20 | project-command-commit：unknown-state | F、H | 文件未知停止源新写，本机未知停止实例读写，UI 标未同步，不换 id 盲重试 | untested |
| V21 | project-command-commit：外部顺序编辑 | F | 追加索引保留，冲突标记／非法树／未知 schema 不被旧内存覆盖，源重载使旧绑定失效 | untested |
| V22 | project-command-commit：通知失败和发布中取消 | F、H | 已提交事实仍可查，发布中取消按实际结果核对，不回滚或重复应用 | untested |
| V23 | project-conversation-context：多对多、空会话 | H | 双向关系可查，实际返回 Session id 被记录，复用不误绑，创建未知不再盲建 | untested |
| V24 | project-conversation-context：浏览与授权分离 | A、H | A 运行时浏览 B／增加 B 关联不改执行目标，不自动扩大写权限 | untested |
| V25a | project-conversation-context：owner Remote 与工具上下文映射 | H、E | UI Remote 由宿主生成 owner invocation（`principalOf` 为空不单独授权）；工具 ToolRunContext 无 invocation 但 agent／callId／signal 有效；queue／steer／迟到工具／cancel／重启的 turn 映射可对照 | pass（2026-11-13，见 2.4 映射记录） |
| V25b | project-conversation-context：绑定准入与 non-owner 边界 | H、E | （i）工具无 invocation 但绑定有效按有限范围准入；agent 缺失／归属不唯一拒绝新绑定——第 6 段实现绑定层后复测，计入 R1；（ii）non-owner／伪造主体拒绝——R1 已声明边界 | blocked（i 待 6.2／6.5 复测，不享完成例外；ii 因 R1 无真实多身份部署，不阻 R1 完成，随归档带入 R2+ 边界记录） |
| V26 | project-conversation-context：queue／steer／旧调用 | H、E | 待执行 B 不覆盖 A，同轮不明确归属拒绝，旧绑定不借新范围；续接和新基线有记录 | untested |
| V27 | project-conversation-context：终态及重启 | H | 结束／取消后拒绝新写，未知停止保持未知，Host 恢复历史不激活授权，Client 断线不取消 Host | untested |
| V28 | project-conversation-context：来源与动态上下文 | A、H、E | 背景与实际绑定一致，决定／建议／未核查区分，新材料不静默改目标，授权内调整记录原因 | untested |
| V29 | project-panel-sync：最小编辑与保存 | H、E | 用户编辑与 Agent 调整同树，失败保草稿不标已保存，重启身份／规划不变 | untested |
| V30 | project-panel-sync：一致快照与初读竞态 | A、F、H | 不混合资料版本，先订阅后回读覆盖已知最新状态，树／摘要一致 | untested |
| V31 | project-panel-sync：旧连接／旧源／旧回执 | A、H | 迟到响应不覆盖新快照，历史回执不回滚当前树，跨实例不比较计数器 | untested |
| V32 | project-panel-sync：重连与草稿 | A、H | 重新订阅／完整回读看到已提交事实，未提交编辑及基线保留 | untested |
| V33 | project-panel-sync：外部变化及未知提示 | F、H | 无通知也在准备／刷新边界重读，待核对／隔离明确显示，对应写入关闭 | untested |
| V34 | plugin-localization：安装资源与回退 | A、H | 中英全部 key／占位符可用，元信息随包，缺失反例失败，其他宿主语言英文回退不改宿主偏好 | untested |
| V35 | plugin-localization：切换与重启 | A、H | 导航／已开面板更新，节点选择／输入保留，重启跟随宿主选择，字典卸载重载无重复 | untested |
| V36 | plugin-localization：内容和时间隔离 | A、H | 项目原文、协议码、指纹与修订不变；长文本、数量、时区可用，语言不改日期或 Agent 授权 | untested |
| V37 | 六能力整体闭环，必含 V32／V04 | E、H | 预构建安装→小树保存→聊天→真实 Agent 授权内调整并记原因→UI 已提交→Client 断线重连完整回读（V32）→重启恢复→卸载及重新安装（V04）→原资料／历史回执一致且旧 WorkRun 不恢复授权，可重复 | untested |
| V38 | portable-project-data：外部 v1 首次接入 | F、H | 全新本机根无原注册表／数据库时取得外部合法 v1 文件，沿用原项目／节点 id，新建本机实例，不重建项目，不导入旧授权或回执；仅基础接入，非 R2 Git 或 R6 跨机试用 | untested |

## 路线图 R1 必须反例映射

| R1 路线图场景 | 本矩阵 |
|---|---|
| 过程记录后提交原规划 | V13、V21 |
| 已提交响应丢失后重试／重启 | V14、V16 |
| 同操作 id 不同参数或归属 | V15 |
| 三种位置且私有数据不混入 | V05、V10、V12 |
| 正文／公开头／回执之间中断 | V17、V18、V19 |
| 文件未知或本机 unknown-state | V20、V33 |
| 伪造身份、旧绑定和排队请求 | V24、V25a、V25b、V26 |
| 结束／取消及 Host 重启后的 WorkRun | V27 |
| 初读新变更、乱序和旧连接 | V30、V31；R1 第二投影为规划摘要，未验收路线图 UI，R2 再补实际路线图一致性 |
| 重连、通知失败和旧回执 | V22、V31、V32 |
| 完成标准的组合闭环、Client 重连与卸载清理 | V37 必须组合 V32、V04，不能仅用各单项 pass 代替 |
| 无原本机状态首次接入外部 v1 并沿用身份（N15 基础检查） | V38；不代替 R2 跨副本 Git 协作或 R6 跨环境试用 |

## 完成判据

必须场景 fail／blocked／untested 时，R1 不标完成；保留问题、影响和下一步，不能通过删除必需场景缩小口径。**V25b 例外**：仅其 non-owner 部分（ii）因 R1 无真实多身份部署而 `blocked`，不阻 R1 完成；该边界须随 change 归档写入 R2+ 记录，且不得改为 `pass`。其绑定准入与 agent 缺失／归属不唯一部分（i）不享此例外，必须在 6.2／6.5 实现后复测并按实际结果更新。每项 pass 绑定实际对象与版本，实际代码变化后按影响复核。路线图原“树与路线图一致”的 R1 核查明确以树／规划摘要代替，路线图 UI 一致性留 R2，不因 V30 pass 宣称已验收路线图。外部 v1 基础接入在 V38 验证；新机器／Git 完整协作属于 R2，真实跨环境试用属于 R6，本机双目录不冒充它们已完成。
