// keel import: sessions of other harnesses (Claude Code, Codex, the Rust
// Keel) from a terminal, over the daemon's import routes.
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ago, ApiError, type Client, command, EXIT, line, printJson, usageError } from "./client.ts";

const home = homedir();
const tilde = (p?: string) => (p ? (p.startsWith(home) ? "~" + p.slice(home.length) : p) : "");
const size = (b: number) => (b < 1 << 20 ? `${Math.round(b / 1024)}K` : `${(b / (1 << 20)).toFixed(1)}M`);

const USAGE = `keel import <list|harnesses|folders|preview|run|batch|index> [options]
  Sessions of other harnesses on this machine: list them, look at one, continue one in Keel.

  list [-q TEXT] [--harness H] [--cwd DIR] [--show subagents,headless,all] [--sort updated|size|title]
       [--limit N] [--cursor C] [--all]        one page; the next cursor goes to standard error
  harnesses                                    each harness, its store and its counts
  folders [--harness H] [-q TEXT] [--limit N]  the directories sessions ran in, with counts
  preview HARNESS ID | preview --path FILE     what an import would bring
  run HARNESS ID | run --path FILE [--mode new|update|open] [-m MODEL] [--cwd DIR] [--title T]
  batch HARNESS:ID... [--mode new|update|open] [-m MODEL]   one line per source; exit 1 when one failed
  index [status|refresh|rebuild]               the index the list reads

  Harnesses: claude, codex, keel, agy, hermes. Every subcommand takes --json.`;

const listRow = (f: any) => {
  const tags = [f.kind !== "interactive" ? `[${f.kind}]` : "", f.imported ? "(imported)" : ""].filter(Boolean).join(" ");
  return `${f.harness.padEnd(6)} ${f.id.padEnd(38)} ${ago(f.updated_ms).padStart(4)} ${size(f.size_bytes).padStart(6)}  ${(line(f.title) || "(untitled)").slice(0, 70)}  ${tilde(f.cwd)}${tags ? `  ${tags}` : ""}`;
};

async function list(c: Client, v: any) {
  const q = new URLSearchParams();
  for (const k of ["harness", "cwd", "show", "sort", "limit"] as const) if (v[k]) q.set(k, k === "cwd" ? resolve(v[k]) : v[k]);
  if (v.query) q.set("q", v.query);
  let cursor = v.cursor ? Number(v.cursor) : 0;
  const rows: any[] = [];
  for (;;) {
    q.set("cursor", String(cursor));
    const r = await c.get<any>(`/api/import/sessions?${q}`);
    rows.push(...r.sessions);
    if (!v.json) for (const f of r.sessions) console.log(listRow(f));
    if (r.next_cursor === undefined) break;
    if (!v.all) {
      console.error(`more: --cursor ${r.next_cursor} (${r.total} in all)`);
      break;
    }
    cursor = r.next_cursor;
  }
  if (v.json) printJson(rows);
  return EXIT.ok;
}

async function target(v: any, pos: string[]) {
  if (v.path) return { path: resolve(v.path) };
  if (pos.length < 2) throw new ApiError("name the session: HARNESS ID, or --path FILE", 400);
  return { harness: pos[0], id: pos[1] };
}

export const importCmd = command("import", USAGE, {
  query: { type: "string", short: "q" }, harness: { type: "string" }, cwd: { type: "string" }, show: { type: "string" },
  sort: { type: "string" }, limit: { type: "string" }, cursor: { type: "string" }, all: { type: "boolean" },
  path: { type: "string" }, mode: { type: "string" }, model: { type: "string", short: "m" }, title: { type: "string" },
}, async (v, pos, c) => {
  const [sub, ...rest] = pos;
  if (v.mode && !["new", "update", "open"].includes(v.mode)) return usageError("import", "--mode is new, update or open", USAGE);
  const model = v.model ? (await c.get<{ model: string }>(`/api/cli/model?model=${encodeURIComponent(v.model)}`)).model : undefined;
  switch (sub) {
    case "list":
      return list(c, v);
    case "harnesses": {
      const r = await c.get<any>("/api/import/index");
      if (v.json) return (printJson(r.harnesses), EXIT.ok);
      for (const h of r.harnesses) console.log(`${h.harness.padEnd(6)} ${h.label.padEnd(14)} ${h.installed ? `${h.total} sessions (${h.interactive} interactive)` : "not found"}  ${tilde(h.store)}`);
      if (!r.complete) console.error("the index is not built yet: keel import list builds it");
      return EXIT.ok;
    }
    case "folders": {
      const q = new URLSearchParams({ limit: "100000", show: "all" });
      if (v.harness) q.set("harness", v.harness);
      if (v.query) q.set("q", v.query);
      const r = await c.get<any>(`/api/import/sessions?${q}`);
      const by = new Map<string, { cwd: string; sessions: number; newest_ms: number; harnesses: Set<string> }>();
      for (const f of r.sessions) {
        const k = f.cwd ?? "";
        const e = by.get(k) ?? { cwd: k, sessions: 0, newest_ms: 0, harnesses: new Set<string>() };
        e.sessions++;
        e.newest_ms = Math.max(e.newest_ms, f.updated_ms);
        e.harnesses.add(f.harness);
        by.set(k, e);
      }
      const rows = [...by.values()].sort((a, b) => b.newest_ms - a.newest_ms).slice(0, v.limit ? Number(v.limit) : 50);
      if (v.json) return (printJson(rows.map((r) => ({ ...r, harnesses: [...r.harnesses] }))), EXIT.ok);
      for (const r of rows) console.log(`${String(r.sessions).padStart(5)}  ${ago(r.newest_ms).padStart(4)}  ${[...r.harnesses].join(",").padEnd(16)}  ${tilde(r.cwd) || "(no folder)"}`);
      return EXIT.ok;
    }
    case "preview": {
      const t = await target(v, rest);
      const r = await c.get<any>(`/api/import/preview?${new URLSearchParams(t as any)}`);
      if (v.json) return (printJson(r), EXIT.ok);
      const s = r.session, n = r.counts;
      console.log(`${s.harness} ${s.id}\n  title    ${line(s.title)}\n  folder   ${tilde(s.cwd)}${s.cwd && !s.cwd_exists ? " (gone)" : ""}\n  model    ${s.model ?? "unknown"}\n  brings   ${n.prompts} prompts, ${n.assistant_messages} replies, ${n.tool_calls} tool calls${n.skipped ? `, ${n.skipped} skipped` : ""}`);
      for (const note of r.notes) console.log(`  note     ${line(note)}`);
      for (const l of r.links) console.log(`  imported before as ${l.session_id} (${ago(l.imported_ms)} ago)`);
      for (const m of r.tail) console.log(`  ${m.role === "user" ? ">" : " "} ${line(m.text).slice(0, 160)}`);
      return EXIT.ok;
    }
    case "run": {
      const t = await target(v, rest);
      const r = await c.post<any>("/api/import", { ...t, mode: v.mode, model, cwd: v.cwd ? resolve(v.cwd) : undefined, title: v.title });
      if (v.json) return (printJson(r), EXIT.ok);
      console.log(`${r.action} ${r.session.id}  (${r.imported_events} events)\nopen ${c.url(r.session.id)}`);
      return EXIT.ok;
    }
    case "batch": {
      const items = rest.map((x) => {
        const i = x.indexOf(":");
        if (i < 1) throw new ApiError(`${x} is not HARNESS:ID`, 400);
        return { harness: x.slice(0, i), id: x.slice(i + 1) };
      });
      if (v.path) items.push({ path: resolve(v.path) } as any);
      if (!items.length) return usageError("import", "batch takes HARNESS:ID arguments", USAGE);
      const r = await c.post<any>("/api/import/batch", { items, mode: v.mode, model });
      if (v.json) printJson(r);
      else for (const x of r.results) console.log(x.ok ? `${x.action} ${x.harness}:${x.id} -> ${x.session_id}` : `failed ${x.harness ?? ""}:${x.id ?? x.path}: ${line(x.error)}`);
      return r.counts.failed ? 1 : EXIT.ok;
    }
    case "index": {
      const action = rest[0] ?? "status";
      if (!["status", "refresh", "rebuild"].includes(action)) return usageError("import", "index takes status, refresh or rebuild", USAGE);
      const r = action === "status" ? await c.get<any>("/api/import/index") : await c.post<any>("/api/import/index", { action });
      if (v.json) return (printJson(r), EXIT.ok);
      console.log(`${r.building ? "building" : r.complete ? "complete" : "not built"}; ${r.harnesses.map((h: any) => `${h.harness} ${h.total}`).join(", ")}`);
      return EXIT.ok;
    }
    default:
      return usageError("import", sub ? `unknown subcommand ${sub}` : "name a subcommand", USAGE);
  }
});
