/**
 * dsh-trpg — 命令层：**唯一的写入权威**。
 *
 * 界面永远不发「半个节点」，只发一个命令；命令在这里被校验、钳制、应用，然后由调用方落盘。
 * 这样做的代价是这个文件很长，收益是存档永远不会出现界面拼出来的非法状态。
 *
 * 骰子与检定**不在这里实现**：宿主把 `ctx.roll` / `ctx.check` 注入进来（真实实现来自 dice.js）。
 * 好处是命令层完全可确定性测试（注入假骰子即可），也让随机性只有一处源头。
 */

import {
  BRIBE_STATUSES,
  LEDGER_KINDS,
  LIMITS,
  LOG_ROLES,
  SUSPICION_MAX,
  SchemaError,
  activeCampaign,
  campaignById,
  clampInt,
  clampText,
  emptyCampaign,
  isPlainObject,
  oneLine,
  safeId,
} from "./schema.js";
import { VERDICTS, applyVerdict, evaluateOffer } from "./bribe.js";

export class CommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

/** 新建战役时预置的属性，覆盖 COC 7e 的常见四项；用 `preset:"none"` 可关掉。 */
export const COC_PRESET = [
  { name: "生命", max: 10 },
  { name: "理智", max: 60 },
  { name: "幸运", max: 50 },
  { name: "魔法", max: 12 },
];

let fallbackSeq = 0;
function fallbackId(prefix) {
  fallbackSeq += 1;
  return `${prefix}_${Date.now().toString(36)}${fallbackSeq.toString(36)}`;
}

function normalizeCtx(ctx) {
  const source = isPlainObject(ctx) ? ctx : {};
  return {
    now: typeof source.now === "function" ? source.now : Date.now,
    id: typeof source.id === "function" ? source.id : fallbackId,
    roll: typeof source.roll === "function" ? source.roll : null,
    check: typeof source.check === "function" ? source.check : null,
  };
}

/* ------------------------------------------------------------------ 小工具 */

function touch(campaign, now) {
  campaign.updatedAt = now;
}

function resolveCampaign(state, command) {
  const wanted = safeId(command.campaignId, "");
  if (wanted) {
    const found = campaignById(state, wanted);
    if (!found) throw new CommandError("CAMPAIGN_NOT_FOUND", `找不到战役 ${wanted}`);
    return found;
  }
  const fallback = activeCampaign(state);
  if (!fallback) throw new CommandError("NO_ACTIVE_CAMPAIGN", "当前没有活动战役");
  return fallback;
}

function findByName(list, name) {
  const needle = oneLine(name, LIMITS.name).toLowerCase();
  if (!needle) return null;
  // 线索只有 text 没有 name，所以这里不能假定 entry.name 一定存在。
  return list.find((entry) => (typeof entry.name === "string" ? entry.name.toLowerCase() : "") === needle) || null;
}

function findByRef(list, ref) {
  const key = typeof ref === "string" ? ref.trim() : "";
  if (!key) return null;
  return list.find((entry) => entry.id === key) || findByName(list, key);
}

function nextSeq(state, campaignId) {
  let max = 0;
  for (const entry of state.log) {
    if (entry.campaignId === campaignId && entry.seq > max) max = entry.seq;
  }
  return max + 1;
}

function appendLog(state, campaign, ctx, { role, text, meta }) {
  const entry = {
    id: ctx.id("log"),
    campaignId: campaign.id,
    seq: nextSeq(state, campaign.id),
    role: LOG_ROLES.includes(role) ? role : "system",
    text: clampText(text, LIMITS.text * 4),
    meta: isPlainObject(meta) ? meta : {},
    createdAt: ctx.now(),
  };
  state.log.push(entry);
  trimLog(state, campaign.id);
  return entry;
}

function trimLog(state, campaignId) {
  const mine = state.log.filter((entry) => entry.campaignId === campaignId);
  if (mine.length > LIMITS.maxLogPerCampaign) {
    const drop = new Set(mine.slice(0, mine.length - LIMITS.maxLogPerCampaign).map((entry) => entry.id));
    state.log = state.log.filter((entry) => !drop.has(entry.id));
  }
  if (state.log.length > LIMITS.maxLogTotal) {
    state.log = state.log.slice(state.log.length - LIMITS.maxLogTotal);
  }
}

function requireText(value, code, label) {
  const text = clampText(value, LIMITS.text);
  if (!text) throw new CommandError(code, `${label}不能为空`);
  return text;
}

function pushUnique(list, value, max) {
  if (list.includes(value)) return false;
  list.push(value);
  if (list.length > max) list.splice(0, list.length - max);
  return true;
}

/* ------------------------------------------------------------------ 战役 */

const campaignHandlers = {
  "campaign.create"(state, command, ctx) {
    const id = safeId(command.campaignId, "") || ctx.id("c");
    if (campaignById(state, id)) throw new CommandError("CAMPAIGN_EXISTS", `战役 ${id} 已存在`);
    const now = ctx.now();
    const campaign = emptyCampaign(id, now, command);
    const preset = command.preset === "none" ? [] : Array.isArray(command.stats) ? command.stats : COC_PRESET;
    preset.slice(0, LIMITS.maxStats).forEach((entry, index) => {
      const max = clampInt(entry && entry.max, { min: 1, max: 100000, fallback: 10 });
      campaign.stats.push({
        id: ctx.id("st"),
        name: oneLine(entry && entry.name, LIMITS.name) || `属性${index + 1}`,
        value: clampInt(entry && entry.value, { min: 0, max, fallback: max }),
        max,
        note: "",
      });
    });
    state.campaigns.push(campaign);
    state.activeCampaignId = campaign.id;
    return { campaignId: campaign.id, result: { campaignId: campaign.id } };
  },

  "campaign.select"(state, command) {
    const id = safeId(command.campaignId, "");
    if (!id || !campaignById(state, id)) throw new CommandError("CAMPAIGN_NOT_FOUND", `找不到战役 ${id}`);
    state.activeCampaignId = id;
    return { campaignId: id, result: { campaignId: id } };
  },

  "campaign.patch"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    if (command.name !== undefined) campaign.name = oneLine(command.name, LIMITS.name) || campaign.name;
    if (command.premise !== undefined) campaign.premise = clampText(command.premise, LIMITS.premise);
    if (command.tone !== undefined) campaign.tone = oneLine(command.tone, LIMITS.name) || campaign.tone;
    if (command.pcName !== undefined) campaign.pcName = oneLine(command.pcName, LIMITS.name) || campaign.pcName;
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { campaignId: campaign.id } };
  },

  "campaign.delete"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const id = campaign.id;
    state.campaigns = state.campaigns.filter((entry) => entry.id !== id);
    state.log = state.log.filter((entry) => entry.campaignId !== id);
    if (state.activeCampaignId === id) state.activeCampaignId = state.campaigns.length ? state.campaigns[0].id : null;
    // 剧本文件由宿主负责删（命令层不碰文件系统），result 里回传 id 供宿主调用 store.dropScenario。
    return { campaignId: null, result: { campaignId: id, dropScenario: id, at: ctx.now() } };
  },
};

/* ------------------------------------------------------------------ 场景 */

const sceneHandlers = {
  "scene.set"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const scene = campaign.scene;
    if (command.name !== undefined) scene.name = oneLine(command.name, LIMITS.name);
    if (command.place !== undefined) scene.place = oneLine(command.place, LIMITS.name);
    if (command.time !== undefined) scene.time = oneLine(command.time, LIMITS.name);
    if (command.mood !== undefined) scene.mood = oneLine(command.mood, 24) || "neutral";
    if (Array.isArray(command.present)) {
      scene.present = [...new Set(command.present.map((name) => oneLine(name, LIMITS.name)).filter(Boolean))].slice(
        0,
        LIMITS.maxPresent,
      );
    }
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { scene } };
  },
};

/* -------------------------------------------------------------- 数值/进度 */

const statHandlers = {
  "stat.define"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const name = oneLine(command.name, LIMITS.name);
    if (!name) throw new CommandError("BAD_NAME", "属性名不能为空");
    const max = clampInt(command.max, { min: 1, max: 100000, fallback: 10 });
    let stat = findByName(campaign.stats, name);
    if (stat) {
      stat.max = max;
      stat.value = clampInt(command.value, { min: 0, max, fallback: stat.value });
    } else {
      if (campaign.stats.length >= LIMITS.maxStats) throw new CommandError("LIMIT_REACHED", "属性数量已达上限");
      stat = {
        id: ctx.id("st"),
        name,
        value: clampInt(command.value, { min: 0, max, fallback: max }),
        max,
        note: clampText(command.note, LIMITS.note),
      };
      campaign.stats.push(stat);
    }
    if (command.note !== undefined) stat.note = clampText(command.note, LIMITS.note);
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { stat } };
  },

  "stat.set"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const stat = findByRef(campaign.stats, command.statId || command.name);
    if (!stat) throw new CommandError("STAT_NOT_FOUND", "找不到该属性");
    const hasDelta = command.delta !== undefined && command.delta !== null && command.delta !== "";
    const before = stat.value;
    if (hasDelta) {
      const delta = clampInt(command.delta, { min: -100000, max: 100000, fallback: 0 });
      stat.value = clampInt(before + delta, { min: 0, max: stat.max, fallback: before });
    } else if (command.value !== undefined) {
      stat.value = clampInt(command.value, { min: 0, max: stat.max, fallback: before });
    }
    if (command.max !== undefined) {
      stat.max = clampInt(command.max, { min: 1, max: 100000, fallback: stat.max });
      stat.value = clampInt(stat.value, { min: 0, max: stat.max, fallback: stat.value });
    }
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { stat, before } };
  },

  "stat.remove"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const stat = findByRef(campaign.stats, command.statId || command.name);
    if (!stat) throw new CommandError("STAT_NOT_FOUND", "找不到该属性");
    campaign.stats = campaign.stats.filter((entry) => entry.id !== stat.id);
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { statId: stat.id } };
  },
};

const clockHandlers = {
  "clock.add"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const name = oneLine(command.name, LIMITS.name);
    if (!name) throw new CommandError("BAD_NAME", "进度名不能为空");
    if (campaign.clocks.length >= LIMITS.maxClocks) throw new CommandError("LIMIT_REACHED", "进度数量已达上限");
    const max = clampInt(command.max, { min: 1, max: 100, fallback: 4 });
    const clock = {
      id: ctx.id("ck"),
      name,
      value: clampInt(command.value, { min: 0, max, fallback: 0 }),
      max,
      note: clampText(command.note, LIMITS.note),
    };
    campaign.clocks.push(clock);
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { clock } };
  },

  "clock.set"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const clock = findByRef(campaign.clocks, command.clockId || command.name);
    if (!clock) throw new CommandError("CLOCK_NOT_FOUND", "找不到该进度");
    const hasDelta = command.delta !== undefined && command.delta !== null && command.delta !== "";
    if (hasDelta) {
      clock.value = clampInt(clock.value + clampInt(command.delta, { min: -1000, max: 1000, fallback: 0 }), {
        min: 0,
        max: clock.max,
        fallback: clock.value,
      });
    } else if (command.value !== undefined) {
      clock.value = clampInt(command.value, { min: 0, max: clock.max, fallback: clock.value });
    }
    if (command.max !== undefined) {
      clock.max = clampInt(command.max, { min: 1, max: 100, fallback: clock.max });
      clock.value = clampInt(clock.value, { min: 0, max: clock.max, fallback: clock.value });
    }
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { clock } };
  },

  "clock.remove"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const clock = findByRef(campaign.clocks, command.clockId || command.name);
    if (!clock) throw new CommandError("CLOCK_NOT_FOUND", "找不到该进度");
    campaign.clocks = campaign.clocks.filter((entry) => entry.id !== clock.id);
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { clockId: clock.id } };
  },
};

/* ------------------------------------------------------------ 物品与标记 */

const itemHandlers = {
  "inventory.add"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const name = oneLine(command.name, LIMITS.name);
    if (!name) throw new CommandError("BAD_NAME", "物品名不能为空");
    const qty = clampInt(command.qty, { min: 1, max: 9999, fallback: 1 });
    let item = findByName(campaign.inventory, name);
    if (item) {
      item.qty = clampInt(item.qty + qty, { min: 0, max: 9999, fallback: item.qty });
    } else {
      if (campaign.inventory.length >= LIMITS.maxInventory) throw new CommandError("LIMIT_REACHED", "物品数量已达上限");
      item = { id: ctx.id("it"), name, qty, note: clampText(command.note, LIMITS.note) };
      campaign.inventory.push(item);
    }
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { item } };
  },

  "inventory.remove"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const item = findByRef(campaign.inventory, command.itemId || command.name);
    if (!item) throw new CommandError("ITEM_NOT_FOUND", "找不到该物品");
    const qty = clampInt(command.qty, { min: 1, max: 9999, fallback: item.qty });
    const next = item.qty - qty;
    if (next > 0) item.qty = next;
    else campaign.inventory = campaign.inventory.filter((entry) => entry.id !== item.id);
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { itemId: item.id, qty: Math.max(0, next) } };
  },

  "flag.add"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const flag = oneLine(command.text ?? command.name, LIMITS.name);
    if (!flag) throw new CommandError("BAD_TEXT", "标记内容不能为空");
    pushUnique(campaign.flags, flag, LIMITS.maxFlags);
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { flag } };
  },

  "flag.remove"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const flag = oneLine(command.text ?? command.name, LIMITS.name);
    campaign.flags = campaign.flags.filter((entry) => entry !== flag);
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { flag } };
  },
};

/* ------------------------------------------------------------------- NPC */

const npcHandlers = {
  "npc.add"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const name = oneLine(command.name, LIMITS.name);
    if (!name) throw new CommandError("BAD_NAME", "NPC 名不能为空");
    let npc = findByName(campaign.npcs, name);
    if (!npc) {
      if (campaign.npcs.length >= LIMITS.maxNpcs) throw new CommandError("LIMIT_REACHED", "NPC 数量已达上限");
      npc = {
        id: ctx.id("np"),
        name,
        attitude: clampInt(command.attitude, LIMITS.fields.attitude),
        note: clampText(command.note, LIMITS.note),
        secret: clampText(command.secret, LIMITS.text),
        revealed: false,
      };
      campaign.npcs.push(npc);
    } else {
      if (command.attitude !== undefined) npc.attitude = clampInt(command.attitude, LIMITS.fields.attitude);
      if (command.note !== undefined) npc.note = clampText(command.note, LIMITS.note);
      if (command.secret !== undefined) npc.secret = clampText(command.secret, LIMITS.text);
    }
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { npc } };
  },

  "npc.patch"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const npc = findByRef(campaign.npcs, command.npcId || command.name);
    if (!npc) throw new CommandError("NPC_NOT_FOUND", "找不到该 NPC");
    if (command.newName !== undefined) npc.name = oneLine(command.newName, LIMITS.name) || npc.name;
    if (command.attitude !== undefined) npc.attitude = clampInt(command.attitude, LIMITS.fields.attitude);
    if (command.note !== undefined) npc.note = clampText(command.note, LIMITS.note);
    if (command.secret !== undefined) npc.secret = clampText(command.secret, LIMITS.text);
    if (command.revealed !== undefined) npc.revealed = Boolean(command.revealed);
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { npc } };
  },

  "npc.remove"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const npc = findByRef(campaign.npcs, command.npcId || command.name);
    if (!npc) throw new CommandError("NPC_NOT_FOUND", "找不到该 NPC");
    campaign.npcs = campaign.npcs.filter((entry) => entry.id !== npc.id);
    campaign.bribes = campaign.bribes.filter((entry) => entry.npcId !== npc.id);
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { npcId: npc.id } };
  },
};

/* -------------------------------------------------------------- 线索/账本 */

const clueHandlers = {
  "clue.add"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const text = requireText(command.text, "BAD_TEXT", "线索内容");
    if (campaign.clues.length >= LIMITS.maxClues) throw new CommandError("LIMIT_REACHED", "线索数量已达上限");
    const clue = { id: ctx.id("cl"), text, found: Boolean(command.found) };
    campaign.clues.push(clue);
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { clue } };
  },

  "clue.reveal"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const clue = findByRef(campaign.clues, command.clueId) || (command.index !== undefined ? campaign.clues[clampInt(command.index, { min: 0, max: Math.max(0, campaign.clues.length - 1), fallback: 0 })] : null);
    if (!clue) throw new CommandError("CLUE_NOT_FOUND", "找不到该线索");
    clue.found = true;
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { clue } };
  },

  "clue.remove"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const clue = findByRef(campaign.clues, command.clueId);
    if (!clue) throw new CommandError("CLUE_NOT_FOUND", "找不到该线索");
    campaign.clues = campaign.clues.filter((entry) => entry.id !== clue.id);
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { clueId: clue.id } };
  },

  "ledger.add"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const text = requireText(command.text, "BAD_TEXT", "账本内容");
    const kind = LEDGER_KINDS.includes(command.kind) ? command.kind : "FACT";
    if (campaign.ledger.length >= LIMITS.maxLedger) campaign.ledger.shift();
    const entry = { id: ctx.id("lg"), kind, text, scene: campaign.scene.name, turn: campaign.turn };
    campaign.ledger.push(entry);
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { entry } };
  },
};

/* ---------------------------------------------------------------- 线报 */

const logHandlers = {
  "log.append"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const role = LOG_ROLES.includes(command.role) ? command.role : "system";
    const entry = appendLog(state, campaign, ctx, { role, text: command.text, meta: command.meta });
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { entry } };
  },

  "log.clear"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const before = state.log.length;
    state.log = state.log.filter((entry) => entry.campaignId !== campaign.id);
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { removed: before - state.log.length, at: ctx.now() } };
  },

  "turn.bump"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    campaign.turn = clampInt(campaign.turn + 1, { min: 0, max: 1000000, fallback: campaign.turn });
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { turn: campaign.turn } };
  },
};

/* ------------------------------------------------------------------ 骰子 */

const diceHandlers = {
  "dice.roll"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    if (!ctx.roll) throw new CommandError("NO_ROLLER", "宿主未注入骰子");
    const roll = ctx.roll({ formula: command.formula, dc: command.dc, reason: command.reason });
    const badge = roll.dc === null || roll.dc === undefined ? "" : roll.total >= roll.dc ? " → 达成" : " → 未达成";
    const entry = appendLog(state, campaign, ctx, {
      role: "dice",
      text: `${roll.text} = ${roll.total}${badge}${roll.reason ? `（${roll.reason}）` : ""}`,
      meta: { kind: "roll", ...roll },
    });
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { roll, entry } };
  },

  "dice.check"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    if (!ctx.check) throw new CommandError("NO_ROLLER", "宿主未注入检定器");
    const check = ctx.check({
      skill: command.skill,
      target: command.target,
      difficulty: command.difficulty,
      bonusDice: command.bonusDice,
      penaltyDice: command.penaltyDice,
    });
    const entry = appendLog(state, campaign, ctx, {
      role: "dice",
      text: check.description,
      meta: { kind: "check", ...check },
    });
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { check, entry } };
  },
};

/* ------------------------------------------------------------------ 贿赂 */

function revealSecret(state, campaign, npc, bribe, ctx) {
  if (!npc || !npc.secret || npc.revealed) return null;
  npc.revealed = true;
  bribe.reveals = Array.isArray(bribe.reveals) ? bribe.reveals : [];
  if (!bribe.reveals.includes(npc.secret)) bribe.reveals.push(npc.secret);
  campaign.ledger.push({
    id: ctx.id("lg"),
    kind: "SECRET",
    text: `${npc.name}：${npc.secret}`,
    scene: campaign.scene.name,
    turn: campaign.turn,
  });
  if (campaign.ledger.length > LIMITS.maxLedger) campaign.ledger.shift();
  appendLog(state, campaign, ctx, {
    role: "system",
    text: `【情报】${npc.name} 松了口：${npc.secret}`,
    meta: { kind: "reveal", npcId: npc.id, bribeId: bribe.id },
  });
  return npc.secret;
}

const bribeHandlers = {
  "bribe.open"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const npcName = oneLine(command.npcName, LIMITS.name);
    if (!npcName) throw new CommandError("BAD_NAME", "要贿赂谁？");
    let npc = findByName(campaign.npcs, npcName);
    if (!npc) {
      if (campaign.npcs.length >= LIMITS.maxNpcs) throw new CommandError("LIMIT_REACHED", "NPC 数量已达上限");
      npc = {
        id: ctx.id("np"),
        name: npcName,
        attitude: clampInt(command.attitude, LIMITS.fields.attitude),
        note: "",
        secret: clampText(command.secret, LIMITS.text),
        revealed: false,
      };
      campaign.npcs.push(npc);
    }
    const existing = campaign.bribes.find((entry) => entry.npcId === npc.id && entry.status === "open");
    if (existing) return { campaignId: campaign.id, result: { bribe: existing, created: false } };

    if (campaign.bribes.length >= LIMITS.maxBribes) campaign.bribes.shift();
    const now = ctx.now();
    const bribe = {
      id: ctx.id("br"),
      npcId: npc.id,
      npcName: npc.name,
      want: clampText(command.want, LIMITS.text),
      price: "",
      status: "open",
      suspicion: 0,
      offers: [],
      reveals: [],
      createdAt: now,
      updatedAt: now,
    };
    campaign.bribes.push(bribe);
    touch(campaign, now);
    return { campaignId: campaign.id, result: { bribe, created: true, npc } };
  },

  /**
   * 一次报价。若调用方（模型）给了 verdict 就用它的，否则用 bribe.js 的确定性兜底。
   * 这是「模型想怎样」和「规则说了算」的和解点。
   */
  "bribe.offer"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const bribe = campaign.bribes.find((entry) => entry.id === safeId(command.bribeId, ""));
    if (!bribe) throw new CommandError("BRIBE_NOT_FOUND", "找不到这笔交易");
    const npc = campaign.npcs.find((entry) => entry.id === bribe.npcId) || null;
    const text = requireText(command.text, "BAD_TEXT", "报价");

    const modelVerdict = VERDICTS.includes(command.verdict) ? command.verdict : null;
    const fallback = evaluateOffer({ bribe, npc, offer: text });
    const decision = modelVerdict
      ? {
          verdict: modelVerdict,
          suspicionDelta: clampInt(command.suspicionDelta, { min: -SUSPICION_MAX, max: SUSPICION_MAX, fallback: 0 }),
          price: clampText(command.price, LIMITS.text),
          reason: "由 GM 判定",
        }
      : fallback;

    bribe.offers.push({ text, at: ctx.now() });
    if (bribe.offers.length > LIMITS.maxBribeOffers) bribe.offers = bribe.offers.slice(-LIMITS.maxBribeOffers);

    const applied = applyVerdict(bribe, decision, ctx.now());
    Object.assign(bribe, applied);

    let revealed = null;
    if (bribe.status === "granted" && command.reveal !== false) {
      revealed = revealSecret(state, campaign, npc, bribe, ctx);
    }
    touch(campaign, ctx.now());
    return {
      campaignId: campaign.id,
      result: { bribe, verdict: bribe.status, reason: decision.reason, revealed, mechanical: !modelVerdict },
    };
  },

  "bribe.settle"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const bribe = campaign.bribes.find((entry) => entry.id === safeId(command.bribeId, ""));
    if (!bribe) throw new CommandError("BRIBE_NOT_FOUND", "找不到这笔交易");
    const status = BRIBE_STATUSES.includes(command.status) ? command.status : bribe.status;
    const npc = campaign.npcs.find((entry) => entry.id === bribe.npcId) || null;
    const applied = applyVerdict(
      bribe,
      { verdict: status, suspicionDelta: command.suspicionDelta, price: command.price },
      ctx.now(),
    );
    Object.assign(bribe, applied);
    let revealed = null;
    if (bribe.status === "granted" && command.reveal === true) {
      revealed = revealSecret(state, campaign, npc, bribe, ctx);
    }
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { bribe, revealed } };
  },

  "bribe.reveal"(state, command, ctx) {
    const campaign = resolveCampaign(state, command);
    const bribe = campaign.bribes.find((entry) => entry.id === safeId(command.bribeId, ""));
    if (!bribe) throw new CommandError("BRIBE_NOT_FOUND", "找不到这笔交易");
    const npc = campaign.npcs.find((entry) => entry.id === bribe.npcId) || null;
    const revealed = revealSecret(state, campaign, npc, bribe, ctx);
    touch(campaign, ctx.now());
    return { campaignId: campaign.id, result: { revealed } };
  },
};

/* ------------------------------------------------------------------ 设置 */

const settingsHandlers = {
  "settings.patch"(state, command) {
    const settings = state.settings;
    if (command.model === null) settings.model = null;
    else if (isPlainObject(command.model)) {
      const provider = oneLine(command.model.provider, 64);
      const model = oneLine(command.model.model, 128);
      if (provider && model) settings.model = { provider, model };
      else throw new CommandError("BAD_MODEL", "provider 与 model 都不能为空");
    }
    if (command.autoRoll !== undefined) settings.autoRoll = Boolean(command.autoRoll);
    if (command.snark !== undefined) settings.snark = clampInt(command.snark, LIMITS.fields.snark);
    if (command.maxContextChars !== undefined) {
      settings.maxContextChars = clampInt(command.maxContextChars, LIMITS.fields.maxContextChars);
    }
    return { campaignId: state.activeCampaignId, result: { settings } };
  },
};

/* ---------------------------------------------------------------- 分发表 */

export const handlers = {
  ...campaignHandlers,
  ...sceneHandlers,
  ...statHandlers,
  ...clockHandlers,
  ...itemHandlers,
  ...npcHandlers,
  ...clueHandlers,
  ...logHandlers,
  ...diceHandlers,
  ...bribeHandlers,
  ...settingsHandlers,
};

export const COMMAND_TYPES = Object.keys(handlers);

/**
 * 应用一个命令。**会就地修改 `state`**，落盘由调用方负责（store.mutate）。
 *
 * @param {object} state 合法存档（normalizeState 的产物）
 * @param {{ type: string }} command
 * @param {{ now?: Function, id?: Function, roll?: Function, check?: Function }} [ctx]
 * @returns {{ campaignId: string|null, result: any }}
 * @throws {CommandError|SchemaError}
 */
export function applyCommand(state, command, ctx) {
  if (!isPlainObject(command)) throw new CommandError("BAD_COMMAND", "命令必须是对象");
  const type = typeof command.type === "string" ? command.type : "";
  const handler = handlers[type];
  if (!handler) throw new CommandError("UNKNOWN_COMMAND", `未知命令：${type || "(空)"}`);
  if (!isPlainObject(state)) throw new SchemaError("NOT_AN_OBJECT", "state 必须是对象");
  return handler(state, command, normalizeCtx(ctx));
}

/** 供 HTTP 层统一把命令错误转成响应体。 */
export function commandFailure(error) {
  const code = error && typeof error.code === "string" ? error.code : "INTERNAL";
  const message = error && error.message ? error.message : "未知错误";
  return { ok: false, error: { code, message } };
}
