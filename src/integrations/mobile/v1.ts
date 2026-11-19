// Hermes Mobile API v1: the routes the phone app calls. Every route but health
// and pair needs the device's bearer token and a request signature; approvals
// and revoking another device also need the approval key's signature.
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename } from "node:path";
import { ATTACHMENT_MAX, attachmentPath, saveAttachment } from "../../engine/attachments.ts";
import type { Server } from "bun";
import type { Session, StoredEvent } from "../../core/types.ts";
import type { Approval, Gate } from "../../safety/gate.ts";
import type { Deps } from "../../server/app.ts";
import { answer, closedQuestions, pendingQuestions, type Answers } from "../../tools/interact.ts";
import * as alerts from "../../automation/alerts.ts";
import * as loops from "../../automation/loops.ts";
import { lineage } from "../../core/tree.ts";
import * as push from "./push.ts";
import {
  approvalMessage, canonicalMessage, checkAndClaim, loadSpki, PairLimiter, REPLAY_VERSION, requestSource, revokeMessage,
} from "./sig.ts";
import type { Device, MobileStore } from "./store.ts";

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
const UNASKED = new Set(["auto-edits", "full-auto"]);

export type MobileCtx = Deps & { mobile: MobileStore; gate: () => Gate | undefined; changed: () => void };

export function pairLink(base: string, code: string) {
  const q = new URLSearchParams({ u: base.replace(/\/+$/, ""), c: code, n: host() });
  return `hermes://pair?${q.toString().replace(/\+/g, "%20")}`;
}

// --- shapes the app reads ---------------------------------------------------------

// The chat's newest message on its shown branch, for the inbox line: the app
// keeps a preview the server sends over one it guesses from a batch of messages.
export type ChatExtra = { unread?: number; preview?: { text: string; role: string; id: string } | null };

export function chatOf(s: Session, lastSeq = 0, x: ChatExtra = {}) {
  const c: Record<string, unknown> = {
    id: s.id, title: s.title || "New chat", kind: "chat", created: secs(s.created), updated: secs(s.updated), unread: x.unread ?? 0,
    pinned: s.settings.pinned_ms ? 1 : 0, archived: s.archived ? 1 : 0, seq: lastSeq, parent_id: s.parent_id ?? null,
  };
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
    if (!o) return { ...base, role: "user", content: String(e.data.text ?? ""), meta: e.data.images?.length ? { images: e.data.images.length } : {} };
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

const approvalMsg = (a: ReturnType<typeof approvalOf>) => ({
  id: `apr-${a.id}`, chat_id: a.chat_id, role: "agent", kind: "approval", content: a.description,
  meta: { approval_id: a.id, command: a.command, description: a.description }, ts: a.ts, seq: 0,
});

export function mobileApi(ctx: MobileCtx) {
  const { store, bus, engine, providers, errors, mobile } = ctx;
  const limiter = new PairLimiter();
  const lastSeq = (sid: string) => store.db.query<{ n: number | null }, [string]>("SELECT MAX(seq) AS n FROM events WHERE session_id = ?").get(sid)!.n ?? 0;
  const allSessions = () => [...store.sessions(), ...store.sessions({ archived: true })];
  // When the running turn started: the phone's elapsed timer counts from it,
  // whatever the turn stored since.
  const turnStart = (sid: string) => store.db.query<{ t: number | null }, [string]>("SELECT MAX(ts) AS t FROM events WHERE session_id = ? AND kind = 'turn_start'").get(sid)!.t;
  const since = (s: Session) => secs(turnStart(s.id) ?? s.updated);
  const working = () => store.sessions().filter((s) => engine.isRunning(s.id)).map((s) => ({ chat_id: s.id, since: since(s) }));
  const msgCtx: MessageCtx = { titleOf: (sid) => store.session(sid)?.title, parentOf: (sid) => store.session(sid)?.parent_id ?? null };
  const toMsg = (e: StoredEvent, gseq: number) => messageOf(e, gseq, msgCtx);
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
  const unread = () => { try { return alerts.unreadCounts().sessions; } catch { return {} as Record<string, number>; } };
  const chatFull = (s: Session, u = unread()) => chatOf(s, lastSeq(s.id), { unread: u[s.id] ?? 0, preview: preview(s) });

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
      actions: [["Answer", "once", "primary"], ["Dismiss", "deny", "danger"]], state: "pending", choice: null, ts: e ? secs(e.ts) : null,
    };
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
    ...closedQuestions(sinceMs).map((q) => ({ id: `q-${q.call_id}`, chat_id: q.session_id, session_key: q.session_id, kind: "question", command: "", description: "", options: [], actions: [], state: q.answered ? "approved" : "expired", choice: null, ts: secs(q.at) })),
  ];

  // Bearer token, then the request signature over method, raw path and query,
  // timestamp and body.
  const signed = (h: Signed, limit = BODY_LIMIT) => async (req: Req, srv: Server<unknown>) => {
    const auth = req.headers.get("authorization") ?? "";
    const dev = mobile.deviceForToken(auth.replace(/^bearer\s+/i, ""));
    if (!dev) return err("unauthorized", 401);
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.length > limit) return err("body too large", 413);
    const u = new URL(req.url);
    const ts = req.headers.get("x-hm-ts") ?? "";
    const msg = canonicalMessage(req.method, u.pathname + u.search, ts, body);
    const r = await checkAndClaim(req.headers.get("x-hm-sig") ?? "", dev.pub, msg, ts, "request", nowSecs(), mobile);
    if (r === "rejected") return err("bad signature", 401);
    if (r === "store_unavailable") return err("signature store is busy; try again", 503);
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
    const b: any = await req.json().catch(() => ({}));
    const [p, a] = await Promise.all([loadSpki(String(b?.pub ?? "")), loadSpki(String(b?.apub ?? ""))]);
    if (!p || !a) return err("device keys required (P-256 SPKI, base64)", 400);
    // The approval key stands for a biometric check; it must not be the request key.
    if (p.spki.toBase64() === a.spki.toBase64()) return err("the approval key must differ from the request key", 400);
    const got = mobile.claimPairCode(String(b.code ?? ""), String(b.device_name ?? "phone"), b.pub, b.apub, b.lock === false);
    if (!got) {
      limiter.fail(source, now);
      return err("invalid or expired code", 403);
    }
    ctx.changed();
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
    const text = byId ? JSON.stringify(Object.keys(byId).sort().map((k) => [k, byId[k]])) : typeof b.answer === "string" ? b.answer.trim() : "";
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
      return json({ approval: { ...card, state: choice === "deny" ? "denied" : "approved", choice }, resolved: 1 });
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

  function events(req: Req, dev: Device, srv: Server<unknown>) {
    srv.timeout(req, 0);
    const enc = new TextEncoder();
    let off = () => {}, beat: Timer | undefined, lagged = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        start(c) {
          const close = () => { off(); clearInterval(beat); try { c.close(); } catch {} };
          const send = (p: unknown) => {
            if (!mobile.isActive(dev.id)) return close();
            // Fell behind: drop until the phone reads again, then say so once.
            if ((c.desiredSize ?? 1) <= 0) { lagged++; return; }
            if (lagged) { const missed = lagged; lagged = 0; c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "resync", missed, seq: mobile.globalSeq() })}\n\n`)); }
            c.enqueue(enc.encode(`data: ${JSON.stringify(p)}\n\n`));
          };
          send({ type: "hello", seq: mobile.globalSeq(), working: working() });
          off = bus.on((f) => {
            try {
              if (f.t === "event") {
                const gseq = mobile.gseqOf(f.event.id);
                const m = toMsg(f.event, gseq);
                const s = store.session(f.event.session_id);
                if (m) send({ type: "message", seq: gseq, message: m, chat: s ? chatFull(s) : null });
                // A question answered elsewhere: its card closes on the phone too.
                if (f.event.kind === "tool_result") {
                  const ids = new Set(((f.event.data.results ?? []) as any[]).map((r) => r.tool_use_id));
                  for (const c of closedCards(f.event.ts - 60_000)) if (c.kind === "question" && ids.has(c.id.slice(2))) send({ type: "approval", seq: gseq, approval: c });
                }
              } else if (f.t === "delta" && f.kind === "text") send({ type: "delta", chat_id: f.session_id, delta: f.text });
              else if (f.t === "session") send({ type: "working", chat_id: f.session.id, working: f.session.phase === "working", since: since(f.session) });
              else if (f.t === "feature" && f.name === "approval") {
                const a = approvalOf(f.data as Approval);
                send({ type: "approval", seq: mobile.globalSeq(), approval: a });
                if (a.state === "pending") send({ type: "message", seq: mobile.globalSeq(), message: approvalMsg(a) });
              }
            } catch (e) {
              errors.capture("server", e, { at: "mobile event stream" });
            }
          });
          beat = setInterval(() => send({ type: "seq", seq: mobile.globalSeq(), working: working() }), 15_000);
          req.signal.addEventListener("abort", close, { once: true });
        },
        cancel() { off(); clearInterval(beat); },
      },
      { highWaterMark: 1000, size: () => 1 },
    );
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
  }

  // Messages of one chat's shown branch with its approval cards in place. The
  // other branches' messages come as kind "deleted" (the app hides those ids),
  // so a phone that cached the branch the owner left shows only the one he chose;
  // nothing is removed from the store. A client that pages (`before`, or
  // `paged=1` with `limit`) gets the newest `limit` and `older` to ask for the
  // page before; one that does not gets the whole branch, as before.
  function chatMessages(s: Session, q: URLSearchParams) {
    const all = store.events(s.id);
    const line = lineage(all, s.head);
    const on = new Set(line.map((e) => e.id));
    const msgs: any[] = line.map((e) => toMsg(e, mobile.gseqOf(e.id))).filter(Boolean);
    for (const a of ctx.gate()?.approvals({ session: s.id }) ?? []) msgs.push(approvalMsg(approvalOf(a)));
    msgs.sort((x, y) => x.ts - y.ts);
    const off = all.filter((e) => !on.has(e.id)).map((e) => toMsg(e, 0)).filter(Boolean)
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

  const chat = (sid: string) => store.session(sid);

  return {
    "/v1/health": { GET: () => json({ ok: true, name: host(), profile: "keel", api: 1, security: { signature_replay: REPLAY_VERSION }, degraded: [] }) },
    "/v1/pair": { POST: pair },
    "/pair": {
      GET: (req: Req) => {
        const code = new URL(req.url).searchParams.get("c") ?? "";
        const link = pairLink(mobile.setting("public_url") ?? new URL(req.url).origin, code).replace(/"/g, "&quot;");
        return new Response(
          `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Pair Keel</title><body style="background:#0c0e12;color:#edf1f7;font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;height:90vh;gap:16px"><div style="font-size:32px;font-weight:700">Keel</div><a href="${link}" style="background:#3b82f6;color:#fff;padding:14px 24px;border-radius:10px;text-decoration:none;font-weight:600">Open in Hermes Mobile</a></body>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      },
    },
    "/v1/me": {
      GET: signed(async (_r, dev) => {
        const models = providers.marked(await providers.models().catch(() => [])).filter((m) => !m.hidden).map((m) => m.id);
        const model = (await providers.defaultModel().catch(() => "")) || store.sessions()[0]?.model || null;
        return json({
          device: { id: dev.id, name: dev.name, created: dev.created }, name: host(), profile: "keel", model, agent_name: "Keel", user_name: "owner",
          models, profiles: ["default"], public_url: mobile.setting("public_url") ?? "",
          features: { radar: false, fleet: false, wake_wa: false, projects: false }, security: { signature_replay: REPLAY_VERSION },
        });
      }),
    },
    // `since` and `seq` are positions in the global event sequence, so a long
    // session never hides a newer event of a short one.
    "/v1/sync": {
      GET: signed((req) => {
        const since = Math.max(0, Number(new URL(req.url).searchParams.get("since")) || 0);
        // A page holds events the app shows, so a run of tool rounds and notes
        // never fills a page with nothing to show (the app reads one page per sync).
        const page = mobile.eventsAfter(since, SYNC_PAGE, SHOWN_KINDS);
        const more = page.length === SYNC_PAGE;
        const seq = more ? page.at(-1)!.gseq : Math.max(since, mobile.globalSeq());
        const u = unread();
        // Cards that closed since the cursor's time, or within a push's lifetime.
        const from = Math.min(Date.now() - 15 * 60_000, since ? (mobile.tsOfGseq(since) ?? 0) : Infinity);
        return json({
          seq, more,
          chats: allSessions().map((s) => chatFull(s, u)),
          messages: page.map((e) => toMsg(e, e.gseq)).filter(Boolean),
          approvals: [...pendingApprovals(), ...closedCards(from)],
          working: working(),
        });
      }),
    },
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
      POST: signed(withBody((req, dev, b) => {
        const text = String(b.text ?? b.caption ?? "").trim();
        // What the phone uploaded goes with the words, or nothing is sent.
        const refs: any[] = Array.isArray(b.attachments) ? b.attachments : [];
        const images: any[] = [];
        for (const r of refs) {
          const id = String(r?.id ?? r?.media ?? "");
          const path = attachmentPath(id);
          if (!path) return err(`attachment ${id.slice(0, 80) || "(no id)"} is not stored here; upload it again`, 400);
          const mime = String(r?.mime ?? Bun.file(path).type ?? "");
          const bytes = readFileSync(path);
          images.push(/^image\/(png|jpeg|gif|webp)$/.test(mime) ? { type: "image", media_type: mime, data: bytes.toString("base64") } : saveAttachment(bytes, String(r?.file_name ?? r?.name ?? basename(path)), mime));
        }
        if (!text && !images.length) return err("empty", 400);
        const s = chat(req.params.cid!);
        if (!s) return err("unknown chat", 404);
        if (s.archived) return err("the chat is archived", 409);
        if (dev.nolock && UNASKED.has(ctx.gate()?.perm(s.id).mode ?? "ask"))
          return err("This phone has no screen lock, so it can only prompt chats where every tool call asks", 403);
        // While a turn runs: steer (the default) joins it, queue waits for it.
        const mode = b.mode === "queue" ? "queue" : b.mode === "steer" ? "steer" : "send";
        const r: any = engine.send(s.id, text, { mode, images });
        if (r.event) return json({ message: toMsg(r.event, mobile.gseqOf(r.event.id)) });
        return json({ message: { id: r.queued.id, chat_id: s.id, role: "user", kind: r.steer ? "steer" : "queued", content: text, meta: {}, ts: secs(Date.now()), seq: 0 } });
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
    // that names it (attachments: [{ id }]).
    "/v1/upload": {
      POST: signed((req, _d, body) => {
        if (!body.length) return err("the file is empty", 400);
        const q = new URL(req.url).searchParams;
        const mime = (q.get("mime") || req.headers.get("content-type") || "application/octet-stream").split(";")[0]!.trim();
        const a = saveAttachment(body, q.get("name") || "file", mime);
        return json({ id: a.id, media: a.id, mime: a.media_type, file_name: a.name, size: a.size });
      }, ATTACHMENT_MAX),
    },
    "/v1/media/:id": {
      GET: signed((req) => {
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
          runs: loops.runs(l.id, 5).map((r) => ({ id: r.id, ts: secs(r.started_ms ?? r.due_ms), ok: r.ok ?? null, detail: r.detail ?? r.skip_reason ?? null })),
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
      GET: signed(() => {
        const config = push.clientConfig();
        return json({ enabled: !!config, config: config ?? {} });
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
