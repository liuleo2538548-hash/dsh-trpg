/**
 * dsh-trpg — `lib/dice.js` 单测。
 *
 * 覆盖 CONTRACT.md 第 1 节「单测至少要覆盖」的每一条：
 * 边界、kh/kl 守恒、负修正、d100 省略 count、faces===1、DiceError code、
 * critical/fumble 边界、奖励骰取小十位 / 惩罚骰取大十位、十位个位同为 0 → 100、
 * 同 seed 可复现、`rollFormula("3d6", ()=>0)` 恒为 3。
 *
 * 跑法（Node 24 的 `--test` 不接受目录，必须给文件名）：
 *   node --test test/dice.test.js
 */

import test from "node:test";
import assert from "node:assert/strict";

import * as diceModule from "../lib/dice.js";
import {
  DiceError,
  cryptoRng,
  makeRng,
  normalizeFormula,
  parseFormula,
  rollFormula,
  rollCheck,
  rollTable,
  bestOf,
} from "../lib/dice.js";

/* --------------------------------------------------------------- 测试工具 */

/** 依次返回给定值；用完后一直返回最后一个（避免越界时静默变成 undefined）。 */
function seq(...values) {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value;
  };
}

/**
 * 让「百分骰 d10」掷出指定个位数字（0..9）所需的 rng 值。
 * 掷骰公式为 `(floor(u*10) + 1) % 10`，所以 digit d 对应 u 落在 [(d+9)%10, (d+9)%10+1) / 10。
 */
function unitForDigit(digit) {
  return ((digit + 9) % 10 + 0.5) / 10;
}

/** 让一颗 `<faces>` 面骰掷出指定点数（1..faces）所需的 rng 值。 */
function unitForDie(faces, value) {
  return (value - 0.5) / faces;
}

/** 造一个百分骰 rng：`rollCheck` 先掷个位、再掷十位。 */
function d100(tens, units) {
  return seq(unitForDigit(units), unitForDigit(tens));
}

function captureThrow(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return assert.fail("预期抛出 DiceError，但没有抛错");
}

/** 断言抛出的是 DiceError（不是裸 Error）且 code 正确。 */
function assertDiceError(fn, code) {
  const error = captureThrow(fn);
  assert.ok(error instanceof DiceError, `应为 DiceError，实际是 ${error.name}`);
  assert.ok(error instanceof Error, "DiceError 必须继承 Error");
  assert.equal(error.name, "DiceError");
  assert.equal(error.code, code);
  return error;
}

/** 一次掷出固定点数序列的公式 rng（按 rolls 顺序取值）。 */
function diceSeq(faces, ...values) {
  return seq(...values.map((value) => unitForDie(faces, value)));
}

/* --------------------------------------------------------- 导出面 / 契约 */

test("导出符号与 CONTRACT 第 1 节逐字一致（不增不减）", () => {
  assert.deepEqual(Object.keys(diceModule).sort(), [
    "DiceError",
    "bestOf",
    "cryptoRng",
    "makeRng",
    "normalizeFormula",
    "parseFormula",
    "rollCheck",
    "rollFormula",
    "rollTable",
  ]);
  assert.equal(typeof DiceError, "function");
  assert.equal(DiceError.prototype instanceof Error, true);
});

test("cryptoRng 落在 [0,1) 且真的在变", () => {
  const seen = new Set();
  for (let index = 0; index < 500; index += 1) {
    const value = cryptoRng();
    assert.equal(typeof value, "number");
    assert.ok(value >= 0 && value < 1, `越界：${value}`);
    seen.add(value);
  }
  assert.ok(seen.size > 400, `随机性不足：500 次只有 ${seen.size} 个不同值`);
});

test("makeRng 是确定性的 mulberry32", () => {
  const left = makeRng(42);
  const right = makeRng(42);
  for (let index = 0; index < 10; index += 1) {
    const value = left();
    assert.equal(value, right());
    assert.ok(value >= 0 && value < 1);
  }
  const other = makeRng(43);
  const first = [];
  for (let index = 0; index < 10; index += 1) first.push(other());
  assert.ok(new Set(first).size > 5, "同一 PRNG 不应退化为常数");
  const seeded42 = makeRng(42);
  assert.notDeepEqual(
    Array.from({ length: 10 }, () => seeded42()),
    first,
    "不同 seed 不应给出完全相同的序列"
  );
});

/* ------------------------------------------------------------ 公式解析 */

test("normalizeFormula：去空格 / 小写 / 补全省略项", () => {
  assert.equal(normalizeFormula("  3 D 6 + 2 "), "3d6+2");
  assert.equal(normalizeFormula("3 d 6 + 2"), "3d6+2");
  assert.equal(normalizeFormula("D100"), "1d100");
  assert.equal(normalizeFormula("2D10KH"), "2d10kh1");
  assert.equal(normalizeFormula("2D10KH1"), "2d10kh1");
  assert.equal(normalizeFormula("3d6-2"), "3d6-2");
  assert.equal(normalizeFormula("3d6+0"), "3d6"); // +0 会被规范化掉
  assert.equal(normalizeFormula("1d6KL9"), "1d6kl1"); // n 钳到 [1, count]
  // 幂等：规范化后再规范化结果不变
  assert.equal(normalizeFormula(normalizeFormula("  4 D 8 KH 3 ")), "4d8kh3");
});

test("parseFormula：字段形状与语义", () => {
  assert.deepEqual(parseFormula("3 d 6 + 2"), {
    text: "3d6+2",
    count: 3,
    faces: 6,
    modifier: 2,
    keep: null,
  });
  assert.deepEqual(parseFormula("2d10kh1").keep, { mode: "kh", n: 1 });
  assert.deepEqual(parseFormula("4d6kl2").keep, { mode: "kl", n: 2 });
  assert.equal(parseFormula("d100").count, 1); // count 省略即 1
  assert.equal(parseFormula("d100").faces, 100);
  assert.equal(parseFormula("d100").text, "1d100");
  assert.equal(parseFormula("1d6-3").modifier, -3);
  assert.equal(parseFormula("1d6").modifier, 0);
  assert.equal(parseFormula("1d6+0").modifier, 0);
  assert.equal(Object.is(parseFormula("1d6-0").modifier, -0), false); // 不留 -0
  assert.deepEqual(parseFormula("5d6kh5").keep, { mode: "kh", n: 5 });
  assert.deepEqual(parseFormula("5d6kh99").keep, { mode: "kh", n: 5 }); // n>count 钳制
  assert.deepEqual(parseFormula("5d6kh0").keep, { mode: "kh", n: 1 }); // n<1 钳制
});

test("count / faces 边界：1 与上限合法，越界报 BAD_COUNT", () => {
  assert.equal(parseFormula("1d1").count, 1);
  assert.equal(parseFormula("1d1").faces, 1);
  assert.equal(parseFormula("100d6").count, 100);
  assert.equal(parseFormula("1d1000").faces, 1000);
  const big = rollFormula("100d6", makeRng(1));
  assert.equal(big.rolls.length, 100);
  assert.ok(big.rolls.every((value) => value >= 1 && value <= 6));

  assertDiceError(() => parseFormula("0d6"), "BAD_COUNT");
  assertDiceError(() => parseFormula("101d6"), "BAD_COUNT");
  assertDiceError(() => parseFormula("1d0"), "BAD_COUNT");
  assertDiceError(() => parseFormula("1d1001"), "BAD_COUNT");
  assertDiceError(() => parseFormula("1000d1000"), "BAD_COUNT");
  assertDiceError(() => rollFormula("0d6"), "BAD_COUNT");
});

test("非法公式一律抛 DiceError(BAD_FORMULA)，绝不抛裸 Error", () => {
  for (const bad of ["3d6x2", "abc", "", "   ", "d", "3d", "3d6+", "3d6-", "+3d6", "3d6khx", "3dd6", "3d6kh1+2"]) {
    assertDiceError(() => parseFormula(bad), "BAD_FORMULA");
  }
  for (const bad of [null, undefined, 42, {}, [], true]) {
    assertDiceError(() => parseFormula(bad), "BAD_FORMULA");
    assertDiceError(() => normalizeFormula(bad), "BAD_FORMULA");
  }
  assertDiceError(() => rollFormula(null), "BAD_FORMULA");
  const error = captureThrow(() => rollFormula("3d6x2"));
  assert.equal(error.code, "BAD_FORMULA");
  assert.ok(/3d6x2/.test(error.message), "错误信息里应带上原公式，方便宿主转述");
});

test("faces === 1 合法（退化为固定值），不特判报错", () => {
  assert.equal(parseFormula("1d1").faces, 1);
  const rolled = rollFormula("4d1", () => 0);
  assert.deepEqual(rolled.rolls, [1, 1, 1, 1]);
  assert.deepEqual(rolled.kept, [1, 1, 1, 1]);
  assert.deepEqual(rolled.dropped, []);
  assert.equal(rolled.total, 4);
});

/* ------------------------------------------------------------ 掷公式 */

test("rollFormula('3d6', ()=>0) 恒为 3（确定性契约）", () => {
  const rolled = rollFormula("3d6", () => 0);
  assert.deepEqual(rolled.rolls, [1, 1, 1]);
  assert.equal(rolled.total, 3);
  assert.equal(rolled.text, "3d6");
  assert.equal(rolled.count, 3);
  assert.equal(rolled.faces, 6);
  assert.equal(rolled.modifier, 0);
  assert.equal(rolled.keep, null);
});

test("负修正与正修正都只作用在总和上", () => {
  assert.equal(rollFormula("3d6-2", () => 0).total, 1);
  assert.equal(rollFormula("2d6+3", () => 0).total, 5);
  assert.equal(rollFormula("1d6-10", () => 0).total, -9); // 允许负总和
  assert.deepEqual(rollFormula("3d6-2", () => 0).rolls, [1, 1, 1]); // 修正不改骰面
});

test("省略 rng 时回落到 cryptoRng，结果仍在合法区间", () => {
  const rolled = rollFormula("3d6");
  assert.equal(rolled.rolls.length, 3);
  assert.ok(rolled.rolls.every((value) => Number.isInteger(value) && value >= 1 && value <= 6));
  const checked = rollCheck({ target: 55 });
  assert.ok(Number.isInteger(checked.roll) && checked.roll >= 1 && checked.roll <= 100);
});

test("kh/kl：kept+dropped===count 且 kept 保持原顺序", () => {
  // 掷出顺序：2 6 1 4 3
  const rolls = [2, 6, 1, 4, 3];
  const kh = rollFormula("5d6kh2", diceSeq(6, ...rolls));
  assert.deepEqual(kh.rolls, rolls);
  assert.deepEqual(kh.kept, [6, 4]); // 最高的两个，但按原顺序输出
  assert.deepEqual(kh.dropped, [2, 1, 3]);
  assert.equal(kh.kept.length + kh.dropped.length, kh.count);
  assert.equal(kh.total, 10);

  const kl = rollFormula("5d6kl2", diceSeq(6, ...rolls));
  assert.deepEqual(kl.rolls, rolls);
  assert.deepEqual(kl.kept, [2, 1]); // 最低的两个，同样按原顺序
  assert.deepEqual(kl.dropped, [6, 4, 3]);
  assert.equal(kl.kept.length + kl.dropped.length, kl.count);
  assert.equal(kl.total, 3);

  for (const formula of ["3d6kh1", "3d6kl1", "10d10kh3", "10d10kl7", "6d6kh6", "1d20kl1"]) {
    const result = rollFormula(formula, makeRng(9));
    assert.equal(result.kept.length + result.dropped.length, result.count, formula);
  }
});

test("kh/kl 的 n 钳制与无后缀时的 kept===rolls", () => {
  const all = rollFormula("3d6", () => 0);
  assert.deepEqual(all.kept, all.rolls);
  assert.deepEqual(all.dropped, []);
  assert.equal(all.kept.length + all.dropped.length, all.count);

  const khAll = rollFormula("5d6kh9", diceSeq(6, 1, 2, 3, 4, 5));
  assert.equal(khAll.keep.n, 5); // n>count → count
  assert.equal(khAll.kept.length, 5);
  assert.equal(khAll.dropped.length, 0);
  assert.equal(khAll.total, 15);

  const klOne = rollFormula("5d6kl0", diceSeq(6, 4, 2, 5, 1, 3));
  assert.equal(klOne.keep.n, 1); // n<1 → 1
  assert.deepEqual(klOne.kept, [1]);
  assert.deepEqual(klOne.dropped, [4, 2, 5, 3]);
});

test("bestOf：取高/取低、保持原顺序、越界钳制", () => {
  const rolls = [3, 1, 5, 2, 4];
  assert.deepEqual(bestOf(rolls, "kh", 2), [5, 4]);
  assert.deepEqual(bestOf(rolls, "kl", 2), [1, 2]);
  assert.deepEqual(bestOf(rolls, "kh", 99), rolls); // n 钳到长度 → 全保留且原顺序
  assert.deepEqual(bestOf(rolls, "kl", 0), [1]); // 下界 1
  assert.deepEqual(bestOf([], "kh", 1), []);
  assert.deepEqual(bestOf([5, 5, 1], "kh", 1), [5]); // 平局也要确定性
  assert.deepEqual(bestOf([2, 2, 2], "kl", 2), [2, 2]);

  assertDiceError(() => bestOf("nope", "kh", 1), "BAD_COUNT");
  assertDiceError(() => bestOf([1, 2], "xx", 1), "BAD_FORMULA");
  assertDiceError(() => bestOf([1, 2], null, 1), "BAD_FORMULA");
});

test("同 seed 可复现回放", () => {
  const left = rollFormula("5d6+1kh2", makeRng(42));
  const right = rollFormula("5d6+1kh2", makeRng(42));
  assert.deepEqual(left, right);
  assert.deepEqual(left.rolls, right.rolls);
  assert.equal(left.total, right.total);

  const checkA = rollCheck({ target: 55, bonusDice: 2 }, makeRng(7));
  const checkB = rollCheck({ target: 55, bonusDice: 2 }, makeRng(7));
  assert.deepEqual(checkA, checkB);

  const checkC = rollCheck({ target: 55, bonusDice: 2 }, makeRng(8));
  assert.notDeepEqual(checkC.tensCandidates, checkA.tensCandidates);
});

/* ------------------------------------------------------------ 检定：等级 */

test("rollCheck：roll===1 → critical，且优先于普通成功判定", () => {
  const normal = rollCheck({ target: 55 }, d100(0, 1));
  assert.equal(normal.roll, 1);
  assert.equal(normal.tens, 0);
  assert.equal(normal.units, 1);
  assert.equal(normal.level, "critical");
  assert.equal(normal.success, true);
  assert.deepEqual(normal.tensCandidates, [0]);
  assert.equal(normal.threshold, 55);
  assert.equal(normal.description, "大成功（目标 55，掷出 1）");

  // target===1 时极难阈值是 0，但 roll===1 仍然算 critical 而不是 extreme
  const minimal = rollCheck({ target: 1 }, d100(0, 1));
  assert.equal(minimal.threshold, 1);
  assert.equal(minimal.level, "critical");
  assert.equal(minimal.success, true);
});

test("rollCheck：target<50 时 96..100 都是 fumble，95 只是 failure", () => {
  for (const [tens, units, roll] of [
    [9, 6, 96],
    [9, 9, 99],
    [0, 0, 100],
  ]) {
    const result = rollCheck({ target: 40 }, d100(tens, units));
    assert.equal(result.roll, roll);
    assert.equal(result.level, "fumble", `roll=${roll} 应为大失败`);
    assert.equal(result.success, false);
  }
  assert.equal(rollCheck({ target: 40 }, d100(0, 0)).description, "大失败（目标 40，掷出 100）");

  const almost = rollCheck({ target: 40 }, d100(9, 5));
  assert.equal(almost.roll, 95);
  assert.equal(almost.level, "failure");
  assert.equal(almost.success, false);

  // 49 仍属「< 50」区间
  assert.equal(rollCheck({ target: 49 }, d100(9, 6)).level, "fumble");
});

test("rollCheck：target>=50 时只有 100 是 fumble", () => {
  const ninetyNine = rollCheck({ target: 55 }, d100(9, 9));
  assert.equal(ninetyNine.roll, 99);
  assert.equal(ninetyNine.level, "failure");
  assert.equal(ninetyNine.success, false);

  const hundred = rollCheck({ target: 55 }, d100(0, 0));
  assert.equal(hundred.roll, 100);
  assert.equal(hundred.level, "fumble");
  assert.equal(hundred.success, false);
  assert.equal(hundred.description, "大失败（目标 55，掷出 100）");

  // 96/97/98 在 target>=50 时只是普通失败
  assert.equal(rollCheck({ target: 55 }, d100(9, 6)).level, "failure");

  // target===50 也走「>=50」分支
  assert.equal(rollCheck({ target: 50 }, d100(9, 6)).level, "failure");
  assert.equal(rollCheck({ target: 50 }, d100(0, 0)).level, "fumble");

  // target===99 时 99 是普通成功（99 <= target），不是大失败
  assert.equal(rollCheck({ target: 99 }, d100(9, 9)).level, "regular");
  assert.equal(rollCheck({ target: 100 }, d100(0, 0)).level, "fumble"); // 100 例外
});

test("rollCheck：难度阈值与四级成功", () => {
  const extremeRoll = rollCheck({ target: 55 }, d100(0, 5));
  assert.equal(extremeRoll.roll, 5);
  assert.equal(extremeRoll.threshold, 55);
  assert.equal(extremeRoll.level, "extreme");
  assert.equal(extremeRoll.success, true);

  const hardRoll = rollCheck({ target: 55 }, d100(1, 9));
  assert.equal(hardRoll.roll, 19);
  assert.equal(hardRoll.level, "hard");
  assert.equal(hardRoll.success, true);
  assert.equal(hardRoll.description, "困难成功（目标 55，需 ≤55，掷出 19）");
  const regularRoll = rollCheck({ target: 55 }, d100(4, 0));
  assert.equal(regularRoll.roll, 40);
  assert.equal(regularRoll.level, "regular");
  assert.equal(regularRoll.success, true);

  const failure = rollCheck({ target: 55 }, d100(7, 0));
  assert.equal(failure.roll, 70);
  assert.equal(failure.level, "failure");
  assert.equal(failure.success, false);
  assert.equal(failure.description, "失败（目标 55，需 ≤55，掷出 70）");

  // 难度只改 threshold，不改等级基准：55 的 hard=27 / extreme=11
  assert.equal(rollCheck({ target: 55, difficulty: "hard" }, d100(1, 0)).threshold, 27);
  assert.equal(rollCheck({ target: 55, difficulty: "extreme" }, d100(1, 0)).threshold, 11);
  assert.equal(rollCheck({ target: 55, difficulty: "hard" }, d100(4, 0)).level, "regular"); // 40<=55
  assert.equal(rollCheck({ target: 55, difficulty: "hard" }, d100(4, 0)).success, true);
  assert.equal(rollCheck({ target: 55, difficulty: "extreme" }, d100(2, 0)).level, "hard"); // 20<=27
  // CONTRACT 第 1 节的示例文案逐字复现（difficulty:"hard" → 需 ≤27）
  assert.equal(
    rollCheck({ target: 55, difficulty: "hard" }, d100(1, 9)).description,
    "困难成功（目标 55，需 ≤27，掷出 19）"
  );
  assert.equal(rollCheck({ target: 55, difficulty: "hard" }, d100(2, 0)).description, "困难成功（目标 55，需 ≤27，掷出 20）");
  // 奇数 target 向下取整
  assert.equal(rollCheck({ target: 55, difficulty: "hard" }, d100(1, 1)).threshold, 27);
  assert.equal(rollCheck({ target: 49, difficulty: "extreme" }, d100(1, 1)).threshold, 9);
});

test("rollCheck：difficulty 取值之外一律回落 regular", () => {
  for (const value of [undefined, null, "", "HARD", "hard ", "insane", 3, {}]) {
    const result = rollCheck({ target: 55, difficulty: value }, d100(4, 0));
    assert.equal(result.difficulty, "regular", `difficulty=${String(value)}`);
    assert.equal(result.threshold, 55);
  }
  assert.equal(rollCheck({ target: 55, difficulty: "hard" }, d100(4, 0)).difficulty, "hard");
});

/* ------------------------------------------------------- 检定：奖励/惩罚骰 */

test("rollCheck：奖励骰取最小十位、惩罚骰取最大十位", () => {
  // 个位 5；两个十位候选依次为 9 与 2
  const bonus = rollCheck({ target: 55, bonusDice: 1 }, seq(0.45, 0.85, 0.15));
  assert.equal(bonus.units, 5);
  assert.deepEqual(bonus.tensCandidates, [9, 2]);
  assert.equal(bonus.tens, 2); // 取小
  assert.equal(bonus.roll, 25);
  assert.equal(bonus.level, "hard"); // 25 <= 27（困难难度下的中段）
  assert.equal(bonus.success, true);
  assert.equal(bonus.bonusDice, 1);
  assert.equal(bonus.penaltyDice, 0);

  const penalty = rollCheck({ target: 55, penaltyDice: 1 }, seq(0.45, 0.85, 0.15));
  assert.deepEqual(penalty.tensCandidates, [9, 2]);
  assert.equal(penalty.tens, 9); // 取大
  assert.equal(penalty.roll, 95);
  assert.equal(penalty.level, "failure");
  assert.equal(penalty.success, false);

  // 没有奖励/惩罚时只掷一个十位
  const plain = rollCheck({ target: 55 }, seq(0.45, 0.85));
  assert.deepEqual(plain.tensCandidates, [9]);
  assert.equal(plain.roll, 95);

  // 2 颗奖励骰 → 3 个候选
  const double = rollCheck({ target: 55, bonusDice: 2 }, seq(0.45, 0.85, 0.75, 0.15));
  assert.equal(double.tensCandidates.length, 3);
  assert.deepEqual(double.tensCandidates, [9, 8, 2]);
  assert.equal(double.tens, 2);
  assert.equal(double.roll, 25);
});

test("rollCheck：奖励与惩罚同时存在时按净值抵消", () => {
  const cancel = rollCheck({ target: 55, bonusDice: 1, penaltyDice: 1 }, seq(0.45, 0.85));
  assert.equal(cancel.tensCandidates.length, 1);
  assert.equal(cancel.tens, 9);
  assert.equal(cancel.roll, 95);

  const netBonus = rollCheck({ target: 55, bonusDice: 2, penaltyDice: 1 }, seq(0.45, 0.85, 0.15));
  assert.equal(netBonus.tensCandidates.length, 2);
  assert.equal(netBonus.tens, 2);
  assert.equal(netBonus.roll, 25);

  const netPenalty = rollCheck({ target: 55, bonusDice: 1, penaltyDice: 2 }, seq(0.45, 0.85, 0.75, 0.15));
  assert.equal(netPenalty.tensCandidates.length, 2); // 净值 -1 → 1 + 1 个十位
  assert.deepEqual(netPenalty.tensCandidates, [9, 8]);
  assert.equal(netPenalty.tens, 9);
  assert.equal(netPenalty.roll, 95);
});

test("rollCheck：奖励/惩罚骰个数钳到 [0,2]", () => {
  const high = rollCheck({ target: 55, bonusDice: 5 }, makeRng(3));
  assert.equal(high.bonusDice, 2);
  assert.equal(high.tensCandidates.length, 3);

  const low = rollCheck({ target: 55, penaltyDice: -3 }, makeRng(3));
  assert.equal(low.penaltyDice, 0);
  assert.equal(low.tensCandidates.length, 1);

  for (const value of [undefined, null, "", "x", {}, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = rollCheck({ target: 55, bonusDice: value, penaltyDice: value }, d100(4, 0));
    assert.equal(result.bonusDice, 0, `bonusDice=${String(value)}`);
    assert.equal(result.penaltyDice, 0, `penaltyDice=${String(value)}`);
  }
  // 数字字符串也认
  assert.equal(rollCheck({ target: 55, bonusDice: "1" }, seq(0.45, 0.85, 0.15)).bonusDice, 1);
});

test("rollCheck：十位与个位同为 0 → roll===100", () => {
  const result = rollCheck({ target: 55 }, d100(0, 0));
  assert.equal(result.tens, 0);
  assert.equal(result.units, 0);
  assert.deepEqual(result.tensCandidates, [0]);
  assert.equal(result.roll, 100);
  assert.equal(result.level, "fumble");

  // 十位 0 但个位非 0：是 1..9 而不是 01..09 的「100+」
  const five = rollCheck({ target: 55 }, d100(0, 5));
  assert.equal(five.roll, 5);
  // 个位 0 但十位非 0：是 10 的倍数
  const forty = rollCheck({ target: 55 }, d100(4, 0));
  assert.equal(forty.roll, 40);

  // 100 永远落在 1..100
  assert.equal(rollCheck({ target: 55 }, d100(9, 9)).roll, 99);
});

/* ------------------------------------------------------- 检定：target 与文案 */

test("rollCheck：target 钳到 [1,100]，缺失/非法报 BAD_TARGET", () => {
  assert.equal(rollCheck({ target: 0 }, d100(4, 0)).target, 1);
  assert.equal(rollCheck({ target: -20 }, d100(4, 0)).target, 1);
  assert.equal(rollCheck({ target: 200 }, d100(4, 0)).target, 100);
  assert.equal(rollCheck({ target: 55.4 }, d100(4, 0)).target, 55);
  assert.equal(rollCheck({ target: "55" }, d100(4, 0)).target, 55); // 数字字符串可接受
  // 钳制会连带影响阈值
  assert.equal(rollCheck({ target: 200, difficulty: "extreme" }, d100(1, 0)).threshold, 20);

  assertDiceError(() => rollCheck(), "BAD_TARGET");
  assertDiceError(() => rollCheck({}), "BAD_TARGET");
  assertDiceError(() => rollCheck({ target: "abc" }), "BAD_TARGET");
  assertDiceError(() => rollCheck({ target: "" }), "BAD_TARGET");
  assertDiceError(() => rollCheck({ target: null }), "BAD_TARGET");
  assertDiceError(() => rollCheck({ target: Number.NaN }), "BAD_TARGET");
  assertDiceError(() => rollCheck({ target: Number.POSITIVE_INFINITY }), "BAD_TARGET");
  assertDiceError(() => rollCheck(null), "BAD_TARGET");
});

test("rollCheck：skill 与 description 形状", () => {
  assert.equal(rollCheck({ target: 55 }, d100(4, 0)).skill, "");
  assert.equal(rollCheck({ target: 55 }, d100(4, 0)).skill, "");
  assert.equal(rollCheck({ skill: "侦察", target: 55 }, d100(4, 0)).skill, "侦察");
  assert.equal(rollCheck({ skill: 42, target: 55 }, d100(4, 0)).skill, "");

  const samples = [
    rollCheck({ skill: "侦察", target: 55 }, d100(0, 1)),
    rollCheck({ target: 55 }, d100(0, 5)),
    rollCheck({ target: 55 }, d100(1, 9)),
    rollCheck({ target: 55 }, d100(4, 0)),
    rollCheck({ target: 55 }, d100(7, 0)),
    rollCheck({ target: 40 }, d100(0, 0)),
  ];
  for (const result of samples) {
    assert.match(result.description, /（目标 \d+/, `缺少目标数字：${result.description}`);
    assert.match(result.description, /掷出 \d+/, `缺少掷出数字：${result.description}`);
    assert.ok(!result.description.includes("\n"), "description 必须是单行");
    assert.ok(result.description.length >= 8 && result.description.length <= 40);
  }
  assert.deepEqual(
    samples.map((result) => result.level),
    ["critical", "extreme", "hard", "regular", "failure", "fumble"]
  );
  assert.deepEqual(
    samples.map((result) => result.success),
    [true, true, true, true, false, false]
  );
});

test("rollCheck：返回字段齐全（CONTRACT 第 1 节逐个核对）", () => {
  const result = rollCheck({ skill: "潜行", target: 70, difficulty: "hard", bonusDice: 2, penaltyDice: 1 }, makeRng(11));
  assert.deepEqual(Object.keys(result).sort(), [
    "bonusDice",
    "description",
    "difficulty",
    "level",
    "penaltyDice",
    "roll",
    "skill",
    "success",
    "target",
    "tens",
    "tensCandidates",
    "threshold",
    "units",
  ]);
  assert.ok(Number.isInteger(result.roll) && result.roll >= 1 && result.roll <= 100);
  assert.ok(Number.isInteger(result.tens) && result.tens >= 0 && result.tens <= 9);
  assert.ok(Number.isInteger(result.units) && result.units >= 0 && result.units <= 9);
  assert.ok(result.tensCandidates.every((digit) => digit >= 0 && digit <= 9));
});

/* ------------------------------------------------------------ 随机表 */

test("rollTable：1dN 命中与边界", () => {
  assert.deepEqual(rollTable(["A", "B", "C"], () => 0), { roll: 1, label: "A", index: 0 });
  assert.deepEqual(rollTable(["A", "B", "C"], () => 0.999), { roll: 3, label: "C", index: 2 });
  assert.deepEqual(rollTable(["独苗"], () => 0.5), { roll: 1, label: "独苗", index: 0 });

  const objects = rollTable([{ label: "甲" }, { label: "乙" }, { label: "丙" }], makeRng(7));
  assert.ok(["甲", "乙", "丙"].includes(objects.label));
  assert.equal(objects.roll, objects.index + 1);

  const auto = rollTable(["x", "y"]);
  assert.ok(auto.roll === 1 || auto.roll === 2);

  assertDiceError(() => rollTable([], () => 0), "BAD_COUNT");
  assertDiceError(() => rollTable(null, () => 0), "BAD_COUNT");
  assertDiceError(() => rollTable("abc", () => 0), "BAD_COUNT");
  assertDiceError(() => rollTable(["A", 5], () => 0), "BAD_FORMULA");
  assertDiceError(() => rollTable([{ nope: 1 }], () => 0), "BAD_FORMULA");
});

/* ------------------------------------------------------------ 越界 rng */

test("注入的 rng 越界也不会掷出面值之外的骰子", () => {
  const wild = seq(-1, 1, 2, Number.NaN, 0.5);
  const rolled = rollFormula("6d6", wild);
  assert.ok(rolled.rolls.every((value) => value >= 1 && value <= 6));
  const checked = rollCheck({ target: 55 }, wild);
  assert.ok(checked.roll >= 1 && checked.roll <= 100);
  assert.ok(checked.tens >= 0 && checked.tens <= 9);
  assert.ok(checked.units >= 0 && checked.units <= 9);
});
