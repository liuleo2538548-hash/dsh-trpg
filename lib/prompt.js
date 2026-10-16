/**
 * dsh-trpg — 提示词装配。
 *
 * 刻意写成**纯函数**：剧本摘要、语气指令、指令语法都由调用方算好后传进来。
 * 这样提示词可以脱机快照测试，也不必让这个文件去 import gm.js / scenario.js。
 *
 * 唯一需要小心的硬约束：每条 assistant 消息都必须带 `source` 信封，否则 dsh-llm 在读历史
 * 回复时会抛 `Cannot read properties of undefined (reading 'replayState')`。
 */

import { LIMITS, clampInt, campaignLog } from "./schema.js";

export function truncateToChars(text, max) {
  const limit = clampInt(max, { min: 0, max: 10_000_000, fallback: 0 });
  if (typeof text !== "string") return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 12))}…（已截断）`;
}

/** 把存档压成一段「当前局面」简报。模型每回合都要看这个，所以必须短且信息密度高。 */
export function stateBrief(campaign, { moodEmoji } = {}) {
  if (!campaign) return "（还没有战役）";
  const emoji = typeof moodEmoji === "function" ? moodEmoji : () => "";
  const lines = [];

  lines.push(`战役：《${campaign.name}》 基调：${campaign.tone} 玩家角色：${campaign.pcName} 第 ${campaign.turn} 回合`);
  if (campaign.premise) lines.push(`前提：${campaign.premise}`);

  const scene = campaign.scene;
  const sceneBits = [scene.name, scene.place, scene.time].filter(Boolean).join(" · ");
  if (sceneBits) lines.push(`场景：${sceneBits}`);
  if (scene.present.length) lines.push(`在场：${scene.present.join("、")}`);
  lines.push(`GM 当前态度：${scene.mood} ${emoji(scene.mood)}`.trim());

  if (campaign.stats.length) {
    lines.push(`属性：${campaign.stats.map((stat) => `${stat.name} ${stat.value}/${stat.max}`).join("、")}`);
  }
  if (campaign.clocks.length) {
    lines.push(`进度：${campaign.clocks.map((clock) => `${clock.name} ${clock.value}/${clock.max}`).join("、")}`);
  }
  if (campaign.inventory.length) {
    lines.push(`携带：${campaign.inventory.map((item) => (item.qty > 1 ? `${item.name}×${item.qty}` : item.name)).join("、")}`);
  }
  if (campaign.flags.length) lines.push(`已有事实标记：${campaign.flags.join("；")}`);
  if (campaign.npcs.length) {
    lines.push(
      `NPC：${campaign.npcs
        .map((npc) => {
          const secret = npc.secret ? (npc.revealed ? "已泄密" : "嘴紧") : "无秘密";
          return `${npc.name}（${npc.attitude >= 0 ? "+" : ""}${npc.attitude}，${secret}）`;
        })
        .join("、")}`,
    );
  }
  const found = campaign.clues.filter((clue) => clue.found).length;
  if (campaign.clues.length) lines.push(`线索：已发现 ${found}/${campaign.clues.length}`);

  const counts = { FACT: 0, BELIEF: 0, HYPOTHESIS: 0, SECRET: 0 };
  for (const entry of campaign.ledger) if (counts[entry.kind] !== undefined) counts[entry.kind] += 1;
  lines.push(`账本：事实 ${counts.FACT}、玩家认知 ${counts.BELIEF}、假设 ${counts.HYPOTHESIS}、已泄密 ${counts.SECRET}`);

  const openBribes = campaign.bribes.filter((bribe) => bribe.status !== "granted");
  for (const bribe of openBribes) {
    lines.push(
      `未结交易：${bribe.npcName} —— 想要「${bribe.want || "还没说要什么"}」，怀疑度 ${bribe.suspicion}/${LIMITS.fields.suspicion.max}，已谈 ${bribe.offers.length} 轮，状态 ${bribe.status}`,
    );
  }

  if (campaign.ledger.length) {
    lines.push("近期场记：");
    for (const entry of campaign.ledger.slice(-6)) lines.push(`  - [${entry.turn}] ${entry.kind} ${entry.text}`);
  }
  return lines.join("\n");
}

/**
 * 系统提示词。`digest` / `style` / `guide` 由调用方传入（分别来自 scenario.js 与 gm.js）。
 */
export function buildSystemPrompt({ campaign, digest = "", style = "", guide = "", extra = "" } = {}) {
  const parts = [];
  parts.push(
    `你是这场跑团的主持人（GM），正在带《${campaign ? campaign.name : "未命名"}》这一局。你是**人**，不是旁白机器：有情绪、有耐心上限、会记仇，也会因为玩家干了漂亮事而闭嘴惊艳。`,
  );
  parts.push(
    [
      "【硬规矩】",
      "1. 你只演 NPC 和世界，绝不替玩家决定行动、绝不替玩家掷骰。",
      "2. 需要随机结果时，用 <<roll 公式 dc=难度 理由>> 让宿主掷骰。**永远不要自己编造骰点数字**。",
      "3. 叙述要动用感官：声音、气味、光线、身体反应。每次回复 2~5 段，别写成流水账。",
      "4. 不要把剧本原文念给玩家。玩家没查到的信息，不能主动吐出来。",
      "5. 每回合回复开头用 <<mood 词>> 标一次你的态度。",
      "6. 玩家明显在瞎搞时，你可以阴阳怪气，但最终仍要把剧情往前推。",
    ].join("\n"),
  );
  if (guide) parts.push(guide);
  if (style) parts.push(style);
  parts.push(`【当前局面】\n${stateBrief(campaign)}`);
  if (digest) parts.push(`【剧本目录】\n${digest}`);
  if (extra) parts.push(extra);
  return parts.join("\n\n");
}

function mergeInto(list, role, content, source) {
  const last = list[list.length - 1];
  if (last && last.role === role) {
    last.content = `${last.content}\n\n${content}`;
    if (source && !last.source) last.source = source;
    return;
  }
  const message = { role, content };
  if (source) message.source = source;
  list.push(message);
}

/**
 * 把线报翻成模型消息。相邻同角色合并 —— 多数 provider 不喜欢连续同角色，合并比过滤安全。
 *
 * @param {{ campaign: object, log: object[], playerText?: string, provider: string, model: string, maxChars?: number }} input
 */
export function buildMessages({ campaign, log = [], playerText = "", provider = "dsh", model = "unknown", maxChars = 12000 } = {}) {
  const budget = clampInt(maxChars, { min: 500, max: 10_000_000, fallback: 12000 });
  const entries = Array.isArray(log) ? log : [];
  const source = { kind: "model", provider, model };

  // 从最近往前装，装到预算为止；最后一条永远保留，否则模型会看不到玩家刚说的话。
  const chosen = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const text = typeof entry.text === "string" ? entry.text : "";
    const cost = text.length + 16;
    if (chosen.length && used + cost > budget) break;
    used += cost;
    chosen.push(entry);
  }
  chosen.reverse();

  const messages = [];
  for (const entry of chosen) {
    const text = typeof entry.text === "string" ? entry.text : "";
    if (!text) continue;
    if (entry.role === "player") mergeInto(messages, "user", text);
    else if (entry.role === "gm") mergeInto(messages, "assistant", text, source);
    else if (entry.role === "dice") mergeInto(messages, "user", `【骰子】${text}`);
    else mergeInto(messages, "user", `【系统】${text}`);
  }
  if (playerText) mergeInto(messages, "user", playerText);

  if (!messages.length) messages.push({ role: "user", content: playerText || "（开始）" });
  // 首条必须是 user：有些 provider 拒绝以 assistant 开头的对话。
  if (messages[0].role === "assistant") messages.unshift({ role: "user", content: "（继续）" });
  return messages;
}

/** 贿赂谈判回合的用户侧指令。 */
export function bribePrompt({ campaign, bribe, npc, offer }) {
  const npcName = bribe ? bribe.npcName : "对方";
  const lines = [
    `玩家正在贿赂 ${npcName}。`,
    `玩家想要：${bribe && bribe.want ? bribe.want : "（没说，你按场面判断）"}`,
    `玩家这次掏出的是：${offer}`,
    `你目前掌握的把柄/秘密：${npc && npc.secret ? npc.secret : "（这个人身上没有你预备好的秘密，不要即兴编一个大秘密，可以给点边角料）"}`,
    `当前怀疑度：${bribe ? bribe.suspicion : 0}（已谈 ${bribe ? bribe.offers.length : 0} 轮）`,
    npc && npc.note ? `你对这个人的设定：${npc.note}` : "",
    "",
    "用 1~2 段演出这个人的反应（动作、语气、眼神，别直接报数值）。",
    `然后必须给出一行判定：<<bribe granted|haggle|refused price=你的要价 suspicion=±N>>。`,
    "granted = 成交并把你知道的说出来；haggle = 抬价，这次不给；refused = 不吃这套。",
    "注意：玩家报价越具体、越对路你越可能收；空口白话应该直接 refused 并且 suspicion=+2。怀疑度到 5 你就彻底不谈了。",
  ];
  return lines.filter((line) => line !== "").join("\n");
}

/** 从 state 里取某战役最近 N 条线报（薄封装，便于 index.js 与测试共用）。 */
export function recentLog(state, campaignId, limit = 60) {
  return campaignLog(state, campaignId, limit);
}
