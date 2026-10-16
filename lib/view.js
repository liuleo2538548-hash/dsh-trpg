/**
 * dsh-trpg — 派生视图。
 *
 * 浏览器半拿到的永远是「算好的」数据：进度条百分比、态度标签、能不能继续报价……
 * 界面不做任何重算（也就没法算错），所有显示口径都在这一个文件里。
 */

import { LIMITS, SUSPICION_MAX, activeCampaign, campaignById, campaignLog, clampInt } from "./schema.js";
import { canOffer, suspicionLabel } from "./bribe.js";

const ATTITUDE_LABELS = {
  "-2": "敌视",
  "-1": "冷淡",
  0: "中立",
  1: "友善",
  2: "亲近",
};

export function attitudeLabel(value) {
  const level = clampInt(value, { min: -2, max: 2, fallback: 0 });
  return ATTITUDE_LABELS[String(level)] || "中立";
}

function pct(value, max) {
  if (!max || max <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / max) * 100)));
}

function buildCampaignView(campaign, state) {
  const stats = campaign.stats.map((stat) => ({ ...stat, pct: pct(stat.value, stat.max) }));
  const clocks = campaign.clocks.map((clock) => ({
    ...clock,
    pct: pct(clock.value, clock.max),
    done: clock.value >= clock.max,
  }));
  const npcs = campaign.npcs.map((npc) => ({
    ...npc,
    attitudeLabel: attitudeLabel(npc.attitude),
    hasSecret: Boolean(npc.secret),
  }));
  const found = campaign.clues.filter((clue) => clue.found).length;
  const ledgerCounts = { FACT: 0, BELIEF: 0, HYPOTHESIS: 0, SECRET: 0 };
  for (const entry of campaign.ledger) {
    if (ledgerCounts[entry.kind] !== undefined) ledgerCounts[entry.kind] += 1;
  }
  const bribes = campaign.bribes.map((bribe) => ({
    ...bribe,
    canOffer: canOffer(bribe),
    suspicionLabel: suspicionLabel(bribe.suspicion),
    offersCount: Array.isArray(bribe.offers) ? bribe.offers.length : 0,
  }));
  return {
    id: campaign.id,
    name: campaign.name,
    premise: campaign.premise,
    tone: campaign.tone,
    pcName: campaign.pcName,
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    turn: campaign.turn,
    scene: { ...campaign.scene, present: [...campaign.scene.present] },
    stats,
    clocks,
    inventory: campaign.inventory.map((item) => ({ ...item })),
    flags: [...campaign.flags],
    npcs,
    clues: { total: campaign.clues.length, found, items: campaign.clues.map((clue) => ({ ...clue })) },
    ledger: { counts: ledgerCounts, recent: campaign.ledger.slice(-8).map((entry) => ({ ...entry })) },
    bribes,
    logCount: state.log.reduce((sum, entry) => (entry.campaignId === campaign.id ? sum + 1 : sum), 0),
  };
}

/**
 * 宿主建议的「下一步」。刻意保持很少（≤4 条）：太多了反而变成菜单游戏。
 * action 语义：`send` 直接把 payload 当玩家发言发出；`roll` 直接掷一次检定；`bribe` 打开某笔交易。
 */
export function buildSuggestions(campaign) {
  if (!campaign) return [];
  const out = [];
  const hiddenClues = campaign.clues.length - campaign.clues.filter((clue) => clue.found).length;
  if (hiddenClues > 0) {
    out.push({
      id: "sug_search",
      label: `搜查现场（还有 ${hiddenClues} 条线索没现身）`,
      action: "send",
      payload: "我停下来，仔细搜查眼前这个地方。",
    });
  }
  const openBribe = campaign.bribes.find((bribe) => canOffer(bribe));
  if (openBribe) {
    out.push({ id: "sug_bribe", label: `继续和 ${openBribe.npcName} 谈条件`, action: "bribe", payload: openBribe.id });
  }
  const secretNpc = campaign.npcs.find((npc) => npc.secret && !npc.revealed);
  if (secretNpc && out.length < 3) {
    out.push({
      id: "sug_talk",
      label: `试探 ${secretNpc.name}（他知道点什么）`,
      action: "send",
      payload: `我转向${secretNpc.name}，试着从他嘴里问出点什么。`,
    });
  }
  const pressedClock = campaign.clocks.find((clock) => clock.value >= clock.max - 1 && clock.value < clock.max);
  if (pressedClock && out.length < 3) {
    out.push({
      id: "sug_clock",
      label: `${pressedClock.name}快满了，得做点什么`,
      action: "send",
      payload: `不能再拖了，我立刻行动——${pressedClock.name}快要到顶了。`,
    });
  }
  if (!out.length) {
    out.push({ id: "sug_look", label: "描述我看到的细节", action: "send", payload: "我环顾四周，注意有什么不对劲的地方。" });
  }
  return out.slice(0, 4);
}

/**
 * @param {object} state 合法存档
 * @param {{ campaignId?: string, moodEmoji?: Function, scenario?: object, extraLog?: object[], error?: string|null }} [options]
 */
export function buildView(state, options = {}) {
  const wanted = typeof options.campaignId === "string" && options.campaignId ? options.campaignId : "";
  const campaign = wanted ? campaignById(state, wanted) : activeCampaign(state);
  const emoji = typeof options.moodEmoji === "function" ? options.moodEmoji : () => "";
  const scenario = options.scenario && typeof options.scenario === "object" ? options.scenario : null;

  let campaignView = null;
  if (campaign) {
    campaignView = buildCampaignView(campaign, state);
    campaignView.scene.moodEmoji = emoji(campaignView.scene.mood);
    campaignView.suggestions = buildSuggestions(campaign);
    const sections = scenario && Array.isArray(scenario.sections) ? scenario.sections : [];
    campaignView.scenario = {
      title: scenario && typeof scenario.title === "string" ? scenario.title : "",
      sectionCount: sections.length,
      chars: scenario && typeof scenario.source === "string" ? scenario.source.length : 0,
      importedAt: scenario && Number.isFinite(Number(scenario.importedAt)) ? Number(scenario.importedAt) : 0,
      headings: sections.map((section) => ({ id: section.id, heading: section.heading, level: section.level })),
    };
  }

  let log = campaign ? campaignLog(state, campaign.id, 80) : [];
  if (Array.isArray(options.extraLog) && options.extraLog.length) log = log.concat(options.extraLog);

  return {
    campaigns: state.campaigns.map((entry) => ({
      id: entry.id,
      name: entry.name,
      tone: entry.tone,
      pcName: entry.pcName,
      turn: entry.turn,
      updatedAt: entry.updatedAt,
    })),
    activeCampaignId: state.activeCampaignId,
    campaign: campaignView,
    log,
    settings: { ...state.settings },
    limits: {
      maxLogPerCampaign: LIMITS.maxLogPerCampaign,
      suspicionMax: SUSPICION_MAX,
      maxNpcs: LIMITS.maxNpcs,
      maxStats: LIMITS.maxStats,
    },
    error: options.error || (state.settings ? null : null),
  };
}
