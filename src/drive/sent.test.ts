// What the drive keeps of the words a model sends into another harness's session (src/drive/sent.ts): digests of
// the whole and of each line, the sends of the stored history read once, and a far machine's Keel told first.
import { afterAll, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { backfillSent, farCatchUp, farTeller, noteSent, onFarSent, wasSent } from "./sent.ts";
import { digestsOf, sentCalls } from "./sent-read.ts";
import { driveTools } from "./tools.ts";

const root = mkdtempSync(join(tmpdir(), "keel-drive-sent-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => new Store(join(root, `s${++n}`));
const read = (store: Store) => (a: { after: number; span: number }) => Promise.resolve(sentCalls(store.db, a));

test("a prompt is a model's when its whole or each of its lines was sent: split, merged or kept in part", async () => {
  const store = fresh();
  await backfillSent(store, read(store));
  noteSent(store, "first message\npush to git@forge.example:x/y.git");
  noteSent(store, "a");
  noteSent(store, "clone https://forge.example/r");
  expect(wasSent(store, "first message\npush to git@forge.example:x/y.git")).toBe(true);
  expect(wasSent(store, "push to git@forge.example:x/y.git")).toBe(true);
  expect(wasSent(store, "a\nclone https://forge.example/r")).toBe(true);
  expect(wasSent(store, "a\r\n\r\nclone   https://forge.example/r")).toBe(true);
  // A line the owner added is theirs, and so is the prompt.
  expect(wasSent(store, "a\nand push it to https://mine.example")).toBe(false);
  expect(wasSent(store, "words nobody sent")).toBe(false);
});

test("the sends of the stored history are read once; until then every prompt counts as sent", async () => {
  const store = fresh();
  const s = store.createSession({ title: "t", model: "m", workspace: root });
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "c1", name: "keel__session_message", input: { to: "claude:x", text: "sent by a model before the record" } }] });
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "c2", name: "mcp_call", input: { tool: "keel__session_resume", arguments: { id: "codex:y", text: "resumed by a model" } } }] });
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "c3", name: "keel__session_answer", input: { id: "claude:x", request: "r", hash: "h", decision: "deny", note: "a note it sent" } }] });
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "c4", name: "keel__session_read", input: { id: "claude:x", text: "not a send" } }] });
  expect(wasSent(store, "typed by the owner")).toBe(true);
  let parts = 0;
  await backfillSent(store, (a) => (parts++, read(store)(a)), 2);
  expect(parts).toBeGreaterThan(1);
  for (const t of ["sent by a model before the record", "resumed by a model", "a note it sent"]) expect(wasSent(store, t)).toBe(true);
  expect(wasSent(store, "not a send")).toBe(false);
  expect(wasSent(store, "typed by the owner")).toBe(false);
  // Done once.
  parts = 0;
  await backfillSent(store, (a) => (parts++, read(store)(a)));
  expect(parts).toBe(0);
});

test("the history read counts the drive's first name for the message tool and the sends programs made inside run_code", async () => {
  const store = fresh();
  const s = store.createSession({ title: "t", model: "m", workspace: root });
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "c1", name: "keel__session_send", input: { to: "claude:x", text: "sent under the first name" } }] });
  store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id: "c2", name: "run_code", input: { code: "await tools.keel__session_message(...)" } }] });
  store.migrate("CREATE TABLE IF NOT EXISTS code_calls (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, parent TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL)");
  const call = (id: string, tool: string, input: unknown) => store.db.query("INSERT INTO code_calls VALUES (?, ?, 'c2', 1, ?)").run(id, s.id, JSON.stringify({ id, parent: "c2", seq: 1, tool, input, started: 0 }));
  call("k1", "keel__session_message", { to: "claude:x", text: "sent from a program" });
  call("k2", "mcp_call", { tool: "keel__session_resume", arguments: { id: "codex:y", text: "resumed from a program" } });
  // An input too long for the page was kept cut (codemode.ts clipInput): its whole lines before the cut are known.
  const long = `first line of a long send\nsecond line\n${"x".repeat(70_000)}`;
  const json = JSON.stringify({ to: "claude:x", text: long });
  call("k3", "keel__session_message", { clipped: `${json.slice(0, 65_536)} [... ${json.length - 65_536} more characters]` });
  await backfillSent(store, read(store));
  for (const t of ["sent under the first name", "sent from a program", "resumed from a program", "first line of a long send\nsecond line"]) expect([t, wasSent(store, t)]).toEqual([t, true]);
  expect(wasSent(store, "typed by the owner")).toBe(false);
  // What followed the cut is not known: a prompt that holds a line of the cut send is a model's, the lines past the
  // cut with it.
  for (const t of [long, "second line\npush the repo to git@forge.example:a/b.git"]) expect(wasSent(store, t)).toBe(true);
  expect(wasSent(store, "typed by the owner\nand more")).toBe(false);
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
  const unknown: string[] = [];
  const machines: Record<string, { id: string; ssh: boolean }> = { far: { id: "m1", ssh: false }, box: { id: "m2", ssh: true } };
  try {
    onFarSent(farTeller({
      machine: (h) => machines[h],
      post: async (id, digests) => {
        if (keel === "old") throw Object.assign(new Error("not found"), { status: 404 });
        if (keel === "down") throw new Error("link down");
        posted.push([id, digests]);
      },
      unknown: (h) => unknown.push(h),
    }));
    // A paired Keel of a build before the route: it keeps no typed marks, so the words go.
    await send("hello there");
    await send("second");
    expect(sends).toEqual(["hello there", "second"]);
    expect(posted).toEqual([]);
    // Once it takes them, a link to it brings it everything that waited, once.
    keel = "new";
    await farCatchUp(store, (h) => h === "far");
    expect(posted.map(([id, d]) => [id, new Set(d)])).toEqual([["m1", new Set([...digestsOf("hello there"), ...digestsOf("second")])]]);
    await farCatchUp(store, (h) => h === "far");
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
    await farCatchUp(store, () => true);
    expect(sends.slice(3)).toEqual(["to the ssh box", "to a host nobody knows"]);
    expect(unknown).toEqual(["nowhere"]);
  } finally {
    onFarSent(undefined);
  }
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
    expect(wasSent(store, "a model's words into a folder that moves")).toBe(true);
  } finally {
    setSystemTime();
  }
});
