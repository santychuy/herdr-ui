import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, window, shared, setShared, updates, layout, settings, spaces, keys } from "herdr";
import { shortcutHint } from "./bindings.js";

export default class WorkspaceChrome extends View {
  button(id, label, action, size = 26) {
    const t = theme();
    return div().id(id).size(size).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .role("button").on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
  }

  scopeSwitch(t) {
    const scope = shared("spaces.scope") ?? (spaces().find(space => space.active)?.machine ? "remote" : "local");
    const option = (value, title) => div().id(`spaces-scope-${value}`).flex_1().min_w(0).h(22)
      .flex().items_center().justify_center().rounded(4).text_size(11).text_color(scope === value ? t.foreground : t.muted)
      .when(scope === value, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
      .role("button").accessibility_label(`${title} projects · ${value === "local" ? "this computer" : "grouped by machine"}${scope === value ? ", selected" : ""}`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => setShared("spaces.scope", value))
      .child(title);
    return h_flex().id("header-project-scope").flex_1().min_w(40).h(26).p(2).gap(2).mr(4).rounded(6).bg(t.background)
      .child(option("local", "Local")).child(option("remote", "Remote"));
  }
  render() {
    const t = theme();
    const root = layout(), win = window();
    const settingsHint = shortcutHint({ name: "app.settings", args: {} }, keys(), shared("layout"), win?.platform);
    // Native macOS window buttons are positioned in unscaled window pixels.
    const left = win?.platform === "macos" && !win.fullscreen
      ? Math.max(10, ((root?.traffic_lights?.[0] ?? 12) + 64) / (settings().zoom ?? 1)) : 14;
    return h_flex().size_full().bg(t.chrome).pl(left).pr(10).gap(4).items_center().text_size(13.5)
      .child(this.scopeSwitch(t))
      .child(
        this.button("settings", svg("mods/my-workspace-chrome/settings.svg").size(14), () => run("app.settings"))
          .relative().accessibility_label("Settings")
          .when(Boolean(settingsHint), el => el.tooltip(settingsHint))
          .when(Boolean(updates().app.ready), button => button.child(div().absolute().top(1).right(1).size(6).rounded_full().bg(t.accent))));
  }
}
