import test from "node:test";
import assert from "node:assert/strict";
import { commandKey, shortcutLabel } from "./bindings.js";

const bound = [
  { section: "global", keys: "cmd-t", action: "tab.new" },
  { section: "global", keys: "cmd-n", action: "space.new" },
  { section: "global", keys: "cmd-w", action: "tab.close" },
  { section: "global", keys: "cmd-shift-w", action: "pane.close" },
  { section: "global", keys: "cmd-/", action: "app.help" },
  { section: "global", keys: "cmd-shift-/", action: "app.help" },
  { section: "global", keys: "cmd-d", action: "pane.split:right" },
  { section: "global", keys: "cmd-q", action: "app.quit" },
  { section: "global", keys: "cmd-]", action: "agent.next" },
  { section: "global", keys: "cmd-alt-h", action: "app.hide_others" },
  { section: "layout:my-main", keys: "cmd-n", action: "tab.new" },
  { section: "layout:my-main", keys: "cmd-shift-s", action: "space.new" },
  { section: "layout:my-main", keys: "cmd-w", action: "pane.close" },
  { section: "layout:my-main", keys: "cmd-shift-w", action: "tab.close" },
  { section: "layout:my-main", keys: "cmd-/", action: "pane.split:right" },
  { section: "layout:my-main", keys: "cmd-]", action: "tab.next" },
  { section: "layout:my-main", keys: "cmd-alt-h", action: "pane.go:left" },
];
const key = (name, args = {}, layout = "my-main") => commandKey({ name, args }, bound, layout);

test("prefers the active layout's shortcuts over valid global aliases", () => {
  assert.equal(key("tab.new"), "cmd-n");
  assert.equal(key("space.new"), "cmd-shift-s");
  assert.equal(key("tab.close"), "cmd-shift-w");
  assert.equal(key("pane.close"), "cmd-w");
  assert.equal(key("pane.split", { direction: "right" }), "cmd-/");
});

test("never displays a global shortcut reassigned to another action", () => {
  assert.equal(key("agent.next"), null);
  assert.equal(key("app.hide_others"), null);
  assert.equal(key("app.help"), "cmd-shift-/");
});

test("keeps effective global shortcuts and ignores unrelated sections", () => {
  assert.equal(key("app.quit"), "cmd-q");
  assert.equal(key("tab.new", {}, "main"), "cmd-t");
  assert.equal(key("space.new", {}, "main"), "cmd-n");
  assert.equal(key("pane.split", { direction: "down" }), null);
  assert.equal(key("missing.command"), null);
});

test("shortcut hints format modifiers and punctuation without descriptive text", () => {
  for (const [key, platform, label] of [
    ["cmd-b", "macos", "⌘B"],
    ["cmd-,", "macos", "⌘,"],
    ["cmd-shift-enter", "macos", "⌘⇧Enter"],
    ["cmd--", "macos", "⌘-"],
    ["ctrl-1", "macos", "⌃1"],
    ["shift-tab", "macos", "⇧Tab"],
    ["ctrl-shift-enter", "linux", "Ctrl+Shift+Enter"],
    ["cmd-b", "windows", "Win+B"],
  ]) assert.equal(shortcutLabel(key, platform), label);
  assert.equal(shortcutLabel(null), null);
});
