// The observe routes over a real store, where the e2e cannot reach: a session
// with more traces than a list may return.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../../core/bus.ts";
import { Store } from "../../core/store.ts";
import { allHooks } from "../../engine/hooks.ts";
import { fixKey, observeRoutes, topFrame } from "./observe.ts";
import { personTyped } from "../../safety/imported.ts";

const hooksAtStart = allHooks().length; // the routes register turn hooks on this store: taken off before it closes
const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "observe-routes-"));
const store = new Store(dir);
// The errors a fix is asked for, and the prompts the fix sessions were sent.
const rows = new Map<string, any>();
const sent: string[] = [];
const sentData: any[] = [];
const routes = observeRoutes({
  store, bus: new Bus(), workspace: dir,
  engine: { isRunning: () => false, statusOf: () => undefined, send: (id: string, text: string, o?: { meta?: object }) => { sent.push(id); sentData.push({ text, ...o?.meta }); } },
  providers: { defaultModel: async () => "p:m", resolve: async () => ({}) },
  errors: { capture: () => {}, get: (id: string) => rows.get(id), find: (id: string) => rows.get(id) },
} as any) as any;
const G = globalThis as any;
afterAll(() => {
  clearInterval(G.__keelSpanPrune);
  G.__keelOtlp?.stop();
  G.__keelOtlpOff?.();
  allHooks().length = hooksAtStart;
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the trace list takes a whole number from 1, gives 50 by default and never more than 200", async () => {
  const s = store.createSession({ workspace: dir, model: "p:m" });
  const now = Date.now();
  const add = store.db.prepare("INSERT INTO spans (span_id, trace_id, session_id, kind, name, start_ms, end_ms, status, attrs) VALUES (?, ?, ?, 'turn', 'invoke_agent', ?, ?, 'ok', '{}')");
  for (let i = 0; i < 250; i++) add.run(i.toString(16).padStart(16, "0"), i.toString(16).padStart(32, "0"), s.id, now - i * 1000, now - i * 1000 + 5);
  const list = (limit?: string) => routes["/api/debug/traces"].GET(new Request(`http://x/api/debug/traces?session_id=${s.id}${limit === undefined ? "" : `&limit=${limit}`}`)) as Response;
  const count = async (limit?: string) => ((await list(limit).json()) as any).traces.length;

  for (const bad of ["-1", "2.5", "0", "abc", "", "1e2"]) {
    const r = list(bad);
    expect([bad, r.status]).toEqual([bad, 400]);
    expect(((await r.json()) as any).error).toContain("whole number");
  }
  expect(await count()).toBe(50);
  expect(await count("3")).toBe(3);
  expect(await count("200")).toBe(200);
  expect(await count("100000")).toBe(200);
  expect(await count("99999999999999999999999999")).toBe(200);
  // Newest first.
  expect(((await list("1").json()) as any).traces[0].span_id).toBe("0".repeat(16));
});

test("a retry whose kept request aged out is not offered for replay, and says why when asked", async () => {
  const s = store.createSession({ workspace: dir, model: "p:m" });
  store.db.run("INSERT INTO spans (span_id, trace_id, session_id, kind, name, start_ms, end_ms, status, error, error_type, attrs) VALUES ('lone-retry', 'trace-lone-retry', ?, 'request', 'chat m', ?, ?, 'error', 'HTTP 529', 'overloaded', ?)", [s.id, Date.now() - 10, Date.now(), JSON.stringify({ request_in: "aged-out" })]);
  const at = (method: "GET" | "POST", path: string) => {
    const r = new Request(`http://x/api/debug/spans/lone-retry${path}`, { method }) as any;
    r.params = { id: "lone-retry" };
    return routes[`/api/debug/spans/:id${path}`][method](r) as Promise<Response>;
  };
  expect(((await (await at("GET", "")).json()) as any).span.replayable).toBe(false);
  const r = await at("POST", "/replay");
  expect(r.status).toBe(409);
  expect(((await r.json()) as any).error).toContain("aged out");
});

// FIND-S54: one fix a failure's cause. Two presses on errors of one cause, a moment apart, start one session; a later
// press opens it while it is not archived, and the fixes list names it for each error of the cause.
test("two Fix presses on one cause start one session, and a later one opens it", async () => {
  const now = Date.now();
  for (const id of ["stall-a", "stall-b"]) rows.set(id, { id, ts: now, source: "server", message: `The loop was held for ${id === "stall-a" ? 812 : 2301} ms: reading the call marks`, stack: null, context: null });
  rows.set("other", { id: "other", ts: now, source: "server", message: "TypeError: x is undefined", stack: null, context: null });
  const fix = (error_id: string) => routes["/api/debug/fix"].POST(new Request("http://x/api/debug/fix", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ error_id }) })) as Promise<Response>;
  const [one, two] = await Promise.all([fix("stall-a"), fix("stall-b")]);
  expect([one.status, two.status].sort()).toEqual([200, 201]);
  const a = (await one.json()) as any, b = (await two.json()) as any;
  expect(a.session.id).toBe(b.session.id);
  expect(one.status === 200 ? a.existing : b.existing).toBe(true);
  expect(sent).toEqual([a.session.id]);
  // Keel's brief, never the owner's typing in the memory transcript.
  expect(personTyped({ own: false, until: 0 }, { kind: "user", seq: 1, ts: 1, data: sentData[0] })).toBe(false);
  const reopened = await fix("stall-b");
  expect(reopened.status).toBe(200);
  const later = (await reopened.json()) as any;
  expect([later.session.id, later.existing]).toEqual([a.session.id, true]);
  // Another cause is another fix.
  const other = (await (await fix("other")).json()) as any;
  expect(other.session.id).not.toBe(a.session.id);
  const listed = (await (routes["/api/debug/fixes"].GET(new Request("http://x/api/debug/fixes?error_ids=stall-a,stall-b,other,none")) as Response).json()) as any;
  expect(listed.fixes).toEqual({ "stall-a": a.session.id, "stall-b": a.session.id, other: other.session.id });
  // An archived fix frees its cause: the next press starts a fresh one.
  store.db.query("UPDATE sessions SET archived = 1 WHERE id = ?").run(a.session.id);
  const created = await fix("stall-a");
  expect(created.status).toBe(201);
  const fresh = (await created.json()) as any;
  expect(fresh.session.id).not.toBe(a.session.id);
  expect(fresh.existing).toBeUndefined();
});

// Failures that read alike are one fix only from one place: a server error's top frame, else the failing session's folder.
test("a fix's cause is told apart by the top frame of a stack, else by the failing session's folder", () => {
  const at = (fn: string, file: string, line: number) => `TypeError: x is undefined\n    at ${fn} (/src/${file}:${line}:9)\n    at run (/src/loop.ts:1:1)`;
  const e = (o: any) => ({ source: "server", message: "TypeError: x is undefined", ...o });
  expect(topFrame(at("readMarks", "store.ts", 12))).toBe("readMarks@store.ts");
  expect(topFrame("Error: x\n    at /src/a.ts:3:4")).toBe("@a.ts");
  expect(topFrame(undefined)).toBeUndefined();
  // The same frame after a rebuild moved its line: one cause; another function: another.
  expect(fixKey({}, e({ stack: at("readMarks", "store.ts", 12) }))).toBe(fixKey({}, e({ stack: at("readMarks", "store.ts", 40) }))!);
  expect(fixKey({}, e({ stack: at("readMarks", "store.ts", 12) }))).not.toBe(fixKey({}, e({ stack: at("sendFrame", "app.ts", 12) }))!);
  // A tool's failure in two folders is two fixes; two sessions of one folder are one.
  const folders: Record<string, string> = { s1: "/w/a", s2: "/w/b", s3: "/w/a" };
  const tool = (sid: string) => fixKey({}, { source: "tool", message: "ENOENT: no such file", session_id: sid }, (id) => folders[id]);
  expect(tool("s1")).not.toBe(tool("s2")!);
  expect(tool("s1")).toBe(tool("s3")!);
});
