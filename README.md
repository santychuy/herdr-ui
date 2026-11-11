# herdr-ui

Personal layout for [Herdr](https://herdr.dev), with custom mods, keybindings, and themes for everyday agent work.

![Santychuy's Herdr layout with a project sidebar, subscription usage, and an agent terminal](preview.png)

## What's included

- **Project sidebar** — local and remote projects with live threads, status indicators, and custom icons.
- **Cmd+K switcher** — jump between agents, terminals, projects, and commands.
- **Subscription usage** — provider quotas and reset times in the sidebar.
- **Linear Issues** — browse issues and add an issue prompt to the focused agent's draft.
- **Personal styling** — slim tabs, rounded terminal panes, and Paper / GitHub Dark themes.
- **Side panels** — Files, Changes, My PRs, Linear Issues, and locally rendered Mermaid diagrams.

This is a separate layout, not a separate app or a replacement for Herdr.

## Use it

See [Setup and syncing](docs/setup.md) for installing on another machine, importing the configuration, and exporting changes back to this repository.

For shortcuts, mod behavior, and implementation details, see [Customization notes](docs/customization.md).

## Rebuild or share

[RECIPE.md](RECIPE.md) is the build-from-empty brief for **Santychuy**: appearance, interactions, dependencies, permissions, and acceptance checks. This repository root is the layout's gallery package: `layouts/`, all required custom `mods/`, `themes/`, `keys.json`, `programs.json`, the recipe, and the inspected `preview.png`.

The public repository uses the `herdr-layout` topic for discovery in the [Herdr gallery](https://herdr.dev/gallery/). Herdr documents indexing within an hour; community previews are screened before appearing.
