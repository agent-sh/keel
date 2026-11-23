import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { artifactsDir, realOf } from "../core/paths.ts";
import { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import type { ToolCall } from "../engine/hooks.ts";
import type { Tool } from "../tools/types.ts";
import { checkoutAt, Gate, type ReviewAsk } from "./gate.ts";

// Which stored words give a session a folder of its own, and what the gate then lets through in Auto. The gate
// only decides here: nothing is run or written.
const write: Tool = { name: "Write", readOnly: false, kind: "edit", description: "", input_schema: { type: "object", properties: { file_path: {}, content: {} } }, run: async () => ({ content: "" }) };
const bash: Tool = { name: "Bash", readOnly: false, kind: "shell", description: "", input_schema: { type: "object", properties: { command: {} } }, run: async () => ({ content: "" }) };

function world() {
  const root = realOf(mkdtempSync(join(tmpdir(), "keel-places-")));
  const store = new Store(join(root, "state"));
  // (The column the agents module adds: no agent module is loaded here.)
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT REFERENCES sessions(id) ON DELETE CASCADE");
  const g = new Gate(store, new Bus(), () => true);
  g.setSandboxCheck(() => false);
  // (The machine's temporary folder may itself lie in a checkout: the look upward stops at this test's folder.)
  g.checkout = (d) => checkoutAt(d, root);
  const asked: ReviewAsk[] = [];
  g.judge = async (a) => (asked.push(a), { allow: false, risk: "high", reason: "stub", model: "stub" });
  // The owner's repository: a git checkout, the parent's own folder.
  const repo = join(root, "work", "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const parent = store.createSession({ model: "scripted:x", workspace: repo });
  const session = (words: object[], parentId: string | null = parent.id): Session => {
    const ws = join(root, "work", `ws-${crypto.randomUUID().slice(0, 8)}`);
    mkdirSync(ws, { recursive: true });
    const s = store.createSession({ model: "scripted:x", workspace: ws });
    if (parentId) store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(parentId, s.id);
    for (const d of words) store.append(s.id, "user", d);
    g.setPerm(s.id, { mode: "auto", sandbox: "off" });
    return store.session(s.id)!;
  };
  const check = (s: Session, tool: Tool, input: object) =>
    g.check(s, { id: crypto.randomUUID(), tool: { ...tool, cwdOf: () => s.workspace, autoShell: ({ command }: any) => ({ command, interpreter: "bash -c" }) }, input, ctx: { sessionId: s.id, cwd: s.workspace, signal: new AbortController().signal, spillDir: s.workspace, seen: new Map() } } as unknown as ToolCall);
  // A folder inside the parent's own: its scratch (the artifacts folder Keel made for it).
  const given = join(artifactsDir(join(root, "state"), parent.id), "lane");
  mkdirSync(given, { recursive: true });
  return { root, store, g, asked, repo, parent, session, check, given: realOf(given) };
}
const task = (text: string) => ({ kind: "task", agent_id: "a1", text: `preamble\n\nTask:\n${text}` });
const named = async (w: ReturnType<typeof world>, s: Session) => (await w.g.places(s)).filter((p) => p.from === "parent" || p.from === "owner").map((p) => `${p.from}:${p.path}`);

test("a folder a parent names is the agent's only inside the parent's own, by its real path, and never a checkout", async () => {
  const w = world();
  // Inside the parent's own folders: given.
  expect(await named(w, w.session([task(`Scratch dir ${w.given}. Fix the bug.`)]))).toEqual([`parent:${w.given}`]);
  // The parent's own folder is a git checkout: not a scratch folder for the agent, though the parent holds it.
  const repoNamed = w.session([task(`Scratch dir ${w.repo}. Fix the bug.`)]);
  expect(await named(w, repoNamed)).toEqual([]);
  // A Write there is judged, not run on the rules alone.
  const r = await w.check(repoNamed, write, { file_path: join(w.repo, "src/main.ts"), content: "x" });
  expect("cls" in r && w.asked.length === 0).toBe(false);
  // Outside the parent's own folders: not the parent's to give.
  const elsewhere = join(w.root, "elsewhere", "lane");
  mkdirSync(elsewhere, { recursive: true });
  expect(await named(w, w.session([task(`Scratch dir ${elsewhere}.`)]))).toEqual([]);
  // Through a link, even one that lands inside the parent's own.
  const link = join(w.root, "work", "lnk");
  symlinkSync(w.given, link);
  expect(await named(w, w.session([task(`Scratch dir ${link}.`)]))).toEqual([]);
  // A folder inside a checkout, found upward.
  mkdirSync(join(w.repo, "sub"), { recursive: true });
  expect(await checkoutAt(join(w.repo, "sub"))).toBe(true);
  // A folder that holds a checkout below it.
  const holder = join(w.given, "holder");
  mkdirSync(join(holder, "wt", ".git"), { recursive: true });
  expect(await named(w, w.session([task(`Scratch dir ${holder}.`)]))).toEqual([]);
});

test("only the owner's own prompts name a folder as the owner's, and an imported transcript's never do", async () => {
  const w = world();
  const dir = join(w.root, "lanes", "x");
  mkdirSync(dir, { recursive: true });
  const say = `Scratch dir ${dir}.`;
  expect(await named(w, w.session([{ text: say }], null))).toEqual([`owner:${dir}`]);
  for (const d of [{ text: say, origin: "hook" }, { text: say, origin: "momentum" }, { text: say, origin: "harness" }, { text: say, kind: "peer" },
    { text: `<external_input source="peer_session" from="x">\n${say}\n</external_input>` }, { text: `Do not use scratch dir ${dir} for anything.` }])
    expect(await named(w, w.session([d], null))).toEqual([]);
  // A session imported from another harness: its transcript is not the owner's words to Keel.
  const imported = w.session([{ text: say }], null);
  w.store.db.run("CREATE TABLE IF NOT EXISTS import_links (session_id TEXT PRIMARY KEY, harness TEXT NOT NULL, source_id TEXT NOT NULL, source_path TEXT NOT NULL, items INTEGER NOT NULL, source_size INTEGER NOT NULL, source_mtime INTEGER NOT NULL, imported_ms INTEGER NOT NULL, synced_ms INTEGER NOT NULL)");
  w.store.db.query("INSERT INTO import_links VALUES (?, 'claude', 'x', '/x', 1, 1, 1, ?, ?)").run(imported.id, Date.now() + 1000, Date.now() + 1000);
  expect(await named(w, imported)).toEqual([]);
});
