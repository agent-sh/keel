// keel run (and keel resume): a prompt from the command line, like `claude -p`
// and `codex exec`. With -p it stays until the work has ended and prints the
// answer (text, one JSON object, or JSON lines); with --wait it stays for the
// turn's outcome; otherwise it returns at once. With no daemon answering it
// starts one inside this process (runMode.client) and stops it at the end.
import { resolve } from "node:path";
import { lockedDaemon } from "../admin/daemon.ts";
import type { StoredEvent } from "../core/types.ts";
import { startDaemon, type Started } from "../server/start.ts";
import { ApiError, clean, Client, command, EXIT, type Found, out, pipedStdin, promptFiles, usageError } from "./client.ts";
import { assistantText, Follower, streamLine } from "./events.ts";

export const RUN_USAGE = `keel run [PROMPT] [options]       (also: keel -p is keel run -p)
  Sends a prompt to a new session in this directory, or to an existing one.
  The prompt is the argument; with none (or "-") it is read from standard input.
  With a prompt and piped input, the input is added to the prompt as context.

  -p, --print                 stay until the work has ended, print the answer
      --output-format F       text, json or stream-json (implies -p)
      --stream-json           same as --output-format stream-json
      --include-partial-messages  with stream-json: text as it streams
      --json                  one JSON object (alone: the session id; with -p or --wait: the result)
      --wait                  stay until the turn has ended and print its outcome
  -r, --session, --resume ID  send to this session (any unique prefix of its id)
  -c, --continue              send to the newest session of the directory
  -C, --cwd DIR               directory of a new session (default: here)
  -m, --model M               a model id, its provider's name for it, or its listed name
      --provider P            the provider of --model
      --permission-mode, --mode MODE   ask, auto-edits, auto, full-auto, read-only, plan or reviewer
      --steer, --queue        to a busy session: join the running turn at its next model
                              call (the default), or run after it (as keel send takes them)
      --effort E              one of the model's listed efforts
      --worktree[=NAME]       start the session in a git worktree of its own
      --peer, --machine NAME  run the session's tools on this fleet machine
      --attach FILE           a file or image to send with the prompt (repeatable)
      --idempotency-key KEY   a retry with the same key starts no second session or turn
      --timeout S             seconds to stay (exit 124; the session keeps running)
      --on-ask exit|deny|wait what an approval card or a question does (default exit;
                              deny when this command started the daemon itself)
      --no-wait-background    with -p: leave when the turn ends, not when its background work does
      --archived              archive the session when the run has ended
      --url URL, --state-dir DIR   which daemon (default: the one the state folder records)

  Exit codes: 0 done, 2 the session needs the owner, 3 error, 124 timeout, 130/143 signal.`;

export const RUN_OPTIONS = {
  print: { type: "boolean", short: "p" },
  "output-format": { type: "string" },
  "stream-json": { type: "boolean" },
  "include-partial-messages": { type: "boolean" },
  wait: { type: "boolean" },
  session: { type: "string", short: "r" },
  resume: { type: "string" },
  continue: { type: "boolean", short: "c" },
  cwd: { type: "string", short: "C" },
  model: { type: "string", short: "m" },
  provider: { type: "string" },
  "permission-mode": { type: "string" },
  mode: { type: "string" },
  steer: { type: "boolean" },
  queue: { type: "boolean" },
  effort: { type: "string" },
  worktree: { type: "string" },
  peer: { type: "string" },
  machine: { type: "string" },
  attach: { type: "string", multiple: true },
  "idempotency-key": { type: "string" },
  timeout: { type: "string" },
  "on-ask": { type: "string" },
  "no-wait-background": { type: "boolean" },
  archived: { type: "boolean" },
} as const;

// `--worktree` alone means a worktree with no name.
export const worktreeArg = (argv: string[]) => argv.map((a) => (a === "--worktree" ? "--worktree=" : a));

type Outcome = "success" | "failure" | "cancelled" | "action_required" | null;
const outcomeOf = (reason?: string): Outcome =>
  !reason ? null : reason === "end_turn" ? "success" : reason === "interrupted" ? "cancelled" : "failure";

export type Watch = {
  c: Client;
  sessionId: string;
  afterSeq: number;
  eventId: string | null;
  // A prompt the daemon queued: its event carries this id once it is sent.
  queueId?: string | null;
  prompt: string;
  stay: "turn" | "all"; // the turn, or the turn and the work it left running
  onAsk: "exit" | "deny" | "wait";
  timeoutS?: number;
  onEvent?: (e: StoredEvent) => void;
  onDelta?: (d: { kind: string; text: string }) => void;
  t0?: number;
};

export type Watched = {
  subtype: "success" | "needs_input" | "error_during_execution" | "cancelled" | "timeout";
  outcome: Outcome;
  answer: string;
  errors: string[];
  turns: number;
  usage: { input: number; output: number; cache_read: number; cache_write: number; cost: number; unpriced: number };
  pending: number;
  refused: number;
};

// Follows a session from a prompt until the work it asked for has ended.
export async function watch(w: Watch): Promise<Watched> {
  const r: Watched = { subtype: "success", outcome: null, answer: "", errors: [], turns: 0, usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0, unpriced: 0 }, pending: 0, refused: 0 };
  let ours = false;
  let ended = false;
  let lastAnswer = "";
  // Staying for one turn, what that turn said is final once it ended: a later
  // prompt's turn read in the same batch is not this one's.
  let frozen = false;
  // Staying for the work a turn left: the turn of another prompt, begun after
  // this one's ended, is not this command's to show or to count.
  let theirs = false;
  const mine = (e: StoredEvent) =>
    e.id === w.eventId || (!!w.queueId && e.data?.queue_id === w.queueId) || (!w.eventId && !w.queueId && String(e.data?.text ?? "").trim() === w.prompt.trim());
  const prompt = (e: StoredEvent) => e.kind === "user" && !e.data?.kind && [undefined, "queued", "steer", "voice"].includes(e.data?.origin);
  const f = new Follower(w.c, w.sessionId, w.afterSeq, (e) => {
    if (frozen) return;
    if (!ours && e.kind === "user" && mine(e)) ours = true;
    if (!ours) return;
    if (ended && prompt(e)) theirs = true;
    if (theirs) {
      if (e.kind === "turn_end") theirs = false;
      return;
    }
    w.onEvent?.(e);
    if (e.kind === "assistant") {
      const t = assistantText(e).trim();
      if (t) lastAnswer = t;
    } else if (e.kind === "error") r.errors.push(String(e.data?.message ?? "error"));
    else if (e.kind === "turn_end") {
      ended = true;
      r.turns++;
      r.outcome = outcomeOf(e.data?.reason);
      const u = e.data?.usage ?? {};
      r.usage.input += u.input ?? 0;
      r.usage.output += u.output ?? 0;
      r.usage.cache_read += u.cache_read ?? 0;
      r.usage.cache_write += u.cache_write ?? 0;
      r.usage.cost += u.cost ?? 0;
      r.usage.unpriced += u.unpriced ?? (u.cost === undefined && (u.input || u.output) ? 1 : 0);
      if (w.stay === "turn") frozen = true;
    } else if (e.kind === "turn_start") ended = false;
    // Text streams in line with the events (see Follower): before this prompt's
    // own event it is the reply to another prompt.
  }, (d) => { if (ours && !frozen && !theirs) w.onDelta?.(d); });
  // The deadline counts from now, and the socket (streamed text, early wakes)
  // is not waited for: stored events are read by seq whether it opens or not.
  const deadline = w.timeoutS !== undefined ? Date.now() + w.timeoutS * 1000 : Infinity;
  void f.connect();
  const answered = new Set<string>();
  // A read that hangs does not hold the command past its deadline.
  const late = Symbol("late");
  const within = <T>(p: Promise<T>): Promise<T | typeof late> => {
    if (deadline === Infinity) return p;
    let t: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([p, new Promise<typeof late>((r) => { t = setTimeout(() => r(late), Math.max(0, deadline - Date.now())); })]).finally(() => clearTimeout(t));
  };
  try {
    for (;;) {
      const read = await within(f.read());
      if (frozen) break; // the turn this command stays for has ended
      const st = read === late ? late : await within(w.c.get<any>(`/api/cli/state/${w.sessionId}`));
      if (st === late) {
        r.subtype = "timeout";
        r.outcome = null;
        break;
      }
      // Read once more: a turn that ended between the two reads is seen now.
      if (!st.running && st.last_seq > f.seq && (await within(f.read())) === late) {
        r.subtype = "timeout";
        r.outcome = null;
        break;
      }
      const cards = [...st.approvals.map((a: any) => ({ ...a, card: "approval" })), ...st.questions.map((q: any) => ({ ...q, id: q.call_id, card: "question" }))];
      if (cards.length && w.onAsk === "exit") {
        r.subtype = "needs_input";
        r.outcome = "action_required";
        r.pending = cards.length;
        break;
      }
      if (cards.length && w.onAsk === "deny") {
        for (const k of cards) {
          if (answered.has(k.id)) continue;
          answered.add(k.id);
          if (k.card === "approval") await w.c.post(`/api/sessions/${k.session_id}/approvals/${k.id}`, { choice: "deny", reason: "No one can answer here: the run was started with --on-ask deny." }).catch(() => {});
          else await w.c.post(`/api/sessions/${k.session_id}/questions/${k.call_id}`, { answers: {} }).catch(() => {});
          r.refused++;
        }
      }
      const idle = !st.running && st.queue === 0;
      const bg = st.background.agents + st.background.waits + st.background.jobs;
      if (ours && ended && (w.stay === "turn" || (idle && !bg))) break;
      if (!ours && idle && st.queue === 0 && Date.now() - (w.t0 ?? 0) > 30_000) {
        r.errors.push("the prompt never started a turn");
        r.subtype = "error_during_execution";
        break;
      }
      if (Date.now() >= deadline) {
        r.subtype = "timeout";
        r.outcome = null;
        break;
      }
      await f.pause(Math.min(1000, Math.max(50, deadline - Date.now())));
    }
  } finally {
    f.close();
  }
  r.answer = lastAnswer;
  if (r.subtype === "success") r.subtype = r.outcome === "success" ? "success" : r.outcome === "cancelled" ? "cancelled" : "error_during_execution";
  return r;
}

export const exitOf = (w: Watched) =>
  w.subtype === "success" ? EXIT.ok : w.subtype === "needs_input" ? EXIT.owner : w.subtype === "timeout" ? EXIT.timeout : EXIT.error;

export function resultObject(w: Watched, x: { sessionId: string; url: string; ms: number; onAsk: string; replayed?: boolean }) {
  const failed = w.subtype !== "success";
  return {
    type: "result",
    subtype: w.subtype,
    is_error: failed && w.subtype !== "needs_input",
    result: w.answer || (failed ? w.errors.at(-1) ?? "" : ""),
    session_id: x.sessionId,
    num_turns: w.turns,
    duration_ms: x.ms,
    usage: { input_tokens: w.usage.input, output_tokens: w.usage.output, cache_read_input_tokens: w.usage.cache_read, cache_creation_input_tokens: w.usage.cache_write },
    total_cost_usd: w.usage.unpriced ? null : Number(w.usage.cost.toFixed(6)),
    outcome: w.outcome,
    url: x.url,
    on_ask: x.onAsk,
    ...(x.replayed ? { replayed: true } : {}),
    ...(w.subtype === "timeout" ? { timed_out: true } : {}),
    ...(w.pending ? { pending_approvals: w.pending } : {}),
    ...(w.refused ? { refused_approvals: w.refused } : {}),
  };
}

// The daemon for a command that can run without one: the one that answers,
// else one inside this process.
export async function daemonFor(c: Client, found: Found, workspace: string): Promise<{ c: Client; own?: Started }> {
  if (await c.alive()) return { c };
  if (found.from === "flag" || found.from === "env") throw new ApiError(`no daemon answers at ${c.base}`, 0);
  const held = lockedDaemon(found.stateDir);
  if (held) throw new ApiError(`a daemon (pid ${held.pid}) holds ${found.stateDir} but does not answer${held.url ? ` at ${held.url}` : ""}`, 0);
  // Its log lines are not the command's output.
  const log = console.log;
  console.log = (...a: unknown[]) => console.error(...a);
  try {
    const own = await startDaemon({ stateDir: found.stateDir, bind: "127.0.0.1:0", workspace, client: true });
    return { c: new Client(own.url), own };
  } finally {
    console.log = log;
  }
}

export async function runPrompt(v: any, pos: string[], c0: Client, found: Found, name = "run"): Promise<number> {
  const t0 = Date.now();
  const format = v["stream-json"] ? "stream-json" : v["output-format"] ?? (v.print ? (v.json ? "json" : "text") : undefined);
  if (format && !["text", "json", "stream-json"].includes(format)) return usageError(name, `--output-format is text, json or stream-json, not ${format}`, RUN_USAGE);
  const print = !!format;
  const onAskFlag = v["on-ask"];
  if (onAskFlag && !["exit", "deny", "wait"].includes(onAskFlag)) return usageError(name, "--on-ask is exit, deny or wait", RUN_USAGE);
  const timeoutS = v.timeout === undefined ? undefined : Number(v.timeout);
  if (timeoutS !== undefined && !(timeoutS > 0)) return usageError(name, "--timeout is a number of seconds above 0", RUN_USAGE);
  const sessionArg = v.session ?? v.resume;
  if (sessionArg && v.continue) return usageError(name, "pass --session or --continue, not both", RUN_USAGE);
  if (v.steer && v.queue) return usageError(name, "--steer or --queue, not both", RUN_USAGE);

  // The prompt: the argument, or standard input; piped input next to an argument is context.
  let prompt = pos.join(" ").trim();
  const piped = await pipedStdin();
  if (prompt === "-" || !prompt) prompt = (piped ?? "").trim();
  else if (piped?.trim()) prompt = `${prompt}\n\n<stdin>\n${piped.replace(/\s+$/, "")}\n</stdin>`;
  if (!prompt) return usageError(name, "no prompt: give it as the argument or on standard input", RUN_USAGE);

  const cwd = resolve(v.cwd ?? process.cwd());
  const { c, own } = await daemonFor(c0, found, cwd);
  const onAsk = (onAskFlag ?? (own ? "deny" : "exit")) as Watch["onAsk"];
  if (own && onAsk === "exit") {
    await own.stop();
    console.error(`keel ${name}: --on-ask exit leaves a card open for someone to answer, but this command started the daemon itself and it ends with the command; use deny or wait, or start \`keel serve\``);
    return EXIT.error;
  }
  // Without a daemon of its own the session would stop with this process: stay for the turn.
  const stay: "turn" | "all" | null = print ? (v["no-wait-background"] ? "turn" : "all") : v.wait || own ? "turn" : null;
  if (own && !print && !v.wait) console.error(`keel ${name}: no daemon runs; this command runs the session itself until the turn ends`);

  let interrupted: number | null = null;
  let sessionId: string | undefined;
  const onSignal = (code: number) => async () => {
    if (interrupted !== null) process.exit(code);
    interrupted = code;
    if (sessionId) await c.post(`/api/sessions/${sessionId}/interrupt`).catch(() => {});
    await own?.stop().catch(() => {});
    process.exit(code);
  };
  process.on("SIGINT", onSignal(EXIT.sigint));
  process.on("SIGTERM", onSignal(EXIT.sigterm));

  try {
    const files = v.attach?.length ? await promptFiles(c, v.attach) : { images: [], files: [] };
    const sent = await c.post<any>("/api/run", {
      text: prompt,
      images: [...files.images, ...files.files],
      session_id: sessionArg,
      continue: v.continue,
      cwd,
      model: v.model,
      provider: v.provider,
      permission_mode: v["permission-mode"] ?? v.mode,
      effort: v.effort,
      worktree: v.worktree,
      peer: v.peer ?? v.machine,
      idempotency_key: v["idempotency-key"],
      ...(v.queue ? { mode: "queue" } : v.steer ? { mode: "steer" } : {}),
    });
    sessionId = sent.session_id as string;
    const url = (own ? c0 : c).url(sessionId);

    if (!stay) {
      if (v.json) console.log(JSON.stringify({ session_id: sessionId, replayed: !!sent.replayed, url, ...(sent.queued ? { queued: true } : {}) }));
      else {
        console.log(`session ${sessionId}`);
        console.error(`${sent.replayed ? "already sent with this key; " : ""}follow it: keel logs ${sessionId} -f`);
      }
      return EXIT.ok;
    }

    const stream = format === "stream-json";
    if (stream) {
      const st = await c.get<any>(`/api/cli/state/${sessionId}`);
      const perm = await c.get<any>(`/api/sessions/${sessionId}/permissions`).catch(() => null);
      const s = st.session;
      console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, cwd: s.workspace, model: s.model, provider: String(s.model).split(":")[0], permission_mode: perm?.perm?.mode ?? null, keel_version: "bun", url }));
    }
    const partial = stream && v["include-partial-messages"];
    const w = await watch({
      c, sessionId, afterSeq: sent.after_seq, eventId: sent.event_id, queueId: sent.queue_id, prompt, stay, onAsk, timeoutS,
      onEvent: stream ? (e) => console.log(JSON.stringify(streamLine(e))) : undefined,
      onDelta: partial ? (d) => console.log(JSON.stringify({ type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", delta: { type: d.kind === "thinking" ? "thinking_delta" : d.kind === "text" ? "text_delta" : "input_json_delta", text: d.text } } })) : undefined,
      t0,
    });
    if (w.subtype === "timeout" && own) await c.post(`/api/sessions/${sessionId}/interrupt`).catch(() => {});
    if (v.archived) await c.patch(`/api/sessions/${sessionId}`, { archived: true }).catch((e) => console.error(`keel ${name}: the session was not archived: ${e.message}`));
    const res = resultObject(w, { sessionId, url, ms: Date.now() - t0, onAsk, replayed: sent.replayed });

    if (w.refused) console.error(`keel ${name}: refused ${w.refused} approval card${w.refused === 1 ? "" : "s"} or question${w.refused === 1 ? "" : "s"} (--on-ask deny)`);
    if (w.pending) console.error(`keel ${name}: the session waits for the owner (${w.pending} open); answer with keel approve ${sessionId}`);
    if (w.subtype === "timeout") console.error(`keel ${name}: --timeout ran out${own ? "; the turn was stopped" : "; the session keeps running"}`);
    for (const e of w.errors) if (format === "text" || !print) console.error(`keel ${name}: ${clean(e)}`);

    if (stream || format === "json" || (v.json && !print)) console.log(stream ? JSON.stringify(res) : JSON.stringify(res, null, 2));
    else if (print) {
      if (w.answer) out(clean(w.answer) + "\n");
    } else {
      console.log(`session ${sessionId}\noutcome ${w.outcome ?? w.subtype}\nsummary ${JSON.stringify(clean(w.answer))}`);
    }
    return exitOf(w);
  } finally {
    await own?.stop().catch(() => {});
  }
}

const runCmd = command("run", RUN_USAGE, RUN_OPTIONS, runPrompt);
export const run = (argv: string[]) => runCmd(worktreeArg(argv));
