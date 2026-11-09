import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const tick = () => new Promise(resolve => setImmediate(resolve));
const row = id => ({ id, provider: "openai-codex", windows: [{ label: "Weekly", remaining: 96 }], note: null });
const response = accounts => ({ code: 0, stdout: JSON.stringify({ accounts, warnings: [], checkedAt: Date.now() }) });

function element(id) {
  const target = { nodeId: id, items: [], attrs: {}, handlers: {} };
  const proxy = new Proxy(target, { get(object, key) {
    if (key in object) return object[key];
    return (...args) => {
      if (key === "when") { if (args[0]) args[1](proxy); }
      else if (["child", "content", "trigger"].includes(key)) object.items.push(args[0]);
      else if (key === "children") object.items.push(...args[0]);
      else if (key === "id") object.nodeId = args[0];
      else if (["tooltip", "accessibility_label", "disabled"].includes(key)) object.attrs[key] = args[0];
      else if (["on_click", "on_open_change"].includes(key)) object.handlers[key] = args[0];
      return proxy;
    };
  } });
  return proxy;
}
const text = node => typeof node === "string" ? node : (node.items ?? []).map(text).join(" ");
const exposed = node => typeof node === "string" ? node : [...Object.values(node.attrs ?? {}), ...(node.items ?? []).map(exposed)].join(" ");
const find = (node, id) => node && typeof node === "object" ? node.nodeId === id ? node : node.items.map(child => find(child, id)).find(Boolean) : undefined;

async function setup() {
  const state = { machine: null }, requests = [];
  const context = vm.createContext({});
  const modules = {
    "gpui-kit": { View: class {}, div: () => element(), svg: () => element() },
    "gpui-base": { h_flex: () => element(), v_flex: () => element(), Button: { new: element } },
    herdr: {
      spaces: () => [{ active: true, machine: state.machine }],
      theme: () => ({}), appHome: () => "/app",
      readTextFile: async () => "collector code",
      exec: (command, args, options) => new Promise(resolve => requests.push({ command, args, options, resolve })),
    },
  };
  const module = new vm.SourceTextModule(await readFile(new URL("./main.js", import.meta.url), "utf8"), { context });
  await module.link(name => {
    const values = modules[name];
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  const cx = {
    spawn: callback => { callback(cx); },
    notify() { assert.notEqual(state.rendering, true, "cx.notify() is not allowed during the render phase"); },
    timer: { every() {} },
  };
  const view = new module.namespace.default();
  view.init({}, cx);
  await tick();
  const render = view.render.bind(view);
  view.render = (...args) => {
    state.rendering = true;
    try { return render(...args); }
    finally { state.rendering = false; }
  };
  return { state, requests, view, cx };
}

test("switching machines routes discovery there and ignores a late reply from the previous machine", async () => {
  const { state, requests, view, cx } = await setup();
  assert.equal(requests[0].options.on, null);
  state.machine = "cooper";
  assert.doesNotMatch(text(view.render(cx)), /local account/);
  await tick();
  assert.equal(requests[1].command, "python3");
  assert.equal(requests[1].options.on, "cooper");
  requests[1].resolve(response([{ ...row("remote"), windows: [{ label: "5h", remaining: 40 }] }]));
  await tick();
  requests[0].resolve(response([{ ...row("local"), windows: [{ label: "5h", remaining: 90 }] }]));
  await tick();
  const output = text(view.render(cx));
  assert.match(output, /60%/);
  assert.doesNotMatch(output, /10%/);
  state.machine = null;
  assert.doesNotMatch(text(view.render(cx)), /60%/);
  await tick();
  assert.equal(requests[2].options.on, null);
  requests[2].resolve(response([{ ...row("local"), windows: [{ label: "5h", remaining: 75 }] }]));
  await tick();
  assert.match(text(view.render(cx)), /25%/);
});

test("the sidebar lists provider accounts without harness or account labels", async () => {
  const { requests, view, cx } = await setup();
  requests[0].resolve(response([
    { ...row("personal"), label: "owner@example.com", harnesses: ["Pi", "Codex"], note: "Usage expired", windows: [{ label: "5h", remaining: 68 }] },
    { ...row("work"), provider: "anthropic", label: "Private company", harnesses: ["CodexBar"], windows: [{ label: "Weekly", remaining: 13 }] },
    { ...row("missing"), provider: "xai", harnesses: ["Pi"], windows: [], note: "Quota not reported by this provider" },
  ]));
  await tick();
  const root = view.render(cx);
  const list = find(root, "subscriptions-list");
  const output = text(list);
  assert.match(output, /32%.*87%/);
  assert.match(output, /Quota not reported by this provider/);
  assert.match(text(root), /Subscriptions/);
  assert.doesNotMatch(exposed(list), /owner@example.com|Private company|CodexBar|\bPi\b/);
});

test("spend without a quota does not invent a usage percentage", async () => {
  const { state, requests, view, cx } = await setup();
  requests[0].resolve(response([
    row("personal"),
    row("work"),
    { ...row("grok"), provider: "xai", windows: [{ label: "Weekly", remaining: 88 }] },
    { ...row("router"), provider: "openrouter", windows: [], summary: "$1.25 used this month", note: "No spending cap set" },
  ]));
  await tick();
  const output = text(view.render(cx));
  assert.match(output, /\$1.25 used this month/);
  // A provider with spend but no cap must not invent a remaining percentage.
  requests.length = 0;
  view.refresh(cx);
  await tick();
  requests[0].resolve(response([{ ...row("router"), provider: "openrouter", windows: [], summary: "$1.25 used this month", note: "No spending cap set" }]));
  await tick();
  const badge = text(find(view.render(cx), "subscriptions-list"));
  assert.match(badge, /\$1.25 used this month/);
  assert.doesNotMatch(badge, /%|Usage unavailable/);
});

test("an invalid refresh is rejected and a previous successful snapshot is visibly marked stale", async () => {
  const { requests, view, cx } = await setup();
  requests[0].resolve(response([row("known")]));
  await tick();
  view.refresh(cx);
  await tick();
  requests[1].resolve(response([{ ...row("invalid"), windows: [{ label: "Weekly", remaining: 101 }] }]));
  await tick();
  const output = text(view.render(cx));
  assert.match(exposed(view.render(cx)), /Unexpected account-usage response/);
  assert.match(output, /may be stale/);
  assert.match(output, /4%/);
});
