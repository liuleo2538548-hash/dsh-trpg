/**
 * dsh-trpg — 装进活动 profile。
 *
 * 做三件事（幂等，可重复跑）：
 *   1. 在 profile 的 package.json 里加一条 link: 依赖；
 *   2. 在该 profile 的 dsh.profile.bundles 里追加 "dsh-trpg"；
 *   3. 在 profile 的 node_modules/ 下建一个指向本包的 junction。
 *
 * 第 3 步不能省：bundle 名是按包名从 profile 目录解析的，只写清单解析不到。
 *
 * `--dry-run` 只算不写（verify.mjs 用它做安装自检）；`--uninstall` 反向操作。
 *
 * 注意：这里全部用**文本级编辑**（正则 + 括号配对）而不是 JSON.parse/stringify，
 * 因为 profile 的 package.json 是人手维护的，重新序列化会把格式和注释彻底改写。
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = "dsh-trpg";
const DEPENDENCY_SPEC = `link:${PACKAGE_ROOT.replaceAll("\\", "/")}`;

/* ------------------------------------------------------------ 纯文本编辑 */

/**
 * 找到 `"key": [` 之后的数组体区间（用括号配对，能跳过字符串里的括号）。
 *
 * 注意传给 matchBracket 的是**开括号本身**的位置：depth 从 0 起步，开括号先把它顶到 1，
 * 配对的闭括号再降回 0 才算命中。若从开括号之后起步，depth 会先变成 -1，函数就会一路
 * 扫到文件末尾那个括号才归零 —— 结果是拿到错误的区间（或 null）。
 */
export function findArrayBody(text, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(text);
  if (!match) return null;
  const open = match.index + match[0].length - 1;
  const end = matchBracket(text, open, "[", "]");
  if (end === -1) return null;
  return { start: open + 1, end, keyIndent: indentOfLine(text, match.index) };
}

/** 找到 `"key": {` 之后的对象体区间。 */
export function findObjectBody(text, key) {
  const match = new RegExp(`"${key}"\\s*:\\s*\\{`).exec(text);
  if (!match) return null;
  const open = match.index + match[0].length - 1;
  const end = matchBracket(text, open, "{", "}");
  if (end === -1) return null;
  return { start: open + 1, end, keyIndent: indentOfLine(text, match.index) };
}

function matchBracket(text, from, open, close) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function indentOfLine(text, index) {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const prefix = text.slice(lineStart, index);
  const match = prefix.match(/^[ \t]*/);
  return match ? match[0] : "";
}

function elementIndent(inner, keyIndent) {
  const match = inner.match(/\n([ \t]+)\S/);
  return match ? match[1] : `${keyIndent}  `;
}

/** 往数组里追加一个字符串元素；已存在则原样返回并标记 changed:false。 */
export function appendToArray(text, key, entry) {
  const body = findArrayBody(text, key);
  if (!body) throw new Error(`package.json 里找不到数组 "${key}"`);
  const inner = text.slice(body.start, body.end);
  if (new RegExp(`"${escapeRegExp(entry)}"`).test(inner)) return { text, changed: false };
  const indent = elementIndent(inner, body.keyIndent);
  const trailing = inner.match(/\s*$/)[0];
  const trimmed = inner.slice(0, inner.length - trailing.length);
  const nextInner = trimmed.trim() === ""
    ? `\n${indent}"${entry}"\n${body.keyIndent}`
    : `${trimmed},\n${indent}"${entry}"${trailing || `\n${body.keyIndent}`}`;
  return { text: text.slice(0, body.start) + nextInner + text.slice(body.end), changed: true };
}

/** 从数组里移除一个字符串元素。 */
export function removeFromArray(text, key, entry) {
  const body = findArrayBody(text, key);
  if (!body) return { text, changed: false };
  const inner = text.slice(body.start, body.end);
  // 尾部只吃行内空白：`\s` 会把闭括号前的换行与缩进一起吞掉，卸载后文本就回不到原样。
  const pattern = new RegExp(`\\n[ \\t]*"${escapeRegExp(entry)}"[ \\t]*,?`);
  if (!pattern.test(inner)) return { text, changed: false };
  const nextInner = inner.replace(pattern, "").replace(/,(\s*)$/, "$1");
  return { text: text.slice(0, body.start) + nextInner + text.slice(body.end), changed: true };
}

/** 设置 dependencies 里的一条依赖（已有则只替换版本说明）。 */
export function setDependency(text, name, spec) {
  const body = findObjectBody(text, "dependencies");
  if (!body) throw new Error('package.json 里找不到 "dependencies"');
  const inner = text.slice(body.start, body.end);
  const existing = new RegExp(`("${escapeRegExp(name)}"\\s*:\\s*)"[^"]*"`);
  if (existing.test(inner)) {
    return { text: text.slice(0, body.start) + inner.replace(existing, `$1"${spec}"`) + text.slice(body.end), changed: true };
  }
  const indent = elementIndent(inner, body.keyIndent);
  const trailing = inner.match(/\s*$/)[0];
  const trimmed = inner.slice(0, inner.length - trailing.length);
  const nextInner = trimmed.trim() === ""
    ? `\n${indent}"${name}": "${spec}"\n${body.keyIndent}`
    : `${trimmed},\n${indent}"${name}": "${spec}"${trailing || `\n${body.keyIndent}`}`;
  return { text: text.slice(0, body.start) + nextInner + text.slice(body.end), changed: true };
}

export function removeDependency(text, name) {
  const body = findObjectBody(text, "dependencies");
  if (!body) return { text, changed: false };
  const inner = text.slice(body.start, body.end);
  // 同 removeFromArray：尾部只吃行内空白，留住闭括号前的换行与缩进。
  const pattern = new RegExp(`\\n[ \\t]*"${escapeRegExp(name)}"[ \\t]*:[ \\t]*"[^"]*"[ \\t]*,?`);
  if (!pattern.test(inner)) return { text, changed: false };
  const nextInner = inner.replace(pattern, "").replace(/,(\s*)$/, "$1");
  return { text: text.slice(0, body.start) + nextInner + text.slice(body.end), changed: true };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ------------------------------------------------------------ profile 定位 */

export function findProfile(env = process.env, argv = process.argv.slice(2)) {
  const flagIndex = argv.indexOf("--profile");
  if (flagIndex !== -1 && argv[flagIndex + 1]) return resolve(argv[flagIndex + 1]);
  if (env.DSH_PROFILE_DIR) return resolve(env.DSH_PROFILE_DIR);
  const home = env.DSH_HOME || join(homedir(), ".dsh");
  const name = env.DSH_PROFILE || "desktop";
  return join(home, "profiles", name);
}

/* -------------------------------------------------------------------- 主流程 */

function linkPathFor(profileDir) {
  return join(profileDir, "node_modules", BUNDLE);
}

function isJunction(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return true;
    // Windows junction 在 lstat 下不算 symlink，普通 realpathSync 也只回敬自身路径，
    // 只有 realpathSync.native 才给出真实 target。
    if (!stat.isDirectory()) return false;
    const real = realpathNative(path);
    return real !== null && resolve(real) !== resolve(path);
  } catch {
    return false;
  }
}

function realpathNative(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/**
 * 摘掉一个链接。junction 在 Windows 上表现为目录，`rmSync(p, { recursive:false })` 会报
 * `ERR_FS_EISDIR`，而 `recursive:true` 会跟着 reparse point **删掉 target 里的文件**。
 * 所以目录一律用 `rmdirSync`（只摘链接本身，不伤 target），符号链接才用 `unlinkSync`。
 */
function removeLink(path) {
  const stat = lstatSync(path);
  if (stat.isDirectory() && !stat.isSymbolicLink()) rmdirSync(path);
  else unlinkSync(path);
}

export function install({ profileDir, dryRun = false } = {}) {
  const manifestPath = join(profileDir, "package.json");
  if (!existsSync(manifestPath)) throw new Error(`找不到 profile 清单：${manifestPath}`);

  const before = readFileSync(manifestPath, "utf8");
  const parsedBefore = JSON.parse(before); // 写前自检：原文件必须是合法 JSON

  let text = before;
  text = setDependency(text, BUNDLE, DEPENDENCY_SPEC).text;
  const bundles = appendToArray(text, "bundles", BUNDLE);
  text = bundles.text;

  const parsedAfter = JSON.parse(text); // 写前自检：改完也必须是合法 JSON
  const bundlesAfter = parsedAfter?.dsh?.profile?.bundles ?? [];
  if (!bundlesAfter.includes(BUNDLE)) throw new Error("追加 bundle 后校验失败：bundles 里没有 dsh-trpg");
  if (parsedAfter?.dependencies?.[BUNDLE] !== DEPENDENCY_SPEC) {
    throw new Error("追加依赖后校验失败：dependencies 里的版本说明不对");
  }
  if (!bundlesAfter.includes("dsh-explore") || !parsedBefore.dependencies) {
    // 只是确认我们没有把别人的条目写丢。
    throw new Error("改写后校验失败：原有的其它 bundle 条目丢失了");
  }

  const linkPath = linkPathFor(profileDir);
  const linkAlreadyOk = existsSync(linkPath) && isJunction(linkPath);
  const changes = [];
  if (text !== before) changes.push("package.json");
  if (!linkAlreadyOk) changes.push(`node_modules/${BUNDLE} junction`);

  if (dryRun) return { dryRun: true, manifestPath, linkPath, changes, text };

  if (text !== before) {
    const backup = `${manifestPath}.pre-${BUNDLE}.bak`;
    if (!existsSync(backup)) writeFileSync(backup, before, "utf8");
    writeFileSync(manifestPath, text, "utf8");
  }

  if (!linkAlreadyOk) {
    mkdirSync(join(profileDir, "node_modules"), { recursive: true });
    if (existsSync(linkPath)) removeLink(linkPath);
    symlinkSync(PACKAGE_ROOT, linkPath, "junction");
  }

  return { dryRun: false, manifestPath, linkPath, changes };
}

export function uninstall({ profileDir, dryRun = false } = {}) {
  const manifestPath = join(profileDir, "package.json");
  if (!existsSync(manifestPath)) throw new Error(`找不到 profile 清单：${manifestPath}`);
  const before = readFileSync(manifestPath, "utf8");
  let text = removeDependency(before, BUNDLE).text;
  text = removeFromArray(text, "bundles", BUNDLE).text;
  JSON.parse(text);

  const linkPath = linkPathFor(profileDir);
  if (dryRun) return { dryRun: true, manifestPath, linkPath, changes: text !== before ? ["package.json", "junction"] : [] };

  if (text !== before) {
    const backup = `${manifestPath}.pre-${BUNDLE}.bak`;
    if (!existsSync(backup)) writeFileSync(backup, before, "utf8");
    writeFileSync(manifestPath, text, "utf8");
  }
  if (existsSync(linkPath)) removeLink(linkPath);
  return { dryRun: false, manifestPath, linkPath, changes: ["package.json", "junction"] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const uninstallMode = argv.includes("--uninstall");
  try {
    const profileDir = findProfile(process.env, argv);
    const result = uninstallMode ? uninstall({ profileDir, dryRun }) : install({ profileDir, dryRun });
    const prefix = result.dryRun ? "（dry-run，未写盘）" : "";
    if (!result.changes.length) console.log(`✓ ${BUNDLE} 已经装好了，无需改动 ${prefix}`);
    else console.log(`✓ ${BUNDLE} ${uninstallMode ? "已卸载" : "已安装"}：改动 ${result.changes.join("、")} ${prefix}`);
    console.log(`  profile: ${result.manifestPath}`);
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  }
}
