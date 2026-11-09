import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { run, openOverlay } from "herdr";

const LABEL = { blocked: "Needs you", done: "Unread reply", working: "Working", idle: "Idle", none: "Terminal", unavailable: "Unavailable" };
const color = (row, t) => row.status === "blocked" ? t.blocked : row.status === "done" ? t.ansi2 : row.status === "working" ? t.working : t.dim;

export class ThreadList {
  constructor() {
    this.expanded = new Set(JSON.parse(localStorage.getItem("threads.expanded") ?? "[]"));
    this.details = new Set();
  }

  focus(row) {
    if (!row.available) return;
    if (row.primary) run("agent.focus", { terminal: row.primary.address });
    else { run("space.select", { id: row.space.id }); run("tab.select", { id: row.id }); }
  }

  review(row) {
    if (!row.available || row.busy) return;
    run(row.reviewed ? "tab.unsettle" : "tab.settle", { id: row.id });
  }

  tool(id, label, icon, action, t) {
    return div().id(id).size(20).flex_none().flex().items_center().justify_center().rounded(4)
      .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).role("button")
      .accessibility_label(label)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(svg(`mods/workspace-chrome/${icon}.svg`).size(12));
  }

  row(row, t) {
    const selected = row.current;
    const pic = row.program?.icon;
    const over = this.hovered === row.id;
    const status = row.reviewed ? "Reviewed" : LABEL[row.status];
    return v_flex().id(`thread-wrap-${row.id}`).flex_none()
      .child(h_flex().id(`thread-${row.id}`).min_h(28).pl(6).pr(5).py(2).gap(6).items_center()
        .role("button").accessibility_label(`${row.title}. ${status}${row.available ? "" : ": machine is offline or still loading"}. ${row.space.name} on ${row.space.machine ?? "this computer"}`)
        .on_hover((on, cx) => { this.hovered = on ? row.id : null; cx.notify(); })
        .on_click(() => this.focus(row))
        .on_mouse_down("right", () => openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: row.id, space: row.space.id } } }))
        .child(pic ? (row.program.tint ? svg(pic).size(13).flex_none().text_color(t.muted) : image(pic).size(13).flex_none())
          : div().w(13).flex_none().text_color(t.dim).child("›"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(selected ? t.foreground : t.muted).child(row.title))
        .when(row.pinned && !over, el => el.child(svg("mods/workspace-chrome/pin.svg").size(11).flex_none().text_color(t.dim)))
        .when(row.primary && row.available && over, el => el.child(this.tool(`thread-pin-${row.id}`, row.pinned ? "Unpin thread" : "Pin thread", row.pinned ? "pin-off" : "pin", () => {
          if (row.pinned) [...row.agents.filter(a => a.pinned), ...row.descendants.filter(child => child.labels?.["herdr.pinned"])].forEach(a => run("terminal.pin", { terminal: a.address, pinned: false }));
          else run("terminal.pin", { terminal: row.primary.address, pinned: true });
        }, t)))
        .when(row.available && !row.busy && over, el => el.child(this.tool(`thread-review-${row.id}`, row.reviewed ? "Bring back thread" : "Mark reviewed", row.reviewed ? "chevron-left" : "check", () => this.review(row), t)))
        .when(row.descendants.length > 0, el => el.child(div().id(`thread-children-${row.id}`).px(3).text_size(10).text_color(t.dim)
          .role("button").accessibility_label(`${this.details.has(row.id) ? "Hide" : "Show"} ${row.descendants.length} subagents`)
          .on_click((_e, cx) => { cx.stop_propagation(); this.details.has(row.id) ? this.details.delete(row.id) : this.details.add(row.id); cx.notify(); })
          .child(String(row.descendants.length))))
        .child(div().id(`thread-status-${row.id}`).size(20).flex_none().flex().items_center().justify_center()
          .child(row.status === "working" ? svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900)
            : div().size(6).flex_none().rounded_full().bg(row.needsAttention ? color(row, t) : t.border))))
      .when(this.details.has(row.id), el => el.children(row.descendants.map(child => h_flex().id(`thread-child-${row.id}-${child.address}`)
        .min_h(23).pl(24).pr(6).gap(5).items_center().text_size(10).text_color(t.dim)
        .role("button").accessibility_label(`${child.name || child.program?.name || child.address}. ${child.status === "error" || child.status === "blocked" ? "Needs you" : child.status === "done" ? "Reported" : child.status || "Running"}${row.available ? "" : ". Machine is offline or still loading"}`)
        .on_click(() => { if (row.available) run("terminal.peek", { terminal: child.address }); })
        .child(div().flex_1().min_w(0).truncate().child(child.name || child.program?.name || child.address))
        .child(div().child(child.status === "error" || child.status === "blocked" ? "Needs you" : child.status === "done" ? "Reported" : child.status || "Running")))));
  }

  branch(content, t, last, center = 14, selected = false, continues = false) {
    return v_flex().relative().flex_none().pl(18)
      .when(!last, el => el.child(div().absolute().left(9).top(0).bottom(0).w(1).bg(t.border).opacity(0.45)))
      .child(div().absolute().left(9).top(0).w(9).h(center + 1)
        .border_l(1).border_b(1).border_color(selected ? t.foreground : t.border).opacity(selected ? 1 : 0.45).rounded_bl(4))
      .when(continues, el => el.child(div().absolute().left(9).top(0).bottom(0).w(1).bg(t.foreground)))
      .child(content);
  }

  shelf(key, label, rows, t) {
    if (!rows.length) return div().h(0);
    const open = this.expanded.has(key);
    const visible = open ? rows : rows.filter(row => row.current);
    const selectedIndex = visible.findIndex(row => row.current);
    return v_flex().flex_none()
      .child(h_flex().id(`threads-shelf-${key}`).h(25).px(6).gap(5).items_center().text_size(10.5).text_color(t.dim)
        .role("button").accessibility_label(`${open ? "Hide" : "Show"} ${label} threads, ${rows.length}`)
        .on_click((_e, cx) => {
          open ? this.expanded.delete(key) : this.expanded.add(key);
          localStorage.setItem("threads.expanded", JSON.stringify([...this.expanded])); cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(10))
        .child(div().flex_1().child(label)).child(String(rows.length)))
      .children(visible.map((row, index) => this.branch(this.row(row, t), t, index === visible.length - 1, 14, row.current, index < selectedIndex)));
  }

  groups(rows) {
    const active = rows.filter(row => row.current || (!row.reviewed && (row.pinned || row.status !== "working")))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned));
    const activeIds = new Set(active.map(row => row.id));
    const working = rows.filter(row => !activeIds.has(row.id) && !row.reviewed);
    const reviewed = rows.filter(row => !activeIds.has(row.id) && row.reviewed);
    return { active, working, reviewed };
  }

  order(rows) {
    const groups = this.groups(rows.filter(row => row.space.active));
    const first = [...groups.active, ...groups.working, ...groups.reviewed];
    const ids = new Set(first.map(row => row.id));
    return [...first, ...rows.filter(row => !ids.has(row.id))];
  }

  project(space, rows, t) {
    const { active, working, reviewed } = this.groups(rows.filter(row => row.space.id === space.id));
    const selectedIndex = active.findIndex(row => row.current);
    return v_flex().id(`project-threads-${space.id}`).flex_none().pl(6).pb(6)
      .children(active.map((row, index) => this.branch(this.row(row, t), t,
        index === active.length - 1 && !working.length && !reviewed.length, 14, row.current, index < selectedIndex)))
      .when(working.length > 0, el => el.child(this.branch(
        this.shelf(`${space.id}:working`, "Working", working, t), t, !reviewed.length, 12)))
      .when(reviewed.length > 0, el => el.child(this.branch(
        this.shelf(`${space.id}:reviewed`, "Reviewed", reviewed, t), t, true, 12)));
  }
}
