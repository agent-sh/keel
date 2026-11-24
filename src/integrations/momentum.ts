// momentum, the owner's supervisor of agent sessions. Two links:
// - a control socket (`<state>/momentum.sock`, mode 0600, one JSON command per
//   line) where momentum reads Keel's own session phases instead of scraping a
//   terminal, and queues, steers or interrupts a session; text it sends is
//   tagged `[momentum]` so it is never taken for the owner's words;
// - `GET /api/momentum`: momentum's own report (`momentum report --json`), or
//   `{ available: false }`. Nothing is invented when it cannot be read.
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Store } from "../core/store.ts";
import type { Session } from "../core/types.ts";
import { isOutside } from "../core/outside.ts";
import type { Engine } from "../engine/turn.ts";
import { findBin, runBounded } from "./tacit.ts";

export const MAX_LINE = 256 * 1024;

// draft: whether the owner has an unsent message in the session (its presence
// only, never its text); without it the answer is unknown (null).
// `deliver`: input that is not the owner's, as the daemon's own (a wake, a loop
// run) goes in: it starts a turn in an idle session and takes along what rides
// the session's next input (agents' reports held after the owner's Stop).
type Ctx = { store: Store; engine: Engine; transcript?: (s: Session) => string; draft?: (id: string) => boolean; deliver?: (sessionId: string, text: string, meta: Record<string, unknown>) => boolean };

// The momentum phase of a session: needs_you (an approval is open), working, idle, done.
export function phaseOf(s: Session, running: boolean, pending: Set<string>) {
  if (pending.has(s.id)) return "needs_you";
  if (running || s.phase === "working") return "working";
  if (s.archived) return "done";
  return "idle";
}

function pendingApprovals(store: Store): Map<string, string> {
  try {
    const rows = store.db.query<{ session_id: string; data: string }, []>("SELECT session_id, data FROM approvals WHERE state = 'pending'").all();
    return new Map(rows.map((r) => [r.session_id, String(JSON.parse(r.data).summary ?? "")]));
  } catch {
    return new Map(); // the gate's table is not there
  }
}

export function handleLine(line: string, c: Ctx): Record<string, unknown> {
  let cmd: any;
  try {
    cmd = JSON.parse(line.trim());
  } catch {
    return { ok: false, error: "invalid command json" };
  }
  if (cmd?.cmd === "list_sessions") {
    const asks = pendingApprovals(c.store);
    const pending = new Set(asks.keys());
    return {
      ok: true,
      // (A session another harness runs is only shown in Keel: src/core/outside.ts.)
      sessions: c.store.sessions({}).filter((s) => !isOutside(s)).map((s) => ({
        key: `keel:${s.id}`,
        session_id: s.id,
        tool: "keel",
        name: s.title,
        cwd: s.workspace,
        model: s.model,
        phase: phaseOf(s, c.engine.isRunning(s.id), pending),
        ask_kind: pending.has(s.id) ? "permission" : null,
        ask: asks.get(s.id) ?? null,
        ui_draft_present: c.draft ? c.draft(s.id) : null,
        transcript: c.transcript?.(s) ?? null,
        updated_ms: s.updated,
      })),
    };
  }
  if (cmd?.cmd === "supervise_act") {
    const { session_id, action } = cmd;
    const text = String(cmd.text ?? "");
    if (!["queue", "steer", "interrupt"].includes(action)) return { ok: false, code: "bad_action", error: "action must be queue, steer or interrupt" };
    const s = typeof session_id === "string" ? c.store.session(session_id) : null;
    if (!s || isOutside(s)) return { ok: false, code: "not_found", error: "unknown session" };
    if (action === "interrupt") {
      void c.engine.interrupt(s.id, "supervisor");
      return { ok: true, accepted: action };
    }
    if (!text.trim()) return { ok: false, code: "empty_text", error: "queue and steer need text" };
    if (s.archived) return { ok: false, code: "archived", error: "the session is archived" };
    // The owner is writing a message there: momentum's waits, so their message
    // is not overtaken (interrupt still goes through).
    if (c.draft?.(s.id)) return { ok: false, code: "hold_ui_draft", error: "the owner has an unsent message in this session" };
    const tagged = text.trimStart().startsWith("[momentum]") ? text : `[momentum] ${text.trim()}`;
    // steer: joins the running turn at its next step, or starts a turn in an idle session.
    // queue: waits for the running turn and what is queued before it. In an idle
    // session it starts a turn, unless the queue is held (a turn was stopped and
    // nothing resumed it): then it waits there for the owner.
    if (action === "steer" && c.deliver && !c.engine.isRunning(s.id)) c.deliver(s.id, tagged, { origin: "momentum" });
    else c.engine.send(s.id, tagged, { mode: action === "steer" ? "steer" : "queue", meta: { origin: "momentum" } });
    return { ok: true, accepted: action };
  }
  return { ok: false, error: "invalid command json" };
}

export function startMomentumSocket(path: string, c: Ctx) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) rmSync(path);
  const old = process.umask(0o177); // the socket is born 0600: no window for another user
  let server: ReturnType<typeof Bun.listen>;
  try {
    server = Bun.listen<{ buf: string }>({
      unix: path,
      socket: {
        open(sock) { sock.data = { buf: "" }; },
        data(sock, chunk) {
          sock.data.buf += new TextDecoder().decode(chunk);
          let i: number;
          while ((i = sock.data.buf.indexOf("\n")) >= 0) {
            const line = sock.data.buf.slice(0, i);
            sock.data.buf = sock.data.buf.slice(i + 1);
            if (line.trim()) sock.write(JSON.stringify(handleLine(line, c)) + "\n");
          }
          if (sock.data.buf.length > MAX_LINE) {
            sock.write(JSON.stringify({ ok: false, code: "line_too_long", error: "command line too long" }) + "\n");
            sock.end();
          }
        },
      },
    });
  } finally {
    process.umask(old);
  }
  chmodSync(path, 0o600);
  return { path, stop: () => { server.stop(true); rmSync(path, { force: true }); } };
}

export async function momentumReport(bin = findBin("MOMENTUM_BIN", "momentum")) {
  if (!bin) return { available: false };
  const out = await runBounded([bin, "report", "--json"], "", 4000);
  if (!out) return { available: false };
  try {
    return { available: true, stale: false, report: JSON.parse(out) };
  } catch {
    return { available: false };
  }
}

export const momentumSocketPath = (stateDir: string) => join(stateDir, "momentum.sock");
