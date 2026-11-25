import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchSettings } from "../admin/settings.ts";
import { Store } from "../core/store.ts";
import { AcpRunner } from "./external.ts";

// keel-bun as an ACP client against the fixture agent in its v2 mode (test/e2e/fixtures/acp-agent-standin.ts, a
// real process): which protocol each connection speaks, the agent's background work, and a prompt sent again.
const fixture = join(import.meta.dirname, "../../test/e2e/fixtures/acp-agent-standin.ts");
const dirs: string[] = [];
afterAll(() => { patchSettings({ acp: null }); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function world(opts: { v2Agent?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "keel-acp-v2-"));
  dirs.push(dir);
  const ws = join(dir, "ws");
  mkdirSync(ws);
  const store = new Store(join(dir, "state"));
  const s = store.createSession({ model: "acp:v2", workspace: ws, title: "T" });
  const agent = { id: "v2", name: "Standin", source: "custom", run: { command: process.execPath, args: [fixture, ...(opts.v2Agent === false ? [] : ["v2"])] } };
  const errors: unknown[] = [];
  const make = () => new AcpRunner(store, { get: () => agent, learn() {}, learnCommands() {}, learned: () => undefined } as any, (async () => undefined) as any, (e) => errors.push(e));
  const io = (signal = new AbortController().signal, stopper?: () => string | undefined) => ({
    signal, stopper,
    events: () => store.events(s.id),
    append: (kind: any, data: any) => store.append(s.id, kind, data),
    delta() {}, status() {},
    runTool: async () => ({}),
  }) as any;
  const say = (text: string, origin?: string) => store.append(s.id, "user", { text, ...(origin ? { origin } : {}) });
  const said = () => store.events(s.id).filter((e) => e.kind === "assistant").flatMap((e) => e.data.blocks.filter((b: any) => b.type === "text").map((b: any) => b.text as string)).join("");
  const runs = () => (existsSync(join(ws, ".v2-runs.log")) ? readFileSync(join(ws, ".v2-runs.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { store, s, ws, make, io, say, said, runs, errors };
}
const until = async (f: () => unknown, ms = 10_000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timed out"); await Bun.sleep(20); } };

test("the default speaks v1 to an agent that offers v2", async () => {
  patchSettings({ acp: { protocol: "v1" } });
  const w = world();
  const r = w.make();
  w.say("which model");
  const t = await r.turn(w.store.session(w.s.id)!, w.io());
  expect(t.reason).toBe("end_turn");
  expect(t.extra).toBeUndefined();
  expect(r.protocol(w.s.id)).toBe(1);
  expect(w.said()).toContain("model fast, effort low");
  r.dispose();
});

test("auto negotiates v2 with an agent that offers it: the prompt's message id is kept with the turn, the work ends at its idle state", async () => {
  patchSettings({ acp: { protocol: "auto" } });
  const w = world();
  const r = w.make();
  w.say("make a build folder");
  const t = await r.turn(w.store.session(w.s.id)!, w.io());
  expect(r.protocol(w.s.id)).toBe(2);
  expect(t.reason).toBe("end_turn");
  // The id the agent gave the inserted message is the one it logged, and it rides to the turn's end.
  expect(t.extra).toEqual({ acp_message_id: w.runs()[0].messageId });
  // The whole message that followed its chunks added only what was new; the call finished by its permission.
  expect(w.said()).toBe("Done: allowed");
  const results = w.store.events(w.s.id).filter((e) => e.kind === "tool_result").flatMap((e) => e.data.results);
  expect(results.map((x: any) => x.content[0].text)).toEqual(["made"]);
  // The key is gone with the finished prompt.
  expect(w.store.db.query("SELECT count(*) AS n FROM acp_prompt_keys").get()).toEqual({ n: 0 });
  r.dispose();
});

test("auto keeps v1 for an agent that answers 1, on the connection it has", async () => {
  patchSettings({ acp: { protocol: "auto" } });
  const w = world({ v2Agent: false });
  const r = w.make();
  w.say("which model");
  const t = await r.turn(w.store.session(w.s.id)!, w.io());
  expect(t.reason).toBe("end_turn");
  expect(r.protocol(w.s.id)).toBe(1);
  expect(w.said()).toContain("model fast, effort low");
  r.dispose();
});

test("a failure the agent reports at its idle state fails the turn with its words", async () => {
  patchSettings({ acp: { protocol: "auto" } });
  const w = world();
  const r = w.make();
  w.say("boom");
  await expect(r.turn(w.store.session(w.s.id)!, w.io())).rejects.toThrow("The model service failed.");
  r.dispose();
});

test("the background list is the session's jobs, and one is stopped alone with the cancel its agent offered", async () => {
  patchSettings({ acp: { protocol: "auto" } });
  const w = world();
  const r = w.make();
  w.say("start the background things");
  const t = await r.turn(w.store.session(w.s.id)!, w.io());
  expect(t.reason).toBe("end_turn");
  const views = () => r.background(w.s.id).map((v) => `${v.id} ${v.can_stop ? "stoppable" : "fixed"}`);
  expect(views()).toEqual(["terminal:term-dev stoppable", "terminal:term-log fixed", "tool_call:call-watch stoppable"]);
  expect(r.background(w.s.id)[0]).toMatchObject({ kind: "terminal", title: "npm run dev", last: "npm run dev: listening" });
  // The terminal that offered no cancel is not asked.
  expect(r.stopBackground(w.s.id, "terminal:term-log")).toContain("did not offer");
  // One terminal is stopped: the agent reports its exit and lists the rest.
  expect(r.stopBackground(w.s.id, "terminal:term-dev")).toBeUndefined();
  await until(() => views().length === 2);
  expect(views()).toEqual(["terminal:term-log fixed", "tool_call:call-watch stoppable"]);
  // The tool call is stopped on its own, and the session is not touched.
  expect(r.stopBackground(w.s.id, "tool_call:call-watch")).toBeUndefined();
  await until(() => views().length === 1);
  expect(views()).toEqual(["terminal:term-log fixed"]);
  expect(r.stopBackground(w.s.id, "terminal:term-dev")).toContain("does not list it");
  r.dispose();
});

// A restart cuts a turn whose prompt the agent took. The agent keeps its keys in files of the session's folder, as an
// agent that retains its messages does.
async function cutTurn(w: ReturnType<typeof world>) {
  const first = w.make();
  w.say("slow work");
  const cut = first.turn(w.store.session(w.s.id)!, w.io()).catch((e) => e);
  await until(() => w.runs().length === 1);
  await until(() => first.background(w.s.id) && w.store.db.query<{ message_id: string | null }, []>("SELECT message_id FROM acp_prompt_keys").get()?.message_id);
  first.dispose();
  expect((await cut) instanceof Error).toBe(true);
  // The key stays with the prompt it was sent with.
  expect(w.store.db.query("SELECT count(*) AS n FROM acp_prompt_keys").get()).toEqual({ n: 1 });
  // What the engine adds when it goes on with a turn a restart cut.
  w.say("[harness] The daemon restarted during your previous turn.", "restart");
}

test("a prompt sent again after a restart goes with its key, and the agent that took it does not run it again", async () => {
  patchSettings({ acp: { protocol: "auto" } });
  const w = world();
  await cutTurn(w);
  const key = w.store.db.query<{ key: string }, []>("SELECT key FROM acp_prompt_keys").get()!.key;
  const again = w.make();
  const t = await again.turn(w.store.session(w.s.id)!, w.io());
  expect(t.reason).toBe("end_turn");
  expect(w.runs()).toHaveLength(1);
  expect(w.runs()[0].key).toBe(key);
  expect(w.runs()[0].text).toBe("slow work");
  // The owner is told what became of it.
  expect(w.store.events(w.s.id).some((e) => e.kind === "note" && String(e.data.text).includes("did not start it again"))).toBe(true);
  expect(w.store.db.query("SELECT count(*) AS n FROM acp_prompt_keys").get()).toEqual({ n: 0 });
  again.dispose();
}, 20_000);

test("an agent that forgot the key takes the prompt again, as the spec says of a forgotten key", async () => {
  patchSettings({ acp: { protocol: "auto" } });
  const w = world();
  await cutTurn(w);
  rmSync(join(w.ws, ".v2-keys.json"));
  const again = w.make();
  const stop = new AbortController();
  const turn = again.turn(w.store.session(w.s.id)!, w.io(stop.signal, () => "owner"));
  await until(() => w.runs().length === 2);
  stop.abort();
  expect((await turn).reason).toBe("interrupted");
  expect(w.runs().map((x) => x.text)).toEqual(["slow work", "slow work"]);
  again.dispose();
}, 20_000);
