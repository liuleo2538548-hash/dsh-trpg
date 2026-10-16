/**
 * dsh-trpg — 命令层单测。
 *
 * 命令层是**唯一写入权威**：UI 与模型都只能通过它改档。
 * 骰子与检定刻意不由本层实现，而是走注入的 ctx.roll / ctx.check ——
 * 所以这里可以用确定性替身把随机性彻底钉死。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COC_PRESET,
  COMMAND_TYPES,
  CommandError,
  applyCommand,
  commandFailure,
  handlers,
} from "../lib/commands.js";
import { LIMITS, emptyState } from "../lib/schema.js";

const NOW = 1700000000000;

function makeCtx(over = {}) {
  let n = 0;
  return {
    now: () => NOW,
    id: (prefix) => `${prefix}_${(n += 1)}`,
    // 替身骰子：给了 dc 就刚好掷出 dc（必然「达成」），否则固定 37。
    roll: ({ formula, dc, reason }) => ({
      formula,
      total: dc === null || dc === undefined ? 37 : dc,
      text: `掷 ${formula}`,
      dc: dc ?? null,
      reason: reason ?? "",
    }),
    check: (options) => ({ ...options, level: "regular", description: `检定 ${options.skill ?? "?"}` }),
    ...over,
  };
}

function fresh() {
  return { state: emptyState(), ctx: makeCtx() };
}

/** 一个已有活动战役的档。 */
function seeded(command = {}) {
  const { state, ctx } = fresh();
  applyCommand(state, { type: "campaign.create", name: "雨夜", pcName: "林晚", ...command }, ctx);
  return { state, ctx, campaign: state.campaigns[0] };
}

const run = (state, ctx, command) => applyCommand(state, command, ctx);
const logOf = (state, campaignId) => state.log.filter((entry) => entry.campaignId === campaignId);
const codeOf = (fn) => {
  try {
    fn();
  } catch (error) {
    return error.code;
  }
  return null;
};

/* ------------------------------------------------------------------ 门面 */

test("applyCommand：非对象 / 未知 type / 非对象 state 都有明确 code", () => {
  const { state, ctx } = fresh();
  assert.equal(codeOf(() => applyCommand(state, null, ctx)), "BAD_COMMAND");
  assert.equal(codeOf(() => applyCommand(state, "campaign.create", ctx)), "BAD_COMMAND");
  assert.equal(codeOf(() => applyCommand(state, { type: "nope" }, ctx)), "UNKNOWN_COMMAND");
  assert.equal(codeOf(() => applyCommand(state, {}, ctx)), "UNKNOWN_COMMAND");
  assert.equal(codeOf(() => applyCommand(null, { type: "log.append", text: "x" }, ctx)), "NOT_AN_OBJECT");
});

test("COMMAND_TYPES 与 handlers 一一对应，且都是非空字符串", () => {
  assert.deepEqual(COMMAND_TYPES, Object.keys(handlers));
  assert.ok(COMMAND_TYPES.length >= 30, `命令太少：${COMMAND_TYPES.length}`);
  for (const type of COMMAND_TYPES) {
    assert.equal(typeof type, "string");
    assert.ok(type.includes("."), `${type} 应当形如 a.b`);
    assert.equal(typeof handlers[type], "function");
  }
});

test("commandFailure 把任意错误折成 { ok:false, error }", () => {
  assert.deepEqual(commandFailure(new CommandError("BAD_TEXT", "文本不能为空")), {
    ok: false,
    error: { code: "BAD_TEXT", message: "文本不能为空" },
  });
  assert.deepEqual(commandFailure(new Error("炸了")), { ok: false, error: { code: "INTERNAL", message: "炸了" } });
  assert.equal(commandFailure(null).error.code, "INTERNAL");
});

test("没有活动战役时，绝大多数命令拒绝执行", () => {
  const { state, ctx } = fresh();
  assert.equal(codeOf(() => run(state, ctx, { type: "scene.set", name: "门口" })), "NO_ACTIVE_CAMPAIGN");
  assert.equal(codeOf(() => run(state, ctx, { type: "log.append", role: "gm", text: "x" })), "NO_ACTIVE_CAMPAIGN");
  assert.equal(codeOf(() => run(state, ctx, { type: "ledger.add", text: "x" })), "NO_ACTIVE_CAMPAIGN");
  assert.equal(codeOf(() => run(state, ctx, { type: "campaignId", campaignId: "c_x" })), "UNKNOWN_COMMAND");
  assert.equal(
    codeOf(() => run(state, ctx, { type: "scene.set", campaignId: "c_none", name: "门口" })),
    "CAMPAIGN_NOT_FOUND",
  );
});

/* ------------------------------------------------------------------ 战役 */

test("campaign.create：默认带 COC 预设、设为活动战役、返回 campaignId", () => {
  const { state, ctx } = fresh();
  const out = run(state, ctx, { type: "campaign.create", name: "雨夜", premise: "地下室", tone: "恐怖" });
  assert.equal(state.campaigns.length, 1);
  assert.equal(state.activeCampaignId, out.campaignId);
  assert.equal(out.result.campaignId, state.campaigns[0].id);
  assert.equal(state.campaigns[0].name, "雨夜");
  assert.equal(state.campaigns[0].turn, 0, "回合从 0 起算，第一次推进才变成 1");
  assert.deepEqual(
    state.campaigns[0].stats.map((stat) => [stat.name, stat.value, stat.max]),
    COC_PRESET.map((entry) => [entry.name, entry.value ?? entry.max, entry.max]),
  );
});

test("campaign.create：preset:'none' 不带属性，自定义 stats 生效且被钳制", () => {
  const { state, ctx } = fresh();
  run(state, ctx, { type: "campaign.create", name: "空档", preset: "none" });
  assert.deepEqual(state.campaigns[0].stats, []);

  run(state, ctx, { type: "campaign.create", name: "自定义", stats: [{ name: "意志", max: 50, value: 999 }] });
  const stat = state.campaigns[1].stats[0];
  assert.equal(stat.name, "意志");
  assert.equal(stat.max, 50);
  assert.equal(stat.value, 50, "value 不能超过 max");
});

test("campaign.create：重复 id 拒绝；非法 id 会另生成一个", () => {
  const { state, ctx } = fresh();
  run(state, ctx, { type: "campaign.create", name: "一", campaignId: "c_fixed" });
  assert.equal(codeOf(() => run(state, ctx, { type: "campaign.create", name: "二", campaignId: "c_fixed" })), "CAMPAIGN_EXISTS");
  run(state, ctx, { type: "campaign.create", name: "三", campaignId: "../坏" });
  assert.equal(state.campaigns.length, 2);
  assert.match(state.campaigns[1].id, /^c_/);
});

test("campaign.select / patch：切档与改字段，空串不覆盖", () => {
  const { state, ctx } = fresh();
  run(state, ctx, { type: "campaign.create", name: "一", campaignId: "c_1" });
  run(state, ctx, { type: "campaign.create", name: "二", campaignId: "c_2" });
  assert.equal(state.activeCampaignId, "c_2");

  run(state, ctx, { type: "campaign.select", campaignId: "c_1" });
  assert.equal(state.activeCampaignId, "c_1");
  assert.equal(codeOf(() => run(state, ctx, { type: "campaign.select", campaignId: "c_none" })), "CAMPAIGN_NOT_FOUND");

  // 空串/纯空白一律算「没传」，不能把已有字段冲掉。
  run(state, ctx, { type: "campaign.patch", tone: "悬疑" });
  assert.equal(state.campaigns[0].tone, "悬疑");
  run(state, ctx, { type: "campaign.patch", name: "  新名字  ", premise: "前言", tone: "   " });
  assert.equal(state.campaigns[0].name, "新名字");
  assert.equal(state.campaigns[0].premise, "前言");
  assert.equal(state.campaigns[0].tone, "悬疑", "空白串不覆盖已有 tone");
  assert.equal(state.campaigns[0].updatedAt, NOW);
});

test("campaign.delete：回传 dropScenario 供宿主删剧本，并清掉该战役的线报", () => {
  const { state, ctx } = fresh();
  run(state, ctx, { type: "campaign.create", name: "一", campaignId: "c_1" });
  run(state, ctx, { type: "campaign.create", name: "二", campaignId: "c_2" });
  run(state, ctx, { type: "log.append", role: "gm", text: "在二里说的话" });

  const out = run(state, ctx, { type: "campaign.delete", campaignId: "c_2" });
  assert.equal(out.result.dropScenario, "c_2");
  assert.equal(out.campaignId, null);
  assert.deepEqual(state.campaigns.map((entry) => entry.id), ["c_1"]);
  assert.equal(state.activeCampaignId, "c_1", "活动战役应当回落");
  assert.equal(logOf(state, "c_2").length, 0);

  run(state, ctx, { type: "campaign.delete", campaignId: "c_1" });
  assert.equal(state.activeCampaignId, null);
});

/* ------------------------------------------------------------------ 场景 */

test("scene.set：逐字段覆盖，present 去重并截断", () => {
  const { state, ctx } = seeded();
  const out = run(state, ctx, {
    type: "scene.set",
    name: " 门厅 ",
    place: "旧宅",
    time: "凌晨两点",
    mood: "ominous",
    present: ["老赵", "老赵", " ", "猫"],
  });
  const scene = out.result.scene;
  assert.equal(scene.name, "门厅");
  assert.equal(scene.place, "旧宅");
  assert.equal(scene.time, "凌晨两点");
  assert.equal(scene.mood, "ominous");
  assert.deepEqual(scene.present, ["老赵", "猫"]);

  run(state, ctx, { type: "scene.set", name: "" });
  assert.equal(state.campaigns[0].scene.name, "", "空串是合法的「清空」，不是拒绝");

  run(state, ctx, { type: "scene.set", present: Array.from({ length: LIMITS.maxPresent + 5 }, (_, i) => `n${i}`) });
  assert.equal(state.campaigns[0].scene.present.length, LIMITS.maxPresent);
});

/* ------------------------------------------------------------ 属性与进度 */

test("stat.define / stat.set / stat.remove 的完整回路", () => {
  const { state, ctx } = fresh();
  run(state, ctx, { type: "campaign.create", name: "x", preset: "none" });

  run(state, ctx, { type: "stat.define", name: "意志", max: 60, value: 40 });
  const stat = state.campaigns[0].stats[0];
  assert.equal(stat.value, 40);
  assert.equal(stat.max, 60);
  assert.equal(codeOf(() => run(state, ctx, { type: "stat.define", name: "  " })), "BAD_NAME");

  const bumped = run(state, ctx, { type: "stat.set", name: "意志", delta: 25 });
  assert.equal(bumped.result.before, 40, "before 直接就是旧的数值");
  assert.equal(bumped.result.stat.value, 60, "应当钳在 max");
  const dropped = run(state, ctx, { type: "stat.set", statId: stat.id, value: -5 });
  assert.equal(dropped.result.stat.value, 0, "应当钳在 0");

  // delta 为 0 / "" / null 时都应当走「直接设值」分支，而不是加 0
  const viaZero = run(state, ctx, { type: "stat.set", statId: stat.id, delta: "", value: 12 });
  assert.equal(viaZero.result.stat.value, 12);

  assert.equal(codeOf(() => run(state, ctx, { type: "stat.set", name: "不存在", value: 1 })), "STAT_NOT_FOUND");
  run(state, ctx, { type: "stat.remove", statId: stat.id });
  assert.deepEqual(state.campaigns[0].stats, []);
  assert.equal(codeOf(() => run(state, ctx, { type: "stat.remove", statId: stat.id })), "STAT_NOT_FOUND");
});

test("stat.define：数量上限触发 LIMIT_REACHED", () => {
  const { state, ctx } = fresh();
  run(state, ctx, { type: "campaign.create", name: "x", preset: "none" });
  for (let i = 0; i < LIMITS.maxStats; i += 1) run(state, ctx, { type: "stat.define", name: `属性${i}`, max: 10 });
  assert.equal(state.campaigns[0].stats.length, LIMITS.maxStats);
  assert.equal(codeOf(() => run(state, ctx, { type: "stat.define", name: "多出来的", max: 10 })), "LIMIT_REACHED");
});

test("clock.add / set / remove：默认 4 格，delta 推进，钳制在 max", () => {
  const { state, ctx } = seeded();
  run(state, ctx, { type: "clock.add", name: "仪式完成" });
  const clock = state.campaigns[0].clocks[0];
  assert.equal(clock.max, 4);
  assert.equal(clock.value, 0);

  assert.equal(run(state, ctx, { type: "clock.set", name: "仪式完成", delta: 2 }).result.clock.value, 2);
  assert.equal(run(state, ctx, { type: "clock.set", clockId: clock.id, delta: 99 }).result.clock.value, 4);
  assert.equal(run(state, ctx, { type: "clock.set", clockId: clock.id, max: 100, value: 100 }).result.clock.max, 100);

  run(state, ctx, { type: "clock.remove", clockId: clock.id });
  assert.deepEqual(state.campaigns[0].clocks, []);
  assert.equal(codeOf(() => run(state, ctx, { type: "clock.remove", clockId: clock.id })), "CLOCK_NOT_FOUND");
});

/* -------------------------------------------------------------- 物品与标记 */

test("inventory.add 同名累加，inventory.remove 递减并在归零时删条目", () => {
  const { state, ctx } = seeded();
  const first = run(state, ctx, { type: "inventory.add", name: "手电筒", qty: 1, note: "快没电了" });
  const id = first.result.item ? first.result.item.id : state.campaigns[0].inventory[0].id;
  run(state, ctx, { type: "inventory.add", name: "手电筒", qty: 2 });
  assert.equal(state.campaigns[0].inventory.length, 1, "同名应当累加而不是新增");
  assert.equal(state.campaigns[0].inventory[0].qty, 3);

  const out = run(state, ctx, { type: "inventory.remove", itemId: id, qty: 3 });
  assert.equal(out.result.qty, 0, "qty 报的是剩下的数量，不是被拿走的数量");
  assert.deepEqual(state.campaigns[0].inventory, []);
  assert.equal(codeOf(() => run(state, ctx, { type: "inventory.remove", name: "手电筒" })), "ITEM_NOT_FOUND");
});

test("flag.add 去重、空值拒绝；flag.remove 删得掉", () => {
  const { state, ctx } = seeded();
  run(state, ctx, { type: "flag.add", text: "见过老赵" });
  run(state, ctx, { type: "flag.add", name: "见过老赵" });
  assert.deepEqual(state.campaigns[0].flags, ["见过老赵"]);
  assert.equal(codeOf(() => run(state, ctx, { type: "flag.add", text: "   " })), "BAD_TEXT");
  run(state, ctx, { type: "flag.remove", text: "见过老赵" });
  assert.deepEqual(state.campaigns[0].flags, []);
});

/* -------------------------------------------------------------------- NPC */

test("npc.add / patch / remove：同名合并、改名、连带删掉它的交易", () => {
  const { state, ctx } = seeded();
  run(state, ctx, { type: "npc.add", name: "老赵", attitude: -1, secret: "钥匙给了别人" });
  assert.equal(state.campaigns[0].npcs.length, 1);
  assert.equal(state.campaigns[0].npcs[0].attitude, -1);

  run(state, ctx, { type: "npc.add", name: "老赵", note: "看门" });
  assert.equal(state.campaigns[0].npcs.length, 1, "同名不新增");
  assert.equal(state.campaigns[0].npcs[0].note, "看门");
  assert.equal(state.campaigns[0].npcs[0].attitude, -1, "没传的字段不能被重置");

  const out = run(state, ctx, { type: "npc.patch", name: "老赵", newName: "赵伯", attitude: 2 });
  const npc = out.result.npc;
  assert.equal(npc.name, "赵伯");
  assert.equal(npc.attitude, 2);

  run(state, ctx, { type: "bribe.open", npcName: "赵伯", want: "地下室" });
  assert.equal(state.campaigns[0].bribes.length, 1);
  run(state, ctx, { type: "npc.remove", npcId: npc.id });
  assert.deepEqual(state.campaigns[0].npcs, []);
  assert.deepEqual(state.campaigns[0].bribes, [], "NPC 走了，它的交易也该消失");
});

/* ------------------------------------------------------------------线索 */

test("clue.add / reveal / remove：reveal 支持按 id 或按下标", () => {
  const { state, ctx } = seeded();
  run(state, ctx, { type: "clue.add", text: "地板上有一道新划痕" });
  run(state, ctx, { type: "clue.add", text: "窗子是从里面锁上的", found: true });
  assert.deepEqual(state.campaigns[0].clues.map((clue) => clue.found), [false, true]);
  assert.equal(codeOf(() => run(state, ctx, { type: "clue.add", text: "  " })), "BAD_TEXT");

  run(state, ctx, { type: "clue.reveal", index: 0 });
  assert.equal(state.campaigns[0].clues[0].found, true);
  run(state, ctx, { type: "clue.reveal", index: 99 });
  assert.equal(state.campaigns[0].clues[1].found, true, "越界下标应当钳到合法范围");
  assert.equal(codeOf(() => run(state, ctx, { type: "clue.reveal", clueId: "cl_none" })), "CLUE_NOT_FOUND");

  run(state, ctx, { type: "clue.remove", clueId: state.campaigns[0].clues[0].id });
  assert.equal(state.campaigns[0].clues.length, 1);
});

/* ------------------------------------------------------------------账本 */

test("ledger.add：kind 非法回落 FACT，条目带上场景与回合", () => {
  const { state, ctx } = seeded();
  run(state, ctx, { type: "scene.set", name: "门厅" });
  run(state, ctx, { type: "turn.bump" });
  run(state, ctx, { type: "ledger.add", text: "老赵知道钥匙的下落", kind: "SECRET" });
  run(state, ctx, { type: "ledger.add", text: "随口一记", kind: "胡说" });
  const [secret, fact] = state.campaigns[0].ledger;
  assert.equal(secret.kind, "SECRET");
  assert.equal(secret.scene, "门厅");
  assert.equal(secret.turn, state.campaigns[0].turn);
  assert.equal(fact.kind, "FACT");
});

test("ledger.add：满 300 条时丢最老的", () => {
  const { state, ctx } = seeded();
  for (let i = 0; i < LIMITS.maxLedger + 3; i += 1) run(state, ctx, { type: "ledger.add", text: `第 ${i} 条`, kind: "FACT" });
  const ledger = state.campaigns[0].ledger;
  assert.equal(ledger.length, LIMITS.maxLedger);
  assert.equal(ledger[0].text, "第 3 条");
  assert.equal(ledger[ledger.length - 1].text, `第 ${LIMITS.maxLedger + 2} 条`);
});

/* ------------------------------------------------------------------线报 */

test("log.append：role 非法回落 system，seq 按战役递增", () => {
  const { state, ctx } = fresh();
  run(state, ctx, { type: "campaign.create", name: "一", campaignId: "c_1" });
  const a = run(state, ctx, { type: "log.append", role: "gm", text: "第一句" }).result.entry;
  const b = run(state, ctx, { type: "log.append", role: "胡说", text: "第二句" }).result.entry;
  assert.equal(a.role, "gm");
  assert.equal(b.role, "system");
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.equal(a.createdAt, NOW);
});

test("log.append：每战役裁到 300 条，且只裁自己那条线", () => {
  const { state, ctx } = fresh();
  run(state, ctx, { type: "campaign.create", name: "一", campaignId: "c_1" });
  run(state, ctx, { type: "campaign.create", name: "二", campaignId: "c_2" });
  run(state, ctx, { type: "log.append", campaignId: "c_1", role: "gm", text: "一的开场" });
  for (let i = 0; i < LIMITS.maxLogPerCampaign + 5; i += 1) {
    run(state, ctx, { type: "log.append", campaignId: "c_2", role: "gm", text: `二的第 ${i} 句` });
  }
  assert.equal(logOf(state, "c_1").length, 1, "别的战役不该被牵连");
  assert.equal(logOf(state, "c_2").length, LIMITS.maxLogPerCampaign);
});

test("log.clear 只清当前战役；turn.bump 从 0 起算", () => {
  const { state, ctx } = fresh();
  run(state, ctx, { type: "campaign.create", name: "一", campaignId: "c_1" });
  run(state, ctx, { type: "campaign.create", name: "二", campaignId: "c_2" });
  run(state, ctx, { type: "log.append", campaignId: "c_1", role: "gm", text: "留着的" });
  run(state, ctx, { type: "log.append", role: "gm", text: "要清的" });
  const out = run(state, ctx, { type: "log.clear" });
  assert.equal(out.result.removed, 1);
  assert.equal(logOf(state, "c_1").length, 1);
  assert.equal(logOf(state, "c_2").length, 0);
  assert.equal(run(state, ctx, { type: "turn.bump" }).result.turn, 1, "初值 0，第一次推进到 1");
  assert.equal(run(state, ctx, { type: "turn.bump" }).result.turn, 2);
});

/* ------------------------------------------------------------------骰子 */

test("dice.roll：用注入的掷骰器，达成与否写进线报", () => {
  const { state, ctx } = seeded();
  const hit = run(state, ctx, { type: "dice.roll", formula: "1d100", dc: 55, reason: "撬锁" });
  assert.equal(hit.result.roll.total, 55);
  assert.equal(hit.result.roll.reason, "撬锁");
  const entry = hit.result.entry;
  assert.equal(entry.role, "dice");
  assert.match(entry.text, /→ 达成/);
  assert.ok(entry.text.includes("撬锁"));
  assert.equal(entry.meta.kind, "roll");

  const plain = run(state, ctx, { type: "dice.roll", formula: "2d6" });
  assert.equal(plain.result.roll.dc, null);
  assert.ok(!plain.result.entry.text.includes("达成"), "没有 dc 就不该有判定徽章");
});

test("dice.roll / dice.check：宿主没注入掷骰器时抛 NO_ROLLER", () => {
  const { state, ctx } = seeded();
  const bare = { ...ctx, roll: undefined, check: undefined };
  assert.equal(codeOf(() => run(state, bare, { type: "dice.roll", formula: "1d6" })), "NO_ROLLER");
  assert.equal(codeOf(() => run(state, bare, { type: "dice.check", skill: "侦查", target: 55 })), "NO_ROLLER");
});

test("dice.check：注入的检定器说了算，结果整包进 meta", () => {
  const { state, ctx } = seeded();
  const out = run(state, ctx, { type: "dice.check", skill: "侦查", target: 55, difficulty: "hard", bonusDice: 1 });
  const check = out.result.check;
  assert.equal(check.skill, "侦查");
  assert.equal(check.difficulty, "hard");
  assert.equal(out.result.entry.text, check.description);
  assert.equal(out.result.entry.meta.kind, "check");
  assert.equal(out.result.entry.meta.skill, "侦查");
});

/* ------------------------------------------------------------------贿赂 */

test("bribe.open：NPC 不存在就顺手建；同一个 NPC 的 open 交易会被复用", () => {
  const { state, ctx } = seeded();
  const first = run(state, ctx, { type: "bribe.open", npcName: "老赵", want: "地下室", secret: "钥匙给了别人", attitude: -1 });
  assert.equal(first.result.created, true);
  assert.equal(state.campaigns[0].npcs.length, 1);
  assert.equal(first.result.bribe.status, "open");
  assert.equal(first.result.bribe.suspicion, 0);

  const again = run(state, ctx, { type: "bribe.open", npcName: "老赵" });
  assert.equal(again.result.created, false);
  assert.equal(again.result.bribe.id, first.result.bribe.id);
  assert.equal(state.campaigns[0].bribes.length, 1);

  assert.equal(codeOf(() => run(state, ctx, { type: "bribe.open", npcName: "   " })), "BAD_NAME");
});

test("bribe.offer：没给 verdict 时用 bribe.js 的确定性兜底，mechanical=true", () => {
  const { state, ctx } = seeded();
  const open = run(state, ctx, { type: "bribe.open", npcName: "老赵", want: "地下室", secret: "钥匙给了别人", attitude: 2 });
  const id = open.result.bribe.id;

  const offered = run(state, ctx, { type: "bribe.offer", bribeId: id, text: "我把知道的都说给你" });
  assert.equal(offered.result.mechanical, true);
  assert.equal(offered.result.verdict, "granted", "态度 +2 且报价够长，应当直接成交");
  assert.equal(offered.result.reason.includes("由 GM 判定"), false);
  assert.equal(offered.result.bribe.offers.length, 1);
  assert.equal(state.campaigns[0].npcs[0].revealed, true, "成交即松口");
  assert.ok(offered.result.revealed.includes("钥匙"));
  assert.deepEqual(state.campaigns[0].ledger.map((entry) => entry.kind), ["SECRET"]);
  const secretLine = logOf(state, state.activeCampaignId).find((entry) => entry.role === "system");
  assert.match(secretLine.text, /【情报】/);
});

test("bribe.offer：模型给了 verdict 就用模型的（mechanical=false）", () => {
  const { state, ctx } = seeded();
  const open = run(state, ctx, { type: "bribe.open", npcName: "老赵", attitude: -2 });
  const id = open.result.bribe.id;
  const out = run(state, ctx, {
    type: "bribe.offer",
    bribeId: id,
    text: "哦",
    verdict: "granted",
    price: "一杯酒",
    suspicionDelta: -1,
  });
  assert.equal(out.result.verdict, "granted");
  assert.equal(out.result.mechanical, false);
  assert.equal(out.result.reason, "由 GM 判定");
  assert.equal(out.result.bribe.status, "granted");
  assert.equal(out.result.bribe.price, "", "granted 不该留下要价");
});

test("bribe.offer：拒绝时怀疑度上升，撞顶后强制 cold 并停止一切变化", () => {
  const { state, ctx } = seeded();
  const open = run(state, ctx, { type: "bribe.open", npcName: "老赵", attitude: -2, secret: "钥匙给了别人" });
  const id = open.result.bribe.id;

  let last = null;
  for (let i = 0; i < 10; i += 1) last = run(state, ctx, { type: "bribe.offer", bribeId: id, text: "哦" });
  assert.equal(last.result.bribe.suspicion, 5);
  assert.equal(last.result.bribe.status, "cold");
  assert.equal(last.result.revealed, null, "翻脸了就不可能再松口");
  assert.equal(state.campaigns[0].npcs[0].revealed, false);

  const after = run(state, ctx, { type: "bribe.offer", bribeId: id, text: "我给你三根金条和一百块钱" });
  assert.equal(after.result.verdict, "cold");
  assert.equal(after.result.bribe.suspicion, 5);
});

test("bribe.offer：报价文本为空拒绝；报价条数上限 12；reveal:false 可压住揭密", () => {
  const { state, ctx } = seeded();
  const open = run(state, ctx, { type: "bribe.open", npcName: "老赵", attitude: 2, secret: "钥匙给了别人" });
  const id = open.result.bribe.id;
  assert.equal(codeOf(() => run(state, ctx, { type: "bribe.offer", bribeId: id, text: "   " })), "BAD_TEXT");
  assert.equal(codeOf(() => run(state, ctx, { type: "bribe.offer", bribeId: "br_none", text: "x" })), "BRIBE_NOT_FOUND");

  const held = run(state, ctx, { type: "bribe.offer", bribeId: id, text: "我把知道的都说给你", reveal: false });
  assert.equal(held.result.verdict, "granted");
  assert.equal(held.result.revealed, null);
  assert.equal(state.campaigns[0].npcs[0].revealed, false);

  for (let i = 0; i < LIMITS.maxBribeOffers + 3; i += 1) run(state, ctx, { type: "bribe.offer", bribeId: id, text: `第 ${i} 次` });
  assert.equal(state.campaigns[0].bribes[0].offers.length, LIMITS.maxBribeOffers);
});

test("bribe.settle：只有 reveal===true 才揭密", () => {
  const { state, ctx } = seeded();
  const open = run(state, ctx, { type: "bribe.open", npcName: "老赵", secret: "钥匙给了别人" });
  const id = open.result.bribe.id;

  const cold = run(state, ctx, { type: "bribe.settle", bribeId: id, status: "refused" });
  assert.equal(cold.result.bribe.status, "refused");
  assert.equal(cold.result.revealed, null);

  const granted = run(state, ctx, { type: "bribe.settle", bribeId: id, status: "granted", reveal: true, price: "一瓶酒" });
  assert.equal(granted.result.bribe.status, "granted");
  assert.equal(granted.result.bribe.price, "", "非 haggle 不留要价");
  assert.ok(granted.result.revealed.includes("钥匙"));

  const again = run(state, ctx, { type: "bribe.settle", bribeId: id, status: "granted", reveal: true });
  assert.equal(again.result.revealed, null, "已经揭过密就不该再揭一次");
});

test("bribe.reveal：强制揭密，只做一次", () => {
  const { state, ctx } = seeded();
  const open = run(state, ctx, { type: "bribe.open", npcName: "老赵", secret: "钥匙给了别人" });
  const id = open.result.bribe.id;
  assert.ok(run(state, ctx, { type: "bribe.reveal", bribeId: id }).result.revealed.includes("钥匙"));
  assert.equal(run(state, ctx, { type: "bribe.reveal", bribeId: id }).result.revealed, null);
  assert.equal(state.campaigns[0].ledger.filter((entry) => entry.kind === "SECRET").length, 1);
});

test("bribe：没有秘密的 NPC 无论如何都揭不出东西", () => {
  const { state, ctx } = seeded();
  const open = run(state, ctx, { type: "bribe.open", npcName: "老赵" });
  const id = open.result.bribe.id;
  assert.equal(run(state, ctx, { type: "bribe.reveal", bribeId: id }).result.revealed, null);
  assert.deepEqual(state.campaigns[0].ledger, []);
});

/* ------------------------------------------------------------------设置 */

test("settings.patch：snark 钳制、model 校验、null 清空", () => {
  const { state, ctx } = fresh();
  assert.equal(run(state, ctx, { type: "settings.patch", snark: 9 }).result.settings.snark, LIMITS.fields.snark.max);
  assert.equal(run(state, ctx, { type: "settings.patch", snark: -3 }).result.settings.snark, LIMITS.fields.snark.min);
  assert.equal(
    run(state, ctx, { type: "settings.patch", snark: null }).result.settings.snark,
    LIMITS.fields.snark.fallback,
    "null 不能算 0",
  );
  assert.equal(run(state, ctx, { type: "settings.patch", maxContextChars: 1 }).result.settings.maxContextChars, 2000);
  assert.equal(run(state, ctx, { type: "settings.patch", autoRoll: 1 }).result.settings.autoRoll, true);

  run(state, ctx, { type: "settings.patch", model: { provider: "p", model: "m" } });
  assert.deepEqual(state.settings.model, { provider: "p", model: "m" });
  assert.equal(codeOf(() => run(state, ctx, { type: "settings.patch", model: { provider: "p" } })), "BAD_MODEL");
  assert.equal(codeOf(() => run(state, ctx, { type: "settings.patch", model: { provider: "", model: "m" } })), "BAD_MODEL");
  run(state, ctx, { type: "settings.patch", model: null });
  assert.equal(state.settings.model, null);
});

/* ------------------------------------------------------------- 就地修改 */

test("applyCommand 就地修改 state（返回的是同一个对象引用）", () => {
  const { state, ctx } = seeded();
  const before = state.campaigns;
  run(state, ctx, { type: "scene.set", name: "门厅" });
  assert.equal(state.campaigns, before, "不该整档替换，否则宿主无法增量消费");
});
