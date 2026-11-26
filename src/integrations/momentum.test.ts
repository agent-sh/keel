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

// The sweep credits a nudge to the message and turn end dated at or after it: the act is stored before it is carried out.
test("a supervisor's act is stored before the message or stop it makes", () => {
  const dir = mkdtempSync(join(tmpdir(), "momentum-order-"));
  try {
    const store = new Store(dir);
    const s = store.createSession({ title: "Mine", model: "p:m", workspace: dir });
    const seen: number[] = [];
    const acts = () => (store.db.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'momentum_acts'").get() as any).n ? (store.db.query("SELECT COUNT(*) AS n FROM momentum_acts").get() as any).n : 0;
    const engine = { isRunning: () => true, send: () => seen.push(acts()), interrupt: async () => { seen.push(acts()); } } as any;
    const c = { store, engine, transcript: () => "t" };
    expect(handleLine(JSON.stringify({ cmd: "supervise_act", session_id: s.id, action: "queue", text: "go on" }), c)).toMatchObject({ ok: true });
    expect(handleLine(JSON.stringify({ cmd: "supervise_act", session_id: s.id, action: "interrupt" }), c)).toMatchObject({ ok: true });
    expect(seen).toEqual([1, 2]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The session list is larger than a socket takes at once: the whole line arrives, as one JSON reply.
test("a reply larger than the socket takes at once arrives whole", async () => {
  const dir = mkdtempSync(join(tmpdir(), "momentum-large-"));
  const { startMomentumSocket } = await import("./momentum.ts");
  const store = new Store(dir);
  const sock = join(dir, "m.sock");
  try {
    const title = "x".repeat(1000);
    for (let i = 0; i < 1500; i++) store.createSession({ title: `${i} ${title}`, model: "p:m", workspace: dir });
    const engine = { isRunning: () => false } as any;
    const server = startMomentumSocket(sock, { store, engine, transcript: () => "t" });
    try {
      const got = await new Promise<string>((resolve, reject) => {
        let buf = "";
        const t = setTimeout(() => reject(new Error(`no whole line, ${buf.length} bytes`)), 10_000);
        void Bun.connect({ unix: sock, socket: {
          open(s) { s.write('{"cmd":"list_sessions"}\n'); },
          data(s, chunk) { buf += new TextDecoder().decode(chunk); if (buf.endsWith("\n")) { clearTimeout(t); s.end(); resolve(buf); } },
        } });
      });
      const reply = JSON.parse(got);
      expect(reply.ok).toBe(true);
      expect(reply.sessions.length).toBe(1500);
    } finally {
      server.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
