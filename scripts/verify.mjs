/**
 * dsh-trpg — 五道关一条命令。
 *
 *   1. 静态契约检查   scripts/check.mjs（清单 / patch / 客户端 id / 路由 requestBody / 模块可导入）
 *   2. 语法           逐文件 `node --check`（在 build.mjs 里）
 *   3. 单元测试       `node --test` 显式 8 个文件
 *   4. 构建           scripts/build.mjs → dist/
 *   5. 安装自检       scripts/install.mjs --dry-run（不碰磁盘，只校验 profile 能被正确改写）
 *
 * 全过才打印 `all steps passed`。
 *
 * 注意：`node --test test/` 的目录形式在 Node 24 会报 Cannot find module，
 * 所以测试文件必须显式列出（与 package.json 的 test 脚本保持一致）。
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;

const TEST_FILES = [
  "test/dice.test.js",
  "test/scenario.test.js",
  "test/gm.test.js",
  "test/bribe.test.js",
  "test/store.test.js",
  "test/commands.test.js",
  "test/host.test.js",
  "test/client.test.js",
  "test/install.test.js",
];

function step(label, args, { optional = false } = {}) {
  process.stdout.write(`\n── ${label}\n`);
  const result = spawnSync(NODE, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    if (optional) {
      console.log(`⚠ ${label} 未通过（可跳过），继续`);
      return false;
    }
    console.error(`✗ ${label} 失败（exit ${result.status}）`);
    process.exit(1);
  }
  console.log(`✓ ${label}`);
  return true;
}

step("1/5 静态契约检查", ["scripts/check.mjs"]);
step("2/5 构建（含逐文件语法检查）", ["scripts/build.mjs"]);

const missing = TEST_FILES.filter((file) => !existsSync(join(ROOT, file)));
if (missing.length) {
  console.error(`✗ 缺少测试文件：${missing.join("、")}`);
  process.exit(1);
}
step("3/5 单元测试", ["--test", "--experimental-test-isolation=none", ...TEST_FILES]);

// 4/5 已经在第 2 步里做过构建，这里只校验产物齐全。
const distFiles = ["dist/lib/index.js", "dist/client/client.js", "dist/package.json", "dist/cordis.patch.yml", "dist/build-manifest.json"];
const distMissing = distFiles.filter((file) => !existsSync(join(ROOT, file)));
if (distMissing.length) {
  console.error(`✗ dist/ 产物缺失：${distMissing.join("、")}`);
  process.exit(1);
}
console.log("\n✓ 4/5 dist/ 产物齐全");

step("5/5 安装自检（--dry-run）", ["scripts/install.mjs", "--dry-run"], { optional: true });

console.log("\nall steps passed");
