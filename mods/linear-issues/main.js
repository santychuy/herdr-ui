import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Button, InputState, Input, Popover } from "gpui-base";
import { agents, appHome, exec, focused, notify, props, run, theme, window as appWindow, writeTextFile } from "herdr";

const SECURITY_URL = "https://linear.app/settings/account/security";
const LINEAR_URL = /^https:\/\/linear\.app\/[^\s\u0000-\u001f\\]*$/;
const RECONNECT = ["invalid_key", "unauthorized", "not_connected"];
const STATE_TYPES = ["triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate"];

// Names are team-defined: In Review and In Progress can both be "started".
// Share same-named groups across teams only within the same category.
function issueGroups(issues) {
  const groups = new Map();
  for (const issue of issues) {
    const { name, type, position } = issue.state;
    const key = JSON.stringify([type, name]);
    let group = groups.get(key);
    if (!group) {
      group = { key, name, type, position, issues: [] };
      groups.set(key, group);
    }
    group.position = Math.min(group.position, position);
    group.issues.push(issue);
  }
  const rank = type => {
    const index = STATE_TYPES.indexOf(type);
    return index < 0 ? STATE_TYPES.length : index;
  };
  return [...groups.values()].sort((a, b) =>
    rank(a.type) - rank(b.type) || a.position - b.position || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

// Never display process output, exceptions, or server text: a credential must not
// leak through an error, tooltip, or accessibility label.
async function client(action, args = []) {
  let result;
  try {
    result = await exec("python3", [appHome() + "/mods/linear-issues/client.py", "--home", appHome(), action, ...args]);
  } catch {
    return { ok: false, error: { code: "helper_unavailable" } };
  }
  try {
    const data = JSON.parse(result.stdout);
    if (data?.ok === false && typeof data.error?.code === "string") return data;
    if (result.code === 0 && data?.ok === true) return data;
  } catch {}
  return { ok: false, error: { code: "helper_unavailable" } };
}

function errorText(error) {
  switch (error?.code) {
    case "invalid_key": case "unauthorized":
      return "Linear did not accept this key. It may be invalid, expired, or revoked. Create a new Read-only key and reconnect.";
    case "not_connected":
      return "No saved Linear key is available. Connect a key to continue.";
    case "forbidden":
      return "Linear denied access. Check the key’s Read permission and team restrictions. Your workspace admin may disable member API keys.";
    case "rate_limited": {
      const seconds = Number(error.retryAfter);
      return Number.isFinite(seconds) && seconds > 0
        ? `Linear is rate limiting requests. Wait at least ${Math.ceil(seconds)} seconds, then retry manually.`
        : "Linear is rate limiting requests. Wait a minute, then retry manually.";
    }
    case "network_error": case "timeout":
      return "Could not reach Linear. Check your internet connection, then retry. No automatic retries run in the background.";
    case "storage_unavailable":
      return "Secure credential storage is unavailable. Use macOS Keychain, or install secret-tool and unlock a Linux Secret Service keyring. No plaintext fallback is used.";
    case "storage_locked": case "storage_denied":
      return "The local credential store is locked or access was denied. Unlock your keyring or allow Keychain access, then retry.";
    case "storage_error":
      return "The local credential store could not complete the request. Check Keychain or your Secret Service keyring, then retry.";
    case "unsafe_handoff": case "handoff_failed":
      return "The private credential handoff could not be completed. Your saved connection was not replaced. Paste the key again to retry.";
    case "helper_unavailable":
      return "The local Linear helper could not start or finish. Install Python 3 and check that the Linear mod’s client.py is installed, then retry the connection check.";
    default:
      return "Linear returned an unexpected response. Retry manually. If it persists, check your key’s Read permission and team access.";
  }
}

export default class LinearIssues extends View {
  init(_props, cx) {
    this.request = 0;
    this.ready = false;
    this.account = null;
    this.storage = null;
    this.busy = null;
    this.settings = false;
    this.settingsMenuOpen = false;
    this.scope = "all";
    this.team = "";
    this.teamMenu = false;
    this.issues = [];
    this.collapsedGroups = new Set();
    this.page = { hasNextPage: false, endCursor: null };
    this.listLoading = false;
    this.listError = null;
    this.error = null;
    this.openError = false;
    this.confirmDisconnect = false;
    this.drafting = false;
    this.hasKey = false;
    this.inputFocused = false;
    this.handoff = null;
    this.input = InputState.new({ placeholder: "Paste your personal API key" });
    this.input.set_masked(true);
    this.input.on("change", (_event, cx) => {
      this.hasKey = Boolean(this.input.value().trim());
      cx.notify();
    });
    this.input.on("submit", (_event, cx) => this.connect(cx));
    this.input.on("focus", (_event, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_event, cx) => { this.inputFocused = false; cx.notify(); });
    // Deliberately never focus the input on mount: the terminal keeps its keyboard.
    this.checkStatus(cx);
  }

  checkStatus(cx) {
    if (this.busy) return;
    const request = ++this.request;
    this.busy = "status";
    this.error = null;
    cx.spawn(async (cx) => {
      const data = await client("status");
      if (request !== this.request) return;
      this.ready = true;
      this.busy = null;
      if (data.ok) {
        this.storage = data.storage;
        this.account = data.connected ? data : null;
        if (this.account) this.loadIssues(cx);
      } else this.error = data.error;
      cx.notify();
    });
    cx.notify();
  }

  connect(cx) {
    if (this.busy || !this.hasKey || this.storage?.available === false) return;
    let key = this.input.value().trim();
    this.input.set_value("");
    this.hasKey = false;
    const request = ++this.request;
    this.busy = "connect";
    this.listLoading = false;
    this.error = null;
    cx.spawn(async (cx) => {
      let handoff = null;
      let data = { ok: false, error: { code: "handoff_failed" } };
      try {
        const prepared = await client("prepare");
        if (!prepared.ok) data = prepared;
        else if (typeof prepared.handoff === "string") {
          handoff = prepared.handoff;
          this.handoff = handoff;
          if (request === this.request) {
            await writeTextFile(handoff, key, null);
            key = "";
            if (request === this.request) data = await client("connect", ["--handoff", handoff]);
          }
        }
      } catch {
        data = { ok: false, error: { code: "handoff_failed" } };
      } finally {
        key = "";
        // connect unlinks before validation; discard also covers a failed write or exec.
        if (handoff && !data.ok) await client("discard", ["--handoff", handoff]);
        if (this.handoff === handoff) this.handoff = null;
      }
      if (request !== this.request) return;
      this.busy = null;
      if (data.ok) {
        this.account = data;
        this.storage = data.storage;
        this.settings = false;
        this.confirmDisconnect = false;
        this.scope = "all";
        this.team = "";
        this.loadIssues(cx);
      } else this.error = data.error;
      cx.notify();
    });
    cx.notify();
  }

  connectionSettings(cx) {
    if (this.busy) return;
    ++this.request;
    this.listLoading = false;
    this.settings = true;
    this.settingsMenuOpen = false;
    this.teamMenu = false;
    this.confirmDisconnect = false;
    this.error = null;
    this.input.set_value("");
    this.hasKey = false;
    cx.notify();
  }

  back(cx) {
    if (this.busy) return;
    this.input.set_value("");
    this.hasKey = false;
    this.settings = false;
    this.error = null;
    this.loadIssues(cx);
  }

  disconnect(cx) {
    if (this.busy || !this.confirmDisconnect) return;
    const request = ++this.request;
    this.busy = "disconnect";
    this.listLoading = false;
    this.error = null;
    this.input.set_value("");
    this.hasKey = false;
    cx.spawn(async (cx) => {
      const data = await client("disconnect");
      if (request !== this.request) return;
      this.busy = null;
      if (data.ok) {
        this.account = null;
        this.storage = data.storage;
        this.settings = false;
        this.settingsMenuOpen = false;
        this.confirmDisconnect = false;
        this.issues = [];
        this.listError = null;
        this.page = { hasNextPage: false, endCursor: null };
      } else this.error = data.error;
      cx.notify();
    });
    cx.notify();
  }

  loadIssues(cx, append = false) {
    if (this.busy || !this.account || (append && this.listLoading)) return;
    if (append && (!this.page.hasNextPage || !this.page.endCursor)) return;
    const request = ++this.request;
    const args = ["--scope", this.scope];
    if (this.team) args.push("--team", this.team);
    if (append) args.push("--after", this.page.endCursor);
    else {
      this.issues = [];
      this.page = { hasNextPage: false, endCursor: null };
    }
    this.listError = null;
    this.openError = false;
    this.listLoading = true;
    this.failedAppend = append;
    cx.spawn(async (cx) => {
      const data = await client("issues", args);
      if (request !== this.request) return;
      this.listLoading = false;
      if (data.ok && Array.isArray(data.issues) && data.pageInfo) {
        const seen = new Set();
        this.issues = (append ? this.issues.concat(data.issues) : data.issues)
          .filter(issue => !seen.has(issue.id) && seen.add(issue.id));
        this.page = data.pageInfo;
      } else this.listError = data.error || { code: "invalid_response" };
      cx.notify();
    });
    cx.notify();
  }

  filter(scope, team, cx) {
    if (this.busy) return;
    this.scope = scope;
    this.team = team;
    this.teamMenu = false;
    this.loadIssues(cx);
  }

  draftIssue(issue, cx) {
    if (this.drafting) return;
    const context = focused();
    const target = context?.shown ?? context?.terminal ?? context?.agent;
    const agent = agents().find(item => item.address === target
      && item.space === context?.space && item.tab === context?.tab);
    if (!agent?.app || !["idle", "done", "working"].includes(agent.status)) {
      notify({ title: "Select an available agent", body: "Focus an agent terminal in this tab that is not blocked or in an error state, then click the issue again.", level: "warning" });
      return;
    }
    this.drafting = true;
    cx.spawn(async (cx) => {
      try {
        const result = await exec("python3", [appHome() + "/mods/linear-issues/draft.py",
          "--terminal", target, "--app", agent.app, "--issue", issue.identifier]);
        const data = JSON.parse(result.stdout);
        if (result.code !== 0 || data?.ok !== true) {
          notify({ title: "Issue prompt not confirmed", body: typeof data?.message === "string" ? data.message : "Check the agent input before clicking again.", level: "error" });
          return;
        }
        const current = focused();
        if (current?.space === context.space && current?.tab === context.tab
            && (current.shown ?? current.terminal ?? current.agent) === target) {
          run("pane.focus", { terminal: target });
        }
        notify({ title: `${issue.identifier} added to agent input`, body: "Review the draft and press Enter to send. Existing input was not cleared.", level: "success" });
      } catch {
        notify({ title: "Issue prompt not confirmed", body: "Check the agent input before clicking again. Python 3 and herdr-core must be available.", level: "error" });
      } finally {
        this.drafting = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  openUrl(url, cx) {
    if (!LINEAR_URL.test(url)) { this.openError = true; cx.notify(); return; }
    cx.spawn(async (cx) => {
      try {
        const platform = appWindow().platform;
        if (platform !== "macos" && platform !== "linux") throw new Error();
        const result = await exec(platform === "macos" ? "open" : "xdg-open", [url]);
        this.openError = result.code !== 0;
      } catch { this.openError = true; }
      cx.notify();
    });
  }

  hide() {
    this.input.set_value("");
    this.hasKey = false;
    this.settingsMenuOpen = false;
    this.confirmDisconnect = false;
    run("layout.hide", { id: props()?.panelId || "panel" });
  }

  async close() {
    ++this.request;
    this.input.set_value("");
    if (this.handoff) await client("discard", ["--handoff", this.handoff]);
  }

  button(id, label, action, t, disabled = false, selected = false) {
    return Button.new(id).h(28).px(8).flex().items_center().justify_center().flex_none()
      .rounded(6).border(1).border_color(selected ? t.accent : t.border)
      .bg(selected ? t.selected : t.background).text_size(12).text_color(selected ? t.foreground : t.muted)
      .hover(s => s.bg(t.hover).text_color(t.foreground)).focus(s => s.border_color(t.accent))
      .disabled(disabled).selected(selected).when(disabled, el => el.opacity(0.45))
      .accessibility_label(label).on_click(action).child(label);
  }

  iconButton(id, label, icon, action, t, disabled = false) {
    return Button.new(id).size(28).flex_none().flex().items_center().justify_center()
      .rounded(6).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
      .focus(s => s.bg(t.selected)).disabled(disabled)
      .when(disabled, el => el.opacity(0.45))
      .accessibility_label(label).tooltip(label).when(Boolean(action), el => el.on_click(action))
      .child(svg(icon).size(15));
  }

  note(text, t, danger = false) {
    return div().text_size(12).line_height("18px").whitespace_normal()
      .text_color(danger ? t.ansi1 : t.muted).child(text);
  }

  onboarding(t) {
    const replacing = Boolean(this.account);
    return v_flex().gap(14)
      .child(v_flex().gap(6)
        .child(div().text_size(17).font_semibold().child(replacing ? "Replace your connection" : "Your Linear work, right here"))
        .child(this.note(replacing ? "The current key stays saved until a replacement is verified. Herdr only reads issues; it never changes Linear." : "Connect once to browse your workspace’s issues by status. Herdr only reads Linear; it never creates or changes issues.", t)))
      .child(v_flex().p(12).gap(12).rounded(8).border(1).border_color(t.border).bg(t.surface)
        .child(v_flex().gap(6)
          .child(div().font_semibold().child("1 · Create a personal API key"))
          .child(this.note("Open Linear’s account security settings and create a key named Herdr.", t))
          .child(this.button("linear-security", "Open Linear security ↗", (_e, cx) => this.openUrl(SECURITY_URL, cx), t)))
        .child(v_flex().gap(6)
          .child(div().font_semibold().child("2 · Limit its access"))
          .child(this.note("Choose Read permission only, then choose the teams Herdr may access. Write and admin permissions are not needed.", t))
          .child(this.note("Can’t create a key? Your workspace admin may have disabled member API keys.", t)))
        .child(v_flex().gap(8)
          .child(div().font_semibold().child("3 · Paste the key once"))
          .when(this.busy !== "connect", el => el.child(Input.new(this.input).id("linear-key-input").w_full().h(36).px(10).rounded(6)
            .border(1).border_color(this.inputFocused ? t.accent : t.border).bg(t.input)
            .text_size(13).text_color(t.foreground).accessibility_label("Linear personal API key, masked")))
          .when(this.busy === "connect", el => el.child(this.note("Verifying your account, workspace, and team access…", t)))
          .child(this.button("linear-connect", this.busy === "connect" ? "Connecting…" : replacing ? "Verify replacement key" : "Connect Linear",
            (_e, cx) => this.connect(cx), t, Boolean(this.busy) || !this.hasKey || this.storage?.available === false))))
      .when(Boolean(this.error), el => el.child(this.note(errorText(this.error), t, true)))
      .when(this.storage?.available === false && !this.error, el => el.child(this.note(errorText({ code: "storage_unavailable" }), t, true)))
      .child(this.note("Saved locally in macOS Keychain or Linux Secret Service. A temporary file in a private folder transfers the key and is deleted before verification. No plaintext key is kept in Herdr settings.", t))
      .child(this.note("Your key stays on this desktop, even when the terminal uses a remote machine. Issues follow the key’s workspace and team access, not the current repository.", t))
      .when(replacing, el => el.child(this.button("linear-back", "← Back to issues", (_e, cx) => this.back(cx), t, Boolean(this.busy))))
      .when(!replacing, el => el.child(this.button("linear-status-retry", this.busy === "status" ? "Checking…" : "Retry connection check", (_e, cx) => this.checkStatus(cx), t, Boolean(this.busy))));
  }

  settingsMenu(t) {
    const a = this.account;
    const disabled = Boolean(this.busy);
    const menuItem = (id, label, action, danger = false) =>
      Button.new(id).w_full().min_h(30).px(8).py(6).flex().items_center().justify_start().rounded(4)
        .text_size(12).text_color(danger ? t.ansi1 : t.foreground)
        .hover(s => s.bg(t.hover)).focus(s => s.bg(t.selected))
        .disabled(disabled).when(disabled, el => el.opacity(0.45))
        .accessibility_label(label).on_click(action).child(label);
    return Popover.new("linear-settings-menu").anchor("top_right")
      .open(this.settingsMenuOpen)
      .on_open_change((open, cx) => {
        this.settingsMenuOpen = open;
        this.confirmDisconnect = false;
        cx.notify();
      })
      .trigger(this.iconButton("linear-settings-toggle", "Linear settings", "mods/workspace-chrome/settings.svg",
        null, t, disabled).selected(this.settingsMenuOpen))
      .content(v_flex().w(260).p(6).gap(4).rounded(8).border(1).border_color(t.border)
        .bg(t.surface).text_color(t.foreground)
        .child(v_flex().px(8).py(6).gap(4)
          .child(div().font_semibold().text_size(13).whitespace_normal().child(a.workspace.name))
          .child(div().text_size(11).text_color(t.muted).whitespace_normal().child(a.viewer.name))
          .child(div().text_size(11).text_color(t.muted).child("Read-only")))
        .child(div().h(1).bg(t.border))
        .when(!this.confirmDisconnect, el => el
          .child(menuItem("linear-settings", "Connection", (_e, cx) => this.connectionSettings(cx)))
          .child(menuItem("linear-disconnect", "Disconnect", (_e, cx) => {
            this.confirmDisconnect = true;
            cx.notify();
          }, true)))
        .when(this.confirmDisconnect, el => el.child(v_flex().p(6).gap(8)
          .child(this.note("Remove the key from this desktop? This does not revoke it in Linear.", t))
          .child(menuItem("linear-disconnect-confirm", this.busy === "disconnect" ? "Removing…" : "Remove saved key",
            (_e, cx) => this.disconnect(cx), true))
          .child(menuItem("linear-disconnect-cancel", "Cancel", (_e, cx) => {
            this.confirmDisconnect = false;
            cx.notify();
          })))));
  }

  assigneeAvatar(user, t) {
    const name = user?.name || "Unassigned";
    const initials = user?.name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
    return div().size(22).flex_none().rounded_full().overflow_hidden()
      .bg(t.surface).text_color(t.muted).flex().items_center().justify_center()
      .tooltip(name).accessibility_label(`Assigned to ${name}`)
      .child(user?.avatarPath
        ? image(user.avatarPath).size_full().rounded_full()
        : user
          ? div().text_size(9).font_semibold().child(initials)
          : svg("mods/linear-issues/unassigned.svg").size(13));
  }

  issueGroup(group, t) {
    const collapsed = this.collapsedGroups.has(group.key);
    return v_flex().gap(4).flex_none()
      .child(Button.new(`linear-group-${group.key}`).w_full().flex_none().flex().items_center().justify_start()
        .px(8).py(8).gap(8).rounded(6).hover(s => s.bg(t.hover)).focus(s => s.bg(t.selected))
        .accessibility_label(`${collapsed ? "Expand" : "Collapse"} ${group.name}, ${group.issues.length} loaded issues`)
        .on_click((_e, cx) => {
          if (this.collapsedGroups.has(group.key)) this.collapsedGroups.delete(group.key);
          else this.collapsedGroups.add(group.key);
          cx.notify();
        })
        .child(div().text_color(t.muted).child(collapsed ? "▸" : "▾"))
        .child(div().min_w(0).font_semibold().whitespace_normal().child(group.name))
        .child(div().text_size(11).text_color(t.muted).child(String(group.issues.length))))
      .when(!collapsed, el => el.children(group.issues.map(issue =>
        Button.new(`linear-issue-${issue.id}`).w_full().flex_none().flex().items_start().justify_start()
          .px(10).py(8).gap(10).rounded(6).hover(s => s.bg(t.hover)).focus(s => s.bg(t.selected))
          .disabled(this.drafting)
          .accessibility_label(`${issue.identifier}: ${issue.title}. Assigned to ${issue.assignee?.name || "Unassigned"}. Draft an analysis prompt in the focused agent.`)
          .on_click((_e, cx) => this.draftIssue(issue, cx))
          .tooltip(issue.title)
          .child(div().w(62).flex_none().text_size(11).line_height("20px").text_color(t.muted).truncate().tooltip(issue.identifier).child(issue.identifier))
          .child(div().flex_1().min_w(0).text_size(13).line_height("20px").whitespace_normal().child(issue.title))
          .child(this.assigneeAvatar(issue.assignee, t)))));
  }


  issueList(t) {
    const teams = this.account.teams;
    const team = teams.find(item => item.id === this.team);
    const scopeText = this.scope === "mine" ? "assigned to you" : "for anyone";
    const teamText = team ? `in ${team.name}` : "across accessible teams";
    return v_flex().gap(10)
      .child(h_flex().gap(6)
        .child(this.button("linear-all", "All", (_e, cx) => this.filter("all", this.team, cx), t, Boolean(this.busy), this.scope === "all"))
        .child(this.button("linear-mine", "Assigned to me", (_e, cx) => this.filter("mine", this.team, cx), t, Boolean(this.busy), this.scope === "mine")))
      .child(Button.new("linear-team-toggle").w_full().min_h(30).px(8).py(6).flex().items_center().rounded(6)
        .border(1).border_color(t.border).hover(s => s.bg(t.hover)).focus(s => s.border_color(t.accent))
        .disabled(Boolean(this.busy)).accessibility_label(`Filter by team: ${team?.name || "All teams"}`)
        .on_click((_e, cx) => { this.teamMenu = !this.teamMenu; cx.notify(); })
        .child(div().flex_1().min_w(0).text_size(12).whitespace_normal().child(team ? `${team.key} · ${team.name}` : "All teams"))
        .child(div().pl(6).text_color(t.muted).child(this.teamMenu ? "▴" : "▾")))
      .when(this.teamMenu, el => el.child(v_flex().id("linear-team-menu").max_h(200).min_h(0).overflow_y_scrollbar()
        .p(6).gap(4).rounded(6).border(1).border_color(t.border).bg(t.surface)
        .children([{ id: "", name: "All teams", key: "" }, ...teams].map(item => Button.new(`linear-team-${item.id || "all"}`)
          .w_full().flex_none().flex().items_start().p(8).rounded(4).selected(this.team === item.id)
          .bg(this.team === item.id ? t.selected : t.surface).hover(s => s.bg(t.hover)).focus(s => s.border_color(t.accent))
          .accessibility_label(item.name).on_click((_e, cx) => this.filter(this.scope, item.id, cx))
          .child(div().w_full().text_size(12).whitespace_normal().child(item.key ? `${item.key} · ${item.name}` : item.name))))))
      .child(this.note("Click an issue to add an analysis prompt to the focused agent. Press Enter there to send it.", t))
      .when(Boolean(this.listError), el => el.child(v_flex().p(10).gap(8).border(1).border_color(t.border).rounded(8)
        .child(this.note(errorText(this.listError), t, true))
        .child(this.note("Results are not current. Your saved connection has been kept.", t))
        .child(this.button("linear-list-retry", this.failedAppend ? "Retry loading more" : "Retry issues", (_e, cx) => this.loadIssues(cx, this.failedAppend), t, Boolean(this.busy)))
        .when(RECONNECT.includes(this.listError?.code), box => box.child(this.button("linear-reconnect", "Reconnect with a new key", (_e, cx) => this.connectionSettings(cx), t, Boolean(this.busy))))))
      .when(!this.listError, el => el
        .children(issueGroups(this.issues).map(group => this.issueGroup(group, t)))
        .when(this.listLoading, box => box.child(this.note(this.issues.length ? "Loading more issues…" : "Loading issues…", t)))
        .when(!this.listLoading && !this.issues.length, box => box.child(v_flex().p(12).gap(6).rounded(8).border(1).border_color(t.border)
          .child(div().font_semibold().child("No issues"))
          .child(this.note(`There are no issues ${scopeText} ${teamText}. Archived issues are excluded.`, t))))
        .when(this.page.hasNextPage, box => box.child(this.button("linear-more", this.listLoading ? "Loading…" : "Load more", (_e, cx) => this.loadIssues(cx, true), t, this.listLoading || Boolean(this.busy))))
        .when(!this.listLoading && this.issues.length > 0, box => box.child(this.note(`${this.issues.length} loaded${this.page.hasNextPage ? " · more available" : " · all matching issues"} · group counts reflect loaded issues`, t))));
  }

  render() {
    const t = theme();
    const connected = Boolean(this.account);
    return v_flex().id("linear-issues").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border(1).border_color(t.border).text_color(t.foreground).text_size(12)
      .child(h_flex().h(44).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/linear-issues/issues.svg").size(15).text_color(t.accent))
        .child(div().flex_1().font_semibold().child("Linear Issues"))
        .when(connected && !this.settings, el => el
          .child(this.iconButton("linear-refresh", "Refresh issues", "mods/linear-issues/refresh.svg",
            (_e, cx) => this.loadIssues(cx), t, Boolean(this.busy) || this.listLoading))
          .child(this.settingsMenu(t)))
        .child(this.iconButton("linear-close", "Close Linear Issues", "mods/pane/close.svg", () => this.hide(), t)))
      .child(v_flex().id(`linear-content-${this.settings ? "settings" : "issues"}-${this.scope}-${this.team}`)
        .flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(14)
        .when(!this.ready, el => el.child(this.note("Checking your local Linear connection…", t)))
        .when(this.ready && connected && !this.settings, el => el
          .when(Boolean(this.error), box => box.child(this.note(errorText(this.error), t, true)))
          .child(this.issueList(t)))
        .when(this.ready && (!connected || this.settings), el => el.child(this.onboarding(t)))
        .when(this.openError, el => el.child(this.note("Could not open the browser. Only secure linear.app links are allowed; check your default browser and try again.", t, true))));
  }
}
