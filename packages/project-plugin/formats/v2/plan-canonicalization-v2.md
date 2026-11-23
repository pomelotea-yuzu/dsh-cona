# v2 规划指纹规范化（`v2-plan`）

本文件是 v2 投影的跨语言实现说明，与 `protocol/plan-canonicalization.md`（v1）并列。
v1 的字符串编码、键排序、整数与 UTF-8 规则完全沿用，**不得**为 v2 改动；v2 只增加
`schemaVersion = 2` 与 `plan.roadmap` 的投影与集合排序规则。

配套工件：

- `schema/project-v2.schema.json` —— v2 资料形状；
- `protocol/plan-vectors-v2.json` —— v2 一致性向量（正向与拒绝）；
- `protocol/roadmap-protocol.md` —— 里程碑与交付引用的可读说明与正反例。

## 1. 版本分派

读取 `project.json` 后先看 `schemaVersion`：

| 值 | 投影 | 说明 |
|---|---|---|
| `1` | `{schemaVersion, project, plan{nodes,dependencies}}` | 与 v1 完全一致；出现 `plan.roadmap` 按未知字段拒绝。 |
| `2` | `{schemaVersion, project, plan{nodes,dependencies,roadmap}}` | `plan.roadmap` 必填（可为空集合）；缺失按缺失字段拒绝。 |
| 其他 | 拒绝 | `invalid-schema-version`；不猜测兼容。 |

从 v1 启用 v2 会改变 `schemaVersion`、新增 `roadmap`，因此必然产生新指纹；原 v1 指纹只是历史。

## 2. 投影

投影只含 `schemaVersion`、`project`、`plan` 三个顶层字段；`planVersion` 与 `records` 不参与。
v2 的 `plan` 比 v1 多一个 `roadmap` 字段，其形状固定为：

```json
{ "roadmap": { "milestones": [ { "nodeId": "<uuid>", "deliveries": [ ... ] } ] } }
```

- `milestones` 允许为空数组；每个 `nodeId` 至多一个条目，且必须是树中存在的节点。
- 交付项只有两种形状，字段集合固定、不允许多余字段：
  - `{"kind":"node","refId":"<uuid>"}`
  - `{"kind":"record","refId":"<uuid>","contentHash":"sha256:<64 位小写十六进制>"}`
- 里程碑本身不携带标题、日期、状态或完成标记：标题与完成条件取该节点在 `nodes` 中的原值，
  完成状态与证据属于记录与后续专用命令，不进入规划指纹。

## 3. 集合排序（v2 新增）

在 v1 三条白名单（`project.repositories` 按 `id`、`plan.nodes` 按 `id`、`plan.dependencies`
按 `(nodeId, requiresNodeId)`）之外，v2 再排两层，均使用 **UTF-16 码元序**（与 v1 相同的比较器）：

1. `plan.roadmap.milestones` 按 `nodeId` 升序；
2. 每个里程碑的 `deliveries` 先按 `kind`、再按 `refId` 升序（`kind` 是普通字符串比较，
   `"node" < "record"`）。

排序是规范化的唯一集合语义：同一集合的不同书写顺序必须得到同一指纹；排序后的副本写入 canonical
文本，不修改输入。交付项去重按 `(kind, refId)`，重复项在本地校验阶段拒绝，不进入指纹比较。

## 4. 规范化字节与指纹

1. 按第 2 节取投影，按第 3 节排序；
2. 按 v1 协议的键排序与字符串编码规则序列化为 canonical JSON（键按 UTF-16 码元序，逐键写入；
   控制字符固定四位小写十六进制；孤立代理字符拒绝；非安全整数拒绝；`-0` 归一为 `0`）；
3. 以 UTF-8 编码该文本（不带 BOM），计算 SHA-256，写作 `sha256:<64 位小写十六进制>`。

注意：`roadmap` 是 `plan` 的普通字段，参与逐键排序；不要对里程碑或交付项做“字段重排后再拼字符串”
之外的特殊处理。

## 5. 与记录、过程数据的关系

- `records` 索引与正文不参与指纹：新增分析、执行或验证记录不改变规划指纹（v1 同规则）。
- 过程记录（含 v2 完成记录正文）不进投影；只有 `roadmap` 的字段变化才改变指纹。
- 里程碑的“完成依据”是记录与专用命令的职责，不属于本规范。

## 6. 校验诊断

实现方在计算指纹前必须完成 v2 结构校验，并给出稳定诊断码（路径为 JSON Pointer 风格）：

| 诊断码 | 触发 |
|---|---|
| `invalid-schema-version` | 版本不是 1／2，或不是安全整数 |
| `unknown-field` / `missing-field` | 出现未定义字段；v2 缺 `roadmap`；v1 出现 `roadmap` |
| `duplicate-milestone` | 同一节点出现多个里程碑条目 |
| `milestone-node-missing` | 里程碑 `nodeId` 不在当前树中 |
| `milestone-self-delivery` | 交付节点就是里程碑自身 |
| `milestone-delivery-node-missing` | 交付节点不在当前树中 |
| `milestone-delivery-record-missing` | 交付记录不在索引中 |
| `milestone-delivery-hash-mismatch` | 交付记录的 `contentHash` 与索引不一致 |
| `duplicate-milestone-delivery` | 同一里程碑内 `(kind, refId)` 重复 |
| `invalid-delivery-kind` | 交付项 `kind` 不是 `node`／`record` |
| `plan-version-mismatch` | 自报 `planVersion` 与重算值不一致（含伪造指纹） |

## 7. 一致性向量

`protocol/plan-vectors-v2.json` 的 `protocol` 字段为 `v2-plan`，包含：

- `scope: "plan"`：完整文档输入、期望 canonical 文本与 `expectedPlanVersion`；
- `scope: "reject"`：必须被拒绝的输入与 `expectedError` 诊断码。

主实现与独立第二实现都必须复算全部正向向量（canonical 字节与散列完全一致）并拒绝全部负向向量；
向量不得由被测实现重新生成期望值。v1 向量文件保持不变。
