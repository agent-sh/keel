// Hermes Mobile API v1: the routes the phone app calls. Every route but health
// and pair needs the device's bearer token and a request signature; approvals
// and revoking another device also need the approval key's signature.
import { hostname } from "node:os";
import type { Server } from "bun";
import type { Session, StoredEvent } from "../../core/types.ts";
import type { Approval, Gate } from "../../safety/gate.ts";
import type { Deps } from "../../server/app.ts";
import { answer, pendingQuestions, type Answers } from "../../tools/interact.ts";
import * as push from "./push.ts";
import {
  approvalMessage, canonicalMessage, checkAndClaim, loadSpki, PairLimiter, REPLAY_VERSION, requestSource, revokeMessage,
} from "./sig.ts";
import type { Device, MobileStore } from "./store.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const err = (error: string, status: number) => json({ error }, status);
const BODY_LIMIT = 1 << 20;
const SYNC_PAGE = 2000;
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

export function chatOf(s: Session, lastSeq = 0) {
  return { id: s.id, title: s.title || "New chat", kind: "chat", created: secs(s.created), updated: secs(s.updated), unread: 0, pinned: 0, archived: s.archived ? 1 : 0, seq: lastSeq };
}

export function messageOf(e: StoredEvent, gseq: number) {
  const base = { id: e.id, chat_id: e.session_id, kind: "text", meta: {}, ts: secs(e.ts), seq: gseq };
  if (e.kind === "user") return { ...base, role: "user", content: String(e.data.text ?? "") };
  if (e.kind === "assistant") {
    const text = ((e.data.blocks ?? []) as any[]).filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim();
    return text ? { ...base, role: "agent", content: text } : null;
  }
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
  const working = () => store.sessions().filter((s) => engine.isRunning(s.id)).map((s) => ({ chat_id: s.id, since: secs(s.updated) }));

  // Questions the model asked that wait for the owner, as approval cards.
  function questions(sessionId?: string) {
    const out: any[] = [];
    for (const s of sessionId ? [store.session(sessionId)].filter(Boolean) as Session[] : store.sessions()) {
      const ids = pendingQuestions(s.id);
      if (!ids.length) continue;
      const evs = store.events(s.id, Math.max(0, lastSeq(s.id) - 40));
      for (const callId of ids) {
        let qs: any[] = [], ts = Date.now();
        for (const e of evs) for (const b of e.kind === "assistant" ? e.data.blocks ?? [] : []) if (b.type === "tool_use" && b.id === callId) { qs = normQuestions(b.input); ts = e.ts; }
        out.push({
          id: `q-${callId}`, chat_id: s.id, session_key: s.id, kind: "question",
          command: qs.map((q) => q.question).join("\n") || "A question", description: qs.flatMap((q) => q.options.map((o: any) => o.label)).join(" / "),
          options: qs.flatMap((q) => q.options.map((o: any) => o.label)),
          actions: [["Answer", "once", "primary"], ["Dismiss", "deny", "danger"]], state: "pending", choice: null, ts: secs(ts),
        });
      }
    }
    return out;
  }
  const pendingApprovals = (sessionId?: string) => [
    ...(ctx.gate()?.approvals({ session: sessionId, pending: true }) ?? []).map(approvalOf),
    ...questions(sessionId),
  ];

  // Bearer token, then the request signature over method, raw path and query,
  // timestamp and body.
  const signed = (h: Signed) => async (req: Req, srv: Server<unknown>) => {
    const auth = req.headers.get("authorization") ?? "";
    const dev = mobile.deviceForToken(auth.replace(/^bearer\s+/i, ""));
    if (!dev) return err("unauthorized", 401);
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.length > BODY_LIMIT) return err("body too large", 413);
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
    const text = typeof b.answer === "string" ? b.answer.trim() : "";
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
      const tu = store.events(s.id).reverse().flatMap((e) => (e.kind === "assistant" ? e.data.blocks ?? [] : [])).find((x: any) => x.type === "tool_use" && x.id === callId);
      const answers: Answers = {};
      for (const q of normQuestions(tu?.input)) {
        const hit = q.options.find((o: any) => o.label.toLowerCase() === text.toLowerCase());
        answers[q.id] = choice === "deny" ? { picked: [], other: "The owner dismissed the question." } : hit ? { picked: [hit.label] } : { picked: [], other: text };
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
                const m = messageOf(f.event, gseq);
                const s = store.session(f.event.session_id);
                if (m) send({ type: "message", seq: gseq, message: m, chat: s ? chatOf(s, f.event.seq) : null });
              } else if (f.t === "delta" && f.kind === "text") send({ type: "delta", chat_id: f.session_id, delta: f.text });
              else if (f.t === "session") send({ type: "working", chat_id: f.session.id, working: f.session.phase === "working", since: secs(f.session.updated) });
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

  // Messages of one chat with its approval cards in place.
  function chatMessages(sid: string) {
    const msgs: any[] = store.events(sid).map((e) => messageOf(e, mobile.gseqOf(e.id))).filter(Boolean);
    for (const a of ctx.gate()?.approvals({ session: sid }) ?? []) msgs.push(approvalMsg(approvalOf(a)));
    return msgs.sort((x, y) => x.ts - y.ts);
  }

  function activity(sinceMs: number) {
    const rows = store.db.query<{ kind: string; data: string }, [number]>("SELECT kind, data FROM events WHERE ts > ? AND kind IN ('turn_start', 'turn_end', 'error')").all(sinceMs);
    let runs = 0, failures = 0, spend = 0, priced = false;
    for (const r of rows) {
      if (r.kind === "turn_start") runs++;
      else if (r.kind === "error") failures++;
      else {
        const c = JSON.parse(r.data)?.usage?.cost;
        if (typeof c === "number") { spend += c; priced = true; }
      }
    }
    return { runs, failures, spend: priced ? Math.round(spend * 10_000) / 10_000 : null };
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
        const page = mobile.eventsAfter(since, SYNC_PAGE);
        const more = page.length === SYNC_PAGE;
        const seq = more ? page.at(-1)!.gseq : Math.max(since, mobile.globalSeq());
        return json({
          seq, more,
          chats: allSessions().map((s) => chatOf(s, lastSeq(s.id))),
          messages: page.map((e) => messageOf(e, e.gseq)).filter(Boolean),
          approvals: pendingApprovals(),
          working: working(),
        });
      }),
    },
    "/v1/events": { GET: signed((req, dev, _b, srv) => events(req, dev, srv)) },
    "/v1/chats": {
      GET: signed(() => json({ chats: store.sessions().map((s) => chatOf(s, lastSeq(s.id))), working: working() })),
      POST: signed(withBody(async (_r, _d, b) => {
        const model = await providers.defaultModel().catch(() => "");
        if (!model) return err("No model provider is set up.", 409);
        await providers.resolve(model);
        const s = store.createSession({ model, workspace: ctx.workspace, title: typeof b.title === "string" && b.title !== "New chat" ? b.title.slice(0, 200) : "" });
        bus.emit({ t: "session", session: s });
        return json({ chat: chatOf(s) });
      })),
    },
    "/v1/chats/:cid": {
      PATCH: signed(withBody((req, _d, b) => {
        const s = chat(req.params.cid!);
        if (!s) return err("unknown chat", 404);
        const title = typeof b.title === "string" ? b.title.slice(0, 200) : undefined;
        const archived = typeof b.archived === "boolean" ? b.archived : typeof b.archived === "number" ? b.archived !== 0 : undefined;
        if (title === undefined && archived === undefined) return err("no supported fields", 400);
        const next = store.updateSession(s.id, { title, archived });
        bus.emit({ t: "session", session: next });
        return json({ chat: chatOf(next, lastSeq(s.id)) });
      })),
    },
    "/v1/chats/:cid/messages": {
      GET: signed((req) => (chat(req.params.cid!) ? json({ messages: chatMessages(req.params.cid!) }) : err("unknown chat", 404))),
      POST: signed(withBody((req, dev, b) => {
        const text = String(b.text ?? "").trim();
        if (!text) return err("empty", 400);
        const s = chat(req.params.cid!);
        if (!s) return err("unknown chat", 404);
        if (s.archived) return err("the chat is archived", 409);
        if (dev.nolock && UNASKED.has(ctx.gate()?.perm(s.id).mode ?? "ask"))
          return err("This phone has no screen lock, so it can only prompt chats where every tool call asks", 403);
        // While a turn runs: steer (the default) joins it, queue waits for it.
        const mode = b.mode === "queue" ? "queue" : b.mode === "steer" ? "steer" : "send";
        const r: any = engine.send(s.id, text, { mode });
        if (r.event) return json({ message: messageOf(r.event, mobile.gseqOf(r.event.id)) });
        return json({ message: { id: r.queued.id, chat_id: s.id, role: "user", kind: r.steer ? "steer" : "queued", content: text, meta: {}, ts: secs(Date.now()), seq: 0 } });
      })),
    },
    "/v1/chats/:cid/read": { POST: signed(() => json({ ok: true })) },
    "/v1/chats/:cid/stop": { POST: signed(async (req) => { await engine.interrupt(req.params.cid!); return json({ ok: true }); }) },
    "/v1/chats/:cid/run": {
      GET: signed((req) => {
        const s = chat(req.params.cid!);
        return json({ chat_id: req.params.cid, working: !!s && engine.isRunning(s.id), model: s?.model ?? null, steps: [], approvals: s ? pendingApprovals(s.id) : [] });
      }),
    },
    "/v1/chats/:cid/usage": {
      GET: signed((req) => {
        const s = chat(req.params.cid!);
        return json({
          chat_id: req.params.cid,
          session: s ? { model: s.model, input_tokens: s.usage.input, output_tokens: s.usage.output, cache_read_tokens: s.usage.cache_read, cache_write_tokens: s.usage.cache_write, cost: s.usage.cost ?? null } : null,
        });
      }),
    },
    "/v1/approvals/:aid": { POST: signed(withBody(approve)) },
    "/v1/pulse": {
      GET: signed(() => {
        const day = activity(Date.now() - 86_400_000), week = activity(Date.now() - 7 * 86_400_000);
        return json({ spend_today: day.spend, spend_7d: week.spend, runs_today: day.runs, failures_today: day.failures, working: working(), live_sessions: store.sessions(), approvals: pendingApprovals() });
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

// The question tools' inputs, in one shape.
function normQuestions(input: any): { id: string; question: string; options: { label: string }[] }[] {
  const list = Array.isArray(input?.questions) ? input.questions : input?.question ? [input] : [];
  return list.map((q: any, i: number) => ({
    id: String(q.id ?? i),
    question: String(q.question ?? ""),
    options: (q.type === "yesno" ? ["Yes", "No"] : Array.isArray(q.options) ? q.options : []).map((o: any) => ({ label: String(typeof o === "string" ? o : o?.label ?? "") })),
  }));
}
