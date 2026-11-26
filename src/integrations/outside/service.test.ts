// The watcher over fixture stores of Claude Code and Codex in a scratch folder: what it watches,
// what it reads of a file that grows, what its copy appends, and what the owner's settings change.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Store } from "../../core/store.ts";
import { Bus } from "../../core/bus.ts";
import { ownEnv } from "../../../test/env.ts";
import { Outside } from "./service.ts";
import { OUTSIDE_DEFAULTS, type OutsideSettings } from "./settings.ts";

const top = mkdtempSync(join(tmpdir(), "keel-outside-"));
// Each rig points the readers at its own stores; the file puts the environment back when it ends.
ownEnv({ KEEL_IMPORT_CLAUDE_DIR: undefined, KEEL_IMPORT_CODEX_DIR: undefined, KEEL_IMPORT_AGY_DIR: undefined });
afterAll(() => rmSync(top, { recursive: true, force: true }));

let k = 0;
function rig(cfg: Partial<OutsideSettings> = {}, viewed = false) {
  const dir = join(top, String(k++));
  const claude = join(dir, "claude", "projects");
  const codex = join(dir, "codex");
  mkdirSync(claude, { recursive: true });
  mkdirSync(join(codex, "sessions"), { recursive: true });
  process.env.KEEL_IMPORT_CLAUDE_DIR = claude;
  process.env.KEEL_IMPORT_CODEX_DIR = codex;
  const agy = join(dir, "gemini");
  process.env.KEEL_IMPORT_AGY_DIR = agy;
  const store = new Store(join(dir, "state"));
  const settings = { ...OUTSIDE_DEFAULTS, ...cfg };
  const o = new Outside({ store, bus: new Bus(), workspace: dir, settings: () => settings, viewed: () => viewed });
  o.start();
  const done = () => { o.stop(); store.db.close(); };
  return { dir, claude, codex, agy, store, o, settings, done };
}

const until = async <T>(f: () => T | undefined, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

// A Claude Code transcript written as it would be: each record under the one before it.
function transcript(path: string, cwd: string, id: string) {
  let n = 0;
  let parent: string | null = null;
  const uuids: string[] = [];
  const write = (r: object, under: string | null = parent) => {
    const uuid = `${id}-${n++}`;
    appendFileSync(path, JSON.stringify({ cwd, sessionId: id, isSidechain: false, userType: "external", entrypoint: "cli", timestamp: new Date().toISOString(), uuid, parentUuid: under, ...r }) + "\n");
    parent = uuid;
    uuids.push(uuid);
    return uuid;
  };
  return {
    uuids,
    user: (text: string, under?: string | null) => write({ type: "user", message: { role: "user", content: text } }, under),
    reply: (mid: string, text: string) => write({ type: "assistant", message: { id: mid, role: "assistant", model: "claude-opus-4-5", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } } }),
    end: () => write({ type: "system", subtype: "turn_duration", durationMs: 1000 }),
    calls: (mid: string, ids: string[]) => write({ type: "assistant", message: { id: mid, role: "assistant", model: "claude-opus-4-5", content: ids.map((id) => ({ type: "tool_use", id, name: "Bash", input: { command: id } })), stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 } } }),
    result: (id: string, text: string) => write({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: true }] } }),
  };
}

const sessionOf = (store: Store, sourceId: string) => store.sessions({ outside: true }).find((s) => s.outside?.source_id === sourceId);
const stored = (store: Store, id: string) => store.db.query<{ n: number; event_id: string }, [string]>("SELECT n, event_id FROM outside_events WHERE session_id = ? ORDER BY n").all(id);

describe("outside sessions", () => {
  test("a source copied into Keel loses its session here, is never made again, and still says what it is doing", async () => {
    const r = rig();
    try {
      const cwd = join(r.dir, "w");
      mkdirSync(cwd);
      const folder = join(r.claude, "-w");
      mkdirSync(folder);
      await until(() => (r.o as any).watchers.has(folder));
      const path = join(folder, "c9.jsonl");
      const t = transcript(path, cwd, "c9");
      t.user("name a fruit");
      t.reply("m1", "quince");
      t.end();
      const s = await until(() => sessionOf(r.store, "c9"));
      // A copy is made: the session this record showed of the source goes.
      let copied = false;
      (r.o as any).d.copied = () => copied;
      copied = true;
      r.o.copiedNow("claude", "c9");
      expect(r.store.session(s.id)).toBeUndefined();
      expect(sessionOf(r.store, "c9")).toBeUndefined();
      // The source goes on: no session of its own comes back, and its state is still told.
      t.user("and another");
      await until(() => r.o.status().reads >= 2);
      await new Promise((res) => setTimeout(res, 200));
      expect(sessionOf(r.store, "c9")).toBeUndefined();
      expect(r.o.runningOf("claude", "c9")?.state).toBe("working");
    } finally { r.done(); }
  });

  test("a copy appends only what the file gained; a rewind reads it again and goes on as a new branch", async () => {
    const r = rig();
    try {
      const cwd = join(r.dir, "w");
      mkdirSync(cwd);
      const folder = join(r.claude, "-w");
      mkdirSync(folder);
      await until(() => r.o.status().watches >= 2 && (r.o as any).watchers.has(folder));
      const path = join(folder, "c1.jsonl");
      const t = transcript(path, cwd, "c1");
      for (let i = 0; i < 100; i++) { t.user(`question ${i} ${"x".repeat(400)}`); t.reply(`m${i}`, `answer ${i}`); }
      t.end();
      const s = await until(() => sessionOf(r.store, "c1")?.outside?.state === "done" ? sessionOf(r.store, "c1") : undefined);
      await r.o.sync(s.id);
      const first = stored(r.store, s.id);
      expect(first.length).toBe(200);
      expect(r.o.stats.copy_bytes).toBe(statSync(path).size);
      expect(r.o.stats.full_copies).toBe(1);

      // It grows: only the new part is read, and its events are appended under the last one.
      const was = statSync(path).size;
      t.user("one more");
      t.reply("m-last", "the last answer");
      t.end();
      await until(() => r.o.status().reads >= 2 && sessionOf(r.store, "c1")?.outside?.state === "done");
      await r.o.sync(s.id);
      expect(r.o.stats.copy_bytes).toBe(statSync(path).size);
      expect(r.o.stats.copy_bytes - was).toBe(statSync(path).size - was);
      expect(r.o.stats.full_copies).toBe(1);
      const second = stored(r.store, s.id);
      expect(second.length).toBe(202);
      expect(second.slice(0, 200)).toEqual(first);
      expect(r.store.event(second[200]!.event_id)?.parent).toBe(first[199]!.event_id);

      // The owner rewound to the fifth answer and asked again: read again, a branch from there.
      t.user("ask it another way", t.uuids[9]!);
      t.reply("m-again", "another answer");
      t.end();
      await until(() => r.o.status().reads >= 3 && sessionOf(r.store, "c1")?.outside?.state === "done");
      await r.o.sync(s.id);
      expect(r.o.stats.full_copies).toBe(2);
      const third = stored(r.store, s.id);
      expect(third.length).toBe(12);
      expect(third.slice(0, 10)).toEqual(first.slice(0, 10));
      expect(r.store.event(third[10]!.event_id)?.parent).toBe(first[9]!.event_id);
      expect(r.store.event(third[10]!.event_id)?.data.text).toBe("ask it another way");
    } finally { r.done(); }
  });

  test("a trailing tool result is copied once the file is quiet; a later result is an event of its own, also after a restart", async () => {
    const r = rig({}, true);
    try {
      const cwd = join(r.dir, "w");
      mkdirSync(cwd);
      const folder = join(r.claude, "-w");
      mkdirSync(folder);
      await until(() => (r.o as any).watchers.has(folder));
      const path = join(folder, "c7.jsonl");
      const t = transcript(path, cwd, "c7");
      t.user("deploy it");
      t.calls("m1", ["a", "b"]);
      t.result("a", "deploy failed: permission denied");
      const s = await until(() => sessionOf(r.store, "c7"));
      expect(s.outside?.state).toBe("working");
      const kinds = () => stored(r.store, s.id).map((x) => r.store.event(x.event_id)?.kind);
      // Nothing more is written: the result the model now thinks over is shown all the same.
      await until(() => kinds().at(-1) === "tool_result" ? true : undefined);
      const first = stored(r.store, s.id);
      expect(kinds()).toEqual(["user", "assistant", "tool_result"]);
      expect(r.store.event(first[2]!.event_id)?.data.results.map((x: any) => x.tool_use_id)).toEqual(["a"]);

      // The round's other result comes later: an event of its own under it, nothing stored changes.
      t.result("b", "second result");
      await until(() => stored(r.store, s.id).length === 4 ? true : undefined);
      const second = stored(r.store, s.id);
      expect(second.slice(0, 3)).toEqual(first);
      expect(r.store.event(second[3]!.event_id)?.parent).toBe(first[2]!.event_id);
      expect(r.store.event(second[3]!.event_id)?.data.results.map((x: any) => x.tool_use_id)).toEqual(["b"]);

      // A daemon that starts again converts the file from its start to the same events: no new branch.
      r.o.stop();
      const o = new Outside({ store: r.store, bus: new Bus(), workspace: r.dir, settings: () => r.settings, viewed: () => true });
      o.start();
      try {
        t.reply("m2", "it is fixed");
        t.end();
        await until(() => sessionOf(r.store, "c7")?.outside?.state === "done");
        await o.sync(s.id);
        const third = stored(r.store, s.id);
        expect(third.slice(0, 4)).toEqual(second);
        expect(third.length).toBe(5);
        expect(r.store.event(third[4]!.event_id)?.parent).toBe(second[3]!.event_id);
      } finally { o.stop(); }
    } finally { r.done(); }
  });

  test("only folders with a session in the days are watched; a prompt in the history finds one in an older folder", async () => {
    const r = rig({ days: 30 });
    r.o.stop();
    try {
      const old = Date.now() / 1000 - 40 * 86_400;
      const cwd = join(r.dir, "old");
      mkdirSync(cwd);
      const oldDir = join(r.claude, "-old"), newDir = join(r.claude, "-new");
      mkdirSync(oldDir);
      mkdirSync(newDir);
      const t = transcript(join(oldDir, "c2.jsonl"), cwd, "c2");
      t.user("an old question");
      t.reply("m1", "an old answer");
      t.end();
      appendFileSync(join(newDir, "c3.jsonl"), "");
      utimesSync(join(oldDir, "c2.jsonl"), old, old);
      utimesSync(oldDir, old, old);
      // A Codex day folder named 40 days ago, and today's.
      const day = (d: Date) => join(r.codex, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
      const oldDay = day(new Date(Date.now() - 40 * 86_400_000)), today = day(new Date());
      mkdirSync(oldDay, { recursive: true });
      mkdirSync(today, { recursive: true });
      utimesSync(oldDay, old, old);
      const o = new Outside({ store: r.store, bus: new Bus(), workspace: r.dir, settings: () => r.settings });
      o.start();
      try {
        const watched = () => (o as any).watchers as Map<string, unknown>;
        await until(() => watched().has(newDir) && watched().has(today));
        await new Promise((ok) => setTimeout(ok, 200));
        expect(watched().has(oldDir)).toBe(false);
        expect(watched().has(oldDay)).toBe(false);

        // The owner resumes the old session: its prompt goes to the history and its file grows.
        t.user("and now?");
        appendFileSync(join(r.dir, "claude", "history.jsonl"), JSON.stringify({ display: "and now?", timestamp: Date.now(), project: cwd, sessionId: "c2" }) + "\n");
        await until(() => watched().has(oldDir));
        const s = await until(() => sessionOf(r.store, "c2"));
        expect(s.outside?.state).toBe("working");
      } finally { o.stop(); }
    } finally { r.done(); }
  });

  test("a session that works with no record for the stale time is stale, and a record makes it working again", async () => {
    const r = rig({ stale_minutes: 0.005 });
    try {
      const cwd = join(r.dir, "w");
      mkdirSync(cwd);
      const folder = join(r.claude, "-w");
      mkdirSync(folder);
      await until(() => (r.o as any).watchers.has(folder));
      const t = transcript(join(folder, "c4.jsonl"), cwd, "c4");
      t.user("start a long job");
      expect((await until(() => sessionOf(r.store, "c4"))).outside?.state).toBe("working");
      await until(() => sessionOf(r.store, "c4")?.outside?.state === "stale");
      t.user("are you there?");
      await until(() => sessionOf(r.store, "c4")?.outside?.state === "working");
    } finally { r.done(); }
  });

  test("an excluded folder's sessions are not made; watching off closes every watch; an archived session is left as it was", async () => {
    const r = rig();
    try {
      const keep = join(r.dir, "keep"), skip = join(r.dir, "skip");
      mkdirSync(keep);
      mkdirSync(join(skip, "sub"), { recursive: true });
      r.settings.exclude = [skip];
      const a = join(r.claude, "-keep"), b = join(r.claude, "-skip-sub");
      mkdirSync(a);
      mkdirSync(b);
      await until(() => (r.o as any).watchers.has(a) && (r.o as any).watchers.has(b));
      const x = transcript(join(b, "c5.jsonl"), join(skip, "sub"), "c5");
      x.user("not to be shown");
      const y = transcript(join(a, "c6.jsonl"), keep, "c6");
      y.user("shown");
      const s = await until(() => sessionOf(r.store, "c6"));
      await until(() => r.o.status().reads >= 2);
      expect(sessionOf(r.store, "c5")).toBeUndefined();

      // Archived: its row stays as it was while its file goes on.
      r.store.updateSession(s.id, { archived: true });
      y.reply("m1", "done");
      y.end();
      await until(() => r.o.status().reads >= 3);
      await new Promise((ok) => setTimeout(ok, 100));
      expect(r.store.session(s.id)?.outside?.state).toBe("working");
      r.store.updateSession(s.id, { archived: false });
      y.user("again");
      await until(() => r.o.status().reads >= 4);

      // Off: nothing is watched.
      r.settings.enabled = false;
      (r.o as any).settled();
      expect(r.o.status().watches).toBe(0);
      expect(r.o.status().enabled).toBe(false);
      r.settings.enabled = true;
      (r.o as any).settled();
      await until(() => r.o.status().watches > 0);
    } finally { r.done(); }
  });

  // Antigravity's command line store as it is laid out: its list with each conversation's run status, a transcript a
  // step a line under brain/<id>/.system_generated/logs.
  test("an Antigravity conversation is followed as it runs: its state from its steps and its list, its copy as it grows, a rewind a branch", async () => {
    const r = rig({}, true);
    try {
      const cli = join(r.agy, "antigravity-cli");
      mkdirSync(join(cli, "brain"), { recursive: true });
      const db = new Database(join(cli, "conversation_summaries.db"), { create: true });
      db.exec("CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT '', preview text NOT NULL DEFAULT '', last_modified_time datetime NOT NULL, workspace_uris text NOT NULL, status text NOT NULL DEFAULT '', parent_conversation_id text NOT NULL DEFAULT '')");
      const cwd = join(r.dir, "w");
      mkdirSync(cwd);
      const id = "aaaa1111-0000-4000-8000-00000000000a", child = "aaaa1111-0000-4000-8000-00000000000b";
      const listed = (cid: string, status: string, parent = "") => db.query("INSERT OR REPLACE INTO conversation_summaries (conversation_id, title, last_modified_time, workspace_uris, status, parent_conversation_id) VALUES (?, 'Quince notes', ?, ?, ?, ?)").run(cid, new Date().toISOString(), JSON.stringify([`file://${cwd}`]), status, parent);
      await until(() => (r.o as any).watchers.has(join(cli, "brain")));
      const logs = (cid: string) => join(cli, "brain", cid, ".system_generated", "logs");
      const step = (cid: string, x: object) => appendFileSync(join(logs(cid), "transcript_full.jsonl"), JSON.stringify({ status: "DONE", created_at: new Date().toISOString(), ...x }) + "\n");
      listed(id, "CASCADE_RUN_STATUS_RUNNING");
      listed(child, "CASCADE_RUN_STATUS_RUNNING", id);
      mkdirSync(logs(id), { recursive: true });
      mkdirSync(logs(child), { recursive: true });
      await until(() => (r.o as any).watchers.has(logs(id)));
      step(id, { step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", content: "<USER_REQUEST>Which fruit is in the notes?</USER_REQUEST>" });
      step(id, { step_index: 1, type: "PLANNER_RESPONSE", model: "agy-model", input_tokens: 10, output_tokens: 5, cache_read_tokens: 100, tool_calls: [{ name: "run_command", args: { CommandLine: "cat notes.md" } }] });
      step(child, { step_index: 0, type: "PLANNER_RESPONSE", model: "agy-model", content: "a subagent's own" });
      const s = await until(() => sessionOf(r.store, id)?.outside?.doing ? sessionOf(r.store, id) : undefined);
      expect(s.outside).toMatchObject({ harness: "agy", state: "working", doing: { tool: "run_command" }, model: "agy-model" });
      expect(s.title).toBe("Quince notes");
      // A subagent's conversation is no session here.
      expect(sessionOf(r.store, child)).toBeUndefined();

      // The call's result and the answer; the list says the run is idle.
      step(id, { step_index: 2, type: "RUN_COMMAND", exit_code: 0, content: "quince" });
      step(id, { step_index: 3, type: "PLANNER_RESPONSE", model: "agy-model", input_tokens: 20, output_tokens: 7, content: "The fruit is quince." });
      listed(id, "CASCADE_RUN_STATUS_IDLE");
      await until(() => sessionOf(r.store, id)?.outside?.state === "done");
      expect(sessionOf(r.store, id)!.usage).toMatchObject({ input: 30, output: 12, cache_read: 100 });
      await r.o.sync(s.id);
      const first = stored(r.store, s.id).map((x) => r.store.event(x.event_id)!);
      expect(first.map((e) => e.kind)).toEqual(["user", "assistant", "tool_result", "assistant"]);
      expect(first[2]!.data.results[0].content).toBe("quince");
      expect((await r.o.details(s.id))?.label).toBe("Antigravity");
      // Antigravity's run status holds a turn its steps ended as one at work.
      listed(id, "CASCADE_RUN_STATUS_RUNNING");
      await until(() => sessionOf(r.store, id)?.outside?.state === "working");

      // Antigravity went back to the answer and made another: the copy goes on from there as a branch.
      step(id, { step_index: 3, type: "PLANNER_RESPONSE", model: "agy-model", content: "Quince, and a pear." });
      listed(id, "CASCADE_RUN_STATUS_IDLE");
      await until(() => sessionOf(r.store, id)?.outside?.state === "done");
      await r.o.sync(s.id);
      const second = stored(r.store, s.id);
      expect(second.length).toBe(4);
      expect(second.slice(0, 3)).toEqual(stored(r.store, s.id).slice(0, 3));
      expect(second.slice(0, 3).map((x) => x.event_id)).toEqual(first.slice(0, 3).map((e) => e.id));
      const answer = r.store.event(second[3]!.event_id)!;
      expect(answer.parent).toBe(first[2]!.id);
      expect(answer.data.blocks[0].text).toBe("Quince, and a pear.");
      db.close();
    } finally { r.done(); }
  });

  // Antigravity writes a tool's result step before the step that made the call. A read between the two holds the
  // result for its call: no reread from the start, no branch. Its list is read without a write in its folder.
  test("an Antigravity result written before its call is held for it, and the list is read with nothing written beside it", async () => {
    const r = rig({}, true);
    try {
      const cli = join(r.agy, "antigravity-cli");
      mkdirSync(join(cli, "brain"), { recursive: true });
      const list = join(cli, "conversation_summaries.db");
      const db = new Database(list, { create: true });
      db.exec("CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT '', preview text NOT NULL DEFAULT '', last_modified_time datetime NOT NULL, workspace_uris text NOT NULL, status text NOT NULL DEFAULT '', parent_conversation_id text NOT NULL DEFAULT '')");
      const cwd = join(r.dir, "w");
      mkdirSync(cwd);
      const id = "bbbb1111-0000-4000-8000-00000000000a";
      const listed = (status: string) => db.query("INSERT OR REPLACE INTO conversation_summaries (conversation_id, title, last_modified_time, workspace_uris, status) VALUES (?, 'Pear notes', ?, ?, ?)").run(id, new Date().toISOString(), JSON.stringify([`file://${cwd}`]), status);
      await until(() => (r.o as any).watchers.has(join(cli, "brain")));
      const logs = join(cli, "brain", id, ".system_generated", "logs");
      const step = (x: object) => appendFileSync(join(logs, "transcript_full.jsonl"), JSON.stringify({ status: "DONE", created_at: new Date().toISOString(), ...x }) + "\n");
      listed("CASCADE_RUN_STATUS_RUNNING");
      mkdirSync(logs, { recursive: true });
      await until(() => (r.o as any).watchers.has(logs));
      step({ step_index: 0, type: "USER_INPUT", source: "USER_EXPLICIT", content: "<USER_REQUEST>Which fruit?</USER_REQUEST>" });
      step({ step_index: 2, type: "VIEW_FILE", content: "pear" });
      const s = await until(() => sessionOf(r.store, id));
      await r.o.sync(s.id);
      const copies = (r.o as any).stats.full_copies;
      step({ step_index: 1, type: "PLANNER_RESPONSE", model: "agy-model", tool_calls: [{ name: "view_file", args: { AbsolutePath: "notes.md" } }] });
      step({ step_index: 3, type: "PLANNER_RESPONSE", model: "agy-model", content: "A pear." });
      listed("CASCADE_RUN_STATUS_IDLE");
      await until(() => sessionOf(r.store, id)?.outside?.state === "done");
      await r.o.sync(s.id);
      const events = stored(r.store, s.id).map((x) => r.store.event(x.event_id)!);
      expect(events.map((e) => e.kind)).toEqual(["user", "assistant", "tool_result", "assistant"]);
      expect(events[2]!.data.results[0]).toMatchObject({ tool_use_id: events[1]!.data.blocks[0].id, content: "pear" });
      expect(events.map((e) => e.parent)).toEqual([null, events[0]!.id, events[1]!.id, events[2]!.id]);
      expect((r.o as any).stats.full_copies).toBe(copies);
      db.close();
      expect(readdirSync(cli).filter((f) => f.startsWith("conversation_summaries.db")).sort()).toEqual(["conversation_summaries.db"]);
    } finally { r.done(); }
  });
});
