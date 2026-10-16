# dsh-trpg 内部契约（冻结）

本文件是**并行开发的分工边界**。三个纯模块（`dice` / `scenario` / `gm`）由不同的人写，
宿主半（`index.js`）按本文件的签名调用它们。**签名一旦写在这里就不再改**；确有必要的改动
必须回到本文件更新后再改代码。

## 全局约定

- ESM（`package.json` 里 `"type": "module"`），只用 `node:` 内置模块，**零第三方依赖**。
- 三个纯模块**互不 import**，也不 import `schema.js`：它们只接收普通数据、返回普通数据。
  它们唯一的副作用来源是注入的 `rng`。
- **绝不自己调随机数**：任何随机都必须走参数传入的 `rng()`（返回 `[0,1)` 的浮点）。
  这是单测可复现的前提，也是「骰子不能被模型伪造」的基础。
- `rng` 参数可省略，省略时用 `dice.js` 导出的 `cryptoRng`。
- 抛错一律用各自模块的 `class ... extends Error`，带 `code` 字符串；**不要抛裸 `Error`**。
- 注释与文案用中文；标识符用英文。
- 单测：`node:test` + `node:assert/strict`，文件名 `test/<module>.test.js`。
  运行方式（Node 24 **不接受目录**，必须列文件，且本机沙箱必须关掉测试隔离，
  否则裸 `node --test` 会 `spawn EPERM`，表现为「测试根本没被加载」）：
  `node --test --experimental-test-isolation=none test/dice.test.js`
- 写文件一律用编辑工具，**不要用 PowerShell 写含中文的源文件**（PS 5.1 会按 GBK 落盘把 UTF-8 打坏）。

---

## 1. `lib/dice.js` — 骰子与检定（负责人：dice-author）

```js
export class DiceError extends Error { code }      // code: BAD_FORMULA / BAD_COUNT / BAD_TARGET
export function cryptoRng(): number                // [0,1)，用 node:crypto.randomInt
export function makeRng(seed): () => number        // mulberry32，仅供测试与「可复现回放」
export function normalizeFormula(input): string    // 去空格、小写化；非法则 throw DiceError
export function parseFormula(input): {
  text: string,          // 规范化后的写法，如 "3d6+2"
  count: number,         // 1..100
  faces: number,         // 1..1000
  modifier: number,      // 可为负
  keep: { mode: "kh"|"kl", n: number } | null
}
export function rollFormula(input, rng?): {
  text: string,
  count: number, faces: number, modifier: number,
  rolls: number[],       // 每次掷出的原值，长度 = count
  kept: number[],        // 计入总和的点数
  dropped: number[],     // 被 kh/kl 丢掉的点数
  total: number,         // sum(kept) + modifier
  keep: { mode, n } | null
}
export function rollCheck(options, rng?): {
  skill: string,          // 可为 ""
  target: number,         // 原始技能值
  difficulty: "regular"|"hard"|"extreme",
  threshold: number,      // 本次难度实际要过的数
  bonusDice: number,      // 奖励骰个数（0..2）
  penaltyDice: number,    // 惩罚骰个数（0..2）
  tens: number, units: number,      // 最终十位/个位
  tensCandidates: number[],         // 奖励/惩罚骰掷出的所有十位
  roll: number,           // 最终 d100 值，1..100
  level: "critical"|"extreme"|"hard"|"regular"|"failure"|"fumble",
  success: boolean,
  description: string     // 一句中文结论，如 "困难成功（目标 55 → 需 ≤27，掷出 19）"
}
export function rollTable(entries, rng?): { roll: number, label: string, index: number }
export function bestOf(rolls, mode, n): number[]    // 供内部/测试复用
```

### 公式文法（`parseFormula` / `rollFormula`）

```
<count>? d <faces> ( ('+'|'-') <modifier> )? ( ('kh'|'kl') <n> )?
```
- 大小写不敏感、可带空格：`D100`、`3 d 6 + 2`、`2d10kh1` 都合法。
- `<count>` 省略即 1；`<count>` 必须 1..100，`<faces>` 必须 1..1000，否则 `DiceError("BAD_COUNT")`。
- `kh<n>`/`kl<n>` 的 `<n>` 省略即 1；`n` 钳到 `[1, count]`。`kh` 取最高的 n 个（D&D 优势），`kl` 取最低的 n 个。
- `rolls` 保持掷出顺序；`kept` 保持**原顺序**（不是排序后）。
- `drop` 时 `kept.length + dropped.length === count` 恒成立。
- `faces === 1` 合法（退化为固定值），不要特判报错。
- 未知后缀（如 `3d6x2`）→ `DiceError("BAD_FORMULA")`。

### `rollCheck` 规则（COC 7e）

- `options`：`{ skill?, target, difficulty?, bonusDice?, penaltyDice? }`。
  - `target` 必填，钳到 `[1,100]`；缺失/非法 → `DiceError("BAD_TARGET")`。
  - `difficulty` 默认 `"regular"`，取值之外一律回落 `"regular"`。
  - `bonusDice` / `penaltyDice` 各自钳到 `[0,2]`；**两者同时 >0 时按净值处理**（`bonus - penalty`）。
- 判定阈值：`regular` = `target`；`hard` = `floor(target/2)`；`extreme` = `floor(target/5)`。
- 百分骰：先掷个位 `units = 1d10 % 10`（即 0..9），十位掷 `1 + max(bonus,penalty)` 次取整十位
  （`bonus` 取**最小**十位、`penalty` 取**最大**十位），`roll = tens*10 + units`，其中
  `tens===0 && units===0` 记作 **100**。`tensCandidates` 记录掷到的所有十位数字（0..9）。
- 等级：
  - `roll === 1` → `critical`（大成功），`success: true`
  - 否则 `roll <= extreme` → `extreme`；`roll <= hard` → `hard`；`roll <= target` → `regular`（三者 `success: true`）
  - `roll === 100 && target < 50` → `fumble`；`roll >= 96 && target < 50` → `fumble`；`target >= 50 && roll === 100` → `fumble`
  - 其余 → `failure`
  - 注意顺序：**大成功/大失败要优先于普通成功判定**（`roll===1` 即使 target 也是 1 仍算 critical）。
- `description` 必须是含数字的中文短句，例如
  `"困难成功（目标 55，需 ≤27，掷出 19）"`、`"大失败（目标 40，掷出 100）"`。

### 单测至少要覆盖

边界（count 上下限、faces 上下限、`kh n>count`）、`kh/kl` 的 `kept+dropped===count`、
负修正、`d100` 省略 count、`faces===1`、非法公式报 `DiceError` 且 `code` 正确；
检定：`roll===1` 为 critical、`target<50` 时 96..100 为 fumble、`target>=50` 时只有 100 是 fumble、
奖励骰取小十位 / 惩罚骰取大十位、十位与个位同为 0 时 `roll===100`；
**确定性**：`makeRng(42)` 连掷两次同 seed 结果一致；`rollFormula("3d6", ()=>0)` 恒为 `3`。

---

## 2. `lib/scenario.js` — 剧本解析与检索（负责人：scenario-author）

纯文本 → 结构化节（section），供宿主注入提示词与提供检索。**不碰文件系统。**

```js
export class ScenarioError extends Error { code }   // code: SOURCE_TOO_LARGE / BAD_SOURCE
export const MAX_SOURCE_CHARS = 400000;
export const MAX_SECTIONS = 400;
export function emptyScenario(): {
  title: "", source: "", sections: [], importedAt: 0
}
export function parseScenario(source, options?): {
  title: string,          // options.title 优先，否则取第一个一级标题，否则 "未命名剧本"
  source: string,         // 原文（超过 MAX_SOURCE_CHARS 抛 ScenarioError("SOURCE_TOO_LARGE")）
  sections: Section[],
  importedAt: number      // options.now ?? Date.now()
}
export function scenarioDigest(scenario, options?): string
export function searchSections(scenario, query, options?): {
  total: number,
  hits: Array<{ id, heading, level, score, snippet, index }>
}
export function readSection(scenario, id): { id, heading, level, body } | null
export function sectionIndex(scenario): Array<{ id, heading, level, chars }>
export function splitLines(source): string[]        // 导出给测试用
```

### `Section` 形状

```js
{ id: "s1", heading: "第一幕 雨夜", level: 1, body: "……", startLine: 12, endLine: 48, chars: 731 }
```
- `id` 按出现顺序 `s1, s2, s3…`（稳定、不随标题变化）。
- `body` **不含标题行本身**，且去掉首尾空行。
- 第一个标题之前的内容（若有实质文字）作为 `level: 0` 的一节，`heading` 为 `"（前言）"`。
- 原文里**一个标题都没有**：整篇作为一节，`heading` 取 `title`，`level` 0。
- 超过 `MAX_SECTIONS` 时截断并追加一节 `heading:"（剧本过长，已截断）"`, `level:0`。

### 标题识别（按行匹配，命中即开新节）

1. Markdown ATX：`/^(#{1,6})\s*(\S.*)$/` → `level = # 的个数`
2. 中文章节：`/^第\s*[0-9一二三四五六七八九十百零〇]+\s*[章节幕回部篇]\s*(.*)$/`
   （`第` 前可有缩进/列表符号 `*`/`-`/`数字.`，需先剥掉；`level` 统一 `2`）
3. 方括号独占一行：`/^【(.+)】\s*$/` → `level = 2`
4. 全下划线/等号underline 行（`^=+$` 或 `^-{3,}$`）**忽略**，不当标题
- 标题文本去掉行首编号与 `**`/`__` 包裹；空标题不计。

### `scenarioDigest(scenario, { maxChars = 1600, perSectionChars = 90 })`

生成给模型看的**目录摘要**，格式固定：

```
【剧本】雨夜钟声（共 12 节）
- s1 第一幕 雨夜：<body 压成单行后取前 90 字>…
- s2 第二幕 钟楼：…
（目录已截断，共 12 节，请用检索获取后续内容）
```

- 每节一行 `- <id> <heading>：<摘要>`；`body` 为空则省略冒号与摘要。
- 累计字符超过 `maxChars` 时停止追加，并补最后那行括号说明（括号行本身要计入）。
- `maxChars < 40` 时至少输出标题行 + 首节。

### `searchSections(scenario, query, { limit = 5, context = 60 })`

- 大小写不敏感的子串检索；`query` 为空或非字符串返回 `{ total: 0, hits: [] }`。
- 命中计分：标题命中权重高于正文（标题 ×3），同一节内多处命中累加但设上限，**不因超长正文刷分**。
- `snippet` 是以第一个命中位置为中心、总长 ≤ `2*context` 的单行片段（换行→空格，两侧加 `…`）。
- `index` 是命中在 `body` 中的字符下标。空 `query` 不返回任何命中。
- 结果按 `score` 降序，`score` 相同按节顺序。

### 单测至少要覆盖

Markdown 多级标题 / 中文章节 / `【】` 三种识别；无标题剧本退化为单节；
前言节；`body` 不含标题行且已 trim；`id` 稳定；超长 source 抛 `SOURCE_TOO_LARGE`；
digest 在 `maxChars` 极小时仍含标题行；检索大小写不敏感、标题权重更高、`limit` 生效、空 query 返回 0；
`readSection` 未知 id 返回 `null`。

---

## 3. `lib/gm.js` — GM 人格：吐槽、语气、指令解析（负责人：gm-author）

**只负责「怎么说」，不负责「怎么判定」**（判定在 `bribe.js` / `commands.js`）。

```js
export const MOODS = ["neutral","pleased","amused","impressed","skeptical","annoyed","ominous","exasperated"];
export function normalizeMood(value): string           // 不在 MOODS 内 → "neutral"
export function moodEmoji(mood): string                // 每个 mood 一个字符，charCode 各不相同
export function speakerFor(mood): string               // "GM"/"KP"/"DM"，固定映射，纯装饰
export function snarkLine(options): string             // 一句吐槽，见下
export function bribeLine(options): string             // 一句「NPC 对报价的反应」旁白，见下
export function styleBrief(options): string            // 注入 system prompt 的语气指令段
export function directiveGuide(): string               // 注入 system prompt 的指令语法说明
export function parseDirectives(text): {
  text: string,                        // 去掉全部 <<…>> 后的干净正文（首尾 trim，内部多余空行压成一个）
  mood: string | null,                 // 最后一个 <<mood X>>，非法值 → null（并计入 ignored）
  moods: string[],                     // 依次出现的合法 mood
  rolls: Array<{ formula: string, dc: number|null, reason: string, raw: string }>,
  bribes: Array<{ verdict: string, price: string, suspicion: number, reason: string, raw: string }>,
  ignored: string[]                    // 无法识别的 <<…>> 原文
}
```

### `snarkLine({ mood, tone, turn, kind, rng, recent })`

- `kind ∈ "any"|"open"|"good"|"bad"|"critical"|"fumble"|"bribe"|"idle"`，默认 `"any"`。
- 输出**一句中文吐槽**，长度 4..40 字，**不含换行**，不重复使用 `recent`（字符串数组，最近用过的句子）
  里的句子；`recent` 覆盖了全部候选时按 `rng` 任选一条。
- `rng` 省略时用固定回退（`Math.random` 也可，但**必须接受注入**）。
- 同一 `(mood,kind)` 候选池 ≥ 6 条；`MOODS × kind` 总量 ≥ 60 条，且**库里不要出现重复句子**。
- `tone`（如 `"恐怖"` / `"轻松"` / `"沙雕"`）影响候选：未知 tone 回落通用池，不得抛错。

### `bribeLine({ verdict, npcName, offer, price, mood, rng, recent })`

- `verdict ∈ "granted"|"haggle"|"refused"|"cold"`；未知值 → `"refused"` 的文案。
- 返回一句**旁白**（GM 视角描述 NPC 的反应），可含 `npcName`；`price` 非空时 `haggle` 的句子要提到它。
- 同样是单行、4..60 字、避开 `recent`。

### `directiveGuide()` / `directive 语法`

模型只能通过 `<<…>>` 让宿主做事，宿主解析后**由宿主掷骰**，模型永远拿不到随机数：

```
<<roll 1d100 dc=55 理由>>      → 宿主掷骰，把结果作为骰子线报插进对话
<<roll 3d6>>                   → dc 可省略
<<mood amused>>                → 切换 GM 表情
<<bribe granted price=一瓶威士忌 suspicion=+1>>  → 贿赂判定
```
- `parseDirectives` 必须容忍**半角/全角**括号混用（`<<`/`>>` 与 `《《》》`）、大小写、多余空格。
- `dc=` 缺省为 `null`；`dc` 非数字 → `null`。`suspicion=+1` / `-1` / `1` 都解析成整数，缺省 0。
- 未知指令进 `ignored`，**绝不能让未知指令留在正文里**（正文里不允许残留 `<<`）。
- 输入非字符串 → 返回 `{ text:"", mood:null, moods:[], rolls:[], bribes:[], ignored:[] }`。

### `styleBrief({ tone, snark, pcName })`

返回给 system prompt 用的一段中文指令，必须体现：
- `snark` 是 0..5 的吐槽浓度，**0 = 完全不吐槽**，5 = 每轮都毒舌；文案要随数值变化（不是只有开关）。
- 要求 GM **拟人**：有情绪、会不耐烦、会记仇，但不代替玩家行动、不替玩家掷骰。
- 要求 GM **先演后判**：叙述要具体（声音/气味/光线），不给玩家递答案。

### 单测至少要覆盖

`MOODS` 全覆盖且 `moodEmoji` 互不相同；`snarkLine` 单行、避开 `recent`、同 seed 可复现、
`snark===0` 时 `styleBrief` 明确禁止吐槽；`parseDirectives` 对四种指令、全角括号、
未知指令进 `ignored`、正文无 `<<` 残留、非字符串输入不抛错。

---

## 4. 宿主半对这三个模块的调用（不可改）

```js
// lib/index.js（Lead 负责）
import { rollFormula, rollCheck, cryptoRng } from "./dice.js";
import { parseScenario, scenarioDigest, searchSections, readSection } from "./scenario.js";
import { parseDirectives, snarkLine, bribeLine, styleBrief, directiveGuide, moodEmoji } from "./gm.js";
```

- 骰子线报的 `meta` 形状：`{ formula, total, rolls, kept, dropped, level?, target?, description? }`。
- 模型回复走 `parseDirectives`；`rolls` 逐个用 `rollFormula`/`rollCheck` 执行后追加为 `role:"dice"` 线报。
- `mood` 非空时写进 `campaign.scene.mood`。
