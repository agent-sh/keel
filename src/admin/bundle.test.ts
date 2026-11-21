// A bundle asked from a span of a branch the session has left since: the
// span, its turn and that branch's transcript, never the present branch's.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { localStamp } from "../core/clock.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import { buildBundle, logFor } from "./bundle.ts";
import { Tracer } from "./trace.ts";

test("a bundle asked from a span is about that span and the branch its turn ran on; a span no longer kept is said so", () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? ".", "bundle-test-"));
  const store = new Store(dir);
  const before = allHooks().length;
  const tracer = new Tracer(store, new Bus(), () => true);
  const hooks = allHooks().at(-1)!;
  try {
    const s = store.createSession({ workspace: dir, model: "p:m" });
    store.append(s.id, "user", { text: "hello" });
    const fork = store.append(s.id, "assistant", { blocks: [{ type: "text", text: "hi" }], model: "p:m", usage: {}, stop: "end_turn" });
    // A turn whose request fails, on the branch that starts at `parent`.
    const failedTurn = (prompt: string, parent: string, why: string) => {
      store.append(s.id, "user", { text: prompt }, parent);
      const turn = store.append(s.id, "turn_start", { model: "p:m" });
      const req = { model: "m", system: "", messages: [{ role: "user", content: [{ type: "text", text: prompt }] }], tools: [], signal: new AbortController().signal } as any;
      const err = Object.assign(new Error(why), { status: 400 }) as Error & { span_id?: string };
      hooks.requestSent!(store.session(s.id)!, req);
      hooks.requestFailed!(store.session(s.id)!, req, err, false);
      store.append(s.id, "error", { message: why });
      store.append(s.id, "turn_end", { reason: "error" });
      hooks.turnEnd!(store.session(s.id)!, "error");
      return { turn: turn.id, span: err.span_id! };
    };
    const original = failedTurn("MARK-ORIGINAL do the first thing", fork.id, "fixture: the original request was refused");
    // The owner goes back and asks something else from the same point: a sibling branch, now the head.
    const sibling = failedTurn("MARK-SIBLING do another thing", fork.id, "fixture: the sibling request was refused");
    expect(original.span).not.toBe(sibling.span);
    const bundle = (o: { turn_event?: string; span_id?: string }) => buildBundle(store, tracer, { session_id: s.id, ...o, daemon: { state_dir: store.stateDir } }).markdown;
    const failing = (md: string) => md.slice(md.indexOf("## The failing span")).split("\n## ")[0]!;

    const md = bundle({ turn_event: original.turn, span_id: original.span });
    expect(md).toContain(`Asked from the span \`${original.span}\``);
    // The way to the trace is a route the reader can call, not a blanked one.
    expect(md).toContain(`- This trace as JSON: \`GET /api/debug/traces/${original.turn.replace(/-/g, "")}\``);
    expect(md).toContain(`- The full session: \`GET /api/sessions/${s.id}/events\``);
    expect(md).not.toContain("GET /[redacted]");
    expect(failing(md)).toContain(`span \`${original.span}\``);
    expect(failing(md)).toContain("the original request was refused");
    expect(md).toContain("this turn is on the branch it left");
    expect(md).toContain("MARK-ORIGINAL");
    expect(md).not.toContain("MARK-SIBLING");
    expect(md).not.toContain(sibling.span);
    // The span alone is enough: its turn and session are its own.
    expect(buildBundle(store, tracer, { span_id: original.span, daemon: { state_dir: store.stateDir } }).markdown).toContain("MARK-ORIGINAL");
    // The head's own span reads the present branch, with no word about a branch left.
    const now = bundle({ turn_event: sibling.turn, span_id: sibling.span });
    expect(now).toContain("MARK-SIBLING");
    expect(now).not.toContain("MARK-ORIGINAL");
    expect(now).not.toContain("branch it left");

    // Read by a session about itself (the timeline tool): the same failure and transcript, and nothing
    // of the daemon's other sessions or its own folders.
    const other = store.createSession({ workspace: dir, model: "p:m" });
    store.recordError({ source: "provider", message: "MARK-OTHER-SESSION a failure elsewhere", session_id: other.id });
    const owners = bundle({ turn_event: sibling.turn });
    for (const part of ["## Other open errors", "MARK-OTHER-SESSION", "## Looking further", "/replay", ", state ", "keel.db", "## Daemon log around it"]) expect(owners).toContain(part);
    const own = buildBundle(store, tracer, { session_id: s.id, turn_event: sibling.turn, daemon: { state_dir: store.stateDir }, own: true }).markdown;
    expect(failing(own)).toContain("the sibling request was refused");
    expect(own).toContain("MARK-SIBLING");
    expect(own).toContain("## Trace of the turn");
    for (const part of ["Other open errors", "MARK-OTHER-SESSION", "Looking further", "/replay", "/api/sessions/", "keel.db", ", state ", "daemon pid"]) expect(own).not.toContain(part);

    // The span is pruned: the bundle says so and shows no other span as the failing one.
    store.db.run("DELETE FROM spans WHERE span_id = ?", [original.span]);
    const pruned = bundle({ turn_event: original.turn, span_id: original.span });
    expect(pruned).toContain(`\`${original.span}\`, is no longer kept`);
    expect(pruned).not.toContain("## The failing span");
    expect(pruned).toContain("MARK-ORIGINAL");
    expect(pruned).not.toContain("MARK-SIBLING");
    // The error row happened again an hour later, elsewhere: the bundle stays at the turn's end, not there.
    const end = store.events(s.id).find((x) => x.kind === "turn_end")!;
    const iso = localStamp;
    const row = { id: "err-1", ts: end.ts + 3_600_000, first_ts: end.ts, count: 2, source: "provider", message: "fixture: the original request was refused", session_id: s.id } as any;
    const later = buildBundle(store, tracer, { error: row, session_id: s.id, turn_event: original.turn, span_id: original.span, daemon: { state_dir: store.stateDir } }).markdown;
    expect(later).toContain(`## Daemon log around it (${iso(end.ts - 120_000)} to `);
    expect(later).toContain("MARK-ORIGINAL");
    // The turn's events are gone too: no transcript rather than the present branch's.
    const gone = bundle({ turn_event: "019a0000-0000-7000-8000-00000000dead", span_id: original.span });
    expect(gone).toContain("The turn's events are no longer in the session");
    expect(gone).not.toContain("## Transcript before the failure");
    expect(gone).not.toContain("MARK-SIBLING");
  } finally {
    allHooks().splice(before);
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a session's own bundle holds its own log lines and the daemon's lines that name it, never another session's", () => {
  const me = "01a1fd57-0861-7438-b6d5-030fa4213433", other = "01a1fd57-095a-7557-af0f-38a84abd7dd6";
  const line = (text: string, session?: string) => ({ ts: 1, level: "info" as const, text, ...(session ? { session } : {}) });
  const lines = [
    line("keel listening on http://127.0.0.1:1"),
    line("[provider] 529 overloaded", me),
    line(`[turn] started agent ${me}`, other),
    line("[provider] credit balance is too low", other),
    line(`[daemon] session ${me} was archived by policy`),
  ];
  // The owner's bundle: every line of the window.
  expect(logFor(lines, me, false)).toEqual(lines);
  // Its own: the line of its turn and the daemon's line that names it; the other session's line that names it stays out.
  expect(logFor(lines, me, true).map((l) => l.text)).toEqual(["[provider] 529 overloaded", `[daemon] session ${me} was archived by policy`]);
  expect(logFor(lines, undefined, true)).toEqual([]);
});

