/**
 * dsh-trpg — 持久化层。
 *
 * 两个文件：
 *   <DSH_HOME>/dsh-trpg/state.json               轻档（战役 + 线报 + 设置）
 *   <DSH_HOME>/dsh-trpg/scenarios/<campaignId>.json   重档（剧本原文 + 解析出的节）
 *
 * 为什么拆开：剧本原文动辄几百 KB，塞进 state.json 会让每次 `/state` 响应都背着一整本
 * 剧本进浏览器。拆开后目录摘要走 `/state`，正文只在 `/scenario` 路由里按需取。
 *
 * 落盘一律「写 .tmp 再 rename」，避免半截 JSON 覆盖掉好档。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { ID_RE, emptyState, normalizeState, serializeState } from "./schema.js";

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

export function dataDir(env = process.env) {
  const home = env && typeof env.DSH_HOME === "string" && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : join(homedir(), ".dsh");
  return join(home, "dsh-trpg");
}

export function stateFile(env = process.env) {
  return join(dataDir(env), "state.json");
}

export function scenarioDir(env = process.env) {
  return join(dataDir(env), "scenarios");
}

/**
 * campaignId 会直接进文件名，所以必须先过 ID_RE 白名单再拼路径 —— 这是本插件唯一的路径注入面。
 */
export function scenarioFile(env, campaignId) {
  if (typeof campaignId !== "string" || !ID_RE.test(campaignId)) {
    throw new StoreError("BAD_CAMPAIGN_ID", `非法 campaignId：${String(campaignId)}`);
  }
  return join(scenarioDir(env), `${campaignId}.json`);
}

/* --------------------------------------------------------------- 剧本信封 */

/**
 * 剧本信封的本地校验。
 * 刻意**不** import scenario.js：解析是那个模块的事，这里只负责「收进来的东西形状对不对」，
 * 让持久化层可以独立测试、独立回归。
 */
export function emptyScenarioDoc() {
  return { title: "", source: "", sections: [], importedAt: 0 };
}

export function normalizeScenarioDoc(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptyScenarioDoc();
  const sections = Array.isArray(raw.sections)
    ? raw.sections
        .filter((entry) => entry && typeof entry === "object")
        .map((entry, index) => ({
          id: typeof entry.id === "string" && entry.id ? entry.id : `s${index + 1}`,
          heading: typeof entry.heading === "string" ? entry.heading : "",
          level: Number.isFinite(Number(entry.level)) ? Number(entry.level) : 0,
          body: typeof entry.body === "string" ? entry.body : "",
          startLine: Number.isFinite(Number(entry.startLine)) ? Number(entry.startLine) : 0,
          endLine: Number.isFinite(Number(entry.endLine)) ? Number(entry.endLine) : 0,
          chars: Number.isFinite(Number(entry.chars)) ? Number(entry.chars) : 0,
        }))
    : [];
  return {
    title: typeof raw.title === "string" ? raw.title : "",
    source: typeof raw.source === "string" ? raw.source : "",
    sections,
    importedAt: Number.isFinite(Number(raw.importedAt)) ? Number(raw.importedAt) : 0,
  };
}

function atomicWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

/* ------------------------------------------------------------------- store */

export class TrpgStore {
  constructor({ env = process.env } = {}) {
    this.env = env;
    this.file = stateFile(env);
    this.scenarioDir = scenarioDir(env);
    this.state = emptyState();
    this.loaded = false;
    this.lastLoadError = null;
  }

  /**
   * 读盘。任何失败都不抛：读不到 → 空档；读得到但坏了 → 把坏档改名留证，然后开空档。
   * 「绝不因为一个坏文件让插件起不来」比「报错给用户看」重要得多。
   */
  load() {
    this.lastLoadError = null;
    try {
      const text = readFileSync(this.file, "utf8");
      this.state = normalizeState(JSON.parse(text));
    } catch (error) {
      if (error && error.code === "ENOENT") {
        this.state = emptyState();
      } else {
        this.lastLoadError = error;
        this.state = emptyState();
        try {
          const stamp = Date.now();
          renameSync(this.file, `${this.file}.corrupt-${stamp}`);
        } catch {
          /* 留证失败不影响开档 */
        }
      }
    }
    this.loaded = true;
    return this.state;
  }

  ensure() {
    if (!this.loaded) this.load();
    return this.state;
  }

  save() {
    this.state.updatedAt = Date.now();
    atomicWrite(this.file, serializeState(this.state));
    return this.state;
  }

  /** 所有写入的唯一通道：改完立刻落盘。fn 的返回值会原样传给调用方。 */
  mutate(fn) {
    this.ensure();
    const result = fn(this.state);
    this.save();
    return result;
  }

  /** 用外来的 raw 文档整档替换（导入）。形状不对会抛 SchemaError，此时旧档不动。 */
  replace(raw) {
    const next = normalizeState(raw);
    this.state = next;
    this.loaded = true;
    this.save();
    return this.state;
  }

  /* ---------------------------------------------------------------- 剧本 */

  readScenario(campaignId) {
    let file;
    try {
      file = scenarioFile(this.env, campaignId);
    } catch {
      return emptyScenarioDoc();
    }
    try {
      return normalizeScenarioDoc(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return emptyScenarioDoc();
    }
  }

  writeScenario(campaignId, scenario) {
    const file = scenarioFile(this.env, campaignId);
    atomicWrite(file, `${JSON.stringify(normalizeScenarioDoc(scenario), null, 2)}\n`);
    return file;
  }

  dropScenario(campaignId) {
    let file;
    try {
      file = scenarioFile(this.env, campaignId);
    } catch {
      return false;
    }
    if (!existsSync(file)) return false;
    try {
      rmSync(file, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}

export function createStore(options) {
  return new TrpgStore(options);
}
