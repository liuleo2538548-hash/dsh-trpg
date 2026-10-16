/**
 * dsh-trpg — 宿主半单测。
 *
 * 这里用**假 ctx** 把 index.js 真正挂起来：`inject` 立即回调，`effect` 立即执行，
 * `connection.fetch.register` 把七条路由收进一张表。然后直接拿 `Request` 打每条
 * 路由的 `route.fetch`，断言响应体 —— 不需要起 HTTP 服务，也不需要真的 harness。
 *
 * 最要紧的一条是 `requestBody: "buffered"`：漏写它时 handler 根本不会跑
 * （共享 Fetch 层会把无 body 的 GET 当成 streaming 请求，构造 Request 时直接抛错）。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ROUTES, apply } from "../lib/index.js";
import { dataDir, stateFile } from "../lib/store.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const TMP_ROOT = `${HERE}.tmp-host`;

let caseIndex = 0;

/** 每个用例一个干净的 DSH_HOME，绝不共用磁盘。 */
function freshEnv() {
  caseIndex += 1;
  const home = `${TMP_ROOT}/h${caseIndex}`;
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  return { DSH_HOME: home };
}

/** 造一个只会吐固定文本的假模型。 */
function fakeLlm(chunks, { failListModels = [] } = {}) {
  const calls = [];
  return {
    calls,
    listProviders: () => [{ id: "p1", name: "一号" }, { id: "p2", name: "二号" }],
    listModels: async (providerId) => {
      if (failListModels.includes(providerId)) throw new Error("凭据没配");
      return [{ id: `${providerId}-m`, name: `${providerId} 模型`, description: "d" }];
    },
    stream: (options) => {
      calls.push(options);
      const script = typeof chunks === "function" ? chunks(options) : chunks;
      return (async function* () {
        for (const chunk of script) yield chunk;
      })();
    },
  };
}

/**
 * 把宿主半挂起来，返回可直接打路由的调用器。
 */
function harness({ env = freshEnv(), llm = fakeLlm([]), defaultSelection = { provider: "p1", model: "p1-m" } } = {}) {
  const registered = [];
  const byKey = new Map();
  const effectLabels = [];

  const connection = {
    fetch: {
      register(route) {
        registered.push(route);
        for (const method of route.methods) byKey.set(`${method} ${route.path}`, route);
        return () => {};
      },
    },
  };

  const services = {
    connection,
    llm,
    agentDefaultModel: defaultSelection ? { currentSelection: () => defaultSelection } : null,
  };

  const ctx = {
    get: (key) => services[key] ?? null,
    effect: (fn, label) => {
      effectLabels.push(label);
      const dispose = fn();
      return typeof dispose === "function" ? dispose : () => {};
    },
    inject: (keys, callback) => {
      callback({ get: ctx.get, effect: ctx.effect, logger: ctx.logger });
      return () => {};
    },
    logger: { warn() {}, debug() {}, info() {}, error() {} },
  };

  apply(ctx, { env });

  async function call(method, path, body, { raw } = {}) {
    const route = byKey.get(`${method} ${path}`);
    assert.ok(route, `路由没挂上：${method} ${path}`);
    const init = { method, headers: {} };
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const response = await route.fetch(new Request(`http://127.0.0.1:1${path}`, init));
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    return { response, text, payload };
  }

  /** 解析 SSE 正文成事件数组。 */
  async function sse(method, path, body) {
    const out = await call(method, path, body);
    const events = out.text
      .split("\n\n")
      .map((frame) => frame.trim())
      .filter(Boolean)
      .map((frame) => JSON.parse(frame.replace(/^data:\s?/, "")));
    return { ...out, events };
  }

  return { ctx, routes: byKey, registered, effectLabels, call, sse, env };
}

/* ------------------------------------------------------------- 路由挂载 */

test("apply：七条路由全部挂上，路径与 ROUTES 一致，methods 非空", () => {
  const { registered, routes } = harness();
  assert.equal(registered.length, 7);
  const paths = registered.map((route) => route.path).sort();
  assert.deepEqual(paths, Object.values(ROUTES).sort());
  for (const route of registered) {
    assert.ok(Array.isArray(route.methods) && route.methods.length > 0, `${route.path} 没有 methods`);
    assert.ok(route.path.startsWith("/api/"), `${route.path} 不在 /api 下`);
    assert.equal(typeof route.fetch, "function");
  }
  assert.equal(routes.size, 7);
});

test("apply：每条路由都显式声明 requestBody:'buffered'（漏写会让 handler 静默不跑）", () => {
  const { registered } = harness();
  for (const route of registered) {
    assert.equal(route.requestBody, "buffered", `${route.path} 漏了 requestBody`);
  }
});

test("apply：connection 服务不可用时只 warn，不抛错", () => {
  const ctx = {
    get: () => null,
    effect: () => () => {},
    inject: (keys, callback) => {
      callback({ get: () => null, effect: () => () => {}, logger: {} });
      return () => {};
    },
    logger: { warn() {} },
  };
  assert.doesNotThrow(() => apply(ctx, { env: freshEnv() }));
});

/* ---------------------------------------------------------------- /state */

test("GET /state：空档也回 ok:true，带 state 与派生 view", async () => {
  const h = harness();
  const { response, payload } = await h.call("GET", ROUTES.state);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(payload.ok, true);
  assert.equal(payload.state.activeCampaignId, null);
  assert.deepEqual(payload.state.campaigns, []);
  assert.ok(payload.view, "必须有派生视图");
  assert.equal(payload.lastLoadError, null);
});

/* -------------------------------------------------------------- /command */

test("POST /command：命令落盘、状态回流，且 view 跟着更新", async () => {
  const h = harness();
  const created = await h.call("POST", ROUTES.command, { type: "campaign.create", name: "雨夜", pcName: "林晚" });
  assert.equal(created.payload.ok, true);
  const campaignId = created.payload.result.campaignId;
  assert.equal(created.payload.state.activeCampaignId, campaignId);
  assert.equal(created.payload.view.campaign.name, "雨夜");

  const scene = await h.call("POST", ROUTES.command, { type: "scene.set", name: "门厅", mood: "ominous" });
  assert.equal(scene.payload.ok, true);
  assert.equal(scene.payload.view.campaign.scene.name, "门厅");

  // 真的落盘了（不是只在内存里）
  const file = stateFile(h.env);
  assert.ok(existsSync(file), "state.json 应当已经写盘");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(doc.campaigns[0].name, "雨夜");
  assert.equal(doc.campaigns[0].scene.name, "门厅");
});

test("POST /command：命令层错误按 code 回 fail，不 500", async () => {
  const h = harness();
  const bad = await h.call("POST", ROUTES.command, { type: "nope" });
  assert.equal(bad.payload.ok, false);
  assert.equal(bad.payload.error.code, "UNKNOWN_COMMAND");
  assert.equal(bad.response.status, 200);

  const noCampaign = await h.call("POST", ROUTES.command, { type: "scene.set", name: "x" });
  assert.equal(noCampaign.payload.error.code, "NO_ACTIVE_CAMPAIGN");
});

test("POST /command：请求体不是 JSON 时回 BAD_JSON", async () => {
  const h = harness();
  const out = await h.call("POST", ROUTES.command, undefined, { raw: "这不是 json" });
  assert.equal(out.payload.ok, false);
  assert.equal(out.payload.error.code, "BAD_JSON");
});

test("POST /command：dice.roll 真的用宿主掷骰器掷出合法点数", async () => {
  const h = harness();
  await h.call("POST", ROUTES.command, { type: "campaign.create", name: "雨夜" });
  const rolled = await h.call("POST", ROUTES.command, { type: "dice.roll", formula: "1d100", dc: 50, reason: "撬锁" });
  assert.equal(rolled.payload.ok, true);
  // 命令层的 result 外层还包了一层：{ ok, state, view, result:{ campaignId, result:{ roll, entry } } }
  const roll = rolled.payload.result.result.roll;
  assert.equal(roll.text, "1d100");
  assert.ok(Number.isInteger(roll.total) && roll.total >= 1 && roll.total <= 100, `点数越界：${roll.total}`);
  assert.equal(roll.dc, 50);
  assert.equal(roll.reason, "撬锁");
});

test("POST /command：删档时 invalidate 剧本缓存，剧本随之读不到", async () => {
  const h = harness();
  const created = await h.call("POST", ROUTES.command, { type: "campaign.create", name: "雨夜" });
  const campaignId = created.payload.result.campaignId;
  await h.call("POST", ROUTES.scenario, { action: "import", source: "## 第一幕\n地下室很冷。\n## 第二幕\n他撒谎了。", title: "试剧本" });

  const listed = await h.call("POST", ROUTES.scenario, { action: "list" });
  assert.equal(listed.payload.scenario.sections.length, 2);

  const dropped = await h.call("POST", ROUTES.command, { type: "campaign.delete", campaignId });
  assert.equal(dropped.payload.result.result.dropScenario, campaignId);

  const after = await h.call("POST", ROUTES.scenario, { action: "list" });
  assert.equal(after.payload.ok, false);
  assert.equal(after.payload.error.code, "NO_ACTIVE_CAMPAIGN");
});

/* --------------------------------------------------------------- /models */

test("GET /models：列 providers 与 models，带 fallback", async () => {
  const h = harness({ llm: fakeLlm([]) });
  const { payload } = await h.call("GET", ROUTES.models);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.providers.map((entry) => entry.id), ["p1", "p2"]);
  assert.deepEqual(payload.models.map((entry) => entry.id), ["p1-m", "p2-m"]);
  assert.equal(payload.models[0].providerName, "一号");
  assert.deepEqual(payload.fallback, { provider: "p1", model: "p1-m" });
});

test("GET /models：某个 provider 取模型失败时，别的 provider 仍然列出来", async () => {
  const h = harness({ llm: fakeLlm([], { failListModels: ["p1"] }) });
  const { payload } = await h.call("GET", ROUTES.models);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.models.map((entry) => entry.id), ["p2-m"]);
});

test("GET /models：没有 llm 服务时回 NO_LLM", async () => {
  const h = harness({ llm: null });
  const { payload } = await h.call("GET", ROUTES.models);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, "NO_LLM");
});

/* ------------------------------------------------------------- /scenario */

test("POST /scenario：没有活动战役一律 NO_ACTIVE_CAMPAIGN", async () => {
  const h = harness();
  for (const action of ["list", "read", "search", "import"]) {
    const { payload } = await h.call("POST", ROUTES.scenario, { action, source: "x", query: "x" });
    assert.equal(payload.error.code, "NO_ACTIVE_CAMPAIGN", `action=${action}`);
  }
});

test("POST /scenario：import 后能 list、read、search", async () => {
  const h = harness();
  await h.call("POST", ROUTES.command, { type: "campaign.create", name: "雨夜" });

  const source = ["## 第一幕 雨夜", "地下室的灯忽明忽暗。", "## 第二幕 撒谎", "老赵说他没见过钥匙。"].join("\n");
  const imported = await h.call("POST", ROUTES.scenario, { action: "import", source, title: "试剧本" });
  assert.equal(imported.payload.ok, true);
  assert.equal(imported.payload.scenario.title, "试剧本");
  assert.equal(imported.payload.scenario.sectionCount, 2);
  assert.equal(typeof imported.payload.digest, "string");

  const listed = await h.call("POST", ROUTES.scenario, { action: "list" });
  assert.equal(listed.payload.scenario.sections.length, 2);
  assert.equal(listed.payload.scenario.sections[0].id, "s1");

  const read = await h.call("POST", ROUTES.scenario, { action: "read", sectionId: "s2" });
  assert.equal(read.payload.ok, true);
  assert.match(read.payload.section.body, /钥匙/);

  const missing = await h.call("POST", ROUTES.scenario, { action: "read", sectionId: "s99" });
  assert.equal(missing.payload.error.code, "SECTION_NOT_FOUND");

  const search = await h.call("POST", ROUTES.scenario, { action: "search", query: "钥匙" });
  assert.equal(search.payload.ok, true);
  assert.ok(search.payload.hits.length >= 1);
  assert.equal(search.payload.query, "钥匙");
});

test("POST /scenario：空原文导入后是空剧本，不伪造一节", async () => {
  const h = harness();
  await h.call("POST", ROUTES.command, { type: "campaign.create", name: "雨夜" });
  const imported = await h.call("POST", ROUTES.scenario, { action: "import", source: "   \n  \n" });
  assert.equal(imported.payload.ok, true);
  assert.equal(imported.payload.scenario.sectionCount, 0);
});

/* --------------------------------------------------------------- /import */

test("POST /import：合法整档替换；坏档按 SchemaError 的 code 拒绝", async () => {
  const h = harness();
  await h.call("POST", ROUTES.command, { type: "campaign.create", name: "原本的" });

  const replaced = await h.call("POST", ROUTES.import, { schemaVersion: 1, activeCampaignId: null, campaigns: [], log: [], settings: {} });
  assert.equal(replaced.payload.ok, true);
  assert.deepEqual(replaced.payload.state.campaigns, []);

  const tooNew = await h.call("POST", ROUTES.import, { schemaVersion: 99, campaigns: [], log: [] });
  assert.equal(tooNew.payload.ok, false);
  assert.equal(tooNew.payload.error.code, "SCHEMA_TOO_NEW");

  const notObject = await h.call("POST", ROUTES.import, undefined, { raw: '"字符串"' });
  assert.equal(notObject.payload.error.code, "NOT_AN_OBJECT");

  // 坏档不该污染已经在盘上的档
  const again = await h.call("POST", ROUTES.import, { schemaVersion: 1 });
  assert.equal(again.payload.error.code, "BAD_SHAPE");
  const state = await h.call("GET", ROUTES.state);
  assert.equal(state.payload.ok, true);
});

/* ----------------------------------------------------------------- /turn */

function turnScript(text) {
  return [{ type: "text-delta", text }, { type: "finish", reason: { kind: "ok" } }];
}

test("POST /turn：逐块 delta，指令落盘，最后发 done 带 view", async () => {
  const h = harness({ llm: fakeLlm(turnScript("<<mood ominous>>雨声压下来。\n<<roll 1d100 dc=55>>")) });
  const created = await h.call("POST", ROUTES.command, { type: "campaign.create", name: "雨夜" });
  const campaignId = created.payload.result.campaignId;

  const { response, events } = await h.sse("POST", ROUTES.turn, { campaignId, content: "我推开门" });
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.equal(response.headers.get("x-accel-buffering"), "no");

  assert.equal(events.filter((event) => event.type === "delta").length, 1);
  const mood = events.find((event) => event.type === "mood");
  assert.equal(mood.mood, "ominous");
  assert.ok(mood.emoji.length > 0);

  const roll = events.find((event) => event.type === "roll");
  assert.equal(roll.dc, 55);
  assert.ok(roll.total >= 1 && roll.total <= 100);

  const done = events.find((event) => event.type === "done");
  assert.equal(done.status, "done");
  assert.ok(done.view, "done 必须带 view");
  assert.equal(done.content.includes("<<"), false, "正文里不能残留指令");

  // 落盘：玩家发言、骰子线报、GM 叙述、场外音（snark 默认 3 >= 2）
  const state = await h.call("GET", ROUTES.state);
  const log = state.payload.state.log.filter((entry) => entry.campaignId === campaignId);
  assert.deepEqual(log.map((entry) => entry.role), ["player", "dice", "gm", "gm"]);
  assert.equal(log[0].text, "我推开门");
  assert.equal(log[1].meta.kind, "roll");
  assert.equal(log[2].text.includes("<<"), false, "GM 正文里不能残留指令");
  assert.equal(log[3].meta.kind, "snark");
  assert.equal(state.payload.view.campaign.scene.mood, "ominous");
  assert.equal(state.payload.view.campaign.turn, 1);
});

test("POST /turn：模型给非法公式只发 roll-error，绝不毁掉整回合", async () => {
  const h = harness({ llm: fakeLlm(turnScript("<<roll 不是公式>>但他还是说了下去。")) });
  await h.call("POST", ROUTES.command, { type: "campaign.create", name: "雨夜" });
  const { events } = await h.sse("POST", ROUTES.turn, { content: "我听着" });
  const bad = events.find((event) => event.type === "roll-error");
  assert.ok(bad, "非法公式必须报 roll-error");
  assert.equal(bad.formula, "不是公式");
  assert.ok(events.find((event) => event.type === "done"), "回合仍然要正常收尾");
});

test("POST /turn：snark>=2 时追加一条 meta.kind==='snark' 的场外音", async () => {
  const h = harness({ llm: fakeLlm(turnScript("他慢慢抬起头。")) });
  await h.call("POST", ROUTES.command, { type: "campaign.create", name: "雨夜" });
  await h.call("POST", ROUTES.command, { type: "settings.patch", snark: 5 });

  const { events } = await h.sse("POST", ROUTES.turn, { content: "我盯着他看" });
  const snark = events.find((event) => event.type === "snark");
  assert.ok(snark, "snark=5 应当出场外音");
  assert.equal(typeof snark.text, "string");
  assert.ok(snark.text.length > 0);
  assert.equal(snark.entry.meta.kind, "snark");
});

test("POST /turn：参数不对时按序回 BAD_TEXT / CAMPAIGN_NOT_FOUND / NO_MODEL / NO_LLM", async () => {
  const h = harness({ llm: fakeLlm(turnScript("x")) });
  const created = await h.call("POST", ROUTES.command, { type: "campaign.create", name: "雨夜" });
  const campaignId = created.payload.result.campaignId;

  const blank = await h.call("POST", ROUTES.turn, { campaignId, content: "   " });
  assert.equal(blank.payload.error.code, "BAD_TEXT");

  const missing = await h.call("POST", ROUTES.turn, { campaignId: "c_none", content: "说话" });
  assert.equal(missing.payload.error.code, "CAMPAIGN_NOT_FOUND");

  const noModel = harness({ llm: fakeLlm(turnScript("x")), defaultSelection: null });
  await noModel.call("POST", ROUTES.command, { type: "campaign.create", name: "雨夜" });
  const which = await noModel.call("POST", ROUTES.turn, { content: "说话" });
  assert.equal(which.payload.error.code, "NO_MODEL");

  const noLlm = harness({ llm: null });
  await noLlm.call("POST", ROUTES.command, { type: "campaign.create", name: "雨夜" });
  const none = await noLlm.call("POST", ROUTES.turn, { content: "说话" });
  assert.equal(none.payload.error.code, "NO_LLM");
});
test("POST /turn：模型流报错时把已生成正文一起回传，且玩家发言不丢", async () => {
  const h = harness({
    llm: fakeLlm([{ type: "text-delta", text: "他张了张嘴" }, { type: "finish", reason: { kind: "error", failure: { message: "上游断了", code: "UPSTREAM" } } }]),
  });
  await h.call("POST", ROUTES.command, { type: "campaign.create", name: "雨夜" });
  const { events } = await h.sse("POST", ROUTES.turn, { content: "我问他是谁" });

  const error = events.find((event) => event.type === "error");
  assert.equal(error.code, "UPSTREAM");
  assert.equal(error.message, "上游断了");
  assert.equal(error.content, "他张了张嘴");

  const state = await h.call("GET", ROUTES.state);
  const log = state.payload.state.log;
  assert.ok(log.some((entry) => entry.role === "player" && entry.text === "我问他是谁"), "玩家发言必须先落盘");
});

test("POST /turn：选中模型优先用请求里的，其次档里的，最后回落默认", async () => {
  const llm = fakeLlm(turnScript("好。"));
  const h = harness({ llm, defaultSelection: { provider: "fallback", model: "fallback-m" } });
  await h.call("POST", ROUTES.command, { type: "campaign.create", name: "雨夜" });

  await h.sse("POST", ROUTES.turn, { content: "一", model: { provider: "req", model: "req-m" } });
  assert.equal(llm.calls.at(-1).provider, "req");

  await h.call("POST", ROUTES.command, { type: "settings.patch", model: { provider: "saved", model: "saved-m" } });
  await h.sse("POST", ROUTES.turn, { content: "二" });
  assert.equal(llm.calls.at(-1).provider, "saved");

  await h.call("POST", ROUTES.command, { type: "settings.patch", model: null });
  await h.sse("POST", ROUTES.turn, { content: "三" });
  assert.equal(llm.calls.at(-1).provider, "fallback");
});

test("POST /turn：system 提示里必须禁止模型自己编骰点", async () => {
  const llm = fakeLlm(turnScript("好。"));
  const h = harness({ llm });
  await h.call("POST", ROUTES.command, { type: "campaign.create", name: "雨夜" });
  await h.sse("POST", ROUTES.turn, { content: "我搜查一遍" });
  const system = llm.calls.at(-1).system;
  assert.equal(typeof system, "string");
  assert.match(system, /<<roll/);
  assert.match(system, /不/);
});

/* ---------------------------------------------------------------- /bribe */

test("POST /bribe：没给 bribeId 时自己开一笔交易，成交即揭密", async () => {
  const h = harness({ llm: fakeLlm(turnScript("他掂了掂信封。\n<<bribe granted price=一瓶酒>>")) });
  await h.call("POST", ROUTES.command, { type: "campaign.create", name: "雨夜" });

  const { events } = await h.sse("POST", ROUTES.bribe, {
    npcName: "老赵",
    want: "地下室",
    secret: "钥匙在花盆底下",
    attitude: 1,
    offer: "我把知道的都说给你",
  });
  const verdict = events.find((event) => event.type === "verdict");
  assert.equal(verdict.verdict, "granted");
  assert.equal(verdict.mechanical, false, "模型给了 verdict 就不算机械兜底");
  assert.equal(verdict.revealed, "钥匙在花盆底下");

  const done = events.find((event) => event.type === "done");
  assert.ok(done);

  const state = await h.call("GET", ROUTES.state);
  assert.ok(state.payload.state.log.some((entry) => entry.role === "system" && entry.text.includes("【情报】")));
  assert.ok(state.payload.state.campaigns[0].ledger.some((entry) => entry.kind === "SECRET"));
});

test("POST /bribe：模型没给指令时退回确定性兜底（mechanical=true）", async () => {
  const h = harness({ llm: fakeLlm(turnScript("他哼了一声。")) });
  await h.call("POST", ROUTES.command, { type: "campaign.create", name: "雨夜" });

  const { events } = await h.sse("POST", ROUTES.bribe, { npcName: "老赵", want: "地下室", attitude: 2, offer: "我把知道的都说给你" });
  const verdict = events.find((event) => event.type === "verdict");
  assert.equal(verdict.mechanical, true);
  assert.ok(["granted", "haggle", "refused", "cold"].includes(verdict.verdict));
  assert.equal(typeof verdict.reason, "string");
});

test("POST /bribe：参数不对时按序回 BAD_TEXT / CAMPAIGN_NOT_FOUND / BRIBE_CLOSED", async () => {
  const h = harness({ llm: fakeLlm(turnScript("x")) });
  await h.call("POST", ROUTES.command, { type: "campaign.create", name: "雨夜" });

  const blank = await h.call("POST", ROUTES.bribe, { npcName: "老赵", offer: "   " });
  assert.equal(blank.payload.error.code, "BAD_TEXT");

  const missing = await h.call("POST", ROUTES.bribe, { campaignId: "c_none", npcName: "老赵", offer: "给你钱" });
  assert.equal(missing.payload.error.code, "CAMPAIGN_NOT_FOUND");

  // 先把它谈成 granted，再谈一次就该被拒
  const opened = await h.sse("POST", ROUTES.bribe, { npcName: "老赵", attitude: 2, offer: "我把知道的都说给你" });
  const bribeId = opened.events.find((event) => event.type === "verdict").bribe.id;
  const closed = await h.call("POST", ROUTES.bribe, { bribeId, offer: "再来一次" });
  assert.equal(closed.payload.error.code, "BRIBE_CLOSED");
});

/* -------------------------------------------------------------- 持久化 */

test("重新 apply 同一份 DSH_HOME：状态从盘上恢复", async () => {
  const env = freshEnv();
  const first = harness({ env });
  const created = await first.call("POST", ROUTES.command, { type: "campaign.create", name: "雨夜" });
  const campaignId = created.payload.result.campaignId;
  await first.call("POST", ROUTES.command, { type: "scene.set", name: "门厅" });

  const second = harness({ env });
  const { payload } = await second.call("GET", ROUTES.state);
  assert.equal(payload.state.activeCampaignId, campaignId);
  assert.equal(payload.state.campaigns[0].name, "雨夜");
  assert.equal(payload.state.campaigns[0].scene.name, "门厅");
  assert.equal(payload.lastLoadError, null);
});

test("坏档在 apply 时被隔离，/state 仍然可用并报 lastLoadError", async () => {
  const env = freshEnv();
  mkdirSync(dataDir(env), { recursive: true });
  const file = stateFile(env);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(file, "{ 这不是 json", "utf8");

  const h = harness({ env });
  const { payload } = await h.call("GET", ROUTES.state);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.state.campaigns, []);
  assert.equal(typeof payload.lastLoadError, "string");
  assert.ok(payload.lastLoadError.length > 0);
});
