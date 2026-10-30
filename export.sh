#!/bin/sh
# Live ~/.config/herdr-app → this repo. Skips files the app ships and rewrites.
set -eu
cd "$(dirname "$0")"
live="$HOME/.config/herdr-app"
test -f "$live/settings.json"
test -f "$live/keys.json"

cp "$live/settings.json" settings.json
cp "$live/keys.json" keys.json

python3 - "$live" << 'PY'
import json, pathlib, shutil, sys
live = pathlib.Path(sys.argv[1])
repo = pathlib.Path.cwd()
installed = json.loads((live / "installed.json").read_text())
shipped_layouts = {k.split(":", 1)[1] for k in installed if k.startswith("layout:")}
shipped_mods = {k for k in installed if not k.startswith("layout:")}
shipped_themes = {"atom-one-dark", "win98"}

def reset(path):
    if path.exists():
        shutil.rmtree(path)
    path.mkdir()

reset(repo / "layouts")
for f in (live / "layouts").glob("*.json"):
    if f.name.startswith(".") or ".old-" in f.name:
        continue
    if f.stem in shipped_layouts:
        continue
    shutil.copy2(f, repo / "layouts" / f.name)

reset(repo / "mods")
if (live / "mods").is_dir():
    for d in (live / "mods").iterdir():
        if d.is_dir() and d.name not in shipped_mods:
            shutil.copytree(d, repo / "mods" / d.name)

reset(repo / "themes")
if (live / "themes").is_dir():
    for f in (live / "themes").glob("*.json"):
        if f.stem not in shipped_themes:
            shutil.copy2(f, repo / "themes" / f.name)

programs = live / "programs.json"
dest = repo / "programs.json"
if programs.is_file():
    shutil.copy2(programs, dest)
elif dest.exists():
    dest.unlink()

for path in (repo / "layouts", repo / "mods", repo / "themes"):
    if path.is_dir() and not any(path.iterdir()):
        path.rmdir()
PY
