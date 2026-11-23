# v2 里程碑与交付引用协议（`plan.roadmap`）

本文件说明 v2 资料里 `plan.roadmap` 的语义、可读正反例与独立核对方式。形状以
`schema/project-v2.schema.json` 为准，指纹规则见 `protocol/plan-canonicalization-v2.md`。

## 1. 语义

- **里程碑** = 树中一个已存在普通节点的身份 + 该节点自身的完成条件。每个节点至多一个里程碑；
  里程碑不复制标题、日期或状态，避免与树出现两套真相。
- **交付引用** 表示“该里程碑的成果在哪里”，不产生执行依赖，也不改变任何节点状态：
  - `{"kind":"node","refId":"<uuid>"}`：同项目中的另一个节点（可跨分支）。
  - `{"kind":"record","refId":"<uuid>","contentHash":"sha256:<hex>"}`：已发布成果记录及其正文哈希；
    哈希用来发现“引用还在、内容已变”。
- 里程碑、交付与节点状态互相独立：某节点状态为 `done` 不等于里程碑完成；完成需要专用命令与
  逐项证据（见 `protocol/milestone-completion-v1.md`，随 4.3 发布）。

## 2. 正例

最小启用（空里程碑集合）：

```json
"roadmap": { "milestones": [] }
```

一个里程碑、两项交付（节点 + 记录）：

```json
"roadmap": {
  "milestones": [
    {
      "nodeId": "00000000-0000-4000-8000-000000000002",
      "deliveries": [
        { "kind": "node", "refId": "00000000-0000-4000-8000-000000000003" },
        {
          "kind": "record",
          "refId": "00000000-0000-4000-8000-000000000007",
          "contentHash": "sha256:c4ea4361211dea5f55e5dbdd9b13106647ac7b8217f299da1168d9471ad711a0"
        }
      ]
    }
  ]
}
```

书写顺序不参与指纹：`milestones` 会按 `nodeId` 排序，每个里程碑的 `deliveries` 会按
`(kind, refId)` 排序。

## 3. 反例

| 反例 | 诊断码 |
|---|---|
| 里程碑 `nodeId` 指向不存在的节点 | `milestone-node-missing` |
| 同一 `nodeId` 出现两个里程碑条目 | `duplicate-milestone` |
| 交付指向里程碑自己 | `milestone-self-delivery` |
| 交付节点不在树中 | `milestone-delivery-node-missing` |
| 交付记录不在索引中 | `milestone-delivery-record-missing` |
| 交付记录哈希与索引不一致 | `milestone-delivery-hash-mismatch` |
| 同一里程碑内同一 `(kind, refId)` 出现两次 | `duplicate-milestone-delivery` |
| 交付项 `kind` 不是 `node`／`record` | `invalid-delivery-kind` |
| 里程碑或交付项出现未定义字段 | `unknown-field` |
| v1 资料里出现 `plan.roadmap` | `unknown-field` |
| v2 资料缺 `plan.roadmap` | `missing-field` |

```json
// 反例：里程碑节点不在树中
"roadmap": { "milestones": [ { "nodeId": "ffffffff-ffff-4fff-8fff-ffffffffffff", "deliveries": [] } ] }
```

```json
// 反例：同一里程碑内重复交付
"deliveries": [
  { "kind": "node", "refId": "00000000-0000-4000-8000-000000000003" },
  { "kind": "node", "refId": "00000000-0000-4000-8000-000000000003" }
]
```

## 4. 独立核对

不依赖 DSH 与本机状态，只读资料根：

```bash
node lib/cli/validate.js --source <资料根>
```

校验器从 `project.json` 出发：严格解析（拒绝重复键与未知字段）→ 按 `schemaVersion` 分派 v1／v2 →
核对节点、依赖、记录索引与 roadmap 引用 → 用与实现无关的同一规则重算 `planVersion` 并与自报值比较。
失败时输出稳定诊断码与 JSON Pointer 路径。

## 5. 与后续能力的关系

- **启用 v2**：由 owner 预览兼容影响后显式确认，创建空 `milestones`；旧读者遇到未知版本应停写而非覆盖。
- **编辑里程碑**：只改目标里程碑的公开字段；结构编辑不得隐式删除里程碑。
- **正式完成**：`complete-milestone` 冻结逐项证据与受检版本；历史完成记录按原条件保留（4.3）。
- **目标视图**：从同源快照读取里程碑、成果、条件与依赖，并区分历史／待核对（4.4）。
