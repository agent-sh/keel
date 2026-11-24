// keel audit verify | export | roots: the sealed record (src/core/seal.ts). verify says whether a session's
// history is whole and where it breaks, or checks a bundle on a machine with no daemon; export writes one
// session's receipts as a bundle that verifies alone; roots checks the days' roots against the copy kept
// outside the store.
import { chmodSync, readFileSync } from "node:fs";
import { verifyBundle, type Checked } from "../core/seal.ts";
import { command, EXIT, printJson, usageError } from "./client.ts";

const USAGE = `keel audit verify SESSION [--roots FILE] [--json]
keel audit verify --bundle FILE [--roots FILE] [--json]
keel audit verify [--json]
keel audit export SESSION [--out FILE]
keel audit roots [--json]
  A session's events, its approval cards and its outward rows are each a chain of SHA-256 links: a row's link
  covers its content and the link before it. verify says whether the chains are whole and names the row where
  one breaks (a row changed, taken out, put in or moved). A store from before the record has its chain from
  the first event written after it; verify says where the sealed part begins.
  Once a day the heads of the sessions that moved are made into a root, written to a file in the state folder
  outside every session's reach (and to the file Settings, seal.mirror names). verify holds the session's
  chains against the days' roots; --roots FILE holds them against a copy of that file you kept elsewhere.
  export writes the session's rows, heads and the paths to the days' roots as one JSON file (to --out, else
  standard output). verify --bundle checks that file alone, with no daemon: a changed row, a changed order or
  a changed head fails. With no session and no bundle, verify checks the days' roots.
  Exit 0 when whole, 1 when not.`;

type Line = { day: string; root: string };
const rootsOf = (path?: string): Map<string, string> | undefined => {
  if (!path) return undefined;
  const m = new Map<string, string>();
  for (const l of readFileSync(path, "utf8").split("\n")) {
    try { const r = JSON.parse(l) as Line; if (typeof r.day === "string" && typeof r.root === "string") m.set(r.day, r.root); } catch {}
  }
  return m;
};

function show(v: Checked & { counts?: { events: number; cards: number; egress: number } }): string {
  const lines = [`${v.ok ? "whole" : "NOT WHOLE"}: session ${v.session}`];
  const names = { events: "events", cards: "approval cards", egress: "outward rows" } as const;
  for (const c of v.chains) {
    const what = names[c.kind];
    if (!c.rows) { lines.push(`  ${what}: none`); continue; }
    if (!c.sealed) { lines.push(`  ${what}: ${c.rows} rows, none sealed (written before the sealed record)`); }
    else lines.push(`  ${what}: ${c.rows} rows, ${c.sealed} sealed from ${c.from}${c.unsealed ? `, ${c.unsealed} before it are not covered` : ""}${c.trimmed ? " (older rows are no longer in the store)" : ""}`);
    if (c.break) lines.push(`    BREAK at ${c.break.at}: ${c.break.why}`);
  }
  for (const a of v.anchors) lines.push(`  root of ${a.day}: ${a.ok ? "holds" : `FAILS: ${a.why}`}`);
  for (const n of v.notes) lines.push(`  note: ${n}`);
  return lines.join("\n");
}

export const auditCmd = command("audit", USAGE, { bundle: { type: "string" }, roots: { type: "string" }, out: { type: "string" } }, async (v, pos, c) => {
  const [sub, id] = pos;
  if (sub === "verify" && v.bundle) {
    let b: unknown;
    try { b = JSON.parse(readFileSync(v.bundle, "utf8")); } catch (e) { return usageError("audit", `cannot read ${v.bundle}: ${(e as Error).message}`, USAGE); }
    const r = verifyBundle(b, rootsOf(v.roots));
    v.json ? printJson(r) : console.log(show(r));
    return r.ok ? EXIT.ok : 1;
  }
  if (sub === "verify" && id) {
    const s = await c.resolve(id);
    const r = await c.get<Checked>(`/api/audit/verify?session=${encodeURIComponent(s.id)}`);
    // (A roots file of the owner's own is held against the store's roots too, besides the daemon's own copy.)
    const kept = rootsOf(v.roots);
    if (kept) for (const a of r.anchors) if (kept.get(a.day) !== a.root) { a.ok = false; a.why ??= kept.has(a.day) ? "the day's root differs from the file given" : "the day is not in the file given"; r.ok = false; }
    v.json ? printJson(r) : console.log(show(r));
    return r.ok ? EXIT.ok : 1;
  }
  if (sub === "export" && id) {
    const s = await c.resolve(id);
    const n = await c.download(`/api/audit/bundle?session=${encodeURIComponent(s.id)}`, v.out);
    if (v.out) { chmodSync(v.out, 0o600); console.log(`wrote ${v.out} (${(n / 1024).toFixed(0)} KB): keel audit verify --bundle ${v.out}`); }
    return EXIT.ok;
  }
  if (sub === "roots" || (sub === "verify" && !id)) {
    const r = await c.get<{ ok: boolean; roots: { day: string; root: string; sessions: number; ok: boolean; why?: string }[]; file: string; file_found: boolean; mirror: string | null; mirror_differs: string[] | null; mirror_unread?: boolean; sessions: number }>("/api/audit/roots");
    if (v.json) printJson(r);
    else {
      console.log(`${r.ok ? "roots hold" : "ROOTS DO NOT HOLD"}: ${r.roots.length} days, ${r.sessions} sessions; kept in ${r.file}${r.file_found ? "" : " (not found)"}${r.mirror ? `, mirrored to ${r.mirror}` : ", no mirror set (Settings, seal.mirror)"}`);
      for (const d of r.roots) console.log(`  ${d.day}  ${d.root.slice(0, 16)}  ${d.sessions} sessions  ${d.ok ? "ok" : `FAILS: ${d.why}`}`);
      if (r.mirror_unread) console.log("  the mirror could not be read in time: the roots were not held against it");
      if (r.mirror_differs?.length) console.log(`  the mirror differs on ${r.mirror_differs.join(", ")}`);
    }
    return r.ok ? EXIT.ok : 1;
  }
  return usageError("audit", "verify SESSION, verify --bundle FILE, export SESSION or roots", USAGE);
});
