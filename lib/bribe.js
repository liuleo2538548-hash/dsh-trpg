/**
 * dsh-trpg — 贿赂/情报交易的**判定策略**（唯一权威）。
 *
 * 分工：`gm.js` 负责「NPC 用怎样的口气回应」，本模块负责「这次贿赂到底成不成」。
 * 模型可以提议结果（`<<bribe granted …>>`），但**提议要经过这里收敛**；模型若没提议，
 * 这里给出确定性的兜底结果，保证交互永不卡死。
 *
 * 判定是**确定性**的：同样的（NPC 态度、怀疑度、报价、已磨轮数）必得同样的结果。
 * 这不是偷懒 —— 玩家磨价时如果结果每次随机，就成了老虎机而不是谈判。
 */

import { SUSPICION_MAX, clampInt, clampText, oneLine } from "./schema.js";

export class BribeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BribeError";
    this.code = code;
  }
}

export const VERDICTS = ["granted", "haggle", "refused", "cold"];

/** 判定阈值：分数越高越容易成。 */
export const THRESHOLDS = { granted: 2.5, haggle: 1.0 };

/** 报价里出现这些词，说明玩家掏的是「硬通货」而不是空口白话。 */
const VALUABLE_RE = /钱|金|银|钞|现金|支票|硬通货|宝石|珠宝|钻|酒|烟|雪茄|咖啡|药|枪|子弹|首饰|戒指|项链|情报|秘密|把柄|帮忙|跑腿|交换|美元|美金|欧元|日|元|币|两|块/i;

/** 报价里出现数字，说明玩家给了具体量（比「我给你点好处」强得多）。 */
const SPECIFIC_RE = /[0-9０-９一二三四五六七八九十百千万]+/;

/**
 * 报价强度 0..3。这是个**粗糙但有道理**的启发式：
 * 说得具体 + 掏的是硬货 + 给了量，三条各算一分。
 * 目的是让「随便糊一句」和「认真谈条件」得到不同结果，而不是评判文笔。
 */
export function offerStrength(offer) {
  const text = typeof offer === "string" ? offer.trim() : "";
  if (!text) return 0;
  let score = 0;
  if (text.length >= 6) score += 1;
  if (VALUABLE_RE.test(text)) score += 1;
  if (SPECIFIC_RE.test(text)) score += 1;
  return score;
}

function hashString(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

/** 候选「要价」池。同一个 NPC 在同一怀疑度下拿到的是同一句，避免界面抖动。 */
const PRICE_POOL = [
  "一条好烟，现在就要",
  "现金。别问数目，你看着给",
  "你身上那件值钱的东西",
  "帮我做一件我不能出面的事",
  "先说清楚你是替谁跑腿",
  "欠我一个人情，记着",
  "把你知道的另外半截告诉我换",
  "别在这儿谈，换个地方",
  "我要一句实话：你到底怕什么",
  "把你那位朋友的名字说出来",
];

/**
 * 给出这次要价的说法。`suspicion` 越高，要价越谨慎（挑靠后的候选）。
 */
export function priceHint({ npc, suspicion = 0, want = "" } = {}) {
  const name = oneLine(npc && npc.name, 60) || "对方";
  const seed = hashString(`${name}|${suspicion}|${clampText(want, 200)}`);
  const index = clampInt(Math.abs(seed + suspicion * 7) % PRICE_POOL.length, { min: 0, max: PRICE_POOL.length - 1, fallback: 0 });
  return PRICE_POOL[index];
}

/** 这个交易还能不能继续谈。 */
export function canOffer(bribe) {
  if (!bribe) return false;
  if (bribe.status === "cold") return false;
  if (bribe.status === "granted") return false;
  return clampInt(bribe.suspicion, { min: 0, max: SUSPICION_MAX, fallback: 0 }) < SUSPICION_MAX;
}

/**
 * 确定性判定一次报价（在**还没有**把这句报价 push 进 bribe.offers 之前调用）。
 *
 * @param {{ bribe: object, npc: object|null, offer: string }} input
 * @returns {{ verdict: string, suspicionDelta: number, price: string, score: number, reason: string }}
 */
export function evaluateOffer({ bribe, npc, offer } = {}) {
  if (!bribe) throw new BribeError("BAD_BRIBE", "缺少贿赂记录");
  const suspicion = clampInt(bribe.suspicion, { min: 0, max: SUSPICION_MAX, fallback: 0 });
  const attitude = clampInt(npc && npc.attitude, { min: -2, max: 2, fallback: 0 });
  const attempts = Array.isArray(bribe.offers) ? bribe.offers.length : 0;

  if (bribe.status === "cold" || suspicion >= SUSPICION_MAX) {
    return {
      verdict: "cold",
      suspicionDelta: 0,
      price: "",
      score: 0,
      reason: "对方已经不再听你说话",
    };
  }

  const strength = offerStrength(offer);
  const score = strength + (attitude + 2) * 0.5 - suspicion * 0.75 - attempts * 0.5;

  if (score >= THRESHOLDS.granted) {
    return {
      verdict: "granted",
      suspicionDelta: 0,
      price: "",
      score,
      reason: `报价够实在（强度 ${strength}），对方收了`,
    };
  }
  if (score >= THRESHOLDS.haggle) {
    return {
      verdict: "haggle",
      suspicionDelta: 1,
      price: priceHint({ npc, suspicion, want: bribe.want }),
      score,
      reason: "报价差一口气，对方开始抬价",
    };
  }
  const insulting = strength === 0;
  return {
    verdict: "refused",
    suspicionDelta: insulting ? 2 : 1,
    price: "",
    score,
    reason: insulting ? "空口白话，对方觉得被耍了" : "对方不吃这套",
  };
}

/**
 * 把判定结果落到贿赂记录上，返回**新对象**（不改原对象）。
 * 怀疑度撞顶时强制转 `cold` —— 这是唯一的自动状态迁移。
 *
 * @param {object} bribe
 * @param {{ verdict: string, suspicionDelta?: number, price?: string }} verdict
 * @param {number} now
 */
export function applyVerdict(bribe, verdict, now) {
  if (!bribe) throw new BribeError("BAD_BRIBE", "缺少贿赂记录");
  const incoming = verdict && VERDICTS.includes(verdict.verdict) ? verdict.verdict : "refused";
  const delta = clampInt(verdict && verdict.suspicionDelta, { min: -SUSPICION_MAX, max: SUSPICION_MAX, fallback: 0 });
  const suspicion = clampInt(
    clampInt(bribe.suspicion, { min: 0, max: SUSPICION_MAX, fallback: 0 }) + delta,
    { min: 0, max: SUSPICION_MAX, fallback: 0 },
  );

  let status = incoming;
  if (incoming === "granted") status = "granted";
  if (suspicion >= SUSPICION_MAX && status !== "granted") status = "cold";

  const price = oneLine(verdict && verdict.price, 240);

  return {
    ...bribe,
    status,
    suspicion,
    price: status === "haggle" ? price || bribe.price || priceHint({ npc: { name: bribe.npcName }, suspicion, want: bribe.want }) : "",
    updatedAt: clampInt(now, { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 }),
  };
}

/** 供界面显示的怀疑度标签。 */
export function suspicionLabel(value) {
  const level = clampInt(value, { min: 0, max: SUSPICION_MAX, fallback: 0 });
  if (level === 0) return "毫无戒心";
  if (level === 1) return "略有警觉";
  if (level === 2) return "开始留意";
  if (level === 3) return "明显起疑";
  if (level === 4) return "很不耐烦";
  return "彻底翻脸";
}
