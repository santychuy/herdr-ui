// Native project icon picker. Selection stays open so the saved icon is visible.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Button, InputState, Input } from "gpui-base";
import { appHome, closeOverlay, exec, nextCommand, props, setShared, shared, spaces, theme } from "herdr";
import { ICONS } from "./catalog.js";

const DEFAULT = "folder-01";
const PASTE = "project_icons_paste";
const COLUMNS = 5;
const COLORS = [
  { name: "neutral", label: "Neutral", token: "foreground" },
  { name: "red", label: "Red", token: "ansi1" },
  { name: "amber", label: "Amber", token: "ansi3" },
  { name: "green", label: "Green", token: "ansi2" },
  { name: "teal", label: "Teal", token: "ansi6" },
  { name: "blue", label: "Blue", token: "ansi4" },
  { name: "purple", label: "Purple", token: "ansi5" },
];

function iconMap() {
  const value = shared("space.icons");
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function currentIcon(space) {
  const value = iconMap()[space];
  if (value?.kind === "custom" && typeof value.path === "string" && value.path) return value;
  if (value?.kind === "gallery" && ICONS.some(icon => icon.name === value.name)) return value;
  return { kind: "gallery", name: DEFAULT };
}

function preview(icon, size, color) {
  return icon.kind === "custom"
    ? image(icon.path).size(size).flex_none().rounded(2)
    : svg(`mods/project-icons/icons/${icon.name}.svg`).size(size).flex_none().text_color(color);
}

export default class ProjectIcons extends View {
  init(_props, cx) {
    const initial = props() ?? {};
    this.space = typeof initial.space === "string" ? initial.space : "";
    this.tab = initial.tab === "custom" ? "custom" : "gallery";
    this.query = "";
    this.busy = false;
    this.error = "";
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Search icons…" });
    this.input.on("change", (_event, cx) => {
      this.query = this.input.value();
      cx.notify();
    });
    this.input.on("submit", (_event, cx) => {
      const first = this.filtered()[0];
      if (first) this.choose(first.name, cx);
    });
    // Keep normal text paste in the gallery's search input. Image paste binds
    // only in Custom, where the root owns keyboard focus.
    if (!sessionStorage.getItem("project-icons.paste-bindings")) {
      cx.bind_keys(["cmd-v", "ctrl-v"].map(keystroke =>
        ({ keystroke, action: PASTE, context: "ProjectIcons" })));
      sessionStorage.setItem("project-icons.paste-bindings", "1");
    }
    if (this.tab === "gallery") this.input.focus();
    else this.handle.focus();
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "gallery" || command === "custom") this.setTab(command);
        else if (command.startsWith("choose-")) this.choose(command.slice(7), cx);
        else if (command.startsWith("color-")) this.chooseColor(command.slice(6), cx);
        else if (command === "reset") this.reset(cx);
        else if (command === "paste") this.importIcon("paste", null, cx);
        else if (command === "import") this.importIcon("source", props().source, cx);
        else if (command === "upload") this.importIcon("pick", null, cx);
        else if (command === "focus") {
          if (this.tab === "gallery") this.input.focus();
          else this.handle.focus();
        }
        cx.notify();
      }
    });
  }

  filtered() {
    const words = this.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return ICONS.filter(icon => words.every(word => `${icon.label} ${icon.name}`.toLowerCase().includes(word)));
  }

  available() {
    return spaces().some(space => space.id === this.space);
  }

  setTab(tab) {
    this.tab = tab;
    if (tab === "gallery") this.input.focus();
    else this.handle.focus();
  }

  save(icon) {
    if (!this.available()) throw new Error("This project is no longer available.");
    const next = { ...iconMap() };
    if (icon) next[this.space] = icon;
    else delete next[this.space];
    setShared("space.icons", next);
  }

  choose(name, cx) {
    if (this.busy) return;
    const icon = ICONS.find(icon => icon.name === name);
    if (!icon) {
      this.error = "That gallery icon is not available.";
      cx.notify();
      return;
    }
    try {
      this.save({ kind: "gallery", name, color: currentIcon(this.space).color ?? "neutral" });
      this.error = "";
    } catch (error) {
      this.error = String(error.message ?? error);
    }
    cx.notify();
  }

  chooseColor(name, cx) {
    const selected = currentIcon(this.space);
    if (this.busy || selected.kind !== "gallery" || !COLORS.some(color => color.name === name)) return;
    try {
      this.save({ ...selected, color: name });
      this.error = "";
    } catch (error) {
      this.error = String(error.message ?? error);
    }
    cx.notify();
  }

  reset(cx) {
    if (this.busy) return;
    try {
      this.save(null);
      this.error = "";
    } catch (error) {
      this.error = String(error.message ?? error);
    }
    cx.notify();
  }

  importIcon(mode, source, cx) {
    if (this.busy) return;
    this.setTab("custom");
    if (!this.available()) {
      this.error = "This project is no longer available.";
      cx.notify();
      return;
    }
    if (mode === "source" && (typeof source !== "string" || !source.startsWith("/"))) {
      this.error = "Choose an absolute PNG or SVG file path.";
      cx.notify();
      return;
    }
    this.busy = true;
    this.error = "";
    this.progress = mode === "pick" ? "Choosing an image…" : "Importing image…";
    cx.notify();
    cx.spawn(async cx => {
      try {
        const root = appHome();
        const args = [`${root}/mods/project-icons/import.mjs`, "--home", root,
          ...(mode === "source" ? ["--source", source] : [mode === "paste" ? "--paste" : "--pick"])];
        // Intentionally local: a remote project's icon belongs to this app home.
        const result = await exec("node", args, { timeout: mode === "pick" ? 330000 : 120000 });
        let imported;
        try { imported = JSON.parse(result.stdout.trim()); }
        catch { throw new Error(result.stderr.trim() || "The image importer returned an unreadable response."); }
        if (!imported.ok) {
          if (!imported.cancelled) throw new Error(imported.error || "Could not import this image.");
        } else {
          if (result.code !== 0 || typeof imported.path !== "string" || !imported.path || imported.path.startsWith("/") || imported.path.split("/").includes("..")) {
            throw new Error("The image importer did not return a saved image path.");
          }
          this.save({ kind: "custom", path: imported.path });
        }
      } catch (error) {
        this.error = `${String(error.message ?? error)} Previous icon kept.`;
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  button(id, label, action, t, disabled = false) {
    return Button.new(id).h(32).px(11).rounded(7).border_1().border_color(t.border)
      .bg(t.raised).text_color(disabled ? t.dim : t.foreground).text_size(12)
      .disabled(disabled).accessibility_label(label)
      .hover(el => el.bg(t.hover)).focus(el => el.border_color(t.accent))
      .on_click((_event, cx) => action(cx)).child(label);
  }

  render(cx) {
    const t = theme();
    const selected = currentIcon(this.space);
    const selectedColor = COLORS.find(color => color.name === selected.color) ?? COLORS[0];
    const tint = t[selectedColor.token];
    const space = spaces().find(space => space.id === this.space);
    const disabled = this.busy || !space;
    const gallery = this.filtered();
    const status = !space ? "This project is no longer available." : this.error || (this.busy ? this.progress : "");
    const rows = [];
    for (let start = 0; start < gallery.length; start += COLUMNS) {
      const icons = gallery.slice(start, start + COLUMNS);
      rows.push(h_flex().gap(7).children([
        ...icons.map(icon => {
          const on = selected.kind === "gallery" && selected.name === icon.name;
          return Button.new(`choose-${icon.name}`).flex().flex_col().flex_1().min_w(0).h(76)
            .items_center().justify_center().gap(5).rounded(8).border_1()
            .border_color(on ? t.accent : t.border).bg(on ? t.selected : t.surface)
            .text_color(t.foreground).disabled(disabled).selected(on)
            .accessibility_label(`${icon.label}${on ? ", selected" : ""}`).tooltip(icon.label)
            .hover(el => el.bg(t.hover)).focus(el => el.border_color(t.accent))
            .on_click((_event, cx) => this.choose(icon.name, cx))
            .child(svg(`mods/project-icons/icons/${icon.name}.svg`).size(25).text_color(tint))
            .child(div().max_w(72).truncate().text_size(10).child(`${on ? "✓ " : ""}${icon.label}`));
        }),
        ...Array.from({ length: COLUMNS - icons.length }, () => div().flex_1()),
      ]));
    }
    return v_flex().id("project-icons").size_full().min_h(0).p(18).gap(10)
      .bg(t.popover).text_color(t.foreground).text_size(12).track_focus(this.handle)
      .key_context(this.tab === "custom" ? "ProjectIcons" : "ProjectIconGallery").accessibility_label("Customize project icon")
      .on_action(PASTE, (_event, cx) => {
        cx.stop_propagation();
        this.importIcon("paste", null, cx);
      })
      .on_key_down((event, cx) => {
        if (event.key === "escape") {
          closeOverlay(props().overlay);
          cx.stop_propagation();
        } else if (this.tab === "custom" && (event.keystroke === "cmd-v" || event.keystroke === "ctrl-v")) {
          cx.stop_propagation();
          this.importIcon("paste", null, cx);
        }
      })
      .on_drop((event, cx) => {
        if (event.paths.length !== 1) {
          this.error = "Drop one PNG or SVG image at a time. Previous icon kept.";
          cx.notify();
        } else this.importIcon("source", event.paths[0], cx);
      })
      .child(h_flex().gap(12).items_center().flex_none()
        .child(div().size(52).rounded(10).bg(t.surface).flex().items_center().justify_center()
          .child(preview(selected, 34, tint)))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(div().text_size(16).font_semibold().child("Customize icon"))
          .child(div().truncate().text_color(t.muted).child(space?.name || this.space || "No project selected"))))
      .child(h_flex().gap(6).flex_none().children(["gallery", "custom"].map(tab =>
        Button.new(`tab-${tab}`).flex_1().h(32).rounded(7).border_1()
          .border_color(this.tab === tab ? t.accent : t.border)
          .bg(this.tab === tab ? t.selected : t.surface).selected(this.tab === tab)
          .accessibility_label(tab === "gallery" ? "Gallery icons" : "Custom image")
          .hover(el => el.bg(t.hover)).focus(el => el.border_color(t.accent))
          .on_click((_event, cx) => { this.setTab(tab); cx.notify(); })
          .child(tab === "gallery" ? "Gallery" : "Custom"))))
      .when(this.tab === "gallery" && selected.kind === "gallery", el => el.child(
        h_flex().gap(8).flex_none().accessibility_label("Icon color").children(COLORS.map(color => {
          const on = color.name === selectedColor.name;
          return Button.new(`color-${color.name}`).size(28).rounded(14).flex().items_center().justify_center()
            .border_2().border_color(on ? t.foreground : t.border).bg(t.surface)
            .disabled(disabled).selected(on).tooltip(color.label)
            .accessibility_label(`${color.label}${on ? ", selected" : ""}`)
            .hover(style => style.bg(t.hover)).focus(style => style.border_color(t.accent))
            .on_click((_event, cx) => this.chooseColor(color.name, cx))
            .child(div().size(16).rounded(8).bg(t[color.token]));
        }))))
      .child(this.tab === "gallery"
        ? v_flex().flex_1().min_h(0).gap(8)
          .child(Input.new(this.input).h(34).flex_none().px(10).rounded(7).border_1()
            .border_color(t.input).bg(t.background).text_color(t.foreground).accessibility_label("Search gallery icons"))
          .child(div().text_size(10).text_color(t.dim).child(`${gallery.length} icons · Enter selects the first result`))
          .child(v_flex().id("icon-gallery").flex_1().min_h(0).gap(7).overflow_y_scrollbar()
            .children(rows.length ? rows : [div().p(20).text_color(t.muted).child("No matching icons")]))
        : v_flex().flex_1().min_h(0).gap(14).items_center().justify_center()
          .child(div().size(92).rounded(12).bg(t.surface).flex().items_center().justify_center()
            .child(preview(selected, 64, t.foreground)))
          .child(div().text_color(t.muted).child("Drop a PNG or SVG image here"))
          .child(h_flex().gap(8)
            .child(this.button("upload", "Upload image…", cx => this.importIcon("pick", null, cx), t, disabled))
            .child(this.button("paste", "Paste image", cx => this.importIcon("paste", null, cx), t, disabled)))
          .child(div().text_size(11).text_color(t.dim).child("PNG / SVG · ⌘V or Ctrl+V to paste")))
      .when(Boolean(status), el => el.child(div().flex_none().text_size(11)
        .text_color(this.error || !space ? t.blocked : t.muted).child(status)))
      .child(h_flex().gap(8).flex_none().justify_between()
        .child(this.button("reset", "Reset to default", cx => this.reset(cx), t, disabled))
        .child(this.button("done", "Done", () => closeOverlay(props().overlay), t)));
  }
}
