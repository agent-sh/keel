// Listing another machine's harness sessions over its link: a fake far store
// answers as the helper does (the same pager), the last list is kept, and a
// machine that does not answer gives it back dated. And which transcripts a
// harness holds open, found from the harnesses' own lists.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KEEL_CONFIG_DIR ??= join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "keel-listing-test-")), "config");
const { Store } = await import("../core/store.ts");
const { migrate } = await import("./db.ts");
const { Listings } = await import("./listing.ts");
const { LinkError } = await import("./link.ts");
const { page } = await import("../integrations/import/offer.ts");
const { parseLsof, runningOf } = await import("./hands-sessions.ts");
import type { Found } from "../integrations/import/types.ts";

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) Bun.spawnSync(["rm", "-rf", d]); });

const row = (id: string, title: string, updated_ms: number, harness: Found["harness"] = "claude"): Found => ({ harness, id, path: `/far/${id}.jsonl`, cwd: "/far/proj", title, updated_ms, size_bytes: 100, kind: "interactive" });

// The far machine: a store the helper pages as it does, a count of the asks, and a switch for the link.
function far(rows: Found[]) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "keel-listing-"));
  dirs.push(dir);
  const store = new Store(dir);
  migrate(store);
  const link = { up: true, asked: [] as string[], down: undefined as string | undefined };
  const ask = async (_m: string, path: string) => {
    link.asked.push(path);
    if (!link.up) throw new LinkError("cannot reach the machine: no answer within 30 s");
    const u = new URL(path, "http://far").searchParams;
    if (u.get("q") === "refused") throw Object.assign(new LinkError("that cursor was not given"), { status: 400 });
    const r = page(rows, { harness: (u.get("harness") || undefined) as any, q: u.get("q") ?? undefined, show: u.get("show") ?? undefined, limit: Number(u.get("limit") ?? 50) });
    return { ...r, harnesses: [{ harness: "claude", label: "Claude Code", total: rows.length }] } as any;
  };
  return { listings: new Listings(store, ask, () => link.down), link };
}

const STORE = [row("a", "Fix the parser", 3000), row("b", "Write the report", 2000), row("c", "Parser notes", 1000)];

test("a live list is kept and comes back, dated, when the machine does not answer", async () => {
  const { listings, link } = far(STORE);
  const live = await listings.list("m1", { harness: "claude", limit: 60 });
  expect(live.cached_ms).toBeUndefined();
  expect(live.body.sessions.map((s) => s.id)).toEqual(["a", "b", "c"]);

  link.up = false;
  const gone = await listings.list("m1", { harness: "claude", limit: 60 });
  expect(gone.body.sessions.map((s) => s.id)).toEqual(["a", "b", "c"]);
  expect(gone.cached_ms).toBeGreaterThan(0);
  expect(gone.stale?.reason).toContain("no answer");
  // The words typed are matched over the rows kept; the count is of what they hold.
  const typed = await listings.list("m1", { harness: "claude", q: "parser" });
  expect(typed.body.sessions.map((s) => s.id)).toEqual(["a", "c"]);
  expect(typed.body.total).toBe(2);
  expect(typed.stale).toBeDefined();
});

test("a machine known to be down is not waited for, and a list is kept per harness and per show", async () => {
  const { listings, link } = far(STORE);
  await listings.list("m1", { harness: "claude" });
  await listings.list("m1", { harness: "codex" });
  const before = link.asked.length;
  link.down = "the link was cut";
  const a = await listings.list("m1", { harness: "claude" });
  expect(link.asked.length).toBe(before);
  expect(a.stale?.reason).toBe("the link was cut");
  // A refresh the owner asked for tries it anyway.
  link.down = undefined;
  expect((await listings.list("m1", { harness: "claude", refresh: true })).stale).toBeUndefined();
  // What the sheet shows while it opens: only what is kept, no word to the machine.
  const asked = link.asked.length;
  expect(listings.cached("m1", { harness: "claude" })?.body.sessions.length).toBe(3);
  expect(listings.cached("m1", { harness: "claude", show: "all" })).toBeUndefined();
  expect(listings.cached("m2", { harness: "claude" })).toBeUndefined();
  expect(link.asked.length).toBe(asked);
});

test("a search, a later page or a machine that never answered keeps nothing and says so", async () => {
  const { listings, link } = far(STORE);
  await listings.list("m1", { harness: "claude", q: "report" });
  await listings.list("m1", { harness: "claude", cursor: "x" });
  expect(listings.cached("m1", { harness: "claude" })).toBeUndefined();
  link.up = false;
  await expect(listings.list("m1", { harness: "claude" })).rejects.toThrow("no answer");
  // What the machine refused is the caller's, never the kept list.
  link.up = true;
  await listings.list("m1", { harness: "claude" });
  await expect(listings.list("m1", { harness: "claude", q: "refused" })).rejects.toThrow("cursor");
  // A machine taken away leaves nothing of it.
  listings.forget("m1");
  expect(listings.cached("m1", { harness: "claude" })).toBeUndefined();
});

test("the transcripts a harness holds open are found from its own lists, not by walking the store", () => {
  const all = [row("live", "Open in Claude", 5), row("quiet", "Not open", 4), row("rollout", "Resumed Codex", 3, "codex"), row("other", "Not resumed", 2, "codex"), row("gem", "Antigravity", 1, "agy")];
  const at = {
    claude: [{ pid: 10, sessionId: "live", listed: true }, { pid: 11, sessionId: "gone", listed: true }],
    procs: [
      { pid: 10, ppid: 1, pgid: 10, started_ms: 1, args: "claude" },
      { pid: 20, ppid: 1, pgid: 20, started_ms: 1, args: "/usr/bin/codex resume rollout" },
      { pid: 30, ppid: 1, pgid: 30, started_ms: 1, args: "vim notes about other" },
    ],
  };
  expect(runningOf(all, at as any).map((f) => f.id)).toEqual(["live", "rollout"]);
});

test("a Codex process is found by the file it holds open where /proc says nothing, as lsof tells it", () => {
  const all = [row("held", "Held open", 5, "codex"), row("idle", "Not held", 4, "codex"), row("shared", "On an app-server", 3, "codex")];
  const at = {
    claude: [],
    procs: [
      { pid: 20, ppid: 1, pgid: 20, started_ms: 1, args: "/opt/homebrew/bin/codex" },
      { pid: 21, ppid: 1, pgid: 21, started_ms: 1, args: "codex app-server" },
      { pid: 22, ppid: 1, pgid: 22, started_ms: 1, args: "vim /far/idle.jsonl" },
    ],
    files: new Map([[20, new Set(["/far/held.jsonl", "/tmp/other"])], [21, new Set(["/far/shared.jsonl"])], [22, new Set(["/far/idle.jsonl"])]]),
  };
  expect(runningOf(all, at as any).map((f) => f.id)).toEqual(["held", "shared"]);
});

test("lsof's field output is read as the files each process holds, paths only", () => {
  const out = "p71482\nfcwd\nn/Users/o\nftxt\nn/opt/homebrew/bin/codex\nf5\nn*:8080\nf6\nn->127.0.0.1:443\nf7\nn/Users/o/.codex/sessions/2026/11/rollout-a.jsonl\np9\nf3\nn/tmp/x\n";
  const got = parseLsof(out);
  expect([...got.get(71482)!]).toEqual(["/Users/o", "/opt/homebrew/bin/codex", "/Users/o/.codex/sessions/2026/11/rollout-a.jsonl"]);
  expect([...got.get(9)!]).toEqual(["/tmp/x"]);
});
