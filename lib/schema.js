/**
 * dsh-trpg — 存档（state document）的唯一权威定义。
 *
 * 设计原则（对齐 dsh-explore 的 store 范式）：
 *   - 只有两个入口：`emptyState()` 造新档、`normalizeState(raw)` 收外来档。
 *   - `normalizeState` 对**形状**错误抛错（SchemaError），对**字段值**一律钳制而非拒绝
 *     —— 存档宁可被夹到合法区间，也不能因为一个越界的士气值整档打不开。
 *   - 所有派生数据（进度条百分比、NPC 态度标签…）不存盘，由宿主在 view 里现算。
 *
 * 浏览器半 `client/client.js` 无法 import 本模块（IIFE），其中的 LIMITS / 枚举
 * 在那边有一份必须保持同步的副本，见 CONTRACT.md。
 */

export const SCHEMA_VERSION = 1;

/** 线索账本的四种记录。GM 必须把「事实」和「玩家猜测」分开记，否则会自我剧透。 */
export const LEDGER_KINDS = ["FACT", "BELIEF", "HYPOTHESIS", "SECRET"];

export const LOG_ROLES = ["gm", "player", "system", "dice"];

export const BRIBE_STATUSES = ["open", "granted", "refused", "cold"];

/** 怀疑度到顶后 NPC 不再接受任何贿赂（status 变 cold）。 */
export const SUSPICION_MAX = 5;

export const LIMITS = {
  id: 64,
  name: 60,
  shortText: 240,
  text: 2000,
  premise: 4000,
  note: 600,
  maxLogPerCampaign: 300,
  maxLogTotal: 1200,
  maxStats: 12,
  maxClocks: 20,
  maxInventory: 60,
  maxFlags: 60,
  maxNpcs: 40,
  maxClues: 200,
  maxLedger: 300,
  maxBribes: 40,
  maxBribeOffers: 12,
  maxReveals: 12,
  maxPresent: 12,
  maxScenarioSections: 400,
  maxScenarioSource: 400000,
  fields: {
    snark: { min: 0, max: 5, fallback: 3 },
    maxContextChars: { min: 2000, max: 200000, fallback: 12000 },
    attitude: { min: -2, max: 2, fallback: 0 },
    suspicion: { min: 0, max: SUSPICION_MAX, fallback: 0 },
  },
};

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class SchemaError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SchemaError";
    this.code = code;
  }
}

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 钳到 [min,max] 整数。
 * 只接受真正的数字或非空数字字符串：`Number(null) === 0`、`Number("") === 0`
 * 会把「缺字段」静默钉到最小值，这是 dsh-explore 记过的坑。
 */
export function clampInt(value, { min, max, fallback }) {
  let numeric = Number.NaN;
  if (typeof value === "number") numeric = value;
  else if (typeof value === "string" && value.trim() !== "") numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const rounded = Math.round(numeric);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

export function clampText(value, max) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** 单行文本：把换行折成空格，用于标题 / 名称 / 短句。 */
export function oneLine(value, max) {
  return clampText(value, max).replace(/\s+/g, " ");
}

/** id 必须能安全地当作文件名片段（scenarios/<id>.json），所以字符集很窄。 */
export function safeId(value, fallback) {
  if (typeof value === "string" && ID_RE.test(value)) return value;
  return fallback;
}

export function clampBool(value, fallback) {
  if (typeof value === "boolean") return value;
  return fallback;
}

/* ------------------------------------------------------------------ 子结构 */

export function emptyScene() {
  return { name: "", place: "", time: "", present: [], mood: "neutral" };
}

export function normalizeScene(raw) {
  const source = isPlainObject(raw) ? raw : {};
  const present = Array.isArray(source.present)
    ? source.present
        .map((entry) => oneLine(entry, LIMITS.name))
        .filter(Boolean)
        .slice(0, LIMITS.maxPresent)
    : [];
  return {
    name: oneLine(source.name, LIMITS.name),
    place: oneLine(source.place, LIMITS.name),
    time: oneLine(source.time, LIMITS.name),
    present: [...new Set(present)],
    mood: oneLine(source.mood, 24) || "neutral",
  };
}

export function emptyStat(id, name, max) {
  return { id, name, value: max, max, note: "" };
}

export function normalizeStat(raw, fallbackId) {
  const source = isPlainObject(raw) ? raw : {};
  const max = clampInt(source.max, { min: 1, max: 100000, fallback: 10 });
  const value = clampInt(source.value, { min: 0, max, fallback: max });
  return {
    id: safeId(source.id, fallbackId),
    name: oneLine(source.name, LIMITS.name) || "属性",
    value,
    max,
    note: clampText(source.note, LIMITS.note),
  };
}

export function normalizeClock(raw, fallbackId) {
  const source = isPlainObject(raw) ? raw : {};
  const max = clampInt(source.max, { min: 1, max: 100, fallback: 4 });
  const value = clampInt(source.value, { min: 0, max, fallback: 0 });
  return {
    id: safeId(source.id, fallbackId),
    name: oneLine(source.name, LIMITS.name) || "倒计时",
    value,
    max,
    note: clampText(source.note, LIMITS.note),
  };
}

export function normalizeInventory(raw, fallbackId) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    id: safeId(source.id, fallbackId),
    name: oneLine(source.name, LIMITS.name) || "物品",
    qty: clampInt(source.qty, { min: 0, max: 9999, fallback: 1 }),
    note: clampText(source.note, LIMITS.note),
  };
}

export function normalizeNpc(raw, fallbackId) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    id: safeId(source.id, fallbackId),
    name: oneLine(source.name, LIMITS.name) || "无名氏",
    attitude: clampInt(source.attitude, LIMITS.fields.attitude),
    note: clampText(source.note, LIMITS.note),
    secret: clampText(source.secret, LIMITS.text),
    revealed: clampBool(source.revealed, false),
  };
}

export function normalizeClue(raw, fallbackId) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    id: safeId(source.id, fallbackId),
    text: clampText(source.text, LIMITS.text),
    found: clampBool(source.found, false),
  };
}

export function normalizeLedgerEntry(raw, fallbackId) {
  const source = isPlainObject(raw) ? raw : {};
  const kind = LEDGER_KINDS.includes(source.kind) ? source.kind : "FACT";
  return {
    id: safeId(source.id, fallbackId),
    kind,
    text: clampText(source.text, LIMITS.text),
    scene: oneLine(source.scene, LIMITS.name),
    turn: clampInt(source.turn, { min: 0, max: 1000000, fallback: 0 }),
  };
}

export function normalizeBribeOffer(raw) {
  const source = isPlainObject(raw) ? raw : {};
  return { text: clampText(source.text, LIMITS.text), at: clampInt(source.at, { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 }) };
}

export function normalizeBribe(raw, fallbackId) {
  const source = isPlainObject(raw) ? raw : {};
  const status = BRIBE_STATUSES.includes(source.status) ? source.status : "open";
  const offers = Array.isArray(source.offers)
    ? source.offers.map(normalizeBribeOffer).filter((entry) => entry.text).slice(-LIMITS.maxBribeOffers)
    : [];
  const reveals = Array.isArray(source.reveals)
    ? source.reveals.map((entry) => oneLine(entry, LIMITS.name)).filter(Boolean).slice(0, LIMITS.maxReveals)
    : [];
  return {
    id: safeId(source.id, fallbackId),
    npcId: safeId(source.npcId, ""),
    npcName: oneLine(source.npcName, LIMITS.name) || "某人",
    want: clampText(source.want, LIMITS.text),
    price: clampText(source.price, LIMITS.text),
    status,
    suspicion: clampInt(source.suspicion, LIMITS.fields.suspicion),
    offers,
    reveals,
    createdAt: clampInt(source.createdAt, { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 }),
    updatedAt: clampInt(source.updatedAt, { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 }),
  };
}

export function normalizeLogEntry(raw, fallbackId) {
  const source = isPlainObject(raw) ? raw : {};
  const role = LOG_ROLES.includes(source.role) ? source.role : "system";
  return {
    id: safeId(source.id, fallbackId),
    campaignId: safeId(source.campaignId, ""),
    seq: clampInt(source.seq, { min: 0, max: 100000000, fallback: 0 }),
    role,
    text: clampText(source.text, LIMITS.text * 4),
    meta: isPlainObject(source.meta) ? source.meta : {},
    createdAt: clampInt(source.createdAt, { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 }),
  };
}

export function emptySettings() {
  return {
    model: null,
    autoRoll: true,
    snark: LIMITS.fields.snark.fallback,
    maxContextChars: LIMITS.fields.maxContextChars.fallback,
  };
}

export function normalizeSettings(raw) {
  const source = isPlainObject(raw) ? raw : {};
  let model = null;
  if (isPlainObject(source.model)) {
    const provider = oneLine(source.model.provider, 64);
    const name = oneLine(source.model.model, 128);
    if (provider && name) model = { provider, model: name };
  }
  return {
    model,
    autoRoll: clampBool(source.autoRoll, true),
    snark: clampInt(source.snark, LIMITS.fields.snark),
    maxContextChars: clampInt(source.maxContextChars, LIMITS.fields.maxContextChars),
  };
}

/* ------------------------------------------------------------------- 战役 */

export function emptyCampaign(id, now, seed = {}) {
  return {
    id,
    name: oneLine(seed.name, LIMITS.name) || "无名战役",
    premise: clampText(seed.premise, LIMITS.premise),
    tone: oneLine(seed.tone, LIMITS.name) || "轻松",
    pcName: oneLine(seed.pcName, LIMITS.name) || "调查员",
    createdAt: now,
    updatedAt: now,
    scene: emptyScene(),
    stats: [],
    clocks: [],
    inventory: [],
    flags: [],
    npcs: [],
    clues: [],
    ledger: [],
    bribes: [],
    turn: 0,
  };
}

function normalizeIdList(items, prefix, limit, normalizeOne) {
  const out = [];
  const seen = new Set();
  const list = Array.isArray(items) ? items : [];
  for (let index = 0; index < list.length && out.length < limit; index += 1) {
    const entry = normalizeOne(list[index], `${prefix}${index + 1}`);
    if (!entry.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    out.push(entry);
  }
  return out;
}

export function normalizeCampaign(raw, now) {
  const source = isPlainObject(raw) ? raw : {};
  const id = safeId(source.id, "");
  if (!id) throw new SchemaError("BAD_SHAPE", "campaign 缺少合法 id");
  const stats = normalizeIdList(source.stats, "st", LIMITS.maxStats, normalizeStat);
  const base = emptyCampaign(id, clampInt(source.createdAt, { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: now }), source);
  return {
    ...base,
    updatedAt: clampInt(source.updatedAt, { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: base.createdAt }),
    scene: normalizeScene(source.scene),
    stats,
    clocks: normalizeIdList(source.clocks, "ck", LIMITS.maxClocks, normalizeClock),
    inventory: normalizeIdList(source.inventory, "it", LIMITS.maxInventory, normalizeInventory),
    flags: Array.isArray(source.flags)
      ? [...new Set(source.flags.map((flag) => oneLine(flag, LIMITS.name)).filter(Boolean))].slice(0, LIMITS.maxFlags)
      : [],
    npcs: normalizeIdList(source.npcs, "np", LIMITS.maxNpcs, normalizeNpc),
    clues: normalizeIdList(source.clues, "cl", LIMITS.maxClues, normalizeClue),
    ledger: normalizeIdList(source.ledger, "lg", LIMITS.maxLedger, normalizeLedgerEntry),
    bribes: normalizeIdList(source.bribes, "br", LIMITS.maxBribes, normalizeBribe),
    turn: clampInt(source.turn, { min: 0, max: 1000000, fallback: 0 }),
  };
}

export function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    activeCampaignId: null,
    campaigns: [],
    log: [],
    settings: emptySettings(),
    updatedAt: 0,
  };
}

/* --------------------------------------------------------------- 全档入口 */

function normalizeLog(rawLog, campaignIds) {
  const list = Array.isArray(rawLog) ? rawLog : [];
  const kept = [];
  const seen = new Set();
  for (let index = 0; index < list.length; index += 1) {
    const entry = normalizeLogEntry(list[index], `log${index + 1}`);
    if (!entry.id || seen.has(entry.id)) continue;
    if (entry.campaignId && !campaignIds.has(entry.campaignId)) continue; // 孤儿线报直接丢
    seen.add(entry.id);
    kept.push(entry);
  }
  return kept.length > LIMITS.maxLogTotal ? kept.slice(kept.length - LIMITS.maxLogTotal) : kept;
}

/**
 * @param {unknown} raw 从 state.json 解析出来的任意值
 * @returns {object} 合法存档
 * @throws {SchemaError} 形状级错误（NOT_AN_OBJECT / MISSING_SCHEMA_VERSION / SCHEMA_TOO_NEW / SCHEMA_TOO_OLD / BAD_SHAPE）
 */
export function normalizeState(raw) {
  if (!isPlainObject(raw)) throw new SchemaError("NOT_AN_OBJECT", "state 必须是一个 JSON 对象");
  const version = raw.schemaVersion;
  if (typeof version !== "number" || !Number.isFinite(version)) {
    throw new SchemaError("MISSING_SCHEMA_VERSION", "state.schemaVersion 缺失或不是数字");
  }
  if (version > SCHEMA_VERSION) {
    throw new SchemaError("SCHEMA_TOO_NEW", `state.schemaVersion=${version} 高于本插件支持的 ${SCHEMA_VERSION}`);
  }
  if (version < SCHEMA_VERSION) {
    throw new SchemaError("SCHEMA_TOO_OLD", `state.schemaVersion=${version} 低于本插件支持的 ${SCHEMA_VERSION}`);
  }
  if (!Array.isArray(raw.campaigns) || !Array.isArray(raw.log)) {
    throw new SchemaError("BAD_SHAPE", "state.campaigns 与 state.log 必须是数组");
  }

  const now = Date.now();
  const campaigns = [];
  const seenCampaign = new Set();
  for (const entry of raw.campaigns) {
    let normalized;
    try {
      normalized = normalizeCampaign(entry, now);
    } catch {
      continue; // 单个坏战役不该拖垮整档
    }
    if (seenCampaign.has(normalized.id)) continue;
    seenCampaign.add(normalized.id);
    campaigns.push(normalized);
  }

  const log = normalizeLog(raw.log, seenCampaign);

  let activeCampaignId = safeId(raw.activeCampaignId, "");
  if (!activeCampaignId || !seenCampaign.has(activeCampaignId)) {
    activeCampaignId = campaigns.length ? campaigns[0].id : null;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    activeCampaignId,
    campaigns,
    log,
    settings: normalizeSettings(raw.settings),
    updatedAt: clampInt(raw.updatedAt, { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 }),
  };
}

export function serializeState(state) {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function campaignById(state, id) {
  return state.campaigns.find((entry) => entry.id === id) || null;
}

export function activeCampaign(state) {
  if (!state.activeCampaignId) return null;
  return campaignById(state, state.activeCampaignId);
}

export function campaignLog(state, campaignId, limit) {
  const entries = state.log.filter((entry) => entry.campaignId === campaignId);
  if (typeof limit === "number" && limit > 0 && entries.length > limit) {
    return entries.slice(entries.length - limit);
  }
  return entries;
}
