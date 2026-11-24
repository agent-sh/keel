import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { ownEnv, tempTree } from "../../test/env.ts";
import * as gh from "./github.ts";
import { WATCH_MS, type Watch } from "./rules.ts";
import { Steward, repoOfUrl, type Io } from "./watch.ts";

const root = tempTree("keel-steward-");
// A gh that answers as `mode` (a file) says: the permission lookup is the call under test.
const bin = join(root, "gh");
writeFileSync(bin, `#!/bin/sh\nm=$(cat "${root}/mode")\ncase "$m" in\n  write) echo write ;;\n  none) echo none ;;\n  limited) echo "gh: API rate limit exceeded (HTTP 403)" >&2; exit 1 ;;\n  missing) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;\nesac\n`);
chmodSync(bin, 0o755);
ownEnv({ KEEL_GH_BIN: bin });
const mode = (m: string) => writeFileSync(join(root, "mode"), m);

test("a person's write access: only an answer is kept, a failed lookup is asked again", async () => {
  mode("limited");
  expect(await gh.writes("o/r", "pal")).toBeUndefined();
  mode("write");
  expect(await gh.writes("o/r", "pal")).toBe(true);
  mode("limited");
  expect(await gh.writes("o/r", "pal")).toBe(true); // kept: GitHub had answered
  mode("limited");
  expect(await gh.writes("o/r", "other")).toBeUndefined();
  mode("missing");
  expect(await gh.writes("o/r", "other")).toBe(false);
  mode("none");
  expect(await gh.writes("o/r", "third")).toBe(false);
});

function world() {
  const dir = join(root, `w${Math.random().toString(36).slice(2)}`);
  const tree = join(dir, "tree");
  mkdirSync(tree, { recursive: true });
  const git = (...a: string[]) => Bun.spawnSync(["git", "-C", tree, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q", "-b", "feat");
  git("commit", "-q", "--allow-empty", "-m", "x");
  const store = new Store(join(dir, "state"));
  const s = store.createSession({ model: "m", workspace: tree, title: "t" });
  const kid = store.createSession({ model: "m", workspace: tree, title: "kid" });
  try { store.db.exec("ALTER TABLE sessions ADD COLUMN parent_id TEXT"); } catch { /* already there */ }
  store.db.query("UPDATE sessions SET parent_id = ? WHERE id = ?").run(s.id, kid.id);
  const live = { running: false, pending: false };
  const io: Io = { worktree: () => ({ path: tree, branch: "feat", state: "active" }), send: async () => "sent", inbox() {}, running: () => live.running, pending: () => live.pending, error(e) { throw e; } };
  const make = () => new Steward(store, new Bus(), io);
  const watch = (o: Partial<Watch> = {}): Watch => ({ session_id: s.id, repo: "o/r", number: 3, url: "u", branch: "feat", state: "fixing", stay: false, bots: [], started: 1, updated: 1, expires: Date.now() + WATCH_MS, seen: [], told: [], tries: 1, pushes: 0, turns: 1, ignored: 0, errors: 0, fixing: { why: ["checks"], head: "h", since: 1, key: "k", seq: 5 }, ...o });
  return { store, s, kid, make, watch, live };
}

test("what a watch turn may do is read from the stored watch: a restart, an agent of the turn, and its end", () => {
  const { s, kid, make, watch } = world();
  const st = make();
  (st as any).save(watch());
  const g = st.guardOf(s.id)!;
  expect([g.branch, g.repo, g.number, g.head?.(), g.dir !== undefined]).toEqual(["feat", "o/r", 3, "feat", true]);
  // A new process over the same store (a restart): the turn that goes on is as guarded as the one that began.
  const again = make();
  expect(again.guardOf(s.id)?.branch).toBe("feat");
  // An agent the turn started is guarded, with no worktree of the watch's to push from.
  const helper = again.guardOf(kid.id)!;
  expect([helper.branch, helper.dir, helper.head]).toEqual(["feat", undefined, undefined]);
  // Turned off while the turn works: held until it ends. Ended turn, ended watch: free.
  (st as any).save(watch({ state: "ended", end: "stopped" }));
  expect(make().guardOf(s.id)).toBeUndefined(); // (the session is not running in this stand-in)
  (st as any).save(watch({ fixing: { why: ["checks"], head: "h", since: 1, key: "k", seq: 5, ended: { reason: "end_turn" } } }));
  expect(make().guardOf(s.id)).toBeUndefined();
});

test("a turn that ends before the watch's words were read is not the watch's turn", () => {
  const { s, make, watch } = world();
  const st = make();
  (st as any).save(watch({ fixing: { why: ["checks"], head: "h", since: 1, key: "k" } }));
  const ev = (seq: number, kind: string, data: Record<string, unknown>) => ({ seq, session_id: s.id, kind, data, ts: 1 }) as any;
  // The turn that was working when the words were sent ends first: the words are still waiting.
  st.onEvent(ev(10, "turn_end", { reason: "end_turn" }));
  expect(st.get(s.id)?.fixing?.ended).toBeUndefined();
  st.onEvent(ev(11, "user", { text: "[harness] PR Steward", kind: "steward" }));
  expect(st.get(s.id)?.fixing?.seq).toBe(11);
  st.onEvent(ev(12, "turn_end", { reason: "end_turn" }));
  expect(st.get(s.id)?.fixing?.ended).toEqual({ reason: "end_turn" });
});

test("the remote a push goes to is read from its address", () => {
  for (const u of ["git@github.com:O/R.git", "https://github.com/o/r", "https://user:tok@github.com/o/r.git/", "ssh://git@github.com/o/r.git"]) expect(repoOfUrl(u), u).toBe("o/r");
  expect(repoOfUrl("git@github.com:evil/r.git")).toBe("evil/r");
  expect(repoOfUrl("/srv/git/r.git")).toBe("git/r");
});

test("a watch the owner turned off while its words waited does not hold the session's later turns to its lane", () => {
  const ev = (id: string, seq: number, kind: string, data: Record<string, unknown>) => ({ seq, session_id: id, kind, data, ts: 1 }) as any;
  // The words never came (nothing queued): the first turn that ends frees the session, the owner's own turns included.
  {
    const { s, make, watch, live } = world();
    const st = make();
    (st as any).save(watch({ fixing: { why: ["checks"], head: "h", since: 1, key: "k" } }));
    live.running = true; // the owner's turn works when the watch is turned off
    st.stop(s.id);
    expect(st.guardOf(s.id)).toBeDefined();
    st.onEvent(ev(s.id, 10, "turn_end", { reason: "end_turn" }));
    expect(st.get(s.id)?.fixing).toBeUndefined();
    expect(st.guardOf(s.id)).toBeUndefined();
  }
  // The words wait in the queue: the guard stays through the turn that ends first, and ends with the words' own turn.
  {
    const { s, make, watch, live } = world();
    const st = make();
    (st as any).save(watch({ fixing: { why: ["checks"], head: "h", since: 1, key: "k" } }));
    live.running = true; live.pending = true;
    st.stop(s.id);
    st.onEvent(ev(s.id, 10, "turn_end", { reason: "end_turn" }));
    expect(st.guardOf(s.id)).toBeDefined();
    st.onEvent(ev(s.id, 11, "user", { text: "[harness] PR Steward", kind: "steward" }));
    expect(st.get(s.id)?.fixing?.seq).toBe(11);
    live.pending = false;
    st.onEvent(ev(s.id, 12, "turn_end", { reason: "end_turn" }));
    expect(st.guardOf(s.id)).toBeUndefined();
  }
});
