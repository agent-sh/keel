// Pairs checked together against real git: a pair whose head moved is not run on the old head, the
// setup gets what the landing queue gives it, a base or setup red on both sides is told to the owner
// once and holds the repository's pairs, and a host keeps none of a pair's refs.
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownEnv } from "../../test/env.ts";
import { patchSettings } from "../admin/settings.ts";
import { bindLedger, unbindLedger } from "../checks/ledger.ts";
import { Store } from "../core/store.ts";
import { Overlaps } from "../worktree/overlap-scan.ts";
import { Worktrees } from "../worktree/manager.ts";
import { Together } from "./together.ts";

setDefaultTimeout(60_000);

const root = join(process.env.HOME!, ".cache/keel-work/bun/unit", `together-${process.pid}`);
mkdirSync(root, { recursive: true });
writeFileSync(join(root, "gitconfig"), "[user]\n\tname = t\n\temail = t@t\n");
ownEnv({ GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" });
afterAll(() => { patchSettings({ together: null }); unbindLedger(); rmSync(root, { recursive: true, force: true }); });

const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
let n = 0;

// A repository whose one check is `sh check.sh`, and branches that each change one line of shared.txt
// (a file no other work touches: they are related by it, and merge clean).
// `from`: a clone of that repository's head instead (its own checks, its own files).
function setup(o: { confine?: (argv: string[], who: string | null, folder: string, shown?: string[]) => string[]; check?: string; land?: Record<string, unknown>; files?: Record<string, string>; from?: string }) {
  const dir = join(root, `case-${++n}`);
  const repo = join(dir, "repo");
  if (o.from) {
    mkdirSync(dir, { recursive: true });
    const head = g(o.from, "rev-parse", "HEAD");
    g(dir, "clone", "-q", "--no-hardlinks", "--no-checkout", o.from, "repo");
    g(repo, "checkout", "-q", "-B", "main", head);
  } else {
    mkdirSync(join(repo, ".keel"), { recursive: true });
    g(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "shared.txt"), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    writeFileSync(join(repo, "check.sh"), o.check!);
    writeFileSync(join(repo, ".gitignore"), "dep\n");
    for (const [f, t] of Object.entries(o.files ?? {})) writeFileSync(join(repo, f), t);
    writeFileSync(join(repo, ".keel/checks.json"), JSON.stringify({ checks: { typecheck: "sh check.sh" }, ...(o.land ? { land: o.land } : {}) }));
    g(repo, "add", "-A");
    g(repo, "commit", "-qm", "init");
  }
  const store = new Store(join(dir, "state"));
  if (!store.columnExists("sessions", "parent_id")) store.migrate("ALTER TABLE sessions ADD COLUMN parent_id TEXT");
  new Worktrees(store, join(dir, "wt"));
  bindLedger(store);
  const ov = new Overlaps(store, { changed: () => {}, failed: () => {} });
  const session = (title: string, parent?: string) => {
    const s = store.createSession({ model: "scripted:stand-in", workspace: repo, title });
    if (parent) store.db.run("UPDATE sessions SET parent_id = ? WHERE id = ?", [parent, s.id]);
    return s.id;
  };
  const coord = session("coord");
  const told: string[] = [], broken: string[] = [], errors: string[] = [];
  const tg = new Together(store, ov, {
    error: (e) => errors.push(String((e as Error)?.message ?? e)),
    changed: () => {},
    tell: (_to, f) => told.push(f.message),
    broken: (m) => broken.push(m),
    agentOf: () => undefined,
    confine: o.confine ?? ((a) => a),
    env: () => ({ PATH: process.env.PATH!, HOME: process.env.HOME!, GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" }),
  });
  const holders = new Map<string, string>();
  // A commit on `name` (made from main the first time) changing line `line` of shared.txt.
  let k = 0;
  const commit = (name: string, line: number) => {
    const has = (() => { try { g(repo, "rev-parse", "--verify", "-q", `refs/heads/${name}`); return true; } catch { return false; } })();
    g(repo, "checkout", "-q", ...(has ? [name] : ["-b", name, "main"]));
    writeFileSync(join(repo, "shared.txt"), readFileSync(join(repo, "shared.txt"), "utf8").replace(new RegExp(`^line ${line}( .*)?$`, "m"), `line ${line} ${name} ${++k}`));
    g(repo, "commit", "-qam", `${name} ${k}`);
    g(repo, "checkout", "-q", "main");
    if (!holders.has(name)) holders.set(name, session(name, coord));
    ov.committed(repo, name, holders.get(name)!);
    return g(repo, "rev-parse", name);
  };
  // A commit on `name` (made from main the first time) that edits `file` with `edit`.
  const commitFile = (name: string, file: string, edit: (text: string) => string) => {
    g(repo, "checkout", "-q", "-b", name, "main");
    writeFileSync(join(repo, file), edit(readFileSync(join(repo, file), "utf8")));
    g(repo, "commit", "-qam", `${name} edits ${file}`);
    g(repo, "checkout", "-q", "main");
    holders.set(name, session(name, coord));
    ov.committed(repo, name, holders.get(name)!);
    return g(repo, "rev-parse", name);
  };
  // A forecast pass, then a pass of the pairs.
  const pass = async () => { await ov.scan(repo); await tg.scan(repo); };
  const rows = () => store.db.query<{ branch1: string; branch2: string; tip1: string; tip2: string; state: string; error: string | null }, []>("SELECT branch1, branch2, tip1, tip2, state, error FROM pair_checks ORDER BY started").all();
  return { dir, repo, store, tg, commit, commitFile, pass, rows, told, broken, errors };
}

test("a pair whose head moved is dropped: from the line when a pass sees it, and by the run itself before it starts", async () => {
  expect(patchSettings({ together: { quiet_s: 0, at_once: 1, host: null } }).ok).toBe(true);
  // The check waits at a gate the test opens, so one pair runs while the rest wait in line.
  const t = setup({ check: 'until [ -e "$KEEL_LAND_REPO/../gate" ]; do sleep 0.05; done\n' });
  const x0 = t.commit("keel/x", 2), y0 = t.commit("keel/y", 12);
  await t.pass();
  const tg = t.tg as any;
  const sides = (j: { a: { branch: string; tip: string }; b: { branch: string; tip: string } }) => [j.a, j.b].map((s) => `${s.branch}@${s.tip.slice(0, 7)}`).sort().join(" ");
  expect(tg.running.size).toBe(1);
  // z comes while x and y run: its pairs wait in line.
  const z0 = t.commit("keel/z", 22);
  await t.pass();
  expect(tg.line.map(sides).sort()).toEqual([`keel/x@${x0.slice(0, 7)} keel/z@${z0.slice(0, 7)}`, `keel/y@${y0.slice(0, 7)} keel/z@${z0.slice(0, 7)}`]);
  // z moves: the pairs of its old head leave the line, its new head's take their place.
  const z1 = t.commit("keel/z", 23);
  await t.pass();
  expect(tg.line.map(sides).sort()).toEqual([`keel/x@${x0.slice(0, 7)} keel/z@${z1.slice(0, 7)}`, `keel/y@${y0.slice(0, 7)} keel/z@${z1.slice(0, 7)}`]);
  expect(tg.stats.dropped).toBe(2);
  // x moves with no pass in between: its queued pair is dropped by the run itself.
  t.commit("keel/x", 3);
  writeFileSync(join(t.dir, "gate"), "");
  await t.tg.idle(t.repo);
  expect(tg.stats.dropped).toBe(3);
  const made = t.rows().map((r) => [r.branch1, r.branch2].sort().join("+") + " " + [r.tip1, r.tip2].map((x) => x.slice(0, 7)).sort().join(" ")).sort();
  // Only the pair already running and y with z's new head were checked; nothing of z's old head, nothing of x's old head with z's new one.
  expect(made).toEqual([`keel/x+keel/y ${[x0, y0].map((x) => x.slice(0, 7)).sort().join(" ")}`, `keel/y+keel/z ${[y0, z1].map((x) => x.slice(0, 7)).sort().join(" ")}`]);
  expect(t.errors).toEqual([]);
});

test("the setup gets the repository as the landing queue gives it (KEEL_LAND_REPO)", async () => {
  expect(patchSettings({ together: { quiet_s: 0, at_once: 2, host: null } }).ok).toBe(true);
  // land.setup links what the repository keeps beside its tree; the check reads through the link.
  const t = setup({ check: "test -f dep/ok\n", land: { setup: 'ln -s "$KEEL_LAND_REPO/dep" dep' } });
  mkdirSync(join(t.repo, "dep"));
  writeFileSync(join(t.repo, "dep/ok"), "");
  t.commit("keel/x", 2); t.commit("keel/y", 30);
  await t.pass();
  await t.tg.idle(t.repo);
  expect(t.rows().map((r) => r.state)).toEqual(["green"]);
  expect(t.broken).toEqual([]);
});

test("red on both sides alone is a broken setup or base: told to the owner once, and the repository's pairs wait for its base or checks to change", async () => {
  expect(patchSettings({ together: { quiet_s: 0, at_once: 2, host: null } }).ok).toBe(true);
  // The documented setup's shape with nothing to link: every run fails, together and alone.
  const t = setup({ check: "test -f dep/ok\n", land: { setup: 'ln -s "$KEEL_LAND_REPO/dep" dep' } });
  t.commit("keel/x", 2); t.commit("keel/y", 30);
  await t.pass();
  await t.tg.idle(t.repo);
  expect(t.rows().map((r) => r.state)).toEqual(["broken"]);
  expect(t.broken.length).toBe(1);
  expect(t.broken[0]).toContain("typecheck fails on each branch alone");
  expect(t.broken[0]).toContain('land.setup: ln -s "$KEEL_LAND_REPO/dep" dep');
  expect(t.told).toEqual([]);
  // A head moves: the base and the checks are the same, so nothing runs.
  t.commit("keel/x", 3);
  await t.pass();
  await t.tg.idle(t.repo);
  expect(t.rows().length).toBe(1);
  // The base moves: checked again, broken again, not told again.
  writeFileSync(join(t.repo, "other.txt"), "x\n");
  g(t.repo, "add", "other.txt"); g(t.repo, "commit", "-qm", "base moves");
  await t.pass();
  await t.tg.idle(t.repo);
  expect(t.rows().map((r) => r.state)).toEqual(["broken", "broken"]);
  expect(t.broken.length).toBe(1);
});

test("a repository with no setup gets its base's installed packages in the pair's tree: a check that reads them passes", async () => {
  expect(patchSettings({ together: { quiet_s: 0, at_once: 2, host: null } }).ok).toBe(true);
  // The packages are installed in the main checkout (ignored by git) from the lockfile the base holds.
  const t = setup({ check: "test -f node_modules/dep/index.js\n", files: { "package.json": '{"dependencies":{"dep":"1"}}', "bun.lock": "lock v1\n" } });
  mkdirSync(join(t.repo, "node_modules/dep"), { recursive: true });
  writeFileSync(join(t.repo, "node_modules/dep/index.js"), "");
  writeFileSync(join(t.repo, ".gitignore"), "dep\nnode_modules\n");
  g(t.repo, "commit", "-qam", "ignore packages");
  t.commit("keel/x", 2); t.commit("keel/y", 30);
  await t.pass();
  await t.tg.idle(t.repo);
  expect(t.rows().map((r) => r.state)).toEqual(["green"]);
  expect(t.broken).toEqual([]);
});

test("a confined pair is shown the linked packages, and links them only where its sandbox reads them", async () => {
  expect(patchSettings({ together: { quiet_s: 0, at_once: 2, host: null } }).ok).toBe(true);
  const files = { "package.json": '{"dependencies":{"dep":"1"}}', "bun.lock": "lock v1\n" };
  const seen: { probe: boolean; shown: string[] }[] = [];
  let hides = false;
  const confine = (argv: string[], _w: string | null, _f: string, shown: string[] = []) => {
    const probe = argv.includes("probe");
    seen.push({ probe, shown });
    return probe && hides ? ["false"] : argv;
  };
  const t = setup({ check: "test -f node_modules/dep/index.js\n", files, confine });
  mkdirSync(join(t.repo, "node_modules/dep"), { recursive: true });
  writeFileSync(join(t.repo, "node_modules/dep/index.js"), "");
  writeFileSync(join(t.repo, ".gitignore"), "dep\nnode_modules\n");
  g(t.repo, "commit", "-qam", "ignore packages");
  t.commit("keel/x", 2); t.commit("keel/y", 30);
  await t.pass();
  await t.tg.idle(t.repo);
  expect(t.rows().map((r) => r.state)).toEqual(["green"]);
  const real = realpathSync(join(t.repo, "node_modules"));
  // The sandbox was asked whether it reads them, and the commands after the link are shown them.
  expect(seen.some((s) => s.probe)).toBe(true);
  expect(seen.filter((s) => !s.probe && s.shown.includes(real)).length).toBeGreaterThan(0);
  // A sandbox that does not read them: no link, so the check does not find the packages (the install is the cache's or a run's).
  hides = true;
  seen.length = 0;
  t.commit("keel/z", 20);
  await t.pass();
  await t.tg.idle(t.repo);
  expect(seen.some((s) => s.probe)).toBe(true);
  expect(seen.some((s) => !s.probe && s.shown.includes(real))).toBe(false);
});

test("checks that could not start for want of a package are the setup's: told with the first line, and the next pair is tried", async () => {
  expect(patchSettings({ together: { quiet_s: 0, at_once: 2, host: null } }).ok).toBe(true);
  const t = setup({ check: "echo \"error: Cannot find module 'zzz' from '/s/x.ts'\"; exit 1\n" });
  t.commit("keel/x", 2); t.commit("keel/y", 30);
  await t.pass();
  await t.tg.idle(t.repo);
  expect(t.rows().map((r) => r.state)).toEqual(["broken"]);
  expect(t.rows()[0]!.error).toBe("setup missing: error: Cannot find module 'zzz' from '/s/x.ts'");
  expect(t.broken.length).toBe(1);
  expect(t.broken[0]).toContain("Cannot find module 'zzz'");
  expect(t.broken[0]).toContain("not a red base");
  // A head moves on the same base: the repository is not held, the pair is tried (and not told again).
  t.commit("keel/x", 3);
  await t.pass();
  await t.tg.idle(t.repo);
  expect(t.rows().map((r) => r.state)).toEqual(["broken", "broken"]);
  expect(t.broken.length).toBe(1);
});

// The probe (not inside a pair run, which would run it again): the daemon's pair runs on two clean branches of a copy of this repository, with the repository's own
// checks (typecheck and unit) and no land.setup. Its packages are the main checkout's: this tree's node_modules
// (a link to them, as a worktree's is) when its lockfile is the one the base holds.
const HERE = join(import.meta.dir, "../..");
const modules = join(HERE, "node_modules");
const ready = existsSync(modules) && existsSync(join(realpathSync(modules), "../bun.lock")) && readFileSync(join(realpathSync(modules), "../bun.lock")).equals(readFileSync(join(HERE, "bun.lock")));
test.skipIf(!ready || !!process.env.KEEL_PAIR)("a real pair of two clean branches of a copy of this repository passes typecheck and unit", async () => {
  expect(patchSettings({ together: { quiet_s: 0, at_once: 2, host: null } }).ok).toBe(true);
  const t = setup({ from: HERE });
  // The main checkout's packages, as the daemon's repository has them (a link to this tree's, which are shared).
  symlinkSync(realpathSync(modules), join(t.repo, "node_modules"));
  const x = t.commitFile("keel/x", "src/checks/counts.ts", (s) => `// first note\n${s}`);
  const y = t.commitFile("keel/y", "src/checks/counts.ts", (s) => `${s}\n// last note\n`);
  expect(x).not.toBe(y);
  await t.pass();
  await t.tg.idle(t.repo);
  const row = t.rows()[0];
  const why = () => { const runs = JSON.parse((t.store.db.query("SELECT runs FROM pair_checks").get() as { runs: string }).runs) as { on: string; ran: { check: string; exit: number; ms: number; log?: string }[] }[]; return runs.map((r) => `${r.on}: ${r.ran.map((x) => `${x.check} exit ${x.exit} ${x.ms} ms\n${x.log ? readFileSync(x.log, "utf8").slice(-1500) : ""}`).join("\n")}`).join("\n"); };
  expect(row?.state, row?.state === "green" ? "" : `${JSON.stringify(row)}\n${why()}`).toBe("green");
  expect(t.broken).toEqual([]);
  const ran = JSON.parse((t.store.db.query("SELECT runs FROM pair_checks").get() as { runs: string }).runs)[0].ran as { check: string; exit: number }[];
  expect(ran.map((r) => r.check).sort()).toEqual(["typecheck", "unit"]);
  expect(ran.every((r) => r.exit === 0)).toBe(true);
}, 600_000);

test("a setup that fails is broken too, told once", async () => {
  expect(patchSettings({ together: { quiet_s: 0, at_once: 2, host: null } }).ok).toBe(true);
  const t = setup({ check: "true\n", land: { setup: "exit 3" } });
  t.commit("keel/x", 2); t.commit("keel/y", 30);
  await t.pass();
  await t.tg.idle(t.repo);
  expect(t.rows().map((r) => r.state)).toEqual(["broken"]);
  expect(t.broken.length).toBe(1);
  expect(t.broken[0]).toContain("setup (land.setup) failed here: exit 3");
});

test("a host that ssh would read as an option is refused", () => {
  expect(patchSettings({ together: { host: "-v" } }).ok).toBe(false);
  expect(patchSettings({ together: { host: "-oProxyCommand" } }).ok).toBe(false);
  expect(patchSettings({ together: { host: "devbox.example" } }).ok).toBe(true);
  expect(patchSettings({ together: { host: null } }).ok).toBe(true);
});

test("on a host: the pair's refs go from its repository after the run, and a worktree a cut run left is pruned", async () => {
  // A stand-in for ssh that runs the command here, with a home of its own for the host.
  const bin = join(root, "bin"), home = join(root, "host-home");
  mkdirSync(bin, { recursive: true }); mkdirSync(home, { recursive: true });
  writeFileSync(join(bin, "ssh"), '#!/bin/bash\nwhile [ "${1:-}" = "-o" ]; do shift 2; done\nshift\ncd "$STUB_HOME" && HOME="$STUB_HOME" exec bash -c "$*"\n');
  chmodSync(join(bin, "ssh"), 0o755);
  ownEnv({ PATH: `${bin}:${process.env.PATH}`, STUB_HOME: home });
  expect(patchSettings({ together: { quiet_s: 0, at_once: 1, host: "stubhost", load_share: 4 } }).ok).toBe(true);
  const t = setup({ check: "test -f shared.txt\n" });
  t.commit("keel/x", 2); t.commit("keel/y", 30);
  await t.pass();
  await t.tg.idle(t.repo);
  expect(t.store.db.query<{ state: string; place: string }, []>("SELECT state, place FROM pair_checks").all()).toEqual([{ state: "green", place: "stubhost" }]);
  const bare = join(home, ".cache/keel-pairs", (await import("node:fs")).readdirSync(join(home, ".cache/keel-pairs")).find((f) => f.endsWith(".git"))!);
  expect(g(bare, "for-each-ref", "refs/keel-pairs/")).toBe("");
  // A worktree of the bare repository whose folder is gone (a run cut there): the next run prunes it.
  const stale = join(home, "stale-wt");
  g(bare, "worktree", "add", "-q", "--detach", stale, g(t.repo, "rev-parse", "main"));
  rmSync(stale, { recursive: true, force: true });
  expect(existsSync(join(bare, "worktrees/stale-wt"))).toBe(true);
  t.commit("keel/x", 3);
  await t.pass();
  await t.tg.idle(t.repo);
  expect(existsSync(join(bare, "worktrees/stale-wt"))).toBe(false);
  expect(g(bare, "for-each-ref", "refs/keel-pairs/")).toBe("");
  patchSettings({ together: { host: null, load_share: null } });
});
