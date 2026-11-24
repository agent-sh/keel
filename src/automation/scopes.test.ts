// A command's job scope outlives the daemon that started it: the next daemon takes it back by its record,
// lists it, and stops it once its session has ended and it idled, counting the idle time across restarts.
// Never a scope its record only names: another state folder's, a copy's, one with a process someone put
// in it. Each daemon is a process of its own (scopes-run.ts). Needs systemd user scopes (the user manager
// reachable over its bus, cgroup v2): skipped by name without them.
import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobScope } from "../tools/jobs.ts";
import { BUILD_IDLE_MS, SCOPE_IDLE_MS } from "./leftover-rules.ts";

const scoped = jobScope();
const RUN = join(import.meta.dir, "scopes-run.ts");
const needs = scoped.slice ? "" : ` (needs systemd user scopes: ${scoped.why})`;

// The live processes whose command line starts with these words (only this test's commands carry its tag).
const ours = (words: string) => readdirSync("/proc").filter((n) => /^\d+$/.test(n)).filter((n) => {
  try {
    const st = readFileSync(`/proc/${n}/stat`, "utf8");
    return st.slice(st.lastIndexOf(") ") + 2)[0] !== "Z" && readFileSync(`/proc/${n}/cmdline`, "utf8").replaceAll("\0", " ").includes(words);
  } catch { return false; }
}).map(Number);

const firsts: { kill(): void }[] = [];
const tags: string[] = [];
afterEach(() => {
  for (const a of firsts.splice(0)) a.kill();
  for (const t of tags.splice(0)) for (const pid of ours(t)) try { process.kill(pid, "SIGKILL"); } catch {}
});

// The first daemon: its command leaves a process in its scope, and the daemon is killed.
async function first(root: string, mode: "gone" | "archived" | "build" | "old") {
  const tag = String(1e9 + Math.floor(Math.random() * 8e9));
  tags.push(tag);
  const a = Bun.spawn([process.execPath, RUN, "a", root, tag, mode], { stdout: "pipe", stderr: "inherit", env: process.env });
  firsts.push(a);
  const reader = a.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) { const r = await reader.read(); if (r.done) break; text += new TextDecoder().decode(r.value); }
  const ready = JSON.parse(text.split("\n")[0]!) as { job: string; session: string; parent: string; contain: string; cgroup: string; record: string };
  expect(ready.contain).toBe("cgroup");
  a.kill("SIGKILL");
  await a.exited;
  expect(ours(tag).length).toBe(1);
  return { ...ready, tag };
}
// A later daemon over `root`, as a process of its own.
function later(root: string, ...args: (string | number)[]) {
  const b = Bun.spawnSync([process.execPath, RUN, args.length <= 2 ? "b" : "c", root, ...args.map(String)], { stdout: "pipe", stderr: "inherit", env: process.env });
  return JSON.parse(b.stdout.toString().trim().split("\n").at(-1)!);
}
const fresh = () => mkdtempSync(join(tmpdir(), "keel-scopes-"));

test.skipIf(!scoped.slice)(`a scope left by a killed daemon is taken back, counted idle across restarts, stopped and told once to the agent's parent${needs}`, async () => {
  const root = fresh();
  const a = await first(root, "gone");
  const t0 = Date.now();
  // Taken back although 210 newer commands ran after it, and listed with what it holds.
  const one = later(root, t0);
  expect(one.taken).toContain(a.job);
  expect(one.views[0].memory).toBeGreaterThan(0);
  expect(one.views[0].fate).toEqual({ act: "keep", why: "its session is gone; it is stopped once idle for 10 min" });
  // Another restart, an idle bound later: the count went on from the first daemon's.
  const two = later(root, t0 + SCOPE_IDLE_MS + 1000);
  expect(two.views[0].fate.act).toBe("stop");
  expect(ours(a.tag)).toEqual([]);
  // Its session is gone: the parent is told, once.
  expect(two.lines).toHaveLength(1);
  expect(two.lines[0]).toStartWith(`${a.parent}: Of an agent's session that is gone: Stopped what \``);
}, 60_000);

test.skipIf(!scoped.slice)(`another state folder's scope is never taken, by a record that names it or by a copy of the folder${needs}`, async () => {
  const b = await first(fresh(), "archived");
  const record = JSON.parse(readFileSync(b.record, "utf8"));
  // A: a record of its own that names B's job, its start and its scope, with a process that has ended.
  const a = fresh();
  const forged = join(a, "state", "spill", "forged-session", "jobs");
  cpSync(b.record.replace(/\.json$/, ".log"), join(forged, `${b.job}.log`));
  writeFileSync(join(forged, `${b.job}.json`), JSON.stringify({ ...record, sessionId: "forged-session", pid: 999_999, reported: true, ended: Date.now(), exit_code: 0 }));
  // D: the same as an older build's record, which names no state folder.
  const d = fresh();
  const old = join(d, "state", "spill", "forged-session", "jobs");
  cpSync(b.record.replace(/\.json$/, ".log"), join(old, `${b.job}.log`));
  const { state_id: _, ...legacy } = record;
  writeFileSync(join(old, `${b.job}.json`), JSON.stringify({ ...legacy, sessionId: "forged-session", pid: 999_999, reported: true, ended: Date.now(), exit_code: 0 }));
  // C: a copy of B's state folder.
  const c = fresh();
  cpSync(join(b.record, "../../../../.."), c, { recursive: true });
  const t0 = Date.now();
  expect(record.state_id).toBeString();
  for (const root of [a, d, c]) {
    later(root, t0);
    const out = later(root, t0 + SCOPE_IDLE_MS + 1000);
    expect(out.views).toEqual([]);
    expect(out.held.others.scopes).toBeGreaterThanOrEqual(1);
    expect(out.lines).toEqual([]);
    // Listed for the owner with what it holds (the page's list), never signalled.
    const mine = out.foreign.find((f: any) => f.cgroup === b.cgroup);
    expect(mine).toMatchObject({ unit: b.cgroup.split("/").at(-1), tasks: 1, commands: [`sleep 900.${b.tag}`] });
    expect(mine.memory_bytes).toBeGreaterThanOrEqual(0);
  }
  expect(ours(b.tag).length).toBe(1);
}, 60_000);

test.skipIf(!scoped.slice)(`a scope refused is said once for its record across starts, listed as foreign, and stopped only by the owner's act${needs}`, async () => {
  const b = await first(fresh(), "archived");
  const record = JSON.parse(readFileSync(b.record, "utf8"));
  // A: a record of its own naming B's job, its start and its scope: the scope is the one of another daemon's.
  const a = fresh();
  const forged = join(a, "state", "spill", "forged-session", "jobs");
  cpSync(b.record.replace(/\.json$/, ".log"), join(forged, `${b.job}.log`));
  writeFileSync(join(forged, `${b.job}.json`), JSON.stringify({ ...record, sessionId: "forged-session", pid: 999_999, reported: true, ended: Date.now(), exit_code: 0 }));
  const t0 = Date.now();
  // Each start is a daemon of its own over the same store: the first says it, the next ones do not.
  const starts = [later(a, t0), later(a, t0 + 1000), later(a, t0 + 2000)];
  expect(starts.map((s) => s.said.includes(b.cgroup))).toEqual([true, false, false]);
  expect(starts.every((s) => s.refused.length >= 1)).toBe(true);
  // The owner's stop of it, as listed: only that scope, and its process ends.
  expect(ours(b.tag).length).toBe(1);
  const out = later(a, t0 + 3000, b.tag);
  expect(out.stop).toEqual({ stopped: true, left: [] });
  expect(out.after).not.toContain(b.cgroup);
  expect(ours(b.tag)).toEqual([]);
}, 60_000);

test.skipIf(!scoped.slice)(`a scope with a process someone put in it is kept${needs}`, async () => {
  const root = fresh();
  const a = await first(root, "archived");
  // A shell of the owner's, moved into the scope from outside it.
  const shell = Bun.spawn(["sleep", `901.${a.tag}`], { stdio: ["ignore", "ignore", "ignore"] });
  writeFileSync(join(a.cgroup, "cgroup.procs"), String(shell.pid));
  const t0 = Date.now();
  later(root, t0);
  const out = later(root, t0 + SCOPE_IDLE_MS + 1000);
  expect(out.views[0].fate).toEqual({ act: "keep", why: `process ${shell.pid} was put in it from outside (its parent ${process.pid} is not of the command): it is kept until you stop it` });
  expect(ours(a.tag).length).toBe(2);
  shell.kill();
}, 60_000);

test.skipIf(!scoped.slice)(`a build daemon a build connected to since the pass is not stopped${needs}`, async () => {
  const root = fresh();
  const a = await first(root, "build");
  const port = Number(readFileSync(join(root, "port"), "utf8"));
  const t0 = Date.now();
  const out = later(root, t0, t0 + BUILD_IDLE_MS + 1000, port);
  expect(out.fate.act).toBe("stop-builds");
  // Decided with no client; a build connected before the stop: the daemon stays, and nothing is told.
  expect(out.withClient).toEqual({ lines: [], alive: true });
  // With the client gone it is stopped.
  expect(out.after.alive).toBe(false);
  expect(out.after.lines).toHaveLength(1);
  expect(ours(a.tag)).toEqual([]);
}, 60_000);

test.skipIf(!scoped.slice)(`an older build's record taken back with its scope is this folder's: a copy made after that takes nothing${needs}`, async () => {
  const root = fresh();
  const o = await first(root, "old");
  expect(JSON.parse(readFileSync(o.record, "utf8")).state_id).toBeUndefined();
  const t0 = Date.now();
  const one = later(root, t0);
  expect(one.taken).toContain(o.job);
  expect(one.views[0].fate).toEqual({ act: "keep", why: "its session lives" });
  expect(JSON.parse(readFileSync(o.record, "utf8")).state_taken).toBeString();
  const c = fresh();
  cpSync(join(o.record, "../../../../.."), c, { recursive: true });
  later(c, t0);
  const out = later(c, t0 + SCOPE_IDLE_MS + 1000);
  expect(out.views).toEqual([]);
  expect(out.taken).toEqual([]);
  expect(out.held.others.scopes).toBeGreaterThanOrEqual(1);
  // The folder that took it back still does.
  expect(later(root, t0 + 1000).taken).toContain(o.job);
  expect(ours(o.tag).length).toBe(1);
}, 60_000);
