const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

function cleanTitle(value) {
  return (value ?? "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .replace(/^[^\p{L}\p{N}~/]+/u, "")
    .trim();
}

function titleFor(tab, primary, pane) {
  if (tab.named && tab.name) return tab.name;
  const program = primary?.program;
  const raw = primary?.title ?? "";
  const harness = primary?.app ?? program?.key;
  const own = harness === "pi" || harness === "omp" ? raw.replace(/^π(?:\s*-\s*|\s+)/u, "")
    : harness === "opencode" ? raw.replace(/^OC\s*\|\s*/, "") : raw;
  const title = cleanTitle(own);
  const telling = title && !/^[~/]|^[A-Za-z]:\\/.test(title) && !title.includes("@")
    && title.toLowerCase() !== program?.name?.toLowerCase()
    && title.toLowerCase() !== program?.key?.toLowerCase();
  return (telling && title) || program?.name || cleanTitle(pane?.title) || `Terminal ${tab.index}`;
}

function word(node) {
  // Raw errors are not represented in AgentInfo's narrower Status union.
  if (node.raw?.status === "error") return "blocked";
  const status = node.agent?.status ?? node.raw?.status;
  return RANK[status] ? status : "none";
}

/** One live thread per native tab; all identity keys remain machine-qualified. */
export function buildThreads({ spaces = [], agents = [], terminals = [], panes = [], machines = [] }) {
  const layouts = new Map(machines.map(machine => [machine.name, machine.layout]));
  const nodes = new Map();
  const panesByTab = new Map();
  const agentsByTab = new Map();
  const nodeFor = address => {
    let node = nodes.get(address);
    if (!node) {
      node = { address, raw: null, agent: null, tab: null, parent: null, children: [] };
      nodes.set(address, node);
    }
    return node;
  };
  const finished = new Set();
  for (const terminal of terminals) {
    if (terminal.state === "finished") finished.add(terminal.address);
    else nodeFor(terminal.address).raw = terminal;
  }
  for (const agent of agents) {
    if (finished.has(agent.address)) continue;
    const node = nodeFor(agent.address);
    node.agent = agent;
    node.tab = agent.tab;
    let list = agentsByTab.get(agent.tab);
    if (!list) agentsByTab.set(agent.tab, list = []);
    list.push(node);
  }
  for (const pane of panes) {
    let list = panesByTab.get(pane.tab);
    if (!list) panesByTab.set(pane.tab, list = []);
    list.push(pane);
    if (pane.terminal && !finished.has(pane.terminal)) {
      const node = nodeFor(pane.terminal);
      node.tab ??= pane.tab;
    }
  }
  for (const node of nodes.values()) node.parent = nodes.get(node.raw?.parent) ?? null;

  // Break malformed ancestry cycles once, before either root selection or traversal.
  const visited = new Set();
  for (const start of nodes.values()) {
    if (visited.has(start)) continue;
    const path = new Set();
    let node = start;
    while (node && !visited.has(node)) {
      if (path.has(node)) {
        node.parent = null;
        break;
      }
      path.add(node);
      node = node.parent;
    }
    for (const item of path) visited.add(item);
  }
  for (const node of nodes.values()) if (node.parent) node.parent.children.push(node);

  const rows = [];
  const emitted = new Set();
  for (const space of spaces) {
    for (const tab of space.tabs) {
      if (emitted.has(tab.id)) continue;
      emitted.add(tab.id);
      const tabAgents = agentsByTab.get(tab.id) ?? [];
      const roots = tabAgents.filter(node => {
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (parent.tab && parent.tab !== tab.id) break;
          if (parent.agent && parent.tab === tab.id) return false;
        }
        return true;
      });
      const tabPanes = panesByTab.get(tab.id) ?? [];
      const descendants = [];
      const seen = new Set();
      let status = "none";
      let busy = false;
      let pinned = false;
      let primary = null;
      let primaryRank = -1;
      const tree = root => {
        let blocked = false;
        let working = false;
        let idle = false;
        const stack = [root];
        while (stack.length) {
          const node = stack.pop();
          if (seen.has(node) || (node.tab && node.tab !== tab.id)) continue;
          seen.add(node);
          const state = word(node);
          blocked ||= state === "blocked";
          working ||= state === "working";
          idle ||= state === "idle";
          pinned ||= Boolean(node.agent?.pinned || node.raw?.labels?.["herdr.pinned"]);
          if (node !== root && node.raw) descendants.push(node.raw);
          for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
        }
        busy ||= blocked || working;
        return blocked ? "blocked" : word(root) === "done" ? "done"
          : working ? "working" : idle ? "idle" : "none";
      };
      for (const root of roots) {
        const state = tree(root);
        const rank = RANK[state] ?? 0;
        if (rank > (RANK[status] ?? 0)) status = state;
        if (rank > primaryRank || (rank === primaryRank && root.agent.focused && !primary?.focused)) {
          primary = root.agent;
          primaryRank = rank;
        }
      }
      // Shell and mod tabs still exist without a reporting agent.
      for (const pane of tabPanes) {
        const node = nodes.get(pane.terminal);
        if (!node || seen.has(node)) continue;
        const state = tree(node);
        if ((RANK[state] ?? 0) > (RANK[status] ?? 0)) status = state;
      }
      const available = !["loading", "unavailable"].includes(layouts.get(space.machine ?? null));
      if (!available) status = "unavailable";
      const needsAttention = available && (status === "blocked" || status === "done");
      const pane = tabPanes.find(pane => pane.focused) ?? tabPanes[0];
      rows.push({
        id: tab.id, space, tab, title: titleFor(tab, primary, pane),
        program: primary?.program ?? pane?.program ?? null,
        primary, agents: roots.map(node => node.agent), descendants, status,
        needsAttention, busy, pinned,
        current: Boolean(space.active && tab.active),
        reviewed: available && Boolean(tab.settled) && !busy && !needsAttention,
        available, rank: RANK[status] ?? 0,
      });
    }
  }
  return rows;
}
