import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

function element() {
  const node = { nodeId: null, items: [], handlers: {} };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === "when") { if (args[0]) args[1](proxy); }
      else if (key === "id") target.nodeId = args[0];
      else if (key === "child") target.items.push(args[0]);
      else if (key === "children") target.items.push(...args[0]);
      else if (key.startsWith("on_")) target.handlers[key] = args.at(-1);
      return proxy;
    };
  } });
  return proxy;
}

const find = (node, id) => node && typeof node === "object"
  ? node.nodeId === id ? node : node.items.map(child => find(child, id)).find(Boolean) : undefined;

async function setup(saved = new Map()) {
  const spaces = [
    { id: "local", name: "Local", machine: null, active: true, tabs: [
      { id: "local-idle", index: 1, active: true, named: true, name: "Local idle" },
    ] },
    { id: "other", name: "Other", machine: null, active: false, tabs: [
      { id: "other-idle", index: 1, active: true, named: true, name: "Other idle" },
      { id: "other-working", index: 2, named: true, name: "Other working" },
      { id: "other-reviewed", index: 3, named: true, name: "Other reviewed", settled: true },
    ] },
    { id: "remote/local", name: "Remote", machine: "remote", active: false, tabs: [
      { id: "remote/idle", index: 1, active: true, named: true, name: "Remote idle" },
    ] },
  ];
  const shared = new Map([["spaces.scope", "local"]]);
  const actions = [];
  const context = vm.createContext({ localStorage: {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: key => saved.delete(key),
  } });
  const modules = new Map();
  const libraries = {
    "gpui-kit": { View: class {}, div: element, svg: element, image: element },
    "gpui-base": { h_flex: element, v_flex: element },
    herdr: {
      spaces: () => spaces, machines: () => [{ name: null, layout: "ready" }, { name: "remote", layout: "ready" }],
      panes: () => [], terminals: () => [],
      agents: () => spaces.flatMap(space => space.tabs.map(tab => ({ address: `agent:${tab.id}`, tab: tab.id,
        status: tab.id === "other-working" ? "working" : "idle", program: { agent: true, name: "Agent" } }))),
      setAgentOrder() {}, nextCommand() {}, exec() {}, hc() {}, watchFolder() {},
      run: (...args) => actions.push(args), openOverlay() {}, theme: () => ({}), keys: () => [],
      window: () => ({ platform: "macos" }), shared: key => shared.get(key), setShared: (key, value) => shared.set(key, value),
    },
  };
  async function load(name) {
    if (modules.has(name)) return modules.get(name);
    const values = libraries[name];
    const module = values ? new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context }) : new vm.SourceTextModule(await readFile(new URL(name, import.meta.url), "utf8"), { context });
    modules.set(name, module);
    if (!values) await module.link(load);
    return module;
  }
  const module = await load("./main.js");
  await module.evaluate();
  const cx = { spawn() {}, notify() {}, timer: { every() {} }, stop_propagation() {} };
  const create = () => { const view = new module.namespace.default(); view.init({}, cx); return view; };
  return { view: create(), create, spaces, shared, actions, saved, cx };
}

test("every project exposes idle, working, and reviewed threads without following project focus", async () => {
  const { view, spaces, shared } = await setup();
  for (const active of ["local", "other", "local"]) {
    for (const space of spaces) space.active = space.id === active;
    const tree = view.render();
    for (const id of ["local-idle", "other-idle", "other-working", "other-reviewed"]) {
      assert(find(tree, `thread-${id}`), `${id} must stay visible with ${active} selected`);
    }
  }
  shared.set("spaces.scope", "remote");
  assert(find(view.render(), "thread-remote/idle"));
});

test("folding a project hides only its threads, survives reload and focus changes, and never navigates", async () => {
  const { view, create, spaces, actions, cx } = await setup();
  find(view.render(), "project-fold-other").handlers.on_click({}, cx);
  let tree = view.render();
  assert(find(tree, "thread-local-idle"));
  assert.equal(find(tree, "thread-other-idle"), undefined);
  assert.equal(find(tree, "thread-other-working"), undefined);
  assert.equal(find(tree, "thread-other-reviewed"), undefined);
  assert(find(tree, "space-other"));
  spaces[0].active = false;
  spaces[1].active = true;
  assert.equal(find(view.render(), "thread-other-idle"), undefined);
  const reloaded = create();
  tree = reloaded.render();
  assert.equal(find(tree, "thread-other-idle"), undefined);
  find(tree, "project-fold-other").handlers.on_click({}, cx);
  tree = reloaded.render();
  for (const id of ["local-idle", "other-idle", "other-working", "other-reviewed"]) assert(find(tree, `thread-${id}`));
  assert.deepEqual(actions, []);
});
