# {{PROJECT_TITLE}} · 项目资料

本目录是 DSH-Cona 项目管理插件的**公开资料根**。任何 Agent 或实现都可以凭本目录与公开协议读取、校验规划，不要求安装 DSH 或插件。

## 权威入口

- `project.json`：项目与规划的唯一权威入口。`planVersion` 是规划投影的 SHA-256 指纹（`sha256:<lowercase-hex>`）。
- `schema/project-v1.schema.json`：v1 结构说明（供阅读；权威校验以协议为准）。
- `protocol/plan-canonicalization.md`：规划指纹字节协议（权威）。
- `protocol/plan-vectors.json`：强制一致性向量（实现必须复算，不得由被测实现重新生成）。
- `records/`：不可变记录正文，路径 `records/<recordId>/<contentHash-hex>.md`。

## 如何编辑与校验

1. 规划变更必须保持 `planVersion` 与重算指纹一致；实现无关的校验命令（插件包内 `dsh-cona-project/cli/validate`）可核对全文与正文哈希。
2. 记录正文按内容寻址写入，索引条目引用其路径与哈希；孤立正文（无索引条目）不得发布。
3. 未知字段与未知格式版本会被拒绝：升级格式必须升 `schemaVersion` 并迁移，不静默略过。

## 私有数据边界

本目录只保存公开资料。会话、授权、回执、WorkRun 等私有运行数据存放在本机数据根，不进入本目录；聊天原文等无法共享的来源保留在私有记录，公开摘要标注其来源未公开。
