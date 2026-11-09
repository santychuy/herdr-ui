// Match the palette's command and first argument to keys.json actions.
export function commandKey(entry, bound, layoutName) {
  const value = Object.values(entry.args)[0];
  const action = value === undefined ? entry.name : `${entry.name}:${value}`;
  const scoped = bound.filter(binding => binding.section === `layout:${layoutName}`);
  const overridden = new Set(scoped.map(binding => binding.keys));
  const effective = [...scoped, ...bound.filter(binding => binding.section === "global" && !overridden.has(binding.keys))];
  return effective.find(binding => binding.action === action)?.keys ?? null;
}

// Pointer hints show keys only; accessible names stay on the control.
export function shortcutLabel(key, platform = "macos") {
  if (!key) return null;
  const mac = platform === "macos";
  const modifiers = mac
    ? { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" }
    : { cmd: platform === "windows" ? "Win" : "Super", ctrl: "Ctrl", alt: "Alt", shift: "Shift" };
  const names = { tab: "Tab", enter: "Enter", escape: "Esc", backspace: "Backspace", space: "Space",
    left: "←", right: "→", up: "↑", down: "↓", pageup: "PgUp", pagedown: "PgDn" };
  return key.split(" ").map(chord => {
    const parts = chord.endsWith("--") ? [...chord.slice(0, -2).split("-"), "-"] : chord.split("-");
    return parts.map(part => modifiers[part] ?? names[part] ?? part.toUpperCase()).join(mac ? "" : "+");
  }).join(" ");
}

export function shortcutHint(entry, bound, layoutName, platform = "macos") {
  return shortcutLabel(commandKey(entry, bound, layoutName), platform);
}
