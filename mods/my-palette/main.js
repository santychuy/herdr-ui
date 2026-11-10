// Agent-first switcher with live threads, projects, and the command palette.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { commands, layouts, keys, run, theme, props, closeOverlay, openOverlay, shared, window as win, spaces, agents, terminals, panes, machines, nextCommand } from "herdr";
import { commandKey, shortcutLabel } from "./bindings.js";
import { navigation, STATUS, FILTERS, SORTS, SORT_LABEL } from "./navigation.js";

// The list keeps one height while you move: rows and group titles have fixed
// heights, and the window shows as many as fit in LIST_H.
// Keep room for the view tabs, filters, and keyboard footer.
const SHOWN = 7;
const ROW_H = 44;
const HEAD_H = 26;
const LIST_H = SHOWN * ROW_H;
const GROUPS = ["Recent", "Tab", "Pane", "Space", "Layout", "Terminal", "Agent", "Window", "App"];
const VIEWS = [["agents", "Agents"], ["terminals", "Terminals"], ["projects", "Projects"], ["commands", "Commands & keys"]];
const NEXT_VIEW = "herdr_palette_next_view";
const NEXT_FILTER = "herdr_palette_next_filter";

// The palette's names for commands: [command, args, group, title, keywords].
const NAMED = [
  ["tab.new", {}, "Tab", "New tab", "tab agent new task"],
  ["tab.rename", {}, "Tab", "Rename tab", "tab"],
  ["tab.close", {}, "Tab", "Close tab", "tab kill"],
  ["tab.next", {}, "Tab", "Next tab", "tab"],
  ["tab.prev", {}, "Tab", "Previous tab", "tab"],
  ["pane.split", { direction: "right" }, "Pane", "Split right", "vertical"],
  ["pane.split", { direction: "down" }, "Pane", "Split down", "horizontal"],
  ["pane.close", {}, "Pane", "Close pane", "kill"],
  ["pane.zoom", {}, "Pane", "Zoom pane", "maximize fullscreen"],
  ...["left", "right", "up", "down"].map((d) => ["pane.go", { direction: d }, "Pane", `Focus pane ${d}`, "move go"]),
  ...["left", "right", "up", "down"].map((d) => ["pane.swap", { direction: d }, "Pane", `Swap pane ${d}`, "move"]),
  ["space.new", {}, "Space", "New space", "workspace"],
  ["space.rename", {}, "Space", "Rename space", "workspace"],
  ["space.close", {}, "Space", "Close space", "workspace kill"],
  ["space.next", {}, "Space", "Next space", "workspace"],
  ["space.prev", {}, "Space", "Previous space", "workspace"],
  ["layout.switch", {}, "Layout", "Next layout", "look switch"],
  ["layout.reset", {}, "Layout", "Reset layout", "new version default restore herdr's"],
  ["layout.clone", {}, "Layout", "Duplicate layout", "clone copy customize"],
  ["mod.clone", {}, "Layout", "Duplicate mod", "clone copy customize"],
  ["terminal.open", {}, "Terminal", "New terminal", "shell"],
  ["terminal.copy", {}, "Terminal", "Copy", "clipboard"],
  ["terminal.paste", {}, "Terminal", "Paste", "clipboard"],
  ["agent.next", {}, "Agent", "Next agent", ""],
  ["agent.prev", {}, "Agent", "Previous agent", ""],
  ["window.minimize", {}, "Window", "Minimize window", ""],
  ["window.maximize", {}, "Window", "Maximize window", "restore"],
  ["window.close", {}, "Window", "Close window", "quit"],
  ["app.settings", {}, "App", "Settings", "preferences options config look font theme sound"],
  ["app.help", {}, "App", "Keys", "keybindings shortcuts help"],
  ["app.welcome", {}, "App", "Welcome", "intro start onboarding"],
  ["app.whats_new", {}, "App", "What's new", "release changes news update"],
  ["app.reset", {}, "App", "Reset to the default screen", "escape hatch broken restore"],
  ["app.zoom_in", {}, "App", "Zoom in", "bigger font size"],
  ["app.zoom_out", {}, "App", "Zoom out", "smaller font size"],
  ["app.zoom_reset", {}, "App", "Reset zoom", "font size"],
  ["app.quit", {}, "App", "Quit Herdr", "exit"],
  ...["graphite", "ink", "moss", "atom-one-dark"].map((n) => ["app.theme", { name: n }, "App", `Theme: ${n.replace(/-/g, " ")}`, "colors look"]),
];

// Commands that act on something you point at (ids, terminals): not for a list.
const HIDDEN = new Set([
  "space.move", "tab.move", "space.select", "tab.select", "pane.focus", "terminal.keep",
  "terminal.park", "terminal.kill", "terminal.show", "agent.focus", "layout.set", "layout.toggle",
  "layout.show", "layout.hide", "layout.resize", "layout.select", "mod.open", "overlay.close",
  "tab.settle", "tab.unsettle",
  "app.palette", "app.hide", "app.hide_others", "app.show_all", "app.theme", "app.settings",
]);

function titleOf(name) {
  const [noun, verb] = name.split(".");
  return { group: noun.charAt(0).toUpperCase() + noun.slice(1), title: `${verb.replace(/_/g, " ")} ${noun}`.replace(/^./, (c) => c.toUpperCase()) };
}

// Every entry for the state we're in now.
function entries() {
  const known = new Set(commands().map(c => c.name));
  const mac = win()?.platform === "macos";
  const list = NAMED.filter(([n]) => known.has(n))
    .filter(([n]) => !(mac && n.startsWith("window.")))
    .map(([name, args, group, title, words]) => ({ name, args, group, title, words }));
  for (const l of layouts()) {
    const t = { main: "Herdr", terminals: "Terminals", win98: "Herdr 98" }[l] ?? l.charAt(0).toUpperCase() + l.slice(1);
    list.push({ name: "layout.switch", args: { name: l }, group: "Layout", title: `Layout: ${t}`, words: `look ${l}` });
  }
  // Anything new in the app shows up too, until it gets a better name here.
  const named = new Set(NAMED.map(([n]) => n));
  for (const c of commands()) {
    if (named.has(c.name) || HIDDEN.has(c.name) || c.args.some((a) => a.required && a.name !== "name")) continue;
    list.push({ name: c.name, args: {}, ...titleOf(c.name), words: c.about });
  }
  return list.map((e) => ({ ...e, id: `${e.name}:${JSON.stringify(e.args)}` }));
}

// "ctrl-shift-p" -> ["ctrl", "shift", "p"]; "ctrl--" -> ["ctrl", "-"].
function keyParts(k) {
  return k.endsWith("--") ? [...k.slice(0, -2).split("-"), "-"] : k.split("-");
}

// Fuzzy score of `q` in `text`, with the matched positions; null: no match.
function fuzzy(q, text) {
  const t = text.toLowerCase();
  let score = 0;
  let at = 0;
  let run = 0;
  const hits = [];
  for (const ch of q) {
    const i = t.indexOf(ch, at);
    if (i < 0) return null;
    const start = i === 0 || /[\s:.\-_/]/.test(t[i - 1]);
    run = i === at && hits.length ? run + 1 : 0;
    score += 1 + (start ? 6 : 0) + run * 3 - Math.min(i - at, 6) * 0.3;
    hits.push(i);
    at = i + 1;
  }
  // Prefer literal names/prefixes over scattered initials; queries omit spaces.
  const compact = t.replace(/\s+/g, "");
  score += compact === q ? 24 : compact.startsWith(q) ? 12 : compact.includes(q) ? 6 : 0;
  return { score: score - text.length * 0.02, hits };
}

export default class Palette extends View {
  init(_props, cx) {
    this.query = "";
    this.view = "agents";
    this.filter = "all";
    this.sort = localStorage.getItem("navigation.sort") ?? "attention";
    if (!SORTS.includes(this.sort)) this.sort = "attention";
    this.input = InputState.new({ placeholder: "Search agents, terminals, tabs, projects…" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", () => this.go(this.rows()[this.at]?.e));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.at = 0;
    // How far the list is scrolled, px.
    this.scroll = 0;
    this.recent = JSON.parse(localStorage.getItem("recent") ?? "[]");
    this.handle = cx.focus_handle();
    // Native Input/Root Tab actions run before bubbling raw key events.
    // Bind at Input depth too, so its built-in editing actions cannot win.
    if (!sessionStorage.getItem("my-palette.tab-actions")) {
      cx.bind_keys(["HerdrPalette", "HerdrPalette > Input"].flatMap(context => [
        { keystroke: "tab", action: NEXT_VIEW, context },
        { keystroke: "shift-tab", action: NEXT_FILTER, context },
      ]));
      sessionStorage.setItem("my-palette.tab-actions", "1");
    }
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "next-view" || command === "next-filter") {
          window.dispatch_action(command === "next-view" ? NEXT_VIEW : NEXT_FILTER);
        } else if (VIEWS.some(([view]) => view === command)) this.setView(command);
        else if (["agents", "terminals"].includes(this.view) && command.startsWith("filter-") && FILTERS.includes(command.slice(7))) this.filter = command.slice(7);
        else if (["agents", "terminals"].includes(this.view) && command.startsWith("sort-") && SORTS.includes(command.slice(5))) {
          this.sort = command.slice(5);
          localStorage.setItem("navigation.sort", this.sort);
        } else if (command.startsWith("search:")) {
          this.query = command.slice(7);
          this.input.set_value(this.query);
        } else if (command === "open-selected") this.go(this.rows()[this.at]?.e);
        this.at = 0;
        this.scroll = 0;
        cx.notify();
      }
    });
  }

  setView(view) {
    this.view = view;
    this.filter = "all";
    this.at = 0;
    this.scroll = 0;
    this.input.focus();
  }

  close() {
    closeOverlay(props().overlay);
  }

  go(e) {
    if (!e) return;
    if (e.available === false) return;
    this.recent = [e.id, ...this.recent.filter((r) => r !== e.id)].slice(0, 20);
    localStorage.setItem("recent", JSON.stringify(this.recent));
    this.close();
    if (e.name === "mod.clone") {
      openOverlay({ mod: "prompt", kind: "dialog", width: 380, props: {
        title: "Duplicate mod", hint: "Mod to copy; creates <name>-copy",
        command: { name: "mod.clone", args: {} },
      } });
    } else {
      run(e.name, e.name === "layout.clone" ? { name: shared("layout") ?? "main" } : e.args);
    }
  }

  // The rows to show: grouped when empty, ranked while typing.
  rows() {
    if (this.view !== "commands") {
      const rows = navigation({ spaces: spaces(), agents: agents(), terminals: terminals(), panes: panes(), machines: machines() }, this.view, this.filter, this.sort);
      const q = this.query.trim().toLowerCase().replace(/\s+/g, "");
      if (!q) return rows.map(e => ({ e }));
      return rows.map(e => {
        const title = fuzzy(q, e.title);
        const more = fuzzy(q, `${e.title} ${e.detail} ${e.words} ${STATUS[e.status] ?? e.status ?? ""}`);
        const best = title ?? (more && { score: more.score - 4, hits: [] });
        return best && { e, score: best.score, hits: best.hits };
      }).filter(Boolean).sort((a, b) => b.score - a.score);
    }
    const all = entries();
    const q = this.query.trim().toLowerCase().replace(/\s+/g, "");
    if (!q) {
      const recent = this.recent.map((id) => all.find((e) => e.id === id)).filter(Boolean).slice(0, 5);
      const rest = GROUPS.slice(1).flatMap((g) => all.filter((e) => e.group === g && !recent.includes(e)));
      const others = all.filter((e) => !GROUPS.includes(e.group) && !recent.includes(e));
      return [...recent.map((e) => ({ e, head: "Recent" })), ...[...rest, ...others].map((e) => ({ e, head: e.group }))];
    }
    const rank = (e) => this.recent.indexOf(e.id);
    return all
      .map((e) => {
        const title = fuzzy(q, e.title);
        const more = fuzzy(q, `${e.group} ${e.title} ${e.name} ${e.words}`);
        const best = title ?? (more && { score: more.score - 4, hits: [] });
        return best && { e, score: best.score, hits: best.hits };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || (rank(a.e) < 0 ? 99 : rank(a.e)) - (rank(b.e) < 0 ? 99 : rank(b.e)));
  }

  title(t, text, hits, on) {
    if (!hits?.length) return div().text_color(on ? t.foreground : t.muted).child(text);
    const parts = [];
    let cur = "";
    let lit = false;
    [...text].forEach((ch, i) => {
      const h = hits.includes(i);
      if (h !== lit && cur) {
        parts.push([cur, lit]);
        cur = "";
      }
      lit = h;
      cur += ch;
    });
    if (cur) parts.push([cur, lit]);
    return h_flex().children(parts.map(([s, h]) => div().text_color(h ? t.accent : on ? t.foreground : t.muted).when(h, (d) => d.font_semibold()).child(s.replace(/ /g, "\u00a0"))));
  }

  render() {
    const t = theme();
    const rows = this.rows();
    const bound = keys();
    const platform = win()?.platform ?? "macos";
    const statusView = this.view === "agents" || this.view === "terminals";
    this.at = Math.max(0, Math.min(this.at, rows.length - 1));
    // One continuous strip: each row (and the group title before it) at a
    // fixed y. Scrolling moves the strip in pixels, only as far as it takes to
    // keep the selected row (and its group's title, if it opens one) in view.
    const tops = [];
    let y = 0;
    rows.forEach((r, i) => {
      const head = this.view === "commands" && !this.query && (i === 0 || r.head !== rows[i - 1].head);
      tops.push({ head, title: y, row: y + (head ? HEAD_H : 0) });
      y += (head ? HEAD_H : 0) + ROW_H;
    });
    const total = y;
    const fixed = total > LIST_H;
    this.maxScroll = Math.max(0, total - LIST_H);
    const sel = tops[this.at];
    if (sel) {
      const from = sel.head ? sel.title : sel.row;
      if (from < this.scroll) this.scroll = from;
      if (sel.row + ROW_H > this.scroll + LIST_H) this.scroll = sel.row + ROW_H - LIST_H;
    }
    this.scroll = Math.max(0, Math.min(this.scroll, this.maxScroll));
    const key = (k) =>
      h_flex().gap(3).children(keyParts(k).map((p) => div().px(5).rounded(4).border_1().border_color(t.border).bg(t.raised).text_size(11).text_color(t.dim).child(p)));
    // In a scrolling list each item is placed at its edges from the model
    // above, not stacked: GPUI rounds every height to whole pixels, and a
    // stack of rounded heights drifts away from the model (19 px at zoom 1.3
    // by row 40, cutting the selection off). Edges from the model can't add up.
    const place = (el, start, end) =>
      fixed
        ? el.absolute().left(0).right(0).top(start - this.scroll).bottom(LIST_H - (end - this.scroll))
        : el.flex_none().h(end - start);
    const visible = (start, end) => !fixed || (end > this.scroll && start < this.scroll + LIST_H);
    const list = [];
    rows.forEach((r, i) => {
      const { head, title, row } = tops[i];
      if (head && visible(title, row)) list.push(place(h_flex(), title, row).px(14).pb(4).items_end().text_size(11).font_semibold().text_color(t.dim).child(r.head));
      if (!visible(row, row + ROW_H)) return;
      const on = i === this.at;
      const k = this.view === "commands" ? commandKey(r.e, bound, shared("layout")) : null;
      list.push(
        place(h_flex(), row, row + ROW_H)
          .id(`pl-${i}`)
          .mx(6)
          .px(10)
          .gap(10)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .text_size(12.8)
          .when(on, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.go(r.e))
          .role("button")
          .accessibility_label(`${r.e.title}. ${r.e.detail ?? r.e.group}.${statusView ? ` ${STATUS[r.e.status] ?? ""}` : ""}${r.e.available === false ? " Machine is unavailable; this item cannot be opened." : ""}`)
          .when(Boolean(k), el => el.tooltip(shortcutLabel(k, platform)))
          .when(statusView, el => el.child(div().w(18).flex_none()
            .accessibility_label(r.e.program?.name ?? r.e.group)
            .when(Boolean(r.e.program?.icon), slot => slot.child(r.e.program.tint
              ? svg(r.e.program.icon).size(16).text_color(on ? t.foreground : t.muted)
              : image(r.e.program.icon).size(16)))))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().truncate().child(this.title(t, r.e.title, r.hits, on)))
            .when(Boolean(r.e.detail), el => el.child(div().truncate().text_size(10.5).text_color(t.dim).child(r.e.detail))))
          .when(statusView, el => el.child(div().flex_none().text_size(11)
            .text_color(t[r.e.status] ?? (r.e.status === "done" ? t.ansi2 : t.dim))
            .child(r.e.reviewed ? "Reviewed" : STATUS[r.e.status] ?? r.e.status)))
          .when(this.view === "commands" && Boolean(this.query), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(r.e.group)))
          .when(Boolean(k), (el) => el.child(key(k))),
      );
    });
    return v_flex()
      .id("palette")
      .track_focus(this.handle)
      .key_context("HerdrPalette")
      .on_action(NEXT_VIEW, (_e, cx) => {
        const index = VIEWS.findIndex(([view]) => view === this.view);
        this.setView(VIEWS[(index + 1) % VIEWS.length][0]);
        cx.stop_propagation(); cx.notify();
      })
      .on_action(NEXT_FILTER, (_e, cx) => {
        if (statusView) {
          this.filter = FILTERS[(FILTERS.indexOf(this.filter) + 1) % FILTERS.length];
          this.at = 0; this.scroll = 0;
        }
        this.input.focus();
        cx.stop_propagation(); cx.notify();
      })
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        // Stops at the ends: wrapping jumps out of sight.
        if (k === "down") this.at = Math.min(this.at + 1, rows.length - 1);
        else if (k === "up") this.at = Math.max(this.at - 1, 0);
        else if (k === "pagedown") this.at = Math.min(this.at + SHOWN, rows.length - 1);
        else if (k === "pageup") this.at = Math.max(this.at - SHOWN, 0);
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().gap(6).tooltip(shortcutLabel("tab", platform)).children(VIEWS.map(([view, label]) =>
        div().id(`palette-view-${view}`).px(10).py(6).rounded(6).text_size(12).cursor_pointer()
          .bg(this.view === view ? t.selected : t.popover).text_color(this.view === view ? t.foreground : t.dim)
          .role("button").accessibility_label(label).on_click((_e, cx) => {
            this.setView(view); cx.notify();
          }).child(label))))
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(10)
          .gap(10)
          .items_center()
          .rounded(9)
          .border_1()
          .border_color(t.accent)
          .bg(t.background)
          .child(svg("mods/my-palette/command.svg").size(16).text_color(t.dim))
          .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground))
          .child(div().text_size(11).text_color(t.dim).child("Esc")),
      )
      .when(statusView, el => el.child(h_flex().gap(5).items_center()
        .child(h_flex().gap(5).tooltip(shortcutLabel("shift-tab", platform)).children(FILTERS.map(filter => div().id(`palette-filter-${filter}`).px(7).py(4).rounded(5).text_size(10.5).cursor_pointer()
          .text_color(this.filter === filter ? t.foreground : t.dim).bg(this.filter === filter ? t.selected : t.popover)
          .role("button").accessibility_label(`Filter ${filter}`).on_click((_e, cx) => {
            this.filter = filter; this.at = 0; this.scroll = 0; this.input.focus(); cx.notify();
          }).child(filter === "attention" ? "Needs attention" : filter.charAt(0).toUpperCase() + filter.slice(1)))))
        .child(div().flex_1())
        .child(div().id("palette-sort").px(7).py(4).rounded(5).text_size(10.5).text_color(t.dim).cursor_pointer()
          .role("button").accessibility_label(`Sort: ${SORT_LABEL[this.sort]}. Cycle attention, recent activity, project, and name.`)
          .on_click((_e, cx) => {
            this.sort = SORTS[(SORTS.indexOf(this.sort) + 1) % SORTS.length];
            localStorage.setItem("navigation.sort", this.sort); this.at = 0; this.scroll = 0; this.input.focus(); cx.notify();
          }).child(`${SORT_LABEL[this.sort]} ↓`))))
      .child(
        rows.length
          ? div()
              .id("palette-rows")
              .relative()
              .mb(6)
              .when(fixed, (el) => el.h(LIST_H).overflow_hidden())
              .on_scroll_wheel((e, cx) => {
                // Wheels report lines, touchpads pixels.
                const d = Math.abs(e.delta.y) < 4 ? e.delta.y * ROW_H : e.delta.y;
                this.scroll = Math.max(0, Math.min(this.scroll - d, this.maxScroll));
                // The selection stays on screen, so the next frame doesn't scroll back to it.
                while (this.at < rows.length - 1 && tops[this.at].row < this.scroll) this.at++;
                while (this.at > 0 && tops[this.at].row + ROW_H > this.scroll + LIST_H) this.at--;
                cx.notify();
              })
              .children(fixed ? list : [v_flex().children(list)])
          : div().px(16).py(14).text_size(13).text_color(t.dim).child(this.query ? `Nothing matches "${this.query}".`
              : this.view === "projects" ? "No projects available." : this.view === "agents" ? "No live agents match this filter." : "No items match this status filter."),
      )
      .child(h_flex().pt(6).gap(8).text_size(10.5).text_color(t.dim)
        .child(div().flex_1().child(`↑↓ Navigate   Enter Open   Tab View${statusView ? "   Shift+Tab Filter" : ""}   Esc Close`))
        .child(`${rows.length} ${this.view === "commands" ? (rows.length === 1 ? "command" : "commands") : (rows.length === 1 ? "result" : "results")}`));
  }
}
