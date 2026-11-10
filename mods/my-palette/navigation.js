// Mod imports are sandboxed; threads.js is the unchanged my-spaces model.
import { buildThreads } from "./threads.js";

export const STATUS = { blocked: "Needs you", done: "Unread reply", working: "Working", idle: "Idle", none: "Terminal", mod: "Mod tab", unknown: "Unknown", unavailable: "Unavailable" };
export const FILTERS = ["all", "attention", "working", "idle", "reviewed"];
export const SORTS = ["attention", "activity", "project", "name"];
export const SORT_LABEL = { attention: "Attention first", activity: "Recent activity", project: "Project", name: "Name A–Z" };

function contextFor(row) {
  const tab = `Tab ${row.tab.index}${row.tab.named ? `: ${row.tab.name}` : ""}`;
  return `${row.space.name} · ${row.space.machine ?? "Local"} · ${tab}`;
}

export function navigation(data, view, filter, sort) {
  const threads = buildThreads(data);
  let rows;
  if (view === "projects") {
    return data.spaces.map(space => {
      const children = threads.filter(row => row.space.id === space.id);
      const tabs = new Set(space.tabs.map(tab => tab.id));
      // Match the sidebar: this project's first live pane folder, then its saved folder.
      const folder = data.panes.find(pane => tabs.has(pane.tab) && pane.cwd)?.cwd || space.folder || "~";
      const available = !["loading", "unavailable"].includes(data.machines.find(m => m.name === (space.machine ?? null))?.layout);
      return { id: `space:${space.id}`, name: "space.select", args: { id: space.id }, title: space.name,
        group: "Project", words: `${folder} ${space.branch ?? ""} ${children.map(r => r.title).join(" ")}`,
        detail: `${space.machine ?? "Local"} · ${children.length} threads · ${folder}`, available };
    });
  } else if (view === "terminals") {
    const rawByAddress = new Map(data.terminals.map(terminal => [terminal.address, terminal]));
    const agentByAddress = new Map(data.agents.map(agent => [agent.address, agent]));
    const paneByAddress = new Map(data.panes.filter(pane => pane.terminal).map(pane => [pane.terminal, pane]));
    const panesByTab = new Map();
    for (const pane of data.panes) {
      if (!panesByTab.has(pane.tab)) panesByTab.set(pane.tab, []);
      panesByTab.get(pane.tab).push(pane);
    }
    const emitted = new Set();
    rows = threads.flatMap(row => {
      const tabPanes = panesByTab.get(row.id) ?? [];
      const addresses = new Set([
        ...tabPanes.map(pane => pane.terminal).filter(Boolean),
        ...row.agents.map(agent => agent.address),
        ...row.descendants.map(child => child.address),
      ]);
      if (!addresses.size && tabPanes.some(pane => pane.mod)) return [{
        id: row.id, name: "tab.select", args: { id: row.id }, title: row.title, group: "Tab",
        words: row.space.folder, detail: contextFor(row), status: row.available ? "mod" : "unavailable",
        available: row.available, needsAttention: false, reviewed: row.reviewed, rank: 0,
        seq: row.tab.changed_at ?? 0, project: row.space.name,
      }];
      return [...addresses].flatMap(address => {
        const raw = rawByAddress.get(address);
        if (emitted.has(address) || raw?.state === "finished") return [];
        emitted.add(address);
        const agent = agentByAddress.get(address);
        const pane = paneByAddress.get(address);
        const program = agent?.program ?? pane?.program ?? raw?.program;
        const reported = raw?.status === "error" ? "blocked" : agent?.status ?? raw?.status;
        const status = !row.available ? "unavailable" : raw?.parent && reported === "done" ? "idle"
          : reported || (program?.agent ? "unknown" : "none");
        return [{
          id: `terminal:${address}`, name: pane ? "pane.focus" : agent ? "agent.focus" : "terminal.peek",
          args: pane ? { pane: pane.pane } : { terminal: address }, program,
          title: raw?.name || pane?.title || agent?.title || program?.name || address, group: "Terminal",
          words: `${row.tab.name} ${row.title} ${program?.name ?? ""} ${row.space.folder}`,
          detail: `${contextFor(row)} · ${address}${pane?.cwd ? ` · ${pane.cwd}` : ""}`,
          status, available: row.available, needsAttention: row.available && (status === "blocked" || status === "done"),
          reviewed: row.reviewed, rank: ({ blocked: 4, done: 3, working: 2, idle: 1 })[status] ?? 0,
          seq: raw?.status_ms ?? row.tab.changed_at ?? 0, project: row.space.name,
        }];
      });
    });
  } else {
    rows = threads.flatMap(row => {
      const context = contextFor(row);
      const main = row.primary ? { id: `agent:${row.primary.address}`, name: "agent.focus",
        args: { terminal: row.primary.address },
        program: row.primary?.program ?? null,
        title: row.title, group: "Agent", words: `${row.program?.name ?? ""} ${row.space.folder} ${row.space.branch ?? ""} ${row.agents.map(a => a.title).join(" ")}`,
        detail: `${context}${row.descendants.length ? ` · ${row.descendants.length} subagents` : ""}`,
        status: row.status, available: row.available, needsAttention: row.needsAttention, reviewed: row.reviewed,
        rank: row.rank, seq: row.tab.changed_at ?? 0, project: row.space.name } : null;
      const others = row.agents.filter(agent => agent.address !== row.primary?.address).map(agent => {
        const raw = data.terminals.find(terminal => terminal.address === agent.address);
        const status = !row.available ? "unavailable" : raw?.status === "error" ? "blocked" : agent.status;
        return { ...main, id: `agent:${agent.address}`, name: "agent.focus", args: { terminal: agent.address },
          program: agent.program,
          title: `${agent.program?.name ?? agent.app ?? "Agent"} · ${agent.address}`, group: "Agent",
          words: `${agent.title} ${main.words}`, detail: context, status, reviewed: row.reviewed,
          needsAttention: row.available && (status === "blocked" || status === "done"),
          rank: ({ blocked: 4, done: 3, working: 2, idle: 1 })[status] ?? 0, seq: raw?.status_ms ?? main.seq };
      });
      const children = row.descendants.filter(child => child.status || child.program?.agent);
      return [main, ...others, ...children.map(child => {
        const status = !row.available ? "unavailable" : child.status === "error" ? "blocked" : child.status === "done" ? "idle" : child.status || "unknown";
        return { id: `child:${child.address}`, name: "terminal.peek", args: { terminal: child.address },
          program: child.program,
          title: child.name || child.program?.name || child.address, group: "Subagent",
          words: `${child.title ?? ""} ${child.address} ${child.program?.name ?? ""}`, detail: `↳ ${row.title} · ${context}`,
          status, available: row.available, needsAttention: row.available && status === "blocked", reviewed: false,
          rank: ({ blocked: 4, working: 2, idle: 1 })[status] ?? 0, seq: child.status_ms ?? 0, project: row.space.name };
      })].filter(Boolean);
    });
  }
  return rows.filter(row => filter === "all" || (filter === "attention" ? row.needsAttention : filter === "reviewed" ? row.reviewed : row.status === filter))
    .sort((a, b) => (sort === "attention" ? b.rank - a.rank : sort === "activity" ? b.seq - a.seq : sort === "project" ? a.project.localeCompare(b.project) : a.title.localeCompare(b.title)));
}
