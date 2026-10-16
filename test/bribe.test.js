/**
 * lib/bribe.js —— 贿赂判定策略。
 *
 * 这一层是「规则说了算」的那一半：模型可以提议结果，但提议要经过这里收敛；
 * 模型不提议时这里给出确定性兜底。所以测试的重点是**确定性**与**边界收敛**，
 * 而不是文笔。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BribeError,
  THRESHOLDS,
  VERDICTS,
  applyVerdict,
  canOffer,
  evaluateOffer,
  offerStrength,
  priceHint,
  suspicionLabel,
} from "../lib/bribe.js";
import { SUSPICION_MAX } from "../lib/schema.js";

const openBribe = (over = {}) => ({
  id: "br_1",
  npcId: "np_1",
  npcName: "看门的老赵",
  want: "地下室那扇门后面是什么",
  price: "",
  status: "open",
  suspicion: 0,
  offers: [],
  reveals: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const npcWith = (attitude) => ({ id: "np_1", name: "看门的老赵", attitude, secret: "他把钥匙给了别人", revealed: false });

/* ------------------------------------------------------------------ 常量 */

test("VERDICTS 与阈值就是契约写的那几个", () => {
  assert.deepEqual(VERDICTS, ["granted", "haggle", "refused", "cold"]);
  assert.equal(THRESHOLDS.granted, 2.5);
  assert.equal(THRESHOLDS.haggle, 1.0);
  assert.equal(SUSPICION_MAX, 5);
});

/* ------------------------------------------------------------ 报价强度 */

test("offerStrength：空/非字符串给 0，三条启发式各算一分", () => {
  assert.equal(offerStrength(""), 0);
  assert.equal(offerStrength("   "), 0);
  assert.equal(offerStrength(null), 0);
  assert.equal(offerStrength(42), 0);
  assert.equal(offerStrength("哦"), 0, "太短且没有硬货没有量");
  assert.equal(offerStrength("随便"), 0, "两条都不占");
  assert.equal(offerStrength("这个给你了行吧"), 1, "7 个字：只占长度");
  assert.equal(offerStrength("钱"), 1, "只占硬货");
  assert.equal(offerStrength("九"), 1, "只占数量（中文数字也算量）");
  assert.equal(offerStrength("拿钱9"), 2, "硬货 + 数量，但太短");
  assert.equal(offerStrength("这根金条给你"), 2, "够长 + 硬货，但没量");
  assert.equal(offerStrength("我给你三根金条"), 3, "够长 + 硬货 + 数量");
});

test("offerStrength 认硬通货也认数字：阿拉伯数字与中文数字都算，英文单词不算量", () => {
  assert.equal(offerStrength("给你一百块"), 2, "5 个字：硬货 + 中文数字，长度不占");
  assert.equal(offerStrength("给你 100 美元"), 3, "够长 + 硬货 + 阿拉伯数字");
  assert.equal(offerStrength("送你一条烟和两瓶酒"), 3);
  assert.equal(offerStrength("three 金条"), 2, "英文单词不算量，只剩长度 + 硬货");
});

/* ------------------------------------------------------------------ 要价 */

test("priceHint 是确定性的，且非空", () => {
  const args = { npc: { name: "看门的老赵" }, suspicion: 2, want: "地下室" };
  const first = priceHint(args);
  const second = priceHint({ ...args, npc: { name: "看门的老赵" } });
  assert.equal(typeof first, "string");
  assert.ok(first.length > 0);
  assert.equal(first, second, "同一 NPC 同一怀疑度必须拿到同一句要价，否则界面会抖");
});

test("priceHint 接受空参数并回落出一个真实字符串", () => {
  const hint = priceHint();
  assert.equal(typeof hint, "string");
  assert.ok(hint.length > 0);
  assert.equal(priceHint({ suspicion: -99 }), priceHint({ suspicion: 0 }), "越界怀疑度被钳回 0");
});

/* -------------------------------------------------------------- 能否再谈 */

test("canOffer：成交/翻脸/怀疑度撞顶都不许再谈", () => {
  assert.equal(canOffer(null), false);
  assert.equal(canOffer(openBribe()), true);
  assert.equal(canOffer(openBribe({ status: "cold" })), false);
  assert.equal(canOffer(openBribe({ status: "granted" })), false);
  assert.equal(canOffer(openBribe({ status: "refused" })), true, "拒绝只是这一轮拒绝，还能再磨");
  assert.equal(canOffer(openBribe({ suspicion: SUSPICION_MAX })), false);
  assert.equal(canOffer(openBribe({ suspicion: 4 })), true);
  assert.equal(canOffer(openBribe({ suspicion: "3" })), true, "数字字符串也认");
  assert.equal(canOffer(openBribe({ suspicion: null })), true, "null 回落 0，而不是被钉到上限");
});

/* ---------------------------------------------------------------- 判定 */

test("evaluateOffer 缺少贿赂记录时抛 BribeError/BAD_BRIBE", () => {
  assert.throws(() => evaluateOffer({}), (error) => error instanceof BribeError && error.code === "BAD_BRIBE");
});

test("evaluateOffer：报价够实在 → granted，且不再加怀疑度", () => {
  const result = evaluateOffer({ bribe: openBribe(), npc: npcWith(0), offer: "我给你三根金条，外加一封介绍信" });
  assert.equal(result.verdict, "granted");
  assert.equal(result.suspicionDelta, 0);
  assert.equal(result.price, "");
  assert.ok(result.score >= THRESHOLDS.granted);
  assert.match(result.reason, /够实在/);
});

test("evaluateOffer：差一口气 → haggle，抬价 + 怀疑度 +1", () => {
  const result = evaluateOffer({ bribe: openBribe(), npc: npcWith(0), offer: "我把知道的都说给你" });
  assert.equal(result.verdict, "haggle");
  assert.equal(result.suspicionDelta, 1);
  assert.ok(result.price.length > 0, "haggle 必须给出一句要价");
  assert.ok(result.score >= THRESHOLDS.haggle && result.score < THRESHOLDS.granted);
});

test("evaluateOffer：空口白话视为羞辱 → refused 且 +2", () => {
  const result = evaluateOffer({ bribe: openBribe(), npc: npcWith(-1), offer: "哦" });
  assert.equal(result.verdict, "refused");
  assert.equal(result.suspicionDelta, 2);
  assert.match(result.reason, /空口白话/);
});

test("evaluateOffer：有诚意但对方不吃 → refused 只 +1", () => {
  const result = evaluateOffer({ bribe: openBribe({ suspicion: 2 }), npc: npcWith(0), offer: "我把知道的都说给你" });
  assert.equal(result.verdict, "refused");
  assert.equal(result.suspicionDelta, 1, "有诚意（强度 > 0）不算羞辱，只 +1");
  assert.match(result.reason, /不吃这套/);
});

test("evaluateOffer：怀疑度撞顶或已翻脸 → cold，不再产生任何变化", () => {
  const maxed = evaluateOffer({ bribe: openBribe({ suspicion: SUSPICION_MAX }), npc: npcWith(2), offer: "我给你三根金条和一百块钱" });
  assert.equal(maxed.verdict, "cold");
  assert.equal(maxed.suspicionDelta, 0);
  assert.equal(maxed.price, "");
  const cold = evaluateOffer({ bribe: openBribe({ status: "cold" }), npc: npcWith(2), offer: "我给你三根金条和一百块钱" });
  assert.equal(cold.verdict, "cold");
  assert.match(cold.reason, /不再听你说话/);
});

test("evaluateOffer：态度越好分越高（±2 之间差 2 分）", () => {
  const offer = "我把知道的都说给你";
  const friendly = evaluateOffer({ bribe: openBribe(), npc: npcWith(2), offer });
  const hostile = evaluateOffer({ bribe: openBribe(), npc: npcWith(-2), offer });
  assert.equal(friendly.score - hostile.score, 2);
  assert.equal(friendly.verdict, "granted", "态度 +2 时同样一句能成");
  assert.equal(hostile.verdict, "haggle", "刚好压在 haggle 阈值上（阈值是闭区间）");
  assert.equal(hostile.score, THRESHOLDS.haggle);
  // 再叠一点怀疑度就掉到 refused
  const colder = evaluateOffer({ bribe: openBribe({ suspicion: 1 }), npc: npcWith(-2), offer });
  assert.equal(colder.verdict, "refused");
});

test("evaluateOffer：磨得越久越难谈（每次报价 -0.5）", () => {
  const offer = "我把知道的都说给你";
  const first = evaluateOffer({ bribe: openBribe(), npc: npcWith(0), offer });
  const fifth = evaluateOffer({
    bribe: openBribe({ offers: [{ text: "a", at: 1 }, { text: "b", at: 2 }, { text: "c", at: 3 }, { text: "d", at: 4 }] }),
    npc: npcWith(0),
    offer,
  });
  assert.equal(first.score - fifth.score, 2);
  assert.equal(fifth.verdict, "refused", "磨到第 5 轮，同样一句话已经不管用了");
});

test("evaluateOffer：越界/nil 的 attitude 与 suspicion 都被钳回区间", () => {
  const wild = evaluateOffer({ bribe: openBribe({ suspicion: 99 }), npc: npcWith(99), offer: "我给你钱" });
  assert.equal(wild.verdict, "cold", "suspicion 99 钳到 5");
  const missing = evaluateOffer({ bribe: openBribe(), npc: null, offer: "我给你钱" });
  assert.equal(missing.score, offerStrength("我给你钱") + 1, "npc 缺失按态度 0 算");
});

test("evaluateOffer 是确定性的：同输入必得同结果", () => {
  const input = { bribe: openBribe({ suspicion: 1 }), npc: npcWith(1), offer: "我拿这条金链子换一句实话" };
  assert.deepEqual(evaluateOffer(input), evaluateOffer(input));
});

/* ------------------------------------------------------------ 落地判定 */

test("applyVerdict 返回新对象，不动原记录", () => {
  const bribe = openBribe();
  const next = applyVerdict(bribe, { verdict: "haggle", suspicionDelta: 1, price: "先给点诚意" }, 1234);
  assert.notEqual(next, bribe);
  assert.equal(bribe.status, "open");
  assert.equal(bribe.suspicion, 0);
  assert.equal(next.status, "haggle");
  assert.equal(next.suspicion, 1);
  assert.equal(next.price, "先给点诚意");
  assert.equal(next.updatedAt, 1234);
});

test("applyVerdict：suspicion 夹在 [0,5]，撞顶且非 granted 时强制 cold", () => {
  const hot = applyVerdict(openBribe({ suspicion: 4 }), { verdict: "refused", suspicionDelta: 2 }, 5);
  assert.equal(hot.suspicion, SUSPICION_MAX);
  assert.equal(hot.status, "cold");
  const cooled = applyVerdict(openBribe({ suspicion: 3 }), { verdict: "haggle", suspicionDelta: -99 }, 5);
  assert.equal(cooled.suspicion, 0);
  const granted = applyVerdict(openBribe({ suspicion: SUSPICION_MAX }), { verdict: "granted" }, 5);
  assert.equal(granted.status, "granted", "成交压过崩溃");
  assert.equal(granted.suspicion, SUSPICION_MAX);
});

test("applyVerdict：未知 verdict 按 refused，haggle 无价时兜底给一句要价，granted 清空要价", () => {
  const unknown = applyVerdict(openBribe(), { verdict: "whatever" }, 1);
  assert.equal(unknown.status, "refused");
  const haggle = applyVerdict(openBribe(), { verdict: "haggle" }, 1);
  assert.equal(haggle.status, "haggle");
  assert.ok(haggle.price.length > 0);
  const granted = applyVerdict(openBribe({ price: "一条好烟" }), { verdict: "granted" }, 1);
  assert.equal(granted.price, "", "成交后要价没有意义了");
});

test("applyVerdict：无法解析的 now 回落 0，而不是 NaN 或极小值", () => {
  assert.equal(applyVerdict(openBribe(), { verdict: "haggle" }, null).updatedAt, 0);
  assert.equal(applyVerdict(openBribe(), { verdict: "haggle" }, "abc").updatedAt, 0);
  assert.equal(applyVerdict(openBribe(), { verdict: "haggle" }, 1.7).updatedAt, 2, "小数四舍五入");
});

test("applyVerdict 缺少记录时抛 BribeError", () => {
  assert.throws(() => applyVerdict(null, { verdict: "granted" }, 1), (error) => error instanceof BribeError);
});

test("applyVerdict 不覆写 offers 与 reveals（它们是历史，不是状态）", () => {
  const bribe = openBribe({ offers: [{ text: "我给你钱", at: 7 }], reveals: ["他贪了公款"] });
  const next = applyVerdict(bribe, { verdict: "haggle" }, 9);
  assert.deepEqual(next.offers, [{ text: "我给你钱", at: 7 }]);
  assert.deepEqual(next.reveals, ["他贪了公款"]);
});

/* ---------------------------------------------------------------- 标签 */

test("suspicionLabel 覆盖六档并把越界值钳回端点", () => {
  assert.equal(suspicionLabel(0), "毫无戒心");
  assert.equal(suspicionLabel(1), "略有警觉");
  assert.equal(suspicionLabel(2), "开始留意");
  assert.equal(suspicionLabel(3), "明显起疑");
  assert.equal(suspicionLabel(4), "很不耐烦");
  assert.equal(suspicionLabel(5), "彻底翻脸");
  assert.equal(suspicionLabel(99), "彻底翻脸");
  assert.equal(suspicionLabel(-3), "毫无戒心");
  assert.equal(suspicionLabel(null), "毫无戒心", "null 必须回落 0，不能被当 0 钉到别的档");
  assert.equal(suspicionLabel(undefined), "毫无戒心");
  assert.equal(suspicionLabel("3"), "明显起疑");
});
