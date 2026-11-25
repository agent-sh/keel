// The health check's rows, as the daemon answers them (GET /api/health/check)
// and as `keel doctor` and Settings > Health show them. Plain data and its text:
// nothing here reads the machine, so the command line may import it.

export type Level = "ok" | "warning" | "broken";
// What a row is about, in the order the list shows them.
export const GROUPS = ["files", "agnix", "hooks", "settings", "sandbox", "providers", "mcp", "telemetry", "disk"] as const;
export type Group = (typeof GROUPS)[number];
export const GROUP_NAMES: Record<Group, string> = {
  files: "Skills, commands, agents and plugins",
  agnix: "Agent configs, linted by agnix",
  hooks: "Hooks",
  settings: "Settings and layers",
  sandbox: "Sandbox",
  providers: "Providers",
  mcp: "MCP servers",
  telemetry: "Telemetry export",
  disk: "Disk",
};

// `link`: the Settings section where the row is fixed (/settings/<section>).
// `how`: what the check did to learn it, where that is not obvious (a provider's call).
// `path`: the file or folder the row is about.
export type Row = {
  id: string;
  group: Group;
  level: Level;
  title: string;
  detail?: string;
  fix?: string;
  link?: { section: string };
  how?: string;
  path?: string;
};

export type HealthReport = {
  at: number;
  took_ms: number;
  rows: Row[];
  counts: Record<Level, number>;
};

// The Settings sections rows point to, as the page names them.
export const SECTION_NAMES: Record<string, string> = {
  skills: "Skills", commands: "Commands", agents: "Agents", plugins: "Plugins", hooks: "Hooks", mcp: "MCP servers", providers: "Providers", instructions: "Instructions",
  safety: "Safety", observability: "Observability", storage: "Storage", general: "General", daemon: "Daemon",
};

// The sections the page keeps under Customize rather than Settings (ui/src/lib/customize-ids.ts).
const CUSTOMIZE = new Set(["skills", "commands", "agents", "plugins", "hooks", "mcp", "instructions"]);

const RANK: Record<Level, number> = { broken: 0, warning: 1, ok: 2 };

// Broken first, then warnings, then what is well; each group keeps its place, rows keep their order.
export function ordered(rows: Row[]): Row[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => GROUPS.indexOf(a.r.group) - GROUPS.indexOf(b.r.group) || RANK[a.r.level] - RANK[b.r.level] || a.i - b.i)
    .map((x) => x.r);
}

export const countsOf = (rows: Row[]): Record<Level, number> => ({
  ok: rows.filter((r) => r.level === "ok").length,
  warning: rows.filter((r) => r.level === "warning").length,
  broken: rows.filter((r) => r.level === "broken").length,
});

// The exit status of `keel doctor`: 0 when nothing is broken, 1 when something is.
export const doctorExit = (c: Record<Level, number>) => (c.broken ? 1 : 0);

const MARK: Record<Level, string> = { ok: "ok     ", warning: "warning", broken: "broken " };

// The report as text, a group at a time. Rows that are well are one line each;
// a row that is not shows what is wrong, how to fix it and where.
// What the check does, in the words every view of it uses. It changes none of the owner's files or settings and
// asks for no answer a provider charges for; it does make requests (a model listing per provider), and it leaves
// out the two providers whose listing can renew a sign-in.
export const CHECK_NOTE = "This check changes none of your files or settings and spends no tokens. It asks each provider for its model listing, a free read over the network, except Codex and Grok, whose listing can renew a sign-in: those are read from the stored sign-in.";

export function healthText(report: HealthReport, { all = true }: { all?: boolean } = {}): string {
  const out: string[] = [];
  for (const g of GROUPS) {
    const rows = report.rows.filter((r) => r.group === g && (all || r.level !== "ok"));
    if (!rows.length) continue;
    out.push(GROUP_NAMES[g]);
    for (const r of rows) {
      out.push(`  ${MARK[r.level]} ${r.title}`);
      if (r.level === "ok") { if (r.detail) out.push(`          ${r.detail}`); continue; }
      if (r.detail) out.push(`          ${r.detail}`);
      if (r.how) out.push(`          checked: ${r.how}`);
      if (r.fix) out.push(`          fix: ${r.fix}`);
      const where = [r.path, r.link ? `${CUSTOMIZE.has(r.link.section) ? "Customize" : "Settings"} > ${SECTION_NAMES[r.link.section] ?? r.link.section}` : ""].filter(Boolean).join("  |  ");
      if (where) out.push(`          where: ${where}`);
    }
    out.push("");
  }
  const c = report.counts;
  out.push(CHECK_NOTE);
  out.push(`${c.broken} broken, ${c.warning} warning${c.warning === 1 ? "" : "s"}, ${c.ok} ok (${report.took_ms < 1000 ? `${report.took_ms} ms` : `${(report.took_ms / 1000).toFixed(1)} s`})`);
  return out.join("\n");
}
