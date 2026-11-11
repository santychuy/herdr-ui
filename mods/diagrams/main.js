import { View, div, image, svg } from "gpui-kit";
import { Button, h_flex, Popup, v_flex } from "gpui-base";
import { appHome, exec, nextCommand, notify, readTextFile, run, settings, theme, watchFolder, window as appWindow } from "herdr";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PELE_REPOSITORY = "https://github.com/obsidianmd/pele";
const DIAGRAM_PROMPT = "Generate a Mermaid diagram and show it in the Diagrams panel.";
const THEME_KEYS = ["background", "foreground", "muted", "surface", "raised", "border", "accent", "ansi1", "ansi2", "ansi3", "ansi4", "ansi5", "ansi6"];
const message = (error) => error instanceof Error ? error.message : String(error);

function diagramTheme(colors) {
  const result = {};
  for (const key of THEME_KEYS) if (typeof colors[key] === "string") result[key] = colors[key];
  return JSON.stringify(result);
}

function validateManifest(value, view = false) {
  if (!value || typeof value !== "object" || (!view && value.version !== 1) || !UUID.test(value.revision)) {
    throw new Error("Invalid diagram manifest: expected version 1 and a revision UUID.");
  }
  const root = `data/diagrams/${value.revision}/`;
  const svgName = typeof value.svg === "string" ? value.svg.slice(root.length) : "";
  if (typeof value.title !== "string" || typeof value.type !== "string" || !value.type ||
      !Number.isFinite(value.width) || value.width <= 0 || !Number.isFinite(value.height) || value.height <= 0 ||
      value.source !== `${root}source.mmd` || typeof value.svg !== "string" || !value.svg.startsWith(root) ||
      (view ? !/^view-[0-9a-f]+\.svg$/i.test(svgName) : svgName !== "diagram.svg")) {
    throw new Error("Invalid diagram manifest: title, type, dimensions or revision file paths are invalid.");
  }
  return value;
}

function button(id, label, title, colors, action, active = false) {
  return h_flex().id(id).h(25).px(7).flex_none().rounded(5).items_center().justify_center()
    .text_size(12).text_color(active ? colors.foreground : colors.muted)
    .when(active, (el) => el.bg(colors.raised)).cursor_pointer().tooltip(title)
    .hover((style) => style.bg(colors.hover || colors.raised).text_color(colors.foreground))
    .on_click((_event, cx) => { cx.stop_propagation(); action(cx); }).child(label);
}

export default class Diagrams extends View {
  init(_props, cx) {
    this.home = appHome().replace(/[\\/]$/, "");
    this.helper = `${this.home}/mods/diagrams/render.mjs`;
    this.directory = `${this.home}/data/diagrams`;
    this.currentPath = `${this.directory}/current.json`;
    this.closed = false;
    this.ready = false;
    this.initializing = false;
    this.watching = false;
    this.readID = 0;
    this.requestID = 0;
    this.width = 0;
    this.themeJSON = diagramTheme(theme());
    this.mode = "fit";
    this.zoom = 1;
    this.viewport = { width: 0, height: 0 };
    this.offset = { x: 0, y: 0 };
    this.drag = null;
    this.manifest = null;
    this.manifestText = null;
    this.view = null;
    this.viewKey = null;
    this.desiredKey = null;
    this.loading = false;
    this.clearing = false;
    this.clearError = null;
    this.bootError = null;
    this.manifestError = null;
    this.viewError = null;
    this.watchError = null;
    this.debounce = null;
    this.creditHovered = { trigger: false, card: false };
    this.creditMounted = false;
    this.creditVisible = false;
    this.creditEpoch = 0;
    this.creditTimer = null;
    this.promptCopied = false;
    this.promptTimer = null;
    this.initialize(cx);
    cx.spawn(async (cx) => {
      while (!this.closed) {
        const command = await nextCommand();
        if (this.closed) return;
        if (command === "reload") this.refresh(cx);
      }
    });
  }

  hoverCredit(source, hovered, cx) {
    if (this.closed) return;
    this.creditHovered[source] = hovered;
    this.creditTimer?.cancel();
    if (this.creditHovered.trigger || this.creditHovered.card) {
      if (this.creditMounted) {
        this.creditVisible = true;
        cx.notify();
      } else {
        this.creditTimer = cx.timer.after(140, (cx) => {
          if (this.closed || !(this.creditHovered.trigger || this.creditHovered.card)) return;
          this.creditMounted = true;
          this.creditEpoch++;
          cx.notify();
        });
      }
    } else if (this.creditMounted) {
      // Keep the card visible and hit-testable while crossing the trigger gap.
      this.creditTimer = cx.timer.after(180, (cx) => {
        if (this.closed || this.creditHovered.trigger || this.creditHovered.card) return;
        this.creditVisible = false;
        cx.notify();
        this.creditTimer = cx.timer.after(160, (cx) => {
          if (this.closed || this.creditHovered.trigger || this.creditHovered.card) return;
          this.creditMounted = false;
          cx.notify();
        });
      });
    }
  }

  openPeleRepository(cx) {
    cx.spawn(async () => {
      try {
        const platform = appWindow()?.platform;
        const command = platform === "macos" ? "open" : platform === "windows" ? "rundll32.exe" : "xdg-open";
        const args = platform === "windows" ? ["url.dll,FileProtocolHandler", PELE_REPOSITORY] : [PELE_REPOSITORY];
        const result = await exec(command, args);
        if (result.code !== 0) throw new Error("Browser launch failed");
      } catch {
        notify({ title: "Could not open Pele repository", body: "Check your default browser and try again.", level: "error" });
      }
    });
  }

  credit(colors) {
    const trigger = div().id("diagrams-info").size(18).flex_none().flex().items_center().justify_center()
      .text_color(colors.muted).hover(style => style.text_color(colors.foreground))
      .accessibility_label("About Pele, the diagram renderer. Hover for its repository link.")
      .on_hover((hovered, cx) => this.hoverCredit("trigger", hovered, cx))
      .child(svg("mods/diagrams/info.svg").size(13));
    return Popup.new("diagrams-pele-credit", trigger).anchor("top_left")
      .when(this.creditMounted, popup => popup.content(
        h_flex().id(`diagrams-pele-credit-${this.creditEpoch}`).w(140).p(10).gap(4).items_center()
          .bg(colors.popover).text_color(colors.foreground).border(1).border_color(colors.border).rounded(7)
          .opacity(this.creditVisible ? 1 : 0).transition("opacity", { duration: 160, easing: "ease-in-out" })
          .on_size_change((_size, cx) => {
            if (!this.creditVisible && (this.creditHovered.trigger || this.creditHovered.card)) {
              this.creditVisible = true;
              cx.notify();
            }
          })
          .on_hover((hovered, cx) => this.hoverCredit("card", hovered, cx))
          .child(div().text_size(12).font_semibold().child("Powered by"))
          .child(Button.new("diagrams-pele-repository").h(18).px(0).flex().items_center().justify_start().cursor_pointer()
            .text_size(12).font_semibold().text_color(colors.accent).hover(style => style.underline())
            .accessibility_label("Open Pele repository on GitHub")
            .on_click((_event, cx) => this.openPeleRepository(cx))
            .child("Pele"))));
  }

  async helperCall(action, args = []) {
    let result;
    try {
      result = await exec("node", [this.helper, action, ...args, "--home", this.home]);
    } catch (error) {
      throw new Error(`Could not start the local renderer. Install Node.js 20 or newer and make node available to Herdr. ${message(error)}`);
    }
    let value;
    try { value = JSON.parse(result.stdout); }
    catch { throw new Error(result.stderr.trim() || `Renderer returned invalid JSON (exit ${result.code}).`); }
    if (result.code !== 0 || value?.ok !== true) {
      throw new Error(value?.error?.message || result.stderr.trim() || `Renderer failed (exit ${result.code}).`);
    }
    return value;
  }

  initialize(cx) {
    if (this.closed || this.initializing) return;
    this.initializing = true;
    this.bootError = null;
    cx.spawn(async (cx) => {
      try {
        await this.helperCall("init");
        if (this.closed) return;
        this.ready = true;
        // Arm the watch before reading, so a publication during that read is not lost.
        this.watch(cx);
        this.reload(cx, true);
      } catch (error) {
        if (!this.closed) this.bootError = message(error);
      } finally {
        if (!this.closed) { this.initializing = false; cx.notify(); }
      }
    });
  }

  watch(cx) {
    if (this.closed || this.watching) return;
    this.watching = true;
    this.watchError = null;
    cx.spawn(async (cx) => {
      try {
        while (!this.closed) {
          const paths = await watchFolder(this.directory);
          if (this.closed) return;
          // View SVGs share the directory; only the publication pointer matters.
          if (paths.some((path) => path === this.directory || path === this.currentPath)) this.reload(cx);
        }
      } catch (error) {
        if (!this.closed) {
          this.watchError = `Automatic updates stopped: ${message(error)}. Use Refresh to reconnect.`;
          cx.notify();
        }
      } finally { this.watching = false; }
    });
  }

  refresh(cx) {
    if (this.closed) return;
    if (this.clearing) return;
    if (!this.ready) this.initialize(cx);
    else { this.watch(cx); this.reload(cx, true); }
    cx.notify();
  }

  resetDiagram() {
    this.invalidateView();
    this.manifest = null;
    this.manifestText = null;
    this.view = null;
    this.viewKey = null;
    this.manifestError = null;
    this.viewError = null;
    this.mode = "fit";
    this.zoom = 1;
    this.offset.x = 0;
    this.offset.y = 0;
    this.drag = null;
  }

  clearDiagrams(cx) {
    if (this.closed || this.clearing) return;
    this.clearing = true;
    this.clearError = null;
    this.readID++;
    this.invalidateView();
    this.drag = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.helperCall("clear");
        if (this.closed) return;
        this.resetDiagram();
        this.bootError = null;
      } catch (error) {
        if (!this.closed) this.clearError = `Could not clear saved diagrams: ${message(error)}`;
      } finally {
        if (!this.closed) {
          this.clearing = false;
          if (!this.clearError) this.reload(cx, true);
          cx.notify();
        }
      }
    });
  }

  invalidateView() {
    this.requestID++;
    this.debounce?.cancel();
    this.debounce = null;
    this.desiredKey = null;
    this.loading = false;
  }

  reload(cx, force = false) {
    if (this.closed || this.clearing) return;
    const id = ++this.readID;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(this.currentPath);
        if (this.closed || id !== this.readID) return;
        if (text === null) {
          this.resetDiagram();
          cx.notify();
          return;
        }
        // A directory-root event can be emitted for our own cached view files.
        // Identical pointers never schedule another render unless Refresh requested it.
        if (!force && text === this.manifestText && !this.manifestError) return;
        const manifest = validateManifest(JSON.parse(text));
        this.manifest = manifest;
        this.manifestText = text;
        this.manifestError = null;
        this.scheduleView(cx, force);
        cx.notify();
      } catch (error) {
        if (this.closed || id !== this.readID) return;
        this.invalidateView();
        this.manifestError = `Cannot load the published diagram: ${message(error)}`;
        cx.notify();
      }
    });
  }

  scheduleView(cx, force = false) {
    if (this.closed || this.clearing || !this.manifest || this.manifestError || this.width <= 0) return;
    const width = Math.max(1, Math.floor(this.width - 32));
    const manifest = this.manifest;
    const themeJSON = this.themeJSON;
    const key = JSON.stringify([manifest.revision, width, themeJSON]);
    if (!force && key === this.desiredKey) return;
    this.debounce?.cancel();
    const id = ++this.requestID;
    this.desiredKey = key;
    this.loading = true;
    this.viewError = null;
    this.debounce = cx.timer.after(180, (cx) => {
      this.debounce = null;
      if (this.closed || id !== this.requestID) return;
      cx.spawn(async (cx) => {
        try {
          const result = validateManifest(await this.helperCall("view", ["--revision", manifest.revision, "--width", String(width), "--theme", themeJSON]), true);
          if (this.closed || id !== this.requestID) return;
          if (result.revision !== manifest.revision) throw new Error("Renderer returned a different diagram revision.");
          if (this.view?.revision !== result.revision) {
            this.offset.x = 0;
            this.offset.y = 0;
            this.drag = null;
          }
          this.view = result;
          this.viewKey = key;
          this.viewError = null;
        } catch (error) {
          if (!this.closed && id === this.requestID) this.viewError = `Cannot render the current diagram: ${message(error)}`;
        } finally {
          if (!this.closed && id === this.requestID) { this.loading = false; cx.notify(); }
        }
      });
    });
  }

  diagramScale() {
    if (this.mode !== "fit") return this.zoom;
    return this.view ? Math.min(1, Math.max(1, this.width - 32) / this.view.width) : 1;
  }


  setZoom(mode, zoom, cx, anchor = null) {
    const previous = this.diagramScale();
    const x = anchor?.x ?? this.viewport.width / 2;
    const y = anchor?.y ?? this.viewport.height / 2;
    this.mode = mode;
    this.zoom = Math.max(0.25, Math.min(4, zoom));
    const ratio = this.diagramScale() / previous;
    this.offset.x = mode === "fit" ? 0 : (this.offset.x + x - 12) * ratio - x + 12;
    this.offset.y = mode === "fit" ? 0 : (this.offset.y + y - 12) * ratio - y + 12;
    this.drag = null;
    cx.notify();
  }

  scrollDiagram(event, cx) {
    const uiZoom = Number(settings().zoom) || 1;
    cx.stop_propagation();
    if (event.modifiers.control || event.modifiers.platform) {
      const anchor = event.local_position
        ? { x: event.local_position.x / uiZoom, y: event.local_position.y / uiZoom } : null;
      this.setZoom("zoom", this.diagramScale() * Math.exp(event.delta.y / uiZoom * 0.01), cx, anchor);
    } else {
      const horizontal = event.modifiers.shift && event.delta.x === 0;
      this.offset.x -= (horizontal ? event.delta.y : event.delta.x) / uiZoom;
      this.offset.y -= (horizontal ? 0 : event.delta.y) / uiZoom;
      cx.notify();
    }
  }

  beginPan(event, cx) {
    this.drag = { x: event.position.x, y: event.position.y, offsetX: this.offset.x, offsetY: this.offset.y };
    cx.stop_propagation();
    cx.notify();
  }

  movePan(event, cx) {
    if (!this.drag) return;
    const uiZoom = Number(settings().zoom) || 1;
    this.offset.x = this.drag.offsetX - (event.position.x - this.drag.x) / uiZoom;
    this.offset.y = this.drag.offsetY - (event.position.y - this.drag.y) / uiZoom;
    cx.stop_propagation();
    cx.notify();
  }

  endPan(cx) {
    if (!this.drag) return;
    this.drag = null;
    cx.notify();
  }

  copyPrompt(cx) {
    if (this.closed) return;
    cx.write_to_clipboard(DIAGRAM_PROMPT);
    this.promptTimer?.cancel();
    this.promptCopied = true;
    cx.notify();
    this.promptTimer = cx.timer.after(1600, (cx) => {
      if (this.closed) return;
      this.promptCopied = false;
      this.promptTimer = null;
      cx.notify();
    });
  }

  close() {
    this.closed = true;
    this.readID++;
    this.invalidateView();
    this.creditTimer?.cancel();
    this.promptTimer?.cancel();
    // A pending directory watch/command await is harmless; it exits before scheduling work.
  }

  render(cx) {
    const colors = theme();
    const themeJSON = diagramTheme(colors);
    if (themeJSON !== this.themeJSON) {
      this.themeJSON = themeJSON;
      this.scheduleView(cx);
    }
    const error = this.clearError || this.bootError || this.manifestError || this.viewError;
    const stale = Boolean(this.view && (error || this.viewKey !== this.desiredKey));
    const metadata = this.view || this.manifest;
    const scale = this.diagramScale();
    const status = this.clearing ? "Clearing saved diagrams…" : error || (this.initializing ? "Starting local renderer…" : this.loading ? "Rendering diagram…" : null);
    const action = (id, label, title, callback, active = false) => button(id, label, title, colors, callback, active);

    return v_flex().id("diagrams-root").size_full().min_w(0).min_h(0).overflow_hidden()
      .bg(colors.background).text_color(colors.foreground).text_size(13)
      .on_size_change((size, cx) => {
        // The callback reports zoomed GPUI pixels; style dimensions are scaled by Herdr.
        const width = Math.round(size.width / (Number(settings().zoom) || 1));
        if (width === this.width) return;
        this.width = width;
        this.scheduleView(cx);
        cx.notify();
      })
      .child(h_flex().h(42).flex_none().px(12).gap(7).items_center().border_b(1).border_color(colors.border)
        .child(svg("mods/diagrams/diagram.svg").size(16).text_color(colors.muted))
        .child(div().font_semibold().child("Diagrams"))
        .child(this.credit(colors))
        .child(div().flex_1())
        .when(Boolean(metadata || this.clearError || this.clearing), el => el.child(
          action("diagrams-clear", svg("mods/diagrams/clear.svg").size(14), "Clear all saved diagrams and cached SVGs", (cx) => this.clearDiagrams(cx))
            .accessibility_label("Clear all saved diagrams and cached SVGs")
            .when(this.clearing, el => el.opacity(0.5))))
        .child(action("diagrams-refresh", "↻", "Refresh the local diagram", (cx) => this.refresh(cx)))
        .child(action("diagrams-close", "×", "Close Diagrams panel", () => run("layout.hide", { id: "panel" }))))
      .when(Boolean(metadata), (el) => el.child(v_flex().flex_none().px(14).py(9).gap(3).min_w(0)
        .child(div().truncate().font_semibold().tooltip(metadata.title || "Untitled diagram").child(metadata.title || "Untitled diagram"))
        .child(div().text_size(11).text_color(colors.muted).child(`${metadata.type} · ${Math.round(metadata.width)} × ${Math.round(metadata.height)} px${stale ? " · last valid view" : ""}`))))
      .when(Boolean(this.view), (el) => el.child(h_flex().flex_none().px(10).pb(7).gap(3).items_center()
        .child(action("diagrams-fit", "Fit width", "Fit the diagram to the panel width", (cx) => this.setZoom("fit", 1, cx), this.mode === "fit"))
        .child(action("diagrams-actual", "100%", "Show the rendered diagram at its natural size", (cx) => this.setZoom("zoom", 1, cx), this.mode === "zoom" && this.zoom === 1))
        .child(div().flex_1())
        .child(action("diagrams-minus", "−", "Zoom out", (cx) => this.setZoom("zoom", scale / 1.25, cx)))
        .child(div().w(35).text_center().text_size(11).text_color(colors.muted).child(`${Math.round(scale * 100)}%`))
        .child(action("diagrams-plus", "+", "Zoom in", (cx) => this.setZoom("zoom", scale * 1.25, cx)))))
      .when(Boolean(status), (el) => el.child(div().flex_none().px(14).py(8).text_size(12)
        .text_color(error ? colors.ansi1 || colors.foreground : colors.muted)
        .child(`${stale ? "Showing last valid diagram. " : ""}${status}`)))
      .when(Boolean(this.watchError), (el) => el.child(div().flex_none().px(14).py(6).text_size(11).text_color(colors.muted).child(this.watchError)))
      .child(this.view
        ? div().id("diagrams-scroll").flex_1().min_w(0).min_h(0).relative().overflow_hidden()
          .on_size_change((size, cx) => {
            const uiZoom = Number(settings().zoom) || 1;
            const width = Math.round(size.width / uiZoom);
            const height = Math.round(size.height / uiZoom);
            if (width === this.viewport.width && height === this.viewport.height) return;
            this.viewport = { width, height };
            this.drag = null;
            cx.notify();
          })
          .child(image(this.view.svg).id("diagrams-image").absolute().left(12 - this.offset.x).top(12 - this.offset.y)
            .w(this.view.width * scale).h(this.view.height * scale))
          // Paint input last: the SVG is presentation, not the gesture target.
          .child(div().id("diagrams-canvas").absolute().inset_0()
            .when(Boolean(this.drag), el => el.cursor_grabbing())
            .when(!this.drag, el => el.cursor_grab())
            .accessibility_label("Diagram canvas. Drag to move freely; Ctrl or Cmd and scroll to zoom.")
            .on_scroll_wheel((event, cx) => this.scrollDiagram(event, cx))
            .on_mouse_down("left", (event, cx) => this.beginPan(event, cx))
            .on_mouse_move((event, cx) => this.movePan(event, cx))
            .on_mouse_up("left", (_event, cx) => {
              if (this.drag) cx.stop_propagation();
              this.endPan(cx);
            })
            .on_hover((hovered, cx) => { if (!hovered) this.endPan(cx); }))
        : v_flex().id("diagrams-empty").flex_1().min_w(0).min_h(0).p(24).gap(10).items_center().justify_center()
          .child(svg("mods/diagrams/diagram.svg").size(28).flex_none().text_color(colors.muted))
          .child(div().font_semibold().text_center().child(this.manifest ? "Preparing your diagram" : "No diagram yet"))
          .child(div().max_w(300).text_center().text_color(colors.muted)
            .child(this.manifest ? "Rendering your latest diagram…" : "Paste this prompt into your agent to generate a diagram."))
          .when(!this.manifest, el => el.child(
            Button.new("diagrams-copy-prompt").w_full().max_w(300).p(12).rounded(7)
              .bg(colors.surface).border(1).border_color(colors.border).cursor_pointer()
              .hover(style => style.bg(colors.raised).border_color(colors.accent))
              .accessibility_label("Copy diagram generation prompt")
              .on_click((_event, cx) => { cx.stop_propagation(); this.copyPrompt(cx); })
              .child(h_flex().w_full().gap(12).items_start()
                .child(div().flex_1().min_w(0).text_size(12).text_left().child(DIAGRAM_PROMPT))
                .child(svg(this.promptCopied ? "mods/diagrams/check.svg" : "mods/diagrams/copy.svg").size(14).flex_none()
                  .text_color(this.promptCopied ? colors.ansi2 || colors.accent : colors.accent))))));
  }
}
