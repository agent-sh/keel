// A bundle asked from a span of a branch the session has left since: the
// span, its turn and that branch's transcript, never the present branch's.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import { allHooks } from "../engine/hooks.ts";
import { buildBundle } from "./bundle.ts";
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

    // The span is pruned: the bundle says so and shows no other span as the failing one.
    store.db.run("DELETE FROM spans WHERE span_id = ?", [original.span]);
    const pruned = bundle({ turn_event: original.turn, span_id: original.span });
    expect(pruned).toContain(`\`${original.span}\`, is no longer kept`);
    expect(pruned).not.toContain("## The failing span");
    expect(pruned).toContain("MARK-ORIGINAL");
    expect(pruned).not.toContain("MARK-SIBLING");
    // The error row happened again an hour later, elsewhere: the bundle stays at the turn's end, not there.
    const end = store.events(s.id).find((x) => x.kind === "turn_end")!;
    const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
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
