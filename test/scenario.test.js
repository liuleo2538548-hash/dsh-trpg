/**
 * dsh-trpg — lib/scenario.js 单测。
 *
 * 运行（Node 24 的 --test 不接受目录，必须显式给文件名）：
 *   node --test test/scenario.test.js
 *
 * 覆盖 CONTRACT.md 第 2 节「单测至少要覆盖」的全部条目，另加边界与容错。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SECTIONS,
  MAX_SOURCE_CHARS,
  ScenarioError,
  emptyScenario,
  parseScenario,
  readSection,
  scenarioDigest,
  searchSections,
  sectionIndex,
  splitLines,
} from "../lib/scenario.js";

/* ------------------------------------------------------------ 基础形状 */

test("导出常量与 emptyScenario 形状固定", () => {
  assert.equal(MAX_SOURCE_CHARS, 400000);
  assert.equal(MAX_SECTIONS, 400);
  assert.deepEqual(emptyScenario(), { title: "", source: "", sections: [], importedAt: 0 });
});

test("ScenarioError 是 Error 子类且带 code", () => {
  const error = new ScenarioError("BAD_SOURCE", "坏输入");
  assert.ok(error instanceof Error);
  assert.equal(error.name, "ScenarioError");
  assert.equal(error.code, "BAD_SOURCE");
  assert.equal(error.message, "坏输入");
});

test("splitLines 归一 CRLF / CR，非字符串返回空数组", () => {
  assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
  assert.deepEqual(splitLines("a\r\nb\rc"), ["a", "b", "c"]);
  assert.deepEqual(splitLines("a\n"), ["a", ""]);
  assert.deepEqual(splitLines(42), []);
});

/* ------------------------------------------------------------ 标题识别 */

test("标题识别：Markdown ATX 多级标题", () => {
  const scenario = parseScenario("# 一级\n正文一\n## 二级\n正文二\n###### 六级\n正文六");
  assert.equal(scenario.title, "一级");
  assert.deepEqual(
    scenario.sections.map((section) => [section.id, section.heading, section.level]),
    [
      ["s1", "一级", 1],
      ["s2", "二级", 2],
      ["s3", "六级", 6],
    ],
  );
  assert.equal(scenario.sections[0].body, "正文一");
});

test("标题识别：ATX 标题去掉行首编号与 ** / __ 包裹", () => {
  const scenario = parseScenario("### **第一章**\n正文\n## 1. 引言\n正文");
  assert.deepEqual(
    scenario.sections.map((section) => [section.heading, section.level]),
    [
      ["第一章", 3],
      ["引言", 2],
    ],
  );
});

test("标题识别：中文章节（缩进 / 星号 / 短横线 / 数字列表符号）", () => {
  const scenario = parseScenario(
    "第一章 雨夜\n雨声。\n  - 第二节 钟楼\n钟声。\n* 第三幕 终局\n结束。\n1. 第四回 尾声\n完。",
  );
  assert.deepEqual(
    scenario.sections.map((section) => [section.heading, section.level]),
    [
      ["雨夜", 2],
      ["钟楼", 2],
      ["终局", 2],
      ["尾声", 2],
    ],
  );
});

test("标题识别：`第 N 章` 但无标题文本时不算标题（空标题不计）", () => {
  const scenario = parseScenario("第三章\n正文");
  assert.equal(scenario.title, "未命名剧本");
  assert.equal(scenario.sections.length, 1);
  assert.equal(scenario.sections[0].level, 0);
  assert.equal(scenario.sections[0].heading, "未命名剧本");
  assert.ok(scenario.sections[0].body.includes("第三章"));
});

test("标题识别：【…】独占一行；不独占一行不算标题", () => {
  const scenario = parseScenario("【开场】\n灯光亮起。\n【终幕】\n落幕。");
  assert.deepEqual(
    scenario.sections.map((section) => [section.heading, section.level]),
    [
      ["开场", 2],
      ["终幕", 2],
    ],
  );
  assert.equal(parseScenario("【开场】还有别的字\n正文").sections.length, 1);
  assert.equal(parseScenario("indent 【开场】\n正文").sections.length, 1);
});

test("下划线分隔行（=== / -----）不是标题", () => {
  const scenario = parseScenario("标题行\n===\n正文\n-----\n更多正文");
  assert.equal(scenario.sections.length, 1);
  assert.equal(scenario.sections[0].level, 0);
  assert.ok(scenario.sections[0].body.includes("==="));
  assert.ok(scenario.sections[0].body.includes("-----"));
});

/* -------------------------------------------------------------- 切分规则 */

test("无标题剧本退化为单节，heading 取 title", () => {
  const scenario = parseScenario("只有正文。\n第二行。");
  assert.equal(scenario.sections.length, 1);
  const [only] = scenario.sections;
  assert.equal(only.id, "s1");
  assert.equal(only.heading, "未命名剧本");
  assert.equal(only.level, 0);
  assert.equal(only.body, "只有正文。\n第二行。");
  assert.equal(only.chars, only.body.length);
  assert.equal(only.startLine, 1);
  assert.equal(only.endLine, 2);
  // options.title 决定退化节的 heading
  assert.equal(parseScenario("只有正文。", { title: "自定义" }).sections[0].heading, "自定义");
});

test("第一个标题前的实质文字成为 level 0 的「（前言）」节", () => {
  const scenario = parseScenario("开场白第一行。\n开场白第二行。\n\n# 第一幕\n正文");
  assert.deepEqual(
    scenario.sections.map((section) => [section.id, section.heading, section.level]),
    [
      ["s1", "（前言）", 0],
      ["s2", "第一幕", 1],
    ],
  );
  assert.equal(scenario.sections[0].body, "开场白第一行。\n开场白第二行。");
  assert.equal(scenario.sections[0].startLine, 1);
  assert.equal(scenario.sections[0].endLine, 2);
  assert.equal(scenario.sections[1].startLine, 4);
  assert.equal(scenario.sections[1].endLine, 5);
});

test("第一个标题前只有空行时不产生前言节", () => {
  const scenario = parseScenario("\n\n# 第一幕\n正文");
  assert.deepEqual(scenario.sections.map((section) => section.id), ["s1"]);
  assert.equal(scenario.sections[0].heading, "第一幕");
});

test("body 不含标题行本身且已 trim", () => {
  const scenario = parseScenario("# 标题\n\n   正文第一行  \n\n\n# 下一节\n");
  assert.equal(scenario.sections[0].body, "正文第一行");
  assert.ok(!scenario.sections[0].body.includes("#"));
  assert.ok(!scenario.sections[1].body.includes("#"));
  assert.equal(scenario.sections[1].body, "");
  assert.equal(scenario.sections[0].startLine, 1);
  assert.equal(scenario.sections[0].endLine, 3);
});

test("id 稳定为 s1,s2,…，与标题内容无关", () => {
  const text = "# 甲\n内容\n## 乙\n内容\n【丙】\n内容";
  const first = parseScenario(text);
  const second = parseScenario(text);
  assert.deepEqual(first.sections.map((section) => section.id), ["s1", "s2", "s3"]);
  assert.deepEqual(
    first.sections.map((section) => section.id),
    second.sections.map((section) => section.id),
  );
});

test("title 优先级：options.title > 第一个一级标题 > 未命名剧本", () => {
  assert.equal(parseScenario("# 甲\n# 乙").title, "甲");
  assert.equal(parseScenario("## 二级\n# 一级").title, "一级");
  assert.equal(parseScenario("正文").title, "未命名剧本");
  assert.equal(parseScenario("# 甲", { title: "自定义" }).title, "自定义");
  assert.equal(parseScenario("# 甲", { title: "   " }).title, "甲");
});

test("importedAt 取 options.now（0 也算数），否则取当前时间", () => {
  assert.equal(parseScenario("# 标题", { now: 42 }).importedAt, 42);
  assert.equal(parseScenario("# 标题", { now: 0 }).importedAt, 0);
  const now = parseScenario("# 标题").importedAt;
  assert.equal(typeof now, "number");
  assert.ok(now > 0);
});

/* ---------------------------------------------------------------- 边界 */

test("非字符串原文抛 ScenarioError(BAD_SOURCE)", () => {
  for (const bad of [null, undefined, 42, {}, []]) {
    assert.throws(
      () => parseScenario(bad),
      (error) => error instanceof ScenarioError && error.code === "BAD_SOURCE",
      `输入 ${JSON.stringify(bad)} 应抛 BAD_SOURCE`,
    );
  }
});

test("超长原文抛 ScenarioError(SOURCE_TOO_LARGE)，恰好到上限仍合法", () => {
  assert.throws(
    () => parseScenario("a".repeat(MAX_SOURCE_CHARS + 1)),
    (error) => error instanceof ScenarioError && error.code === "SOURCE_TOO_LARGE",
  );
  const atLimit = parseScenario("a".repeat(MAX_SOURCE_CHARS));
  assert.equal(atLimit.source.length, MAX_SOURCE_CHARS);
  assert.equal(atLimit.sections.length, 1);
});

test("超过 MAX_SECTIONS 时截断并追加占位节", () => {
  const lines = [];
  for (let index = 1; index <= MAX_SECTIONS + 5; index += 1) {
    lines.push(`# 标题${index}`, `正文${index}`);
  }
  const scenario = parseScenario(lines.join("\n"));
  assert.equal(scenario.sections.length, MAX_SECTIONS + 1);
  const last = scenario.sections[MAX_SECTIONS];
  assert.equal(last.id, `s${MAX_SECTIONS + 1}`);
  assert.equal(last.heading, "（剧本过长，已截断）");
  assert.equal(last.level, 0);
  assert.equal(last.body, "");
  assert.equal(scenario.sections[0].heading, "标题1");
  assert.equal(scenario.sections[MAX_SECTIONS - 1].heading, `标题${MAX_SECTIONS}`);
});

test("空原文与纯空白原文没有节", () => {
  assert.deepEqual(parseScenario("").sections, []);
  assert.deepEqual(parseScenario("   \n\n  ").sections, []);
});

/* --------------------------------------------------------------- digest */

test("scenarioDigest 格式逐字符固定（标题行 + 每节一行）", () => {
  const scenario = parseScenario("# 第一幕\n雨夜的钟声响起。\n# 第二幕\n钟楼。", {
    title: "雨夜钟声",
    now: 123,
  });
  assert.equal(
    scenarioDigest(scenario),
    [
      "【剧本】雨夜钟声（共 2 节）",
      "- s1 第一幕：雨夜的钟声响起。",
      "- s2 第二幕：钟楼。",
    ].join("\n"),
  );
});

test("scenarioDigest：body 为空则省略冒号与摘要；空剧本只有标题行", () => {
  const scenario = parseScenario("## 甲\n## 乙\n有正文");
  assert.equal(
    scenarioDigest(scenario),
    ["【剧本】未命名剧本（共 2 节）", "- s1 甲", "- s2 乙：有正文"].join("\n"),
  );
  assert.equal(scenarioDigest(emptyScenario()), "【剧本】未命名剧本（共 0 节）");
});

test("scenarioDigest：maxChars 极小时仍含标题行与首节", () => {
  const scenario = parseScenario("# 第一幕\n雨夜的钟声响起。\n# 第二幕\n钟楼。", {
    title: "雨夜钟声",
  });
  const tiny = scenarioDigest(scenario, { maxChars: 4 });
  assert.ok(tiny.startsWith("【剧本】雨夜钟声（共 2 节）"));
  assert.ok(tiny.includes("- s1 第一幕：雨夜的钟声响起。"));
  assert.ok(tiny.includes("（目录已截断，共 2 节，请用检索获取后续内容）"));

  const zero = scenarioDigest(scenario, { maxChars: 0 });
  assert.ok(zero.includes("- s1 "));
});

test("scenarioDigest：括号说明行计入 maxChars", () => {
  const scenario = parseScenario("# 第一幕\n雨夜的钟声响起。\n# 第二幕\n钟楼。", {
    title: "雨夜钟声",
  });
  const headerLine = "【剧本】雨夜钟声（共 2 节）";
  const bullet1 = "- s1 第一幕：雨夜的钟声响起。";
  const bullet2 = "- s2 第二幕：钟楼。";
  const tailLine = "（目录已截断，共 2 节，请用检索获取后续内容）";
  const needForTwo = headerLine.length + 1 + bullet1.length + 1 + bullet2.length;

  // 恰好留不出括号行的位置 → 截断，最终长度仍受 maxChars 约束
  const tight = scenarioDigest(scenario, { maxChars: needForTwo + tailLine.length });
  assert.equal(tight, [headerLine, bullet1, tailLine].join("\n"));
  assert.ok(tight.length <= needForTwo + tailLine.length);

  // 预算够放下两节 + 括号行 → 不截断
  const roomy = scenarioDigest(scenario, { maxChars: needForTwo + 1 + tailLine.length });
  assert.equal(roomy, [headerLine, bullet1, bullet2].join("\n"));
  assert.ok(!roomy.includes("目录已截断"));
});

test("scenarioDigest：perSectionChars 生效，超长摘要加省略号", () => {
  const scenario = parseScenario(`# 标题\n${"字".repeat(200)}`);
  assert.equal(
    scenarioDigest(scenario, { perSectionChars: 10 }),
    ["【剧本】标题（共 1 节）", `- s1 标题：${"字".repeat(10)}…`].join("\n"),
  );
  const short = parseScenario("# 标题\n短正文");
  assert.equal(
    scenarioDigest(short, { perSectionChars: 90 }),
    ["【剧本】标题（共 1 节）", "- s1 标题：短正文"].join("\n"),
  );
});

/* --------------------------------------------------------------- 检索 */

test("searchSections 大小写不敏感（标题与正文都算）", () => {
  const scenario = parseScenario("# Gate OPEN\nHello World\n# 别的\nnothing");
  assert.equal(searchSections(scenario, "hello").total, 1);
  assert.equal(searchSections(scenario, "HELLO").hits[0].id, "s1");
  assert.equal(searchSections(scenario, "gate").hits[0].id, "s1");
  assert.equal(searchSections(scenario, "  hello  ").hits[0].id, "s1");
});

test("searchSections 标题命中权重高于正文，超长正文刷不了分", () => {
  const scenario = parseScenario("# 钟楼\n与案子无关的正文。\n# 无关标题\n" + "钟楼".repeat(6));
  const result = searchSections(scenario, "钟楼");
  assert.equal(result.total, 2);
  assert.equal(result.hits[0].id, "s1");
  assert.ok(
    result.hits[0].score > result.hits[1].score,
    `标题命中 ${result.hits[0].score} 应高于正文命中 ${result.hits[1].score}`,
  );

  // 同一节正文里命中 200 次也不该压过别处的标题命中
  const spam = parseScenario("# 目标\n无关。\n# 噪声\n" + "目标".repeat(200));
  const ranked = searchSections(spam, "目标");
  assert.equal(ranked.hits[0].id, "s1");
});

test("searchSections limit 生效，total 仍是命中节总数", () => {
  const lines = [];
  for (let index = 1; index <= 8; index += 1) lines.push(`# 命中${index}`, `正文${index}`);
  const scenario = parseScenario(lines.join("\n"));
  const result = searchSections(scenario, "命中", { limit: 3 });
  assert.equal(result.total, 8);
  assert.equal(result.hits.length, 3);
  assert.deepEqual(result.hits.map((hit) => hit.id), ["s1", "s2", "s3"]);
  assert.deepEqual(searchSections(scenario, "命中", { limit: 0 }).hits, []);
  assert.equal(searchSections(scenario, "命中", { limit: 100 }).hits.length, 8);
});

test("searchSections 空 query / 非字符串 query 返回 {total:0,hits:[]}", () => {
  const scenario = parseScenario("# 标题\n正文");
  for (const query of ["", "   ", "\n", null, undefined, 42, {}]) {
    assert.deepEqual(searchSections(scenario, query), { total: 0, hits: [] });
  }
  assert.deepEqual(searchSections(emptyScenario(), "正文"), { total: 0, hits: [] });
});

test("searchSections 同分按节顺序", () => {
  const scenario = parseScenario("# 甲\n共有词\n# 乙\n共有词\n# 丙\n共有词");
  const result = searchSections(scenario, "共有词", { limit: 2 });
  assert.equal(result.total, 3);
  assert.deepEqual(result.hits.map((hit) => hit.id), ["s1", "s2"]);
});

test("searchSections 命中片段是单行、含 query、index 指向 body", () => {
  const body = "第一行\n第二行含目标词\n第三行";
  const scenario = parseScenario(`# 标题\n${body}`);
  const result = searchSections(scenario, "目标词", { context: 60 });
  assert.equal(result.total, 1);
  const [hit] = result.hits;
  assert.equal(hit.id, "s1");
  assert.equal(hit.index, body.indexOf("目标词"));
  assert.ok(!hit.snippet.includes("\n"), "片段必须是单行");
  assert.ok(hit.snippet.includes("目标词"));
  assert.ok(hit.snippet.startsWith("…") && hit.snippet.endsWith("…"));
  assert.ok(hit.snippet.length <= 120);

  // 只有标题命中时 index 为 -1，片段仍来自正文
  const headingOnly = searchSections(scenario, "标题");
  assert.equal(headingOnly.hits[0].index, -1);
  assert.ok(!headingOnly.hits[0].snippet.includes("\n"));
});

/* ---------------------------------------------------------- 读节与索引 */

test("readSection 未知 id 返回 null，已知 id 返回规定形状", () => {
  const scenario = parseScenario("# 甲\nAAA\n# 乙\nBBB");
  assert.deepEqual(readSection(scenario, "s1"), { id: "s1", heading: "甲", level: 1, body: "AAA" });
  assert.equal(readSection(scenario, "s2").body, "BBB");
  assert.equal(readSection(scenario, "s9"), null);
  assert.equal(readSection(scenario, "S1"), null);
  assert.equal(readSection(scenario, ""), null);
  assert.equal(readSection(scenario, null), null);
  assert.equal(readSection(emptyScenario(), "s1"), null);
  assert.equal(readSection(null, "s1"), null);
});

test("sectionIndex 只给索引字段且 chars 与 body 长度一致", () => {
  const scenario = parseScenario("# 甲\nAAA\n# 乙\nBBBB");
  assert.deepEqual(sectionIndex(scenario), [
    { id: "s1", heading: "甲", level: 1, chars: 3 },
    { id: "s2", heading: "乙", level: 1, chars: 4 },
  ]);
  assert.deepEqual(sectionIndex(null), []);
  assert.deepEqual(sectionIndex(emptyScenario()), []);
});
