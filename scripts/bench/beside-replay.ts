#!/usr/bin/env bun
// Replays the shape of recorded checks beside agents through the lane rules of src/checks/beside.ts, to see what a
// cap of runs an hour and the standing of passed tests do to their count and processor time.
//
//   bun scripts/bench/beside-replay.ts SHAPE.tsv [PER_HOUR...]
//
// SHAPE.tsv: one recorded check run a line, as the check ledger has it (check_runs, by "beside"), with a last column
// saying whether its files changed since the session's last green run of the check:
//   session  started_ms  ended_ms  check  cpu_ms  verdict (first | changed | same | unknown)
// "same" for a test check: every test file it ran had passed before and nothing it reaches changed since (the
// standing rule, stillGreen). The replay takes each recorded pass of a lane (the checks of one session that started
// within a few seconds) as a change made one window before it, drives the lane with changed, dueAt, started and
// finished, and lets a run cover every change made before it started: its typecheck costs what the newest covered
// pass's did, its test check what the newest covered pass's did unless every covered pass was "same". A session's
// last pass is its turn's end (it runs at once, as afterTurn makes it). Nothing here reads Keel's state.
import { readFileSync } from "node:fs";
import { changed, dueAt, finished, fresh, gapOf, started, turnEnded, WINDOW_MS, type Lane } from "../../src/checks/beside.ts";

type Rec = { session: string; started: number; ended: number; check: string; cpu: number; verdict: string };
type Pass = { at: number; ms: number; checks: Map<string, { cpu: number; verdict: string }> };
const [file, ...caps] = Bun.argv.slice(2);
if (!file) { console.error("usage: beside-replay.ts SHAPE.tsv [PER_HOUR...]"); process.exit(2); }
const recs: Rec[] = readFileSync(file, "utf8").trim().split("\n").map((l) => {
  const [session, s, e, check, cpu, verdict] = l.split("\t");
  return { session: session!, started: +s!, ended: +e!, check: check!, cpu: +(cpu || 0), verdict: verdict! };
});
// The passes of each session: the checks that started within 5 s of the pass's first, one after another.
const bySession = new Map<string, Pass[]>();
for (const r of [...recs].sort((a, b) => a.started - b.started)) {
  const list = bySession.get(r.session) ?? bySession.set(r.session, []).get(r.session)!;
  const last = list.at(-1);
  const end = last ? last.at + last.ms : -Infinity;
  if (last && r.started - end < 5_000 && !last.checks.has(r.check)) { last.checks.set(r.check, { cpu: r.cpu, verdict: r.verdict }); last.ms = r.ended - last.at; continue; }
  list.push({ at: r.started, ms: r.ended - r.started, checks: new Map([[r.check, { cpu: r.cpu, verdict: r.verdict }]]) });
}
const TESTS = new Set(["unit"]);
function replay(perHour: number | "recorded", standing: boolean) {
  let runs = 0, cpu = 0, lag = 0, covered = 0;
  for (const passes of bySession.values()) {
    if (perHour === "recorded") {
      for (const p of passes) for (const c of p.checks.values()) { runs++; cpu += c.cpu; }
      continue;
    }
    const gap = gapOf(perHour);
    let l: Lane = fresh();
    let i = 0, now = 0;
    const changes = passes.map((p) => p.at - WINDOW_MS);
    while (i < passes.length) {
      // The next change, unless a run is due before it.
      l = changed(l, changes[i]!);
      if (i === passes.length - 1) l = turnEnded(l);
      let due = dueAt(l, WINDOW_MS, gap)!;
      while (i + 1 < passes.length && changes[i + 1]! <= due) { i++; if (i === passes.length - 1) l = turnEnded(l); due = dueAt(l, WINDOW_MS, gap)!; }
      now = Math.max(now, due);
      // The run covers every change made before it started: passes first..i.
      const first = passes.findIndex((p, k) => k <= i && !(p as any).done);
      const cover = passes.slice(first, i + 1);
      for (const p of cover) { (p as any).done = true; lag += now - (p.at - WINDOW_MS); covered++; }
      l = started(l, now);
      const names = new Set(cover.flatMap((p) => [...p.checks.keys()]));
      let ms = 0;
      for (const name of names) {
        const newest = [...cover].reverse().find((p) => p.checks.has(name))!;
        const c = newest.checks.get(name)!;
        if (standing && TESTS.has(name) && cover.every((p) => !p.checks.has(name) || p.checks.get(name)!.verdict === "same")) continue;
        runs++; cpu += c.cpu; ms += newest.ms;
      }
      now += ms;
      l = finished(l, `t${i}`);
      i++;
    }
    for (const p of passes) delete (p as any).done;
  }
  return { runs, cpu_s: Math.round(cpu / 1000), mean_lag_s: covered ? Math.round(lag / covered / 1000) : 0 };
}
const agents = bySession.size, passes = [...bySession.values()].reduce((a, p) => a + p.length, 0);
console.log(`${agents} sessions, ${passes} passes, ${recs.length} check runs`);
console.log("rule\truns\tcpu_s\tmean_lag_s");
const row = (name: string, r: ReturnType<typeof replay>) => console.log(`${name}\t${r.runs}\t${r.cpu_s}\t${r.mean_lag_s}`);
row("recorded", replay("recorded", false));
row("window only", replay(0, false));
row("standing only", replay(0, true));
for (const c of caps.length ? caps.map(Number) : [12, 10, 8, 6, 4]) row(`standing + ${c}/hour`, replay(c, true));
