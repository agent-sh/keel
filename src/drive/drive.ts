// Sessions of other harnesses on this machine and the machines the agent view
// links: list them, read them, and send, answer, switch model or resume, with
// the rules that keep a text from landing where it would act instead of being
// read. Routes (the owner) and tools (a model) share this; only tools pass the
// permission gate, since a route call is the owner's own.
import { existsSync } from "node:fs";
import * as av from "./agentview.ts";
import { harnessCommand, outsideText, pickChoice, promptHash, type OutsideText, type Prompt } from "./text.ts";
import { fitTurns, turnsOf, type Turn } from "./transcript.ts";
import { stripAnsi } from "../core/text.ts";

export type State = "working" | "waiting" | "scheduled" | "idle" | "done" | "ended" | "disconnected" | "unknown";
export type Row = {
  id: string;
  name: string;
  kind: string;
  host: string;
  cwd: string;
  model: string;
  state: State;
  live: boolean;
  waiting_on: string | null;
  detail: string | null;
  until_ms: number | null;
  last_activity_ms: number | null;
  transcript: boolean;
  drive: { send: boolean; answer: boolean; model: boolean; resume: boolean };
  changed?: boolean;
};
export type ReadPrompt = Prompt & { hash: string };

export type Code = "INVALID_PARAM" | "NOT_FOUND" | "NOT_SENT" | "NOT_AVAILABLE" | "CHANGED" | "NOT_ANSWERED";
const STATUS: Record<Code, number> = { INVALID_PARAM: 400, NOT_FOUND: 404, NOT_SENT: 409, NOT_AVAILABLE: 409, CHANGED: 409, NOT_ANSWERED: 502 };
export class DriveError extends Error {
  constructor(public code: Code, message: string) {
    super(message);
  }
  get status() {
    return STATUS[this.code];
  }
}
const err = (code: Code, m: string) => new DriveError(code, m);

const epochMs = (v: unknown) => (typeof v === "number" && v > 0 ? Math.round(v * 1000) : null);
const str = (v: unknown) => (typeof v === "string" ? v : "");

// One agent view row in the shape every row of the list has.
export function toRow(raw: av.Raw, here = ""): Row {
  const kind = raw.tool || "agent";
  const live = raw.live === true;
  const stale = raw.stale === true;
  const label = str(raw.label);
  const word = str(raw.state) || label;
  const detail = str(raw.detail) || null;
  const until = epochMs(raw.hold_until);
  let state: State;
  let on: string | null = null;
  if (stale) [state, on] = ["disconnected", str(raw.host_error) || null];
  else if (!live) state = "ended";
  else if (until || str(raw.hold)) [state, on] = ["scheduled", str(raw.hold) || null];
  else if (["waiting", "needs_input", "blocked", "awaiting", "permission", "input", "failed", "errored"].includes(word) || label === "waiting" || label === "failed") [state, on] = ["waiting", detail];
  else if (["working", "busy", "running", "thinking"].includes(word) || label === "working") [state, on] = ["working", detail];
  else if (["done", "completed", "finished"].includes(word) || label === "done") state = "done";
  else if (word === "idle" || label === "idle") state = "idle";
  else if (["stopped", "exited"].includes(word) || label === "ended") state = "ended";
  else [state, on] = ["unknown", detail];
  const has = (k: string) => !!str(raw[k]);
  const job = has("job");
  // An ended session the agent view can bring back: an interactive Claude one
  // (by session), a Codex thread, an agy conversation.
  const resumable = !live && !stale && (kind === "claude" ? has("session") && !job : kind === "codex" ? has("thread") : kind === "agy" && has("session"));
  return {
    id: av.rowId(raw),
    name: str(raw.name) || str(raw.title),
    kind,
    host: str(raw.host) || here,
    cwd: str(raw.cwd),
    model: str(raw.model),
    state,
    live,
    waiting_on: state === "waiting" ? on : null,
    detail: state === "waiting" ? null : on,
    until_ms: state === "scheduled" ? until : null,
    last_activity_ms: epochMs(raw.last) ?? epochMs(raw.t),
    transcript: !str(raw.host) && has("transcript") && existsSync(raw.transcript),
    drive: {
      send: !stale && (live || resumable),
      answer: live && !stale,
      // `/model` sent as a message: not into a background job.
      model: live && !stale && !job,
      resume: resumable,
    },
  };
}

export type Found = { host: string; key: string; raw: av.Raw; row: Row };

const MAX_AGE_MS = 4000; // a list takes seconds; reads within this share one

export class Drive {
  private cache: { at: number; raws: av.Raw[] } | null = null;
  private inflight: Promise<av.Raw[]> | null = null;
  private seen = new Map<string, Map<string, string>>(); // per driver: row id -> fingerprint
  onList?: (rows: Row[]) => void;

  configured(): boolean {
    return !!av.settings().agent_view?.trim();
  }

  // The agent view's rows, shared by every caller within MAX_AGE_MS.
  async raws(maxAge = MAX_AGE_MS): Promise<av.Raw[]> {
    if (this.cache && Date.now() - this.cache.at <= maxAge) return this.cache.raws;
    if (!this.inflight) {
      this.inflight = av.list().then(
        (raws) => {
          this.cache = { at: Date.now(), raws };
          this.inflight = null;
          this.onList?.(raws.map((r) => toRow(r)));
          return raws;
        },
        (e) => {
          this.inflight = null;
          throw e;
        },
      );
    }
    return this.inflight;
  }

  cached(): { at: number; rows: Row[] } | null {
    return this.cache ? { at: this.cache.at, rows: this.cache.raws.filter((r) => (av.KINDS as readonly string[]).includes(r.tool)).map((r) => toRow(r)) } : null;
  }

  async list(maxAge = MAX_AGE_MS): Promise<{ sessions: Row[]; not_listed?: string[] }> {
    try {
      const raws = await this.raws(maxAge);
      return { sessions: raws.filter((r) => (av.KINDS as readonly string[]).includes(r.tool)).map((r) => toRow(r)) };
    } catch (e) {
      return { sessions: [], not_listed: [(e as Error).message] };
    }
  }

  // Marks the rows that are new or different (state, wait, activity, schedule)
  // since this driver's previous list. Kept in memory: the first list after a
  // restart marks every row.
  markChanged(driver: string, rows: Row[]): Row[] {
    const prev = this.seen.get(driver) ?? new Map<string, string>();
    const next = new Map<string, string>();
    const out = rows.map((r) => {
      const f = JSON.stringify([r.state, r.waiting_on, r.last_activity_ms, r.until_ms]);
      next.set(r.id, f);
      return { ...r, changed: prev.get(r.id) !== f };
    });
    this.seen.set(driver, next);
    return out;
  }

  async find(id: string, maxAge = MAX_AGE_MS): Promise<Found> {
    const p = av.parseId(id);
    if (!p) throw err("INVALID_PARAM", `${id} is not an outside session id (<kind>:<key> or <kind>:<host>::<key>, kind claude, codex or agy)`);
    let raws: av.Raw[];
    try {
      raws = await this.raws(maxAge);
    } catch (e) {
      throw err("NOT_AVAILABLE", (e as Error).message);
    }
    const raw = raws.find((r) => av.rowId(r) === id);
    if (!raw) throw err("NOT_FOUND", `no session ${id} is listed by the agent view now`);
    return { host: p.host, key: p.key, raw, row: toRow(raw) };
  }

  async prompt(f: Found): Promise<ReadPrompt | null> {
    const card = await av.rpc(f.host, { op: "attention", key: f.key });
    if (!card || typeof card !== "object" || typeof card.id !== "string") return null;
    const p: Prompt = { id: card.id, kind: str(card.kind) || "prompt", title: str(card.title), body: str(card.body), choices: Array.isArray(card.choices) ? card.choices.map((c: any) => ({ value: String(c?.value ?? ""), label: String(c?.label ?? "") })) : [] };
    return { ...p, hash: promptHash(p) };
  }

  // The agent view's row of a session as it is now (`snapshot` carries what
  // `list` leaves out: the identity, and Claude Code's own state).
  private async freshRow(f: Found): Promise<av.Raw> {
    const snap = await av.rpc(f.host, { op: "snapshot" });
    const row = (snap?.agents ?? []).find((a: av.Raw) => av.nativeKey(a) === f.key && !str(a.host));
    if (!row) throw new Error("the session is no longer listed by the agent view");
    return row;
  }

  // Why a text may not go into the session now: it is live and waits on a
  // prompt, where a text typed in would answer or close the prompt instead of
  // being read. A prompt that cannot be read holds it too. Two things show
  // one: the agent view's `attention` (a recorded permission request, a menu on
  // a tmux screen), and for an interactive Claude Code session wherever it runs
  // (a window whose screen the agent view cannot read), Claude Code's own
  // `waiting` state, written while a dialog is open, unless a status model
  // replaced that state (its `source` is then not Claude Code's).
  async held(f: Found): Promise<string | undefined> {
    if (f.raw.live !== true) return;
    try {
      const p = await this.prompt(f);
      if (p) return `"${f.row.name}" waits on a prompt (request ${p.id}): a text would land in the prompt. Read it and answer it, or send once it is gone`;
    } catch (e) {
      return `whether it waits on a prompt could not be read (${(e as Error).message})`;
    }
    if (f.row.kind !== "claude" || str(f.raw.job)) return;
    try {
      const now = await this.freshRow(f);
      if (now.state === "waiting" && ["", "claude"].includes(str(now.source)))
        return `"${f.row.name}" has a dialog open (Claude Code reports it waiting${str(now.detail) ? `: ${now.detail}` : ""}): a text would land in the dialog. Send once it is idle`;
    } catch (e) {
      return `whether it waits on a prompt could not be read (${(e as Error).message})`;
    }
  }

  // The agent view's identity of the session, checked against what was judged
  // (live included). A row of a linked machine carries it; for one here it is
  // read now. The agent view checks it again before it delivers.
  private async identity(f: Found): Promise<unknown> {
    const id = f.host ? f.raw.remote_identity : (await this.freshRow(f)).remote_identity;
    if (!id || typeof id !== "object") throw new Error("the agent view gave no identity for the session, so it cannot be checked to be the one judged");
    const judged = f.raw.live === true;
    if (!f.host && typeof id.live !== "boolean") throw new Error("the agent view's identity of the session does not say whether it is live");
    if (typeof id.live === "boolean" && id.live !== judged) throw new Error(`the session ${judged ? "ended" : "became live"} since it was checked, so the text was not queued`);
    return id;
  }

  private async enqueue(f: Found, body: OutsideText): Promise<string> {
    let identity: unknown;
    try {
      identity = await this.identity(f);
    } catch (e) {
      throw err("NOT_SENT", (e as Error).message);
    }
    let r: any;
    try {
      r = await av.rpc(f.host, { op: "enqueue", key: f.key, body: body.text, identity });
    } catch (e) {
      throw err("NOT_SENT", (e as Error).message);
    }
    const state = str(r?.state) || "waiting";
    const detail = str(r?.detail);
    const id = str(r?.id);
    const line =
      state === "submitted" ? `Delivered to ${f.row.name}${detail ? `: ${detail}` : ""} (agent view reply ${id}).`
      : state === "waiting" ? `Queued for ${f.row.name} (${id}): it is delivered when the session is ready${detail ? ` (${detail})` : ""}.`
      : state === "failed" ? null
      : `Agent view reply ${id} is ${state}${detail ? `: ${detail}` : ""}.`;
    if (line === null) throw err("NOT_SENT", `the agent view could not deliver it: ${detail}`);
    return line + changedNote(body);
  }

  async read(id: string, opts: { lines?: number; budget: number }): Promise<{ session: Row; turns?: Turn[]; lines?: string[]; prompt: ReadPrompt | null; text: string }> {
    const f = await this.find(id);
    const n = opts.lines ?? 80;
    if (!(n > 0)) throw err("INVALID_PARAM", "lines is above 0");
    let prompt: ReadPrompt | null = null;
    if (f.row.drive.answer) {
      try {
        prompt = await this.prompt(f);
      } catch (e) {
        throw err("NOT_AVAILABLE", (e as Error).message);
      }
    }
    const tail = prompt ? promptText(prompt) : "";
    const head = `${f.row.name} (${f.row.kind} session ${f.row.id}, ${f.row.state}${f.row.model ? `, model ${f.row.model}` : ""}${f.row.cwd ? `, in ${f.row.cwd}` : ""})\n`;
    const room = Math.max(400, opts.budget - head.length - tail.length - 2);
    // The transcript when the agent view names one here (turns read better than
    // a screen and cost less); else the screen or recent activity lines.
    if (f.row.transcript) {
      try {
        const turns = turnsOf(f.row.kind, f.raw.transcript);
        if (turns.length) return { session: f.row, turns: turns.slice(-Math.min(n, 400)), prompt, text: `${head}${fitTurns(turns.slice(-Math.min(n, 400)), room)}${tail ? `\n\n${tail}` : ""}` };
      } catch {
        // an unreadable transcript falls back to the screen
      }
    }
    let lines: string[];
    try {
      const live = await av.rpc(f.host, { op: "live", key: f.key, lines: Math.min(n, 400) });
      lines = (live?.lines ?? []).map((l: unknown) => stripAnsi(String(l)));
    } catch (e) {
      throw err("NOT_AVAILABLE", (e as Error).message);
    }
    return { session: f.row, lines, prompt, text: `${head}${fitLines(lines, room)}${tail ? `\n\n${tail}` : ""}` };
  }

  // A text for a session as it will arrive, and what it is: the owner's alone
  // (`owner` says why) or an ordinary send.
  judgeText(f: Found, raw: string): { body: OutsideText; owner?: string } {
    let body: OutsideText;
    try {
      body = outsideText(raw);
    } catch (e) {
      throw err("INVALID_PARAM", (e as Error).message);
    }
    if (f.raw.live !== true)
      return { body, owner: "the session has ended: the agent view resumes it with this text as a command-line argument of its harness, where a word such as update or mcp runs that subcommand" };
    return { body, owner: harnessCommand(body.text, f.row.kind) };
  }

  // Send a text (or resume an ended session with it). `judged` is the row the
  // gate judged, when a gate did; the text is queued only for that session.
  async send(id: string, text: string, judged?: Found): Promise<string> {
    const f = judged ?? (await this.find(id));
    if (!f.row.drive.send) throw err("NOT_AVAILABLE", `that session is ${f.row.state} and takes no message`);
    const { body } = this.judgeText(f, text);
    const why = await this.held(f);
    if (why) throw err("NOT_SENT", `${why}. Nothing was sent.`);
    return this.enqueue(f, body);
  }

  async model(id: string, model: string, judged?: Found): Promise<string> {
    const f = judged ?? (await this.find(id));
    const name = model.trim();
    if (!name || /\s/.test(name)) throw err("INVALID_PARAM", "model is one model name");
    if (str(f.raw.job)) throw err("NOT_AVAILABLE", "a Claude Code background job takes no model command");
    if (!f.row.drive.model) throw err("NOT_AVAILABLE", `that session is ${f.row.state}; a model command goes only into a live session`);
    const cmd = modelCommand(f.row.kind, name);
    const why = await this.held(f);
    if (why) throw err("NOT_SENT", `${why}. The model was not changed.`);
    // Claude Code, Codex and agy each take `/model <name>` in their composer.
    return `Sent \`${cmd.text}\` to the ${f.row.kind} session.${f.row.kind === "agy" ? " agy also saves it as its default model." : ""} ${await this.enqueue(f, cmd)}`;
  }

  // Answer the open prompt named by request and hash with one of its options.
  async answer(id: string, a: { request: string; hash: string; decision: "allow" | "deny"; choice?: string; note?: string }, judged?: Found): Promise<string> {
    const f = judged ?? (await this.find(id));
    const now = await this.prompt(f).catch((e) => {
      throw err("NOT_AVAILABLE", (e as Error).message);
    });
    if (!now || now.id !== a.request || now.hash !== a.hash) throw err("CHANGED", "the open prompt is not the one that was read (request or hash differ). Nothing was answered; read the session again.");
    let pick;
    try {
      pick = pickChoice(now, a.decision, a.choice);
    } catch (e) {
      throw err("INVALID_PARAM", `${(e as Error).message}. Nothing was answered.`);
    }
    const note = a.note?.trim() ? this.judgeText(f, a.note).body : undefined;
    let res: any;
    try {
      res = await av.rpc(f.host, { op: "answer", key: f.key, id: a.request, choice: pick.value });
    } catch (e) {
      throw err("NOT_ANSWERED", (e as Error).message);
    }
    let line = `Answered ${a.decision} (option ${pick.value} = ${pick.label}) on the prompt of "${f.row.name}": ${typeof res === "string" ? res : "submitted"}.`;
    // The note is queued after the answer and is not held: the prompt it follows is the one just answered.
    if (note) {
      try {
        line += ` Note: ${await this.enqueue(f, note)}`;
      } catch (e) {
        line += ` The note was not sent: ${(e as Error).message}`;
      }
    }
    return line;
  }
}

export function modelCommand(kind: string, model: string): OutsideText {
  let c: OutsideText;
  try {
    c = outsideText(`/model ${model}`);
  } catch {
    c = { text: "", changed: 1 };
  }
  if (c.changed || (kind === "codex" && /\$[A-Za-z0-9_:-]/.test(model))) throw err("INVALID_PARAM", "model is one model name, without control or invisible characters or a $ mention");
  return c;
}

export function promptText(p: ReadPrompt): string {
  const choices = (p.choices ?? []).map((c) => `${c.value} = ${c.label}`).join("; ");
  const body = (p.body ?? "").split("\n").map((l) => `    ${l}`).join("\n");
  return `PENDING ${p.kind ?? "prompt"} request=${p.id} hash=${p.hash}\n  title: ${p.title ?? ""}\n  choices: ${choices}\n  shows:\n${body}`;
}

export function changedNote(b: OutsideText): string {
  if (!b.changed) return "";
  return ` ${b.changed} character${b.changed === 1 ? "" : "s"} that a delivery drops or turns into a line break ${b.changed === 1 ? "was" : "were"} taken out first; the text checked and sent is the one shown.`;
}


function fitLines(lines: string[], budget: number): string {
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i]!.length + 1 > budget) break;
    size += lines[i]!.length + 1;
    kept.push(lines[i]!);
  }
  kept.reverse();
  return (kept.length < lines.length ? `(${lines.length - kept.length} earlier lines not shown; this read's budget was reached)\n` : "") + kept.join("\n");
}
