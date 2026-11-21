// keel run --input-format stream-json: one session a script holds open.
// Messages come as JSON lines on standard input (a prompt, an interrupt, an
// answer to a permission request or a question) and the session's events go
// out as JSON lines, until standard input closes and the work has ended.
// The shape is Claude Code's stream-json where Keel says the same thing
// (user messages, control_request and control_response); docs/headless.md is
// the reference, and STREAM_SCHEMA its version.
import { resolve } from "node:path";
import { chunks } from "../core/proc.ts";
import type { StoredEvent } from "../core/types.ts";
import { type Client, EXIT, type Found, usageError } from "./client.ts";
import { assistantText, Follower, STREAM_SCHEMA, streamLine } from "./events.ts";
import { daemonFor, exitOf, heldNote, resultObject, RUN_USAGE, type Watched } from "./run.ts";

export type Input =
  | { kind: "user"; text: string; images: { type: "image"; media_type: string; data: string }[]; uuid?: string }
  | { kind: "interrupt"; request_id: string }
  | { kind: "answer"; request_id: string; allow: boolean; message?: string; answers?: Record<string, unknown> }
  | { kind: "refused"; request_id: string; error: string }
  | { kind: "bad"; error: string };

// One line of standard input. Nothing here throws: a line that is not a
// message is said back on the stream and the session goes on.
export function parseInput(line: string): Input {
  let m: any;
  try { m = JSON.parse(line); } catch { return { kind: "bad", error: "not a JSON object on one line" }; }
  if (!m || typeof m !== "object" || Array.isArray(m)) return { kind: "bad", error: "not a JSON object on one line" };
  if (m.type === "user") {
    const c = m.message?.content ?? m.content;
    const blocks = typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : null;
    if (!blocks) return { kind: "bad", error: "a user message carries message.content: a string, or a list of text and image blocks" };
    const texts: string[] = [];
    const images: { type: "image"; media_type: string; data: string }[] = [];
    for (const b of blocks) {
      if (b?.type === "text" && typeof b.text === "string") texts.push(b.text);
      else if (b?.type === "image" && b.source?.type === "base64" && typeof b.source.data === "string" && typeof b.source.media_type === "string") images.push({ type: "image", media_type: b.source.media_type, data: b.source.data });
      else return { kind: "bad", error: `a user message takes text blocks and base64 image blocks, not ${JSON.stringify(b?.type ?? b)}` };
    }
    const text = texts.join("\n").trim();
    if (!text && !images.length) return { kind: "bad", error: "the user message is empty" };
    return { kind: "user", text, images, ...(typeof m.uuid === "string" ? { uuid: m.uuid } : {}) };
  }
  if (m.type === "control_request") {
    const id = typeof m.request_id === "string" ? m.request_id : "";
    if (!id) return { kind: "bad", error: "a control_request carries a request_id" };
    const sub = m.request?.subtype;
    if (sub === "interrupt") return { kind: "interrupt", request_id: id };
    // The mode is the one the command was started with: what a session may do
    // without asking is not widened from inside the stream.
    if (sub === "set_permission_mode") return { kind: "refused", request_id: id, error: "the permission mode is set when the command starts (--permission-mode), not over the stream" };
    return { kind: "refused", request_id: id, error: `unsupported control request: ${String(sub)}` };
  }
  if (m.type === "control_response") {
    const r = m.response ?? {};
    const id = typeof r.request_id === "string" ? r.request_id : "";
    if (!id) return { kind: "bad", error: "a control_response carries response.request_id" };
    const a = r.response ?? {};
    if (r.subtype === "error") return { kind: "answer", request_id: id, allow: false, message: typeof r.error === "string" ? r.error : undefined };
    if (a.answers && typeof a.answers === "object") return { kind: "answer", request_id: id, allow: true, answers: a.answers };
    if (a.behavior !== "allow" && a.behavior !== "deny") return { kind: "bad", error: "a control_response carries response.response.behavior: allow or deny (or answers, for a question)" };
    return { kind: "answer", request_id: id, allow: a.behavior === "allow", message: typeof a.message === "string" ? a.message : undefined };
  }
  return { kind: "bad", error: `unknown message type ${JSON.stringify(m.type)}: user, control_request or control_response` };
}

async function* stdinLines(): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of chunks(Bun.stdin.stream())) {
    buf += dec.decode(chunk, { stream: true });
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (l.trim()) yield l;
    }
  }
  if (buf.trim()) yield buf;
}

type OnAsk = "exit" | "deny" | "wait" | "stdin";
type Sent = { event_id: string | null; queue_id: string | null; text: string; uuid?: string; seen: boolean; at: number };
type Card = { id: string; session_id: string; card: "approval" | "question"; call_id?: string; tool?: string; input?: unknown; summary?: string; risk?: string };

const NO_ONE = "No one answers permission requests here: the run was started without --on-ask stdin.";
const CLOSED = "Standard input closed before this request was answered.";

export async function runStream(v: any, pos: string[], c0: Client, found: Found, name = "run"): Promise<number> {
  const t0 = Date.now();
  const say = (o: unknown) => console.log(JSON.stringify(o));
  const fmt = v["stream-json"] ? "stream-json" : v["output-format"];
  if (fmt && fmt !== "stream-json") return usageError(name, "--input-format stream-json writes stream-json: --output-format cannot be text or json", RUN_USAGE);
  for (const o of ["wait", "idempotency-key", "attach", "queue", "json"] as const) {
    if (v[o] !== undefined && !(Array.isArray(v[o]) && !v[o].length)) return usageError(name, `--${o} does not go with --input-format stream-json${o === "attach" ? " (an image is a block of its message)" : o === "queue" ? " (prompts already run one after another; --steer sends each at once)" : ""}`, RUN_USAGE);
  }
  const onAskFlag = v["on-ask"];
  if (onAskFlag && !["exit", "deny", "wait", "stdin"].includes(onAskFlag)) return usageError(name, "--on-ask is exit, deny, wait or stdin", RUN_USAGE);
  const timeoutS = v.timeout === undefined ? undefined : Number(v.timeout);
  if (timeoutS !== undefined && !(timeoutS > 0)) return usageError(name, "--timeout is a number of seconds above 0", RUN_USAGE);
  const sessionArg = v.session ?? v.resume;
  if (sessionArg && v.continue) return usageError(name, "pass --session or --continue, not both", RUN_USAGE);

  const cwd = resolve(v.cwd ?? process.cwd());
  const { c, own } = await daemonFor(c0, found, cwd);
  let onAsk = (onAskFlag ?? "deny") as OnAsk;
  if (own && onAsk === "exit") {
    await own.stop();
    console.error(`keel ${name}: --on-ask exit leaves a card open for someone to answer, but this command started the daemon itself and it ends with the command; use deny, wait or stdin, or start \`keel serve\``);
    return EXIT.error;
  }

  let sessionId: string | undefined;
  let url = "";
  let f: Follower | undefined;
  let wake: (() => void) | undefined;
  const inbox: Input[] = [];
  const prompts: Extract<Input, { kind: "user" }>[] = [];
  if (pos.join(" ").trim()) prompts.push({ kind: "user", text: pos.join(" ").trim(), images: [] });
  let open = true;
  let inputError: unknown;
  void (async () => {
    try { for await (const l of stdinLines()) { inbox.push(parseInput(l)); wake?.(); } } catch (e) { inputError = e; }
    open = false;
    wake?.();
  })();

  // The prompts this command sent whose turn has not ended, oldest first.
  const sent: Sent[] = [];
  const total = { turns: 0, cost: 0, unpriced: 0 };
  // The turn under way: what it said, what failed in it, the messages it took.
  let began = false;
  let answer = "";
  let errors: string[] = [];
  let uuids: string[] = [];
  let last: Watched | null = null;
  const calls = new Map<string, { name: string; input: unknown }>();
  const pending = new Map<string, Card>();
  const handled = new Set<string>();
  let refused = 0;

  const result = (w: Partial<Watched> & Pick<Watched, "subtype" | "outcome">, usage?: any) => {
    const u = usage ?? {};
    const one: Watched = {
      answer, errors, turns: total.turns, pending: 0, refused, held: false,
      usage: { input: u.input ?? 0, output: u.output ?? 0, cache_read: u.cache_read ?? 0, cache_write: u.cache_write ?? 0, cost: total.cost, unpriced: total.unpriced },
      ...w,
    };
    last = one;
    say({ ...resultObject(one, { sessionId: sessionId!, url, ms: Date.now() - t0, onAsk }), ...(uuids.length ? { user_message_uuids: uuids } : {}) });
    answer = "";
    errors = [];
    uuids = [];
    refused = 0;
  };
  // The prompts whose event was read are this turn's: its end settles them.
  const settle = () => { for (let i = sent.length - 1; i >= 0; i--) if (sent[i]!.seen) sent.splice(i, 1); };

  const onEvent = (e: StoredEvent) => {
    say(streamLine(e));
    if (e.kind === "user") {
      const s = sent.find((x) => !x.seen && ((x.event_id && x.event_id === e.id) || (x.queue_id && e.data?.queue_id === x.queue_id)));
      if (s) {
        s.seen = true;
        if (s.uuid) uuids.push(s.uuid);
      }
    } else if (e.kind === "assistant") {
      const t = assistantText(e).trim();
      if (t) answer = t;
      for (const b of e.data.blocks ?? []) if (b.type === "tool_use") calls.set(b.id, { name: b.name, input: b.input });
    } else if (e.kind === "turn_start") began = true;
    else if (e.kind === "error") {
      errors.push(String(e.data?.message ?? "error"));
      // With no turn under way it kept a prompt's turn from starting: no turn end follows.
      if (!began && sent.some((x) => x.seen)) {
        settle();
        result({ subtype: "error_during_execution", outcome: "failure" });
      }
    } else if (e.kind === "turn_end") {
      began = false;
      total.turns++;
      const u = e.data?.usage ?? {};
      total.cost += u.cost ?? 0;
      total.unpriced += u.unpriced ?? (u.cost === undefined && (u.input || u.output) ? 1 : 0);
      settle();
      const r = e.data?.reason;
      result(r === "end_turn" ? { subtype: "success", outcome: "success" } : r === "interrupted" ? { subtype: "cancelled", outcome: "cancelled" } : { subtype: "error_during_execution", outcome: "failure" }, u);
    }
  };
  const onDelta = v["include-partial-messages"]
    ? (d: { kind: string; text: string }) => say({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", delta: { type: d.kind === "thinking" ? "thinking_delta" : d.kind === "text" ? "text_delta" : "input_json_delta", text: d.text } } })
    : undefined;

  const send = async (p: Extract<Input, { kind: "user" }>) => {
    const first = !sessionId;
    let r: any;
    try {
      r = await c.post<any>("/api/run", first
        ? { text: p.text, images: p.images, session_id: sessionArg, continue: v.continue, cwd, model: v.model, provider: v.provider, permission_mode: v["permission-mode"] ?? v.mode, effort: v.effort, worktree: v.worktree, peer: v.peer ?? v.machine }
        : { text: p.text, images: p.images, session_id: sessionId, ...(v.steer ? { mode: "steer" } : {}) });
    } catch (e) {
      // A refused first prompt leaves no session: the command ends on it.
      if (first) throw e;
      if (p.uuid) uuids.push(p.uuid);
      errors.push((e as Error).message);
      return result({ subtype: "error_during_execution", outcome: "failure" });
    }
    sent.push({ event_id: r.event_id ?? null, queue_id: r.queue_id ?? null, text: p.text, uuid: p.uuid, seen: false, at: Date.now() });
    if (!first) return;
    sessionId = r.session_id as string;
    url = (own ? c0 : c).url(sessionId);
    const st = await c.get<any>(`/api/cli/state/${sessionId}`);
    const perm = await c.get<any>(`/api/sessions/${sessionId}/permissions`).catch(() => null);
    say({
      type: "system", subtype: "init", schema_version: STREAM_SCHEMA, session_id: sessionId, cwd: st.session.workspace, model: st.session.model, provider: String(st.session.model).split(":")[0],
      permission_mode: perm?.perm?.mode ?? null, on_ask: onAsk, capabilities: ["interrupt", "can_use_tool", "ask_question", "control_cancel_request"], keel_version: "bun", url,
    });
    f = new Follower(c, sessionId, r.after_seq, onEvent, onDelta);
    void f.connect();
  };

  const deny = async (k: Card, reason: string) => {
    if (k.card === "approval") await c.post(`/api/sessions/${k.session_id}/approvals/${k.id}`, { choice: "deny", reason }).catch(() => {});
    else await c.post(`/api/sessions/${k.session_id}/questions/${k.call_id}`, { answers: {} }).catch(() => {});
    refused++;
    say({ type: "system", subtype: "permission_denied", session_id: k.session_id, request_id: k.id, tool_name: k.tool ?? null, tool_use_id: k.call_id ?? null, ...(k.summary ? { summary: k.summary } : {}), reason });
  };

  // What the script wrote, in order. A prompt waits its turn in `prompts`.
  const drain = async () => {
    for (let m = inbox.shift(); m; m = inbox.shift()) {
      if (m.kind === "user") prompts.push(m);
      else if (m.kind === "bad") say({ type: "system", subtype: "input_error", error: m.error });
      else if (m.kind === "refused") say({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: m.error } });
      else if (m.kind === "interrupt") {
        const e = sessionId ? await c.post(`/api/sessions/${sessionId}/interrupt`).then(() => null, (x) => x as Error) : null;
        say({ type: "control_response", response: e ? { subtype: "error", request_id: m.request_id, error: e.message } : { subtype: "success", request_id: m.request_id } });
      } else {
        const k = pending.get(m.request_id);
        if (!k) { say({ type: "system", subtype: "input_error", request_id: m.request_id, error: "no open request has this id (it was answered, or its turn ended)" }); continue; }
        pending.delete(m.request_id);
        if (!m.allow) { await deny(k, m.message || "The script refused this request."); continue; }
        // One call, once: a standing rule is the owner's to give.
        const e = await (k.card === "approval"
          ? c.post(`/api/sessions/${k.session_id}/approvals/${k.id}`, { choice: "once" })
          : c.post(`/api/sessions/${k.session_id}/questions/${k.call_id}`, { answers: m.answers ?? {} })).then(() => null, (x) => x as Error);
        if (e) say({ type: "system", subtype: "input_error", request_id: m.request_id, error: `the answer was not taken: ${e.message}` });
      }
    }
  };

  // The cards open in the session and its agents: answered here, or passed to the script.
  const cards = async (st: any): Promise<boolean> => {
    const now: Card[] = [
      ...st.approvals.map((a: any) => ({ id: a.id, session_id: a.session_id, card: "approval" as const, call_id: a.call_id, tool: a.tool, input: a.input, summary: a.summary, risk: a.risk })),
      ...st.questions.map((q: any) => ({ id: q.call_id, session_id: q.session_id, card: "question" as const, call_id: q.call_id, tool: calls.get(q.call_id)?.name, input: calls.get(q.call_id)?.input })),
    ];
    // A request that closed without the script (answered in the workbench, its turn stopped).
    for (const id of [...pending.keys()]) {
      if (now.some((k) => k.id === id)) continue;
      pending.delete(id);
      say({ type: "control_cancel_request", request_id: id });
    }
    for (const k of now) {
      if (handled.has(k.id)) continue;
      if (onAsk === "exit") return true;
      if (onAsk === "wait") continue;
      handled.add(k.id);
      if (onAsk === "deny") await deny(k, open ? NO_ONE : CLOSED);
      else {
        pending.set(k.id, k);
        say({ type: "control_request", request_id: k.id, request: k.card === "approval"
          ? { subtype: "can_use_tool", session_id: k.session_id, tool_name: k.tool, tool_use_id: k.call_id, input: k.input, summary: k.summary, risk: k.risk }
          : { subtype: "ask_question", session_id: k.session_id, tool_name: k.tool ?? null, tool_use_id: k.call_id, input: k.input ?? null } });
      }
    }
    return false;
  };

  let interrupted: number | null = null;
  const onSignal = (code: number) => async () => {
    if (interrupted !== null) process.exit(code);
    interrupted = code;
    if (sessionId) await c.post(`/api/sessions/${sessionId}/interrupt`).catch(() => {});
    await own?.stop().catch(() => {});
    process.exit(code);
  };
  process.on("SIGINT", onSignal(EXIT.sigint));
  process.on("SIGTERM", onSignal(EXIT.sigterm));

  const deadline = timeoutS !== undefined ? t0 + timeoutS * 1000 : Infinity;
  let code: number | undefined;
  try {
    for (;;) {
      await drain();
      if (inputError) throw inputError;
      // No one is left to answer: what is open, and what opens from here on, is refused.
      if (!open && onAsk === "stdin") {
        onAsk = "deny";
        for (const k of [...pending.values()]) await deny(k, CLOSED);
        pending.clear();
      }
      // At rest: no turn runs and none will start by itself (a held queue starts none).
      let rest = true;
      let free = true;
      let bg = 0;
      if (sessionId && f) {
        await f.read();
        const st = await c.get<any>(`/api/cli/state/${sessionId}`);
        // Read once more: a turn that ended between the two reads is seen now.
        if (!st.running && st.last_seq > f.seq) await f.read();
        if (await cards(st)) {
          result({ subtype: "needs_input", outcome: "action_required", pending: st.approvals.length + st.questions.length });
          console.error(`keel ${name}: the session waits for the owner; answer with keel approve ${sessionId}`);
          break;
        }
        free = !st.running;
        rest = free && (st.queue === 0 || st.held);
        bg = st.background.agents + st.background.waits + st.background.jobs;
        const old = sent.find((x) => !x.seen);
        // The session was stopped and its queue is held: the prompt in it starts no turn.
        if (old && free && st.held && st.queue > 0) {
          sent.splice(sent.indexOf(old), 1);
          if (old.uuid) uuids.push(old.uuid);
          result({ subtype: "needs_input", outcome: "action_required", held: true });
          console.error(`keel ${name}: ${heldNote(sessionId)}`);
        } else if (old && rest && Date.now() - old.at > 30_000) {
          sent.splice(sent.indexOf(old), 1);
          if (old.uuid) uuids.push(old.uuid);
          errors.push("the prompt never started a turn");
          result({ subtype: "error_during_execution", outcome: "failure" });
        }
      }
      // One turn per prompt, in order: the next goes when the turn before has
      // ended. With --steer each goes at once and joins the turn that runs.
      if (prompts.length && (v.steer ? true : !sent.length && free)) {
        await send(prompts.shift()!);
        continue;
      }
      if (!open && !inbox.length && !prompts.length && !sent.length && rest && (v["no-wait-background"] || !bg)) break;
      if (Date.now() >= deadline) {
        if (sessionId) {
          result({ subtype: "timeout", outcome: null });
          if (own) await c.post(`/api/sessions/${sessionId}/interrupt`).catch(() => {});
        }
        console.error(`keel ${name}: --timeout ran out${own ? "; the turn was stopped" : "; the session keeps running"}`);
        code = EXIT.timeout;
        break;
      }
      if (inbox.length) continue;
      await new Promise<void>((done) => {
        const t = setTimeout(done, Math.min(1000, Math.max(50, deadline - Date.now())));
        wake = () => { clearTimeout(t); done(); };
        void f?.pause(1000).then(done);
      });
      wake = undefined;
    }
    if (sessionId && v.archived) await c.patch(`/api/sessions/${sessionId}`, { archived: true }).catch((e) => console.error(`keel ${name}: the session was not archived: ${e.message}`));
    // The command ends as its last result did; with no prompt at all, well.
    return code ?? (last ? exitOf(last) : EXIT.ok);
  } finally {
    f?.close();
    await own?.stop().catch(() => {});
  }
}
