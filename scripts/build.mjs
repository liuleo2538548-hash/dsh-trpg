/**
 * dsh-trpg — 构建。
 *
 * 本插件**没有打包器**：客户端那一半是手写的 IIFE，宿主那一半是普通 ESM，
 * 都直接拷进 dist/ 就能跑。所以「构建」在这里只剩两件事：
 *   1. 逐文件做一次真正的语法检查（`node --check`，尊重 package.json 的 type:module）；
 *   2. 把要发布的东西复制到 dist/，并写一份 build-manifest.json 供审计。
 *
 * 这里刻意不引入 esbuild / eslint / typescript —— 本机的 dsh-explore 就因为
 * node_modules 顶层链接丢失而跑不动 verify。插件保持零依赖，才能离线自证。
 */

import { spawnSync } from "node:child_process";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const NODE = process.execPath;

/** 收集插件自己的源码（跳过 node_modules 与 dist），顺序确定，便于 diff。 */
export function listSources() {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(full);
      } else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) {
        out.push(full);
      }
    }
  };
  for (const dir of ["lib", "client", "scripts", "test"]) walk(join(ROOT, dir));
  return out;
}

/**
 * 逐文件语法检查。返回失败清单（file 为相对路径，output 为 node 的原始报错）。
 *
 * 注意 stdio：本机沙箱里 `spawnSync(..., { encoding:"utf8" })`（默认走管道）会直接
 * 返回 `EPERM`，于是**每个**文件都被误报成语法错误。子进程输出改为重定向到临时文件，
 * 既不经过管道，也仍然能拿到原始报错文本。
 */
export function checkSyntax(files = listSources()) {
  const failed = [];
  const logFile = join(ROOT, ".syntax-check.log");
  for (const file of files) {
    const fd = openSync(logFile, "w");
    let result;
    try {
      result = spawnSync(NODE, ["--check", file], { stdio: ["ignore", fd, fd] });
    } finally {
      closeSync(fd);
    }
    if (result.status !== 0) {
      let output = "";
      try {
        output = readFileSync(logFile, "utf8").trim();
      } catch {
        output = "";
      }
      if (!output && result.error) output = result.error.message;
      failed.push({ file: relative(ROOT, file), output });
    }
  }
  rmSync(logFile, { force: true });
  return failed;
}

/**
 * 客户端是 IIFE，不能 import，所以共享的 id 只能靠「客户端里写的 id 必须等于包名」来保证。
 */
export function verifyClientIdentity() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const clientFile = join(ROOT, "client", "client.js");
  if (!existsSync(clientFile)) throw new Error("client/client.js 缺失");
  const code = readFileSync(clientFile, "utf8");
  const match = code.match(/id:\s*"([^"]+)"/);
  if (!match) throw new Error('client/client.js 里找不到 `id: "…"`');
  if (match[1] !== pkg.name) {
    throw new Error(`客户端 id "${match[1]}" 与包名 "${pkg.name}" 不一致；IIFE 无法 import，二者必须相等`);
  }
  if (/^\s*import\s/m.test(code)) throw new Error("client/client.js 出现了顶层 import —— 浏览器半是 IIFE，不能 import");
  if (!/__ModuleLoader__\s*\.\s*load/.test(code)) throw new Error("client/client.js 没有走 window.__ModuleLoader__.load");
  return pkg;
}

export function build() {
  const files = listSources();
  const failed = checkSyntax(files);
  if (failed.length) {
    for (const item of failed) console.error(`✗ 语法错误 ${item.file}\n${item.output}`);
    throw new Error(`${failed.length} 个文件语法不通过`);
  }

  const pkg = verifyClientIdentity();

  if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  for (const entry of ["lib", "client", "docs", "cordis.patch.yml", "package.json", "README.md", "CONTRACT.md", "LICENSE"]) {
    const from = join(ROOT, entry);
    if (existsSync(from)) cpSync(from, join(DIST, entry), { recursive: true });
  }

  const manifest = {
    name: pkg.name,
    version: pkg.version,
    builtAt: new Date().toISOString(),
    files: files.map((file) => relative(ROOT, file)).sort(),
    clientIdentity: pkg.name,
  };
  writeFileSync(join(DIST, "build-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = build();
    console.log(`✓ 语法检查 ${manifest.files.length} 个文件通过，dist/ 已生成`);
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
  }
}
