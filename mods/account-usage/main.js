import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Button } from "gpui-base";
import { spaces, theme, exec, appHome, readTextFile } from "herdr";

const PROVIDERS = { "openai-codex": "Codex", anthropic: "Claude", xai: "Grok", "opencode-go": "OpenCode Go", opencodego: "OpenCode Go", openrouter: "OpenRouter", meta: "Meta" };
const PROVIDER_ICONS = {
  "openai-codex": "mods/account-usage/icons/openai.svg",
  anthropic: "mods/account-usage/icons/claude.svg",
  xai: "icons/grok.svg",
  "opencode-go": "icons/opencode.svg",
  opencodego: "icons/opencode.svg",
  openrouter: "mods/account-usage/icons/openrouter.svg",
  meta: "mods/account-usage/icons/meta.svg",
};

export default class AccountUsage extends View {
  init(_props, cx) {
    this.accounts = [];
    this.warnings = [];
    this.generation = 0;
    this.refresh(cx);
    cx.timer.every(120000, cx => {
      this.refresh(cx);
      cx.notify();
    });
  }

  machineNow() {
    return spaces().find(space => space.active)?.machine ?? null;
  }

  refresh(cx) {
    const machine = this.machineNow();
    if (this.loading && this.machine === machine) return;
    if (this.machine !== machine) {
      this.accounts = [];
      this.warnings = [];
      this.checkedAt = null;
    }
    this.machine = machine;
    this.loading = true;
    this.error = null;
    const generation = ++this.generation;
    cx.spawn(async cx => {
      try {
        this.collector ??= await readTextFile(`${appHome()}/mods/account-usage/collect.py`);
        if (!this.collector) throw new Error("Account collector is missing");
        // Only code crosses machines; credentials and HTTP requests stay on their owner.
        const result = await exec("python3", ["-c", this.collector], { on: machine });
        if (result.code !== 0) throw new Error("Account discovery failed. Python 3 is required on this machine.");
        const data = JSON.parse(result.stdout);
        if (!data || !Array.isArray(data.accounts) || !Array.isArray(data.warnings)
          || !Number.isFinite(data.checkedAt) || data.warnings.some(value => typeof value !== "string")
          || data.accounts.some(row => !row || [row.id, row.provider].some(value => typeof value !== "string")
            || (row.summary != null && typeof row.summary !== "string")
            || (row.note !== null && typeof row.note !== "string") || !Array.isArray(row.windows)
            || row.windows.some(w => !w || typeof w.label !== "string" || !Number.isFinite(w.remaining) || w.remaining < 0 || w.remaining > 100))) {
          throw new Error("Unexpected account-usage response");
        }
        if (generation !== this.generation) return;
        this.accounts = data.accounts;
        this.warnings = data.warnings;
        this.checkedAt = data.checkedAt;
      } catch (error) {
        if (generation === this.generation) this.error = error.message || "Could not reach this machine";
      } finally {
        if (generation === this.generation) { this.loading = false; cx.notify(); }
      }
    });
    // The caller already renders machine changes; completion notifies asynchronously.
  }

  reset(value) {
    const time = typeof value === "number" ? value * 1000 : Date.parse(value);
    if (!Number.isFinite(time)) return "";
    const minutes = Math.max(0, Math.ceil((time - Date.now()) / 60000));
    return minutes >= 1440 ? `resets in ${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`
      : minutes >= 60 ? `resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m` : `resets in ${minutes}m`;
  }

  compactAccount(row, t) {
    const provider = PROVIDERS[row.provider] ?? row.provider;
    const icon = PROVIDER_ICONS[row.provider];
    const status = row.note || (!row.windows.length && !row.summary ? "Usage unavailable" : null);
    return v_flex().id(`subscription-${row.id}`).flex_none().gap(4).py(5)
      .accessibility_label(`${provider}. ${row.windows.map(w => `${w.label}: ${Math.round(100 - w.remaining)}% used, ${Math.round(w.remaining)}% left${w.reset ? `, ${this.reset(w.reset)}` : ""}`).join(". ") || row.summary || ""}${status ? `. ${status}` : ""}`)
      .child(h_flex().items_center().gap(8)
        .child(div().relative().size(18).flex_none().flex().items_center().justify_center()
          .child(div().accessibility_label(provider).child(icon ? svg(icon).size(16).text_color(t.foreground) : div().text_size(10).child(provider))))
        .child(div().min_w(0).flex_1().text_size(10).whitespace_normal().child(provider)))
      .when(row.windows.length > 0, el => el.child(h_flex().ml(26).gap(10).flex_wrap()
        .children(row.windows.map(w => {
          const used = 100 - w.remaining;
          const color = used >= 80 ? t.ansi1 : used >= 60 ? t.ansi3 : t.accent;
          const label = w.label === "Weekly" ? "7d" : w.label === "Monthly" ? "30d" : w.label;
          return v_flex().flex_1().min_w(64).gap(4)
            .accessibility_label(`${provider} · ${w.label}: ${Math.round(used)}% used, ${Math.round(w.remaining)}% left${w.reset ? ` · ${this.reset(w.reset)}` : ""}`)
            .child(h_flex().items_center().text_size(10).text_color(t.muted)
              .child(div().flex_1().child(label))
              .child(div().text_color(used >= 60 ? color : t.muted).child(`${Math.round(used)}%`)))
            .child(div().h(4).w_full().rounded(2).bg(t.border)
              .child(div().h(4).w(`${used}%`).rounded(2).bg(color)));
        }))))
      .when(!row.windows.length && Boolean(row.summary), el => el.child(div().ml(26).text_size(10).text_color(t.muted).whitespace_normal()
        .child(row.summary)))
      .when(Boolean(status), el => el.child(div().ml(26).text_size(9).text_color(t.ansi3).whitespace_normal()
        .accessibility_label(status).child(status)));
  }

  render(cx) {
    if (this.machineNow() !== this.machine) this.refresh(cx);
    const t = theme();
    const filter = Button.new("account-usage-filter").h(24).px(8).rounded(5).text_size(10)
      .bg(t.selected).text_color(t.dim).disabled(true).accessibility_label("All subscriptions").child("All");
    return v_flex().size_full().min_h(0).px(16).py(8).gap(8).bg(t.chrome).border_t(1).border_color(t.border).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(11.5).font_medium().text_color(t.dim).child("Subscriptions"))
        .child(filter))
      .when(Boolean(this.error), el => el.child(div().text_size(10).text_color(t.ansi3).whitespace_normal()
        .accessibility_label(`${this.checkedAt ? "Usage may be stale. " : ""}${this.error}`).child(this.checkedAt ? "Usage may be stale" : this.error)))
      .children(this.warnings.map((warning, index) => div().id(`account-discovery-warning-${index}`)
        .text_size(10).text_color(t.ansi3).accessibility_label(warning).child("!")))
      .child(v_flex().id("subscriptions-list").flex_1().min_h(0).overflow_y_scrollbar()
        .children(this.accounts.map(row => this.compactAccount(row, t)))
        .when(!this.accounts.length, el => el.child(div().text_size(11).text_color(t.muted).whitespace_normal()
          .child(this.loading ? "Checking subscriptions…" : "No provider logins on this machine."))));
  }
}
