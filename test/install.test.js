/**
 * dsh-trpg — 安装脚本的文本改写测试。
 *
 * profile 的 package.json 是人手维护的，所以 install.mjs 全程做**文本级**编辑（正则 + 括号
 * 配对），不 JSON.parse/stringify 重写。这类代码最容易错在括号配对与缩进上，而错了以后
 * 症状是「装不上」或「把别人条目写丢」，所以这里用真实形状的清单逐项验证。
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  appendToArray,
  findArrayBody,
  findObjectBody,
  findProfile,
  install,
  removeDependency,
  removeFromArray,
  setDependency,
  uninstall,
} from "../scripts/install.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 与真实 desktop profile 同构（含 link: 依赖、多个 bundle、8 空格缩进）。 */
const MANIFEST = `{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "dsh-explore": "link:C:/somewhere/dsh-explore",
    "dsh-context": "0.69.1",
    "dshmarket": "^1.66.15"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-explore",
        "dsh-context"
      ]
    }
  }
}
`;

let counter = 0;
function freshProfile() {
  counter += 1;
  const dir = join(ROOT, "test", `.tmp-install-${counter}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "package.json"), MANIFEST, "utf8");
  return dir;
}

test("findObjectBody / findArrayBody 命中正确的区间", () => {
  const deps = findObjectBody(MANIFEST, "dependencies");
  assert.ok(deps);
  // 区间内应当只有依赖项，且第一个键就是 dsh-explore。
  const inner = MANIFEST.slice(deps.start, deps.end);
  assert.match(inner, /"dsh-explore"/);
  assert.equal(inner.includes("bundles"), false, "dependencies 的区间越界吃到了 bundles");

  const bundles = findArrayBody(MANIFEST, "bundles");
  assert.ok(bundles);
  const list = MANIFEST.slice(bundles.start, bundles.end);
  assert.match(list, /"@deepseek-ai\/dsh-base"/);
  // 关键：区间必须在 ] 之前收住，不能一路跑到文件末尾的 }。
  assert.equal(MANIFEST[bundles.end], "]");
});

test("findArrayBody / findObjectBody 遇到不存在的键返回 null", () => {
  assert.equal(findArrayBody(MANIFEST, "nope"), null);
  assert.equal(findObjectBody(MANIFEST, "nope"), null);
});

test("括号配对跳过字符串里的括号", () => {
  const text = '{\n  "dependencies": {\n    "weird": "a{b]c",\n    "x": "1"\n  },\n  "y": 2\n}\n';
  const body = findObjectBody(text, "dependencies");
  assert.ok(body);
  assert.equal(text.slice(body.start, body.end).trim(), '"weird": "a{b]c",\n    "x": "1"');
});

test("setDependency 新增一条，且不碰别人的行", () => {
  const next = setDependency(MANIFEST, "dsh-trpg", "link:C:/pkg");
  assert.equal(next.changed, true);
  const parsed = JSON.parse(next.text);
  assert.equal(parsed.dependencies["dsh-trpg"], "link:C:/pkg");
  assert.equal(parsed.dependencies["dsh-explore"], "link:C:/somewhere/dsh-explore");
  assert.equal(parsed.dependencies["dsh-context"], "0.69.1");
  assert.equal(parsed.dsh.profile.bundles.length, 3, "不该动 bundles");
});

test("setDependency 对已有依赖只替换版本说明", () => {
  const next = setDependency(MANIFEST, "dsh-explore", "link:C:/moved");
  assert.equal(next.changed, true);
  const parsed = JSON.parse(next.text);
  assert.equal(parsed.dependencies["dsh-explore"], "link:C:/moved");
  assert.equal(Object.keys(parsed.dependencies).length, 3, "不该多出一条");
});

test("appendToArray 追加 bundle，缩进与既有元素一致", () => {
  const next = appendToArray(MANIFEST, "bundles", "dsh-trpg");
  assert.equal(next.changed, true);
  const parsed = JSON.parse(next.text);
  assert.deepEqual(parsed.dsh.profile.bundles, ["@deepseek-ai/dsh-base", "dsh-explore", "dsh-context", "dsh-trpg"]);
  assert.match(next.text, /\n {8}"dsh-trpg"\n/, "新元素缩进应与既有元素一致");
});

test("appendToArray / setDependency 幂等：已存在时不改文本", () => {
  const once = appendToArray(MANIFEST, "bundles", "dsh-trpg");
  const twice = appendToArray(once.text, "bundles", "dsh-trpg");
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once.text);

  const depOnce = setDependency(MANIFEST, "dsh-trpg", "link:C:/pkg");
  const depTwice = setDependency(depOnce.text, "dsh-trpg", "link:C:/pkg");
  assert.equal(depTwice.changed, true, "版本相同也会重写，但内容必须一致");
  assert.equal(JSON.parse(depTwice.text).dependencies["dsh-trpg"], "link:C:/pkg");
});

test("appendToArray 缺键时抛错（而不是静默改坏）", () => {
  assert.throws(() => appendToArray(MANIFEST, "notThere", "x"), /找不到数组/);
  assert.throws(() => setDependency("{}", "x", "y"), /找不到 "dependencies"/);
});

test("removeFromArray / removeDependency 删掉目标并保持 JSON 合法", () => {
  const added = appendToArray(setDependency(MANIFEST, "dsh-trpg", "link:C:/pkg").text, "bundles", "dsh-trpg").text;
  const back = removeDependency(removeFromArray(added, "bundles", "dsh-trpg").text, "dsh-trpg");

  const parsed = JSON.parse(back.text);
  assert.equal(parsed.dependencies["dsh-trpg"], undefined);
  assert.equal(parsed.dsh.profile.bundles.includes("dsh-trpg"), false);
  assert.deepEqual(parsed.dsh.profile.bundles, ["@deepseek-ai/dsh-base", "dsh-explore", "dsh-context"]);
  assert.equal(Object.keys(parsed.dependencies).length, 3);
});

test("remove* 对不存在的目标是不动声色的 no-op", () => {
  const a = removeFromArray(MANIFEST, "bundles", "dsh-trpg");
  assert.equal(a.changed, false);
  assert.equal(a.text, MANIFEST);

  const b = removeDependency(MANIFEST, "dsh-trpg");
  assert.equal(b.changed, false);
  assert.equal(b.text, MANIFEST);

  const c = removeFromArray(MANIFEST, "notThere", "dsh-trpg");
  assert.equal(c.changed, false);
});

test("install：写入清单 + 建 junction，且别人条目毫发无伤", () => {
  const dir = freshProfile();
  try {
    const result = install({ profileDir: dir });
    assert.equal(result.dryRun, false);
    assert.deepEqual(result.changes.sort(), ["node_modules/dsh-trpg junction", "package.json"]);

    const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.equal(parsed.name, "dsh-profile-desktop");
    assert.equal(parsed.private, true);
    assert.equal(parsed.dependencies["dsh-context"], "0.69.1");
    assert.equal(parsed.dependencies["dshmarket"], "^1.66.15");
    assert.equal(parsed.dependencies["dsh-explore"], "link:C:/somewhere/dsh-explore");
    assert.deepEqual(parsed.dsh.profile.bundles.slice(0, 3), ["@deepseek-ai/dsh-base", "dsh-explore", "dsh-context"]);
    assert.equal(parsed.dsh.profile.bundles[3], "dsh-trpg");

    // 备份只写一次，内容是改前原文。
    assert.equal(readFileSync(`${join(dir, "package.json")}.pre-dsh-trpg.bak`, "utf8"), MANIFEST);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install：重复执行是幂等的（第二次不改清单）", () => {
  const dir = freshProfile();
  try {
    install({ profileDir: dir });
    const afterFirst = readFileSync(join(dir, "package.json"), "utf8");
    const second = install({ profileDir: dir });
    assert.deepEqual(second.changes, [], "第二次不该再有改动");
    assert.equal(readFileSync(join(dir, "package.json"), "utf8"), afterFirst);
    // junction 已经被认出来，不该重建（重建也不会出错，但这里要确认判定生效）。
    assert.equal(second.changes.includes("node_modules/dsh-trpg junction"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install --dry-run：只算不写", () => {
  const dir = freshProfile();
  try {
    const result = install({ profileDir: dir, dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(readFileSync(join(dir, "package.json"), "utf8"), MANIFEST, "dry-run 不该动盘");
    assert.equal(readFileSync(join(dir, "package.json"), "utf8").includes("dsh-trpg"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall：把 install 的痕迹全部抹掉", () => {
  const dir = freshProfile();
  try {
    install({ profileDir: dir });
    uninstall({ profileDir: dir });
    assert.equal(readFileSync(join(dir, "package.json"), "utf8"), MANIFEST, "卸载后应逐字回到原样");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install：profile 清单不存在时报错，不静默新建", () => {
  const dir = join(ROOT, "test", ".tmp-install-missing");
  rmSync(dir, { recursive: true, force: true });
  try {
    assert.throws(() => install({ profileDir: dir }), /找不到 profile 清单/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findProfile：--profile 优先于环境变量", () => {
  const env = { DSH_HOME: "C:/home/.dsh", DSH_PROFILE: "web" };
  assert.equal(findProfile(env, ["--profile", "C:/elsewhere"]), join("C:\\elsewhere"));
  assert.equal(findProfile(env, []), join("C:/home/.dsh", "profiles", "web"));
  assert.equal(findProfile({ DSH_PROFILE_DIR: "C:/explicit" }, []), join("C:\\explicit"));
  // 默认 desktop
  assert.equal(findProfile({ DSH_HOME: "C:/home/.dsh" }, []), join("C:/home/.dsh", "profiles", "desktop"));
});
