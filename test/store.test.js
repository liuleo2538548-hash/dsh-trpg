/**
 * dsh-trpg — 持久化层单测。
 *
 * 临时目录一律放在**工作区内**（test/.tmp-store），不用 os.tmpdir()：
 * 本机的沙箱只保证会话工作区可写。
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { SCHEMA_VERSION, SchemaError } from "../lib/schema.js";
import {
  StoreError,
  TrpgStore,
  createStore,
  dataDir,
  emptyScenarioDoc,
  normalizeScenarioDoc,
  scenarioDir,
  scenarioFile,
  stateFile,
} from "../lib/store.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const TMP_ROOT = join(HERE, ".tmp-store");
let seq = 0;

/** 每个用例一个全新的 DSH_HOME，互不干扰。 */
function freshEnv() {
  const home = join(TMP_ROOT, `h${(seq += 1)}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  return { DSH_HOME: home };
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

/* ------------------------------------------------------------------ 路径 */

test("dataDir / stateFile / scenarioDir 都落在 DSH_HOME 下", () => {
  const env = { DSH_HOME: "C:\\fake\\home" };
  assert.equal(dataDir(env), join("C:\\fake\\home", "dsh-trpg"));
  assert.equal(stateFile(env), join("C:\\fake\\home", "dsh-trpg", "state.json"));
  assert.equal(scenarioDir(env), join("C:\\fake\\home", "dsh-trpg", "scenarios"));
});

test("DSH_HOME 为空/非字符串时回落到 ~/.dsh", () => {
  const expected = join(homedir(), ".dsh", "dsh-trpg", "state.json");
  assert.equal(stateFile({ DSH_HOME: "" }), expected);
  assert.equal(stateFile({ DSH_HOME: "   " }), expected);
  assert.equal(stateFile({ DSH_HOME: 42 }), expected);
  assert.equal(stateFile({}), expected);
  assert.equal(stateFile(null), expected);
});

test("scenarioFile 只接受白名单 id：这是唯一的路径注入面", () => {
  const env = { DSH_HOME: "C:\\fake\\home" };
  assert.equal(scenarioFile(env, "c_abc-1"), join(scenarioDir(env), "c_abc-1.json"));
  for (const bad of ["../../evil", "..\\evil", "a/b", "a\\b", "", " ", "c 1", "c.1", null, 42, {}, ["c1"]]) {
    assert.throws(
      () => scenarioFile(env, bad),
      (error) => error instanceof StoreError && error.code === "BAD_CAMPAIGN_ID",
      `应当拒绝 ${JSON.stringify(bad)}`,
    );
  }
});

/* ------------------------------------------------------------ 读盘与坏档 */

test("读不到文件 → 空档，loaded=true，不抛错", () => {
  const env = freshEnv();
  const store = new TrpgStore({ env });
  const state = store.load();
  assert.equal(store.loaded, true);
  assert.equal(store.lastLoadError, null);
  assert.equal(state.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(state.campaigns, []);
  assert.equal(state.activeCampaignId, null);
});

test("save → load 往返：战役与设置都不丢", () => {
  const env = freshEnv();
  const first = new TrpgStore({ env });
  first.load();
  first.state.settings.snark = 5;
  first.state.campaigns.push({ id: "c_round", name: "雨夜", schemaVersion: SCHEMA_VERSION });
  first.state.activeCampaignId = "c_round";
  first.save();

  assert.ok(existsSync(stateFile(env)), "save 之后应当有 state.json");
  const second = new TrpgStore({ env });
  const loaded = second.load();
  assert.equal(loaded.settings.snark, 5);
  assert.equal(loaded.campaigns.length, 1);
  assert.equal(loaded.campaigns[0].id, "c_round");
  assert.equal(loaded.campaigns[0].name, "雨夜");
  assert.equal(loaded.activeCampaignId, "c_round");
  assert.equal(second.lastLoadError, null);
});

test("坏档不改坏整个插件：开空档 + 原文件改名留证", () => {
  const env = freshEnv();
  mkdirSync(dataDir(env), { recursive: true });
  writeFileSync(stateFile(env), "{ 这不是 JSON", "utf8");
  const store = new TrpgStore({ env });
  const state = store.load();

  assert.deepEqual(state.campaigns, []);
  assert.ok(store.lastLoadError, "应当记下 lastLoadError");
  assert.equal(existsSync(stateFile(env)), false, "坏档应当被改名让位");

  const dir = dataDir(env);
  const leftovers = readdirSync(dir).filter((name) => name.includes(".corrupt-"));
  assert.equal(leftovers.length, 1, `应当留下一个 .corrupt- 证据文件，实际 ${JSON.stringify(leftovers)}`);
  assert.equal(readFileSync(join(dir, leftovers[0]), "utf8"), "{ 这不是 JSON");
});

test("schemaVersion 高于本插件 → 同样按坏档处理，不会崩", () => {
  const env = freshEnv();
  mkdirSync(dataDir(env), { recursive: true });
  writeFileSync(stateFile(env), JSON.stringify({ schemaVersion: 999, campaigns: [], log: [] }), "utf8");
  const store = new TrpgStore({ env });
  store.load();
  assert.equal(store.state.schemaVersion, SCHEMA_VERSION);
  assert.ok(store.lastLoadError instanceof SchemaError);
  assert.equal(store.lastLoadError.code, "SCHEMA_TOO_NEW");
});

/* ------------------------------------------------------------- 写入通道 */

test("mutate 立即落盘，并把 fn 的返回值原样传出", () => {
  const env = freshEnv();
  const store = new TrpgStore({ env });
  const returned = store.mutate((state) => {
    state.settings.autoRoll = true;
    return { ok: "yes" };
  });
  assert.deepEqual(returned, { ok: "yes" });
  assert.equal(readJson(stateFile(env)).settings.autoRoll, true);
});

test("ensure 只在第一次读盘", () => {
  const env = freshEnv();
  const store = new TrpgStore({ env });
  assert.equal(store.loaded, false);
  const state = store.ensure();
  assert.equal(store.loaded, true);
  assert.equal(state, store.state, "ensure 返回的就是内存里那一份");
});

test("保存走 .tmp + rename：落盘后不留下半截文件", () => {
  const env = freshEnv();
  const store = new TrpgStore({ env });
  store.load();
  store.save();
  const dir = dataDir(env);
  const names = readdirSync(dir);
  assert.deepEqual(names, ["state.json"], `只该有一个正式文件，实际 ${JSON.stringify(names)}`);
  assert.ok(!existsSync(`${stateFile(env)}.tmp`));
});

test("state.updatedAt 每次 save 都会被刷新", () => {
  const env = freshEnv();
  const store = new TrpgStore({ env });
  store.load();
  store.state.updatedAt = 0;
  store.save();
  assert.ok(store.state.updatedAt > 0);
  assert.equal(readJson(stateFile(env)).updatedAt, store.state.updatedAt);
});

/* --------------------------------------------------------------- 导入 */

test("replace：形状不对抛 SchemaError，旧档原地不动", () => {
  const env = freshEnv();
  const store = new TrpgStore({ env });
  store.mutate((state) => {
    state.settings.snark = 4;
  });
  const before = readFileSync(stateFile(env), "utf8");

  for (const bad of [null, 42, [], "x", {}, { schemaVersion: SCHEMA_VERSION, campaigns: {} }]) {
    assert.throws(
      () => store.replace(bad),
      (error) => error instanceof SchemaError,
      `应当拒绝 ${JSON.stringify(bad)}`,
    );
    assert.equal(store.state.settings.snark, 4, "失败后内存里的档也不能变");
    assert.equal(readFileSync(stateFile(env), "utf8"), before, "失败后磁盘上的档也不能变");
  }
});

test("replace：合法文档整档替换并立刻落盘", () => {
  const env = freshEnv();
  const store = new TrpgStore({ env });
  store.load();
  const next = store.replace({
    schemaVersion: SCHEMA_VERSION,
    activeCampaignId: "c_a",
    campaigns: [{ id: "c_a", name: "导入的战役" }],
    log: [],
    settings: { snark: 1 },
  });
  assert.equal(next.campaigns.length, 1);
  assert.equal(next.activeCampaignId, "c_a");
  assert.equal(next.settings.snark, 1);
  assert.equal(readJson(stateFile(env)).campaigns[0].name, "导入的战役");
  assert.equal(store.loaded, true);
});

test("replace：缺失 activeCampaignId 时回落到第一个战役", () => {
  const env = freshEnv();
  const store = new TrpgStore({ env });
  store.replace({
    schemaVersion: SCHEMA_VERSION,
    campaigns: [{ id: "c_first", name: "一" }, { id: "c_second", name: "二" }],
    log: [],
  });
  assert.equal(store.state.activeCampaignId, "c_first");
});

/* --------------------------------------------------------------- 剧本 */

test("剧本：没写过 → 空信封；坏 id 也被吞掉不抛错", () => {
  const env = freshEnv();
  const store = new TrpgStore({ env });
  assert.deepEqual(store.readScenario("c_none"), emptyScenarioDoc());
  assert.deepEqual(store.readScenario("../../evil"), emptyScenarioDoc());
  assert.deepEqual(store.readScenario(null), emptyScenarioDoc());
});

test("剧本：write → read 往返，且文件落在 scenarios/<id>.json", () => {
  const env = freshEnv();
  const store = new TrpgStore({ env });
  const file = store.writeScenario("c_sc", {
    title: "雨夜",
    source: "第一幕 雨夜\n你到得太早。",
    sections: [{ id: "s1", heading: "雨夜", level: 1, body: "你到得太早。", chars: 6 }],
    importedAt: 123,
  });
  assert.equal(file, join(scenarioDir(env), "c_sc.json"));
  const doc = store.readScenario("c_sc");
  assert.equal(doc.title, "雨夜");
  assert.equal(doc.sections.length, 1);
  assert.equal(doc.sections[0].body, "你到得太早。");
  assert.equal(doc.importedAt, 123);
});

test("剧本：文件坏了 → 空信封，不抛错", () => {
  const env = freshEnv();
  const store = new TrpgStore({ env });
  store.writeScenario("c_broken", { title: "x" });
  writeFileSync(join(scenarioDir(env), "c_broken.json"), "}}}", "utf8");
  assert.deepEqual(store.readScenario("c_broken"), emptyScenarioDoc());
});

test("剧本：dropScenario 删得掉、重复删返回 false、坏 id 也返回 false", () => {
  const env = freshEnv();
  const store = new TrpgStore({ env });
  store.writeScenario("c_gone", { title: "x" });
  assert.equal(store.dropScenario("c_gone"), true);
  assert.equal(existsSync(join(scenarioDir(env), "c_gone.json")), false);
  assert.equal(store.dropScenario("c_gone"), false);
  assert.equal(store.dropScenario("../evil"), false);
});

test("normalizeScenarioDoc：垃圾输入 → 空信封；半成品条目被补全", () => {
  assert.deepEqual(normalizeScenarioDoc(null), emptyScenarioDoc());
  assert.deepEqual(normalizeScenarioDoc([1, 2]), emptyScenarioDoc());
  assert.deepEqual(normalizeScenarioDoc("x"), emptyScenarioDoc());

  const doc = normalizeScenarioDoc({
    title: 42,
    source: null,
    importedAt: "不是数字",
    sections: [null, "x", { heading: "标题", body: null, level: "2", chars: "7" }],
  });
  assert.equal(doc.title, "");
  assert.equal(doc.source, "");
  assert.equal(doc.importedAt, 0);
  assert.equal(doc.sections.length, 1, "非对象条目应当被丢掉");
  assert.equal(doc.sections[0].id, "s1", "缺 id 时按序补 s1…");
  assert.equal(doc.sections[0].heading, "标题");
  assert.equal(doc.sections[0].body, "");
  assert.equal(doc.sections[0].level, 2);
  assert.equal(doc.sections[0].chars, 7);
});

test("createStore 与 TrpgStore 等价，且可独立指定 env", () => {
  const env = freshEnv();
  const store = createStore({ env });
  assert.ok(store instanceof TrpgStore);
  assert.equal(store.file, stateFile(env));
  assert.equal(store.scenarioDir, scenarioDir(env));
});
