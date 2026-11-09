import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const tick = () => new Promise(resolve => setImmediate(resolve));
function element(id) {
  const node = { nodeId: id, items: [], handlers: {} };
  const proxy = new Proxy(node, { get(object, key) {
    if (key in object) return object[key];
    return (...args) => {
      if (key === "when") { if (args[0]) args[1](proxy); }
      else if (key === "id") object.nodeId = args[0];
      else if (["child", "content", "trigger"].includes(key)) object.items.push(args[0]);
      else if (key === "children") object.items.push(...args[0]);
      else if (key === "on_click") object.handlers.click = args[0];
      return proxy;
    };
  } });
  return proxy;
}
const find = (node, id) => node && typeof node === "object"
  ? node.nodeId === id ? node : node.items.map(child => find(child, id)).find(Boolean) : undefined;
const issue = { id: "issue-uuid", identifier: "RIFF-62", title: "A title is not an identifier", url: "https://linear.app/example/issue/RIFF-62", state: { id: "started", name: "Started", type: "started", position: 0 }, team: { name: "Team" }, assignee: null };

async function setup() {
  const state = {
    focus: { space: "s", tab: "tab", terminal: "t1", agent: "t1" },
    agents: [{ address: "t1", space: "s", tab: "tab", app: "omp", status: "working" }],
    calls: [], notifications: [], actions: [],
  };
  const context = vm.createContext({});
  const input = { value: () => "", set_value() {}, set_masked() {}, on() {} };
  const modules = {
    "gpui-kit": { View: class {}, div: () => element(), svg: () => element(), image: () => element() },
    "gpui-base": { v_flex: () => element(), h_flex: () => element(), Button: { new: element }, Popover: { new: element }, InputState: { new: () => input }, Input: { new: () => element() } },
    herdr: {
      agents: () => state.agents, focused: () => state.focus, appHome: () => "/app",
      notify: value => state.notifications.push(value), run: (...args) => state.actions.push(args),
      props: () => ({}), theme: () => ({}), window: () => ({ platform: "macos" }), writeTextFile() {},
      exec: async (command, args) => {
        if (args[0].endsWith("client.py")) return { code: 0, stdout: JSON.stringify({ ok: true, connected: false, storage: { available: true } }) };
        return new Promise(resolve => state.calls.push({ command, args, resolve }));
      },
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
  const view = new module.namespace.default(), cx = { spawn: callback => callback(cx), notify() {} };
  view.init({}, cx);
  await tick();
  view.account = { workspace: { name: "Workspace" }, viewer: { name: "User" }, teams: [] };
  view.issues = [issue];
  return { state, view, cx, click: () => find(view.render(), `linear-issue-${issue.id}`).handlers.click({}, cx) };
}

const success = call => call.resolve({ code: 0, stdout: JSON.stringify({ ok: true }) });

test("an issue click targets the shown remote agent, using the issue identifier rather than its title or UUID", async () => {
  const { state, view, click } = await setup();
  state.focus = { space: "remote-space", tab: "remote-tab", terminal: "cooper/t2", shown: "cooper/t8", agent: "t1" };
  state.agents.push({ address: "cooper/t8", space: "remote-space", tab: "remote-tab", app: "claude-code", status: "idle" });
  click();
  assert.equal(state.calls[0].args[state.calls[0].args.indexOf("--terminal") + 1], "cooper/t8");
  assert.equal(state.calls[0].args[state.calls[0].args.indexOf("--app") + 1], "claude-code");
  assert.equal(state.calls[0].args[state.calls[0].args.indexOf("--issue") + 1], "RIFF-62");
  click();
  assert.equal(state.calls.length, 1, "another click while drafting must not duplicate input");
  success(state.calls[0]);
  await tick();
  assert.equal(view.drafting, false);
  assert.equal(state.actions[0][0], "pane.focus");
  assert.equal(state.actions[0][1].terminal, "cooper/t8");
  assert.match(state.notifications.at(-1).body, /press Enter/i);
});

test("shells, absent focus, mismatched tabs/spaces, and unavailable agents never receive issue text", async () => {
  const { state, click } = await setup();
  const original = state.focus;
  for (const focus of [null, { ...original, terminal: "shell" }, { ...original, tab: "another" }, { ...original, space: "another" }]) {
    state.focus = focus;
    click();
  }
  state.focus = original;
  for (const status of ["blocked", "error", "unknown"]) {
    state.agents[0].status = status;
    click();
  }
  assert.equal(state.calls.length, 0);
  assert.equal(state.actions.length, 0);
  assert.equal(state.notifications.length, 7);
  assert(state.notifications.every(item => item.level === "warning"));
});

test("completion does not steal focus after navigation, and uncertain delivery never reports success", async () => {
  const { state, view, click } = await setup();
  click();
  state.focus = { space: "other", tab: "other", terminal: "t2" };
  success(state.calls[0]);
  await tick();
  assert.equal(state.actions.length, 0);
  state.focus = { space: "s", tab: "tab", terminal: "t1" };
  state.notifications = [];
  click();
  state.calls[1].resolve({ code: 0, stdout: JSON.stringify({ ok: false, message: "Check the input before trying again." }) });
  await tick();
  assert.equal(view.drafting, false);
  assert.equal(state.actions.length, 0);
  assert.equal(state.notifications.at(-1).level, "error");
  assert.match(state.notifications.at(-1).body, /Check the input/);
});

test("named statuses stay separate within a category, sort by workflow, and fold independently as pages arrive", async () => {
  const { view, cx } = await setup();
  const make = (id, name, type, position, team = "Team") => ({
    ...issue, id, state: { id: `state-${id}`, name, type, position }, team: { name: team },
  });
  view.issues = [
    make("review", "In Review", "started", 2),
    make("done", "Done", "completed", 0),
    make("progress", "In Progress", "started", 1),
    make("todo", "Todo", "unstarted", 0),
    make("backlog", "Backlog", "backlog", 0),
    make("other-team", "In Review", "started", 2, "Other team"),
    make("same-name", "In Review", "unstarted", 1),
  ];
  const groups = node => {
    if (!node || typeof node !== "object") return [];
    return [
      ...(node.nodeId?.startsWith("linear-group-") ? [node] : []),
      ...node.items.flatMap(groups),
    ];
  };
  const text = node => typeof node === "string" ? node : node?.items?.map(text).join(" ") || "";
  let tree = view.render();
  const headers = groups(tree);
  assert.deepEqual(headers.map(header => text(header)), [
    "▾ Backlog 1", "▾ Todo 1", "▾ In Review 1", "▾ In Progress 1", "▾ In Review 2", "▾ Done 1",
  ]);
  headers[4].handlers.click({}, cx);
  tree = view.render();
  assert.equal(find(tree, "linear-issue-review"), undefined);
  assert.equal(find(tree, "linear-issue-other-team"), undefined);
  assert(find(tree, "linear-issue-progress"));
  assert(find(tree, "linear-issue-same-name"));
  view.issues.push(make("next-page", "In Review", "started", 2));
  tree = view.render();
  assert.equal(find(tree, "linear-issue-next-page"), undefined);
  const folded = groups(tree)[4];
  assert.equal(text(folded), "▸ In Review 3");
  folded.handlers.click({}, cx);
  tree = view.render();
  for (const id of ["review", "other-team", "next-page"]) assert(find(tree, `linear-issue-${id}`));
});
