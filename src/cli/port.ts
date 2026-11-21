// keel port: bring the setup of Claude Code, Codex, Hermes and the Rust Keel
// over, through the daemon. Without --apply it only shows the plan.
import { type Client, command, EXIT, printJson, usageError } from "./client.ts";

const USAGE = `keel port [--apply] [--only AREA,...] [--pick ID,...] [--days N] [--max N] [--all]
  Bring your setup from the other harnesses into Keel: instructions, memory (into
  tacit), skills, plugins, MCP servers, hooks, sessions and the Rust Keel's settings.
  The sources are only read. Without --apply nothing is written: the plan says what
  comes, what is already here, and what is left out and why. Running it again
  brings only what is new.

  --apply        run the plan (the items it picks, or the ones --pick names)
  --only AREAS   instructions, memory, skills, plugins, mcp, hooks, sessions, settings
  --pick IDS     run these items (ids from the plan), picked or not
  --days N       sessions of the last N days (30)
  --max N        at most N sessions per harness (50)
  --all          list every item, also the ones already here and every session
  --json         the plan or the result as JSON`;

const MARK: Record<string, string> = { new: "+", update: "~", done: "=", skip: "-", error: "!" };

function show(items: any[], all: boolean) {
  const line = (it: any) => {
    const pick = (it.state === "new" || it.state === "update") && !it.result ? (it.pick ? "[x]" : "[ ]") : "   ";
    const result = it.result ? `  => ${it.result}` : it.error ? `  !! ${it.error}` : "";
    console.log(`  ${MARK[it.state] ?? "?"} ${pick} ${it.source}: ${it.title}${it.detail ? `  (${it.detail})` : ""}${it.reason ? `  -- ${it.reason}` : ""}${result}`);
    if (all) console.log(`        ${it.id}`);
  };
  const areas = [...new Set(items.map((i) => i.area))];
  for (const area of areas) {
    const list = items.filter((i) => i.area === area && (all || i.state !== "done"));
    // Sessions: one line per harness unless --all lists each.
    const each = area !== "sessions" || all ? list : list.filter((i) => i.state === "skip" || i.state === "error" || i.result || i.error);
    const by = new Map<string, Record<string, number>>();
    if (area === "sessions" && !all) for (const i of items.filter((x) => x.area === area && (x.state === "new" || x.state === "update" || x.state === "done") && !x.result && !x.error)) {
      const c = by.get(i.source) ?? {};
      c[i.state] = (c[i.state] ?? 0) + 1;
      by.set(i.source, c);
    }
    if (!each.length && !by.size) continue;
    console.log(`\n${area}`);
    for (const [src, c] of by) console.log(`  ${c.new || c.update ? "+ [x]" : "=    "} ${src}: ${Object.entries(c).map(([k, n]) => `${n} ${k === "done" ? "here" : k}`).join(", ")}  (--all lists them)`);
    for (const it of each) line(it);
  }
  const n = (s: string) => items.filter((i) => i.state === s).length;
  console.log(`\n${n("new")} new, ${n("update")} changed, ${n("done")} already here, ${n("skip")} left out, ${n("error")} unreadable`);
}

export const portCmd = command("port", USAGE, {
  apply: { type: "boolean" }, only: { type: "string" }, pick: { type: "string" }, days: { type: "string" }, max: { type: "string" }, all: { type: "boolean" },
}, async (v, pos, c: Client) => {
  if (pos.length) return usageError("port", `unexpected ${pos[0]}`, USAGE);
  const areas = v.only ? String(v.only).split(",").filter(Boolean) : undefined;
  const ids = v.pick ? String(v.pick).split(",").filter(Boolean) : undefined;
  if (!v.apply) {
    const q = new URLSearchParams();
    if (v.days) q.set("days", v.days);
    if (v.max) q.set("max", v.max);
    const r = await c.get<any>(`/api/port?${q}`);
    const items = areas ? r.items.filter((i: any) => areas.includes(i.area)) : r.items;
    if (v.json) return (printJson({ ...r, items }), EXIT.ok);
    console.log(`From ${r.home} into ${r.config}`);
    show(items, !!v.all);
    console.log("keel port --apply brings the [x] items.");
    return EXIT.ok;
  }
  const r = await c.post<any>("/api/port", { ids, areas, days: v.days ? Number(v.days) : undefined, max: v.max ? Number(v.max) : undefined });
  // An item that failed is the command's failure in both forms of output.
  if (v.json) printJson(r);
  else show(r.items.filter((i: any) => i.result || i.error || v.all), true);
  return r.counts?.failed ? EXIT.error : EXIT.ok;
});
