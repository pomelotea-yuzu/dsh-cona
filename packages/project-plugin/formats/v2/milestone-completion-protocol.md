# 里程碑完成记录正文协议（v1）

本文件说明 v2 资料中“里程碑完成记录”的正文格式、语义、正反例与独立核对方式。
形状以 `schema/milestone-completion-v1.schema.json` 为准；完成命令与证据规则的语义见
`protocol/roadmap-protocol.md`。

## 1. 记录身份

- 索引：`kind: "verification"`，`summary` 以 `[cona:milestone-completion] ` 开头，
  `subjectNodeIds` 为该里程碑节点，`verification` 为
  `{"status":"pass","subject":{"kind":"node","id":"<里程碑节点>"},"subjectVersion":"<完成后的规划指纹>","scope":"<可查阅范围>"}`。
- 正文：UTF-8、无 BOM。首行必须是版本标记 `<!-- cona:milestone-completion v1 -->`，
  紧接一个 `json` 围栏代码块（严格 JSON：拒绝重复键、未知字段、非安全整数），
  其后是从同一结构生成的可读 Markdown。
- 路径：`records/<recordId>/<contentHash-hex>.md`，`contentHash` 覆盖正文实际字节。

## 2. 正文结构

```json
{
  "version": 1,
  "milestoneNodeId": "00000000-0000-4000-8000-000000000101",
  "inputPlanVersion": "sha256:<64 位小写十六进制>",
  "evidence": [
    {
      "criterionIndex": 0,
      "criterionText": "条件一（原文）",
      "recordId": "00000000-0000-4000-8000-000000000201",
      "contentHash": "sha256:<64 位小写十六进制>"
    }
  ]
}
```

- `milestoneNodeId`：里程碑节点 UUID；必须与索引 `verification.subject.id` 一致。
- `inputPlanVersion`：完成命令核对的**输入**规划指纹（完成前的 `planVersion`）。
- `evidence`：按完成条件原顺序逐项列出，`criterionIndex` 从 `0` 连续；`criterionText`
  保存条件原文，用来发现条件被改动；`recordId` 必须是索引中更早的、结论为 `pass`
  且主题为该里程碑节点的验证记录；`contentHash` 与索引里的 `contentHash` 一致。
- 同一验证记录可以覆盖多条明确选择的条件（同一 `recordId` 出现多次，索引仍连续）。

完成记录自身的 `subjectVersion` 是**完成后的**规划指纹（节点状态已变为 `done`），
与 `inputPlanVersion` 不同；二者都参与核对，不能互相替代。

## 3. 正例

完整正文（UTF-8，无 BOM）：

~~~~markdown
<!-- cona:milestone-completion v1 -->

```json
{
  "version": 1,
  "milestoneNodeId": "00000000-0000-4000-8000-000000000101",
  "inputPlanVersion": "sha256:<完成前指纹>",
  "evidence": [
    {
      "criterionIndex": 0,
      "criterionText": "接口复测通过",
      "recordId": "00000000-0000-4000-8000-000000000201",
      "contentHash": "sha256:<证据 1 正文哈希>"
    },
    {
      "criterionIndex": 1,
      "criterionText": "文档已发布",
      "recordId": "00000000-0000-4000-8000-000000000202",
      "contentHash": "sha256:<证据 2 正文哈希>"
    }
  ]
}
```

## 里程碑完成记录

里程碑节点 00000000-0000-4000-8000-000000000101 按以下逐项证据完成；输入规划 sha256:<完成前指纹>。
~~~~

对照的索引条目（同一权威头内）：

```json
{
  "id": "00000000-0000-4000-8000-000000000301",
  "kind": "verification",
  "subjectNodeIds": ["00000000-0000-4000-8000-000000000101"],
  "path": "records/00000000-0000-4000-8000-000000000301/<正文哈希>.md",
  "contentHash": "sha256:<正文哈希>",
  "summary": "[cona:milestone-completion] 完成 00000000-0000-4000-8000-000000000101（2 项条件）",
  "sources": [],
  "verification": {
    "status": "pass",
    "subject": { "kind": "node", "id": "00000000-0000-4000-8000-000000000101" },
    "subjectVersion": "sha256:<完成后的规划指纹>",
    "scope": "里程碑完成记录：逐项核对 2 项完成条件"
  }
}
```

## 4. 反例

| 反例 | 诊断码 |
|---|---|
| 首行不是版本标记 | `completion-version-marker` |
| 缺少 ```json 围栏 | `completion-json-fence` |
| JSON 重复键 / 非法 JSON | `duplicate-key` / `invalid-json` |
| 未知版本 | `completion-unknown-version` |
| 出现未定义字段 | `completion-unknown-field` |
| 证据为空 | `completion-evidence-empty` |
| `criterionIndex` 不从 0 连续 | `completion-evidence-order` |
| 记录正文哈希与索引不符 | `completion-body-hash-mismatch` |
| 索引主题与正文里程碑不一致 | `completion-subject-mismatch` |
| 证据记录不在索引中 | `completion-evidence-record-missing` |
| 证据记录晚于完成记录 | `completion-evidence-order` |
| 证据记录不是 pass 验证 | `completion-evidence-not-pass` |
| 证据主题不是里程碑节点 | `completion-evidence-subject` |
| 证据受检版本 ≠ `inputPlanVersion` | `completion-evidence-version` |
| 证据哈希与正文声明不一致 | `completion-evidence-hash-mismatch` |
| 证据正文实际哈希与索引不一致 | `completion-evidence-body-hash-mismatch` |

## 5. 独立核对

不依赖 DSH 与本机状态，只读资料根：

```bash
node lib/cli/validate.js check-completion <资料根>
```

校验器从 `project.json` 出发，按索引顺序读取正文，逐项核对：

1. 完成记录的 `kind`、摘要前缀、正文哈希与版本标记；
2. 正文结构（严格 JSON、字段集、索引连续、UUID 与哈希形态）；
3. `milestoneNodeId` 与索引 `verification.subject.id` 一致，且节点仍在树中；
4. 每项证据在索引中更早、为 `pass` 验证记录、主题一致、`subjectVersion` 等于
   `inputPlanVersion`、正文声明哈希与索引及实际字节一致。

输出一行 JSON：`{ok, root, completions:[{recordId, milestoneNodeId, evidenceCount}], issues}`；
`issues` 非空时退出码为 1。历史完成记录的条件原文按原记录保留，不与当前条件比较。
