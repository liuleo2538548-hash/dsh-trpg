/**
 * dsh-trpg — lib/gm.js 单测。
 *
 * 覆盖 CONTRACT.md 第 3 节「单测至少要覆盖」的全部条目，另外加两条库完整性断言：
 *   1) 全库句子互不重复、总量 ≥ 60 —— 直接扫 lib/gm.js 源码里被标记包围的吐槽库字面量
 *      （库表不对外导出，宿主只该看到 snarkLine/bribeLine 的行为）；
 *   2) 每个 (mood,kind) 的候选池 ≥ 6 —— 行为验证：借 recent 去重连续取 6 条必须互不相同，
 *      池子不够大就会被迫吃回头草，断言随即失败。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MOODS,
  normalizeMood,
  moodEmoji,
  speakerFor,
  snarkLine,
  bribeLine,
  styleBrief,
  directiveGuide,
  parseDirectives,
} from "../lib/gm.js";

const KINDS = ["any", "open", "good", "bad", "critical", "fumble", "bribe", "idle"];
const TONES = ["恐怖", "轻松", "沙雕", "硬核"];
const SOURCE = readFileSync(new URL("../lib/gm.js", import.meta.url), "utf8");

/* --------------------------------------------------------------- 测试工具 */

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 按 i/n 造一个每次都能挑到不同下标的 rng；配合 recent 就能枚举候选池。 */
function steppingRng(count) {
  return (i) => () => i / count + 0.001;
}

function sampleSnark(options, count) {
  const recent = [];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const line = snarkLine({ ...options, rng: steppingRng(count)(i), recent });
    recent.push(line);
    out.push(line);
  }
  return out;
}

function sampleBribe(options, count) {
  const recent = [];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const line = bribeLine({ ...options, rng: steppingRng(count)(i), recent });
    recent.push(line);
    out.push(line);
  }
  return out;
}

function sliceBetween(startMarker, endMarker) {
  const start = SOURCE.indexOf(startMarker);
  const end = SOURCE.indexOf(endMarker);
  assert.ok(start >= 0 && end > start, `源码里找不到标记 ${startMarker}`);
  return SOURCE.slice(start, end);
}

/** 抽出「独占一行的字符串字面量」。 */
function literalLines(region) {
  const out = [];
  const re = /^[ \t]*"([^"\n]+)"[ \t]*,?[ \t]*$/gm;
  let match = re.exec(region);
  while (match) {
    out.push(match[1]);
    match = re.exec(region);
  }
  return out;
}

const SNARK_LIB = literalLines(sliceBetween("==== 吐槽库开始 ====", "==== 吐槽库结束 ===="));
const BRIBE_LIB = literalLines(sliceBetween("==== 贿赂旁白开始 ====", "==== 贿赂旁白结束 ===="));

function assertSingleLine(line) {
  assert.equal(typeof line, "string");
  assert.ok(line.length > 0, "不能是空串");
  assert.ok(!line.includes("\n") && !line.includes("\r"), `必须是单行：${line}`);
}

/* --------------------------------------------------------------- 情绪基础件 */

test("MOODS 就是契约里的八种情绪，顺序一致", () => {
  assert.deepEqual(MOODS, [
    "neutral",
    "pleased",
    "amused",
    "impressed",
    "skeptical",
    "annoyed",
    "ominous",
    "exasperated",
  ]);
});

test("normalizeMood：MOODS 全覆盖，其余一律回落 neutral 且不抛错", () => {
  for (const mood of MOODS) assert.equal(normalizeMood(mood), mood);
  assert.equal(normalizeMood("AMUSED"), "amused");
  assert.equal(normalizeMood("  Amused  "), "amused");
  assert.equal(normalizeMood("暴躁"), "neutral");
  assert.equal(normalizeMood(""), "neutral");
  assert.equal(normalizeMood(undefined), "neutral");
  assert.equal(normalizeMood(null), "neutral");
  assert.equal(normalizeMood(42), "neutral");
  assert.equal(normalizeMood({}), "neutral");
});

test("moodEmoji：每个 mood 都有字符且彼此不同", () => {
  const emojis = MOODS.map((mood) => moodEmoji(mood));
  for (const emoji of emojis) {
    assert.equal(typeof emoji, "string");
    assert.ok(emoji.length >= 1, "每个 mood 至少要有一个字符");
  }
  assert.equal(new Set(emojis).size, MOODS.length, "emoji 必须两两不同");
  // 注意：emoji 是代理对，charCodeAt(0) 会撞（😊 与 😏 的高位都是 0xD83D），必须比码点。
  assert.equal(
    new Set(emojis.map((e) => [...e][0].codePointAt(0))).size,
    MOODS.length,
    "首个码点必须两两不同",
  );
  // 未知 mood 回落 neutral 的字符
  assert.equal(moodEmoji("不存在"), moodEmoji("neutral"));
  assert.equal(moodEmoji(undefined), moodEmoji("neutral"));
});

test("speakerFor：MOODS 全覆盖，取值只在 GM/KP/DM 里", () => {
  for (const mood of MOODS) {
    assert.ok(["GM", "KP", "DM"].includes(speakerFor(mood)), `${mood} → ${speakerFor(mood)}`);
  }
  assert.equal(speakerFor("不存在"), "GM");
  assert.equal(speakerFor(undefined), "GM");
});

/* --------------------------------------------------------------- 吐槽库完整性 */

test("吐槽库：总量 ≥ 60、句子互不重复、每条 4..40 字单行", () => {
  assert.ok(SNARK_LIB.length >= 60, `吐槽库只有 ${SNARK_LIB.length} 条`);
  assert.equal(new Set(SNARK_LIB).size, SNARK_LIB.length, "吐槽库里出现了重复句子");
  for (const line of SNARK_LIB) {
    assertSingleLine(line);
    const size = [...line].length;
    assert.ok(size >= 4 && size <= 40, `长度 ${size} 越界：${line}`);
  }
});

test("贿赂旁白库：条数够用、互不重复、每条 4..60 字", () => {
  assert.ok(BRIBE_LIB.length >= 24, `贿赂旁白只有 ${BRIBE_LIB.length} 条`);
  assert.equal(new Set(BRIBE_LIB).size, BRIBE_LIB.length, "贿赂旁白库里出现了重复句子");
  for (const line of BRIBE_LIB) {
    assertSingleLine(line);
    const size = [...line].length;
    assert.ok(size >= 4 && size <= 60, `长度 ${size} 越界：${line}`);
  }
  // 两个库之间也不许撞句子
  const all = [...SNARK_LIB, ...BRIBE_LIB];
  assert.equal(new Set(all).size, all.length, "吐槽库与旁白库之间有重复句子");
});

test("每个 (mood,kind) 的候选池都 ≥ 6：连取 6 条必须互不相同", () => {
  for (const mood of MOODS) {
    for (const kind of KINDS) {
      const lines = sampleSnark({ mood, kind }, 6);
      assert.equal(new Set(lines).size, 6, `(${mood},${kind}) 候选不足 6 条`);
    }
  }
});

/* --------------------------------------------------------------- snarkLine */

test("snarkLine：单行、4..40 字，覆盖全部 mood / kind / tone", () => {
  for (const mood of MOODS) {
    for (const kind of KINDS) {
      for (const tone of [...TONES, "未知基调", undefined]) {
        for (const rng of [() => 0, () => 0.5, () => 0.999999, makeRng(7)]) {
          const line = snarkLine({ mood, kind, tone, rng });
          assertSingleLine(line);
          const size = [...line].length;
          assert.ok(size >= 4 && size <= 40, `长度 ${size} 越界：${line}`);
        }
      }
    }
  }
});

test("snarkLine：注入 rng 可复现，同一 seed 两次一致", () => {
  const first = snarkLine({ mood: "amused", kind: "fumble", rng: makeRng(42) });
  const second = snarkLine({ mood: "amused", kind: "fumble", rng: makeRng(42) });
  assert.equal(first, second);
  const other = snarkLine({ mood: "amused", kind: "fumble", rng: makeRng(43) });
  assert.equal(typeof other, "string");
  // rng 真的参与了挑选：池子 >1，0 与 ~1 必须挑到不同句子
  assert.notEqual(
    snarkLine({ mood: "neutral", kind: "any", rng: () => 0 }),
    snarkLine({ mood: "neutral", kind: "any", rng: () => 0.999 }),
  );
});

test("snarkLine：避开 recent；recent 吃掉整池时仍返回合法句子且不抛错", () => {
  const used = snarkLine({ mood: "impressed", kind: "good", rng: () => 0 });
  const next = snarkLine({ mood: "impressed", kind: "good", rng: () => 0, recent: [used] });
  assert.notEqual(next, used);

  const wholePool = sampleSnark({ mood: "neutral", kind: "any" }, 12);
  const overflow = snarkLine({ mood: "neutral", kind: "any", rng: () => 0.4, recent: wholePool });
  assert.ok(wholePool.includes(overflow), "整池被 recent 覆盖时只能按 rng 任选");

  // recent 传垃圾也不能崩
  assertSingleLine(snarkLine({ mood: "annoyed", kind: "idle", recent: "不是数组" }));
  assertSingleLine(snarkLine({ mood: "annoyed", kind: "idle", recent: [1, null, {}, "真句子"] }));
});

test("snarkLine：tone 影响候选池，未知 tone 回落通用池且不抛错", () => {
  const withTone = snarkLine({ mood: "neutral", kind: "open", tone: "沙雕", rng: () => 0 });
  const withoutTone = snarkLine({ mood: "neutral", kind: "open", tone: "火星语", rng: () => 0 });
  assertSingleLine(withTone);
  assertSingleLine(withoutTone);
  assert.notEqual(withTone, withoutTone, "基调应当改变候选池");
  for (const tone of TONES) {
    assertSingleLine(snarkLine({ mood: "ominous", kind: "critical", tone, rng: () => 0.3 }));
  }
});

test("snarkLine：非法 kind / mood / 非对象入参都不抛错", () => {
  assertSingleLine(snarkLine({ mood: 42, kind: "没有这种时刻" }));
  assertSingleLine(snarkLine({ mood: null, kind: null, tone: null, rng: null, recent: null }));
  assertSingleLine(snarkLine());
  assertSingleLine(snarkLine(null));
  assertSingleLine(snarkLine("不是对象"));
  assert.equal(snarkLine({ kind: "没有这种时刻", rng: () => 0 }), snarkLine({ kind: "any", rng: () => 0 }));
  // 会抛错的 rng 也不能把模块带崩
  assertSingleLine(snarkLine({ mood: "neutral", rng: () => { throw new Error("坏 rng"); } }));
});

/* --------------------------------------------------------------- bribeLine */

test("bribeLine：四种 verdict 都产出 4..60 字的单行旁白", () => {
  for (const verdict of ["granted", "haggle", "refused", "cold"]) {
    const line = bribeLine({ verdict, npcName: "老王", price: "一瓶威士忌", rng: () => 0 });
    assertSingleLine(line);
    const size = [...line].length;
    assert.ok(size >= 4 && size <= 60, `长度 ${size} 越界：${line}`);
    assert.ok(!line.includes("{"), `占位符没填干净：${line}`);
  }
});

test("bribeLine：未知 verdict 按 refused 处理", () => {
  assert.equal(
    bribeLine({ verdict: "maybe", rng: () => 0, npcName: "老王" }),
    bribeLine({ verdict: "refused", rng: () => 0, npcName: "老王" }),
  );
  assert.equal(
    bribeLine({ verdict: undefined, rng: () => 0.7 }),
    bribeLine({ verdict: "refused", rng: () => 0.7 }),
  );
  assert.equal(
    bribeLine({ verdict: "GRANTED", rng: () => 0, npcName: "老王" }),
    bribeLine({ verdict: "granted", rng: () => 0, npcName: "老王" }),
  );
});

test("bribeLine：haggle 且 price 非空时，句子必须提到 price", () => {
  const price = "一瓶威士忌";
  const lines = sampleBribe({ verdict: "haggle", price, npcName: "老王" }, 6);
  assert.equal(new Set(lines).size, 6);
  for (const line of lines) {
    assert.ok(line.includes(price), `haggle 句子没提到价格：${line}`);
    assertSingleLine(line);
  }
  // price 缺省时也不能残留占位符
  const plain = bribeLine({ verdict: "haggle", npcName: "老王", rng: () => 0 });
  assertSingleLine(plain);
  assert.ok(!plain.includes("{"));
});

test("bribeLine：可含 npcName，且避开 recent", () => {
  const line = bribeLine({ verdict: "granted", npcName: "老王", rng: () => 0 });
  assert.ok(line.includes("老王"), `旁白应当提到 NPC：${line}`);
  const next = bribeLine({ verdict: "granted", npcName: "老王", rng: () => 0, recent: [line] });
  assert.notEqual(next, line);
  // 无 npcName 时回落到泛称，不能崩
  assertSingleLine(bribeLine({ verdict: "cold" }));
  assertSingleLine(bribeLine({ rng: () => { throw new Error("坏 rng"); } }));
  assert.equal(
    bribeLine({ verdict: "cold", rng: () => 0, recent: "不是数组" }),
    bribeLine({ verdict: "cold", rng: () => 0 }),
  );
});

test("bribeLine：注入 rng 可复现", () => {
  const a = bribeLine({ verdict: "cold", rng: makeRng(11) });
  const b = bribeLine({ verdict: "cold", rng: makeRng(11) });
  assert.equal(a, b);
});

/* --------------------------------------------------------------- styleBrief */

test("styleBrief：snark 0 明确禁止吐槽，5 是毒舌，六个档位文案各不相同", () => {
  const briefs = [0, 1, 2, 3, 4, 5].map((snark) => styleBrief({ snark }));
  for (const brief of briefs) assert.ok(typeof brief === "string" && brief.length > 0);
  assert.equal(new Set(briefs).size, 6, "snark 每一档的文案都该不一样");
  assert.match(briefs[0], /完全不吐槽|禁止吐槽/, "snark=0 必须明确禁止吐槽");
  assert.match(briefs[5], /毒舌/, "snark=5 必须是毒舌档");
  assert.ok(briefs[0].includes("0/5") && briefs[5].includes("5/5"));
  assert.ok(!/毒舌/.test(briefs[0]), "0 档不能同时出现毒舌要求");
});

test("styleBrief：拟人 / 边界 / 先演后判都要写进去", () => {
  const brief = styleBrief({ tone: "恐怖", snark: 4, pcName: "林晚" });
  assert.ok(brief.includes("不代替玩家行动"), "必须写明不代替玩家行动");
  assert.ok(brief.includes("不代替玩家掷骰"), "必须写明不替玩家掷骰");
  assert.ok(brief.includes("声音") && brief.includes("气味"), "要求具体感官叙述");
  assert.ok(brief.includes("有情绪") || brief.includes("会不耐烦"), "要求拟人");
  assert.ok(brief.includes("恐怖"), "tone 要注入");
  assert.ok(brief.includes("林晚"), "pcName 要注入");
  assert.ok(brief.includes("4/5"), "浓度要注入");
  assert.ok(!brief.includes("<<"), "语气指令段不该夹带 <<…>> 指令");
});

test("styleBrief：snark 越界与非法值都收敛，不抛错", () => {
  assert.equal(styleBrief({ snark: 9 }), styleBrief({ snark: 5 }));
  assert.equal(styleBrief({ snark: -3 }), styleBrief({ snark: 0 }));
  assert.equal(styleBrief({ snark: 3.4 }), styleBrief({ snark: 3 }));
  assert.equal(styleBrief({ snark: "4" }), styleBrief({ snark: 4 }));
  assert.equal(styleBrief({}), styleBrief({ snark: 3 }), "缺省应为 3");
  assert.equal(styleBrief({ snark: null }), styleBrief({ snark: 3 }), "null 不能算 0");
  assert.equal(styleBrief({ snark: "" }), styleBrief({ snark: 3 }));
  assert.equal(styleBrief({ snark: "很多" }), styleBrief({ snark: 3 }));
  assert.equal(styleBrief(null), styleBrief({}));
  assert.equal(styleBrief("不是对象"), styleBrief({}));
});

test("styleBrief：未知 tone 回落通用基调且不抛错", () => {
  const brief = styleBrief({ tone: "蒸汽朋克", snark: 2 });
  assert.ok(typeof brief === "string" && brief.length > 0);
  assert.ok(brief.includes("基调"));
  assert.ok(!brief.includes("蒸汽朋克") || brief.includes("基调未指定"));
  assert.equal(styleBrief({ tone: undefined }), styleBrief({ tone: "" }));
});

/* --------------------------------------------------------------- directiveGuide */

test("directiveGuide：三种指令语法与全角说明都在", () => {
  const guide = directiveGuide();
  assert.ok(typeof guide === "string" && guide.length > 0);
  assert.ok(guide.includes("<<roll") && guide.includes("dc="));
  assert.ok(guide.includes("<<mood"));
  assert.ok(guide.includes("<<bribe"));
  for (const mood of MOODS) assert.ok(guide.includes(mood), `说明里该列出 mood：${mood}`);
  assert.ok(guide.includes("《《"), "要说明全角括号也认");
});

/* --------------------------------------------------------------- parseDirectives */

test("parseDirectives：<<roll …>> 含可选 dc、理由与 raw", () => {
  const withDc = parseDirectives("我掷一下。\n<<roll 1d100 dc=55 试探门后有什么>>");
  assert.equal(withDc.rolls.length, 1);
  assert.deepEqual(withDc.rolls[0], {
    formula: "1d100",
    dc: 55,
    reason: "试探门后有什么",
    raw: "<<roll 1d100 dc=55 试探门后有什么>>",
  });
  assert.equal(withDc.text, "我掷一下。");

  const withoutDc = parseDirectives("<<roll 3d6>>");
  assert.deepEqual(withoutDc.rolls[0], { formula: "3d6", dc: null, reason: "", raw: "<<roll 3d6>>" });
  assert.equal(withoutDc.text, "");

  const weirdDc = parseDirectives("<<roll 1d100 dc=abc 看看>>");
  assert.equal(weirdDc.rolls[0].dc, null);
  assert.equal(weirdDc.rolls[0].reason, "看看");

  const upperCase = parseDirectives("<<ROLL 1D100 DC=55>>");
  assert.equal(upperCase.rolls[0].formula, "1D100");
  assert.equal(upperCase.rolls[0].dc, 55);

  const noFormula = parseDirectives("<<roll>>");
  assert.equal(noFormula.rolls.length, 0);
  assert.deepEqual(noFormula.ignored, ["<<roll>>"]);
});

test("parseDirectives：<<mood …>> 取最后一个合法值，非法值归 null 并进 ignored", () => {
  const one = parseDirectives("<<mood amused>>");
  assert.equal(one.mood, "amused");
  assert.deepEqual(one.moods, ["amused"]);

  const many = parseDirectives("<<mood amused>>\n<<mood OMINOUS>>");
  assert.equal(many.mood, "ominous");
  assert.deepEqual(many.moods, ["amused", "ominous"]);

  const bad = parseDirectives("<<mood amused>><<mood 暴躁>>");
  assert.equal(bad.mood, null, "最后一个 mood 非法 → null");
  assert.deepEqual(bad.moods, ["amused"]);
  assert.equal(bad.ignored.length, 1);
  assert.ok(bad.ignored[0].includes("暴躁"));

  const missing = parseDirectives("<<mood>>");
  assert.equal(missing.mood, null);
  assert.deepEqual(missing.moods, []);
  assert.deepEqual(missing.ignored, ["<<mood>>"]);
});

test("parseDirectives：<<bribe …>> 解析 price / suspicion / verdict", () => {
  const full = parseDirectives("<<bribe granted price=一瓶威士忌 suspicion=+1 顺手问一句>>");
  assert.equal(full.bribes.length, 1);
  assert.deepEqual(full.bribes[0], {
    verdict: "granted",
    price: "一瓶威士忌",
    suspicion: 1,
    reason: "顺手问一句",
    raw: "<<bribe granted price=一瓶威士忌 suspicion=+1 顺手问一句>>",
  });

  const minus = parseDirectives("<<bribe haggle suspicion=-1 price=三百块>>");
  assert.equal(minus.bribes[0].suspicion, -1);
  assert.equal(minus.bribes[0].price, "三百块");
  assert.equal(minus.bribes[0].verdict, "haggle");

  const bare = parseDirectives("<<bribe>>");
  assert.deepEqual(bare.bribes[0], { verdict: "refused", price: "", suspicion: 0, reason: "", raw: "<<bribe>>" });

  const unknownVerdict = parseDirectives("<<bribe 也许可以>>");
  assert.equal(unknownVerdict.bribes[0].verdict, "refused");
  assert.equal(unknownVerdict.bribes[0].suspicion, 0);
});

test("parseDirectives：容忍全角《《》》、混用括号、大小写与多余空格", () => {
  const fullWidth = parseDirectives("《《mood amused》》然后你看见了什么？");
  assert.equal(fullWidth.mood, "amused");
  assert.equal(fullWidth.text, "然后你看见了什么？");

  const mixedLeft = parseDirectives("<<mood amused》》");
  assert.equal(mixedLeft.mood, "amused");
  const mixedRight = parseDirectives("《《mood amused>>");
  assert.equal(mixedRight.mood, "amused");

  const spaces = parseDirectives("<<    ROLL   1d100   dc = 55   >>");
  assert.equal(spaces.rolls.length, 1);
  assert.equal(spaces.rolls[0].formula, "1d100");
  assert.equal(spaces.rolls[0].dc, 55);

  const fullWidthRoll = parseDirectives("《《roll 2d6》》");
  assert.equal(fullWidthRoll.rolls[0].formula, "2d6");
});

test("parseDirectives：未知指令进 ignored，正文不残留 << 或 《《", () => {
  const result = parseDirectives("前面的话。\n<<teleport 3 城堡>>\n后面的话。");
  assert.equal(result.rolls.length, 0);
  assert.equal(result.bribes.length, 0);
  assert.deepEqual(result.ignored, ["<<teleport 3 城堡>>"]);
  assert.ok(!result.text.includes("<<"), "正文不能残留 <<");
  assert.ok(!result.text.includes("teleport"));
  assert.ok(result.text.includes("前面的话。") && result.text.includes("后面的话。"));

  const fullWidthUnknown = parseDirectives("《《幻术》》");
  assert.deepEqual(fullWidthUnknown.ignored, ["《《幻术》》"]);
  assert.equal(fullWidthUnknown.text, "");

  const empty = parseDirectives("<<>>");
  assert.deepEqual(empty.ignored, ["<<>>"]);
  assert.equal(empty.text, "");
});

test("parseDirectives：没闭合的 << 也算指令，绝不留在正文里", () => {
  const result = parseDirectives("他说了一半 <<roll 1d6");
  assert.equal(result.text, "他说了一半");
  assert.ok(!result.text.includes("<<"));
  assert.deepEqual(result.ignored, ["<<roll 1d6"]);
});

test("parseDirectives：正文 trim，内部多余空行压成一个", () => {
  const result = parseDirectives("前文\n<<roll 1d6>>\n\n\n\n后文");
  assert.equal(result.text, "前文\n\n后文");
  assert.ok(!result.text.includes("<<"));
  assert.match(result.text, /^[^ \n].*[^ \n]$/s, "首尾不该有空白");

  const onlyDirectives = parseDirectives("<<mood amused>><<roll 1d6>>《《bribe cold》》");
  assert.equal(onlyDirectives.text, "");
  assert.equal(onlyDirectives.mood, "amused");
  assert.equal(onlyDirectives.rolls.length, 1);
  assert.equal(onlyDirectives.bribes.length, 1);
});

test("parseDirectives：非字符串输入返回空结构且不抛错", () => {
  const expected = { text: "", mood: null, moods: [], rolls: [], bribes: [], ignored: [] };
  for (const input of [undefined, null, 42, true, [], {}, () => {}, Symbol("x"), 123n]) {
    const result = parseDirectives(input);
    assert.deepEqual(result, expected, `输入 ${String(input)} 应返回空结构`);
  }
});

test("parseDirectives：多种指令混在一段里互不干扰", () => {
  const result = parseDirectives(
    "【开场】\n<<mood skeptical>>\n雨声很密。\n<<roll 1d100 dc=55 听声辨位>>\n<<bribe haggle price=一包烟 suspicion=-1>>\n你决定吧。",
  );
  assert.equal(result.mood, "skeptical");
  assert.deepEqual(result.moods, ["skeptical"]);
  assert.equal(result.rolls.length, 1);
  assert.equal(result.bribes.length, 1);
  assert.deepEqual(result.ignored, []);
  assert.ok(result.text.includes("【开场】"));
  assert.ok(result.text.includes("雨声很密。"));
  assert.ok(result.text.includes("你决定吧。"));
  assert.ok(!result.text.includes("<<"));
  assert.ok(!result.text.includes("《《"));
});
