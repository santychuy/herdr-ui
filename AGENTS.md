# Herdr UI customization

This repository is the shareable setup copy. The running app reads `~/.config/herdr-app`; do not set `HERDR_APP_HOME` to this repository. Before changing the UI, run `herdr-app --skill`, then read the installed `~/.config/herdr-app/AGENTS.md`. Do not edit that generated guide or its generated type files. Custom mods and layouts hot-reload; validate changes with `herdr-app check`, `status`, and an inspected `shot`.

## Render Mermaid in the Diagrams panel

When asked to show a Mermaid diagram in Herdr, prefer the installed **Diagrams** panel over emitting a Mermaid block in terminal chat.

1. Write raw Mermaid syntax (without Markdown fences) to a local `.mmd` file.
2. Run on the machine hosting the desktop app:
   ```sh
   node "$HOME/.config/herdr-app/mods/diagrams/render.mjs" publish \
     --file /absolute/path/diagram.mmd --title "Diagram title"
   ```
3. The command uses the bundled Pele renderer, publishes SVG locally, and opens the right-side Diagrams panel. Check its JSON result: `ok` reports rendering success; `shown` reports whether opening the panel succeeded.
4. Inspect `herdr-app status` and `herdr-app shot /tmp/diagram.png`, then read the picture. Do not claim the diagram was displayed from `ok` alone.

Rendering requires Node.js 20 or newer. It does not need a browser, npm installation, API key, or runtime network access. `--no-show` renders without changing the window. `--home /absolute/app-home` targets another installed app home. Diagram images and links are disabled. Invalid source must not replace the last valid diagram; use the reported error to correct the Mermaid source.

The live implementation is `~/.config/herdr-app/mods/diagrams/`: `render.mjs` is the agent/CLI interface, `main.js` is the native viewer, and `vendor/pele.mjs` is pinned Pele 1.13.0 with its license. `data/diagrams/current.json` in the app home points to the latest immutable source/SVG revision; do not hand-edit its generated artifacts. A new publish replaces the displayed revision. The panel uses local desktop data even when another terminal is remote.

When the user asks to clear generated diagrams, run:
```sh
node "$HOME/.config/herdr-app/mods/diagrams/render.mjs" clear
```
This permanently deletes all revisions, copied sources, manifests, and cached SVGs under the app's `data/diagrams/`, without deleting original inputs outside that store. The open panel switches to its empty state. Do not clear diagrams automatically before publishing.
