/**
 * dsh-trpg — 剧本解析与检索（纯文本 → 结构化节）。
 *
 * 定位：宿主（lib/index.js）把整篇剧本交给 `parseScenario` 解析一次，之后模型只看
 * `scenarioDigest` 生成的目录；需要细节时用 `searchSections` / `readSection` 按需取。
 * 本模块**不碰文件系统**、不 import 任何其它模块，输入输出都是普通数据，零依赖。
 *
 * 关键约定（对齐 CONTRACT.md 第 2 节）：
 *   - `id` 是「节在原文里出现的顺序号」（s1、s2…），解析一次即固定；检索/读节只认它。
 *   - 三种标题：Markdown ATX、中文章节（第 N 章/节/幕/回/部/篇）、`【…】` 独占一行；
 *     下划线分隔行（`===` / `-----`）**不是**标题。
 *   - 出错一律抛 `ScenarioError`（带 `code`），不抛裸 `Error`。
 */

export class ScenarioError extends Error {
  /**
   * @param {string} code SOURCE_TOO_LARGE / BAD_SOURCE
   * @param {string} message 中文说明
   */
  constructor(code, message) {
    super(message);
    this.name = "ScenarioError";
    this.code = code;
  }
}

/** 原文上限（UTF-16 长度）。超限直接拒收：整篇原文会进每一次请求，不能失控。 */
export const MAX_SOURCE_CHARS = 400000;

/** 节数上限。超出的节丢弃，并追加一节「（剧本过长，已截断）」占位。 */
export const MAX_SECTIONS = 400;

/* ---------------------------------------------------------------- 常量 */

/** 前言节（第一个标题之前的实质文字）的固定标题。 */
const PREAMBLE_HEADING = "（前言）";
/** 超过 MAX_SECTIONS 时追加的占位节标题。 */
const TRUNCATED_HEADING = "（剧本过长，已截断）";
/** 标题与正文都拿不到名字时的剧本名。 */
const UNTITLED_TITLE = "未命名剧本";

const DIGEST_MAX_CHARS = 1600;
const DIGEST_PER_SECTION_CHARS = 90;

const SEARCH_LIMIT = 5;
const SEARCH_CONTEXT = 60;
/** 标题命中的权重：一次标题命中抵 3 次正文命中。 */
const HEADING_WEIGHT = 3;
/**
 * 同一节内的命中次数上限：既允许累加，又保证超长正文刷不了分。
 * 正文上限取 2，于是「任意标题命中（≥3）」恒高于「纯正文命中（≤2）」。
 */
const MAX_HEADING_HITS = 3;
const MAX_BODY_HITS = 2;
/** 单行片段两侧的省略号，各占 1 个字符。 */
const SNIPPET_ELLIPSIS = "…";
/** 单次调用里最多统计多少个命中位置（性能保护，计分用不到这么多）。 */
const MAX_SCAN_HITS = 64;

/* -------------------------------------------------------------- 行匹配 */

/** Markdown ATX 标题：`#`..`######`，`#` 后必须紧跟一个非空白字符（可隔空格）。 */
const ATX_RE = /^(#{1,6})\s*(\S.*)$/;
/** 中文章节：第 N 章/节/幕/回/部/篇；`第` 前的缩进与列表符号由 stripListPrefix 先剥掉。 */
const CHAPTER_RE = /^第\s*[0-9一二三四五六七八九十百零〇]+\s*[章节幕回部篇]\s*(.*)$/;
/** 方括号独占一行。 */
const BRACKET_RE = /^【(.+)】\s*$/;
/** 全等号/全短横线的下划线分隔行：明确忽略，绝不当标题。 */
const UNDERLINE_RE = /^(?:=+|-{3,})$/;
/** 行首编号：`1.`、`1、`、`1)`、`（1）`、`一、` 等。 */
const ORDERED_PREFIX_RE = /^(?:[（(]?\s*[0-9０-９]+\s*[）).、,:：]|[一二三四五六七八九十百零〇]+\s*[、.)）])\s*/u;
/** 行首列表符号与缩进（可叠加，如「  - 1. 第一章」）。 */
const LIST_PREFIX_RE = /^(?:[ \t\u3000]+|[*+-][ \t\u3000]+|\d+[.、)][ \t\u3000]*)/u;

/* ---------------------------------------------------------------- 工具 */

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 钳到 [min,max] 整数。
 * 只接受真正的数字或非空数字字符串：`Number(null) === 0`、`Number("") === 0`
 * 会把「缺参数」静默钉到最小值而不是回落默认值（dsh-explore 记过的坑）。
 */
function clampInt(value, { min, max, fallback }) {
  let numeric = Number.NaN;
  if (typeof value === "number") numeric = value;
  else if (typeof value === "string" && value.trim() !== "") numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const rounded = Math.round(numeric);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

/** 压成单行（连续空白 → 一个空格）。 */
function oneLine(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/gu, " ").trim();
}

/** 从任意值里安全地取出节数组；形状不对时当空剧本处理，不抛错。 */
function sectionsOf(scenario) {
  if (!isPlainObject(scenario) || !Array.isArray(scenario.sections)) return [];
  return scenario.sections.filter(isPlainObject);
}

/** 剥掉行首缩进与列表符号（只用于中文章节匹配，ATX 与 `【】` 按契约不剥前缀）。 */
function stripListPrefix(line) {
  let out = line;
  for (let round = 0; round < 4; round += 1) {
    const next = out.replace(LIST_PREFIX_RE, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * 清洗标题文本：去掉行首编号与 `**` / `__` 包裹。
 * 返回空串表示「空标题」，按契约该行不算标题。
 */
function cleanHeading(text) {
  let out = typeof text === "string" ? text.trim() : "";
  if (!out) return "";
  for (let round = 0; round < 3; round += 1) {
    const before = out;
    out = out.replace(/^\*\*([\s\S]*?)\*\*$/u, "$1").trim();
    out = out.replace(/^__([\s\S]*?)__$/u, "$1").trim();
    if (out === before) break;
  }
  out = out.replace(ORDERED_PREFIX_RE, "").trim();
  // 7 个以上的 `#` 会有一部分漏进捕获组（`#{1,6}` 最多吃 6 个），这里兜底剥掉。
  out = out.replace(/^#+\s*/u, "").trim();
  return out;
}

/**
 * 按行判定标题。命中即返回 `{ level, heading }`，否则 null。
 * 顺序：下划线分隔行（显式排除）→ ATX → 中文章节 → `【】`。
 */
function matchHeadingLine(line) {
  if (UNDERLINE_RE.test(line)) return null;
  const atx = ATX_RE.exec(line);
  if (atx) {
    const heading = cleanHeading(atx[2]);
    return heading ? { level: atx[1].length, heading } : null;
  }
  const chapter = CHAPTER_RE.exec(stripListPrefix(line));
  if (chapter) {
    const heading = cleanHeading(chapter[1]);
    return heading ? { level: 2, heading } : null;
  }
  const bracket = BRACKET_RE.exec(line);
  if (bracket) {
    const heading = cleanHeading(bracket[1]);
    return heading ? { level: 2, heading } : null;
  }
  return null;
}

/** [from,to] 内最后一个非空行的下标；全空返回 -1。 */
function lastNonBlankLine(lines, from, to) {
  for (let index = to; index >= from; index -= 1) {
    if (lines[index].trim() !== "") return index;
  }
  return -1;
}

/** 行数 → 1 起始的行号（空区间回落到标题行本身）。 */
function makeSection(id, heading, level, bodyLines, startLine, endLine) {
  const body = bodyLines.join("\n").trim();
  return { id, heading, level, body, startLine, endLine, chars: body.length };
}

/* ---------------------------------------------------------------- 入口 */

/** 空剧本：与 `parseScenario` 的返回形状完全一致，供宿主做初值。 */
export function emptyScenario() {
  return { title: "", source: "", sections: [], importedAt: 0 };
}

/**
 * 把整篇原文切成节。
 * @param {string} source 剧本文本
 * @param {{ title?: string, now?: number }} [options] title 优先于原文里的第一个一级标题
 * @returns {{ title: string, source: string, sections: object[], importedAt: number }}
 * @throws {ScenarioError} BAD_SOURCE（非字符串）/ SOURCE_TOO_LARGE（超长）
 */
export function parseScenario(source, options) {
  if (typeof source !== "string") {
    throw new ScenarioError("BAD_SOURCE", "剧本原文必须是字符串");
  }
  if (source.length > MAX_SOURCE_CHARS) {
    throw new ScenarioError(
      "SOURCE_TOO_LARGE",
      `剧本原文 ${source.length} 字符，超过上限 ${MAX_SOURCE_CHARS}`,
    );
  }
  const opts = isPlainObject(options) ? options : {};
  const lines = splitLines(source);

  // 1) 先扫一遍标题行，拿到「行号 → 标题」的骨架。
  const found = [];
  for (let index = 0; index < lines.length; index += 1) {
    const hit = matchHeadingLine(lines[index]);
    if (hit) found.push({ index, level: hit.level, heading: hit.heading });
  }

  // 2) 定标题：显式 title > 第一个一级标题 > 未命名剧本。
  const explicitTitle = oneLine(opts.title);
  let title = explicitTitle;
  if (!title) {
    const firstLevelOne = found.find((entry) => entry.level === 1);
    title = firstLevelOne ? firstLevelOne.heading : "";
  }
  if (!title) title = UNTITLED_TITLE;

  // 3) 切节。id 按出现顺序递增，与标题内容无关，所以稳定。
  const sections = [];
  let nextId = 1;
  const newId = () => `s${nextId++}`;

  if (found.length === 0) {
    // 没有任何标题：整篇退化为单节（空白原文则没有节可给）。
    if (source.trim() !== "") {
      const end = lastNonBlankLine(lines, 0, lines.length - 1);
      sections.push(makeSection(newId(), title, 0, lines, 1, end < 0 ? 1 : end + 1));
    }
  } else {
    // 第一个标题之前的实质文字 → level 0 的「（前言）」节。
    const head = found[0];
    const preambleEnd = lastNonBlankLine(lines, 0, head.index - 1);
    if (preambleEnd >= 0) {
      sections.push(
        makeSection(newId(), PREAMBLE_HEADING, 0, lines.slice(0, head.index), 1, preambleEnd + 1),
      );
    }
    for (let k = 0; k < found.length; k += 1) {
      const current = found[k];
      const stop = k + 1 < found.length ? found[k + 1].index : lines.length;
      const end = lastNonBlankLine(lines, current.index + 1, stop - 1);
      sections.push(
        makeSection(
          newId(),
          current.heading,
          current.level,
          lines.slice(current.index + 1, stop),
          current.index + 1,
          end < 0 ? current.index + 1 : end + 1,
        ),
      );
    }
  }

  // 4) 节数上限：截断后补一节占位说明，让模型知道后面还有内容。
  if (sections.length > MAX_SECTIONS) {
    const firstDropped = sections[MAX_SECTIONS];
    const kept = sections.slice(0, MAX_SECTIONS);
    kept.push({
      id: `s${MAX_SECTIONS + 1}`,
      heading: TRUNCATED_HEADING,
      level: 0,
      body: "",
      startLine: firstDropped ? firstDropped.startLine : 0,
      endLine: firstDropped ? firstDropped.startLine : 0,
      chars: 0,
    });
    sections.length = 0;
    sections.push(...kept);
  }

  return {
    title,
    source,
    sections,
    importedAt:
      typeof opts.now === "number" && Number.isFinite(opts.now) ? opts.now : Date.now(),
  };
}

/** 一节 → 目录里的一行。body 为空则省略冒号与摘要。 */
function digestLine(section, perSectionChars) {
  const heading = oneLine(section.heading);
  const summary = oneLine(section.body);
  if (!summary) return `- ${section.id} ${heading}`;
  const clipped =
    summary.length > perSectionChars ? `${summary.slice(0, perSectionChars)}${SNIPPET_ELLIPSIS}` : summary;
  return `- ${section.id} ${heading}：${clipped}`;
}

/**
 * 生成给模型看的目录摘要。格式固定：
 *
 * ```
 * 【剧本】雨夜钟声（共 12 节）
 * - s1 第一幕 雨夜：<body 压成单行后取前 90 字>…
 * （目录已截断，共 12 节，请用检索获取后续内容）
 * ```
 *
 * 截断用的括号行**计入** maxChars：追加每一节前先为它留位，所以最终长度基本不超预算；
 * 但 `maxChars` 再小也保证至少输出「标题行 + 首节」。
 *
 * @param {object} scenario parseScenario 的产物
 * @param {{ maxChars?: number, perSectionChars?: number }} [options]
 * @returns {string}
 */
export function scenarioDigest(scenario, options) {
  const opts = isPlainObject(options) ? options : {};
  const maxChars = clampInt(opts.maxChars, { min: 0, max: 1000000, fallback: DIGEST_MAX_CHARS });
  const perSectionChars = clampInt(opts.perSectionChars, {
    min: 1,
    max: 10000,
    fallback: DIGEST_PER_SECTION_CHARS,
  });
  const title = oneLine(isPlainObject(scenario) ? scenario.title : "") || UNTITLED_TITLE;
  const sections = sectionsOf(scenario);

  const header = `【剧本】${title}（共 ${sections.length} 节）`;
  if (sections.length === 0) return header;

  const lines = sections.map((section) => digestLine(section, perSectionChars));
  const tail = `（目录已截断，共 ${sections.length} 节，请用检索获取后续内容）`;
  const reserve = 1 + tail.length; // 换行 + 括号行

  let out = header;
  let used = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = `${out}\n${lines[index]}`;
    // 首节无条件收入：maxChars 极小时也要有「标题行 + 首节」。
    if (index > 0 && candidate.length + reserve > maxChars) break;
    out = candidate;
    used = index + 1;
  }
  if (used < lines.length) out = `${out}\n${tail}`;
  return out;
}

/** 在一个已小写化的串里找出全部命中位置（不重叠）。 */
function matchPositions(haystack, needle) {
  const positions = [];
  if (!needle) return positions;
  let from = 0;
  while (positions.length < MAX_SCAN_HITS) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    positions.push(at);
    from = at + needle.length;
  }
  return positions;
}

/**
 * 以命中位置为中心截一段单行片段。
 * 两侧固定加省略号，且（context ≥ 2 时）总长 ≤ 2*context。
 */
function makeSnippet(body, index, needleLength, context) {
  const width = Math.max(2, context * 2);
  const core = Math.max(1, width - 2 * SNIPPET_ELLIPSIS.length);
  if (index < 0) {
    // 只有标题命中：给正文开头一段，仍然保持单行 + 两侧省略号。
    return `${SNIPPET_ELLIPSIS}${body.slice(0, core).replace(/\s+/gu, " ")}${SNIPPET_ELLIPSIS}`;
  }
  let start = index - Math.floor((core - needleLength) / 2);
  if (start < 0) start = 0;
  let end = start + core;
  if (end > body.length) {
    end = body.length;
    start = Math.max(0, end - core);
  }
  return `${SNIPPET_ELLIPSIS}${body.slice(start, end).replace(/\s+/gu, " ")}${SNIPPET_ELLIPSIS}`;
}

/**
 * 大小写不敏感的子串检索。
 * 计分：标题命中 ×3（最多计 3 次），正文命中每次 1 分（最多计 2 次）——
 * 累加但有上限，超长正文刷不了分，且任意标题命中都高于纯正文命中。
 *
 * @param {object} scenario
 * @param {string} query 空串/空白/非字符串 → `{ total: 0, hits: [] }`
 * @param {{ limit?: number, context?: number }} [options]
 * @returns {{ total: number, hits: Array<{id:string,heading:string,level:number,score:number,snippet:string,index:number}> }}
 */
export function searchSections(scenario, query, options) {
  if (typeof query !== "string") return { total: 0, hits: [] };
  const needle = query.trim().toLowerCase();
  if (!needle) return { total: 0, hits: [] };

  const opts = isPlainObject(options) ? options : {};
  const limit = clampInt(opts.limit, { min: 0, max: 1000, fallback: SEARCH_LIMIT });
  const context = clampInt(opts.context, { min: 2, max: 5000, fallback: SEARCH_CONTEXT });

  const scored = [];
  const sections = sectionsOf(scenario);
  for (let order = 0; order < sections.length; order += 1) {
    const section = sections[order];
    const heading = typeof section.heading === "string" ? section.heading : "";
    const body = typeof section.body === "string" ? section.body : "";
    const headingHits = matchPositions(heading.toLowerCase(), needle).length;
    const bodyPositions = matchPositions(body.toLowerCase(), needle);
    const score =
      Math.min(headingHits, MAX_HEADING_HITS) * HEADING_WEIGHT +
      Math.min(bodyPositions.length, MAX_BODY_HITS);
    if (score <= 0) continue;
    const index = bodyPositions.length > 0 ? bodyPositions[0] : -1;
    scored.push({
      order,
      hit: {
        id: section.id,
        heading,
        level: section.level,
        score,
        snippet: makeSnippet(body, index, needle.length, context),
        index,
      },
    });
  }

  // score 降序；同分按节顺序（用显式 order 而不是依赖 sort 的稳定性）。
  scored.sort((a, b) => b.hit.score - a.hit.score || a.order - b.order);
  const hits = scored.map((entry) => entry.hit);
  return { total: hits.length, hits: hits.slice(0, limit) };
}

/**
 * 按 id 读一节。
 * @param {object} scenario
 * @param {string} id 如 "s3"
 * @returns {{ id: string, heading: string, level: number, body: string } | null}
 */
export function readSection(scenario, id) {
  if (typeof id !== "string") return null;
  const found = sectionsOf(scenario).find((section) => section.id === id);
  if (!found) return null;
  return {
    id: found.id,
    heading: typeof found.heading === "string" ? found.heading : "",
    level: typeof found.level === "number" ? found.level : 0,
    body: typeof found.body === "string" ? found.body : "",
  };
}

/**
 * 目录索引（不含正文，供 UI 列表用）。
 * @returns {Array<{ id: string, heading: string, level: number, chars: number }>}
 */
export function sectionIndex(scenario) {
  return sectionsOf(scenario).map((section) => ({
    id: section.id,
    heading: typeof section.heading === "string" ? section.heading : "",
    level: typeof section.level === "number" ? section.level : 0,
    chars:
      typeof section.chars === "number"
        ? section.chars
        : typeof section.body === "string"
          ? section.body.length
          : 0,
  }));
}

/**
 * 按行切开原文：`\r\n` 与 `\r` 都归一成 `\n`。
 * 导出给测试用；行号（startLine / endLine）就是这里的下标 +1。
 * @param {string} source
 * @returns {string[]} 非字符串一律返回空数组
 */
export function splitLines(source) {
  if (typeof source !== "string") return [];
  return source.replace(/\r\n?/gu, "\n").split("\n");
}
