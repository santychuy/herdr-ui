#!/bin/sh
# This repo → ~/.config/herdr-app. Does not replace shipped layouts or mods.
set -eu
cd "$(dirname "$0")"
live="$HOME/.config/herdr-app"
mkdir -p "$live"
stamp=$(date +%Y%m%d-%H%M%S)

for f in settings.json keys.json; do
  if [ -f "$live/$f" ]; then
    cp -p "$live/$f" "$live/$f.bak-import-$stamp"
  fi
  cp "$f" "$live/$f"
done

if [ -f programs.json ]; then
  cp programs.json "$live/programs.json"
fi

for dir in layouts mods themes; do
  [ -d "$dir" ] || continue
  find "$dir" -type f -print | while IFS= read -r f; do
    mkdir -p "$live/$(dirname "$f")"
    cp "$f" "$live/$f"
  done
done
