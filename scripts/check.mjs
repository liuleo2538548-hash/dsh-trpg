/**
 * dsh-trpg — 静态契约检查。
 *
 * 这里检查的都是**不会在启动期报错、只会在运行时炸**的东西（AGENTS.md 记过的那几个坑）：
 *   · 路由漏写 requestBody → handler 根本不跑，前端只看到空响应；
 *   · 客户端 IIFE 里 import → 加载即崩；
 *   · 客户端 fetch 的路径宿主没注册 → 404；
 *   · 客户端 id 与包名不一致 → slot 注册对不上。
 *
 * 零依赖，只用 node: 内置模块。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}
function note(message) {
  notes.push(message);
}

function read(relPath) {
  const full = join(ROOT, relPath);
  if (!existsSync(full)) {
    fail(`缺少文件 ${relPath}`);
    return "";
  }
  return readFileSync(full, "utf8");
}

/* --------------------------------------------------------------- 1. 清单 */

const pkgText = read("package.json");
let pkg = {};
try {
  pkg = JSON.parse(pkgText);
} catch (error) {
  fail(`package.json 不是合法 JSON：${error.message}`);
}

if (pkg.type !== "module") fail('package.json 的 "type" 必须是 "module"');
if (pkg.main !== "./lib/index.js") fail('package.json 的 "main" 必须是 "./lib/index.js"');
for (const key of [".", "./client", "./cordis.patch.yml", "./package.json"]) {
  if (!pkg.exports || !pkg.exports[key]) fail(`package.json 的 exports 缺少 "${key}"`);
}
if (!pkg.dsh) fail('package.json 缺少 "dsh" 段');
else {
  if (pkg.dsh.bundle?.patch !== "./cordis.patch.yml") fail('dsh.bundle.patch 必须是 "./cordis.patch.yml"');
  if (pkg.dsh.client?.platform !== "web") fail('dsh.client.platform 必须是 "web"');
  if (pkg.dsh.manifestVersion !== 1) fail("dsh.manifestVersion 必须是 1");
}
if (pkg.dependencies && Object.keys(pkg.dependencies).length) fail("本插件不允许有运行时依赖");
if (pkg.devDependencies && Object.keys(pkg.devDependencies).length) fail("本插件不允许有开发依赖（要保持离线自证）");

/* --------------------------------------------------------- 2. bundle patch */

const patch = read("cordis.patch.yml");
if (patch) {
  if (!/^-\s*insert:/m.test(patch)) fail("cordis.patch.yml 缺少 `- insert:`");
  if (!/name:\s*'dsh-trpg'/.test(patch)) fail("cordis.patch.yml 里的 name 必须是 'dsh-trpg'");
  if (!/id:\s*dsh-trpg/.test(patch)) fail("cordis.patch.yml 里的 id 必须是 dsh-trpg");
}

/* ---------------------------------------------------------- 3. 浏览器半 */

const client = read("client/client.js");
if (client) {
  const idMatch = client.match(/id:\s*"([^"]+)"/);
  if (!idMatch) fail('client/client.js 缺少 `id: "…"`');
  else if (idMatch[1] !== pkg.name) fail(`客户端 id "${idMatch[1]}" != 包名 "${pkg.name}"`);
  if (/^\s*import\s/m.test(client)) fail("client/client.js 出现顶层 import（IIFE 不能 import）");
  if (!/__ModuleLoader__\s*\.\s*load/.test(client)) fail("client/client.js 没有走 window.__ModuleLoader__.load");
  if (/host\s*\.\s*call/.test(client)) fail("client/client.js 用了 host.call —— 已安装 bundle 的 factory 拿不到它");
  if (!/sidebar\.panellist/.test(client)) fail("client/client.js 没有注册 sidebar.panellist");
  if (!/getDerivedStateFromError/.test(client)) fail("client/client.js 缺少 error boundary（main 是 shadows-shipped-ui 的 keyed slot）");
  if (!/selectPanel\s*\(\s*null\s*\)/.test(client)) fail("client/client.js 缺少「← 返回会话」（应调用 layout.selectPanel(null)）");
  if (/--dsw-alias-brand-primary[^;]*background/.test(client)) {
    note("client/client.js 可能把 brand-primary（ink token）当背景用了 —— 深色主题下会不可见，填充请用 --dsw-alias-button-primary-fill");
  }
}

/* ------------------------------------------------------------- 4. 路由表 */

const host = read("lib/index.js");
let routePaths = [];
if (host) {
  const routesBlock = host.match(/export const ROUTES = \{([\s\S]*?)\};/);
  if (!routesBlock) fail("lib/index.js 里找不到 ROUTES 表");
  else {
    routePaths = [...routesBlock[1].matchAll(/:\s*"([^"]+)"/g)].map((match) => match[1]);
    if (!routePaths.length) fail("ROUTES 表里没有任何路径");
    for (const path of routePaths) {
      if (!path.startsWith("/api/")) fail(`路由 ${path} 不在 /api 之下（connection 服务会断言失败）`);
    }
  }
  // 统一在 mount 里注入 requestBody —— 这是三条硬约束里最容易漏的一条。
  if (!/register\(\{\s*requestBody:\s*"buffered"\s*,\s*\.\.\.route\s*\}\)/.test(host)) {
    fail('lib/index.js 的 mount 没有统一写 `register({ requestBody: "buffered", ...route })`');
  }
  if (/methods:\s*\[/.test(host) === false) fail("路由缺少 methods 声明");
}

if (client && routePaths.length) {
  const used = [...client.matchAll(/["'`](\/api\/[A-Za-z0-9_\-/]*)["'`]/g)].map((match) => match[1]);
  for (const path of new Set(used)) {
    if (!routePaths.includes(path)) fail(`client/client.js 请求了宿主没注册的路径：${path}`);
  }
  for (const path of routePaths) {
    if (!used.includes(path)) note(`路由 ${path} 没有被客户端使用`);
  }
}

/* ------------------------------------------------------- 5. 模块可导入性 */

const libDir = join(ROOT, "lib");
if (existsSync(libDir)) {
  for (const entry of readdirSync(libDir).sort()) {
    if (!entry.endsWith(".js")) continue;
    const rel = relative(ROOT, join(libDir, entry));
    try {
      await import(new URL(`../lib/${entry}`, import.meta.url).href);
    } catch (error) {
      fail(`导入 ${rel} 失败：${String(error?.message ?? error)}`);
    }
  }
} else {
  fail("缺少 lib/ 目录");
}

/* ------------------------------------------------------------- 6. 测试面 */

if (!existsSync(join(ROOT, "test"))) fail("缺少 test/ 目录");
else {
  const tests = readdirSync(join(ROOT, "test")).filter((name) => name.endsWith(".test.js"));
  if (tests.length < 9) fail(`测试文件太少（${tests.length} 个），9 个模块都要有测试`);
}

/* ---------------------------------------------------------------- 汇总 */

if (problems.length) {
  console.error("✗ 静态契约检查失败：");
  for (const problem of problems) console.error(`  · ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`✓ 静态契约检查通过（${routePaths.length} 条路由，清单/patch/客户端/路由/模块可导入）`);
}
for (const item of notes) console.log(`  ⚠ ${item}`);
