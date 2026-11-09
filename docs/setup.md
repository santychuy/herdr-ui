# Setup and syncing

[← README](../README.md)

This repository is a shareable copy of my Herdr configuration, not the app's live config directory. Herdr reads `~/.config/herdr-app`; do not point `HERDR_APP_HOME` at this clone.

## Use on a new machine

Install and launch [Herdr](https://herdr.dev) first. You'll need Git and Python 3 for the sync scripts and helper mods; custom project-icon imports also require Node.js.

```sh
git clone https://github.com/santychuy/herdr-ui.git
cd herdr-ui
./import.sh
```

Open Herdr's layout switcher with **Cmd+Shift+L** and select **Santychuy**. Settings and keybindings apply live; custom mods and layouts hot-reload.

**Import replaces your settings and keybindings**, plus any matching custom layout, mod, theme, and program-override files. It backs up existing `settings.json` and `keys.json` with a `.bak-import-<timestamp>` suffix; other overwritten files are not backed up. Save your own configuration before importing.

Prefer asking an agent? Give it:

```text
Clone https://github.com/santychuy/herdr-ui and run ./import.sh from that clone.
The live app config stays at ~/.config/herdr-app; do not set HERDR_APP_HOME.
Then help me select the Santychuy layout.
```

For Linear setup, see [First connection](customization.md#first-connection). Provider logins, Linear credentials, and custom project-icon choices are local to each machine and are not transferred by these scripts.

## Save changes from the live app

Make UI changes in `~/.config/herdr-app`, then run this from your clone:

```sh
./export.sh
git diff
```

Review the changes, then commit and push what you want to share. On another machine, pull the repository and run `./import.sh` again.

**Export replaces this clone's `layouts/`, `mods/`, and `themes/` directories** with the live custom files. Import any repo-only changes you want to keep before exporting.

## What gets synced

- `settings.json` and `keys.json`.
- Custom layouts, mods, and themes.
- `programs.json`, when present.

App-shipped layouts and mods, `frame/`, and `icons/` are left to Herdr. Personal state—including `shared.json`, `view.json`, `window.json`, `data/`, and `telemetry/`—is not synced.

Compatibility baseline: Herdr.app 0.1.8. Detailed behavior and implementation notes are in [Customization notes](customization.md).
