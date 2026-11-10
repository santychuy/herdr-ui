import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

// Only the native host is replaced; search, thread aggregation, selection,
// and submission run through the real palette and navigation implementations.
const host = {
  calls: [],
  data: {},
  input: {
    handlers: {}, value: () => host.query, focus() {},
    on(event, handler) { this.handlers[event] = handler; },
  },
};
globalThis.paletteTestHost = host;
const native = `
  const host = globalThis.paletteTestHost;
  export class View {}
  export const div = () => {}, svg = div, image = div, v_flex = div, h_flex = div, Input = {};
  export const InputState = { new: () => host.input };
  export const spaces = () => host.data.spaces, agents = () => host.data.agents,
    terminals = () => host.data.terminals, panes = () => host.data.panes,
    machines = () => host.data.machines;
  export const commands = () => [], layouts = commands, keys = commands,
    theme = commands, window = commands, shared = commands, openOverlay = commands;
  export const props = () => ({ overlay: "test" }), closeOverlay = () => {},
    run = (name, args) => host.calls.push({ name, args });
  export const nextCommand = () => new Promise(() => {});
`;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return ["gpui-kit", "gpui-base", "herdr"].includes(specifier)
      ? { url: `data:text/javascript,${encodeURIComponent(native)}`, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
const { default: Palette } = await import("./main.js");
hooks.deregister();

function setup() {
  const titles = ["Check logs and compile code", "Claude Code", "Claude Code"];
  host.data = {
    spaces: [{ id: "project", name: "Project", folder: "/project", tabs: titles.map((name, i) => ({ id: `tab${i}`, index: i + 1, name, named: true })) }],
    agents: titles.map((title, i) => ({ address: `t${i}`, tab: `tab${i}`, title, status: i === 0 ? "blocked" : "idle", program: { name: "Claude Code", agent: true } })),
    terminals: titles.map((_, i) => ({ address: `t${i}`, state: "live" })),
    panes: titles.map((_, i) => ({ pane: `p${i}`, tab: `tab${i}`, terminal: `t${i}` })),
    machines: [{ name: null, layout: "ready" }],
  };
  host.calls = [];
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.sessionStorage = { getItem: () => "1" };
  const palette = new Palette();
  palette.init({}, { timer: { after() {} }, focus_handle() {}, spawn() {} });
  return palette;
}

test("typing ranks the strongest agent match first and Enter opens it without arrow navigation", () => {
  const palette = setup();
  assert.equal(palette.rows()[0].e.args.terminal, "t0");
  palette.at = 2;
  for (const query of ["cl", "claude", "Claude Code"]) {
    host.query = query;
    host.input.handlers.change({}, { notify() {} });
    assert.equal(palette.rows()[0].e.args.terminal, "t1", query);
    assert.equal(palette.at, 0);
  }
  host.input.handlers.submit();
  assert.deepEqual(host.calls, [{ name: "agent.focus", args: { terminal: "t1" } }]);
  host.query = "   ";
  host.input.handlers.change({}, { notify() {} });
  assert.equal(palette.rows()[0].e.args.terminal, "t0");
});

test("equal search scores retain the selected ordering and status filters still apply", () => {
  const palette = setup();
  palette.query = "claude code";
  assert.deepEqual(palette.rows().slice(0, 2).map(row => row.e.args.terminal), ["t1", "t2"]);
  palette.filter = "attention";
  assert.deepEqual(palette.rows().map(row => row.e.args.terminal), ["t0"]);
});
