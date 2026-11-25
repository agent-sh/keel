import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("only the owner's own prompts name a folder as the owner's, and of an imported transcript only those they typed in their own store", async () => {
  const w = world();
  const dir = join(w.root, "lanes", "x");
  mkdirSync(dir, { recursive: true });
  const say = `Scratch dir ${dir}.`;
  expect(await named(w, w.session([{ text: say }], null))).toEqual([`owner:${dir}`]);
  for (const d of [{ text: say, origin: "hook" }, { text: say, origin: "momentum" }, { text: say, origin: "harness" }, { text: say, kind: "peer" },
    { text: `<external_input source="peer_session" from="x">\n${say}\n</external_input>` }, { text: `Do not use scratch dir ${dir} for anything.` }])
    expect(await named(w, w.session([d], null))).toEqual([]);
  // A session imported from another harness. Its transcript is that harness's, not the owner's words to Keel, but for
  // the prompts the owner typed in a session of their own store on this machine: the importer marks those `typed`
  // (src/integrations/import/service.ts, from each format's own record shape) and they are the owner's words, as the
  // same words typed here are. This case pinned the older rule (no imported prompt ever counts), which held a folder
  // or a repository the owner had typed in their own Claude Code session as if a page had named it.
  w.store.db.run("CREATE TABLE IF NOT EXISTS import_links (session_id TEXT PRIMARY KEY, harness TEXT NOT NULL, source_id TEXT NOT NULL, source_path TEXT NOT NULL, items INTEGER NOT NULL, source_size INTEGER NOT NULL, source_mtime INTEGER NOT NULL, imported_ms INTEGER NOT NULL, synced_ms INTEGER NOT NULL)");
  const imported = (d: object, harness = "claude", path = "/x") => {
    const s = w.session([d], null);
    w.store.db.query("INSERT INTO import_links VALUES (?, ?, 'x', ?, 1, 1, 1, ?, ?)").run(s.id, harness, path, Date.now() + 1000, Date.now() + 1000);
    return s;
  };
  expect(await named(w, imported({ text: say, typed: true }))).toEqual([`owner:${dir}`]);
  // A prompt the importer did not mark (a hand-back, a notice, a program's), a marked one that also says what else
  // wrote it, and a mark in a copy from another machine or of a Keel session: none is the owner's.
  for (const [d, h, p] of [[{ text: say }, "claude", "/x"], [{ text: say, typed: true, kind: "peer" }, "claude", "/x"], [{ text: say, typed: true, origin: "hook" }, "claude", "/x"],
    [{ text: say, typed: true }, "claude", "m0123abcd:/x"], [{ text: say, typed: true }, "keel", "/x"]] as const)
    expect([d, h, p, await named(w, imported(d, h, p))]).toEqual([d, h, p, []]);
});

// A session's own `git worktree add`, as its stored calls show it, is a folder of its own to the judge.
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));
test("a worktree the session's own call added is its own for the judge, and nothing the call did not make is", async () => {
  const w = world();
  const s = w.session([{ text: "Fix the bug." }], null);
  const linked = (name: string) => {
    const dir = join(w.root, "scratch-wt", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".git"), `gitdir: ${w.repo}/.git/worktrees/${name}\n`);
    return dir;
  };
  // `made`: what the call does while it runs (the folder it adds is born between its two stored events).
  const call = (id: string, command: string, out: string, made?: () => void, error = false) => {
    w.store.append(s.id, "assistant", { blocks: [{ type: "tool_use", id, name: "Bash", input: { command } }] });
    made?.();
    w.store.append(s.id, "tool_result", { results: [{ type: "tool_result", tool_use_id: id, content: out, ...(error ? { is_error: true } : {}) }] });
  };
  // Folders that were there before any call below: the owner's worktrees, a failed add's, a plain folder.
  const owners = linked("owners"), failed = linked("failed"), plain = join(w.root, "scratch-wt", "plain"), given = linked("given");
  mkdirSync(plain, { recursive: true });
  const made = join(w.root, "scratch-wt", "made");
  await later(250);
  call("c1", `cd ${w.repo} && git worktree add -q -b lane-made ${made} main`, "", () => linked("made"));
  call("c2", `git -C ${w.repo} worktree add ${failed} main`, "Exit code 128\nfatal: '/x' already exists", undefined, true);
  call("c3", `git -C ${w.repo} worktree add ${plain} main`, "");
  // A path the line builds as it runs is not read.
  call("c4", `git -C ${w.repo} worktree add "$(mktemp -d)" main`, "");
  // A call that is only text in an argument.
  call("c5", `echo 'git worktree add ${given}'`, "");
  // Calls that ended well and made nothing: the folder was the owner's, there before.
  call("f1", `true || git worktree add ${owners}`, "");
  call("f2", `grep -q zzz a.txt && git worktree add ${owners}`, "");
  call("f3", `if false; then git worktree add ${owners}; fi`, "");
  call("f4", `git worktree add ${owners} 2>/dev/null || true`, "");
  call("f5", `[ -d ${owners} ] || git -C ${w.repo} worktree add ${owners}`, "");
  // The gpt family's shell: a failing exit and a command still running show nothing made.
  call("f6", `git -C ${w.repo} worktree add ${owners} main`, "Chunk ID: a1\nWall time: 0.1 seconds\nProcess exited with code 128\nOutput:\nx");
  call("f7", `git -C ${w.repo} worktree add ${owners} main`, "Chunk ID: a1\nWall time: 1.0 seconds\nProcess running with session ID 3\nOutput:\n");
  call("f8", `git -C ${w.repo} worktree add ${owners} main`, "Command did not complete within its 120s timeout and was moved to the background with ID: b1.");
  const ask = async (who: Session, dir: string) => {
    w.asked.length = 0;
    await w.check(who, bash, { command: `rm -rf ${dir}/src` });
    return w.asked[0]?.own ?? "";
  };
  const own = await ask(s, made);
  expect(own).toContain(`${made}:`);
  expect(own).toContain("`git worktree add`");
  // (It adds nothing the session may write: the places the sandbox and a parent's gifts read stay as they were.)
  expect((await w.g.places(s)).some((p) => p.path === made)).toBe(false);
  for (const dir of [owners, failed, plain, given]) expect(await ask(s, dir)).not.toContain(`${dir}:`);
  // Another session's call does not make a folder this one's.
  const other = w.session([{ text: "Other." }], null);
  expect(await ask(other, made)).not.toContain(`${made}:`);
  // A worktree made, then replaced by a folder that is no linked worktree.
  const early = join(w.root, "scratch-wt", "swapped");
  call("c6", `git -C ${w.repo} worktree add ${early} main`, "", () => linked("swapped"));
  rmSync(join(early, ".git"));
  mkdirSync(join(early, ".git"));
  w.g.forgetPlaces(s.id);
  expect(await ask(s, early)).not.toContain(`${early}:`);
  // A worktree the call made, removed and made again by someone else after the call ended, is not the call's.
  rmSync(made, { recursive: true });
  await later(250);
  linked("made");
  w.g.forgetPlaces(s.id);
  expect(await ask(s, made)).not.toContain(`${made}:`);
});
