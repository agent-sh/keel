import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { handleLine } from "./momentum.ts";

// A session another harness runs is only shown here (src/core/outside.ts): momentum neither lists it nor acts on it.
test("momentum's list leaves out an outside session and its acts do not reach one", () => {
  const dir = mkdtempSync(join(tmpdir(), "momentum-outside-"));
  try {
    const store = new Store(dir);
    const mine = store.createSession({ title: "Mine", model: "p:m", workspace: dir });
    const out = store.createSession({ title: "Elsewhere CANARY", model: "p:m", workspace: dir });
    store.updateSession(out.id, { outside: { harness: "claude", source_id: "x", state: "working", since: 1, files: 0, failures: 0 } });
    const sent: string[] = [];
    const engine = { isRunning: () => false, send: (id: string) => sent.push(id), interrupt: async (id: string) => sent.push(id) } as any;
    const c = { store, engine, transcript: () => "t" };
    const listed = handleLine(JSON.stringify({ cmd: "list_sessions" }), c) as any;
    expect(listed.sessions.map((s: any) => s.session_id)).toEqual([mine.id]);
    for (const action of ["steer", "interrupt"]) expect(handleLine(JSON.stringify({ cmd: "supervise_act", session_id: out.id, action, text: "x" }), c)).toMatchObject({ ok: false, code: "not_found" });
    expect(sent).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
