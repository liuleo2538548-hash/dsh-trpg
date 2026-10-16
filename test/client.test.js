/**
 * dsh-trpg — 浏览器半的静态与结构测试。
 *
 * 这里不起浏览器、不起 HTTP 服务，也不联网：
 *   - 用 node:vm 造一个 `window.__ModuleLoader__`，把 client.js 跑起来并捕获它注册的 spec；
 *   - 用最小替身喂 `require("react")`，拿到 factory 的返回值；
 *   - 用假 ctx 调 `apply()`，检查它往哪些 slot 注册了什么，以及「返回会话」是否真会调到 layout。
 *
 * 这样做能挡住三类真事故：factory 形状写错（宿主直接加载失败）、slot 注册名与 PANEL_ID
 * 不一致（点了侧栏没反应）、以及 main 面板顶掉会话视图后没有返回路径。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const CLIENT_PATH = fileURLToPath(new URL("../client/client.js", import.meta.url));
const SOURCE = readFileSync(CLIENT_PATH, "utf8");

const PLUGIN_ID = "dsh-trpg";

/** 宿主 lib/index.js 里注册的七条路由，客户端一个字面量都不许多。 */
const ROUTES = [
  "/api/dsh-trpg/state",
  "/api/dsh-trpg/command",
  "/api/dsh-trpg/models",
  "/api/dsh-trpg/scenario",
  "/api/dsh-trpg/turn",
  "/api/dsh-trpg/bribe",
  "/api/dsh-trpg/import",
];

/* ------------------------------------------------------------- 替身工厂 -- */

/** createElement 只保留形状，够我们把组件树走一遍即可。 */
function makeElement(type, props, ...children) {
  return { type, props: props || {}, children };
}

class StubComponent {
  constructor(props) {
    this.props = props || {};
    this.state = {};
  }

  setState(next) {
    const patch = typeof next === "function" ? next(this.state) : next;
    this.state = { ...this.state, ...(patch || {}) };
  }
}

function makeReact() {
  const React = {
    createElement: makeElement,
    Component: StubComponent,
    useRef: (initial) => ({ current: initial === undefined ? null : initial }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    Fragment: Symbol("Fragment"),
  };
  React.createRef = () => ({ current: null });
  return React;
}

function makeDocument() {
  const styles = [];
  return {
    styles,
    createElement: () => ({
      setAttribute() {},
      remove() {
        styles.pop();
      },
      textContent: "",
    }),
    head: {
      appendChild(node) {
        styles.push(node);
      },
    },
    body: { appendChild() {}, removeChild() {} },
  };
}

/**
 * 在 vm 里跑 client.js，返回它交给 ModuleLoader 的 spec。
 *
 * 注意 `document` 必须真的放进沙箱：installStyles 把 `document.createElement` 包在
 * try/catch 里（样式是加分项，不该阻塞挂载），所以少给一个全局会**静默**变成"没注入样式"。
 */
function loadSpec({ document: document_ } = {}) {
  let spec = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(candidate) {
          spec = candidate;
        },
      },
    },
    document: document_ || makeDocument(),
    console,
  };
  vm.createContext(sandbox);
  new vm.Script(SOURCE, { filename: CLIENT_PATH }).runInContext(sandbox);
  assert.ok(spec, "client.js 没有调用 window.__ModuleLoader__.load");
  return spec;
}

function makeFactoryResult() {
  const document_ = makeDocument();
  const spec = loadSpec({ document: document_ });
  const React = makeReact();
  const requested = [];
  const require = (name) => {
    requested.push(name);
    if (name === "react") return React;
    throw new Error(`客户端不应 require("${name}")`);
  };
  const result = spec.factory(require);
  return { spec, result, React, document: document_, requested };
}

/** 假 ctx：slots 走 inject，effect 立即执行并把 cleanup 记下来。 */
function makeCtx({ slots, layout } = {}) {
  const effects = [];
  const ctx = {
    effects,
    get(name) {
      if (name === "slots") return slots === undefined ? defaultSlots() : slots;
      if (name === "layout") return layout === undefined ? null : layout;
      return null;
    },
    effect(fn, label) {
      const cleanup = typeof fn === "function" ? fn() : undefined;
      effects.push({ label, cleanup });
      return typeof cleanup === "function" ? cleanup : () => {};
    },
  };
  return ctx;
}

function defaultSlots() {
  const registered = [];
  const injected = [];
  const disposed = [];
  return {
    registered,
    injected,
    disposed,
    inject(name, cb) {
      injected.push(name);
      cb();
      return () => disposed.push(name);
    },
    register(meta, component) {
      registered.push({ meta, component });
      return () => disposed.push(meta.name);
    },
  };
}

/** 深度优先找出树里所有元素（含嵌套 children）。 */
function walk(node, out = []) {
  if (node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out);
    return out;
  }
  if (typeof node === "object" && typeof node.type !== "undefined") {
    out.push(node);
    walk(node.children, out);
  }
  return out;
}

/* --------------------------------------------------------------- 用例 -- */

test("静态：没有顶层 import、没有 host.call，走 ModuleLoader", () => {
  assert.equal(/^\s*import\s/m.test(SOURCE), false, "IIFE 不能有顶层 import");
  assert.equal(SOURCE.includes("host.call"), false, "已安装 bundle 拿不到 host.call");
  assert.match(SOURCE, /__ModuleLoader__\s*\.\s*load/);
});

test("静态：客户端引用的 /api 路径恰好是宿主那七条", () => {
  const found = new Set(SOURCE.match(/\/api\/[A-Za-z0-9_/-]+/g) || []);
  for (const path of found) {
    assert.ok(ROUTES.includes(path), `客户端用了未注册的路由 ${path}`);
  }
  for (const path of ROUTES) {
    assert.ok(found.has(path), `客户端没有用到路由 ${path}`);
  }
  assert.equal(found.size, ROUTES.length);
});

test("ModuleLoader spec：id 等于包名，factory 是函数", () => {
  const spec = loadSpec();
  assert.equal(spec.id, PLUGIN_ID);
  assert.equal(typeof spec.factory, "function");
});

test("factory：只 require('react')，返回 { name, inject, apply }", () => {
  const { result, requested } = makeFactoryResult();
  assert.deepEqual(requested, ["react"]);
  assert.deepEqual(Object.keys(result).sort(), ["apply", "inject", "name"]);
  assert.equal(result.name, PLUGIN_ID);
  // result.inject 是 vm 那个 realm 里造出来的数组，原型与本 realm 不同，
  // deepStrictEqual 会判"结构相同但引用不等"，所以比内容而不是比对象。
  assert.deepEqual([...result.inject], ["slots"]);
  assert.equal(typeof result.apply, "function");
});

test("apply：注册 sidebar.panellist 与 main，共用同一 PANEL_ID", () => {
  const { result } = makeFactoryResult();
  const slots = defaultSlots();
  result.apply(makeCtx({ slots }));

  assert.equal(slots.registered.length, 2);
  const panel = slots.registered[0].meta;
  const main = slots.registered[1].meta;

  assert.equal(panel.name, "sidebar.panellist");
  assert.equal(panel.id, PLUGIN_ID);
  assert.equal(panel.id, main.key, "侧栏图标与 main 必须是同一个 id");
  assert.equal(main.name, "main");
  assert.equal(typeof panel.order, "number");
  assert.equal(panel.label(), "AI 跑团");
  assert.equal(typeof slots.registered[0].component, "function");
  assert.equal(typeof slots.registered[1].component, "function");
});

test("apply：先等父 slot 声明（inject），父没声明也能直接注册", () => {
  const { result } = makeFactoryResult();
  const slots = defaultSlots();
  result.apply(makeCtx({ slots }));
  assert.deepEqual(slots.injected, ["sidebar.panellist", "main"]);

  // 只有 register、没有 inject 的极简 slot 表也不能崩。
  const bare = { registered: [], register(meta, component) { this.registered.push({ meta, component }); } };
  const ctx = makeCtx({ slots: bare });
  assert.doesNotThrow(() => result.apply(ctx));
  assert.equal(bare.registered.length, 2);

  // inject 抛错时退回直接注册。
  const hostile = {
    registered: [],
    inject() { throw new Error("父 slot 还没声明"); },
    register(meta, component) { this.registered.push({ meta, component }); return () => {}; },
  };
  assert.doesNotThrow(() => result.apply(makeCtx({ slots: hostile })));
  assert.equal(hostile.registered.length, 2);
});

test("apply：slots 服务不可用时不抛错，只是不挂载", () => {
  const { result } = makeFactoryResult();
  const warn = console.warn;
  const seen = [];
  console.warn = (...args) => seen.push(args.join(" "));
  try {
    assert.doesNotThrow(() => result.apply(makeCtx({ slots: null })));
  } finally {
    console.warn = warn;
  }
  assert.equal(seen.some((line) => line.includes("slots")), true);
});

test("apply：样式表注入一次，并在 effect cleanup 里摘掉", () => {
  const { result, document: doc } = makeFactoryResult();
  const slots = defaultSlots();
  const ctx = makeCtx({ slots });
  result.apply(ctx);
  assert.equal(doc.styles.length, 1);

  const styleEffect = ctx.effects.find((entry) => entry.label === PLUGIN_ID + ": styles");
  assert.ok(styleEffect, "没有注册样式 effect");
  styleEffect.cleanup();
  assert.equal(doc.styles.length, 0);
});

test("apply：卸载时把两个 slot 都注销", () => {
  const { result } = makeFactoryResult();
  const slots = defaultSlots();
  const ctx = makeCtx({ slots });
  result.apply(ctx);

  const slotsEffect = ctx.effects.find((entry) => entry.label === PLUGIN_ID + ": slots");
  assert.ok(slotsEffect, "没有注册 slots effect");
  slotsEffect.cleanup();
  assert.deepEqual(slots.disposed.slice().sort(), ["main", "sidebar.panellist"]);
});

test("main 面板被 error boundary 包着，且有 getDerivedStateFromError", () => {
  const { result } = makeFactoryResult();
  const slots = defaultSlots();
  result.apply(makeCtx({ slots }));

  const PanelRoot = slots.registered[1].component;
  const root = PanelRoot({});
  const Boundary = root.type;
  assert.equal(typeof Boundary.getDerivedStateFromError, "function");
  assert.equal(typeof Boundary, "function");

  const instance = new Boundary(root.props);
  instance.state = Boundary.getDerivedStateFromError(new Error("故意炸一个"));
  const tree = instance.render();
  const texts = walk(tree)
    .flatMap((node) => (Array.isArray(node.children) ? node.children : []))
    .filter((child) => typeof child === "string");
  assert.ok(texts.includes("面板渲染失败"), "崩溃 fallback 里没有报错标题");
  assert.ok(texts.includes("故意炸一个"), "崩溃 fallback 里没有带出原始消息");
});

test("返回会话：fallback 上的按钮真的调 layout.selectPanel(null)", () => {
  const { result } = makeFactoryResult();
  const slots = defaultSlots();
  const calls = [];
  const layout = { selectPanel: (value) => calls.push(value) };
  result.apply(makeCtx({ slots, layout }));

  const PanelRoot = slots.registered[1].component;
  const root = PanelRoot({});
  const Boundary = root.type;
  const instance = new Boundary(root.props);
  instance.state = Boundary.getDerivedStateFromError(new Error("boom"));
  const tree = instance.render();

  const exit = walk(tree).find((node) => typeof node.props.onClick === "function" && node.props.onClick === root.props.onExit);
  assert.ok(exit, "崩溃 fallback 里找不到返回会话的按钮");

  const labels = walk(tree)
    .flatMap((node) => (Array.isArray(node.children) ? node.children : []))
    .filter((child) => typeof child === "string");
  assert.ok(labels.includes("← 返回会话"), "返回按钮的文字不对");

  exit.props.onClick();
  assert.deepEqual(calls, [null]);
});

test("返回会话：layout 缺失时只警告，不抛错", () => {
  const { result } = makeFactoryResult();
  const slots = defaultSlots();
  const warn = console.warn;
  const seen = [];
  console.warn = (...args) => seen.push(args.join(" "));
  try {
    result.apply(makeCtx({ slots, layout: null }));
    const PanelRoot = slots.registered[1].component;
    const root = PanelRoot({});
    assert.doesNotThrow(() => root.props.onExit());
  } finally {
    console.warn = warn;
  }
  assert.equal(seen.some((line) => line.includes("layout")), true);
});

test("apply：effect 缺失的宿主也不能崩", () => {
  const { result } = makeFactoryResult();
  const slots = defaultSlots();
  const ctx = {
    get: (name) => (name === "slots" ? slots : null),
  };
  assert.doesNotThrow(() => result.apply(ctx));
  assert.equal(slots.registered.length, 2);
});

test("源码：SSE 走 text/event-stream 且按空行切帧", () => {
  assert.match(SOURCE, /text\/event-stream/);
  assert.match(SOURCE, /split\(\/\\r\?\\n\/\)|split\("\\n\\n"\)|indexOf\("\\n\\n"\)/);
});

test("主题：不用 ink token 做「填充 + 白字」，主色按钮用正确的一对 token", () => {
  /*
   * `--dsw-alias-brand-primary` 是 INK token（浅色近黑、深色近白），只在描边/文字/
   * 淡色调（color-mix）上安全。真正的坑是把它当**实心背景**又配白字：深色主题下
   * 就是白字压近白底，对比度 1.05:1。所以这里逐条规则检查，而不是全局 grep。
   */
  const css = SOURCE.match(/const CSS = `([\s\S]*?)`;/);
  assert.ok(css, "找不到 CSS 模板串");
  const rules = css[1].split("}");

  const whiteText = /color\s*:\s*(#fff|#ffffff|white|var\(--dsw-alias-label-primary-foreground\))/i;
  const solidInkFill = /background(-color)?\s*:\s*var\(--dsw-alias-brand-primary\)/;
  for (const rule of rules) {
    if (solidInkFill.test(rule)) {
      assert.equal(whiteText.test(rule), false, `ink token 当实心背景又配白字：${rule.trim().slice(0, 80)}`);
    }
  }

  // 主色按钮/chip 必须用 fill + foreground 这一对。
  assert.match(SOURCE, /--dsw-alias-button-primary-fill/);
  assert.match(SOURCE, /--dsw-alias-label-primary-foreground/);
});
