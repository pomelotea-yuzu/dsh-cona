# v1-plan：规划指纹字节协议

状态：R1 change 的规范工件，按 review A2 补充，尚未成为已实现能力。关键词 MUST／MUST NOT 为协议要求。实施时将本文和 [plan-vectors.json](plan-vectors.json) 随包分发，并以相同文件名复制到资料根 `protocol/`，由 README 引用；独立实现不需要 DSH、插件数据库或某一种编程语言。

## 1. 输入与有效值

完整输入是 UTF-8、无 BOM 的 `project.json`。MUST 先严格解析并校验完整 v1 格式／领域规则，再提取规划；不能先删除未知字段后算出“兼容”指纹。规划投影的完整字段如下，字段均必需；完整记录及领域约束另由随格式分发的 v1 schema 定义，不能据本编码协议跳过资料校验。

| 对象 | 字段与值域 |
|---|---|
| 规划投影根 | schemaVersion（整数 1）、project、plan |
| project | id（UUID 字符串）、title／goal（字符串）、constraints（字符串数组）、repositories（仓库声明数组） |
| 仓库声明 | id（UUID 字符串）、label（字符串） |
| plan | nodes（节点数组）、dependencies（依赖数组） |
| 节点 | id（UUID 字符串）、parentId（UUID 字符串或 null）、order（非负安全整数）、title／goal（字符串）、completionCriteria（字符串数组）、status（todo／in-progress／blocked／done／canceled 字符串之一） |
| 依赖 | nodeId／requiresNodeId（UUID 字符串） |

资料携带的 schema 供独立实现阅读；DSH 插件使用安装包内已知版本，不能执行资料所附脚本或获取远程 schema。

严格 JSON 要求：

- 重复对象键、非法 UTF-8、BOM、注释、尾逗号、NaN／Infinity、非 JSON 值均拒绝。同名键以解码后的字符串判断，`"a"` 与 `"\u0061"` 是重复键。
- 解码后的键和值字符串 MUST 是 Unicode 标量序列。正确 surrogate pair 合并为一个补充字符；孤立高／低代理字符拒绝。原始输入可用合法 `\u` 转义，不决定最终字节。
- 数字按其十进制词法表示的**精确数学值**核对，MUST 为区间 `[-9007199254740991, 9007199254740991]` 内的整数；整数值的 `1.0`、`1e0` 可接受，负零归一为 0。不能先以浮点舍入再误接受小数，例如 `9007199254740990.1` 必须拒绝。字段 schema 另可收窄为非负整数或常量。
- 序列化器支持字符串、安全整数、布尔、null、数组和对象。`true`／`false`／`null` 各输出其小写字面量，布尔不得当作整数。v1 字段本身仍按 schema 限定：例如 parentId 可以 null，title 不能 null 或布尔；通用序列化测试允许这些值不等于新增业务字段。
- 不做 Unicode 归一化、trim、换行转换或翻译；`é` 与 `e` 加组合重音可以得到不同散列，这是不同内容。省略字段与显式 null 不等价，只有 schema 允许的形式可进入投影。

## 2. 规划投影及集合白名单

从已校验对象提取且仅提取 `{schemaVersion, project, plan}`。排除顶层 `planVersion` 与 records；不接受额外私有字段后再将其静默略过。

仅以下数组是无序集合，MUST 先生成副本再排序，不能修改调用者输入：

| 精确路径 | 排序键 | 重复规则 |
|---|---|---|
| `$.project.repositories` | 元素的 id | id 唯一 |
| `$.plan.nodes` | 元素的 id | id 唯一 |
| `$.plan.dependencies` | 先 nodeId，再 requiresNodeId 的二元组 | 同一有向关系唯一 |

字符串比较按 UTF-16 无符号码元字典序，不使用 locale、UTF-8 字节序或 Unicode 码点序。补充字符先编码为 surrogate pair 再比较；相同前缀时短串在前。二元组逐项比较，禁止拼接出可能歧义的复合键。

**其余所有数组保留顺序**，包括 constraints、completionCriteria；不能按名称猜测其为集合。节点的 order 值保留，同级业务重排必须改变 order，即使物理 nodes 数组排序不变也会改变指纹。records 不在规划投影内，其正文与索引仍须独立校验。

## 3. 唯一字符串编码

使用双引号包围字符串。对每个已解码的 Unicode 标量按以下规则输出；这里的反斜杠表示输出中的实际 ASCII 反斜杠字节：

| 输入字符 | 唯一输出 |
|---|---|
| U+0022 双引号 | `\"` |
| U+005C 反斜杠 | `\\` |
| U+0008、U+0009、U+000A、U+000C、U+000D | 分别 `\b`、`\t`、`\n`、`\f`、`\r` |
| 其余 U+0000–U+001F | `\u00xx`，固定四个十六进制位，a–f 小写；例如 U+000B 是 `\u000b` |
| 其他所有 Unicode 标量 | 原样输出，包括 `/`、中文、emoji、U+007F、U+2028 和 U+2029；不输出可选 `\/` 或 `\uXXXX` 形式 |

字符串内容中的换行转义为 `\n`，整个 canonical 文本自身没有排版换行或末尾 LF。输入中 `"\u4e2d"` 与 `"中"` 的 canonical 字节相同。上述有效字符串编码等价于 ECMAScript `JSON.stringify(string)` 的输出；其他语言必须显式匹配这些规则，不能使用其默认的 ensure_ascii 或 HTML-safe 选项。

## 4. 递归序列化与散列

对象的**所有层级**键按 §2 的 UTF-16 比较排序，再逐个输出 `Quote(key) + ":" + Encode(value)`；对象和数组分别用 `{}`／`[]`，元素仅用 `,` 分隔，无其他空白。整数输出十进制，负数只加一个 `-`，不用 `+`、前导零、小数点或指数；零及负零输出 `0`。

不要先把排序键插入普通 JS 对象后整体 `JSON.stringify`：整数样式键可能被重新枚举为数值顺序。MUST 直接按排序后的键逐个写入，通用边界向量包含 `"10"`／`"2"` 以检测此问题。

下面是可执行到具体操作的伪代码；StrictParse 和 ValidateV1 必须遵守 §1 及领域规则，Quote 必须逐字实现 §3：

```text
Encode(v):
  if v is null: return "null"
  if v is boolean: return "true" if v else "false"
  if v is exact safe integer: return base10(v), with either zero rendered "0"
  if v is string: return Quote(v)
  if v is array: return "[" + join(",", map(Encode, v)) + "]"
  if v is object:
    keys = sorted(keys(v), UTF16Compare)
    return "{" + join(",", [Quote(k) + ":" + Encode(v[k]) for k in keys]) + "}"
  reject

PlanVersion(inputUtf8):
  doc = StrictParse(inputUtf8)
  ValidateV1(doc)                         # 完整文档；未知字段先拒绝
  p = deepCopy({schemaVersion: doc.schemaVersion, project: doc.project, plan: doc.plan})
  sort p.project.repositories by id      # 比较器均是 UTF16Compare
  sort p.plan.nodes by id
  sort p.plan.dependencies by tuple(nodeId, requiresNodeId)
  canonicalText = Encode(p)
  bytes = UTF8(canonicalText)             # 无 BOM、无末尾换行
  return "sha256:" + lowercaseHex(SHA256(bytes))
```

校验文件自报指纹时先计算期望值再比较，不把 planVersion 纳入自身散列。显式计算命令可输出新指纹供外部 Agent 更新，不能在只读校验时自动修复资料。

## 5. 强制一致性向量与适用边界

[plan-vectors.json](plan-vectors.json) 是协议随附工件，不能由被测实现临时重新生成期望值。每个正向向量携带原始 inputJson、精确 canonical 文本与期望散列；散列前不得把文件为了排版附加的 LF 带入 canonical 字节。

- `scope: plan`：提取完整项目规划并按白名单排序。涵盖中文、不同键序／缩进／输入转义、物理集合顺序、记录追加指纹不变，以及同级 order／目标变化指纹改变。向量不宣称已验证资料路径、记录发布或 DSH 运行。
- `scope: serializer`：直接调用 Encode，覆盖嵌套对象键序、整数样式键、UTF-16 与码点序差异、全部控制字符、斜杠、emoji、U+2028／U+2029、布尔／null 和整数边界；这些是编码算法向量，不是完整 project.json。
- `scope: reject`：严格解析阶段必须拒绝，附输入和拒绝原因；无期望散列，不能先得到舍入值再哈希。

主实现和第二份不依赖主序列化函数的独立实现 MUST 对正向向量产生完全相同的 canonical 字节及散列，并拒绝负向向量。两份实现可以用不同语言；不要求安装 DSH。协议工件的复算检查和将来的产品测试分别记录，不能把前者计为 R1 的 V11 或跨机器协作已通过。
