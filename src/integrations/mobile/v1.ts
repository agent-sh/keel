// Hermes Mobile API v1: the routes the phone app calls. Every route but health
// and pair needs the device's bearer token and a request signature; approvals
// and revoking another device also need the approval key's signature.
import { holdStream } from "../../server/streams.ts";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename } from "node:path";
import { ATTACHMENT_MAX, attachmentPath, saveAttachment } from "../../engine/attachments.ts";
import { TEXT_MEDIA } from "../../engine/compact.ts";
import { imageType } from "../../engine/images.ts";
import type { Server } from "bun";
import type { Session, StoredEvent } from "../../core/types.ts";
import type { Approval, Gate } from "../../safety/gate.ts";
import type { Deps } from "../../server/app.ts";
import { answer, closedQuestions, pendingQuestions, type Answers } from "../../tools/interact.ts";
import * as alerts from "../../automation/alerts.ts";
import * as loops from "../../automation/loops.ts";
import { sessionState } from "../../automation/state.ts";
import { lineage } from "../../core/tree.ts";
import * as push from "./push.ts";
import {
  answersText, approvalMessage, canonicalMessage, checkAndClaim, loadSpki, PairLimiter, REPLAY_VERSION, requestSource, revokeMessage, sha256Hex,
} from "./sig.ts";
import type { Device, MobileStore, SendRecord } from "./store.ts";
import { fitted } from "../../engine/image-fit.ts";

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

export type MobileCtx = Deps & { mobile: MobileStore; gate: () => Gate | undefined; changed: () => void };

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

// Where a chat stands, as the phone's list shows it: a card waits for the
// owner, a turn runs or its agents still work (agents: how many), or how the
// last turn ended.
export type ChatStatus = "needs_you" | "working" | "failed" | "stopped" | "done" | "idle";
export type ChatExtra = { unread?: number; preview?: { text: string; role: string; id: string } | null; status?: ChatStatus; failure?: string; agents?: number };

export function chatOf(s: Session, lastSeq = 0, x: ChatExtra = {}) {
  const c: Record<string, unknown> = {
    id: s.id, title: s.title || "New chat", kind: "chat", created: secs(s.created), updated: secs(s.updated), unread: x.unread ?? 0,
    pinned: s.settings.pinned_ms ? 1 : 0, archived: s.archived ? 1 : 0, seq: lastSeq, parent_id: s.parent_id ?? null,
  };
  if (x.status) c.status = x.status;
  if (x.failure) c.failure = x.failure;
  if (x.agents) c.agents = x.agents;
  if (x.preview !== undefined) Object.assign(c, { preview: x.preview?.text ?? "", last_role: x.preview?.role ?? "", preview_id: x.preview?.id ?? null });
  return c;
}

// How a turn that did not finish ended, as the workbench says it.
const OUTCOME: Record<string, string> = {
  interrupted: "Stopped before the reply finished", restart: "Cut by a daemon restart", max_tokens: "Cut at the output limit",
  max_steps: "Stopped at the step budget", refusal: "Declined",
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

export function approvalOf(a: Approval) {
  const actions: string[][] = [["Approve", "once", "primary"]];
  if (a.risk !== "high") actions.push(["This session", "session", ""]);
  actions.push(["Deny", "deny", "danger"]);
  return {
    id: a.id, chat_id: a.session_id, session_key: a.session_id, kind: "permission",
    command: a.summary, description: a.why ? `${a.tool}: ${a.why}` : a.tool,
    actions, state: STATE[a.state] ?? a.state, choice: a.choice ?? null, ts: secs(a.created),
  };
}

// The card's place in the chat. It carries the card's state, so a chat read
// after the card closed never offers a decision on it.
const approvalMsg = (a: { id: string; chat_id: string; kind: string; command: string; description: string; state: string; ts: number | null }) => ({
  id: `apr-${a.id}`, chat_id: a.chat_id, role: "agent", kind: "approval", content: a.description,
  meta: { approval_id: a.id, card: a.kind, command: a.command, description: a.description, state: a.state }, ts: a.ts ?? secs(Date.now()), seq: 0,
});

export function mobileApi(ctx: MobileCtx) {
  const { store, bus, engine, providers, errors, mobile } = ctx;
  const limiter = new PairLimiter();
  const lastSeq = (sid: string) => store.db.query<{ n: number | null }, [string]>("SELECT MAX(seq) AS n FROM events WHERE session_id = ?").get(sid)!.n ?? 0;
  const allSessions = () => [...store.sessions(), ...store.sessions({ archived: true })];
  // When the running turn started: the phone's elapsed timer counts from it,
  // whatever the turn stored since.
  // A turn that has not stored its start yet (the session just went working)
  // starts now, not at the previous turn's start.
  const turnBounds = (sid: string) => store.db.query<{ st: number | null; en: number | null }, [string]>(
    "SELECT MAX(CASE WHEN kind = 'turn_start' THEN ts END) AS st, MAX(CASE WHEN kind = 'turn_end' THEN ts END) AS en FROM events WHERE session_id = ?").get(sid)!;
  const since = (s: Session) => { const b = turnBounds(s.id); return secs(b.st !== null && (b.en === null || b.st > b.en) ? b.st : s.updated); };
  const working = () => store.sessions().filter((s) => engine.isRunning(s.id)).map((s) => ({ chat_id: s.id, since: since(s) }));
  const msgCtx: MessageCtx = { titleOf: (sid) => store.session(sid)?.title, parentOf: (sid) => store.session(sid)?.parent_id ?? null };
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
  function status(s: Session): { status: ChatStatus; failure?: string; agents?: number } {
    const st = sessionState(s, { from: { store, engine } });
    const agents = st.agents ? { agents: st.agents } : {};
    if (pendingApprovals(s.id).length) return { status: "needs_you", ...agents };
    if (st.watch === "work" || engine.isRunning(s.id)) return { status: "working", ...agents };
    let id = s.head;
    for (let i = 0; id && i < 200; i++) {
      const e = store.event(id);
      if (!e) break;
      if (e.kind === "error") return { status: "failed", failure: String(e.data.message ?? "the turn failed").split("\n")[0]!.slice(0, 200) };
      if (e.kind === "turn_end") {
        if (e.data.reason === "interrupted") return { status: "stopped" };
        if (NORMAL_STOP.has(e.data.reason)) return { status: "done" };
        return { status: "failed", failure: OUTCOME[e.data.reason] ?? `ended: ${e.data.reason}` };
      }
      if (e.kind === "user" && !originOf(e, () => undefined, () => null)) return { status: "idle" };
      id = e.parent;
    }
    return { status: "idle" };
  }
  const chatFull = (s: Session, u = unread()) => chatOf(s, lastSeq(s.id), { unread: u[s.id] ?? 0, preview: preview(s), ...status(s) });

  // Questions the model asked that wait for the owner, as approval cards. Each
  // pending call is read from its own tool call, however far back it is.
  function questionCard(s: Session, callId: string) {
    const e = store.db.query<any, [string, string]>("SELECT * FROM events WHERE session_id = ? AND kind = 'assistant' AND instr(data, ?) > 0 ORDER BY seq DESC LIMIT 1").get(s.id, JSON.stringify(callId));
    const tu = e ? (JSON.parse(e.data).blocks ?? []).find((b: any) => b.type === "tool_use" && b.id === callId) : undefined;
    const qs = tu ? normQuestions(tu.input) : [];
    const options = qs.flatMap((q) => q.options.map((o) => o.label));
    return {
      id: `q-${callId}`, chat_id: s.id, session_key: s.id, kind: "question",
      command: tu ? qs.map((q) => q.question).join("\n") || "A question" : "This question is no longer stored; answer it in the workbench",
      description: options.join(" / "), options, unavailable: !tu,
      // One entry per question, by id: a card of several takes one answer each.
      questions: qs.map((q) => ({ id: q.id, question: q.question, options: q.options.map((o) => o.label), multi: q.multi })),
      // Just after its tool call's row in the chat (traceOf), not before the words of the reply that asks.
      actions: [["Answer", "once", "primary"], ["Dismiss", "deny", "danger"]], state: "pending", choice: null, ts: e ? (e.ts + (e.seq % 1000) / 1000 + 0.0008) / 1000 : null,
    };
  }
  // A question that stopped waiting, with what was picked (by question id), as
  // the desktop shows it: from this daemon's record, else the stored result.
  function closedQuestion(q: { call_id: string; session_id: string; at: number; answered: boolean; answers?: Answers }) {
    const s = store.session(q.session_id);
    const base = s ? questionCard(s, q.call_id) : { id: `q-${q.call_id}`, chat_id: q.session_id, session_key: q.session_id, kind: "question", command: "", description: "", options: [], questions: [] };
    let answers = q.answers;
    if (!answers && q.answered) {
      const r = store.db.query<{ data: string }, [string, string]>("SELECT data FROM events WHERE session_id = ? AND kind = 'tool_result' AND instr(data, ?) > 0 ORDER BY seq DESC LIMIT 1").get(q.session_id, JSON.stringify(q.call_id));
      answers = r ? JSON.parse(r.data).shown?.[q.call_id]?.answers : undefined;
    }
    return { ...base, actions: [], state: q.answered ? "approved" : "expired", choice: q.answered ? "once" : null, ts: secs(q.at), ...(answers ? { answers } : {}) };
  }
  function questions(sessionId?: string) {
    const out: any[] = [];
    for (const s of sessionId ? [store.session(sessionId)].filter(Boolean) as Session[] : store.sessions()) {
      for (const callId of pendingQuestions(s.id)) out.push(questionCard(s, callId));
    }
    return out;
  }
  const pendingApprovals = (sessionId?: string) => [
    ...(ctx.gate()?.approvals({ session: sessionId, pending: true }) ?? []).map(approvalOf),
    ...questions(sessionId),
  ];
  // Cards that closed after `sinceMs` (answered on the desktop, say): the app
  // keeps cards it saw until it hears they closed, and cancels their notification then.
  const closedCards = (sinceMs: number) => [
    ...(ctx.gate()?.approvals() ?? []).filter((a) => a.state !== "pending" && (a.resolved ?? a.created) >= sinceMs).map(approvalOf),
    ...closedQuestions(sinceMs).map((q) => closedQuestion(q)),
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
    // cannot relay its retry here. A first claim needs none.
    const ts = req.headers.get("x-hm-ts") ?? "", sig = req.headers.get("x-hm-sig") ?? "";
    const here = urlOrigin(mobile.setting("public_url") ?? new URL(req.url).origin);
    const proven = !!sig && !!here && urlOrigin(String(b.server ?? "")) === here
      && (await checkAndClaim(sig, String(b.pub), canonicalMessage(req.method, new URL(req.url).pathname, ts, raw), ts, "pair", now, mobile)) === "valid";
    const got = mobile.claimPairCode(String(b.code ?? ""), String(b.device_name ?? "phone"), b.pub, b.apub, b.lock === false, proven);
    if (!got) {
      limiter.fail(source, now);
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
    if (aid.startsWith("q-")) {
      const callId = aid.slice(2);
      const card = questions().find((q) => q.id === aid);
      if (!card) return err("this question is no longer waiting", 409);
      if (choice !== "deny" && !text) return err("answer required for question", 400);
      const s = store.session(card.chat_id)!;
      const answers: Answers = {};
      const qs = card.questions as { id: string; options: string[]; multi: boolean }[];
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
      if (!answer(s.id, callId, answers)) return err("this question is no longer waiting", 409);
      return json({ approval: { ...card, actions: [], state: choice === "deny" ? "denied" : "approved", choice, answers }, resolved: 1 });
    }
    const g = ctx.gate();
    const a = g?.approval(aid);
    if (!g || !a) return err("unknown approval", 404);
    if (text) return err("answer only applies to questions", 400);
    if (a.state !== "pending") return err(`this approval is already ${STATE[a.state] ?? a.state}`, 409);
    const r = g.resolve(aid, a.session_id, { choice: choice as any, reason: choice === "deny" ? `denied from ${dev.name}` : undefined });
    if ("error" in r) return err(r.status === 409 ? `this approval is already ${STATE[g.approval(aid)?.state ?? ""] ?? "closed"}` : r.error, r.status);
    return json({ approval: approvalOf(g.approval(aid)!), resolved: 1 });
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
          const hello = (from: number) => {
            const sync = syncBody(from);
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
            const s = store.session(sid);
            const page = s ? chatMessages(s, RESET_PAGE) : null;
            if (s && page && send({ type: "chat_reset", seq: m, chat_id: sid, messages: page.messages, older: page.older, chat: chatFull(s) })) marks.set(sid, m);
          };
          if (resumes) hello(Math.max(0, Number(q.get("since")) || 0));
          else send({ type: "hello", seq: sent, working: working() });
          off = bus.on((f) => {
            try {
              if (f.t === "event") {
                const gseq = mobile.gseqOf(f.event.id);
                const s = store.session(f.event.session_id);
                branch(f.event.session_id);
                const out = msgsOf(f.event, gseq);
                const chat = s ? chatFull(s) : null;
                out.forEach((m, i) => send({ type: "message", seq: gseq, message: m, chat, ...(i === out.length - 1 ? { cursor: gseq } : {}) }));
                if (!lagged) sent = Math.max(sent, gseq);
                // A question answered elsewhere: its card closes on the phone too.
                if (f.event.kind === "tool_result") {
                  const ids = new Set(((f.event.data.results ?? []) as any[]).map((r) => r.tool_use_id));
                  for (const c of closedCards(f.event.ts - 60_000)) if (c.kind === "question" && ids.has(c.id.slice(2))) send({ type: "approval", seq: gseq, approval: c });
                }
              } else if (f.t === "delta" && f.kind === "text") send({ type: "delta", chat_id: f.session_id, delta: f.text });
              else if (f.t === "session") {
                // Gone on the desktop: the phone drops it. Renamed, archived or
                // pinned there: the phone's row follows without a sync.
                if (f.deleted) send({ type: "chat_removed", chat_id: f.session.id, seq: mobile.globalSeq() });
                else {
                  branch(f.session.id);
                  const s = store.session(f.session.id);
                  if (s) send({ type: "chat", seq: mobile.globalSeq(), chat: chatFull(s) });
                  send({ type: "working", chat_id: f.session.id, working: f.session.phase === "working", since: since(f.session) });
                }
              }
              else if (f.t === "feature" && f.name === "automation" && f.data?.kind === "alert" && f.data.data?.kind === "question" && !f.data.data.read && f.data.data.data?.call_id) {
                // A question raised: its card reaches the phone now, not at the next sync.
                const a = f.data.data;
                if (closedQuestions(0).some((q) => q.call_id === a.data.call_id)) return;
                const s = store.session(a.data.open_session ?? a.session_id);
                if (s) {
                  const q = questionCard(s, a.data.call_id);
                  send({ type: "approval", seq: mobile.globalSeq(), approval: q });
                  send({ type: "message", seq: mobile.globalSeq(), message: approvalMsg(q) });
                  send({ type: "chat", seq: mobile.globalSeq(), chat: chatFull(s) });
                }
              }
              else if (f.t === "feature" && f.name === "automation" && f.data?.kind === "agent" && f.data.data?.parent_id) {
                // An agent started or ended: its parent's row says whether it still works.
                const s = store.session(f.data.data.parent_id);
                if (s) send({ type: "chat", seq: mobile.globalSeq(), chat: chatFull(s) });
              }
              else if (f.t === "feature" && f.name === "approval") {
                const a = approvalOf(f.data as Approval);
                send({ type: "approval", seq: mobile.globalSeq(), approval: a });
                if (a.state === "pending") send({ type: "message", seq: mobile.globalSeq(), message: approvalMsg(a) });
                // The chat's row says it needs the owner, then that it does not.
                const s = store.session(a.chat_id);
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
  function syncBody(since: number) {
    const seq = mobile.globalSeq();
    const page = since > 0 && since <= seq ? mobile.eventsAfter(since, SYNC_PAGE + 1, SHOWN_KINDS) : [];
    const reload = since > seq ? "ahead" : page.length > SYNC_PAGE ? "behind" : undefined;
    const whole = since === 0 || !!reload;
    const u = unread();
    const all = allSessions();
    const moved = whole ? [] : mobile.branchesAfter(since).map((id) => store.session(id)).filter((s): s is Session => !!s)
      .map((s) => ({ id: s.id, page: chatMessages(s, RESET_PAGE)! }));
    const reset = new Set(moved.map((m) => m.id));
    // Cards that closed since the cursor's time, or within a push's lifetime.
    const from = Math.min(Date.now() - 15 * 60_000, whole ? Infinity : (mobile.tsOfGseq(since) ?? 0));
    return {
      // `more` is always false now: an older app pages while it is true.
      seq, more: false,
      // `complete`: the chats are every chat there is, so the app drops the
      // ones it holds that are not among them (deleted on the desktop).
      complete: true,
      ...(reload ? { reload } : {}),
      chats: all.map((s) => chatFull(s, u)),
      messages: whole ? store.sessions().sort((a, b) => b.updated - a.updated).slice(0, FIRST_CHATS).flatMap(recent) : [...page.filter((e) => !reset.has(e.session_id)).flatMap((e) => msgsOf(e, e.gseq)), ...moved.flatMap((m) => m.page.messages)],
      ...(moved.length ? { reset: moved.map((m) => ({ chat_id: m.id, older: m.page.older ?? null })) } : {}),
      approvals: [...pendingApprovals(), ...closedCards(from)],
      working: working(),
      // The reply each running turn has streamed so far.
      drafts: [...drafts].map(([chat_id, text]) => ({ chat_id, text })),
    };
  }

  const chat = (sid: string) => store.session(sid);

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
        const model = (await providers.defaultModel().catch(() => "")) || store.sessions()[0]?.model || null;
        return json({
          device: { id: dev.id, name: dev.name, created: dev.created }, name: host(), profile: "keel", model, agent_name: "Keel", user_name: "owner",
          models, profiles: ["default"], public_url: mobile.setting("public_url") ?? "",
          features: { radar: false, fleet: false, wake_wa: false, projects: false, rooms: false }, security: { signature_replay: REPLAY_VERSION },
          // What /v1/upload takes, so the app can say no before it sends the bytes.
          uploads: { max_bytes: ATTACHMENT_MAX, inline_images: INLINE_IMAGES },
        });
      }),
    },
    // `since` and `seq` are positions in the global event sequence, so a long
    // session never hides a newer event of a short one (syncBody).
    "/v1/sync": { GET: signed((req) => json(syncBody(Math.max(0, Number(new URL(req.url).searchParams.get("since")) || 0)))) },
    "/v1/events": { GET: signed((req, dev, _b, srv) => events(req, dev, srv)) },
    "/v1/chats": {
      GET: signed(() => { const u = unread(); return json({ chats: store.sessions().map((s) => chatFull(s, u)), working: working() }); }),
      POST: signed(withBody(async (_r, _d, b) => {
        // Profiles are not a Keel notion; the one profile is "default". A
        // remembered profile this daemon does not have is refused before a chat
        // exists, so the app can show the choice it has.
        if (b.profile !== undefined && b.profile !== null && b.profile !== "" && b.profile !== "default")
          return json({ error: `this machine has no profile "${String(b.profile).slice(0, 80)}"; the profiles are: default`, profiles: ["default"] }, 409);
        const model = await providers.defaultModel().catch(() => "");
        if (!model) return err("No model provider is set up.", 409);
        await providers.resolve(model);
        const s = store.createSession({ model, workspace: ctx.workspace, title: typeof b.title === "string" && b.title !== "New chat" ? b.title.slice(0, 200) : "" });
        bus.emit({ t: "session", session: s });
        return json({ chat: chatOf(s, 0, { preview: null }) });
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
        const next = title !== undefined || archived !== undefined ? store.updateSession(s.id, { title, archived }) : store.session(s.id)!;
        bus.emit({ t: "session", session: next });
        return json({ chat: chatFull(next) });
      })),
    },
    "/v1/chats/:cid/messages": {
      GET: signed((req) => {
        const s = chat(req.params.cid!);
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
    "/v1/chats/:cid/stop": { POST: signed(async (req) => { await engine.interrupt(req.params.cid!); return json({ ok: true }); }) },
    "/v1/chats/:cid/run": {
      GET: signed((req) => {
        const s = chat(req.params.cid!);
        if (!s) return err("unknown chat", 404);
        // The tool calls of the latest turn on the shown branch, one step each.
        const line = lineage(store.events(s.id), s.head);
        const start = line.findLastIndex((e) => e.kind === "turn_start");
        const steps = (start < 0 ? [] : line.slice(start)).flatMap((e) => (e.kind === "assistant" ? (e.data.blocks ?? []) : [])
          .filter((b: any) => b.type === "tool_use").map((b: any) => ({ tool: b.name, ts: secs(e.ts), what: stepWhat(b.input) })));
        // The saved selection, where the Run screen reads it: the model the next
        // turn uses, not a claim about who answered before.
        return json({ chat_id: s.id, working: engine.isRunning(s.id), model: s.model, session: sessionUsage(s), steps, approvals: pendingApprovals(s.id) });
      }),
    },
    "/v1/chats/:cid/usage": {
      GET: signed((req) => {
        const s = chat(req.params.cid!);
        if (!s) return json({ chat_id: req.params.cid, session: null });
        // The latest finished turn on the shown branch, with its answering model.
        const line = lineage(store.events(s.id), s.head);
        const end = line.findLast((e) => e.kind === "turn_end");
        const answered = end ? line.slice(0, line.indexOf(end)).findLast((e) => e.kind === "assistant")?.data.model : undefined;
        const u = end?.data.usage;
        const endAt = end ? line.indexOf(end) : -1;
        const startAt = line.slice(0, Math.max(0, endAt)).findLastIndex((e) => e.kind === "turn_start");
        const turn = u ? { ...tokens(u), model: answered ?? null, calls: line.slice(startAt + 1, endAt).filter((e) => e.kind === "assistant").length } : undefined;
        return json({ chat_id: s.id, session: sessionUsage(s), ...(turn ? { turn } : {}) });
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
        return json({ ...pulse(), working: working(), live_sessions: store.sessions(), approvals: pendingApprovals() });
      }),
    },
    "/v1/sessions": { GET: signed(() => json({ sessions: store.sessions() })) },
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

// The question tools' inputs, in one shape.
function normQuestions(input: any): { id: string; question: string; options: { label: string }[]; multi: boolean }[] {
  const list = Array.isArray(input?.questions) ? input.questions : input?.question ? [input] : [];
  return list.map((q: any, i: number) => ({
    id: String(q.id ?? i),
    question: String(q.question ?? ""),
    multi: !!(q.multiSelect ?? q.multi_select ?? q.multiple),
    options: (q.type === "yesno" ? ["Yes", "No"] : Array.isArray(q.options) ? q.options : []).map((o: any) => ({ label: String(typeof o === "string" ? o : o?.label ?? "") })),
  }));
}
