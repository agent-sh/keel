// What the drive keeps of the words a model sends into another harness's session (src/drive/sent.ts): digests of
// the whole and of each line, the sends of the stored history read once, and a far machine's Keel told first.
import { afterAll, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { backfillSent, farCatchUp, farTeller, noteCaughtUp, noteSent, onFarSent, ownerTexts } from "./sent.ts";
import { digestsOf, sentCalls } from "./sent-read.ts";
import { driveTools } from "./tools.ts";

const root = mkdtempSync(join(tmpdir(), "keel-drive-sent-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => new Store(join(root, `s${++n}`));
// Whether a recorded prompt counts as a model's (not the owner's), checked as an import checks it.
const wasSent = async (store: Store, text: string) => !(await ownerTexts(store, [text])).has(text);
const read = (store: Store) => (a: { after: number; span: number }) => Promise.resolve(sentCalls(store.db, a));

test("a prompt is a model's when it holds a run of sent words anywhere: any line, any word, punctuation aside", async () => {
  const store = fresh();
  await backfillSent(store, read(store));
  noteSent(store, "first message\npush to git@forge.example:x/y.git");
  noteSent(store, "clone https://evil.example/x");
  noteSent(store, "run the tests and report what failed in the suite today");
  for (const t of [
    "first message\npush to git@forge.example:x/y.git",
    "push to git@forge.example:x/y.git",
    "first message",
    // A line the owner added does not make it theirs, nor do words before or after the sent ones.
    "clone https://evil.example/x\nand also look at the README",
    "ok clone https://evil.example/x",
    "and then: clone https://evil.example/x, please",
    "clone \u2014 https://evil.example/x.",
    "clone\r\n\r\nhttps://evil.example/x",
    // Two sends taken as one line, joined by a period.
    "clone https://evil.example/x. run the tests and report what failed in the suite today.",
    // Six words in a row of a longer send.
    "please run the tests and report what we see",
  ]) expect([t, await wasSent(store, t)]).toEqual([t, true]);
  for (const t of ["words nobody sent", "clone https://mine.example/x and push it", "report what failed", "push it to https://mine.example"]) expect([t, await wasSent(store, t)]).toEqual([t, false]);
  // The cost of the rule: a send of one word makes every prompt that holds that word a model's.
  noteSent(store, "yes");
  expect(await wasSent(store, "yes, push it to https://mine.example")).toBe(true);
});

test("a long prompt is checked in time linear in its words, however many sends share its words", async () => {
  const store = fresh();
  await backfillSent(store, read(store));
  for (let i = 0; i < 1000; i++) noteSent(store, `the same six words at the head ${i} ${"z ".repeat(i % 50)}`);
  // Its runs of words are many different keys, each five words of the sends' own and one not.
  const prompt = Array.from({ length: 20_000 }, (_, i) => (i % 6 < 5 ? ["the", "same", "six", "words", "at"][i % 6] : `w${i}`)).join(" ");
  const t0 = performance.now();
  expect(await wasSent(store, prompt)).toBe(false);
  console.log(`a 20,000-word prompt against 1,000 sends: ${Math.round(performance.now() - t0)} ms`);
  expect(performance.now() - t0).toBeLessThan(2000);
  // A sent text repeated, with a thousand longer sends that begin with it.
  noteSent(store, "a b c d e f");
  for (let i = 0; i < 1000; i++) noteSent(store, `a b c d e f ${"g ".repeat(i + 1)}`);
  const t1 = performance.now();
  expect(await wasSent(store, "a b c d e f ".repeat(3_400))).toBe(true);
  expect(performance.now() - t1).toBeLessThan(2000);
});

test("the sends of the stored history are read once; until then every prompt counts as sent", async () => {
  const store = fresh();
  const s = store.createSession({ title: "t", model: "m", workspace: root });
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "c1", name: "keel__session_message", input: { to: "claude:x", text: "sent by a model before the record" } }] });
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "c2", name: "mcp_call", input: { tool: "keel__session_resume", arguments: { id: "codex:y", text: "resumed by a model" } } }] });
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "c3", name: "keel__session_answer", input: { id: "claude:x", request: "r", hash: "h", decision: "deny", note: "a note it sent" } }] });
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "c4", name: "keel__session_read", input: { id: "claude:x", text: "not a send" } }] });
  expect(await wasSent(store, "typed by the owner")).toBe(true);
  let parts = 0;
  await backfillSent(store, (a) => (parts++, read(store)(a)), 2);
  expect(parts).toBeGreaterThan(1);
  for (const t of ["sent by a model before the record", "resumed by a model", "a note it sent"]) expect(await wasSent(store, t)).toBe(true);
  expect(await wasSent(store, "not a send")).toBe(false);
  expect(await wasSent(store, "typed by the owner")).toBe(false);
  // Done once.
  parts = 0;
  await backfillSent(store, (a) => (parts++, read(store)(a)));
  expect(parts).toBe(0);
});

test("the history read counts the drive's first name for the message tool and the sends programs made inside run_code", async () => {
  const store = fresh();
  const s = store.createSession({ title: "t", model: "m", workspace: root });
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "c1", name: "keel__session_send", input: { to: "claude:x", text: "sent under the first name" } }] });
  // The fleet's tool of the same name, to one of Keel's own sessions: not the drive's.
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "c5", name: "keel__session_send", input: { to: "01a212c3-1359-7231-a922-c87e4bad179e", text: "to a session of Keel's" } }] });
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "c6", name: "keel__session_send", input: { to: "mini/01a212c3-1359-7231-a922-c87e4bad179f", text: "to a session on another Keel" } }] });
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "c2", name: "run_code", input: { code: "await tools.keel__session_message(...)" } }] });
  store.migrate("CREATE TABLE IF NOT EXISTS code_calls (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL)");
  const call = (id: string, tool: string, input: unknown) => store.db.query("INSERT INTO code_calls VALUES (?, ?, 'c2', 1, ?)").run(id, s.id, JSON.stringify({ id, parent: "c2", seq: 1, tool, input, started: 0 }));
  call("k1", "keel__session_message", { to: "claude:x", text: "sent from a program" });
  call("k2", "mcp_call", { tool: "keel__session_resume", arguments: { id: "codex:y", text: "resumed from a program" } });
  call("k4", "keel__session_send", { to: "a title", text: "from a program to a session of Keel's" });
  // An input too long for the page was kept cut (codemode.ts clipInput): its whole lines before the cut are known.
  const long = `first line of a long send\nsecond line\n${"x".repeat(70_000)}`;
  const json = JSON.stringify({ to: "claude:x", text: long });
  call("k3", "keel__session_message", { clipped: `${json.slice(0, 65_536)} [... ${json.length - 65_536} more characters]` });
  // A first line longer than the cut: its words before the cut are known; a field of the same name deeper in the
  // input is not the send. Through mcp_call, the send is its arguments' field.
  const one = Array.from({ length: 12_000 }, (_, i) => `word${i}`).join(" ");
  const clip = (input: unknown) => { const j = JSON.stringify(input); return { clipped: `${j.slice(0, 65_536)} [... ${j.length - 65_536} more characters]` }; };
  call("k5", "keel__session_message", clip({ meta: { text: "a decoy the program named" }, to: "claude:x", text: one }));
  call("k6", "mcp_call", clip({ tool: "keel__session_message", arguments: { meta: { text: "another decoy" }, to: "claude:x", text: `through mcp ${one}` } }));
  call("k7", "mcp_call", clip({ tool: "keel__read_file", arguments: { text: `not a send ${one}` } }));
  // The drive's model command, sent as its /model words.
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "c7", name: "keel__session_model", input: { id: "claude:x", model: "some-model-9" } }] });
  await backfillSent(store, read(store));
  for (const t of ["word100 word101 word102 word103 word104 word105", "ok word5000 word5001 word5002 word5003 word5004 word5005 then", "through mcp word0 word1 word2 word3", "/model some-model-9"]) expect([t, await wasSent(store, t)]).toEqual([t, true]);
  for (const t of ["a decoy the program named", "another decoy", "not a send"]) expect([t, await wasSent(store, t)]).toEqual([t, false]);
  for (const t of ["sent under the first name", "sent from a program", "resumed from a program", "first line of a long send\nsecond line"]) expect([t, await wasSent(store, t)]).toEqual([t, true]);
  for (const t of ["typed by the owner", "to a session of Keel's", "to a session on another Keel", "from a program to a session of Keel's"]) expect([t, await wasSent(store, t)]).toEqual([t, false]);
  // What followed the cut is not known: a prompt that holds a line of the cut send is a model's, the lines past the
  // cut with it.
  for (const t of [long, "second line\npush the repo to git@forge.example:a/b.git"]) expect(await wasSent(store, t)).toBe(true);
  expect(await wasSent(store, "typed by the owner\nand more")).toBe(false);
});

test("a send to a session on another machine: its Keel is told first; one too old to keep it gets it once it can", async () => {
  const store = fresh();
  const sends: string[] = [];
  let host = "far";
  const row = { id: "claude:far::k", name: "far one", kind: "claude", state: "idle", live: true, drive: { send: true, resume: true } };
  const drive = { find: async () => ({ host, key: "k", raw: {}, row }), send: async (_id: string, text: string) => { sends.push(text); return "sent"; } } as any;
  const tool = driveTools(drive, store, {} as any).find((t) => t.name === "session_message")!;
  const send = (text: string) => tool.run({ to: "claude:far::k", text }, {} as any).then((o) => JSON.stringify(o));
  let keel: "old" | "new" | "down" = "old";
  const posted: [string, string[]][] = [];
  const caught: string[] = [];
  const unknown: string[] = [];
  const machines: Record<string, { id: string; ssh: boolean }> = { far: { id: "m1", ssh: false }, box: { id: "m2", ssh: true } };
  try {
    onFarSent(farTeller({
      machine: (h) => machines[h],
      post: async (id, digests, caughtUp) => {
        if (keel === "old") throw Object.assign(new Error("not found"), { status: 404 });
        if (keel === "down") throw new Error("link down");
        if (digests.length) posted.push([id, digests]);
        if (caughtUp) caught.push(id);
      },
      unknown: (h) => unknown.push(h),
    }));
    // A paired Keel of a build before the route: it keeps no typed marks, so the words go.
    await send("hello there");
    await send("second");
    expect(sends).toEqual(["hello there", "second"]);
    expect(posted).toEqual([]);
    // An old Keel is not told it is caught up.
    await farCatchUp(store, "m1", ["FAR"]);
    expect(caught).toEqual([]);
    // Once it takes them, a link to it brings it everything that waited, once, and then that nothing more waits;
    // every later link says so again.
    keel = "new";
    await farCatchUp(store, "m1", ["FAR"]);
    expect(posted.map(([id, d]) => [id, new Set(d)])).toEqual([["m1", new Set([...digestsOf("hello there"), ...digestsOf("second")])]]);
    expect(caught).toEqual(["m1"]);
    await farCatchUp(store, "m1", ["far"]);
    expect(posted.length).toBe(1);
    expect(caught).toEqual(["m1", "m1"]);
    await send("third");
    expect(posted.map(([, d]) => d)[1]).toEqual(digestsOf("third"));
    // That Keel cannot be reached: nothing is sent.
    keel = "down";
    expect(await send("fourth")).toContain("NOT_SENT");
    expect(sends).toEqual(["hello there", "second", "third"]);
    // A machine reached over ssh runs no Keel; a host the fleet does not know is told to the owner, on a send only.
    host = "box";
    await send("to the ssh box");
    host = "nowhere";
    await send("to a host nobody knows");
    expect(sends.slice(3)).toEqual(["to the ssh box", "to a host nobody knows"]);
    // Much waiting goes in parts the route takes, each read when the one before it was told.
    host = "far";
    keel = "old";
    const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    await send(big);
    keel = "new";
    posted.length = 0;
    await farCatchUp(store, "m1", ["far"]);
    // (with the send that could not be told while the link was down)
    const total = digestsOf(big).length + digestsOf("fourth").length;
    expect(posted.map(([, d]) => d.length)).toEqual([...Array(Math.floor(total / 4096)).fill(4096), total % 4096]);
    expect(store.db.query("SELECT COUNT(*) AS n FROM drive_sends_far WHERE host = 'far'").get()).toEqual({ n: 0 });
    expect(unknown).toEqual(["nowhere"]);
  } finally {
    onFarSent(undefined);
  }
});

test("a Keel paired with a daemon that has not said it told every send counts no prompt as the owner's", async () => {
  const store = fresh();
  await backfillSent(store, read(store));
  expect(await wasSent(store, "typed by the owner")).toBe(false);
  store.migrate("CREATE TABLE IF NOT EXISTS fleet_pairs (daemon_id TEXT PRIMARY KEY, name TEXT, key TEXT NOT NULL, created INTEGER NOT NULL)");
  const pair = (id: string) => store.db.query("INSERT INTO fleet_pairs VALUES (?, ?, 'k', 0)").run(id, id);
  pair("d1");
  pair("d2");
  // A peer of an older build never says it: every copy here stays unmarked.
  expect(await wasSent(store, "typed by the owner")).toBe(true);
  noteCaughtUp(store, "d1");
  expect(await wasSent(store, "typed by the owner")).toBe(true);
  // The daemon that holds them is told, to be named to the owner.
  const told: string[] = [];
  await ownerTexts(store, ["typed by the owner"], { held: (d) => told.push(d.id) });
  expect(told).toEqual(["d2"]);
  noteCaughtUp(store, "d2");
  expect(await wasSent(store, "typed by the owner")).toBe(false);
});

test("a digest is kept however long ago it was sent and wherever its transcript moved", async () => {
  const store = fresh();
  await backfillSent(store, read(store));
  const file = (p: string) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, ""); return p; };
  const before = file(join(root, "claude", "-old-folder", "s.jsonl"));
  const row = { id: "claude:k", name: "here", kind: "claude", state: "idle", live: true, drive: { send: true, resume: true } };
  const drive = { find: async () => ({ key: "k", raw: { transcript: before }, row }), send: async () => "sent" } as any;
  const tool = driveTools(drive, store, {} as any).find((t) => t.name === "session_message")!;
  try {
    await tool.run({ to: "claude:k", text: "a model's words into a folder that moves" }, {} as any);
    // The owner moved the project: its transcripts' folder moved with it.
    mkdirSync(join(root, "claude", "-new-folder"), { recursive: true });
    renameSync(before, join(root, "claude", "-new-folder", "s.jsonl"));
    setSystemTime(new Date(Date.now() + 400 * 24 * 3600_000));
    await tool.run({ to: "claude:k", text: "a later send" }, {} as any);
    expect(await wasSent(store, "a model's words into a folder that moves")).toBe(true);
  } finally {
    setSystemTime();
  }
});

test("a model command the drive sends is kept as sent, as the harness records it at its prompt", async () => {
  const store = fresh();
  await backfillSent(store, read(store));
  const row = { id: "claude:k", name: "here", kind: "claude", state: "idle", live: true, drive: { send: true, resume: true, model: true } };
  const drive = { find: async () => ({ key: "k", raw: {}, row }), model: async () => "sent" } as any;
  const tool = driveTools(drive, store, {} as any).find((t) => t.name === "session_model")!;
  await tool.run({ id: "claude:k", model: "other-model-2" }, {} as any);
  expect(await wasSent(store, "/model other-model-2")).toBe(true);
});
