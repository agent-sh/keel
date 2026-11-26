// The phone: pairing and the device list for the workbench (/api/mobile), the
// Hermes Mobile API the phone app calls (/v1), and phone push as an alert channel.
import { renderSVG } from "uqr";
import { atDesk, liveWait, get as alertOf, opensErrors, registerChannel, settings as alertSettings, type Alert } from "../../automation/alerts.ts";
import { costLine, costs } from "../../core/wait-rank.ts";
import { digestOf, needsOf, PushBudget, WINDOW_MS, type Held } from "../../integrations/mobile/budget.ts";
import { holdThenSend, screenUnlocked } from "../../integrations/mobile/hold.ts";
import * as push from "../../integrations/mobile/push.ts";
import { PhoneShown } from "../../integrations/mobile/shown.ts";
import { hostOf, MobileStore, type PushRecord } from "../../integrations/mobile/store.ts";
import { mobileApi, pairLink } from "../../integrations/mobile/v1.ts";
import { typedShown } from "../../integrations/mobile/typed-code.ts";
import type { Deps, RouteModule } from "../app.ts";
import { addAllowedHosts } from "../admission.ts";
import { allPendingQuestions, pendingQuestions } from "../../tools/interact.ts";
import { openAnswer, openPush, openRefusal } from "../../integrations/mobile/open.ts";
import { liveData, LiveTicker, readLive, type LiveStatus } from "../../integrations/mobile/live.ts";
import { agentCounts } from "../../automation/state.ts";
import { plansWaiting } from "./plan.ts";
import { gate } from "./permissions.ts";
import { checkpoints } from "./checkpoints.ts";
import { fleetMachines, startFleetSession } from "./fleet.ts";
import { awayNow, awaySeen } from "./overview.ts";
import { helperNow } from "./helper.ts";
import { searchSessions } from "./search.ts";
import { ownerSeen } from "../../admin/away.ts";
import { landings } from "../../integrations/mobile/landings.ts";
import { report as agentReport, rootSession, send as sendToAgent } from "../../automation/agents.ts";
import { workBoard } from "./board.ts";
import { landing } from "./landing.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;

// What an alert becomes on the phone: the kind the app's wake handler knows,
// who asks and what may be answered from the notification.
// A notification shows one line, and collapsed it shows the start of that
// line. It carries Allow once only for a request whose whole line it shows
// (`glance`, src/safety/card.ts: short, plain, low risk, runs where the session
// is). Any other gets Deny alone in `opts`, so an app from before the rule
// offers no Allow for it either; the app's own notification then leads with
// Open. A standing answer is never a notification's to give. `hold` says why
// the request is read first (empty when it is not held).
// `card`: the card's form as the gate reads it now (else what the alert recorded).
// `who`: the helper, when the alert is of its conversation: the name the owner gave it and the mark of its picture, so the
// notification carries its face (the app fetches the picture once per mark).
export function alertPush(a: Alert, card?: { hold: string[]; glance: boolean; line: string }, who?: { name: string; face?: string }): push.PushMessage {
  const kind = a.kind === "question" ? "approval" : a.kind;
  const data: Record<string, string> = { title: a.title, body: card?.line ?? a.body, ek: a.kind, pri: "", reply: a.kind === "finished" || a.kind === "question" ? "1" : "0" };
  const aid = a.data?.approval_id ?? (a.data?.call_id ? `q-${a.data.open_session ?? a.session_id}.${a.data.call_id}` : a.data?.plan_id ? `plan-${a.data.open_session ?? a.session_id}.${a.data.plan_id}` : undefined);
  if (aid) data.aid = String(aid);
  if (who) { data.who = who.name; if (who.face) data.face = who.face; }
  // A plan is read whole in the app before it is approved: its notification opens it, and allows nothing.
  if (a.data?.plan_id) { data.hold = "plan"; data.opts = JSON.stringify(["deny"]); }
  if (a.kind === "approval") {
    // An alert from before cards recorded this says nothing: no Allow.
    const held: string[] = card?.hold ?? (Array.isArray(a.data?.hold) ? a.data.hold : a.data?.risk === "high" ? ["risk"] : []);
    data.hold = held.join(",");
    data.opts = JSON.stringify((card ? card.glance : a.data?.glance === true) ? ["once", "deny"] : ["deny"]);
  }
  // What the wait costs as it stands, and the key the phone orders what waits by: the one it began with (src/core/wait-rank.ts).
  const now = liveWait(a);
  if (costs(now)) { data.cost = costLine(now, Date.now()); data.wk = String(a.data.wait.key ?? 0); }
  // A failure with no session to open opens the app's Errors view, as its click on the desktop opens the Errors panel.
  try { if (opensErrors(a)) data.open = "errors"; } catch {}
  const high = ["approval", "question", "failed", "loop_failed", "limit", "test"].includes(a.kind);
  data.pri = high ? "high" : "normal";
  return { kind, session_id: a.session_id, high, data };
}

export const mobileRoutes: RouteModule = (deps: Deps) => {
  const { store, bus, errors } = deps;
  const mobile = new MobileStore(store);
  const changed = () => bus.emit({ t: "feature", name: "mobile", data: { changed: true } });
  // Each address the owner gave for the phone (in a pair link) is this daemon's
  // own name to the phones paired through it: requests that name it pass the Host check.
  addAllowedHosts(() => [...mobile.pairHosts(), hostOf(mobile.setting("public_url")), hostOf(process.env.MOBILE_PUBLIC_URL)].filter((h): h is string => !!h));

  const deviceRows = () => mobile.devices().map(({ pub, apub, ...d }) => ({ ...d, push: mobile.pushStatus(d.id) }));

  async function testPush(deviceId?: string): Promise<Response> {
    if (deviceId && !mobile.devices().some((d) => d.id === deviceId && !d.revoked)) return bad(`unknown device ${deviceId}`, 404);
    if (!push.configured()) return bad(`push is not set up: put the service-account key of the app's Firebase project at ${push.accountPath()}`, 409);
    let pushes;
    try {
      pushes = await push.send(mobile, mobile.globalSeq(), push.testMessage(), deviceId);
    } catch (e) {
      return bad((e as Error).message, 409);
    } finally {
      changed();
    }
    if (!pushes.length) return bad("no paired device has registered a push token yet; open the app on the phone once", 409);
    return json({ pushes });
  }

  // An alert as the phone is sent it now: an approval's hold is read from its card as the gate reads it today.
  const pushOf = (a: Alert) => {
    const card = a.kind === "approval" && a.data?.approval_id ? gate?.approval(a.data.approval_id) : undefined;
    const h = helperNow?.();
    return alertPush(a, card ? gate!.form(card) : undefined, h?.isHelper(a.session_id) ? { name: h.name(), face: h.persona().avatar?.v } : undefined);
  };
  // The phone's lasting notification while turns run (src/integrations/mobile/live.ts).
  const waiting = () => [
    ...(gate?.approvals({ pending: true }) ?? []).map((a) => a.session_id),
    ...allPendingQuestions().map((q) => q.session_id),
    ...plansWaiting().map((p) => p.session_id),
  ];
  // The open errors not read yet, counted as the Errors view counts them (the newest 200 open kinds).
  const unreadErrors = () => [...errors.unwritten(), ...errors.list(200, { resolved: false })].filter((e) => !e.read_ts && !e.recovered_ts).length;
  const nowLive = () => readLive({ store, running: () => deps.engine.runningIds(), waiting, below: () => agentCounts({ store }), failed: unreadErrors });
  // What the phone was last told is kept in the mobile settings: a daemon that stopped inside a hold
  // after it said something works leaves this one to say it ended (the poke at the start).
  const keep = {
    get: (): LiveStatus | null => { try { return JSON.parse(mobile.setting("live_told") ?? "null"); } catch { return null; } },
    set: (s: LiveStatus) => mobile.setSetting("live_told", JSON.stringify(s)),
  };
  const live = new LiveTicker(nowLive, async (s) => {
    const recs = await push.send(mobile, mobile.globalSeq(), { kind: "live", high: false, data: liveData(s) });
    for (const r of recs) if (!r.ok) errors.capture("server", new Error(`phone push failed: ${r.error}`), { live: true, device: r.device_id });
    return recs.some((r) => r.ok);
  }, 20_000, () => push.configured() && mobile.pushTargets().length > 0, keep, (e) => errors.capture("server", e, { live: true }));
  live.poke();
  bus.on((f) => {
    if (f.t === "session" || f.t === "error" || (f.t === "feature" && (f.name === "approval" || f.name === "plan" || f.name === "automation"))) live.poke();
  });

  // What the phone holds a notification for, so a withdraw goes only there.
  const shown = new PhoneShown();
  const takeDown = async (msg: push.PushMessage, about: Record<string, string>) => {
    const recs = await push.send(mobile, mobile.globalSeq(), msg);
    for (const r of recs) if (!r.ok) errors.capture("server", new Error(`phone push failed: ${r.error}`), { ...about, device: r.device_id });
    if (recs.length) changed();
  };
  // The budget of interruptions (src/integrations/mobile/budget.ts): an alert that is due goes through it,
  // told alone, inside the digest of the hour, or held until a slot opens.
  type Due = Held & { alert: Alert; open: () => boolean };
  const sendAlone = async (a: Alert) => {
    const msg = pushOf(a);
    const recs = await push.send(mobile, mobile.globalSeq(), msg);
    if (recs.some((r) => r.ok)) shown.pushed(msg);
    for (const r of recs) if (!r.ok) errors.capture("server", new Error(`phone push failed: ${r.error}`), { alert: a.id, device: r.device_id });
    if (recs.length) changed();
  };
  // A digest is an agent's word with no session: its tap opens the app, where the inbox has each of them.
  const sendDigest = async (items: Due[]) => {
    const d = digestOf(items);
    const recs = await push.send(mobile, mobile.globalSeq(), {
      kind: "agent", session_id: null, high: d.need + d.failed > 0,
      data: { title: d.title, body: d.body, ek: "digest", pri: d.need + d.failed > 0 ? "high" : "normal", reply: "0" },
    });
    for (const r of recs) if (!r.ok) errors.capture("server", new Error(`phone push failed: ${r.error}`), { digest: items.length, device: r.device_id });
    if (recs.length) changed();
  };
  // What needs the owner when the hour has no slot left: the one alone, several in one push of their own.
  const sendOver = async (items: Due[]) => {
    if (items.length === 1) return sendAlone(items[0]!.alert);
    const d = needsOf(items);
    const recs = await push.send(mobile, mobile.globalSeq(), {
      kind: "agent", session_id: null, high: true,
      data: { title: d.title, body: d.body, ek: "digest", pri: "high", reply: "0" },
    });
    for (const r of recs) if (!r.ok) errors.capture("server", new Error(`phone push failed: ${r.error}`), { needs: items.length, device: r.device_id });
    if (recs.length) changed();
  };
  // What an earlier run of the daemon pushed in the last hour: the device that got the most of it.
  const pushedBefore = () => {
    const by = new Map<string, number[]>();
    const rows = store.db.query<{ device_id: string; sent_ms: number }, [number]>("SELECT device_id, sent_ms FROM pushes WHERE ok = 1 AND kind NOT IN ('live', 'withdraw', 'test') AND sent_ms > ?").all(Date.now() - WINDOW_MS);
    for (const r of rows) (by.get(r.device_id) ?? by.set(r.device_id, []).get(r.device_id)!).push(r.sent_ms);
    return [...by.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  };
  const budget = new PushBudget<Due>({
    limit: () => alertSettings().push_per_hour,
    alone: (d) => sendAlone(d.alert),
    digest: sendDigest,
    over: sendOver,
    moot: (d) => !d.open(),
    seed: pushedBefore,
  });
  registerChannel({
    id: "push",
    label: "Phone push",
    available: () => push.configured() && mobile.pushTargets().length > 0,
    paired: () => mobile.devices().some((d) => !d.revoked),
    async deliver(a, opts) {
      const read = () => !!store.db.query<{ read: number }, [string]>("SELECT read FROM alerts WHERE id = ?").get(a.id)?.read;
      const stillOpen = () => {
        if (read()) return false;
        // Another daemon's session: its daemon says when the request is answered, and the alert is read then.
        if (a.data?.far) return true;
        if (a.kind === "approval") return gate?.approval(a.data?.approval_id)?.state === "pending";
        // The question is the asking session's (a child's, when a subagent asks),
        // while the alert sits on the parent where it is answered.
        if (a.kind === "question") {
          const asker = a.data?.open_session ?? a.session_id;
          return !!asker && pendingQuestions(asker).includes(a.data?.call_id);
        }
        return true;
      };
      // A reminder is sent while the owner is away by the digest's rule, which the reminder's own look settled:
      // no wait of its own, no look at the desk. It still goes through the hour's budget.
      if (opts?.reminder) {
        if (stillOpen()) await budget.offer({ id: a.id, ts: a.ts, kind: a.kind, wait: a.data?.wait, label: a.title, alert: a, open: stillOpen });
        return;
      }
      await holdThenSend({
        needsAnswer: a.kind === "approval" || a.kind === "question",
        stillOpen,
        atDesk: async () => atDesk() || (await screenUnlocked()),
        sleep: (ms) => Bun.sleep(ms),
        send: () => budget.offer({ id: a.id, ts: a.ts, kind: a.kind, wait: a.data?.wait, label: a.title, alert: a, open: stillOpen }),
      });
    },
    // Nothing in the session is unread any more (answered or read on the
    // desktop): the phone takes down what it shows for it. Normal priority, no
    // notification of its own; the phone needs no network to act on it.
    async withdraw(sessionId) {
      const msg = shown.clear(sessionId);
      if (!msg || !push.configured() || !mobile.pushTargets().length) return;
      await takeDown(msg, { withdraw: sessionId });
    },
    // One request answered on the desk (or another phone) while the session has more:
    // its notification alone comes down, the others stay.
    async take(a) {
      const msg = shown.takeBack(alertPush(a).data.aid);
      if (!msg || !push.configured() || !mobile.pushTargets().length) return;
      await takeDown(msg, { withdraw: a.id });
    },
  });

  return {
    ...mobileApi({ ...deps, mobile, gate: () => gate, changed, checkpoints: () => checkpoints, fleetMachines: () => fleetMachines?.() ?? Promise.resolve([]), startFleetSession: (b) => (startFleetSession ? startFleetSession(b) : Promise.resolve(Response.json({ error: "this daemon has no machines to start a session on" }, { status: 409 }))),
      landings: landings({ store, board: workBoard, landing: () => landing, rootOf: rootSession, report: agentReport,
        sendBack: (id, text, key) => sendToAgent(id, text, false, key, undefined, undefined, "owner_back") }),
      live: nowLive, helper: () => helperNow?.() ?? null, away: () => awayNow?.() ?? null, awaySeen: () => awaySeen?.(), ownerSeen: (ms) => void ownerSeen(ms),
      search: (r) => (searchSessions ? searchSessions(r) : Promise.resolve(Response.json({ error: "the search is not loaded" }, { status: 409 }))) }),

    // The budget of interruptions as it stands: the limit, the pushes of the last hour, what is held, when the next slot opens.
    "/api/mobile/budget": { GET: () => json(budget.status()) },
    "/api/mobile/settings": {
      GET: () => json({ public_url: mobile.setting("public_url") ?? process.env.MOBILE_PUBLIC_URL ?? "", push: { configured: push.configured(), path: push.accountPath() } }),
    },
    // A one-time code, the link the app opens and its QR, and a code to type on
    // a phone that cannot scan. The address is the one the phone reaches this
    // machine at (a tunnel); it is remembered.
    "/api/mobile/pair": {
      POST: async (req: Request) => {
        const b = await body(req);
        const url = String(b.public_url ?? mobile.setting("public_url") ?? process.env.MOBILE_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
        if (!/^https?:\/\/[^\s/]+/.test(url)) return bad("give the address the phone reaches this machine at (http or https)");
        mobile.setPublicUrl(url);
        const ttl = Math.min(86_400, Math.max(60, Number(b.ttl_seconds) || 600));
        const { code, typed } = mobile.createPair(ttl);
        const pair_link = pairLink(url, code);
        return json({ code, typed_code: typedShown(typed), public_url: url, pair_link, hermes_link: pairLink(url, code, "hermes"), qr_svg: renderSVG(pair_link, { border: 2 }), ttl_seconds: ttl, expires_ms: Date.now() + ttl * 1000 });
      },
    },
    // What a phone would be sent for an alert: its words, and what its notification may answer.
    "/api/mobile/alerts/:id/push": {
      GET: (req: any) => {
        const a = alertOf(req.params.id);
        return a ? json({ push: pushOf(a) }) : bad("no such alert", 404);
      },
    },
    "/api/mobile/devices": { GET: () => json({ devices: deviceRows() }) },
    "/api/mobile/devices/:id": {
      DELETE: (req: any) => {
        if (!mobile.device(req.params.id)) return bad("unknown device", 404);
        mobile.revoke(req.params.id);
        changed();
        return json({ ok: true });
      },
    },
    "/api/mobile/test-push": {
      POST: async (req: Request) => {
        const id = String((await body(req)).device_id ?? "").trim();
        return testPush(id || undefined);
      },
    },
    "/api/mobile/devices/:id/test-push": { POST: (req: any) => testPush(req.params.id) },
    // Open on phone (src/integrations/mobile/open.ts): one session sent to the paired phones, the answer said when
    // each confirmed it or after a few seconds without.
    "/api/sessions/:id/open-on-phone": {
      POST: async (req: any) => {
        const s = store.session(req.params.id);
        const no = openRefusal(s);
        if (no) return bad(no, s ? 409 : 404);
        if (!mobile.devices().some((d) => !d.revoked)) return bad("No phone is paired. Pair one in Settings > Phone.", 409);
        if (!push.configured()) return bad(`Push is not set up: put the service-account key of the app's Firebase project at ${push.accountPath()}.`, 409);
        let recs: PushRecord[];
        try { recs = await push.send(mobile, mobile.globalSeq(), openPush(s!)); } catch (e) { return bad((e as Error).message, 409); } finally { changed(); }
        const sent = recs.filter((r) => r.ok);
        for (let n = 0; n < 24 && sent.some((r) => !mobile.pushAcked(r.id)); n++) await Bun.sleep(250);
        const names = new Map(mobile.devices().map((d) => [d.id, d.name]));
        const told = recs.map((r) => ({ ...r, acked_ms: r.ok && mobile.pushAcked(r.id) ? Date.now() : null, name: names.get(r.device_id) }));
        const a = openAnswer(told);
        return a.ok ? json({ ...a, pushes: told }) : bad(a.words, 409);
      },
    },
  };
};
