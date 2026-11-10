import test from "node:test";
import assert from "node:assert/strict";
import { navigation } from "./navigation.js";

function inventory() {
  const program = { name: "Agent", agent: true };
  return {
    spaces: [
      { id: "local", name: "Local project", machine: null, tabs: [
        { id: "work", index: 1, name: "Build", named: true },
        { id: "notes", index: 2, name: "Notes", named: true },
      ] },
      { id: "remote/project", name: "Remote project", machine: "remote", tabs: [
        { id: "remote/work", index: 1, name: "Shell", named: true },
      ] },
    ],
    agents: [
      { address: "t1", tab: "work", status: "working", program },
      { address: "t2", tab: "work", status: "idle", program },
      { address: "t3", tab: "work", status: "working", program },
    ],
    terminals: [
      { address: "t1", state: "live", status: "working" },
      { address: "t2", state: "live", status: "idle" },
      { address: "t3", parent: "t1", state: "live", status: "working", program },
      { address: "worker", parent: "t1", state: "live", status: null },
      { address: "shell", state: "live", status: null },
      { address: "exited", state: "finished", status: "done" },
      { address: "remote/t1", state: "live", status: null },
    ],
    panes: [
      { pane: "p1", terminal: "t1", tab: "work" },
      { pane: "p2", terminal: "t2", tab: "work" },
      { pane: "p3", terminal: "t3", tab: "work" },
      { pane: "shell-pane", terminal: "shell", tab: "work" },
      { pane: "exited-pane", terminal: "exited", tab: "work" },
      { pane: "notes-pane", terminal: null, tab: "notes", mod: "markdown" },
      { pane: "remote/p1", terminal: "remote/t1", tab: "remote/work" },
    ],
    machines: [{ name: null, layout: "ready" }, { name: "remote", layout: "ready" }],
  };
}

const rows = (data, view) => navigation(data, view, "all", "attention");

test("agents exclude shells, plain child programs, and mod tabs without losing split or child agents", () => {
  const agents = rows(inventory(), "agents");
  assert.deepEqual(new Set(agents.map(row => row.args.terminal)), new Set(["t1", "t2", "t3"]));
  assert.equal(agents.find(row => row.args.terminal === "t2").status, "idle");
});

test("terminal inventory independently targets split panes, deduplicates promoted children, and retains background programs", () => {
  const terminals = rows(inventory(), "terminals");
  const find = address => terminals.find(row => row.id === `terminal:${address}`);
  for (const [address, pane] of [["t1", "p1"], ["t2", "p2"], ["t3", "p3"], ["shell", "shell-pane"], ["remote/t1", "remote/p1"]]) {
    assert.deepEqual({ name: find(address).name, args: find(address).args }, { name: "pane.focus", args: { pane } });
  }
  assert.equal(terminals.filter(row => row.id === "terminal:t3").length, 1);
  assert.deepEqual({ name: find("worker").name, args: find("worker").args }, { name: "terminal.peek", args: { terminal: "worker" } });
  assert.equal(find("exited"), undefined);
  const notes = terminals.find(row => row.id === "notes");
  assert.deepEqual({ name: notes.name, args: notes.args, status: notes.status }, { name: "tab.select", args: { id: "notes" }, status: "mod" });
});

test("a shell entering and leaving an agent session updates both inventories without stale or fallback agents", () => {
  const data = inventory();
  data.agents = [];
  data.terminals = [{ address: "shell", state: "live", status: null }];
  data.panes = [{ pane: "shell-pane", terminal: "shell", tab: "work" }];
  assert.deepEqual(rows(data, "agents"), []);
  assert.equal(rows(data, "terminals").find(row => row.id === "terminal:shell").status, "none");

  data.agents = [{ address: "shell", tab: "work", status: "working", program: { name: "Agent", agent: true } }];
  data.terminals[0].status = "working";
  assert.equal(rows(data, "agents")[0].args.terminal, "shell");
  assert.equal(rows(data, "terminals").find(row => row.id === "terminal:shell").status, "working");

  data.terminals[0].state = "finished";
  assert.deepEqual(rows(data, "agents"), []);
  assert.equal(rows(data, "terminals").find(row => row.id === "terminal:shell"), undefined);
});

test("project directories follow their own live panes, with machine-qualified tabs and saved-folder fallback", () => {
  const data = {
    spaces: [
      { id: "home", name: "Home", folder: "/fork", tabs: [{ id: "tab", index: 1 }] },
      { id: "fork", name: "Fork", folder: "/maquila", tabs: [{ id: "fork-tab", index: 1 }] },
      { id: "remote/home", name: "Remote home", machine: "remote", folder: "/old", tabs: [{ id: "remote/tab", index: 1 }] },
      { id: "notes", name: "Notes", folder: "/notes", tabs: [{ id: "notes-tab", index: 1 }] },
      { id: "empty", name: "Empty", folder: "", tabs: [] },
    ],
    panes: [
      { tab: "remote/tab", terminal: "remote/t1", cwd: "/remote/home" },
      { tab: "fork-tab", terminal: "t2", cwd: "/fork" },
      { tab: "tab", terminal: "t1", cwd: null },
      { tab: "tab", terminal: "t3", cwd: "/home" },
      { tab: "tab", terminal: "t4", cwd: "/other-split" },
      { tab: "notes-tab", terminal: null, mod: "markdown" },
    ],
    agents: [], terminals: [], machines: [],
  };
  const projects = rows(data, "projects");
  assert.deepEqual(projects.map(row => [row.args.id, row.detail]), [
    ["home", "Local · 1 threads · /home"],
    ["fork", "Local · 1 threads · /fork"],
    ["remote/home", "remote · 1 threads · /remote/home"],
    ["notes", "Local · 1 threads · /notes"],
    ["empty", "Local · 0 threads · ~"],
  ]);
  assert(!projects[0].words.includes("/fork"));
  assert(projects[0].words.includes("/home"));
  data.panes[3].cwd = "/home/moved";
  assert.equal(rows(data, "projects")[0].detail, "Local · 1 threads · /home/moved");
});
