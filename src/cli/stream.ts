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
import { ApiError, type Client, EXIT, type Found, usageError } from "./client.ts";
import { assistantText, deltaLine, Follower, STREAM_SCHEMA, streamLine } from "./events.ts";
import { daemonFor, exitOf, heldNote, resultObject, RUN_USAGE, type Watched } from "./run.ts";

export type Input =
  | { kind: "user"; text: string; images: { type: "image"; media_type: string; data: string }[]; uuid?: string }
  | { kind: "interrupt"; request_id: string }
  // `updated`: the input the script wants the call to run with (Claude Code's
  // updatedInput). `grants`: it asked for a standing rule (updatedPermissions).
  | { kind: "answer"; request_id: string; allow: boolean; message?: string; answers?: Record<string, unknown>; updated?: unknown; grants?: boolean }
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
    const allow = a.behavior === "allow";
    return {
      kind: "answer", request_id: id, allow, message: typeof a.message === "string" ? a.message : undefined,
      ...(allow && a.updatedInput !== undefined && a.updatedInput !== null ? { updated: a.updatedInput } : {}),
      ...(allow && Array.isArray(a.updatedPermissions) && a.updatedPermissions.length ? { grants: true } : {}),
    };
  }
  return { kind: "bad", error: `unknown message type ${JSON.stringify(m.type)}: user, control_request or control_response` };
}

// The longest input line taken: the largest request a Claude host takes
// (32 MB on the Claude API, 20 MB on Bedrock: platform.claude.com/docs/en/api/overview),
// so a longer line could not reach a model as one prompt. Its bytes are
// dropped as they come, up to its newline, and the line is said back as skipped.
export const LINE_MAX = 32 * 1024 * 1024;

// The lines of a byte stream, each once it is whole. Only the bytes of the
// line being read are held, and a new chunk alone is searched for its end.
export async function* inputLines(src: AsyncIterable<Uint8Array>, max = LINE_MAX): AsyncGenerator<string | { over: number }> {
  let parts: Uint8Array[] = [];
  let size = 0;
  const whole = function* (): Generator<string | { over: number }> {
    if (size > max) yield { over: size };
    else if (size) {
      const l = Buffer.concat(parts).toString("utf8");
      if (l.trim()) yield l;
    }
    parts = [];
    size = 0;
  };
  for await (const chunk of src) {
    for (let from = 0; from <= chunk.length;) {
      const i = chunk.indexOf(10, from);
      const piece = chunk.subarray(from, i < 0 ? chunk.length : i);
      size += piece.length;
      if (size > max) parts = [];
      else if (piece.length) parts.push(piece);
      if (i < 0) break;
      yield* whole();
      from = i + 1;
    }
  }
  yield* whole();
}

// Whether two JSON values say the same, whatever the order of their keys.
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => k in (b as object) && sameJson((a as any)[k], (b as any)[k]));
}

type OnAsk = "exit" | "deny" | "wait" | "stdin";
type Prompt = Extract<Input, { kind: "user" }> & { key?: string };
type Sent = { event_id: string | null; queue_id: string | null; text: string; uuid?: string; seen: boolean; at: number };
type Card = { id: string; session_id: string; card: "approval" | "question"; call_id?: string; tool?: string; input?: unknown; summary?: string; risk?: string; cut?: boolean; why?: string };

const NO_ONE = "No one answers permission requests here: the run was started without --on-ask stdin.";
const CLOSED = "Standard input closed before this request was answered.";
const CHANGED = "The script allowed this call with another input than the one asked about. Keel runs a call as it was asked or not at all, so it was refused: call the tool again with the input wanted.";
// How long a daemon that takes no connection is waited for: what `keel
// restart` gives a daemon to come back after its drain (src/cli/admin.ts).
const AWAY_MS = 90_000;

// The daemon is not there to take the call: it took no connection, the call
// broke on the way, or it is draining and turned the call away at the door.
const gone = (e: unknown): e is ApiError => e instanceof ApiError && (e.status === 0 || e.refused);

export async function runStream(v: any, pos: string[], c0: Client, found: Found, name = "run"): Promise<number> {
  const t0 = Date.now();
  // The first line written, whatever it is, says the schema version.
  let said = false;
  const say = (o: Record<string, unknown>) => {
    console.log(JSON.stringify(said || "schema_version" in o ? o : { type: o.type, ...("subtype" in o ? { subtype: o.subtype } : {}), schema_version: STREAM_SCHEMA, ...o }));
    said = true;
  };
  const fmt = v["stream-json"] ? "stream-json" : v["output-format"];
  if (fmt && fmt !== "stream-json") return usageError(name, "--input-format stream-json writes stream-json: --output-format cannot be text or json", RUN_USAGE);
  const WHY: Record<string, string> = {
    attach: " (an image is a block of its message)", queue: " (prompts already run one after another; --steer sends each at once)",
    "json-schema": " (one schema fits one answer; a held session has many)", "output-schema": " (one schema fits one answer; a held session has many)",
  };
  for (const o of ["wait", "idempotency-key", "attach", "queue", "json", "json-schema", "output-schema"] as const) {
    if (v[o] !== undefined && !(Array.isArray(v[o]) && !v[o].length)) return usageError(name, `--${o} does not go with --input-format stream-json${WHY[o] ?? ""}`, RUN_USAGE);
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
  const prompts: Prompt[] = [];
  if (pos.join(" ").trim()) prompts.push({ kind: "user", text: pos.join(" ").trim(), images: [] });
  let open = true;
  let inputError: unknown;
  void (async () => {
    try {
      for await (const l of inputLines(chunks(Bun.stdin.stream()))) {
        inbox.push(typeof l === "string" ? parseInput(l) : { kind: "bad", error: `a line of ${l.over} bytes is longer than a message can be (${LINE_MAX} bytes): it was skipped` });
        wake?.();
      }
    } catch (e) { inputError = e; }
    open = false;
    wake?.();
  })();

  // The prompts this command sent whose turn has not ended, oldest first.
  const sent: Sent[] = [];
  const total = { turns: 0, cost: 0, unpriced: 0 };
  // The turn under way: what it said, what failed in it, the messages it
  // took, what it used, the requests refused in it and when its prompt went.
  let began = false;
  let answer = "";
  let errors: string[] = [];
  let uuids: string[] = [];
  let used = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  let denials: { tool_name: string | null; tool_use_id: string | null; tool_input: unknown }[] = [];
  let since: number | null = null;
  let last: Watched | null = null;
  // A turn that ended without its result written yet. One that failed: the
  // engine stores the turn's end first and its error after it, so the result
  // waits for that error. `parked`: a daemon restart cut it, and the next
  // daemon continues it; its result is the continued turn's, or says that it
  // was not continued.
  let owed: { parked: boolean } | null = null;
  const calls = new Map<string, { name: string; input: unknown }>();
  const pending = new Map<string, Card>();
  const handled = new Set<string>();

  const result = (w: Partial<Watched> & Pick<Watched, "subtype" | "outcome">) => {
    const one: Watched = { answer, errors, turns: total.turns, pending: 0, refused: denials.length, held: false, usage: { ...used, cost: total.cost, unpriced: total.unpriced }, ...w };
    last = one;
    say({
      ...resultObject(one, { sessionId: sessionId!, url, ms: since === null ? 0 : Date.now() - since, onAsk }),
      ...(denials.length ? { permission_denials: denials } : {}), ...(uuids.length ? { user_message_uuids: uuids } : {}),
    });
    answer = "";
    errors = [];
    uuids = [];
    denials = [];
    used = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    since = null;
  };
  // The prompts whose event was read are this turn's: its end settles them.
  const settle = () => { for (let i = sent.length - 1; i >= 0; i--) if (sent[i]!.seen) sent.splice(i, 1); };
  const failure = { subtype: "error_during_execution", outcome: "failure" } as const;
  // The result of the turn that is owed one, now that what follows its end was read.
  const flush = () => {
    if (!owed) return;
    if (owed.parked) {
      total.turns++;
      settle();
      if (!errors.length) errors.push("A daemon restart cut the turn and it was not continued.");
    }
    owed = null;
    result(failure);
  };

  const onEvent = (e: StoredEvent) => {
    say(streamLine(e));
    // What follows a failed turn's end and is not its error: the turn had none to add.
    if (owed && !owed.parked && e.kind !== "error") flush();
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
    } else if (e.kind === "turn_start") {
      // A turn the restart cut goes on here: its result is this turn's.
      owed = null;
      began = true;
      // What failed before this turn is not this turn's.
      errors = [];
      since ??= e.ts;
    } else if (e.kind === "note" && e.data?.kind === "restart" && owed?.parked) {
      // The daemon did not continue the cut turn, and says why.
      errors.push(String(e.data.text ?? ""));
      flush();
    } else if (e.kind === "error") {
      errors.push(String(e.data?.message ?? "error"));
      if (owed && !owed.parked) flush();
      // With no turn under way it kept a prompt's turn from starting: no turn end follows.
      else if (!owed && !began && sent.some((x) => x.seen)) {
        settle();
        result(failure);
      }
    } else if (e.kind === "turn_end") {
      began = false;
      const u = e.data?.usage ?? {};
      used = { input: used.input + (u.input ?? 0), output: used.output + (u.output ?? 0), cache_read: used.cache_read + (u.cache_read ?? 0), cache_write: used.cache_write + (u.cache_write ?? 0) };
      total.cost += u.cost ?? 0;
      total.unpriced += u.unpriced ?? (u.cost === undefined && (u.input || u.output) ? 1 : 0);
      const r = e.data?.reason;
      // Parked for a daemon restart: not over. The prompts it took stay its own.
      if (r === "restart") return void (owed = { parked: true });
      total.turns++;
      settle();
      if (r === "end_turn") result({ subtype: "success", outcome: "success" });
      else if (r === "interrupted") result({ subtype: "cancelled", outcome: "cancelled" });
      else owed = { parked: false };
    }
  };
  const onDelta = v["include-partial-messages"] ? (d: { kind: string; text: string }) => say(deltaLine(sessionId, d)) : undefined;

  // The daemon is away: it takes no connection (`unreached`), or it is
  // draining for a stop or a restart and takes no new prompt (`draining`).
  let away: { since: number; why: "draining" | "unreached" } | null = null;
  const gotAway = (why: "draining" | "unreached", e: Error) => {
    if (away?.why === why) return;
    away = { since: Date.now(), why };
    say({ type: "system", subtype: "daemon_away", ...(sessionId ? { session_id: sessionId } : {}), reason: why, error: e.message });
  };
  const cameBack = () => {
    if (!away) return;
    away = null;
    say({ type: "system", subtype: "daemon_back", ...(sessionId ? { session_id: sessionId } : {}) });
    void f?.connect();
  };

  // Sends a prompt. False: the daemon is draining and took nothing; the prompt waits.
  const send = async (p: Prompt): Promise<boolean> => {
    const first = !sessionId;
    // A send whose answer was lost is sent again under the same key: the daemon stores the prompt once.
    p.key ??= `stream-${crypto.randomUUID()}`;
    let r: any;
    try {
      r = await c.post<any>("/api/run", first
        ? { text: p.text, images: p.images, idempotency_key: p.key, session_id: sessionArg, continue: v.continue, cwd, model: v.model, provider: v.provider, permission_mode: v["permission-mode"] ?? v.mode, effort: v.effort, worktree: v.worktree, peer: v.peer ?? v.machine }
        : { text: p.text, images: p.images, idempotency_key: p.key, session_id: sessionId, ...(v.steer ? { mode: "steer" } : {}) });
    } catch (e) {
      if (!own && gone(e)) {
        prompts.unshift(p);
        if (!e.refused) throw e;
        gotAway("draining", e);
        return false;
      }
      // A refused first prompt leaves no session: the command ends on it.
      if (first) throw e;
      if (p.uuid) uuids.push(p.uuid);
      errors = [(e as Error).message];
      result(failure);
      return true;
    }
    cameBack();
    since ??= Date.now();
    sent.push({ event_id: r.event_id ?? null, queue_id: r.queue_id ?? null, text: p.text, uuid: p.uuid, seen: false, at: Date.now() });
    if (!first) return true;
    sessionId = r.session_id as string;
    url = (own ? c0 : c).url(sessionId);
    const st = await c.get<any>(`/api/cli/state/${sessionId}`);
    const perm = await c.get<any>(`/api/sessions/${sessionId}/permissions`).catch(() => null);
    say({
      type: "system", subtype: "init", schema_version: STREAM_SCHEMA, session_id: sessionId, cwd: st.session.workspace, model: st.session.model, provider: String(st.session.model).split(":")[0],
      permission_mode: perm?.perm?.mode ?? null, on_ask: onAsk, capabilities: ["interrupt", "can_use_tool", "ask_question", "control_cancel_request", "daemon_away"], keel_version: "bun", url,
    });
    f = new Follower(c, sessionId, r.after_seq, onEvent, onDelta);
    void f.connect();
    return true;
  };

  // An answer to a card. `done`: taken. `closed`: the card is not open any
  // more (answered elsewhere, its turn ended). An error: the daemon did not
  // take it and the card is still open.
  const answerCard = async (k: Card, body: unknown): Promise<"done" | "closed" | Error> => {
    try {
      await c.post(k.card === "approval" ? `/api/sessions/${k.session_id}/approvals/${k.id}` : `/api/sessions/${k.session_id}/questions/${k.call_id}`, body);
      return "done";
    } catch (e) {
      const st = (e as ApiError).status;
      return st === 404 || st === 409 ? "closed" : (e as Error);
    }
  };
  const deny = async (k: Card, reason: string): Promise<"done" | "closed" | Error> => {
    const r = await answerCard(k, k.card === "approval" ? { choice: "deny", reason } : { answers: {} });
    if (r !== "done") return r;
    denials.push({ tool_name: k.tool ?? null, tool_use_id: k.call_id ?? null, tool_input: k.input ?? null });
    say({ type: "system", subtype: "permission_denied", session_id: k.session_id, request_id: k.id, tool_name: k.tool ?? null, tool_use_id: k.call_id ?? null, ...(k.summary ? { summary: k.summary } : {}), reason });
    return r;
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
        // The call runs as it was shown or not at all: an allow that changes its input refuses it.
        const changed = m.allow && m.updated !== undefined && !sameJson(m.updated, k.input);
        const r = !m.allow || changed
          ? await deny(k, changed ? CHANGED : m.message || "The script refused this request.")
          // One call, once: a standing rule is the owner's to give.
          : await answerCard(k, k.card === "approval" ? { choice: "once" } : { answers: m.answers ?? {} });
        // Not taken: the request stays open for another answer, and is refused when standard input closes.
        if (r instanceof Error) { say({ type: "system", subtype: "input_error", request_id: m.request_id, error: `the answer was not taken (${r.message}): the request is still open, answer it again` }); continue; }
        pending.delete(m.request_id);
        if (r === "closed") say({ type: "control_cancel_request", request_id: m.request_id });
        else if (changed) say({ type: "system", subtype: "input_error", request_id: m.request_id, error: "updatedInput differs from the input asked about, which Keel does not take: the call was refused" });
        else if (m.grants) say({ type: "system", subtype: "input_error", request_id: m.request_id, error: "updatedPermissions is not taken: the allow covers this one call, and the same call asks again" });
      }
    }
  };

  // The cards open in the session and its agents: answered here, or passed to the script.
  const cards = async (st: any): Promise<boolean> => {
    const now: Card[] = [
      ...st.approvals.map((a: any) => ({ id: a.id, session_id: a.session_id, card: "approval" as const, call_id: a.call_id, tool: a.tool, input: a.input, summary: a.summary, risk: a.risk, cut: a.cut, why: a.why })),
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
      if (onAsk === "deny") {
        // One the daemon did not take the refusal of is refused again at the next look.
        if (!((await deny(k, open ? NO_ONE : CLOSED)) instanceof Error)) handled.add(k.id);
        continue;
      }
      handled.add(k.id);
      pending.set(k.id, k);
      say({ type: "control_request", request_id: k.id, request: k.card === "approval"
        ? { subtype: "can_use_tool", session_id: k.session_id, tool_name: k.tool, tool_use_id: k.call_id, input: k.input, summary: k.summary, risk: k.risk, ...(k.cut ? { input_cut: true } : {}), ...(k.why ? { once_only: k.why } : {}) }
        : { subtype: "ask_question", session_id: k.session_id, tool_name: k.tool ?? null, tool_use_id: k.call_id, input: k.input ?? null } });
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
  const pause = (ms: number) => new Promise<void>((done) => {
    const t = setTimeout(done, Math.min(ms, Math.max(50, deadline - Date.now())));
    wake = () => { clearTimeout(t); done(); };
    void f?.pause(ms).then(done);
  }).then(() => void (wake = undefined));
  // One look at the session and one step: "more" (go on at once), "wait", or "end".
  const step = async (): Promise<"more" | "wait" | "end"> => {
    await drain();
    if (inputError) throw inputError;
    // No one is left to answer: what is open, and what opens from here on, is refused.
    if (!open && onAsk === "stdin") {
      onAsk = "deny";
      for (const id of pending.keys()) handled.delete(id);
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
      if (away?.why === "unreached") cameBack();
      if (f.lost) void f.connect();
      // Nothing runs and what followed the turn's end was read: its result is due.
      // A turn a restart cut is waited for while the daemon says it will continue it.
      if (owed && !st.running && !(owed.parked && st.state?.watch === "resume")) flush();
      if (await cards(st)) {
        result({ subtype: "needs_input", outcome: "action_required", pending: st.approvals.length + st.questions.length });
        console.error(`keel ${name}: the session waits for the owner; answer with keel approve ${sessionId}`);
        return "end";
      }
      free = !st.running && !owed;
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
        errors = ["the prompt never started a turn"];
        result(failure);
      }
    }
    // One turn per prompt, in order: the next goes when the turn before has
    // ended. With --steer each goes at once and joins the turn that runs.
    if (prompts.length && (v.steer ? true : !sent.length && free)) return (await send(prompts.shift()!)) ? "more" : "wait";
    if (!open && !inbox.length && !prompts.length && !sent.length && rest && (v["no-wait-background"] || !bg)) return "end";
    return inbox.length ? "more" : "wait";
  };

  let code: number | undefined;
  try {
    for (;;) {
      let next: "more" | "wait" | "end";
      try {
        next = await step();
      } catch (e) {
        // A daemon of its own never goes away; any other failure is the command's.
        if (own || !gone(e)) throw e;
        gotAway("unreached", e);
        // It did not come back: the command ends, the session is kept.
        if (Date.now() - away!.since > AWAY_MS) {
          if (sessionId) {
            errors = [`the daemon at ${c.base} has taken no connection for ${Math.round(AWAY_MS / 1000)} s: ${e.message}`];
            result(failure);
          }
          console.error(`keel ${name}: ${e.message}${sessionId ? `; the session is kept: keel run --input-format stream-json -r ${sessionId}` : ""}`);
          code = EXIT.error;
          break;
        }
        next = "wait";
      }
      if (next === "end") break;
      if (Date.now() >= deadline) {
        if (sessionId) {
          result({ subtype: "timeout", outcome: null });
          if (own) await c.post(`/api/sessions/${sessionId}/interrupt`).catch(() => {});
        }
        console.error(`keel ${name}: --timeout ran out${own ? "; the turn was stopped" : "; the session keeps running"}`);
        code = EXIT.timeout;
        break;
      }
      if (next === "wait") await pause(away ? 500 : 1000);
    }
    if (sessionId && v.archived) await c.patch(`/api/sessions/${sessionId}`, { archived: true }).catch((e) => console.error(`keel ${name}: the session was not archived: ${e.message}`));
    // The command ends as its last result did; with no prompt at all, well.
    return code ?? (last ? exitOf(last) : EXIT.ok);
  } finally {
    f?.close();
    await own?.stop().catch(() => {});
  }
}
