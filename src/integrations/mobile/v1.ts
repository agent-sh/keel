// Hermes Mobile API v1: the routes the phone app calls. Every route but health
// and pair needs the device's bearer token and a request signature; approvals
// and revoking another device also need the approval key's signature.
import { askId } from "../../helper/ask.ts";
import { holdStream } from "../../server/streams.ts";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename as baseName, isAbsolute, resolve as resolvePath } from "node:path";
import { hostname } from "node:os";
import { basename } from "node:path";
import { ATTACHMENT_MAX, attachmentPath, saveAttachment } from "../../engine/attachments.ts";
import { bodyOf } from "../../mcp/channel.ts";
import { TEXT_MEDIA } from "../../engine/compact.ts";
import { imageType } from "../../engine/images.ts";
import type { Server } from "bun";
import type { ErrorRecord, Session, StoredEvent } from "../../core/types.ts";
import { isOutside, outsideIds } from "../../core/outside.ts";
import { closedWhy, type Approval, type Gate } from "../../safety/gate.ts";
import { cardLines, fromSaid, type CardForm } from "../../safety/card.ts";
import { spelled } from "../../safety/chars.ts";
import type { Deps } from "../../server/app.ts";
import { commandInFront, moveToBackground } from "../../tools/jobs.ts";
import { answer, askedOf, closedQuestions, decline, pendingQuestions, type Answers } from "../../tools/interact.ts";
import * as alerts from "../../automation/alerts.ts";
import * as loops from "../../automation/loops.ts";
import { sessionState } from "../../automation/state.ts";
import { lineOf as nowLineOf, type NowLine } from "../../automation/now.ts";
import { laneOf } from "../../automation/lane.ts";
import { laneText } from "../../automation/lane-line.ts";
import { byChild as agentByChild } from "../../automation/agents.ts";
import { WATCH_LABEL } from "../../core/watch.ts";
import { backgroundOf, dotWord, stateWords } from "../../core/state-words.ts";
import { costLine, costs, rankWaiting, type WaitNow } from "../../core/wait-rank.ts";
import { lineage } from "../../core/tree.ts";
import * as push from "./push.ts";
import {
  answersText, approvalMessage, canonicalMessage, checkAndClaim, loadSpki, PairLimiter, REPLAY_VERSION, requestSource, revokeMessage, sha256Hex,
} from "./sig.ts";
import type { Device, MobileStore, SendRecord } from "./store.ts";
import { typedCodeOf } from "./typed-code.ts";
import { fitted } from "../../engine/image-fit.ts";
import { STORE } from "../../providers/image-limits.ts";
import { Bad, type Checkpoints } from "../../safety/checkpoints.ts";
import type { FileChange } from "../../safety/shadow.ts";
import { readsOf } from "../../server/reads.ts";
import { digestBrief, digestTotals, hms, type Digest } from "../../admin/away.ts";
import { dur } from "../../admin/timeline-rows.ts";
import { newestMark } from "../../admin/marks.ts";
import { liveData, type LiveStatus } from "./live.ts";
import { BACK_MAX, landMessage, type landings } from "./landings.ts";

type Landings = ReturnType<typeof landings>;
import { zoneLabel } from "../../core/clock.ts";
import type { Helper } from "../../helper/helper.ts";
import { paramKey } from "../../helper/memory.ts";
import type { MemoryRecord } from "../../helper/records.ts";
import { decidePlan, plansEnded, plansWaiting, type PlanCard, type PlanEnd } from "../../server/routes/plan.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const err = (error: string, status: number) => json({ error }, status);
const BODY_LIMIT = 1 << 20;
const SYNC_PAGE = 2000;
// The event kinds a phone message can come from (messageOf).
const SHOWN_KINDS = ["user", "assistant", "turn_end", "error"];
const secs = (ms: number) => ms / 1000;
const nowSecs = () => Math.floor(Date.now() / 1000);
const host = () => process.env.KEEL_HOST_NAME || hostname() || "keel-host";

type Req = Request & { params: Record<string, string> };
type Signed = (req: Req, dev: Device, body: Uint8Array, srv: Server<unknown>) => Response | Promise<Response>;

// Modes where a tool call may run without asking. A phone without a screen lock
// may be in anyone's hand: it cannot prompt a session in one of them.
const UNASKED = new Set(["auto-edits", "auto", "full-auto"]);

// `checkpoints`: what each turn changed in the session's folder (src/safety/checkpoints.ts), for the
// phone's Changes; absent where no checkpoints are kept.
// What the phone's start sheet offers: the folders this machine's sessions worked in, newest first,
// at most this many (the daemon's own folder always among them).
const START_FOLDERS = 12;
// The open errors the phone lists: the page's Errors panel reads as many (src/server/routes/errors.ts).
const ERRORS_LISTED = 200;

export type MobileCtx = Deps & {
  mobile: MobileStore; gate: () => Gate | undefined; changed: () => void; checkpoints?: () => Checkpoints | undefined;
  // The fleet, where the daemon has one: its machines, and a session started on one of them.
  fleetMachines?: () => Promise<any[]>; startFleetSession?: (b: any) => Promise<Response>;
  // The digest of the owner's last absence and its dismissal (src/server/routes/overview.ts), and the
  // owner seen this long ago (the phone in use ends an absence, as a page in use does).
  away?: () => Digest | null; awaySeen?: () => void; ownerSeen?: (idleMs: number) => void;
  // The search across sessions (src/server/routes/search.ts), asked as the page asks it.
  search?: (req: Request) => Promise<Response>;
  // The lasting notification's status (src/integrations/mobile/live.ts): the background check reads it in the pulse.
  live?: () => LiveStatus;
  // The owner's helper (src/helper/), on a daemon that runs one.
  helper?: () => Helper | null;
  // Branches that wait to land, as cards the owner decides from (src/integrations/mobile/landings.ts).
  landings?: Landings;
};

// How many of what the helper was told the phone is sent, the newest first: a screen of them.
const HELPER_EVENTS = 20;

// The helper as the phone shows it: whether it is on, its conversation, what it was told lately
// and how many records its memory holds.
export function helperOf(h: Helper) {
  const v = h.view();
  return {
    on: v.on, chat_id: v.session_id, memory: h.records.index.size,
    // The name the owner gave it, and the mark of its picture (`face`: GET /v1/helper/face; absent while it has none).
    name: h.name(), ...(h.persona().avatar ? { face: h.persona().avatar!.v } : {}),
    events: v.events.slice(-HELPER_EVENTS).reverse().map((e) => ({ id: e.id, ts: secs(e.ts), chat_id: e.session_id, title: e.title, body: e.body })),
  };
}
// An answer of the helper to a question from the app's helper row (src/helper/ask.ts), as the app shows it:
// its words, the sessions it read with what each waits on the owner for (an approval or a question: the
// row offers Answer there, else Open), and what else it looked at.
export function helperAnswerOf(a: NonNullable<Awaited<ReturnType<Helper["answer"]>>>) {
  return {
    id: a.id, chat_id: a.chat_id, state: a.state, question: a.question, text: a.text, ts: secs(a.ts), looked: a.looked,
    read: a.read.map((r) => ({ chat_id: r.id, title: r.title || "(untitled)", waits: a.waits[r.id] ?? 0 })),
  };
}
// How many records the whole memory sends at a time, the newest first, as many as a find answers
// with; `total` says how many there are, and the words narrow it from there.
const MEMORY_PAGE = 200;
const recordOf = (m: MemoryRecord) => ({ key: m.key, value: m.value, topics: m.topics, updated: secs(m.updated) });

// How many hits the phone is sent: a screen and a half of them; the words narrow it from there.
const SEARCH_HITS = 30;

// The digest as the phone shows it: the span and the totals in words, what the daemon went through,
// and each session's facts with the part that went wrong apart, as the page's digest says them.
export function awayOf(d: Digest) {
  const many = d.spans.length > 1;
  const at = (ts: number) => hms(ts, d.as_of);
  const z = zoneLabel(d.as_of);
  const span = d.present
    ? `While you were away, ${many ? `${d.spans.length} times between ${at(d.from)} and ${at(d.to)} ${z} (${dur(d.away_ms)} in all)` : `${at(d.from)} to ${at(d.to)} ${z} (${dur(d.away_ms)})`}`
    : `While you are away, since ${at(d.from)} ${z} (${dur(d.away_ms)})`;
  return {
    span, brief: digestBrief(d), totals: digestTotals(d), daemon: d.daemon, present: d.present, from: secs(d.from), to: secs(d.to),
    failed: d.totals.failed + (d.totals.agents.failed ?? 0), waiting: d.totals.approvals + d.totals.questions, quiet: d.quiet,
    sessions: d.sessions.map((r) => ({ chat_id: r.id, title: r.title, state: WATCH_LABEL[r.watch], watch: r.watch, text: r.text, ...(r.bad ? { bad: r.bad } : {}) })),
  };
}

const urlOrigin = (u: string) => { try { return new URL(u).origin; } catch { return null; } };

// The link the phone app opens: `keel://pair` for the Keel app, `hermes://pair`
// for a phone still on the Hermes app (the same /v1 surface answers both).
export type PairApp = "keel" | "hermes";
export function pairLink(base: string, code: string, app: PairApp = "keel") {
  const q = new URLSearchParams({ u: base.replace(/\/+$/, ""), c: code, n: host() });
  return `${app}://pair?${q.toString().replace(/\+/g, "%20")}`;
}

// --- shapes the app reads ---------------------------------------------------------

// The chat's newest message on its shown branch, for the inbox line: the app
// keeps a preview the server sends over one it guesses from a batch of messages.

// The longest action line a row carries: a row says one line, and the phone cuts it to its width.
const ACTION_CHARS = 160;
// The longest command a phone is shown: a line, cut to the screen's width there.
const COMMAND_CHARS = 200;

// Where a chat stands, as the phone's list shows it: a card waits for the
// owner, a turn runs or its agents still work (agents: how many), or how the
// last turn ended.
export type ChatStatus = "needs_you" | "working" | "failed" | "stopped" | "done" | "idle";
export type ChatExtra = { unread?: number; preview?: { text: string; role: string; id: string } | null; status?: ChatStatus; failure?: string; agents?: number; state_word?: string; dot?: string; dot_ring?: string; dot_word?: string; action?: string; now?: NowLine | null };

export function chatOf(s: Session, lastSeq = 0, x: ChatExtra = {}) {
  const c: Record<string, unknown> = {
    id: s.id, title: s.title || "New chat", kind: "chat", created: secs(s.created), updated: secs(s.updated), unread: x.unread ?? 0,
    pinned: s.settings.pinned_ms ? 1 : 0, archived: s.archived ? 1 : 0, seq: lastSeq, parent_id: s.parent_id ?? null,
  };
  // The owner's helper: the phone lists it above the sessions.
  if (s.settings.helper) c.helper = 1;
  if (x.status) c.status = x.status;
  // The state in the workbench's own words ("Waiting for a timer", "Declined", "Working: command in
  // background"), beside the six statuses above, which stay as they are: an app that knows the field shows it.
  if (x.state_word) c.state_word = x.state_word;
  // The row's dot, as the workbench draws it (ui/src/bridge.css .k-mark): the state's own name (`dot`: need, work, wait, fail,
  // declined, resume, stop, done, idle: declined is a failure the model gave nothing for, wait is a half dot), the ring
  // around the dot of a session that only waits on what it left going (`dot_ring`: agents or command), and the dot's word
  // for a reader (`dot_word`). The six statuses above lose the difference between these.
  if (x.dot) c.dot = x.dot;
  if (x.dot_ring) c.dot_ring = x.dot_ring;
  if (x.dot_word) c.dot_word = x.dot_word;
  // What the session's own turn does now, in the page's words for it ("Editing src/a.ts", "Waiting for a timer"): the line the
  // page's status block shows over the box. Only while it works or waits; a session at rest says its state, not an action.
  if (x.action) c.action = x.action;
  if (x.failure) c.failure = x.failure;
  if (x.agents) c.agents = x.agents;
  // A live agent's "now" line, flat: what it is doing, its steps, when its task began, its spend, whether it needs the owner.
  if (x.now) Object.assign(c, { now: x.now.text, now_steps: x.now.steps, now_since: secs(x.now.since), now_usd: Math.round(x.now.usd * 10_000) / 10_000, now_need: x.now.need ? 1 : 0 });
  if (x.preview !== undefined) Object.assign(c, { preview: x.preview?.text ?? "", last_role: x.preview?.role ?? "", preview_id: x.preview?.id ?? null });
  // The row's own mark: the same row, the same mark. A phone that says what it holds by these marks
  // is sent only the rows of the buckets that changed (syncBody's `held`).
  c.h = rowMark(c);
  return c;
}

// Eight hex digits of the row's content (its `h` left out): a phone's copy is level when the marks match.
export const rowMark = (row: Record<string, unknown>) => {
  const { h: _, ...rest } = row;
  return (Bun.hash(JSON.stringify(rest)) & 0xffffffffn).toString(16).padStart(8, "0");
};

// What a reconnecting phone holds, said in a bounded number of bytes: its rows are put in `n` buckets
// by their ids, and each bucket is said by one digest of its rows' marks. The daemon sends the rows of
// each bucket whose digest differs from its own, and names those buckets, so the phone drops what it
// holds there that was not sent (a session deleted meanwhile). The phone picks `n`; the digests travel
// as `held=<8 hex>.<8 hex>...` in the stream's query, nine bytes a bucket whatever the rows hold.
export const MAX_BUCKETS = 256;
// FNV-1a, 32 bits, over the UTF-8 bytes (Wire.kt makes the same number).
export function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(s, "utf8")) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h;
}
export const bucketOf = (id: string, n: number) => fnv(id) % n;
// A bucket's digest is the sum of its rows' `<id>:<mark>` hashes (mod 2^32): the order of the rows does not count.
export function digests(rows: { id: string; h: string }[], n: number): number[] {
  const d = new Array<number>(n).fill(0);
  for (const r of rows) { const b = bucketOf(r.id, n); d[b] = (d[b]! + fnv(`${r.id}:${r.h}`)) >>> 0; }
  return d;
}
export const heldOf = (rows: { id: string; h: string }[], n: number) => digests(rows, n).map((x) => x.toString(16).padStart(8, "0")).join(".");
// Null for none given or one that is not of the form (an app that does not send it is sent every row).
export function parseHeld(v: string | null): number[] | null {
  if (!v) return null;
  const parts = v.split(".");
  if (parts.length > MAX_BUCKETS || parts.some((p) => !/^[0-9a-f]{8}$/.test(p))) return null;
  return parts.map((p) => parseInt(p, 16));
}

// How a turn that did not finish ended, as the workbench says it.
const OUTCOME: Record<string, string> = {
  interrupted: "Stopped before the reply finished", restart: "Cut by a daemon restart", max_tokens: "Cut at the output limit",
  max_steps: "Stopped at the step budget", budget: "Stopped at the agent's budget", refusal: "Declined",
};
const NORMAL_STOP = new Set(["end_turn", "tool_use", "stop_sequence", undefined, null]);

// Input the harness put in a conversation: whose it is and a label for it.
type Origin = { origin: string; label: string; text: string; meta?: Record<string, unknown> };
const unesc = (t: string) => t.replace(/&lt;/g, "<");
// The failure notice an input carries (src/automation/failures.ts), alone or
// with another input: `section` is its entries and the lines after them, out
// of their frame; `rest` is the input without it. Only where the input's meta
// says it holds one, and the last one in the text: the notice goes after what
// it comes with, so a report that quotes one is not taken for it.
function failuresIn(text: string, d: any): { section: string; rest: string } {
  const has = d.kind === "failures" || ((d.parts ?? []) as any[]).some((p) => p?.kind === "failures");
  const m = has ? [...text.matchAll(/\[harness\] Failures in this session's work[^\n]*\n<failures>\n([\s\S]*?)\n<\/failures>((?:\n(?!\n)[^\n]*)*)/g)].at(-1) : undefined;
  if (!m) return { section: "", rest: text };
  return { section: `**Failures, grouped by cause**\n\n${unesc(m[1]!)}${m[2]}`, rest: (text.slice(0, m.index) + text.slice(m.index! + m[0].length)).trim() };
}
const joined = (...parts: string[]) => parts.filter(Boolean).join("\n\n");
function wakeOf(text: string, d: any): Origin {
  const ws = [...text.matchAll(/<wait_fired id="[^"]*" kind="([^"]*)" outcome="([^"]*)">\n?([\s\S]*?)\n?<\/wait_fired>|<monitor_event id="[^"]*" batch="(\d+)"[^>]*>\n?([\s\S]*?)<\/monitor_event>/g)];
  const label = ws.map((m) => (m[4] ? `monitor event ${m[4]}` : m[2] === "fired" ? `${m[1]} fired` : m[2] === "timeout" ? `${m[1]} timed out` : `${m[1]} ${m[2]}`)).join(", ");
  const body = ws.map((m) => unesc((m[4] ? m[5] : m[3]) ?? "").trimEnd()).join("\n\n");
  return { origin: "wait", label: `Woken: ${label || "a wait ended"}`, text: body || text, meta: { wait_id: d.wait_id ?? null } };
}
function originOf(e: StoredEvent, titleOf: (sid: string) => string | undefined, parentOf: (sid: string) => string | null): Origin | null {
  const d = e.data ?? {};
  const text = String(d.text ?? "");
  if (d.origin === "harness" || d.origin === "restart" || d.kind === "harness") return { origin: "harness", label: "", text: text.replace(/^\[harness\]\s*/, "") };
  // A failure notice that came with another input: that input as it reads by
  // itself (a report, a wake, a loop run), then the notice.
  const f = failuresIn(text, d);
  const others = ((d.parts ?? []) as any[]).filter((p) => p?.kind !== "failures");
  if (f.section && others.length) {
    const kinds = new Set(others.map((p) => p.kind));
    const data = others.length === 1 ? { ...others[0], text: f.rest } : { ...d, kind: kinds.size === 1 ? others[0].kind : "wake", parts: others, text: f.rest };
    const o = originOf({ ...e, data }, titleOf, parentOf) ?? { origin: "harness", label: "", text: f.rest };
    return { ...o, text: joined(o.text, f.section) };
  }
  switch (d.kind) {
    case "subagent": case "wake": {
      const reps = [...text.matchAll(/<subagent_result agent_id="([^"]*)" title="([^"]*)" status="([^"]*)">\n?([\s\S]*?)\n?<\/subagent_result>/g)];
      if (reps.length) {
        const body = reps.map((m) => `**Report from ${unesc(m[2]!)}** (${m[3]})\n\n${unesc(m[4]!)}`).join("\n\n");
        return { origin: "subagent", label: "", text: body, meta: { agent_id: d.agent_id ?? reps[0]![1], agent_ids: reps.map((m) => m[1]) } };
      }
      if (d.kind === "subagent") return { origin: "subagent", label: "Agent report", text, meta: { agent_id: d.agent_id ?? null } };
      return wakeOf(text, d);
    }
    case "wait": return wakeOf(text, d);
    case "failures": return { origin: "harness", label: "", text: f.section || text.replace(/^\[harness\]\s*/, "") };
    case "loop": return { origin: "loop", label: `Loop run${d.loop_name ? `: ${d.loop_name}` : ""}`, text, meta: { loop_id: d.loop_id ?? null } };
    case "goal": return { origin: "goal", label: d.goal === "start" ? "Goal set" : d.goal === "resume" ? "Goal resumed" : "Goal not met yet: next turn", text: text.replace(/^\[harness\]\s*/, "") };
    case "task": {
      const pid = parentOf(e.session_id);
      const task = text.includes("Task:\n") ? text.slice(text.lastIndexOf("Task:\n") + 6) : text;
      return { origin: "task", label: `Task from ${(pid && titleOf(pid)) || "the parent session"}`, text: task, meta: { parent_id: pid, agent_id: d.agent_id ?? null } };
    }
    case "steer": {
      const pid = parentOf(e.session_id);
      return { origin: "parent", label: `Message from ${(pid && titleOf(pid)) || "the parent session"}`, text, meta: { parent_id: pid, agent_id: d.agent_id ?? null } };
    }
    case "peer": return { origin: "peer", label: "Message from another session", text, meta: { from: d.from ?? null, message_id: d.message_id ?? null } };
    case "channel": return { origin: "channel", label: `Event from ${d.source ?? "a connected source"}`, text: bodyOf(text), meta: { source: d.source ?? null, event_id: d.event_id ?? null } };
  }
  if (text.startsWith('<external_input source="peer_session"')) return { origin: "peer", label: "Message from another session", text };
  return null;
}

// What a prompt carried, as the app shows it: a photo fetched from /v1/media
// (stored inline in the prompt, so its id names the event and its place), a
// file by its stored id.
const PROMPT_IMAGE = /^img-(\d+)-(.+)$/;
// The image types a model reads inline. A file that claims one of them and is
// not one by its bytes is stored as plain bytes.
const INLINE_IMAGES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
// The type a phone's file is stored under. What the daemon acts on is decided
// by the bytes: an image the model sees, a PDF it may read as a document. A
// claim is kept only when it is a well-formed type of text (the file is then
// tried as text); anything else, a claim with control characters or a type
// nothing here acts on included, is plain bytes.
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/;
export function uploadType(bytes: Uint8Array, claim: string): string {
  const image = imageType(bytes);
  if (image) return image;
  if (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-") return "application/pdf";
  const type = claim.split(";")[0]!.trim().toLowerCase();
  return MIME.test(type) && type !== "application/pdf" && !type.startsWith("image/") && TEXT_MEDIA.test(type) ? type : "application/octet-stream";
}
// A send id of the phone's own making: at most this long. A longer one is
// refused, never cut (two that differ later would be one).
const CLIENT_ID_MAX = 200;
function promptFiles(e: StoredEvent) {
  return ((e.data.images ?? []) as any[]).map((b, i) => b.type === "image"
    ? { kind: "image", media: `img-${i}-${e.id}`, mime: b.media_type }
    : { kind: "file", media: b.id, mime: b.media_type, file_name: b.name, size: b.size });
}

export type MessageCtx = { titleOf?: (sid: string) => string | undefined; parentOf?: (sid: string) => string | null };

// One stored event as the app's message, or null for what the app does not show.
// The owner's words are role "user"; everything else, input the harness put in
// the conversation included, is the agent's side with its origin in meta. A
// turn that did not finish leaves a status line; the reply text stays as it was.
// `ts` carries the event's place in its session below the millisecond, so two
// events stored in the same millisecond keep their order wherever the app sorts.
export function messageOf(e: StoredEvent, gseq: number, ctx: MessageCtx = {}) {
  const ts = (e.ts + (e.seq % 1000) / 1000) / 1000;
  // A queued prompt keeps the id of its queue receipt, so the app's QUEUED row
  // becomes the committed message instead of staying beside it.
  const base = { id: e.kind === "user" && e.data.queue_id ? String(e.data.queue_id) : e.id, chat_id: e.session_id, kind: "text", meta: {} as Record<string, unknown>, ts, seq: gseq };
  if (e.kind === "user") {
    const o = originOf(e, ctx.titleOf ?? (() => undefined), ctx.parentOf ?? (() => null));
    if (!o) return { ...base, role: "user", content: String(e.data.text ?? ""), meta: e.data.images?.length ? { images: e.data.images.length, attachments: promptFiles(e) } : {} };
    if (o.origin === "harness" || o.origin === "goal") return { ...base, role: "agent", kind: "status", content: o.label ? `${o.label}: ${o.text}` : o.text, meta: { origin: o.origin } };
    return { ...base, role: "agent", content: o.label ? `**${o.label}**\n\n${o.text}` : o.text, meta: { origin: o.origin, ...o.meta } };
  }
  if (e.kind === "assistant") {
    const text = ((e.data.blocks ?? []) as any[]).filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim();
    if (!text) return null;
    const meta: Record<string, unknown> = {};
    if (e.data.model) meta.model = e.data.model;
    if (!NORMAL_STOP.has(e.data.stop)) meta.stop = e.data.stop;
    return { ...base, role: "agent", content: text, meta };
  }
  if (e.kind === "turn_end" && OUTCOME[e.data.reason]) return { ...base, role: "agent", kind: "status", content: OUTCOME[e.data.reason]!, meta: { outcome: e.data.reason } };
  if (e.kind === "error") return { ...base, role: "agent", kind: "status", content: `Failed: ${String(e.data.message ?? "the turn failed")}`, meta: { outcome: "error" } };
  return null;
}

// The tool calls of one model reply as the app's trace row: what ran, one line
// each. Its own message beside the reply's words, just after them.
export function traceOf(e: StoredEvent, gseq: number) {
  if (e.kind !== "assistant") return null;
  const steps = ((e.data.blocks ?? []) as any[]).filter((b) => b.type === "tool_use").map((b) => ({ tool: String(b.name), what: stepWhat(b.input) ?? "" }));
  if (!steps.length) return null;
  const ts = (e.ts + (e.seq % 1000) / 1000 + 0.0005) / 1000;
  return { id: `${e.id}.tools`, chat_id: e.session_id, role: "agent", kind: "trace", content: steps.map((x) => x.tool).join(", "), meta: { steps }, ts, seq: gseq };
}

const STATE: Record<string, string> = { pending: "pending", allowed: "approved", denied: "denied", cancelled: "expired" };

// A permission card. `command` and `description` are what an app from before
// the read-first rule shows (the summary, each hidden character written out).
// `form`, for a card that waits, adds what the rule needs, read from the one
// form every client gets (src/safety/card.ts), ready for a screen that draws
// plain text:
// - `text`: the whole text to judge (the command, the paths and what the edit
//   writes, the tool's input), each hidden character written as its code point;
// - `notes`: why it is asked, where it runs when not here, what in the text can
//   mislead, and that only its start is kept (`cut`, with `total` when known);
// - `rtl`: it holds letters written right to left (the app keeps each run in place);
// - `hold`: why Allow needs the text shown whole first (empty: one line shows
//   all of it);
// - `at`: for a chained command, where in `text` the part that asked stands, [from, to): the app marks it;
// - `line` and `glance`: what a notification says of it, and whether that line
//   shows all of it within a collapsed notification (only then may one carry
//   Allow once; a notification never gives a standing answer);
// - `grants`: the rules a standing answer would store. The session action's
//   label names them, and so does the app's button: never a bare "Allow for
//   session". Offered only where there is a rule to grant.
// The app sends `seen: "whole"` with an allow once all of `text` was on its
// screen; without it the answer to a held card is a 409 with the sentence to
// show, and the card stays open. A closed card says where it was answered (`from`).
export function approvalOf(a: Approval, form?: CardForm) {
  const l = form && a.state === "pending" ? cardLines(form) : undefined;
  const actions: string[][] = [["Approve", "once", "primary"]];
  // (Without the form, a closed card or a caller that has none, the action is as it was.)
  if (form && l ? form.grants.length : a.risk !== "high") actions.push([form && l ? `Allow ${form.grants.join(", ")} for this session` : "This session", "session", ""]);
  actions.push(["Deny", "deny", "danger"]);
  return {
    id: a.id, chat_id: a.session_id, session_key: a.session_id, kind: "permission",
    command: spelled(a.summary), description: [a.why, a.notice].filter(Boolean).length ? `${spelled(a.tool, "")}: ${[a.why, a.notice].filter(Boolean).join(". ")}` : spelled(a.tool, ""),
    actions, state: STATE[a.state] ?? a.state, choice: a.choice ?? null, ts: secs(a.created),
    ...(a.by ? { from: fromSaid(a.by) } : {}),
    ...(form && l ? {
      text: l.text, notes: l.notes, cut: !!form.cut, total: form.total ?? null, lines: form.lines, chars: form.chars,
      risk: form.risk, rtl: form.marks.rtl, machine: form.machine?.far ? form.machine.name : "", hold: form.hold,
      line: form.line, glance: form.glance, grants: form.grants, ...(l.at ? { at: l.at } : {}),
    } : {}),
  };
}

// A plan the model presents in plan mode, as a card: its title, the whole plan to read
// (`text`, `lines`), and the ways on. Approve starts the work in a mode: "session" in auto
// edits (edits inside the folder run, commands ask), "once" in ask (every change asks: what a
// phone with no screen lock may start). "deny" sends it back to planning, with `feedback` (what
// to change) when the owner wrote one. A plan is approved only once all of it was on the
// screen (`hold`; the app says `seen: "whole"`), and with the approval key, as any allow.
const PLAN_STATE = { approved: "approved", denied: "denied", expired: "expired" } as const;
// A plan's card id names its session too: a plan is known by its tool call's id, and two sessions'
// calls may share one (a card that closed in one must never hide the other's that waits).
export const planCardId = (sessionId: string, planId: string) => `plan-${sessionId}.${planId}`;
export function planCardOf(c: PlanCard, end?: PlanEnd) {
  return {
    id: planCardId(c.session_id, c.id), chat_id: c.session_id, session_key: c.session_id, kind: "plan",
    command: c.title || "The model's plan", description: "Approve it to start the work, or keep planning.",
    text: c.plan, lines: c.plan.split("\n").length, notes: [], hold: end ? [] : ["plan"],
    actions: end ? [] : [["Approve: edits run", "session", "primary"], ["Approve: each change asks", "once", ""], ["Keep planning", "deny", "danger"]],
    state: end ? PLAN_STATE[end.how] : "pending", choice: end?.how === "approved" ? (end.mode === "ask" ? "once" : "session") : end ? "deny" : null,
    ts: secs(c.created),
  };
}

// A changed file as the phone lists it: its path, how it changed (git's letter: A, M, D, T), the lines
// added and removed, and whether it was written outside the session's turns.
const fileOf = (f: FileChange) => ({ path: f.path, status: f.status, added: f.added, removed: f.removed, ...(f.outside ? { outside: true } : {}) });

// The card's place in the chat. It carries the card's state, so a chat read
// after the card closed never offers a decision on it.
const approvalMsg = (a: { id: string; chat_id: string; kind: string; command: string; description: string; state: string; ts: number | null }) => ({
  id: `apr-${a.id}`, chat_id: a.chat_id, role: "agent", kind: "approval", content: a.description,
  meta: { approval_id: a.id, card: a.kind, command: a.command, description: a.description, state: a.state }, ts: a.ts ?? secs(Date.now()), seq: 0,
});

export function mobileApi(ctx: MobileCtx) {
  const { store, bus, engine, providers, errors, mobile } = ctx;
  // A session another harness runs is only shown in Keel (src/core/outside.ts): the phone gets nothing of it,
  // not its row, its messages, its questions or its state. Every read of a session here is through these.
  const sessionShown = (sid: string) => { const s = store.session(sid); return s && !isOutside(s) ? s : undefined; };
  const sessionsShown = (o?: { archived?: boolean }) => store.sessions(o).filter((s) => !isOutside(s));
  const limiter = new PairLimiter();
  const lastSeq = (sid: string) => store.db.query<{ n: number | null }, [string]>("SELECT MAX(seq) AS n FROM events WHERE session_id = ?").get(sid)!.n ?? 0;
  const allSessions = () => [...sessionsShown(), ...sessionsShown({ archived: true })];
  // When the running turn started: the phone's elapsed timer counts from it,
  // whatever the turn stored since.
  // A turn that has not stored its start yet (the session just went working)
  // starts now, not at the previous turn's start.
  // (Each is one seek of the turn index: this runs for every working session at each hello.)
  const turnBounds = (sid: string) => ({ st: newestMark(store, sid, "turn_start"), en: newestMark(store, sid, "turn_end") });
  const since = (s: Session) => { const b = turnBounds(s.id); return secs(b.st !== null && (b.en === null || b.st > b.en) ? b.st : s.updated); };
  const working = () => sessionsShown().filter((s) => engine.isRunning(s.id)).map((s) => ({ chat_id: s.id, since: since(s) }));
  const msgCtx: MessageCtx = { titleOf: (sid) => sessionShown(sid)?.title, parentOf: (sid) => sessionShown(sid)?.parent_id ?? null };
  const toMsg = (e: StoredEvent, gseq: number) => messageOf(e, gseq, msgCtx);
  // Everything one event shows on the phone: its words, then its tool calls.
  const msgsOf = (e: StoredEvent, gseq: number): any[] => [toMsg(e, gseq), traceOf(e, gseq)].filter(Boolean);
  // The newest message of the shown branch, walking back from the head.
  function preview(s: Session): ChatExtra["preview"] {
    let id = s.head;
    for (let i = 0; id && i < 200; i++) {
      const e = store.event(id);
      if (!e) break;
      const m = toMsg(e, 0);
      if (m && m.kind !== "status") return { text: m.content.split("\n").map((l: string) => l.replace(/[*_`#>]/g, "").trim()).find(Boolean)?.slice(0, 200) ?? "", role: m.role, id: m.id };
      id = e.parent;
    }
    return null;
  }
  // The newest messages of a chat's shown branch, walking back from its head:
  // what a phone starting from nothing gets per chat. The rest comes by paging.
  const FIRST_PAGE = 40;
  // The whole state is as large as what the phone shows, not as the store: a
  // chat's row is what its list shows, and the app reads a chat's page when it
  // is opened. Messages go only as a head start for the chats the owner opens
  // first, the most recently updated ones that are not archived: ten, about
  // one screen of the phone's list.
  const FIRST_CHATS = 10;
  const RESET_PAGE = new URLSearchParams({ paged: "1", limit: String(FIRST_PAGE) });
  // The words each running turn has streamed since its last stored step, for
  // a phone that connects (or recovers) in the middle of a reply.
  const drafts = new Map<string, string>();
  bus.on((f) => {
    if (f.t === "delta" && f.kind === "text") drafts.set(f.session_id, (drafts.get(f.session_id) ?? "") + f.text);
    else if (f.t === "event" && (f.event.kind === "assistant" || f.event.kind === "turn_end")) drafts.delete(f.event.session_id);
    else if (f.t === "status" && f.status.kind === "retry") drafts.delete(f.session_id);
    else if (f.t === "session" && f.deleted) drafts.delete(f.session.id);
  });
  function recent(s: Session) {
    const out: any[] = [];
    let id = s.head;
    for (let i = 0; id && i < FIRST_PAGE * 10 && out.length < FIRST_PAGE; i++) {
      const e = store.event(id);
      if (!e) break;
      out.unshift(...msgsOf(e, mobile.gseqOf(e.id)));
      id = e.parent;
    }
    return out;
  }
  const unread = () => { try { return alerts.unreadCounts().sessions; } catch { return {} as Record<string, number>; } };
  // How the last turn on the shown branch ended, walking back from the head.
  // A failed turn says why, in a line.
  function status(s: Session): { status: ChatStatus; state_word: string; dot: string; dot_ring?: string; dot_word: string; action?: string; failure?: string; agents?: number } {
    const told = statusOf(s);
    const ring = backgroundOf(told.st);
    // The words without a clock ("stalled for 3m" is the page's tooltip): the row is sent when its facts change, not each minute.
    const action = told.st.watch === "work" || told.st.watch === "wait" || told.st.watch === "resume" ? (told.st.brief ?? told.st.text ?? "").trim().slice(0, ACTION_CHARS) : "";
    return { ...told.is, state_word: stateWords(told.st).phrase, dot: told.st.watch, ...(ring ? { dot_ring: ring } : {}), dot_word: dotWord(told.st), ...(action ? { action } : {}) };
  }
  function statusOf(s: Session): { st: ReturnType<typeof sessionState>; is: { status: ChatStatus; failure?: string; agents?: number } } {
    // The end of the shown branch, back to the owner's last prompt: how its last turn ended.
    const tail: StoredEvent[] = [];
    for (let id = s.head, i = 0; id && i < 200; i++) {
      const e = store.event(id);
      if (!e) break;
      tail.unshift(e);
      if (e.kind === "user" && !originOf(e, () => undefined, () => null)) break;
      id = e.parent;
    }
    const st = sessionState(s, { from: { store, engine }, events: tail });
    const agents = st.agents ? { agents: st.agents } : {};
    // The phone's words for the one state: what waits on the owner (a card, a question, a plan),
    // then what moves by itself (a running turn, agents, a wait that will wake it).
    if (st.watch === "need") return { st, is: { status: "needs_you", ...agents } };
    // A turn a restart cut is about to go on: it moves by itself too.
    if (st.watch === "work" || st.watch === "wait" || st.watch === "resume" || engine.isRunning(s.id)) return { st: engine.isRunning(s.id) && !["work", "wait", "resume"].includes(st.watch) ? { ...st, watch: "work" } : st, is: { status: "working", ...agents } };
    // How the last turn ended is the same fact the page shows: failed or declined with the reason, stopped, done.
    if (st.watch === "fail" || st.watch === "declined") {
      const said = String(tail.findLast((e) => e.kind === "error")?.data.message ?? "").split("\n")[0];
      return { st, is: { status: "failed", failure: (st.text || said || WATCH_LABEL[st.watch]).slice(0, 200) } };
    }
    if (st.watch === "stop") return { st, is: { status: "stopped" } };
    return { st, is: { status: st.watch === "done" ? "done" : "idle" } };
  }
  const chatFull = (s: Session, u = unread()) => chatOf(s, lastSeq(s.id), { unread: u[s.id] ?? 0, preview: preview(s), ...status(s), ...(s.parent_id ? { now: nowLineOf(s.id) } : {}) });

  // Questions the model asked that wait for the owner, as approval cards. Each
  // pending call is read from its own tool call, however far back it is.
  // A card's id. A question a server asked carries its own id too: a call can
  // have several, one after another, and an answer to a card that is no
  // longer the one waiting must find nothing (never the next question). The session is in the id: a
  // call's id is unique in its session only (a wire whose ids count the calls gives two sessions the same).
  const questionId = (sessionId: string, callId: string, asked?: string) => `q-${sessionId}.${callId}${asked ? `-${asked}` : ""}`;
  // The pending question a card id is for.
  function questionFor(aid: string): { s: Session; callId: string; asked?: string } | undefined {
    for (const s of sessionsShown()) for (const callId of pendingQuestions(s.id)) {
      const asked = askedOf(s.id, callId)?.id;
      if (questionId(s.id, callId, asked) === aid) return { s, callId, asked };
    }
    return undefined;
  }
  function questionCard(s: Session, callId: string) {
    const e = store.db.query<any, [string, string]>("SELECT * FROM events WHERE session_id = ? AND kind = 'assistant' AND instr(data, ?) > 0 ORDER BY seq DESC LIMIT 1").get(s.id, JSON.stringify(callId));
    const tu = e ? (JSON.parse(e.data).blocks ?? []).find((b: any) => b.type === "tool_use" && b.id === callId) : undefined;
    // A question a server asked while the call ran is not the call's input: the registry holds it.
    const asked = askedOf(s.id, callId);
    const qs = asked ? normQuestions({ questions: asked.questions }) : tu ? normQuestions(tu.input) : [];
    const options = qs.flatMap((q) => q.options.map((o) => o.label));
    return {
      id: questionId(s.id, callId, asked?.id), chat_id: s.id, session_key: s.id, kind: "question",
      // (A page a server sends the owner to is shown whole: the owner opens it on the phone, and says so.)
      command: asked ? [`${asked.from} asks: ${asked.message}`, ...(asked.link ? [`${asked.link.waiting ? "Finish the step at" : "Page to open"}: ${asked.link.url}`] : []), ...(asked.notes ?? []), ...qs.map((q) => q.question)].join("\n") : tu ? qs.map((q) => q.question).join("\n") || "A question" : "This question is no longer stored; answer it in the workbench",
      description: options.join(" / "), options, unavailable: !tu,
      // One entry per question, by id: a card of several takes one answer each.
      // What each choice means, as the model wrote it beside its label (`details`, one per option, "" for
      // none), and the question's short header: sent where the model gave them.
      questions: qs.map((q) => ({
        id: q.id, question: q.question, options: q.options.map((o) => o.label), multi: q.multi,
        ...(q.options.some((o) => o.description) ? { details: q.options.map((o) => clipped(o.description ?? "", DETAIL_CHARS)) } : {}),
        ...(q.header ? { header: clipped(q.header, HEADER_CHARS) } : {}),
      })),
      // Just after its tool call's row in the chat (traceOf), not before the words of the reply that asks.
      actions: [[asked?.link ? (asked.link.waiting ? "I finished" : "I opened it") : "Answer", "once", "primary"], [asked?.link?.waiting ? "Cancel" : "Dismiss", "deny", "danger"]], state: "pending", choice: null, ts: e ? (e.ts + (e.seq % 1000) / 1000 + 0.0008) / 1000 : null,
    };
  }
  // A question that stopped waiting, with what was picked (by question id), as
  // the desktop shows it: from this daemon's record, else the stored result.
  function closedQuestion(q: { call_id: string; session_id: string; at: number; answered: boolean; answers?: Answers; question?: string }) {
    const s = sessionShown(q.session_id);
    // (A server's question is gone once it closed: its card closes by its id, with nothing of another question in it.)
    const base = s && !q.question ? questionCard(s, q.call_id) : { id: questionId(q.session_id, q.call_id, q.question), chat_id: q.session_id, session_key: q.session_id, kind: "question", command: "", description: "", options: [], questions: [] };
    let answers = q.answers;
    if (!answers && q.answered) {
      const r = store.db.query<{ data: string }, [string, string]>("SELECT data FROM events WHERE session_id = ? AND kind = 'tool_result' AND instr(data, ?) > 0 ORDER BY seq DESC LIMIT 1").get(q.session_id, JSON.stringify(q.call_id));
      answers = r ? JSON.parse(r.data).shown?.[q.call_id]?.answers : undefined;
    }
    return { ...base, actions: [], state: q.answered ? "approved" : "expired", choice: q.answered ? "once" : null, ts: secs(q.at), ...(answers ? { answers } : {}) };
  }
  function questions(sessionId?: string) {
    const out: any[] = [];
    for (const s of sessionId ? [sessionShown(sessionId)].filter(Boolean) as Session[] : sessionsShown()) {
      for (const callId of pendingQuestions(s.id)) out.push(questionCard(s, callId));
    }
    return out;
  }
  // A card with its form while it waits (the gate knows where the session's calls run).
  const cardOf = (a: Approval) => approvalOf(a, a.state === "pending" ? ctx.gate()?.form(a) : undefined);
  const plans = (sessionId?: string) => plansWaiting().filter((p) => !sessionId || p.session_id === sessionId).map((p) => planCardOf(p));
  // What waits on the owner, in the order of the next-look queue (src/core/wait-rank.ts): the
  // costliest wait first, then the one asked first (`asked`: when its alert was first raised, in
  // seconds; the phone breaks ties by it too). Each card says what its wait costs: `wait`, the facts
  // it began with (times in seconds) and its key; `wait_line`, the words as the wait stands now.
  // Each card's wait is read by its own key (alerts.waitOf), so a read costs what waits.
  const pendingApprovals = (sessionId?: string) => {
    const gate = ctx.gate();
    const asks = gate?.approvals({ session: sessionId, pending: true }) ?? [];
    const qs = (sessionId ? [sessionShown(sessionId)].filter(Boolean) as Session[] : sessionsShown()).flatMap((s) => pendingQuestions(s.id).map((callId) => ({ s, callId })));
    const ps = plansWaiting().filter((p) => !sessionId || p.session_id === sessionId);
    if (!asks.length && !qs.length && !ps.length) return [];
    const now = Date.now();
    const live = new Map<string, WaitNow | undefined>();
    const nowOf = (asker: string) => {
      if (!live.has(asker)) { let w: WaitNow | undefined; try { w = alerts.waitHook.now?.(asker); } catch {} live.set(asker, w); }
      return live.get(asker);
    };
    const withWait = (card: any, asker: string, w: alerts.WaitOf | undefined) => {
      const line = w?.wait ? nowOf(asker) ?? w.wait : undefined;
      return {
        ...card, _ts: w?.ts ?? card.ts * 1000,
        ...(w ? { asked: secs(w.ts) } : {}),
        ...(w?.wait ? { wait: { ...w.wait, at: secs(w.wait.at), ...(w.wait.until !== undefined ? { until: secs(w.wait.until) } : {}) }, _key: w.wait.key, wait_line: costs(line) ? costLine(line, now) : "" } : {}),
      };
    };
    const all = [
      ...asks.map((a) => withWait(cardOf(a), a.session_id, alerts.waitOf({ approval: a.id }))),
      ...qs.map(({ s, callId }) => withWait(questionCard(s, callId), s.id, alerts.waitOf({ call: callId, session: s.id }))),
      ...ps.map((p) => withWait(planCardOf(p), p.session_id, alerts.waitOf({ plan: p.id, session: p.session_id }))),
    ];
    return rankWaiting(all, (c) => ({ id: c.id, ts: c._ts, wait: { key: c._key ?? 0 } })).map(({ _ts, _key, ...c }) => c);
  };
  // Cards that closed after `sinceMs` (answered on the desktop, say): the app
  // keeps cards it saw until it hears they closed, and cancels their notification then.
  const closedCards = (sinceMs: number) => [
    ...(ctx.gate()?.approvals() ?? []).filter((a) => a.state !== "pending" && (a.resolved ?? a.created) >= sinceMs).map(cardOf),
    ...closedQuestions(sinceMs).map((q) => closedQuestion(q)),
    ...plansEnded(sinceMs).map((e) => planCardOf(e.card, e)),
  ];

  // Bearer token, then the request signature over method, raw path and query,
  // timestamp and body.
  const signed = (h: Signed, limit = BODY_LIMIT) => async (req: Req, srv: Server<unknown>) => {
    const auth = req.headers.get("authorization") ?? "";
    const dev = mobile.deviceForToken(auth.replace(/^bearer\s+/i, ""));
    if (!dev) return err("unauthorized", 401);
    // Said before the body is read when the request says its size, checked after in any case.
    const tooLarge = () => err(limit === ATTACHMENT_MAX ? `a file can be at most ${ATTACHMENT_MAX / 1024 / 1024} MiB` : "body too large", 413);
    if (Number(req.headers.get("content-length") ?? 0) > limit) return tooLarge();
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.length > limit) return tooLarge();
    const u = new URL(req.url);
    const ts = req.headers.get("x-hm-ts") ?? "";
    const msg = canonicalMessage(req.method, u.pathname + u.search, ts, body);
    const r = await checkAndClaim(req.headers.get("x-hm-sig") ?? "", dev.pub, msg, ts, "request", nowSecs(), mobile);
    if (r === "rejected") return err("bad signature", 401);
    if (r === "store_unavailable") return err("signature store is busy; try again", 503);
    // The token's first use: from now on a pairing retry may not replace it.
    if (!dev.token_used && !mobile.markTokenUsed(dev.id, auth.replace(/^bearer\s+/i, ""))) return err("unauthorized", 401);
    return h(req, dev, body, srv);
  };
  const parse = (b: Uint8Array): any => {
    if (!b.length) return {};
    try {
      return JSON.parse(new TextDecoder().decode(b)) ?? {};
    } catch {
      return null;
    }
  };
  const withBody = (h: (req: Req, dev: Device, b: any) => Response | Promise<Response>): Signed => (req, dev, raw) => {
    const b = parse(raw);
    return b === null || typeof b !== "object" ? err("the body is not JSON", 400) : h(req, dev, b);
  };

  // An approval key signature over `msg` (biometric on the phone).
  const approvalSigned = async (req: Req, dev: Device, msg: string, scope: string) =>
    (await checkAndClaim(req.headers.get("x-hm-asig") ?? "", dev.apub, new TextEncoder().encode(msg), req.headers.get("x-hm-ts") ?? "", scope, nowSecs(), mobile)) === "valid";

  async function pair(req: Req, srv: Server<unknown>) {
    const now = nowSecs();
    const source = requestSource(req.headers, srv.requestIP(req)?.address ?? null);
    if (limiter.blocked(source, now)) return err("too many attempts", 429);
    const raw = new Uint8Array(await req.arrayBuffer());
    const b: any = parse(raw) ?? {};
    const [p, a] = await Promise.all([loadSpki(String(b?.pub ?? "")), loadSpki(String(b?.apub ?? ""))]);
    if (!p || !a) return err("device keys required (P-256 SPKI, base64)", 400);
    // The approval key stands for a biometric check; it must not be the request key.
    if (p.spki.toBase64() === a.spki.toBase64()) return err("the approval key must differ from the request key", 400);
    // A retry of a redeemed code (the phone lost the answer) must prove the
    // request key with the canonical request signature, claimed once in its own
    // scope, over a body that names this server: a server the phone was lured to
    // cannot relay its retry here. A first claim of a link code needs none; a
    // code typed by hand (typed-code.ts) needs it the first time too.
    const ts = req.headers.get("x-hm-ts") ?? "", sig = req.headers.get("x-hm-sig") ?? "";
    const here = urlOrigin(mobile.setting("public_url") ?? new URL(req.url).origin);
    const proven = !!sig && !!here && urlOrigin(String(b.server ?? "")) === here
      && (await checkAndClaim(sig, String(b.pub), canonicalMessage(req.method, new URL(req.url).pathname, ts, raw), ts, "pair", now, mobile)) === "valid";
    const code = String(b.code ?? "");
    const got = mobile.claimPairCode(code, String(b.device_name ?? "phone"), b.pub, b.apub, b.lock === false, proven);
    if (!got) {
      limiter.fail(source, now);
      // A code typed by hand pairs only a request signed with the request key over a body naming this server.
      if (!proven && typedCodeOf(code)) return err("a typed code pairs only a signed request (x-hm-ts, x-hm-sig) whose body names this server", 403);
      return err("invalid or expired code", 403);
    }
    if (!got.reissued) ctx.changed();
    return json({ device_id: got.device_id, token: got.token, cf: {}, server: { name: host(), profile: "keel" } });
  }

  async function approve(req: Req, dev: Device, b: any) {
    const aid = req.params.aid!;
    const choice = String(b.choice ?? "");
    if (!["once", "session", "always", "deny"].includes(choice)) return err("bad choice", 400);
    if (dev.nolock && (choice === "session" || choice === "always")) return err("This phone has no screen lock, so it can only approve once", 403);
    // Answers by question id ({ id: "label" | ["labels"] }), or one `answer`
    // for a card of one question. The signature covers what is answered.
    const byId: Record<string, unknown> | null = b.answers && typeof b.answers === "object" && !Array.isArray(b.answers) ? b.answers : null;
    const text = byId ? answersText(byId) : typeof b.answer === "string" ? b.answer.trim() : "";
    if (choice !== "deny") {
      const v2 = req.headers.get("x-hm-asig-v")?.trim() === "2";
      if (!(await approvalSigned(req, dev, approvalMessage(aid, choice, req.headers.get("x-hm-ts") ?? "", v2, text), "approval")))
        return err("biometric signature required", 403);
    }
    if (aid.startsWith("plan-")) {
      const rest = aid.slice("plan-".length), dot = rest.indexOf(".");
      const sid = rest.slice(0, Math.max(0, dot)), id = rest.slice(dot + 1);
      const p = plansWaiting().find((x) => x.id === id && x.session_id === sid);
      const ended = plansEnded(0).findLast((e) => e.card.id === id && e.card.session_id === sid);
      if (!p) return ended ? json({ error: `this plan is already ${ended.how === "approved" ? "approved" : ended.how === "denied" ? "sent back to planning" : "closed"}`, approval: planCardOf(ended.card, ended) }, 409) : err("this plan is no longer waiting", 409);
      if (text) return err("answer only applies to questions", 400);
      if (choice === "always") return err("a plan is approved for the work it describes, not always", 400);
      // A notification shows a line of it: a plan is approved only from where it is read whole.
      if (choice !== "deny" && b.via === "notification") return json({ error: "Open the plan to read it before approving it.", hold: ["plan"], approval: planCardOf(p) }, 409);
      // Approved only once the whole plan was on the phone's screen.
      if (choice !== "deny" && b.seen !== "whole") return json({ error: "Read the plan to its end to approve it.", hold: ["plan"], approval: planCardOf(p) }, 409);
      const feedback = typeof b.feedback === "string" ? b.feedback : undefined;
      const r = decidePlan(sid, id, choice === "deny" ? { approve: false, feedback } : { approve: true, mode: choice === "session" ? "auto-edits" : "ask" });
      if (r.status !== 200) return json({ error: r.body.error ?? "the plan was not decided", approval: planCardOf(p) }, r.status);
      const end = plansEnded(0).findLast((e) => e.card.id === id && e.card.session_id === sid);
      return json({ approval: planCardOf(p, end ?? { card: p, how: choice === "deny" ? "denied" : "approved", at: Date.now() }), resolved: 1 });
    }
    if (aid.startsWith("q-")) {
      // (By the whole id: a card of a server's earlier question on the same call finds nothing.)
      const at = questionFor(aid);
      if (!at) return err("this question is no longer waiting", 409);
      const { s, callId } = at;
      const card = questionCard(s, callId);
      if (choice !== "deny" && !text) return err("answer required for question", 400);
      const answers: Answers = {};
      const qs = card.questions as { id: string; options: string[]; multi: boolean }[];
      // Dismissing a question a server asked is the protocol's decline.
      if (choice === "deny" && askedOf(s.id, callId)) {
        if (decline(s.id, callId, at.asked) !== true) return err("this question is no longer waiting", 409);
        return json({ approval: { ...card, actions: [], state: "denied", choice }, resolved: 1 });
      }
      if (choice !== "deny" && !byId && qs.length > 1) return err(`this card asks ${qs.length} questions; answer each by its id (answers: { id: answer })`, 400);
      for (const q of qs) {
        if (choice === "deny") { answers[q.id] = { picked: [], other: "The owner dismissed the question." }; continue; }
        const given = byId ? byId[q.id] : text;
        const vals = (Array.isArray(given) ? given : given === undefined || given === null ? [] : [given]).map((v) => String(v).trim()).filter(Boolean);
        if (!vals.length) return err(`no answer for question ${q.id}; the question stays waiting`, 400);
        const picked: string[] = [], other: string[] = [];
        for (const v of vals) { const hit = q.options.find((o) => o.toLowerCase() === v.toLowerCase()); (hit ? picked : other).push(hit ?? v); }
        answers[q.id] = other.length ? { picked, other: other.join(", ") } : { picked };
      }
      const sent = answer(s.id, callId, answers, false, at.asked);
      // A form that asks for what looks like a secret is sent from the workbench only, on the owner's word there.
      if (sent === "unsent") return err("this form asks for what looks like a secret: dismiss it here, or answer it in the workbench", 409);
      if (sent !== true) return err("this question is no longer waiting", 409);
      // (What was typed for a server's question is the server's alone: it is not sent back.)
      return json({ approval: { ...card, actions: [], state: choice === "deny" ? "denied" : "approved", choice, ...(askedOf(s.id, callId) ? {} : { answers }) }, resolved: 1 });
    }
    const g = ctx.gate();
    const a = g?.approval(aid);
    if (!g || !a) return err("unknown approval", 404);
    if (text) return err("answer only applies to questions", 400);
    // Answered elsewhere first: who answered and how long ago, and the card as it ended.
    const closed = (x: Approval) => json({ error: `this approval is ${closedWhy(x)}`, approval: cardOf(x) }, 409);
    if (a.state !== "pending") return closed(a);
    // `seen`: the app's word that its card showed the whole text. The gate
    // takes it from the app's card only: a notification shows one line, so an
    // answer from one allows once, and only what that line shows whole.
    // (A denial carries no reason of the phone's making: the call's result is then the same words as
    // a denial on the page, and the transcript reads it the same. Where it was given is kept in `by`.)
    const r = g.resolve(aid, a.session_id, {
      choice: choice as any,
      seen: b.seen === "whole" ? "whole" : undefined, by: { client: b.via === "notification" ? "notification" : "phone", device: dev.name },
    });
    // Held: the card is still open. The sentence is what the app shows; `hold` and the card tell a newer app what to open.
    if ("error" in r && r.hold) return json({ error: r.error, hold: r.hold, approval: cardOf(g.approval(aid)!) }, 409);
    if ("error" in r && r.status === 409 && g.approval(aid)!.state !== "pending") return closed(g.approval(aid)!);
    if ("error" in r) return err(r.error, r.status);
    return json({ approval: cardOf(g.approval(aid)!), resolved: 1 });
  }

  // The live stream. With `since` (the phone's cursor) it opens with what the
  // phone missed: the first frame is `hello` with `sync`, the answer /v1/sync
  // gives for that cursor, made in the same step that subscribes the stream to
  // what follows. So nothing falls between the catch-up and the live frames
  // and nothing comes twice, also across a reconnect or a daemon restart (the
  // cursor is a stored place). A stream that fell behind drops frames until
  // the phone reads again, then says `resync` and sends `hello` with `sync`
  // from the last place it delivered: the phone recovers on the same stream.
  // `cursor` on a frame says every stored event up to there has gone out on
  // this stream; the phone reconnects from the newest one it got. Without
  // `since` (an older app) the stream starts live, as before.
  function events(req: Req, dev: Device, srv: Server<unknown>) {
    srv.timeout(req, 0);
    const q = new URL(req.url).searchParams;
    const resumes = q.has("since");
    const enc = new TextEncoder();
    let off = () => {}, beat: Timer | undefined, lagged = 0, forget = () => {};
    const stream = new ReadableStream<Uint8Array>(
      {
        start(c) {
          forget = holdStream(c);
          const close = () => { off(); clearInterval(beat); forget(); try { c.close(); } catch {} };
          // Every stored event up to `sent` has gone out here. Branch changes
          // up to `base` are in the last sync; `marks` are the ones sent since.
          let sent = mobile.globalSeq(), base = sent;
          const marks = new Map<string, number>();
          const put = (p: unknown) => c.enqueue(enc.encode(`data: ${JSON.stringify(p)}\n\n`));
          // What the phone holds (`held`, its digests per bucket of rows), said once with the stream: its
          // first hello sends only the buckets that differ. A hello after a lag sends every row (what the
          // phone holds is not known then).
          let held = parseHeld(q.get("held"));
          const hello = (from: number) => {
            const sync = syncBody(from, held);
            held = null;
            sent = base = sync.seq;
            marks.clear();
            put({ type: "hello", seq: sync.seq, cursor: sync.seq, working: sync.working, sync });
          };
          // False when the frame was not sent. Within one bus frame, once a
          // send is dropped the ones after it are too.
          const send = (p: unknown) => {
            if (!mobile.isActive(dev.id)) { close(); return false; }
            // Fell behind: drop until the phone reads again, then say so once.
            if ((c.desiredSize ?? 1) <= 0) { lagged++; return false; }
            if (lagged) {
              const missed = lagged;
              lagged = 0;
              put({ type: "resync", missed, seq: mobile.globalSeq() });
              if (resumes) hello(sent);
            }
            put(p);
            return true;
          };
          // The shown branch changed: the chat's newest page replaces what the phone holds for it.
          const branch = (sid: string) => {
            const m = mobile.branchSeq(sid);
            if (m <= (marks.get(sid) ?? base)) return;
            const s = sessionShown(sid);
            const page = s ? chatMessages(s, RESET_PAGE) : null;
            if (s && page && send({ type: "chat_reset", seq: m, chat_id: sid, messages: page.messages, older: page.older, chat: chatFull(s) })) marks.set(sid, m);
          };
          if (resumes) hello(Math.max(0, Number(q.get("since")) || 0));
          else send({ type: "hello", seq: sent, working: working() });
          off = bus.on((f) => {
            try {
              if (f.t === "event") {
                const s = sessionShown(f.event.session_id);
                if (!s) return;
                const gseq = mobile.gseqOf(f.event.id);
                branch(f.event.session_id);
                const out = msgsOf(f.event, gseq);
                const chat = s ? chatFull(s) : null;
                out.forEach((m, i) => send({ type: "message", seq: gseq, message: m, chat, ...(i === out.length - 1 ? { cursor: gseq } : {}) }));
                if (!lagged) sent = Math.max(sent, gseq);
                // A question answered elsewhere: its card closes on the phone too.
                if (f.event.kind === "tool_result") {
                  const ids = new Set(((f.event.data.results ?? []) as any[]).map((r) => r.tool_use_id));
                  for (const q of closedQuestions(f.event.ts - 60_000)) if (q.session_id === f.event.session_id && ids.has(q.call_id)) send({ type: "approval", seq: gseq, approval: closedQuestion(q) });
                }
              } else if (f.t === "delta" && f.kind === "text") send({ type: "delta", chat_id: f.session_id, delta: f.text });
              else if (f.t === "session") {
                if (isOutside(f.session)) return;
                // Gone on the desktop: the phone drops it. Renamed, archived or
                // pinned there: the phone's row follows without a sync.
                if (f.deleted) send({ type: "chat_removed", chat_id: f.session.id, seq: mobile.globalSeq() });
                else {
                  branch(f.session.id);
                  const s = sessionShown(f.session.id);
                  if (s) send({ type: "chat", seq: mobile.globalSeq(), chat: chatFull(s) });
                  send({ type: "working", chat_id: f.session.id, working: f.session.phase === "working", since: since(f.session) });
                }
              }
              else if (f.t === "feature" && f.name === "automation" && f.data?.kind === "alert" && f.data.data?.kind === "question" && !f.data.data.read && f.data.data.data?.call_id) {
                // A question raised: its card reaches the phone now, not at the next sync.
                const a = f.data.data;
                const asker = a.data.open_session ?? a.session_id;
                if (closedQuestions(0).some((q) => q.call_id === a.data.call_id && q.session_id === asker)) return;
                const s = sessionShown(asker);
                if (s) {
                  const q = questionCard(s, a.data.call_id);
                  send({ type: "approval", seq: mobile.globalSeq(), approval: q });
                  send({ type: "message", seq: mobile.globalSeq(), message: approvalMsg(q) });
                  send({ type: "chat", seq: mobile.globalSeq(), chat: chatFull(s) });
                }
              }
              else if (f.t === "feature" && f.name === "agents_now") {
                // What agents are doing now (at most a line every 15 s an agent): their rows follow.
                for (const l of ((f.data as { lines?: NowLine[] })?.lines ?? [])) {
                  const s = sessionShown(l.session_id);
                  if (s) send({ type: "chat", seq: mobile.globalSeq(), chat: chatFull(s) });
                }
              }
              else if (f.t === "feature" && f.name === "automation" && f.data?.kind === "agent" && f.data.data?.parent_id) {
                // An agent started or ended: its parent's row says whether it still works.
                const s = sessionShown(f.data.data.parent_id);
                if (s) send({ type: "chat", seq: mobile.globalSeq(), chat: chatFull(s) });
              }
              // (A plan parked with its turn by a stopping daemon is closed with no end: nothing is said of it.)
              else if (f.t === "feature" && f.name === "plan" && f.data?.card && (f.data.state === "open" || f.data.end)) {
                // A plan presented, or how it ended: its card, its place in the chat, and the chat's row.
                const a = planCardOf(f.data.card, f.data.end);
                send({ type: "approval", seq: mobile.globalSeq(), approval: a });
                if (a.state === "pending") send({ type: "message", seq: mobile.globalSeq(), message: approvalMsg(a) });
                const s = sessionShown(a.chat_id);
                if (s) send({ type: "chat", seq: mobile.globalSeq(), chat: chatFull(s) });
              }
              else if (f.t === "error") {
                // A kind of failure happened, was read, healed or resolved: its row as the Errors view lists it
                // (`gone`: resolved, or a kind the store never took that was let go), so the view and its count
                // follow without a read of the list.
                const kept = f.error.id.startsWith("unwritten-") ? errors.unwritten().find((u) => u.id === f.error.id) : errors.get(f.error.id);
                const rec = kept ?? f.error;
                send({ type: "error_changed", row: errorRow(rec), gone: !kept || !!rec.resolved_ts });
              }
              else if (f.t === "feature" && f.name === "approval") {
                const a = cardOf(f.data as Approval);
                send({ type: "approval", seq: mobile.globalSeq(), approval: a });
                if (a.state === "pending") send({ type: "message", seq: mobile.globalSeq(), message: approvalMsg(a) });
                // The chat's row says it needs the owner, then that it does not.
                const s = sessionShown(a.chat_id);
                if (s) send({ type: "chat", seq: mobile.globalSeq(), chat: chatFull(s) });
              }
            } catch (e) {
              errors.capture("server", e, { at: "mobile event stream" });
            }
          });
          // Between two bus frames every stored event has had its frame: a
          // stream that dropped none is level with the store.
          beat = setInterval(() => {
            // A head move whose frame never came (none does that today) is told
            // here, before the cursor passes its place.
            for (const sid of mobile.branchesAfter(base)) branch(sid);
            if (!lagged) sent = Math.max(sent, mobile.globalSeq());
            send({ type: "seq", seq: mobile.globalSeq(), cursor: sent, working: working() });
          }, 15_000);
          req.signal.addEventListener("abort", close, { once: true });
        },
        cancel() { off(); clearInterval(beat); forget(); },
      },
      { highWaterMark: 1000, size: () => 1 },
    );
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
  }

  // Messages of one chat's shown branch with its approval cards in place. The
  // other branches' messages come as kind "deleted" (the app hides those ids),
  // so a phone that cached the branch the owner left shows only the one they chose;
  // nothing is removed from the store. A client that pages (`before`, or
  // `paged=1` with `limit`) gets the newest `limit` and `older` to ask for the
  // page before; one that does not gets the whole branch, as before.
  function chatMessages(s: Session, q: URLSearchParams) {
    const all = store.events(s.id);
    const line = lineage(all, s.head);
    const on = new Set(line.map((e) => e.id));
    const msgs: any[] = line.flatMap((e) => msgsOf(e, mobile.gseqOf(e.id)));
    for (const a of ctx.gate()?.approvals({ session: s.id }) ?? []) msgs.push(approvalMsg(approvalOf(a)));
    for (const q of questions(s.id)) msgs.push(approvalMsg(q));
    for (const p of plans(s.id)) msgs.push(approvalMsg(p));
    for (const e of plansEnded(0)) if (e.card.session_id === s.id) msgs.push(approvalMsg(planCardOf(e.card, e)));
    msgs.sort((x, y) => x.ts - y.ts);
    const off = all.filter((e) => !on.has(e.id)).flatMap((e) => msgsOf(e, 0))
      .map((m: any) => ({ ...m, kind: "deleted", content: "", meta: { branch: "not shown" } }));
    const before = q.get("before");
    const limit = Math.max(1, Math.min(1000, Number(q.get("limit")) || 150));
    if (!before && q.get("paged") !== "1") return { messages: [...msgs, ...off] };
    let end = msgs.length;
    if (before) {
      end = msgs.findIndex((m) => m.id === before);
      if (end < 0) return null;
    }
    const start = Math.max(0, end - limit);
    return { messages: [...msgs.slice(start, end), ...(before ? [] : off)], older: start > 0 ? msgs[start]!.id : null };
  }

  // Calendar days in the daemon's time zone: "today" on the card is the newest
  // of the seven bars. A scheduled run counts as failed once, by its run record;
  // a skipped run or one the owner stopped is not a failure.
  const dayStart = (offset = 0) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - offset); return d.getTime(); };
  function pulse() {
    const from = dayStart(6), today = dayStart();
    const spend = Array<number>(7).fill(0), unpriced = Array<number>(7).fill(0);
    const bucket = (ts: number) => 6 - Math.round((dayStart() - new Date(new Date(ts).setHours(0, 0, 0, 0)).getTime()) / 86_400_000);
    let runs = 0;
    for (const r of store.db.query<{ kind: string; data: string; ts: number }, [number]>("SELECT kind, data, ts FROM events WHERE ts >= ? AND kind IN ('turn_start', 'turn_end')").all(from)) {
      if (r.kind === "turn_start") { if (r.ts >= today) runs++; continue; }
      const i = bucket(r.ts);
      if (i < 0 || i > 6) continue;
      const c = JSON.parse(r.data)?.usage?.cost;
      if (typeof c === "number") spend[i] = spend[i]! + c;
      else unpriced[i] = unpriced[i]! + 1;
    }
    let failed: { id: string; loop_id: string; chat_id: string }[] = [];
    try {
      failed = store.db.query<{ id: string; loop_id: string; session_id: string }, [number]>(
        "SELECT id, loop_id, session_id FROM loop_runs WHERE ended_ms >= ? AND ok = 0 AND skip_reason IS NULL AND stop = 0 ORDER BY ended_ms",
      ).all(today).map((r) => ({ id: r.id, loop_id: r.loop_id, chat_id: r.session_id }));
    } catch {}
    const round = (n: number) => Math.round(n * 10_000) / 10_000;
    return {
      // Known spend only; the turns with no price are counted beside it.
      spend_today: unpriced[6] && !spend[6] ? null : round(spend[6]!), spend_today_unpriced: unpriced[6],
      spend_7d: spend.map(round), spend_7d_unpriced: unpriced, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      runs_today: runs, failures_today: failed.length, failed_runs_today: failed,
    };
  }

  // What a phone at cursor `since` needs to be level with the daemon.
  // From nothing: every chat's row at the current cursor, and the newest page
  // of the FIRST_CHATS chats at the top of the phone's list.
  // After a cursor: the events the app shows that were stored since (so a run
  // of tool rounds and notes costs nothing), and for each chat whose shown
  // branch changed since (`reset`), its newest page in place of them: the app
  // replaces what it holds for that chat and pages back from `older`.
  // `reload` says the cursor cannot be caught up from, and the answer is the
  // one from nothing; the app drops what it holds first. "ahead": this store
  // never gave that cursor (a restored backup, another machine). "behind":
  // more than a page of events were stored since, more than the newest page of
  // every chat costs.
  // `held`: what the phone holds, a digest per bucket of rows (heldOf). Then only the rows of the buckets
  // whose digest differs go, `buckets` names those buckets (the phone drops what it holds there that
  // was not sent), and the answer is not `complete`. A whole read (since 0, a reload) sends every row.
  function syncBody(since: number, held: number[] | null = null) {
    const seq = mobile.globalSeq();
    const page = since > 0 && since <= seq ? mobile.eventsAfter(since, SYNC_PAGE + 1, SHOWN_KINDS) : [];
    const reload = since > seq ? "ahead" : page.length > SYNC_PAGE ? "behind" : undefined;
    const whole = since === 0 || !!reload;
    const u = unread();
    const all = allSessions();
    const moved = whole ? [] : mobile.branchesAfter(since).map((id) => sessionShown(id)).filter((s): s is Session => !!s)
      .map((s) => ({ id: s.id, page: chatMessages(s, RESET_PAGE)! }));
    const reset = new Set(moved.map((m) => m.id));
    const away = page.length ? outsideIds(store.db) : new Set<string>();
    // Cards that closed since the cursor's time, or within a push's lifetime.
    const from = Math.min(Date.now() - 15 * 60_000, whole ? Infinity : (mobile.tsOfGseq(since) ?? 0));
    const rows = all.map((s) => chatFull(s, u));
    // The phone said what it holds: only the buckets that differ go, each whole.
    const diff = held && !whole ? held : null;
    const n = diff?.length ?? 0;
    const mine = diff ? digests(rows.map((r) => ({ id: r.id as string, h: r.h as string })), n) : [];
    const stale = new Set(mine.flatMap((d, i) => (d === diff![i] ? [] : [i])));
    return {
      // `more` is always false now: an older app pages while it is true.
      seq, more: false,
      // `complete`: the chats are every chat there is, so the app drops the
      // ones it holds that are not among them (deleted on the desktop).
      complete: !diff,
      ...(reload ? { reload } : {}),
      chats: diff ? rows.filter((r) => stale.has(bucketOf(r.id as string, n))) : rows,
      ...(diff ? { buckets: { n, of: [...stale] } } : {}),
      messages: whole ? sessionsShown().sort((a, b) => b.updated - a.updated).slice(0, FIRST_CHATS).flatMap(recent) : [...page.filter((e) => !reset.has(e.session_id) && !away.has(e.session_id)).flatMap((e) => msgsOf(e, e.gseq)), ...moved.flatMap((m) => m.page.messages)],
      ...(moved.length ? { reset: moved.map((m) => ({ chat_id: m.id, older: m.page.older ?? null })) } : {}),
      approvals: [...pendingApprovals(), ...closedCards(from)],
      working: working(),
      // The reply each running turn has streamed so far.
      drafts: [...drafts].map(([chat_id, text]) => ({ chat_id, text })),
    };
  }

  // One kind of failure as the phone lists it: its whole message, where it came from, how often and
  // when, read or not, healed by a retry or not, and the session it last happened in while that
  // session is there to open (`sessions`: in how many it happened, when more than one).
  const errorRow = (e: ErrorRecord) => {
    const at = e.sites?.[0]?.session_id ?? e.session_id;
    const s = at ? sessionShown(at) : undefined;
    return {
      id: e.id, message: e.message, source: e.source, count: e.count ?? 1, first: secs(e.first_ts ?? e.ts), last: secs(e.ts),
      read: !!e.read_ts, recovered: !!e.recovered_ts,
      ...(s ? { chat_id: s.id, title: s.title || "New chat" } : {}),
      ...((e.sites?.length ?? 0) > 1 ? { sessions: e.sites!.length } : {}),
    };
  };
  // What is open, the newest first: the failures the store could not take lead, as on the page.
  // `unread`: what the page's badge counts (open, not read, not healed by a retry).
  const errorList = () => {
    const rows = [...errors.unwritten(), ...errors.list(ERRORS_LISTED, { resolved: false })].map(errorRow);
    return { errors: rows, unread: rows.filter((r) => !r.read && !r.recovered).length };
  };

  const chat = (sid: string) => sessionShown(sid);
  // The chat, for a handler that reads its events: one that is not in memory is brought in off
  // the loop first, a part at a time (its rows; these routes are not under /api/sessions/:id,
  // where every request does this).
  const warmed = async (sid: string) => {
    if (!store.isKept(sid) && sessionShown(sid)) await store.warm(sid, false);
    return sessionShown(sid);
  };

  // The receipt of a prompt already stored, as it stands now: the committed
  // message, a queued prompt still waiting as it was first told, or the
  // message a queued prompt became (the same id). One the owner took off the
  // queue comes back as "deleted": the app drops its row.
  function receiptNow(p: SendRecord) {
    const told = JSON.parse(p.receipt);
    const committed = (e?: StoredEvent | null) => (e ? toMsg(e, mobile.gseqOf(e.id)) : null);
    if (p.event_id) return committed(store.event(p.event_id)) ?? told;
    if (!p.queue_id || store.queueItem(p.queue_id)) return told;
    const row = store.db.query<{ id: string }, [string, string]>("SELECT id FROM events WHERE session_id = ? AND kind = 'user' AND instr(data, ?) > 0 ORDER BY seq DESC LIMIT 1").get(p.session_id, JSON.stringify(p.queue_id));
    const e = row ? store.event(row.id) : null;
    return (e?.data.queue_id === p.queue_id ? committed(e) : null) ?? { ...told, kind: "deleted", content: "" };
  }

  return {
    "/v1/health": { GET: () => json({ ok: true, name: host(), profile: "keel", api: 1, security: { signature_replay: REPLAY_VERSION }, degraded: [] }) },
    "/v1/pair": { POST: pair },
    // The page a pairing QR or link opens in the phone's browser: it hands the
    // code to the Keel app, or to the Hermes app on a phone that has that one.
    "/pair": {
      GET: (req: Req) => {
        const code = new URL(req.url).searchParams.get("c") ?? "";
        const base = mobile.setting("public_url") ?? new URL(req.url).origin;
        const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
        return new Response(pairPage(esc(pairLink(base, code, "keel")), esc(pairLink(base, code, "hermes"))), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
        });
      },
    },
    "/v1/me": {
      GET: signed(async (_r, dev) => {
        const models = providers.marked(await providers.models().catch(() => [])).filter((m) => !m.hidden).map((m) => m.id);
        const model = (await providers.defaultModel().catch(() => "")) || sessionsShown()[0]?.model || null;
        return json({
          device: { id: dev.id, name: dev.name, created: dev.created }, name: host(), profile: "keel", model, agent_name: "Keel", user_name: "owner",
          models, profiles: ["default"], public_url: mobile.setting("public_url") ?? "",
          features: { radar: false, fleet: false, wake_wa: false, projects: false, rooms: false }, security: { signature_replay: REPLAY_VERSION },
          // What /v1/upload takes, so the app can say no before it sends the bytes,
          // and the long edge a photo is stored at, so it sends no more pixels than are kept.
          uploads: { max_bytes: ATTACHMENT_MAX, inline_images: INLINE_IMAGES, image_edge: STORE.edge },
        });
      }),
    },
    // `since` and `seq` are positions in the global event sequence, so a long
    // session never hides a newer event of a short one (syncBody).
    "/v1/sync": {
      GET: signed(async (req) => {
        const q = new URL(req.url).searchParams;
        const since = Math.max(0, Number(q.get("since")) || 0);
        // The chats whose shown branch changed since are read whole below: brought in off the loop first.
        if (since > 0) for (const id of mobile.branchesAfter(since)) await warmed(id);
        return json(syncBody(since, parseHeld(q.get("held"))));
      }),
    },
    "/v1/events": { GET: signed((req, dev, _b, srv) => events(req, dev, srv)) },
    // The search across sessions, as the page's: titles first, then what was said and done, one hit a
    // session at most. A hit's `snippet` marks the words found between \u0001 and \u0002.
    "/v1/search": {
      GET: signed(async (req) => {
        const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
        if (!q) return json({ query: "", hits: [] });
        if (!ctx.search) return err("this daemon does not search", 409);
        const r = await ctx.search(new Request(`http://keel/api/search?${new URLSearchParams({ q, limit: String(SEARCH_HITS), sessions: "1", outside: "0" })}`));
        const out: any = await r.json();
        if (!r.ok) return json({ error: String(out.error ?? "the search failed"), ...(out.limit ? { limit: true } : {}) }, r.status);
        // One row a session: in the place of its first hit (a title's, when the title holds the words),
        // with what was said when the words were said too, since that tells more than the title again.
        const rows = new Map<string, any>();
        for (const h of (out.hits ?? []) as any[]) {
          const row = {
            chat_id: h.session_id, title: h.session_title || "New chat", kind: h.kind, snippet: String(h.snippet ?? "").slice(0, 400), ts: secs(h.ts),
            ...(h.event_id ? { event_id: h.event_id } : {}), ...(h.archived ? { archived: true } : {}), ...(h.parent_id ? { parent_id: h.parent_id } : {}),
          };
          const had = rows.get(h.session_id);
          if (!had) rows.set(h.session_id, row);
          else if (had.kind === "title" && row.kind !== "title") rows.set(h.session_id, { ...row, title: had.title });
        }
        return json({ query: out.query ?? q, ...(out.limits ? { limits: out.limits } : {}), hits: [...rows.values()] });
      }),
    },
    // What happened while the owner was away (the page's digest), and its dismissal: seen on the phone,
    // it is not shown again there or on the page.
    "/v1/away": {
      GET: signed(() => { const d = ctx.away?.(); return json({ away: d ? awayOf(d) : null }); }),
      DELETE: signed(() => { ctx.awaySeen?.(); return json({ ok: true }); }),
    },
    // What broke on the daemon, as the page's Errors panel lists it: the open kinds of failure.
    "/v1/errors": { GET: signed(() => json(errorList())) },
    // Branches that wait to land, ready first: each a card of the work board's facts.
    "/v1/landings": {
      GET: signed(async () => (ctx.landings ? json({ cards: await ctx.landings.list() }) : err("this daemon runs no work board", 409))),
    },
    // Land it (the approval key signs the card's key and print) or send it back with the owner's words:
    // either only while the card's facts are the ones shown.
    "/v1/landings/:key/:action": {
      POST: signed(withBody(async (req, dev, b) => {
        const L = ctx.landings;
        if (!L) return err("this daemon runs no work board", 409);
        let key: string;
        try { key = decodeURIComponent(req.params.key!); } catch { return err("the key is not a valid path part", 400); }
        const action = req.params.action;
        const fp = typeof b.fp === "string" ? b.fp : "";
        if (!fp) return err("fp is the print of the card as it was shown", 400);
        let r: any;
        if (action === "land") {
          if (!(await approvalSigned(req, dev, landMessage(key, fp, req.headers.get("x-hm-ts") ?? ""), "approval"))) return err("biometric signature required", 403);
          r = await L.land(key, fp);
        } else if (action === "back") {
          const text = typeof b.text === "string" ? b.text.trim() : "";
          if (!text) return err("text is what the agent is told", 400);
          if (text.length > BACK_MAX) return err(`the words can be at most ${BACK_MAX} characters`, 400);
          r = await L.back(key, fp, text).catch((e: Error) => ({ status: 409, error: e.message, card: null }));
        } else return err("the action is land or back", 400);
        if ("status" in r) return json({ error: r.error, card: r.card }, r.status);
        return json(r);
      })),
    },
    // Every open one the phone was shown, read at once (`ids`), as the page's Mark all read: one that
    // happened again after it was shown came back unread and is read with the rest only if listed.
    "/v1/errors/read-all": {
      POST: signed(withBody((_r, _d, b) => {
        const ids: string[] = Array.isArray(b.ids) ? b.ids.filter((x: unknown): x is string => typeof x === "string").slice(0, ERRORS_LISTED) : [];
        if (!ids.length) return err("ids is the list of the errors shown", 400);
        for (const id of ids) {
          if (id.startsWith("unwritten-")) { errors.dismiss(id); continue; }
          const e = store.error(id);
          if (!e || e.resolved_ts || e.read_ts) continue;
          store.readError(id, true);
          bus.emit({ t: "error", error: errors.get(id)! });
        }
        return json(errorList());
      })),
    },
    // Read (out of the count, still listed), unread again, or resolved (off the list), as on the page.
    "/v1/errors/:eid/:action": {
      POST: signed((req) => {
        const id = req.params.eid!, action = req.params.action;
        if (action !== "read" && action !== "unread" && action !== "resolve") return err("the action is read, unread or resolve", 400);
        // One the store never took is only in memory: read or resolved, it is let go.
        if (id.startsWith("unwritten-")) {
          if (action === "unread") return err("this error was never stored; it can only be let go", 400);
          const gone = errors.dismiss(id);
          return gone ? json({ row: errorRow(gone) }) : err("no such error", 404);
        }
        if (!store.error(id)) return err("no such error", 404);
        if (action === "resolve") errors.resolve(id, true); else store.readError(id, action === "read");
        const rec = errors.get(id)!;
        bus.emit({ t: "error", error: rec });
        return json({ row: errorRow(rec) });
      }),
    },
    // The owner is at the phone: its last touch this long ago (the end of an absence, as a page's report is).
    "/v1/presence": {
      POST: signed(withBody((_r, _d, b) => {
        if (typeof b.idle_ms !== "number" || !(b.idle_ms >= 0)) return err("give idle_ms: how long ago the owner last touched the app", 400);
        ctx.ownerSeen?.(b.idle_ms);
        return json({ ok: true });
      })),
    },
    // What a new session can start with: the models (the default first named), the folders this
    // machine's sessions worked in, newest first, and the machines of the fleet that can take one.
    "/v1/start": {
      GET: signed(async () => {
        const listed = providers.marked(await providers.models().catch(() => [])).filter((m) => !m.hidden);
        const model = (await providers.defaultModel().catch(() => "")) || "";
        const seen = new Map<string, number>();
        for (const s of [...sessionsShown(), ...sessionsShown({ archived: true })]) {
          if (s.machine || s.parent_id) continue;
          seen.set(s.workspace, Math.max(seen.get(s.workspace) ?? 0, s.updated));
        }
        if (!seen.has(ctx.workspace)) seen.set(ctx.workspace, 0);
        const folders = [...seen].filter(([p]) => { try { return statSync(p).isDirectory(); } catch { return false; } })
          .sort((a, b) => b[1] - a[1]).slice(0, START_FOLDERS)
          .map(([path, last]) => ({ path, name: baseName(path) || path, ...(last ? { last: secs(last) } : {}), ...(path === ctx.workspace ? { home: true } : {}) }));
        const all = (await ctx.fleetMachines?.().catch(() => [])) ?? [];
        const machines = all.filter((m: any) => m.id === "local" || (m.enabled && m.workspace_root))
          .map((m: any) => ({ id: m.id, name: m.name, ready: m.id === "local" || (m.state === "ready" && (m.daemon?.state === "linked" || m.transport === "ssh")), ...(m.workspace_root ? { root: m.workspace_root } : {}) }));
        return json({ model, models: listed.map((m) => ({ id: m.id, name: m.name || m.id })), folders, machines });
      }),
    },
    "/v1/chats": {
      GET: signed(() => { const u = unread(); return json({ chats: sessionsShown().map((s) => chatFull(s, u)), working: working() }); }),
      // A new session: on the default model in the daemon's folder, or as the start sheet chose (`model`,
      // `workspace`, `machine`), and with its first message (`text`) when one is given.
      POST: signed(withBody(async (_r, dev, b) => {
        // Profiles are not a Keel notion; the one profile is "default". A
        // remembered profile this daemon does not have is refused before a chat
        // exists, so the app can show the choice it has.
        if (b.profile !== undefined && b.profile !== null && b.profile !== "" && b.profile !== "default")
          return json({ error: `this machine has no profile "${String(b.profile).slice(0, 80)}"; the profiles are: default`, profiles: ["default"] }, 409);
        const title = typeof b.title === "string" && b.title !== "New chat" ? b.title.slice(0, 200) : "";
        const text = typeof b.text === "string" ? b.text.trim().slice(0, 100_000) : "";
        const model = (typeof b.model === "string" && b.model) || (await providers.defaultModel().catch(() => ""));
        if (!model) return err("No model provider is set up.", 409);
        try { await providers.resolve(model); } catch (e) { return err(`${(e as Error).message}: pick another model`, 409); }
        const machine = typeof b.machine === "string" && b.machine && b.machine !== "local" ? b.machine : "";
        let s: Session;
        if (machine) {
          // Placed on a machine of the fleet: the page's own way, checks included.
          const start = ctx.startFleetSession;
          if (!start) return err("this daemon has no machines to start a session on", 409);
          const r = await start({ machine, model, title, ...(typeof b.workspace === "string" && b.workspace ? { workspace: b.workspace } : {}) });
          const out: any = await r.json();
          if (!r.ok) return err(String(out.error ?? "the session was not started there"), r.status);
          s = sessionShown(out.session.id)!;
        } else {
          const ws = typeof b.workspace === "string" && b.workspace ? b.workspace : ctx.workspace;
          if (!isAbsolute(ws)) return err("give the folder as an absolute path on this machine", 400);
          const folder = resolvePath(ws);
          if (!existsSync(folder) || !statSync(folder).isDirectory()) return err(`not a folder on this machine: ${folder}`, 400);
          s = store.createSession({ model, workspace: folder, title });
          bus.emit({ t: "session", session: s });
        }
        if (text) {
          if (dev.nolock && UNASKED.has(ctx.gate()?.perm(s.id).mode ?? "ask"))
            return json({ chat: chatFull(s), error: "This phone has no screen lock, so it can only prompt chats where every tool call asks" }, 403);
          engine.send(s.id, text, { mode: "send" });
        }
        return json({ chat: chatFull(sessionShown(s.id)!) });
      })),
    },
    "/v1/chats/:cid": {
      PATCH: signed(withBody((req, _d, b) => {
        const s = chat(req.params.cid!);
        if (!s) return err("unknown chat", 404);
        const title = typeof b.title === "string" ? b.title.slice(0, 200) : undefined;
        const flag = (v: unknown) => (typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : undefined);
        const archived = flag(b.archived), pinned = flag(b.pinned);
        if (title === undefined && archived === undefined && pinned === undefined) return err("no supported fields", 400);
        if (pinned !== undefined) store.mergeSettings(s.id, { pinned_ms: pinned ? (s.settings.pinned_ms ?? Date.now()) : null });
        const next = title !== undefined || archived !== undefined ? store.updateSession(s.id, { title, ...(title !== undefined ? { title_by: "" as const } : {}), archived }) : sessionShown(s.id)!;
        bus.emit({ t: "session", session: next });
        return json({ chat: chatFull(next) });
      })),
    },
    "/v1/chats/:cid/messages": {
      GET: signed(async (req) => {
        const s = await warmed(req.params.cid!);
        if (!s) return err("unknown chat", 404);
        const page = chatMessages(s, new URL(req.url).searchParams);
        return page ? json(page) : err("that message is not on this chat's shown branch; reload the chat", 409);
      }),
      // `client_id` names the send, made by the phone and kept with its draft
      // until an answer arrives. The same id again (the answer was lost) gets
      // the receipt of the prompt it already stored and stores nothing; the
      // mode may differ by then (the first attempt started the turn). A send
      // without one is a new prompt each time.
      POST: signed(withBody(async (req, dev, b) => {
        const text = String(b.text ?? b.caption ?? "").trim();
        // What the phone uploaded goes with the words, or nothing is sent.
        const refs: any[] = Array.isArray(b.attachments) ? b.attachments : [];
        const ids = refs.map((r) => String(r?.id ?? r?.media ?? ""));
        const clientId = typeof b.client_id === "string" ? b.client_id.trim() : "";
        if (clientId.length > CLIENT_ID_MAX) return err(`the send id is longer than ${CLIENT_ID_MAX} characters`, 400);
        const fingerprint = sha256Hex(JSON.stringify([req.params.cid, text, ids]));
        const prior = clientId ? mobile.sendOf(dev.id, clientId) : undefined;
        if (prior) {
          if (prior.fingerprint !== fingerprint) return err("this send id was used for another message; send this one under a new id", 409);
          if (!chat(prior.session_id)) return err("unknown chat", 404);
          return json({ message: receiptNow(prior), replayed: true });
        }
        const images: any[] = [];
        for (const [i, r] of refs.entries()) {
          const id = ids[i]!;
          const path = attachmentPath(id);
          if (!path) return err(`attachment ${id.slice(0, 80) || "(no id)"} is not stored here; upload it again`, 400);
          const bytes = readFileSync(path);
          // An image is what its bytes are, not what the request calls it: a
          // file that only claims to be one goes as a file, never as an image
          // block a provider would refuse the whole request for.
          const mime = uploadType(bytes, String(r?.mime ?? Bun.file(path).type ?? ""));
          images.push(mime.startsWith("image/") ? { type: "image", media_type: mime, data: bytes.toString("base64") }
            : saveAttachment(bytes, String(r?.file_name ?? r?.name ?? basename(path)), mime));
        }
        if (!text && !images.length) return err("empty", 400);
        const s = chat(req.params.cid!);
        if (!s) return err("unknown chat", 404);
        if (s.archived) return err("the chat is archived", 409);
        if (dev.nolock && UNASKED.has(ctx.gate()?.perm(s.id).mode ?? "ask"))
          return err("This phone has no screen lock, so it can only prompt chats where every tool call asks", 403);
        // While a turn runs: steer (the default) joins it, queue waits for it.
        const mode = b.mode === "queue" ? "queue" : b.mode === "steer" ? "steer" : "send";
        // The prompt and its receipt are one write: a daemon that stops between
        // them has neither, and the retry stores the prompt once.
        // Fitted and stored in the order the session's prompts came.
        const message = await fitted(s.id, images, (fit) => store.atomic(s.id, () => {
          // Read again inside the write: the same send may have come in while the images were fitted.
          const now = clientId ? mobile.sendOf(dev.id, clientId) : undefined;
          if (now) return receiptNow(now);
          const r: any = engine.send(s.id, text, { mode, images: fit });
          const message = r.event
            ? toMsg(r.event, mobile.gseqOf(r.event.id))
            : { id: r.queued.id, chat_id: s.id, role: "user", kind: r.steer ? "steer" : "queued", content: r.queued.text ?? text, meta: {}, ts: secs(Date.now()), seq: 0 };
          if (clientId) mobile.recordSend(dev.id, clientId, { session_id: s.id, fingerprint, event_id: r.event?.id ?? null, queue_id: r.queued?.id ?? null, receipt: JSON.stringify(message) });
          return message;
        }));
        return json({ message });
      })),
    },
    // Read on the phone is read everywhere: the same alerts the workbench counts.
    // Reading answers nothing: a pending approval stays pending.
    "/v1/chats/:cid/read": {
      POST: signed((req) => {
        if (!chat(req.params.cid!)) return err("unknown chat", 404);
        alerts.markRead({ session_id: req.params.cid! });
        return json({ ok: true });
      }),
    },
    "/v1/chats/:cid/stop": { POST: signed(async (req) => { await engine.interrupt(req.params.cid!, "phone"); return json({ ok: true }); }) },
    // The command the session's turn waits on now, which the owner can move behind its call (the page's Move to the background):
    // its words (the description the model gave it, else the command) and when it began, or none. A session whose tools run on
    // another machine says none: that command is moved on the computer.
    "/v1/chats/:cid/command": {
      GET: signed(async (req) => {
        const s = await warmed(req.params.cid!);
        if (!s) return err("unknown chat", 404);
        const c = s.machine ? undefined : commandInFront(s.id);
        return json({ chat_id: s.id, front: c ? { job: c.job, call: c.call ?? null, command: c.command.slice(0, COMMAND_CHARS), since: secs(c.started) } : null });
      }),
    },
    // Moves it behind its call: the call returns at once with the command's ID, the command goes on and its end starts the
    // next turn. `moved` is false when it ended or moved meanwhile (the owner is told it is no longer in front).
    "/v1/chats/:cid/background": {
      POST: signed(withBody(async (req, _d, b) => {
        const s = await warmed(req.params.cid!);
        if (!s) return err("unknown chat", 404);
        if (s.machine) return err(`This session's commands run on ${s.machine}: move it on the computer.`, 409);
        const call = typeof b.call === "string" && b.call ? b.call : undefined;
        return json({ chat_id: s.id, moved: moveToBackground(s.id, call ? { call } : {}) });
      })),
    },
    "/v1/chats/:cid/run": {
      GET: signed(async (req) => {
        const s = await warmed(req.params.cid!);
        if (!s) return err("unknown chat", 404);
        // The tool calls of the latest turn on the shown branch, one step each.
        const line = store.lineage(s.id);
        const start = line.findLastIndex((e) => e.kind === "turn_start");
        const steps = (start < 0 ? [] : line.slice(start)).flatMap((e) => (e.kind === "assistant" ? (e.data.blocks ?? []) : [])
          .filter((b: any) => b.type === "tool_use").map((b: any) => ({ tool: b.name, ts: secs(e.ts), what: stepWhat(b.input) })));
        // The saved selection, where the Run screen reads it: the model the next
        // turn uses, not a claim about who answered before.
        return json({ chat_id: s.id, working: engine.isRunning(s.id), model: s.model, session: sessionUsage(s), steps, approvals: pendingApprovals(s.id) });
      }),
    },
    // What the session changed in its folder, read-only: each turn's files with their counts, newest
    // first, and the files changed since its first turn (`session`). A file's diff is asked for on its
    // own (`/changes/diff`): a phone reads one file at a time. A session whose tools run on another
    // machine, or a daemon that keeps no checkpoints, says so in `unavailable`.
    "/v1/chats/:cid/changes": {
      GET: signed(async (req) => {
        const s = await warmed(req.params.cid!);
        if (!s) return err("unknown chat", 404);
        const c = ctx.checkpoints?.();
        const none = (why: string) => json({ chat_id: s.id, turns: [], session: [], expired: 0, scope: "tree", unavailable: why });
        if (s.machine) return none(`This session's files are on ${s.machine}: its changes are read on the computer.`);
        if (!c) return none("This daemon keeps no checkpoints, so it cannot say what a turn changed.");
        try {
          const { turns, expired } = await c.turns(s);
          // A turn's place among the session's turns (its first is 1), as the page numbers it.
          // (The starts alone, from the index that holds only those columns, on the read thread.)
          const starts = turns.length ? (await readsOf(store).sql<{ seq: number }>("SELECT seq FROM events INDEXED BY events_bare WHERE session_id = ? AND kind = 'turn_start' ORDER BY seq", [s.id])).map((r) => r.seq) : [];
          const place = new Map(starts.map((seq, i) => [seq, i + 1]));
          const all = await c.diff(s, {});
          return json({
            chat_id: s.id, expired, scope: all.scope,
            session: all.files.map(fileOf),
            turns: turns.filter((t) => t.files.length || t.unavailable || t.incomplete).reverse().map((t) => ({
              turn: t.turn, n: place.get(t.turn) ?? null, prompt: t.prompt, ts: secs(t.created), added: t.added, removed: t.removed, files: t.files.map(fileOf),
              ...(t.incomplete ? { incomplete: true } : {}), ...(t.elsewhere ? { elsewhere: t.elsewhere } : {}), ...(t.unavailable ? { unavailable: t.unavailable } : {}),
            })),
          });
        } catch (e) {
          if (e instanceof Bad) return none(e.message);
          throw e;
        }
      }),
    },
    // One file's diff: of one turn (`turn`, its place in the history as /changes gives it), or since the
    // session's first turn. Capped where the page caps a diff (`truncated`).
    "/v1/chats/:cid/changes/diff": {
      GET: signed(async (req) => {
        const s = await warmed(req.params.cid!);
        if (!s) return err("unknown chat", 404);
        const c = ctx.checkpoints?.();
        if (!c || s.machine) return err("this session's changes are not read here", 409);
        const q = new URL(req.url).searchParams;
        const path = q.get("path") ?? "";
        if (!path || path.startsWith("/") || path.split("/").includes("..")) return err("give the file's path, relative to the session's folder", 400);
        const turn = q.has("turn") ? Number(q.get("turn")) : undefined;
        if (turn !== undefined && !Number.isInteger(turn)) return err("turn is a number", 400);
        try {
          const d = await c.diff(s, { turn, paths: [path] });
          const f = d.files.find((x) => x.path === path);
          return json({ chat_id: s.id, path, status: f?.status ?? "", added: f?.added ?? 0, removed: f?.removed ?? 0, diff: d.diff, truncated: d.truncated });
        } catch (e) {
          if (e instanceof Bad) return err(e.message, e.status);
          throw e;
        }
      }),
    },
    "/v1/chats/:cid/usage": {
      GET: signed(async (req) => {
        const s = await warmed(req.params.cid!);
        if (!s) return json({ chat_id: req.params.cid, session: null });
        // The latest finished turn on the shown branch, with its answering model.
        const line = store.lineage(s.id);
        const end = line.findLast((e) => e.kind === "turn_end");
        const answered = end ? line.slice(0, line.indexOf(end)).findLast((e) => e.kind === "assistant")?.data.model : undefined;
        const u = end?.data.usage;
        const endAt = end ? line.indexOf(end) : -1;
        const startAt = line.slice(0, Math.max(0, endAt)).findLastIndex((e) => e.kind === "turn_start");
        const turn = u ? { ...tokens(u), model: answered ?? null, calls: line.slice(startAt + 1, endAt).filter((e) => e.kind === "assistant").length } : undefined;
        return json({ chat_id: s.id, session: sessionUsage(s), ...(turn ? { turn } : {}) });
      }),
    },
    // An agent's chat explained in five lines (src/automation/lane-line.ts): what it is doing, what it
    // waits for and since when, what went wrong, what it changed, what comes next. Each line says
    // where it is from: a fact Keel keeps, the agent's own words, or a fact that is missing.
    "/v1/chats/:cid/lane": {
      GET: signed(async (req) => {
        const s = sessionShown(req.params.cid!);
        const a = s?.parent_id ? agentByChild(s.id) : undefined;
        if (!s || !a) return err("not an agent's chat", 404);
        const l = await laneOf(a.id);
        if (!l) return err("not an agent's chat", 404);
        return json({ chat_id: s.id, lines: l.lines.map((x) => ({ ...x, ...(x.at ? { at: secs(x.at) } : {}) })), text: laneText(l.lines), ts: secs(l.at) });
      }),
    },
    "/v1/approvals/:aid": { POST: signed(withBody(approve)) },
    // A file for the next message: stored by content, sent with the message
    // that names it (attachments: [{ id }]). At most ATTACHMENT_MAX bytes
    // (`/v1/me` says it). `kind` says how the model gets it: "image" for a
    // PNG, JPEG, GIF or WebP by its bytes (the model sees it), "file" for
    // anything else (text inline, a PDF as a document where the model reads
    // them, the rest by its saved path), a photo in another format included.
    // The stored type is uploadType's: by the bytes, the claim only for text.
    "/v1/upload": {
      POST: signed((req, _d, body) => {
        if (!body.length) return err("the file is empty", 400);
        const q = new URL(req.url).searchParams;
        const a = saveAttachment(body, q.get("name") || "file", uploadType(body, q.get("mime") || req.headers.get("content-type") || ""));
        return json({ id: a.id, media: a.id, kind: a.media_type.startsWith("image/") ? "image" : "file", mime: a.media_type, file_name: a.name, size: a.size });
      }, ATTACHMENT_MAX),
    },
    "/v1/media/:id": {
      GET: signed((req) => {
        const inline = PROMPT_IMAGE.exec(req.params.id!);
        if (inline) {
          const b = store.event(inline[2]!)?.data.images?.[Number(inline[1])];
          if (b?.type !== "image") return err("no such file", 404);
          return new Response(Buffer.from(b.data, "base64"), { headers: { "content-type": b.media_type, "x-content-type-options": "nosniff" } });
        }
        const path = attachmentPath(req.params.id!);
        if (!path) return err("no such file", 404);
        return new Response(readFileSync(path), { headers: { "content-type": Bun.file(path).type || "application/octet-stream", "x-content-type-options": "nosniff" } });
      }),
    },
    // Loops, as the app's cron jobs.
    "/v1/cron": {
      GET: signed(() => json({
        jobs: loops.list().map((l) => ({
          id: l.id, name: l.name, schedule: l.schedule_text, enabled: l.enabled, prompt: l.prompt, chat_id: l.session_id,
          last_status: l.last_status ?? null, paused_reason: l.disabled_reason ?? null, next: l.next_ms ? secs(l.next_ms) : null,
          runs: loops.runs(l.id, 5).map((r) => ({ id: r.id, ts: secs(r.started_ms ?? r.due_ms), ok: r.ok ?? null, outcome: r.skip_reason ? "skipped" : r.outcome ?? null, detail: r.detail ?? r.skip_reason ?? null })),
        })),
        now: secs(Date.now()),
      })),
    },
    "/v1/cron/:jid/:action": {
      POST: signed((req) => {
        const id = req.params.jid!, action = req.params.action;
        if (!loops.get(id)) return err("unknown job", 404);
        const job =
          action === "pause" ? loops.update(id, { enabled: false })
          : action === "resume" ? loops.update(id, { enabled: true })
          : action === "run" ? loops.runNow(id)
          : null;
        return job ? json({ job }) : err("the action is pause, resume or run", 400);
      }),
    },
    "/v1/pulse": {
      GET: signed(() => {
        return json({ ...pulse(), working: working(), live_sessions: sessionsShown(), approvals: pendingApprovals(), ...(ctx.live ? { live: liveData(ctx.live()) } : {}) });
      }),
    },
    // The owner's helper: turned on and off, what it was told lately, and its memory, seen and pruned
    // (src/helper/). Its conversation is a chat of the list (`helper: 1`), talked to as any other.
    // The helper's picture: the bytes the owner kept, under the mark `face` names, so a phone fetches one once.
    "/v1/helper/face": {
      GET: signed(() => {
        const h = ctx.helper?.();
        const f = h?.avatarFile();
        const bytes = f && h!.files.read(f.path);
        return bytes ? new Response(bytes as unknown as BodyInit, { headers: { "content-type": f.type, "x-content-type-options": "nosniff", "cache-control": "private, max-age=31536000, immutable" } }) : err("no picture", 404);
      }),
    },
    "/v1/helper": {
      GET: signed(() => { const h = ctx.helper?.(); return h ? json(helperOf(h)) : err("this daemon runs no helper", 409); }),
      PATCH: signed(withBody(async (_r, _d, b) => {
        const h = ctx.helper?.();
        if (!h) return err("this daemon runs no helper", 409);
        if (typeof b.on !== "boolean") return err("give on: true or false", 400);
        await h.setOn(b.on);
        return json(helperOf(h));
      })),
    },
    // A question from the helper row, spoken (the phone's own recognizer: words, never audio) or typed.
    // Its turn only reads; what the answer offers the owner does with a tap, through the routes above.
    "/v1/helper/ask": {
      POST: signed(withBody(async (_r, _d, b) => {
        const h = ctx.helper?.();
        if (!h) return err("this daemon runs no helper", 409);
        if (typeof b.text !== "string" || !b.text.trim()) return err("give text: the question", 400);
        if (b.client_id !== undefined && (typeof b.client_id !== "string" || !b.client_id || b.client_id.length > 100)) return err("client_id is a string of at most 100 characters", 400);
        try {
          const r = await h.ask(b.text, "phone", b.client_id);
          return json("duplicate" in r ? { id: null, chat_id: r.chat_id, duplicate: true } : r);
        } catch (e: any) {
          return err(e?.message ?? String(e), e?.status ?? 500);
        }
      })),
    },
    "/v1/helper/ask/:id": {
      GET: signed(async (req) => {
        const h = ctx.helper?.();
        if (!h) return err("this daemon runs no helper", 409);
        const a = await h.answer(askId(String(req.params.id)));
        return a ? json(helperAnswerOf(a)) : err("no such question", 404);
      }),
    },
    "/v1/helper/memory": {
      GET: signed((req) => {
        const h = ctx.helper?.();
        if (!h) return err("this daemon runs no helper", 409);
        const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
        if (!q) return json({ items: h.memory().slice(0, MEMORY_PAGE).map(recordOf), total: h.records.index.size });
        const f = h.records.index.find(q, MEMORY_PAGE);
        return json({ items: f.hits.map((x) => h.records.index.byKey.get(x.key)).filter((m): m is MemoryRecord => !!m).map(recordOf), total: f.total });
      }),
    },
    "/v1/helper/memory/:key": {
      DELETE: signed((req) => {
        const h = ctx.helper?.();
        if (!h) return err("this daemon runs no helper", 409);
        const key = paramKey(req.params.key!);
        if (key === null) return err("the key is not a URL-encoded key", 400);
        return h.records.forget(key) ? json({ ok: true }) : err("no such record", 404);
      }),
    },
    "/v1/sessions": { GET: signed(() => json({ sessions: sessionsShown() })) },
    "/v1/commands": { GET: signed(() => json({ commands: [{ name: "stop", description: "Interrupt the running turn", args: "", category: "Core" }] })) },
    "/v1/devices": {
      GET: signed((_r, dev) => json({ devices: mobile.devices().map(({ pub, apub, ...d }) => d), this: dev.id })),
    },
    // A device may always revoke itself. Revoking another is the owner's call:
    // the approval key signs `revoke\n<id>\n<ts>`, and a phone without a screen
    // lock cannot do it at all.
    "/v1/devices/:did": {
      DELETE: signed(async (req, dev) => {
        const did = req.params.did!;
        if (did !== dev.id) {
          if (dev.nolock) return err("This phone has no screen lock, so it can only revoke itself", 403);
          if (!(await approvalSigned(req, dev, revokeMessage(did, req.headers.get("x-hm-ts") ?? ""), "revoke")))
            return err("biometric signature required to revoke another device", 403);
        }
        const ok = mobile.revoke(did);
        ctx.changed();
        return json({ ok });
      }),
    },
    "/v1/fcm": {
      POST: signed(withBody((_r, dev, b) => {
        const token = typeof b.token === "string" ? b.token : "";
        if (token.length > 4096 || /[\x00-\x1f\x7f]/.test(token)) return err("token is not a push token", 400);
        mobile.setPushToken(dev.id, token);
        ctx.changed();
        return json({ ok: true, push: push.configured() });
      })),
    },
    "/v1/push-config": {
      // `app` names the asking app's package, so each app gets its own Firebase entry.
      GET: signed((req) => {
        const app = new URL(req.url).searchParams.get("app")?.trim() || undefined;
        const { config, missing } = push.clientConfig(app);
        return json({ enabled: !!config, config: config ?? {}, ...(config ? {} : { missing }) });
      }),
    },
    "/v1/push/ack": {
      POST: signed(withBody((_r, dev, b) => {
        if (!mobile.ackPush(dev.id, String(b.id ?? "").trim())) return err("unknown push", 404);
        ctx.changed();
        return json({ ok: true });
      })),
    },
  };
}

// The pairing page, in the workbench's colors: steel and ink, ink buttons.
function pairPage(keel: string, hermes: string) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Pair with Keel</title>
<style>
:root{--bg:#ebeef1;--raised:#f9fafb;--line:#ccd1d7;--fg:#11161f;--muted:#464e58;--ink:#11161f;--ink-fg:#f3f5f8}
@media (prefers-color-scheme:dark){:root{--bg:#12181e;--raised:#181f27;--line:#262c33;--fg:#e4e8ed;--muted:#a5acb4;--ink:#e4e8ed;--ink-fg:#11161d}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:16px/1.5 "IBM Plex Sans",system-ui,sans-serif}
main{width:min(22rem,88vw);display:flex;flex-direction:column;gap:1.25rem}
h1{margin:0;font:600 1.6rem/1.2 "Martian Mono",ui-monospace,monospace;letter-spacing:-.03em}p{margin:0;color:var(--muted)}
a{display:block;text-align:center;text-decoration:none;font-weight:600;border-radius:.5rem;padding:.875rem 1.125rem}
.open{background:var(--ink);color:var(--ink-fg)}.alt{border:1px solid var(--line);background:var(--raised);color:var(--fg);font-weight:500}
small{color:var(--muted)}
</style>
<main><svg width="44" height="44" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#0e6a80"/><path d="M6 11.5h20c-1.1 4.9-5 7.6-10 7.6s-8.9-2.7-10-7.6z" fill="#f4faf9"/><path d="M14.6 18.6h2.8l-.7 6.4h-1.4z" fill="#f4faf9"/></svg>
<h1>Pair this phone</h1><p>Open the link in the Keel app on this phone. The code works once and expires soon.</p>
<a class="open" data-app="keel" href="${keel}">Open in Keel</a>
<a class="alt" data-app="hermes" href="${hermes}">Open in the Hermes app instead</a>
<small>Keep this link private: whoever opens it first pairs a device.</small></main></html>`;
}

// Token counts as the app reads them: prompt_tokens is every input token,
// cached or not, beside its parts.
function tokens(u: { input?: number; output?: number; cache_read?: number; cache_write?: number; cost?: number }) {
  const input = u.input ?? 0, cr = u.cache_read ?? 0, cw = u.cache_write ?? 0;
  return { prompt_tokens: input + cr + cw, input_tokens: input, output_tokens: u.output ?? 0, cache_read_tokens: cr, cache_write_tokens: cw, cost: u.cost ?? null };
}
const sessionUsage = (s: Session) => ({ model: s.model, ...tokens(s.usage) });

// One line for a tool step: the input's command, path or first short string.
function stepWhat(input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  for (const k of ["command", "cmd", "description", "file_path", "path", "pattern", "url", "query", "prompt"]) if (typeof input[k] === "string" && input[k].trim()) return input[k].trim().slice(0, 200);
  const v = Object.values(input).find((x) => typeof x === "string" && x.trim());
  return typeof v === "string" ? v.trim().slice(0, 200) : undefined;
}

// What a question card carries of a choice's meaning and of its header, at most. A meaning is drawn whole
// under its label: 300 characters is about five lines at a phone's width at the default text size, and a
// longer one makes a single choice taller than the screen at a large text size. A header is a chip: the
// question tools ask for 12 or 16 characters, so twice the larger is room for any model that runs over.
// The whole words stay in the tool call, which the session shows.
const DETAIL_CHARS = 300;
const HEADER_CHARS = 32;
const clipped = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}\u2026` : text);

// The question tools' inputs, in one shape.
function normQuestions(input: any): { id: string; question: string; header?: string; options: { label: string; description?: string }[]; multi: boolean }[] {
  const list = Array.isArray(input?.questions) ? input.questions : input?.question ? [input] : [];
  return list.map((q: any, i: number) => ({
    id: String(q.id ?? i),
    question: String(q.question ?? ""),
    ...(typeof q.header === "string" && q.header.trim() ? { header: q.header.trim() } : {}),
    multi: !!(q.multiSelect ?? q.multi_select ?? q.multiple),
    options: (q.type === "yesno" ? ["Yes", "No"] : Array.isArray(q.options) ? q.options : []).map((o: any) => ({
      label: String(typeof o === "string" ? o : o?.label ?? ""),
      ...(typeof o?.description === "string" && o.description.trim() ? { description: o.description.trim() } : {}),
    })),
  }));
}
