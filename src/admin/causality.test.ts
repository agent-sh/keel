// Where a failure is said to have happened: the session, turn and span it
// really ran in. The engine, the tracer and the store work together here, on
// cases no page can script: a rewound branch, a side request, a tool that throws.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { ErrorTracker } from "../core/errors.ts";
import { Store } from "../core/store.ts";
import { lineage } from "../core/tree.ts";
import { allHooks } from "../engine/hooks.ts";
import { Engine } from "../engine/turn.ts";
import { toolSpanId, Tracer, traceIdOf, turnSpanId } from "./trace.ts";

const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
const refused = (text: string) => Object.assign(new Error(text), { status: 400 });

test("a failure names the session, turn and span it happened in; an unscoped repeat inherits none", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keel-causality-"));
  // A database from before the errors table had a fingerprint, a session or a span.
  mkdirSync(join(dir, "state"), { recursive: true });
  const old = new Database(join(dir, "state", "keel.db"), { create: true });
  old.exec("CREATE TABLE errors (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL, stack TEXT, context TEXT)");
  old.exec("INSERT INTO errors (id, ts, source, message) VALUES ('old-1', 5, 'server', 'fixture: kept from an older build')");
  old.close();

  const store = new Store(join(dir, "state")), bus = new Bus(), errors = new ErrorTracker(store, bus);
  const info = { id: "fixture:m", model: "fixture", name: "Fixture", family: "claude", context: 16384, output: 64, efforts: [], images: false, pdf: false, tools: true };
  // The newest block decides: prompts of failed turns before it stay in the same user message.
  const lastText = (req: any) => {
    const b = (req.messages.at(-1).content as any[]).at(-1);
    return b.type === "text" ? String(b.text) : "";
  };
  const provider = {
    wire: "anthropic_messages",
    stream: async (req: any) => {
      const text = lastText(req);
      if (text.includes("fail-side")) throw refused("fixture: the side request was refused");
      if (text.includes("fail-turn")) throw refused("fixture: the turn request was refused");
      if (text.includes("use-tool")) return { blocks: [{ type: "tool_use", id: "call-boom", name: "boom", input: {} }], usage, stop: "tool_use", model: "fixture" };
      return { blocks: [{ type: "text", text: "done" }], usage, stop: "end_turn", model: "fixture" };
    },
  };
  const boom = { name: "boom", description: "throws", input_schema: { type: "object" }, readOnly: true, run: async () => { throw new Error("fixture: the tool blew up"); } };
  const providers = { resolve: async () => ({ provider, info }), current: () => [info], models: async () => [info] };
  const engine = new Engine(store, bus, providers as any, errors, join(dir, "spill"));
  let stepFails = false;
  (engine as any).step = async () => {
    if (stepFails) throw new Error("fixture: no route to the model");
    return { provider, info, tools: [boom], system: "Fixture system", systemSplit: 0, native: false };
  };
  const registered = allHooks().length;
  const tracer = new Tracer(store, bus, (id) => engine.isRunning(id));
  // The daemon's own wiring (src/server/routes/observe.ts).
  errors.spanOf = (id) => tracer.span(id);

  try {
    // Rows of an older build stay readable.
    expect(store.errors().map((e) => [e.id, e.message, e.count, e.session_id])).toEqual([["old-1", "fixture: kept from an older build", 1, undefined]]);

    const s = store.createSession({ workspace: dir, model: info.id, title: "causality" });
    const turns = () => store.events(s.id).filter((e) => e.kind === "turn_start");
    const row = (text: string) => store.errors().find((e) => e.message.includes(text))!;
    const run = async (text: string) => { engine.send(s.id, text); await engine.idle(s.id); };

    // Two good turns, then the branch is rewound to the end of the first:
    // the newest turn_start of the session is now on a branch nobody sees.
    await run("first");
    const endOfFirst = store.session(s.id)!.head!;
    await run("second");
    const [, abandoned] = turns();
    store.updateSession(s.id, { head: endOfFirst });
    expect(lineage(store.events(s.id), store.session(s.id)!.head).some((e) => e.id === abandoned!.id)).toBe(false);

    // A side request on the rewound branch fails: its own span, in no turn.
    const asked = await engine.ask(s.id, [{ role: "user", content: [{ type: "text", text: "fail-side" }] }], new AbortController().signal).catch((e) => e);
    errors.capture("provider", asked, { session: s.id, at: "side question" });
    const side = row("side request was refused");
    expect(side.session_id).toBe(s.id);
    expect(side.turn_event).toBeUndefined();
    const sideSpan = tracer.span(side.span_id!)!;
    expect([sideSpan.kind, sideSpan.parent_id, sideSpan.attrs.turn_event, sideSpan.error_id]).toEqual(["request", null, undefined, side.id]);

    // A turn that fails before it starts (no turn_start is stored) is in no turn either.
    stepFails = true;
    await run("third");
    stepFails = false;
    const early = row("no route to the model");
    expect(turns()).toHaveLength(2);
    expect([early.session_id, early.turn_event, early.span_id]).toEqual([s.id, undefined, undefined]);

    // A turn on the rewound branch fails at its request: that turn, that request.
    await run("fail-turn");
    const failedTurn = turns().at(-1)!;
    const inTurn = row("turn request was refused");
    expect([inTurn.session_id, inTurn.turn_event]).toEqual([s.id, failedTurn.id]);
    const request = tracer.span(inTurn.span_id!)!;
    expect([request.kind, request.parent_id, request.error_id]).toEqual(["request", turnSpanId(traceIdOf(failedTurn.id)), inTurn.id]);

    // A tool that throws: the row names the call's span, which names the row.
    await run("use-tool");
    const toolTurn = turns().at(-1)!;
    const thrown = row("the tool blew up");
    expect([thrown.source, thrown.session_id, thrown.turn_event, thrown.count]).toEqual(["tool", s.id, toolTurn.id, 1]);
    expect(thrown.span_id).toBe(toolSpanId(s.id, "call-boom"));
    const call = tracer.span(thrown.span_id!)!;
    expect([call.kind, call.status, call.parent_id, call.error_id]).toEqual(["tool", "error", turnSpanId(traceIdOf(toolTurn.id)), thrown.id]);

    // The same failure again with nothing said about where: counted on the same
    // row, which no longer points at the earlier session, turn or span.
    const again = errors.capture("tool", new Error("fixture: the tool blew up"));
    expect(again.id).toBe(thrown.id);
    expect([again.count, again.session_id, again.turn_event, again.span_id]).toEqual([2, undefined, undefined, undefined]);
  } finally {
    allHooks().length = registered;
  }
});
