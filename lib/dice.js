/**
 * dsh-trpg — 骰子与 COC 7e 检定。
 *
 * 本模块是**纯函数**模块：不碰文件系统、不读时钟、不认识 Schema，只接收普通数据、返回普通数据。
 * 唯一的随机来源是调用方注入的 `rng()`（返回 [0,1) 的浮点）；省略时才回落到 `cryptoRng()`。
 * 这条纪律有两个目的：
 *   1. 单测可复现（`makeRng(seed)` 是确定性 mulberry32）；
 *   2. 「骰子不能被模型伪造」——随机数永远在宿主手里，模型只能请求公式，拿不到结果。
 *
 * 抛错一律用 `DiceError`（带 `code`），**绝不抛裸 `Error`**：
 *   - `BAD_FORMULA` 公式文法不合法（未知后缀、空串、非字符串输入…）
 *   - `BAD_COUNT`   骰子个数 / 面数 / 随机表条目数越界
 *   - `BAD_TARGET`  检定目标值缺失或不是数字
 *
 * 签名与规则见 CONTRACT.md 第 1 节（冻结）。
 */

import { randomInt } from "node:crypto";

/* ------------------------------------------------------------------- 常量 */

/** 骰子个数上限：防止 `100000d6` 把宿主打爆。 */
const MAX_COUNT = 100;
/** 骰子面数上限。 */
const MAX_FACES = 1000;
/** 检定难度；取值之外一律回落 `regular`。 */
const DIFFICULTIES = ["regular", "hard", "extreme"];
/** 奖励 / 惩罚骰个数上限（COC 7e 最多 2 颗）。 */
const MAX_BONUS_DICE = 2;
/** `crypto.randomInt` 的合法区间上界：范围不得超过 2^48 - 1，否则抛 ERR_OUT_OF_RANGE。 */
const RANDINT_MAX = 2 ** 48 - 1;
/** 等级 → 中文短句前缀。 */
const LEVEL_LABELS = {
  critical: "大成功",
  extreme: "极难成功",
  hard: "困难成功",
  regular: "普通成功",
  failure: "失败",
  fumble: "大失败",
};

/**
 * 公式文法（匹配前已去空格并小写化）：
 *   `<count>? d <faces> (('+'|'-') <modifier>)? (('kh'|'kl') <n>)?`
 */
const FORMULA_RE = /^(\d+)?d(\d+)(?:([+-])(\d+))?(kh|kl)?(\d+)?$/;

/* -------------------------------------------------------------------- 错误 */

/** 骰子模块唯一的错误类型。`code` 取值见文件头注释。 */
export class DiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DiceError";
    this.code = code;
  }
}

/** 抛错的小工具，保证 `name` 与 `code` 永远一起出现。 */
function fail(code, message) {
  throw new DiceError(code, message);
}

/* -------------------------------------------------------------- 数值与随机 */

/**
 * 只认真正的数字与非空数字字符串。
 * `Number(null) === 0`、`Number("") === 0` 会把「缺字段」静默钉成 0，这是 dsh-explore 记过的坑。
 */
function toFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
}

/** 钳到 [min,max] 的整数；非法值回落 `fallback`。 */
function clampInt(value, min, max, fallback) {
  const numeric = toFiniteNumber(value);
  if (!Number.isFinite(numeric)) return fallback;
  const rounded = Math.round(numeric);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

/**
 * 取一个 [0,1) 随机数。
 * 注入的 rng 若越界（返回 1、负数、NaN）就夹回区间，保证掷骰结果永远落在合法面值内。
 */
function nextUnit(rand) {
  const value = rand();
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  if (value >= 1) return 0.9999999999999999;
  return value;
}

/** rng 参数可省略；不是函数就当没传。 */
function pickRng(rng) {
  return typeof rng === "function" ? rng : cryptoRng;
}

/** 掷一颗 `<faces>` 面骰，返回 1..faces。 */
function rollDie(faces, rand) {
  return Math.floor(nextUnit(rand) * faces) + 1;
}

/** 掷一颗「百分骰用的 d10」，返回个位数字 0..9（等价于 `1d10 % 10`）。 */
function rollD10Digit(rand) {
  return (Math.floor(nextUnit(rand) * 10) + 1) % 10;
}

/**
 * 默认随机源：`node:crypto.randomInt` 取的 48 位均匀整数除以区间宽度，结果落在 [0,1)。
 * 用 randomInt 而不是 Math.random：前者不可预测，也不受 V8 内部种子影响。
 * 注意上界必须是 `2^48 - 1`——`randomInt` 要求 `max - min <= 2^48 - 1`，写 `2 ** 48` 会抛
 * `ERR_OUT_OF_RANGE: The value of "max - min" is out of range`。
 */
export function cryptoRng() {
  return randomInt(0, RANDINT_MAX) / RANDINT_MAX;
}

/**
 * mulberry32：32 位状态、返回 [0,1) 的**确定性** PRNG。
 * 只用于单测与「同 seed 可复现回放」，**不要**当作安全随机源。
 */
export function makeRng(seed) {
  let state = Number(seed) >>> 0;
  return function rng() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* -------------------------------------------------------------- 公式解析 */

/**
 * 解析骰子公式（严格校验，非法即抛 `DiceError`）。
 *
 * @param {unknown} input 如 `"3 d 6 + 2"` / `"D100"` / `"2d10kh1"`
 * @returns {{ text: string, count: number, faces: number, modifier: number, keep: { mode: "kh"|"kl", n: number } | null }}
 * @throws {DiceError} BAD_FORMULA（文法不合法）/ BAD_COUNT（个数或面数越界）
 */
export function parseFormula(input) {
  if (typeof input !== "string") fail("BAD_FORMULA", "骰子公式必须是字符串");
  const compact = input.replace(/\s+/g, "").toLowerCase();
  const match = FORMULA_RE.exec(compact);
  if (!match) fail("BAD_FORMULA", `无法识别的骰子公式：${input}`);

  const count = match[1] === undefined ? 1 : Number(match[1]);
  const faces = Number(match[2]);
  if (count < 1 || count > MAX_COUNT || faces < 1 || faces > MAX_FACES) {
    fail("BAD_COUNT", `骰子个数必须 1..${MAX_COUNT}、面数必须 1..${MAX_FACES}：${input}`);
  }

  let modifier = 0;
  if (match[4] !== undefined) {
    modifier = match[3] === "-" ? -Number(match[4]) : Number(match[4]);
    if (modifier === 0) modifier = 0; // 消掉 -0，序列化与 deepStrictEqual 才友好
  }

  let keep = null;
  if (match[5] !== undefined) {
    const wanted = match[6] === undefined ? 1 : Number(match[6]);
    keep = { mode: match[5], n: clampInt(wanted, 1, count, 1) };
  }

  let text = `${count}d${faces}`;
  if (modifier > 0) text += `+${modifier}`;
  else if (modifier < 0) text += `-${Math.abs(modifier)}`;
  if (keep) text += `${keep.mode}${keep.n}`;

  return { text, count, faces, modifier, keep };
}

/**
 * 规范化公式：去空格、小写化、补全省略的 count / keep 的 n，并校验合法性。
 * `"3 d 6 + 2"` → `"3d6+2"`；`"D100"` → `"1d100"`；`"2D10KH"` → `"2d10kh1"`。
 *
 * @param {unknown} input
 * @returns {string} 规范化写法
 * @throws {DiceError} BAD_FORMULA / BAD_COUNT
 */
export function normalizeFormula(input) {
  return parseFormula(input).text;
}

/* ------------------------------------------------------------ 取与舍（kh/kl） */

/**
 * 选出要保留的下标，**升序返回**（即掷出顺序）。
 * `kh` 取点数最高的 n 个、`kl` 取最低的 n 个；点数相同时固定从前往后取，保证确定性。
 */
function pickIndices(rolls, mode, n) {
  const size = rolls.length;
  if (size === 0) return [];
  const wanted = clampInt(n, 1, size, 1);
  const order = rolls.map((value, index) => ({ value, index }));
  order.sort((a, b) => a.value - b.value || a.index - b.index);
  const chosen = mode === "kh" ? order.slice(size - wanted) : order.slice(0, wanted);
  return chosen
    .map((entry) => entry.index)
    .sort((a, b) => a - b);
}

/**
 * 从一串点数里取 `kh`/`kl` 的结果，**保持原顺序**（不是排序后的顺序）。
 * 供 `rollFormula` 内部复用，也导出给测试。
 *
 * @param {number[]} rolls
 * @param {"kh"|"kl"} mode
 * @param {number} n 钳到 [1, rolls.length]
 * @returns {number[]}
 * @throws {DiceError} BAD_COUNT（rolls 不是数组）/ BAD_FORMULA（mode 未知）
 */
export function bestOf(rolls, mode, n) {
  if (!Array.isArray(rolls)) fail("BAD_COUNT", "rolls 必须是数组");
  if (mode !== "kh" && mode !== "kl") fail("BAD_FORMULA", `未知的保留模式：${mode}`);
  return pickIndices(rolls, mode, n).map((index) => rolls[index]);
}

/* ---------------------------------------------------------------- 掷公式 */

/**
 * 掷一个公式。
 *
 * @param {unknown} input 公式文本，如 `"3d6+2"` / `"2d10kh1"`
 * @param {() => number} [rng] 返回 [0,1) 的随机源；省略时用 `cryptoRng`
 * @returns {{ text: string, count: number, faces: number, modifier: number, rolls: number[], kept: number[], dropped: number[], total: number, keep: { mode: string, n: number } | null }}
 * @throws {DiceError} BAD_FORMULA / BAD_COUNT
 */
export function rollFormula(input, rng) {
  const formula = parseFormula(input);
  const rand = pickRng(rng);

  const rolls = [];
  for (let index = 0; index < formula.count; index += 1) {
    rolls.push(rollDie(formula.faces, rand));
  }

  let kept = rolls;
  let dropped = [];
  if (formula.keep) {
    const keptIndices = new Set(pickIndices(rolls, formula.keep.mode, formula.keep.n));
    kept = rolls.filter((_, index) => keptIndices.has(index));
    dropped = rolls.filter((_, index) => !keptIndices.has(index));
  }

  const total = kept.reduce((sum, value) => sum + value, 0) + formula.modifier;

  return {
    text: formula.text,
    count: formula.count,
    faces: formula.faces,
    modifier: formula.modifier,
    rolls,
    kept,
    dropped,
    total,
    keep: formula.keep,
  };
}

/* ---------------------------------------------------------------- 检定 */

/** 生成一句含数字的中文结论，如 `困难成功（目标 55，需 ≤27，掷出 19）`。 */
function describeCheck(level, target, threshold, roll) {
  const label = LEVEL_LABELS[level];
  if (level === "critical" || level === "fumble") {
    return `${label}（目标 ${target}，掷出 ${roll}）`;
  }
  return `${label}（目标 ${target}，需 ≤${threshold}，掷出 ${roll}）`;
}

/**
 * COC 7e 检定。
 *
 * 等级判定顺序（**大成功 / 大失败优先于普通成功**）：
 *   `roll === 1` → critical → fumble（`target < 50` 时 96..100；`target >= 50` 时只有 100）
 *   → extreme（≤ ⌊target/5⌋）→ hard（≤ ⌊target/2⌋）→ regular（≤ target）→ failure。
 *
 * 百分骰：先掷个位 `1d10 % 10`，再掷 `1 + |奖励-惩罚|` 个十位数字；
 * 奖励取**最小**十位、惩罚取**最大**十位；十位与个位同为 0 记作 100。
 *
 * @param {{ skill?: string, target: number, difficulty?: string, bonusDice?: number, penaltyDice?: number }} options
 * @param {() => number} [rng]
 * @throws {DiceError} BAD_TARGET
 */
export function rollCheck(options, rng) {
  const source = typeof options === "object" && options !== null ? options : {};

  const wanted = toFiniteNumber(source.target);
  if (!Number.isFinite(wanted)) fail("BAD_TARGET", "检定缺少合法的技能值 target（数字 1..100，越界会被钳制）");
  const target = clampInt(wanted, 1, 100, 1);

  const difficulty = DIFFICULTIES.includes(source.difficulty) ? source.difficulty : "regular";
  const bonusDice = clampInt(source.bonusDice, 0, MAX_BONUS_DICE, 0);
  const penaltyDice = clampInt(source.penaltyDice, 0, MAX_BONUS_DICE, 0);
  // 奖励与惩罚同时存在时按净值处理（COC 7e：互相抵消）。
  const net = bonusDice - penaltyDice;

  const regular = target;
  const hard = Math.floor(target / 2);
  const extreme = Math.floor(target / 5);
  const threshold = difficulty === "hard" ? hard : difficulty === "extreme" ? extreme : regular;

  const rand = pickRng(rng);
  const units = rollD10Digit(rand);
  const tensCandidates = [];
  for (let index = 0; index < 1 + Math.abs(net); index += 1) {
    tensCandidates.push(rollD10Digit(rand));
  }
  // 奖励骰取最小的十位（更容易成功），惩罚骰取最大的十位。
  const tens = net > 0 ? Math.min(...tensCandidates) : net < 0 ? Math.max(...tensCandidates) : tensCandidates[0];
  const roll = tens === 0 && units === 0 ? 100 : tens * 10 + units;

  let level;
  let success;
  if (roll === 1) {
    level = "critical";
    success = true;
  } else if (target < 50 ? roll >= 96 : roll === 100) {
    level = "fumble";
    success = false;
  } else if (roll <= extreme) {
    level = "extreme";
    success = true;
  } else if (roll <= hard) {
    level = "hard";
    success = true;
  } else if (roll <= regular) {
    level = "regular";
    success = true;
  } else {
    level = "failure";
    success = false;
  }

  return {
    skill: typeof source.skill === "string" ? source.skill : "",
    target,
    difficulty,
    threshold,
    bonusDice,
    penaltyDice,
    tens,
    units,
    tensCandidates,
    roll,
    level,
    success,
    description: describeCheck(level, target, threshold, roll),
  };
}

/* ---------------------------------------------------------------- 随机表 */

/**
 * 掷一个随机表：掷 `1dN`（N = 条目数）后返回命中的条目。
 * `entries` 既可以是字符串数组，也可以是 `{ label, ... }` 对象数组。
 *
 * @param {Array<string|{label: string}>} entries
 * @param {() => number} [rng]
 * @returns {{ roll: number, label: string, index: number }} `roll` 从 1 起，`index` 从 0 起
 * @throws {DiceError} BAD_COUNT（空表或非数组）/ BAD_FORMULA（条目形状不对）
 */
export function rollTable(entries, rng) {
  if (!Array.isArray(entries) || entries.length === 0) fail("BAD_COUNT", "随机表必须是非空数组");
  const labels = entries.map((entry) => {
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object" && typeof entry.label === "string") return entry.label;
    fail("BAD_FORMULA", "随机表条目必须是字符串或带 label 的对象");
    return "";
  });

  const rand = pickRng(rng);
  const index = Math.floor(nextUnit(rand) * labels.length);
  return { roll: index + 1, label: labels[index], index };
}
