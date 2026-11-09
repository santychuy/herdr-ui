import assert from "node:assert/strict";
import test from "node:test";
import { buildThreads } from "./threads.js";

const program = { key: "pi", name: "Pi", icon: null, tint: true, tile: null, color: null, shell: false, agent: true };
const tab = (id = "tab1", extra = {}) => ({ id, index: 1, name: "1", named: false, active: false, status: null, panes: 1, zoomed: false, settled: false, settled_at: null, changed_at: null, working_since: null, ...extra });
const space = (tabs, extra = {}) => ({ id: "space1", index: 1, name: "Project", named: true, folder: "/project", machine: null, branch: null, active: true, status: null, tabs, ...extra });
const agent = (address, status, extra = {}) => ({ address, pane: `p-${address}`, space: "space1", space_name: "Project", tab: "tab1", tab_index: 1, tab_name: "1", status, app: "pi", program, title: "Fix sidebar", seq: 1, pinned: false, focused: false, ...extra });
const terminal = (address, status, parent = null, extra = {}) => ({ address, status, parent, state: "live", labels: {}, ...extra });
const pane = (terminal, extra = {}) => ({ pane: `p-${terminal}`, terminal, tab: "tab1", title: "Shell", program: { ...program, key: "shell", name: "zsh", agent: false, shell: true }, status: null, focused: false, zoomed: false, ...extra });
const row = (extra = {}) => buildThreads({ spaces: [space([tab()])], ...extra })[0];

test("a thread aggregates independent agents and selects the most urgent tree", () => {
  const first = agent("t1", "working", { focused: true });
  const done = agent("t2", "done");
  const blocked = agent("t3", "idle");
  const result = row({
    agents: [first, done, blocked],
    terminals: [terminal("t1", "working"), terminal("t2", "done"), terminal("t3", "idle"), terminal("t4", "error", "t3")],
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.rank, 4);
  assert.equal(result.primary, blocked);
  assert.deepEqual(result.agents, [first, done, blocked]);
  assert.equal(result.needsAttention, true);
  assert.equal(result.busy, true);
  assert.deepEqual(result.descendants.map(child => child.address), ["t4"]);
  const withoutBlock = row({ agents: [first, done] });
  assert.equal(withoutBlock.status, "done");
  assert.equal(withoutBlock.primary, done);
  assert.equal(withoutBlock.busy, true);
});

test("descendants escalate blocking and working but never report completion for their parent", () => {
  const cases = [
    ["done", "working", "live", "done", true],
    ["done", "error", "live", "blocked", true],
    ["idle", "working", "live", "working", true],
    ["idle", "done", "live", "idle", false],
    ["idle", "blocked", "finished", "idle", false],
  ];
  for (const [parent, child, state, expected, busy] of cases) {
    const result = row({
      agents: [agent("t1", parent)],
      terminals: [terminal("t1", parent), terminal("t2", child, "t1", { state })],
    });
    assert.equal(result.status, expected, `${parent} with ${state} ${child}`);
    assert.equal(result.busy, busy);
    assert.equal(result.descendants.length, state === "finished" ? 0 : 1);
  }
});

test("listed child agents fold into their ancestor without creating another independent completion", () => {
  const parent = agent("t1", "idle");
  const child = agent("t2", "done", { pinned: true });
  const result = row({
    agents: [parent, child],
    terminals: [terminal("t1", "idle"), terminal("t2", "done", "t1"), terminal("t3", "working", "t2")],
  });
  assert.deepEqual(result.agents, [parent]);
  assert.equal(result.primary, parent);
  assert.equal(result.status, "working");
  assert.equal(result.pinned, true);
  assert.deepEqual(result.descendants.map(child => child.address), ["t2", "t3"]);
});

test("qualified identities preserve project boundaries, tab order, and unavailable machine state", () => {
  const localTab = tab("tab1");
  const remoteTab = tab("remote/tab1", { settled: true });
  const loadingTab = tab("loading/tab1");
  const result = buildThreads({
    spaces: [space([localTab]), space([remoteTab], { id: "remote/space1", machine: "remote" }), space([loadingTab], { id: "loading/space1", machine: "loading" })],
    agents: [agent("t1", "idle"), agent("remote/t1", "idle", { space: "remote/space1", tab: "remote/tab1" })],
    terminals: [terminal("t1", "idle"), terminal("remote/t1", "idle"), terminal("remote/t2", "error", "remote/t1")],
    machines: [{ name: "remote", layout: "unavailable" }, { name: "loading", layout: "loading" }],
  });
  assert.deepEqual(result.map(item => item.id), ["tab1", "remote/tab1", "loading/tab1"]);
  assert.equal(result[0].available, true);
  assert.equal(result[0].status, "idle");
  assert.deepEqual(result[0].descendants, []);
  assert.deepEqual(result[1].descendants.map(child => child.address), ["remote/t2"]);
  for (const item of result.slice(1)) {
    assert.equal(item.status, "unavailable");
    assert.equal(item.available, false);
    assert.equal(item.reviewed, false);
    assert.equal(item.rank, 0);
  }
});

test("native settle review resurfaces when work or attention returns", () => {
  const settled = tab("tab1", { settled: true, active: true });
  const cases = [["idle", null, true], ["working", null, false], ["blocked", null, false], ["done", null, false], ["done", "working", false]];
  for (const [status, child, reviewed] of cases) {
    const result = row({
      spaces: [space([settled])], agents: [agent("t1", status)],
      terminals: [terminal("t1", status), ...(child ? [terminal("t2", child, "t1")] : [])],
    });
    assert.equal(result.reviewed, reviewed, `${status} / ${child}`);
    assert.equal(result.current, true);
    assert.equal(result.tab, settled);
  }
  assert.equal(row({ agents: [agent("t1", "idle")] }).reviewed, false);
  assert.equal(row({ spaces: [space([settled], { active: false })] }).current, false);
});

test("primary ties favor focus then original order, and titles use meaningful native metadata", () => {
  const first = agent("t1", "idle", { title: "First" });
  const second = agent("t2", "idle", { focused: true, title: "\x1b[32m✦ Fix API\x1b[0m\x07" });
  assert.equal(row({ agents: [first, second] }).title, "Fix API");
  assert.equal(row({ agents: [first, { ...second, focused: false }] }).primary, first);
  assert.equal(row({ spaces: [space([tab("tab1", { named: true, name: "Release" })])], agents: [second] }).title, "Release");
  assert.equal(row({ agents: [agent("t1", "working", { title: "π ⠼ 󱂪 Fix sidebar" })] }).title, "Fix sidebar");
  for (const title of ["~/project", "user@host", "Pi", "pi", "✦"]) {
    assert.equal(row({ agents: [agent("t1", "idle", { title })] }).title, "Pi", title);
  }
  const shellPane = pane("t1", { title: "Logs" });
  const shell = row({ panes: [shellPane] });
  assert.equal(shell.title, "Logs");
  assert.equal(shell.program, shellPane.program);
  assert.equal(shell.status, "none");
  assert.equal(shell.primary, null);
  assert.equal(row().title, "Terminal 1");
});

test("shell and mod tabs remain visible, and ancestry cannot duplicate cross-tab work", () => {
  const tabs = [tab(), tab("tab2", { index: 2 }), tab("tab3", { index: 3 })];
  const result = buildThreads({
    spaces: [space(tabs)],
    agents: [agent("t2", "working", { tab: "tab2" })],
    panes: [pane("t1"), pane("t2", { tab: "tab2" }), pane(null, { pane: "mod", tab: "tab3", mod: "diagrams", title: "Diagrams", program: undefined })],
    terminals: [terminal("t1", null), terminal("t2", "working", "t1")],
  });
  assert.deepEqual(result.map(item => item.status), ["none", "working", "none"]);
  assert.deepEqual(result[0].descendants, []);
  assert.equal(result[2].title, "Diagrams");
  assert.equal(result[2].program, null);
});

test("cyclic ancestry terminates with one owner and includes each live descendant once", () => {
  const result = row({
    agents: [agent("t1", "idle"), agent("t2", "working")],
    terminals: [terminal("t1", "idle", "t2"), terminal("t2", "working", "t1"), terminal("t3", "error", "t2")],
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.agents.length, 1);
  assert.equal(result.descendants.length, 2);
  assert.equal(new Set(result.descendants.map(child => child.address)).size, 2);
});
