# 结构化替代记录协议（v1）

替代记录是 `kind: "plan-change"` 的公开记录，其索引 `summary` 以精确前缀 `[cona:replacement] ` 开头，正文首行为版本标记 `<!-- cona:replacement v1 -->`，紧接一个标为 `json` 的围栏代码块（严格 JSON：拒绝重复键、未知版本、未知字段、非安全整数），其后为可读 Markdown。正文使用 UTF-8、无 BOM。

## 两种互斥形状（version: 1）

### replace —— 建立替代关系

```json
{
  "version": 1,
  "kind": "replace",
  "sourceNodeIds": ["0b1e2f3a-0000-4000-8000-00000000c301", "0b1e2f3a-0000-4000-8000-00000000c302"],
  "replacementNodeId": "0b1e2f3a-0000-4000-8000-00000000c303"
}
```

约束：`sourceNodeIds` 非空、不重复、均为节点 UUID；`replacementNodeId` 为当前项目节点 UUID，不得出现在来源数组中。

### clear —— 解除既有替代关系

```json
{
  "version": 1,
  "kind": "clear",
  "clearsRecordId": "0b1e2f3a-0000-4000-8000-00000000c3f0"
}
```

约束：`clearsRecordId` 必须是已发布且在当前索引中更早的 `replace` 记录 UUID；解除该记录的全部关系，逐项核对这些来源当前仍指向该记录——指向其他记录、重复解除和部分清除均拒绝；原替代正文继续保留。

## 正例

1. 两个同父级来源合并到一个保留节点的 `replace`（如上）。
2. 其后一条 `clear` 解除该替代关系（撤销合并），原 `replace` 正文保留。

## 反例（均拒绝）

| 反例 | 原因 |
|---|---|
| `sourceNodeIds: []` | 来源为空 |
| `sourceNodeIds` 含重复 UUID | 来源重复 |
| `replacementNodeId` 出现在来源数组中 | 自引用 |
| `kind: "merge"` | 未知 kind |
| `version: 2` | 未知版本 |
| `replace` 形状多出 `note` 字段 | 未知字段 |
| `clear` 指向不存在的记录 ID | 引用错误 |
| `clear` 指向已解除过的记录 | 重复解除 |
| `clear` 解除时部分来源已指向其他记录 | 部分清除 |

## 独立校验

随包提供独立校验命令（无需 DSH 或本机状态）：

```sh
node lib/cli/validate-replacement.js --source <资料根>
```

从 `project.json` 出发：读取索引中的 `plan-change` 记录 → 按摘要前缀与正文首行识别替代记录 → 复算正文哈希与索引一致 → 按索引顺序投影替代关系：核对 `clear` 指向更早记录、逐项核对来源当前指向、拒绝重复活跃来源与替代链成环。任一步失败输出记录 ID、字段与原因并以非零码退出。
