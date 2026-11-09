# herdr-ui

Herdr desktop app setup. Tested with Herdr.app 0.1.8.

This repo is the shareable copy. The app still reads `~/.config/herdr-app`. Do not set `HERDR_APP_HOME`.

Shipped layouts, mods, `frame/`, and `icons/` stay out. The app replaces those on launch. Custom layouts, mods, and themes are copied on the next `./export.sh` once they exist.

## New machine

Install the Herdr app, then paste this to an agent:

```text
Clone https://github.com/santychuy/herdr-ui and run ./import.sh from that clone.
import.sh copies settings.json and keys.json to ~/.config/herdr-app, and copies any custom layouts, mods, themes, or programs.json in this repo.
Do not copy view.json, window.json, data/, telemetry/, frame/, icons/, or the shipped layouts and mods.
The app applies settings and keys live.
```

## After changing the live app config

From this clone, run `./export.sh`, review `git diff`, commit, and push.

Current personal files include `settings.json`, `keys.json`, and custom mods under `mods/`. Cmd+K opens the custom agent-first `my-palette`. The old Cmd+P picker binding is removed; other keybindings retain their configured layout overrides.

The `my-main` layout uses Herdr's built-in `paper` theme in light mode and the custom `github-dark` theme in dark mode. The palette follows [TerminalColors GitHub Dark](https://terminalcolors.com/themes/github/dark/) and its [Alacritty export](https://terminalcolors.com/downloads/alacritty/github-dark.toml): terminal background, foreground, selection, cursor, and all 16 ANSI colors. Herdr derives panel colors from the theme. The normal black ANSI slot is a shadow color (2.48:1 contrast against the terminal background); the foreground is 17.38:1, and it is 7.19:1 on the selection background.


In `my-main`, the bottom toolbar and separate Agents inventory are removed. Project/thread navigation fills the sidebar above Accounts. Accounts retains its title-case, 11.5-pixel medium-weight dim heading and 1-pixel theme-border top divider. Drag that divider to resize Accounts independently against the navigation area; its requested height is 180 pixels with an 80-pixel minimum. The Add machine footer button is removed.

The sidebar header places **Local / Remote → Search → Settings → Sidebar toggle** in one vertically centered row. The scope switch fills the available left-hand space, with an 8-pixel gap before the icon group at normal widths; the three icons retain equal 26-pixel button boxes and 4-pixel gaps. Tighter widths use compact icon controls, and Local/Remote falls back to monitor/server icons with tooltips when the labels do not fit. macOS window-button space is reserved with zoom accounted for. Settings retains its tooltip, accessible label, and update-available indicator.

The main workspace's top navigation (`my-tabs`) has no bottom border and uses the same theme `canvas` background as the workspace body. Inactive tabs and panel buttons also use `canvas` to avoid contrasting patches; selected and hover states remain visible.

The main content starts 2 logical pixels below the top navigation, retaining 8-pixel side and bottom insets. `work-body.padding: [2, 8]` supplies vertical/horizontal padding; the fixed 6-pixel `work-bottom-inset` spacer preserves the original bottom inset because layout padding pairs top and bottom.

Terminal interior padding is `terminal_padding: [10, 4]`: 10 logical pixels left/right and 4 top/bottom. This is separate from the workspace's outer insets.

Subscriptions lists provider-native OAuth logins (Codex, managed Codex accounts, Claude Code, and OpenCode) and uses Pi OAuth only as a fallback. API keys and CodexBar's generic provider entries are excluded. Matching provider account identities merge; native credentials are queried first, and a matching Pi login supplies usage only when the native login has no usable reading. Account names, emails, and harness sources are not sent to the sidebar. Provider APIs supply quota/spend status; a saved login alone does not prove a paid plan is active.

The **All** button is disabled; the account-details popover and standalone details view are removed, including manual refresh and email-reveal controls. Provider names and usage status appear inline; unavailable quotas explain why. Spend summaries remain inline with quota data. Discovery remains machine-aware and refreshes automatically every two minutes. Usage, remaining amounts, reset times, and status details remain accessible without descriptive hover popups.

Switching between machines clears the previous machine's account snapshot immediately and starts discovery for the selected machine. Rendering does not issue synchronous redraw notifications; timer refreshes and asynchronous completion request redraws outside the render phase. Late responses from a previously selected machine are ignored.

Provider logos use [LobeHub Icons](https://github.com/lobehub/lobe-icons), the library used for Herdr's agent icons. Codex uses the OpenAI mark; Anthropic uses the Claude mark. OpenAI, Claude, OpenRouter, and Meta SVGs are bundled in the live mod's `icons/` directory with the MIT license; Grok and OpenCode reuse Herdr's installed icons. Rendering is theme-tinted and requires no runtime downloads. Unknown providers retain their text name rather than showing an incorrect logo.

The removed workspace-status toolbar no longer shows machine, branch, agent counts, or resize-mode messages. Its toolbar-dependent `cmd-r` resize shortcut is removed.

Terminal panes in `my-main` use a 1-pixel black (`#000000`) focus border; unfocused panes retain the neutral theme border.

The layout uses the custom `my-pane` header (cloned from `pane`) with 10-pixel top-corner rounding to match the pane radius and prevent its background from protruding into the rounded outline.

`terminal_opacity: 0` lets the rounded pane frame supply the terminal's default background instead of painting a square terminal background over its bottom corners. The pane background and black focus border remain.

The custom `my-spaces` sidebar presents Spaces as **Projects**, retaining project menus, worktree grouping, Git details, machine connection controls, and drag ordering. Its Local / Remote switch lives only in the top header and shares its persisted scope with project navigation. Filtering does not change the focused space; choosing a scope returns from Attention to Projects. Only the selected project expands its live threads. Local lists only this computer's spaces; its + button explicitly creates a local space. Remote groups projects under their machines. Selecting a project through navigation updates the header's local/remote selection and unfolds its machine.

The sidebar header omits both the Herdr logo and label, retaining the scope switch, search, settings, and sidebar controls.

## Live threads and attention

The sidebar uses native Herdr tabs as live thread workspaces, not persistent conversation IDs. Named tabs supply their thread titles; otherwise a meaningful agent title or program is used. Shell and mod tabs remain accessible. The selected project alone expands its threads, directly beneath the project without a separate Threads heading. A **+** at the project cell's right edge selects that project and opens the existing new-terminal/agent menu on its machine. Theme-colored tree connectors link the project to its thread rows: intermediate rows share a continuous vertical trunk, and the final row ends in a rounded elbow. Working/Reviewed groups retain folding and show their visible threads as nested branches. Clicking a thread focuses its existing agent (the most urgent agent tree when a tab contains several), or selects its tab for non-agent work. Right-click retains the native tab menu, including rename and close.

Project and thread rows have no selection or hover background fill; active work is distinguished by text emphasis and status indicators. Colored project avatars remain. Rows use 6-pixel left and 5-pixel right padding; standard project and thread rows are 28 pixels tall, with thread vertical padding reduced to 2 pixels. Tree indentation and elbow positions match the tighter spacing. The header sidebar toggle, Projects +, attention count, project-cell +, and thread statuses share a trailing-column center 23 logical pixels inside the sidebar's right edge. Counts use centered 26-pixel slots and thread status glyphs use centered 20-pixel slots, so digit widths and dot/spinner changes do not move the column.

**Needs attention** shows a global count of threads with blockers/errors or unread completed replies, across local and remote projects. Clicking it replaces the project navigation with an attention view: blockers first, unread replies next, with stable tab order for equal priority. The current thread stays visible separately when it needs no attention. **‹ Projects** returns to navigation. Nothing changes focus merely because status updates arrive.

Working threads are folded into a **Working** group unless current or pinned. Hover a thread to pin/unpin it with native `terminal.pin`, or mark finished work **Reviewed** with native `tab.settle`; busy or blocked trees cannot be marked reviewed. Reviewed work goes into a folded group, keeps running, and leaves the normal tab bar unless current or active again. Clicking it shows it again; the bring-back control uses `tab.unsettle`. Reviewing never closes a pane, kills a terminal, or deletes a conversation. Pins lead project thread rows but never outrank blockers in the global attention view.

Subagent problems roll up to their parent thread, including errors from child terminals without panes. A parent's unread reply remains visible even while children continue working; child completion alone is not a separate unread reply. The subagent count expands live children for inspection with `terminal.peek`. Machine-qualified IDs keep local and remote work separate; unavailable/loading machines show unavailable state instead of idle/completed work. Native agent navigation follows the sidebar's thread order.

Presentation state remembers the attention/projects view and folded Working/Reviewed groups. No agent-status polling, external session database, or Atuin installation is added. Historical search, resume, and fork are intentionally not part of this live-thread design. Existing top-bar tabs remain the workspace controls.

Commands available through `herdr-app do`: `my-spaces.attention`, `my-spaces.projects`, `my-spaces.review` (current thread), `my-spaces.working`, and `my-spaces.reviewed` (toggle that group's visibility in the selected project). No additional keyboard shortcuts are claimed.


## Cmd+K switcher

Cmd+K opens `my-palette` with **Agents** selected on each opening. Four views share one search field:

- **Agents — default:** live primary agents, split-pane agents, and reporting/recognized subagents only. Plain shells, non-agent child programs, and mod-only tabs never fill the agent list. Working, blocked, unread, and idle agents remain visible under **All**; choose **Working** to narrow to that status.
- **Terminals:** individual terminals across local and remote projects, including shells, agent-hosting terminals, and background descendants. Split panes have separate rows; promoted child terminals are not duplicated. Each row shows project, machine, tab, terminal address, and live folder when available. Mod-only tabs remain accessible here as explicitly labeled **Mod tab** entries.
- **Projects:** spaces across local and remote machines, with thread counts, folders, and rolled-up status.
- **Commands & keys:** the existing searchable command catalog, recent commands, and effective shortcut labels for the current layout.

Agent rows show their harness's Herdr program icon in a fixed left-hand column, including split-pane agents and subagents. Terminal rows use their own program icons. Monochrome glyphs follow the theme; full-color logos keep their original colors. Rows without an icon retain alignment without an invented logo.

`programs.json` assigns `omp` the gradient π mark from the [official homepage header](https://omp.sh/), bundled as `mods/my-spaces/omp.svg` with its MIT license. The pink/purple/cyan logo has no favicon background; its original geometry is preserved and its OKLCH gradient stops are converted to sRGB for native SVG rendering. It replaces the generic agent icon across the sidebar, tabs, pane headers, and switcher, without runtime downloads. Existing import/export scripts carry both the override and its asset.

Search matches native tab names/numbers, agent titles, terminal addresses, project/machine context, program names, and folders. For example, `OpenKlub Tab 1` in **Terminals** lists that tab's individual terminals. Agents, terminals, and projects support **All**, **Needs attention**, **Working**, **Idle**, and **Reviewed** filters. Switching views resets the status filter to **All** while retaining the search query. Click the sort control to cycle **Attention first**, **Recent activity**, **Project**, and **Name A–Z**; the sort choice persists. Search preserves the chosen ordering.

Attention puts blockers/errors before unread replies, then working and idle threads. It uses the sidebar's existing thread aggregation: child problems roll up to the parent, child completion is not an unread parent reply, and unavailable machines are not presented as completed or idle. Unavailable entries cannot be opened. Activity sorting uses reported state-change timestamps, not fabricated visit or session ages.

↑/↓ and Page Up/Down move selection; Enter opens it. **Tab** cycles forward through Agents → Terminals → Projects → Commands & keys → Agents. **Shift+Tab** cycles the current view's filters forward through All → Needs attention → Working → Idle → Reviewed → All, without changing views or the search query. Shift+Tab does nothing in Commands & keys, which has no filters. View/filter changes reset row selection and scroll while keeping the search input focused; Escape closes. Choosing an agent uses `agent.focus`; terminal rows with panes use `pane.focus` with the exact pane ID, background terminals use `agent.focus` or `terminal.peek`, and mod-only tabs use `tab.select`. Filtering and sorting never change terminal focus. Exited terminals are excluded; if no agents are live, the default view stays empty instead of falling back to shells. This is live navigation, not historical conversation search/resume.

Tab navigation uses native GPUI actions, not a bubbling raw-key handler. `cx.bind_keys` scopes Tab/Shift+Tab to `HerdrPalette` and `HerdrPalette > Input`; the latter matches at the native search input's depth so its built-in Tab editing actions cannot take precedence. Palette action handlers consume propagation and restore input focus. Registration is once per app session; no global Tab override or desktop key injection is used. See [GPUI keybinding precedence](https://gpui-kit.com/docs/keybinding).

This replaces the custom setup's old sidebar search/picker access. The sidebar button, Cmd+P binding, and palette command that opened the picker are removed. The old picker's inline new-tab/new-space and tab-close actions are not copied into search results; creation/management commands remain in **Commands & keys**. Herdr's shipped `picker` mod is left untouched because stock layouts still use it; the custom header and palette no longer open it.

The live files are `~/.config/herdr-app/mods/my-palette/`; this repository carries the portable copy without generated type files. Herdr restricts module imports to the current mod, so its `threads.js` is an unchanged local copy of `my-spaces/threads.js`; keep those copies aligned when changing thread semantics.

For command-driven inspection, open with `herdr-app do mod.open --name my-palette`, then send `my-palette.agents`, `my-palette.terminals`, `my-palette.projects`, or `my-palette.commands`. The former combined `my-palette.threads` view command is removed. `my-palette.next-view` and `my-palette.next-filter` dispatch the same native actions as Tab and Shift+Tab down the current window's real focus path. Other controls are `my-palette.filter-<all|attention|working|idle|reviewed>`, `my-palette.sort-<attention|activity|project|name>`, `my-palette.search:<query>`, and `my-palette.open-selected`. Commands target shown copies only. Validate with `herdr-app check ~/.config/herdr-app/mods/my-palette`, `status`, and a screenshot inspected after the next rendered frame.


## Linear Issues panel

`my-main` adds **Issues** beside Files, Changes, and My PRs. It uses the same right-side panel and per-space panel selection. The Linear connection belongs to the local desktop user; switching to a remote terminal does not copy credentials to that machine.

The Issues toolbar button and panel header use the [Linear logo from Simple Icons](https://github.com/simple-icons/simple-icons/blob/develop/icons/linear.svg), bundled locally as `mods/linear-issues/issues.svg` and tinted by the current theme. No runtime download is required. Brand usage remains subject to [Simple Icons’ disclaimer and the brand’s guidelines](https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md).

### Authentication choice

| Method | Onboarding | Requirements |
|---|---|---|
| Personal API key (implemented) | Create a read-only key and paste it once into a masked field | A Linear account allowed to create API keys; no hosted service or OAuth registration |
| OAuth with PKCE | Browser consent instead of copying a key | A registered OAuth application/client ID, configured callback URI, state/PKCE validation, and access/refresh-token lifecycle |

Linear recommends OAuth for public integrations and API keys for personal scripts. PKCE permits a native client without an embedded client secret; it still requires an application registration. This mod uses personal keys so the first installation can connect without a developer-operated authentication service.

### First connection

1. Open **Issues**.
2. Follow the link to [Linear → Settings → Account → Security & Access](https://linear.app/settings/account/security).
3. Create a key named **Herdr**, grant **Read** only, and choose all intended teams or restrict it to specific teams. Write/Admin permissions are not needed. If key creation is unavailable, a workspace administrator must permit member API keys.
4. Paste the key into the masked field and connect. Do not paste it into agent chat or a terminal command.
5. The panel verifies the account and lists accessible issues grouped by status. The header’s Settings gear shows the connected workspace/user and read-only access.

The helper requires Python 3. Persistent credentials use macOS Keychain or Linux Secret Service (`secret-tool`); there is no plaintext persistent fallback. A brief handoff file inside a private, owner-only directory under `data/linear-issues/credentials` transfers the key from the native input to the helper and is deleted after connection. Keys are not put in command arguments, shared mod state, layouts, or exported settings. Do not copy the app's `data/` directory between installations.

If the app crashes during that handoff, an abandoned file can remain in the private directory. Status/setup removes matching stale handoffs after one hour; an in-flight connection is not deleted. The credential store is the desktop user's OS store, not an app-exclusive security boundary.

### Browsing and account scope

- The main view starts with assignee/team filters and the status groups, without a redundant scope summary or account card. Header controls are icon-only Refresh, Settings, and Close, with tooltips and accessible labels.
- **Settings** opens a native popover containing account details, **Connection** (replace the key), and **Disconnect**. Escape or an outside click dismisses it. Disconnect requires a separate **Remove saved key** confirmation; canceling or dismissing the menu disarms it.
- **All** shows every non-archived issue the key can read in its Linear workspace, including unassigned issues. It is not limited to the current Git repository or active terminal.
- **Assigned to me** narrows by the authenticated user's ID. The team selector further narrows either view.
- All workflow statuses are eligible, including Done, Canceled, and Duplicate; archived issues remain excluded.
- Issues are grouped by the exact status name within its category. Identical names in the same category share a group across teams. Categories follow Triage → Backlog → Unstarted → Started → Completed → Canceled → Duplicate, followed by any unknown categories. Within a category, groups follow workflow `position`, then name; when teams give a shared status different positions, the lowest position wins.
- Click a status header to fold or expand its issues. Headers have no resting background, and each loaded-issue count sits beside its status name on the left. Groups start expanded; each fold choice survives refreshes, filtering, and loading more while the panel instance remains mounted.
- Issue rows place the identifier, wrapping title, and circular assignee photo side by side. Hover the photo to see the assignee’s full name; it also remains in the accessible label. Missing photos use initials, and unassigned issues use a neutral person icon. Oversized identifiers truncate within their column and remain available in a tooltip.
- Results are fetched most recently updated first, in pages of 50, then grouped locally. Use **Load more** to reach the rest; the first page is not the complete workspace inventory. Header counts represent loaded issues, not server-wide totals. Within each group, issues retain their API order.
- Refresh is explicit; there is no background issue polling. Clicking an issue inserts `Let's analyze this linear issue: {IDENTIFIER}` into the focused agent's input, without pressing Enter. The identifier is Linear's human-readable key (for example `RIFF-62`), not its internal UUID or title. This integration never creates, updates, or deletes Linear issues.
- Disconnect removes the saved credential on this computer; it does not revoke the key in Linear. Revoke it separately from Security & Access if needed.

Issue prompts are inserted at the current input cursor without clearing existing text or changing the clipboard. The click targets the actual focused agent in the current space/tab, including remote agents and temporarily shown replacement terminals; it never falls back to an unrelated last-viewed agent. Shells and blocked/errored agents are rejected. `draft.py` rechecks the live agent identity and uses the [core framed attach protocol](https://github.com/herdrdev/herdr-core/blob/master/schema/README.md) for literal single-line input; it does not use `hc send`, which would also submit Enter. After ambiguous delivery errors, inspect the agent draft before clicking again to avoid duplicates.

### Requirements and research

The API endpoint is `https://api.linear.app/graphql`. Personal keys use the raw key in the `Authorization` header; OAuth tokens instead use `Bearer`. GraphQL errors must be handled even when HTTP status is 200. Team restrictions and workspace policy determine the accessible issue set.

The issue query selects `state { id name type position }` and nullable `assignee { id name avatarUrl }`. Workflow states are team-specific and names are customizable. `type` is the broad category, not the displayed status: both **In Progress** and **In Review** can be `started`, so grouping only by `type` would incorrectly merge them. Preserve `name` for headers and use `type` plus numeric `position` for ordering; do not infer categories from English names. See [Linear issue statuses](https://linear.app/docs/issue-property#issue-status) and the [WorkflowState schema](https://studio.apollographql.com/public/Linear-API/variant/current/schema/reference/objects/WorkflowState).

Herdr loads photos from local files. The helper caches supported `avatarUrl` images under `data/linear-issues/avatars/`, keyed by URL so repeated assignees and later pages reuse the same file. Image requests accept only HTTPS on Linear’s `public.linear.app` CDN, never include the API key, never follow redirects, and are size/time bounded. Missing, unsupported, or failed image downloads leave the issue visible with initials instead. The cache stays local and must not be exported with this setup.

Primary references: [GraphQL and authentication](https://linear.app/developers/graphql), [API-key permissions](https://linear.app/docs/api-and-webhooks), [OAuth/PKCE and refresh](https://linear.app/developers/oauth-2-0-authentication), [filtering](https://linear.app/developers/filtering), [cursor pagination](https://linear.app/developers/pagination), and [rate limits](https://linear.app/developers/rate-limiting).

## Diagrams panel

**Diagrams** in the top navigation opens a native SVG viewer in the right-side panel. Agents can write Mermaid source to a file, then publish it directly to that panel:

```sh
node "$HOME/.config/herdr-app/mods/diagrams/render.mjs" publish \
  --file /absolute/path/diagram.mmd --title "Diagram title"
```

The command renders with the bundled **Pele 1.13.0**, atomically publishes the source/SVG revision under the app's `data/diagrams/`, and opens the panel. It returns JSON; `ok` confirms rendering and `shown` confirms that opening the app panel succeeded. Use `--no-show` to render without changing the window, or `--home /absolute/app-home` to target another installation. Failed Mermaid renders leave the previous valid diagram intact.

The viewer uses full-color SVG images, not theme-tinted icon masks. It renders for the available width and converts Pele's CSS variables into the current Herdr theme's concrete colors. Width/theme changes reflow the diagram; zoom/scroll controls handle larger diagrams. Links and external images inside diagrams are disabled. Source, SVG, and rendering stay local; there is no browser, hosted rendering service, API key, or runtime package download.

The trash icon beside Refresh and Close appears when a diagram is available. **Clear diagrams permanently deletes all saved revisions, copied Mermaid sources, manifests, and cached SVGs under `~/.config/herdr-app/data/diagrams/`**, then empties the panel. It leaves original input files outside that store untouched. With no diagram, the centred placeholder shows a clickable card with the prompt on the left and a copy icon at the top-right. Clicking the card copies the whole prompt; the icon briefly becomes a green check mark to confirm, then returns to the copy icon. Failed deletions show an error and keep Clear available for retry.

Diagram navigation:
- Scroll vertically or horizontally to move around tall or wide diagrams; **Shift + scroll** moves horizontally.
- **Click and drag anywhere in the diagram body**, including empty space, to move the SVG freely in any direction—even when it fits inside the panel. A separate input layer covers the canvas above the SVG without showing a hover hint. Releasing the button or leaving the canvas ends the drag.
- Hold **Ctrl** or **Cmd** while scrolling to zoom around the pointer, from **25% to 400%**. The **−**, **+**, and **100%** controls remain available.
- **Fit width** fits the diagram horizontally and restores its top-left position if it has been moved offscreen. Resizing preserves the canvas position; a newly published revision starts at the top-left.
- True trackpad pinch is not available in the installed Herdr mod API; modified-wheel zoom is used instead.

Requires **Node.js 20+**. The self-contained Pele bundle and license live in the mod's `vendor/` directory; no `node_modules` installation is required. The agent workflow is documented in this repository's `AGENTS.md`. New publish operations replace the latest diagram; this is not a multi-document diagram library.

Hover the info icon beside **Diagrams** to reveal a short fade-in acknowledgement, **Powered by [Pele](https://github.com/obsidianmd/pele)**. The card stays visible while hovering either the icon or the card, with a brief grace period for moving between them. The icon has no click action; clicking **Pele** opens its repository in the default browser.

Primary references: [Pele API](https://pele.run/api), [theming](https://pele.run/theming), [security](https://pele.run/security), and [source](https://github.com/obsidianmd/pele).
