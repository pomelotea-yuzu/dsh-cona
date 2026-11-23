# 用户流程模板协议（v1）

用户模板是 `kind: "plan-change"` 的公开记录，其索引 `summary` 以精确前缀 `[cona:template] ` 开头，正文首行为版本标记 `<!-- cona:template v1 -->`，紧接一个标为 `json` 的围栏代码块（严格 JSON：拒绝重复键、未知版本、未知字段、非安全整数），其后为可读 Markdown。正文使用 UTF-8、无 BOM。

模板正文只含作者显式确认的标题、目标、完成条件、层级与内部依赖：节点使用局部 `key` / `parentKey`（根为 `null`），依赖两端均为模板键。项目节点 UUID、聊天关系、本机授权和任何私有数据都不进入正文。对外依赖在从子树抽取时省略。正文语言 `bodyLanguage` 是一个明确语言标签（如 `zh-CN`、`en`）或 `und`；它只描述原文，宿主 UI 语言与它独立，实例化按作者原文进行，不翻译。

## 正文形状（version: 1）

```json
{
  "version": 1,
  "templateId": "0b1e2f3a-0000-4000-8000-00000000c301",
  "title": "功能开发流程",
  "bodyLanguage": "zh-CN",
  "nodes": [
    { "key": "n0", "parentKey": null, "order": 0, "title": "功能开发", "goal": "交付可验证功能", "completionCriteria": [] },
    { "key": "n1", "parentKey": "n0", "order": 0, "title": "实现", "goal": "按目标实现", "completionCriteria": ["实现完成"] }
  ],
  "dependencies": [
    { "nodeKey": "n1", "requiresKey": "n0" }
  ]
}
```

约束：
- `templateId` 为 UUID；每次发布是不可变版本，正文或结构变化须换新的 `templateId` 或至少新记录。
- 单根、局部键唯一、父键存在、父子无环、同级 `order` 从 0 连续。
- 依赖两端都存在、不自依赖、不重复、无环。
- 规模上限：节点 200、每节点完成条件 50、标题 500 字、目标 2000 字、条件 500 字、正文 200000 字。

目录只收已发布且正文验证成功的记录版本。读取以 `templateId`、`versionRecordId`（记录 UUID）与 `contentHash`（正文哈希）三元组精确匹配；版本不存在或移出索引、身份或哈希不符均返回稳定诊断，不回退到近似版本。

## 正例

1. 上面的单根双节点模板，两条局部依赖均在子树内。
2. `bodyLanguage: "und"` 的中性正文，仅含标题、目标与层级，无依赖。

## 反例（均拒绝）

| 反例 | 原因 |
|---|---|
| `version: 2` | 未知版本 |
| 正文多出 `author` 字段 | 未知字段 |
| 两个节点 `key` 相同 | 重复键 |
| 两个根节点（`parentKey: null`） | 非单根 |
| 父键指向不存在的键 | 父键无效 |
| 同级 `order` 为 `[0, 2]` | 同级顺序不连续 |
| 依赖端点为项目节点 UUID | 依赖必须使用模板键 |
| 依赖成环或自依赖 | 依赖非法 |
| `bodyLanguage: "zh_CN"` | 非法语言标签（应为 `zh-CN`） |
| 正文含项目节点 UUID 或聊天 id | 私有数据／节点身份不得进入模板 |
| 正文首行不是版本标记，或缺 ```json 围栏 | 正文格式不符 |

## 读取

宿主经 owner 实例边界提供异步目录与精确读取：

- `listUserTemplates(instanceId)` → `{source:"user", templateId, versionRecordId, contentHash, bodyLanguage, title}[]`
- `getUserTemplate(instanceId, templateId, versionRecordId, contentHash)` → 单一版本的正文描述

损坏正文、不受支持的版本与孤立记录不进入可实例化目录。内置 `treePresets` 与 `insert-preset` 保持原有协议，不与用户模板目录混用。
