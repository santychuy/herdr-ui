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

Current personal files are `settings.json` (zoom 1.2, sounds on) and `keys.json` (stock macOS map: `cmd-t` new tab, `cmd-k` palette, `cmd-d` split right).
