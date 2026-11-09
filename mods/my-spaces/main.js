// Project navigation with live threads.
// Retains local/remote machine groups, project menus, worktrees, and drag ordering.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, agents, terminals, setAgentOrder, nextCommand, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, keys } from "herdr";
import { buildThreads } from "./threads.js";
import { ThreadList } from "./threads-ui.js";
import { shortcutHint } from "./bindings.js";

const ICON_TINTS = { red: "ansi1", amber: "ansi3", green: "ansi2", teal: "ansi6", blue: "ansi4", purple: "ansi5" };

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 26 : 28);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

export default class Spaces extends View {
  init(_props, cx) {
    this.threadUI = new ThreadList();
    this.threads = [];
    this.foldedProjects = new Set(JSON.parse(localStorage.getItem("projects.folded") ?? "[]"));
    this.hoveredProject = null;
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "icons") {
          const space = spaces().find(s => s.active);
          if (space) openOverlay({ mod: "project-icons", kind: "dialog", width: 480, height: 520, props: { space: space.id } });
        } else if (command === "project-menu") {
          const space = spaces().find(s => s.active);
          if (space) this.menu(space);
        } else if (command === "review") {
          const current = this.threads.find(row => row.current);
          if (current) this.threadUI.review(current);
        } else if (command === "working" || command === "reviewed") {
          const space = spaces().find(s => s.active);
          if (space) {
            const key = `${space.id}:${command}`;
            this.threadUI.toggleShelf(key);
          }
        }
        cx.notify();
      }
    });
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    const active = spaces().find(s => s.active);
    this.activeSpace = active?.id;
    const savedScope = localStorage.getItem("spaces.scope");
    if (!["local", "remote"].includes(shared("spaces.scope"))) {
      setShared("spaces.scope", savedScope === "local" || savedScope === "remote" ? savedScope : active?.machine ? "remote" : "local");
    }
    localStorage.removeItem("spaces.scope");
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "project-menu", kind: "popup", width: 230, height: 300, props: { tab: "space", target: { id: w.id } } });
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null })).filter((r) => this.shown.has(r.w.id));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    return out;
  }

  // Local spaces stand alone; remote spaces keep their machine headers.
  grouped(t) {
    const rows = this.ordered();
    const draw = r => v_flex().flex_none().child(this.row(r, t))
      .when(!this.foldedProjects.has(r.w.id), el => el.child(this.threadUI.project(r.w, this.threads, t)));
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child("Loading…");
    if (this.scope === "local") {
      const local = rows.filter(r => !r.w.machine);
      return local.length ? local.map(draw) : [loading(null) ? loadingRow(null)
        : div().px(8).py(12).text_size(12).text_color(t.dim).child("No local spaces yet.")];
    }
    if (!remote.length) return [div().px(8).py(12).text_size(12).text_color(t.dim)
      .whitespace_normal().child("No remote machines connected.")];
    const machineNames = remote;
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(8).gap(7).items_center().text_size(11).text_color(t.dim)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .role("button").accessibility_label(`${folded ? "Expand" : "Collapse"} ${m ?? "This computer"}${connected ? "" : `. ${machine?.state ?? "asleep"}${machine?.why ? `. ${machine.why}` : ""}`}`)
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none())
        .child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .role("button").accessibility_label(`${repair?.busy ? "Connecting to" : "Connect to"} ${m}. ${repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one."}`)
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .role("button").accessibility_label(`New space on ${m ?? "this computer"}`)
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none());
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .role("button").accessibility_label(`New space on ${m ?? "this computer"}`)
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).child("New space there");
      if (rebuilt) return [head];
      return [head, ...(folded ? [] : mine.length ? mine.map(draw) : [loading(m) ? loadingRow(m) : empty])];
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  projectIcon(space, t) {
    const folded = this.foldedProjects.has(space.id);
    const reveal = this.hoveredProject === space.id;
    const icon = (shared("space.icons") ?? {})[space.id];
    const glyph = icon?.kind === "custom"
      ? image(icon.path).size(18)
      : svg(`mods/project-icons/icons/${icon?.name ?? "folder-01"}.svg`).size(16)
        .text_color(t[ICON_TINTS[icon?.color]] ?? t.muted);
    return div().id(`project-fold-${space.id}`).relative().size(18).flex_none().rounded(5)
      .cursor_pointer().role("button").accessibility_label(`${folded ? "Expand" : "Collapse"} threads in ${space.name}`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_up("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        folded ? this.foldedProjects.delete(space.id) : this.foldedProjects.add(space.id);
        localStorage.setItem("projects.folded", JSON.stringify([...this.foldedProjects]));
        cx.notify();
      })
      .child(h_flex().id(`project-avatar-${space.id}`).absolute().size_full().rounded(5)
        .items_center().justify_center().text_color(t.muted)
        .opacity(reveal ? 0 : 1).transition("opacity", { duration: 140, easing: "ease-in-out" })
        .child(glyph))
      .child(h_flex().id(`project-chevron-${space.id}`).absolute().size_full().items_center().justify_center()
        .text_color(t.muted).hover(style => style.text_color(t.foreground))
        .opacity(reveal ? 1 : 0).transition("opacity", { duration: 140, easing: "ease-in-out" })
        .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(13)));
  }

  row({ w, i, g, tree }, t) {
    const on = w.active;
    const attentionCount = this.threads.filter(row => row.space.id === w.id && row.needsAttention).length;
    const hint = Number.isInteger(w.index) && w.index >= 1 && w.index <= 9
      ? shortcutHint({ name: "space.select", args: { index: w.index } }, keys(), shared("layout"), window()?.platform) : null;
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .pl(6).pr(5)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .role("button").accessibility_label(w.name)
      .when(this.pressed === i && this.over !== i, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === i && this.pressed !== i, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(this.pressed < i, line => line.bottom(0))
          .when(this.pressed > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = i;
        this.over = i;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces()[this.pressed];
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? i : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === i && from !== i) run("space.move", { id: spaces()[from].id, index: i + 1 });
        else if (from === i) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .on_hover((hovered, cx) => {
        if (hovered) this.hoveredProject = w.id;
        else if (this.hoveredProject === w.id) this.hoveredProject = null;
        cx.notify();
      })
      .child(
        h_flex()
          .gap(7)
          .items_center()
          .when(Boolean(tree), el => el.pl(22))
          .child(this.projectIcon(w, t))
          .child(div().flex_shrink(1).min_w(0).max_w(150).truncate().text_color(on ? t.foreground : t.muted)
            .when(Boolean(hint), el => el.tooltip(hint)).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1())
          .when(attentionCount > 0, el => el.child(div().flex_none().text_size(10).text_color(t.blocked)
            .accessibility_label(`${attentionCount} threads needing attention`).child(String(attentionCount))))
          .child(this.threadUI.tool(`thread-new-${w.id}`, `New thread in ${w.name}`, "plus", () => {
            run("space.select", { id: w.id });
            openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 });
          }, t))
      );
  }

  get scope() {
    return shared("spaces.scope") === "remote" ? "remote" : "local";
  }

  render() {
    const t = theme();
    const sp = spaces();
    const active = sp.find(s => s.active);
    const newSpaceHint = active && !active.machine ? shortcutHint({ name: "space.new", args: {} }, keys(), shared("layout"), window()?.platform) : null;
    const liveAgents = agents();
    this.threads = buildThreads({ spaces: sp, agents: liveAgents, terminals: terminals(), panes: panes(), machines: machines() });
    const listed = new Set(liveAgents.map(a => a.address));
    setAgentOrder(this.threadUI.order(this.threads).filter(row => row.available).flatMap(row => [
      ...(row.primary ? [row.primary.address] : []),
      ...row.agents.filter(a => a.address !== row.primary?.address).map(a => a.address),
      ...row.descendants.filter(child => listed.has(child.address)).map(child => child.address),
    ]));
    if (active?.id !== this.activeSpace) {
      this.activeSpace = active?.id;
      setShared("spaces.scope", active?.machine ? "remote" : "local");
      if (active?.machine && this.folded.delete(active.machine)) localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
      this.pressed = this.over = null;
    }
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .child("Projects")
        .when(this.scope === "local", el => el.child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .role("button").accessibility_label("New local space")
          .when(Boolean(newSpaceHint), el => el.tooltip(newSpaceHint))
          .on_click(() => run("space.new", { machine: "" })).child(svg("mods/workspace-chrome/plus.svg").size(14)))))
      .child(v_flex().flex_1().min_h(0).px(8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(this.grouped(t)));
  }
}
