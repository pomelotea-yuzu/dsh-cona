# 接续记录格式 v1（cona:resume）

本文件随插件发布，供其他 Agent 与人工核对「接着上次做」记录。它不是 R1 公开资料协议的一部分：接续记录复用了 R1 的 `execution-note` 记录类型与正文寻址，不改公开 JSON 头字段或 `schemaVersion`。

## 索引层

接续记录在公开 `project.json` 的 `records` 里仍是一条普通 `RecordIndexEntry`：

- `kind`：`execution-note`
- `summary`：以精确前缀 `[cona:resume] ` 开头，其后是简短可读停点
- `path`：`records/<recordId>/<contentHash-hex>.md`，正文必须 UTF-8、无 BOM
- `contentHash`：`sha256:<hex>`，覆盖正文实际字节

普通 `execution-note`（无该前缀）与其他 kind 都不是接续记录。选取时从索引尾部向前找第一条同时满足 `kind === 'execution-note'` 且 summary 带该前缀的条目；跳过普通记录；找到即停。最新候选不可读时不回退到更早的接续。

## 正文层

正文由三部分组成：

1. 独占一行：`<!-- cona:resume v1 -->`
2. 紧随的 `json` fenced block，块内是严格 JSON（拒重复键、孤立代理字符与非安全整数）：

```json
{
  "version": 1,
  "stoppedAt": "完成阶段1目标编辑",
  "nextStep": "实现题库切换",
  "nextStepKind": "confirmed",
  "savedAt": "2026-11-19T05:00:00.000Z",
  "outcome": "目标已保存",
  "decisions": "沿用现有规划基线",
  "openIssues": "题库切换未实测",
  "verifications": [
    { "status": "pass", "subjectId": "<原记录或节点 id>", "label": "单元通过" }
  ]
}
```

3. fenced block 之后是由同一载荷生成的可读 Markdown。

字段说明：

| 字段 | 必填 | 含义 |
|---|---|---|
| `version` | 是 | 固定为 `1`，其他值按「版本不支持」处理 |
| `stoppedAt` | 是 | 停点，trim 后非空 |
| `nextStep` | 是 | 下一步，trim 后非空 |
| `nextStepKind` | 是 | `suggested`（建议）或 `confirmed`（已确认） |
| `savedAt` | 是 | 保存时刻，UTC instant 字符串；用于展示与追溯 |
| `outcome` | 否 | 简短成果 |
| `decisions` | 否 | 已有决定或约束 |
| `openIssues` | 否 | 未解决问题 |
| `verifications` | 否 | 历史验证引用；`status` 为 `pass`／`fail`／`blocked`／`untested`，原样保留，不表示当前通过 |

## 边界

- 公开摘要与正文**不含**本机聊天指针、机器绝对路径、Session id 或执行授权结构；这些留在本机实例聚合。
- 单次投影最多解码一条候选，正文上限 64 KiB UTF-8；超限、版本未知、JSON 非法、哈希不符都显示原因并停止选取。
- 停点记录本身不改变节点完成条件；验证状态是历史证据，规划或代码基线变化后标记为待核对。
