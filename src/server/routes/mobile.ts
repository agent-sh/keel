// The phone: pairing and the device list for the workbench (/api/mobile), the
// Hermes Mobile API the phone app calls (/v1), and phone push as an alert channel.
import { renderSVG } from "uqr";
import { atDesk, get as alertOf, registerChannel, type Alert } from "../../automation/alerts.ts";
import { holdThenSend, screenUnlocked } from "../../integrations/mobile/hold.ts";
import * as push from "../../integrations/mobile/push.ts";
import { hostOf, MobileStore } from "../../integrations/mobile/store.ts";
import { mobileApi, pairLink } from "../../integrations/mobile/v1.ts";
import type { Deps, RouteModule } from "../app.ts";
import { addAllowedHosts } from "../admission.ts";
import { allPendingQuestions, pendingQuestions } from "../../tools/interact.ts";
import { liveData, liveStatus, LiveTicker } from "../../integrations/mobile/live.ts";
import { agentCounts } from "../../automation/state.ts";
import { plansWaiting } from "./plan.ts";
import { gate } from "./permissions.ts";
import { checkpoints } from "./checkpoints.ts";
import { fleetMachines, startFleetSession } from "./fleet.ts";
import { awayNow, awaySeen } from "./overview.ts";
import { ownerSeen } from "../../admin/away.ts";

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
export function alertPush(a: Alert, card?: { hold: string[]; glance: boolean; line: string }): push.PushMessage {
  const kind = a.kind === "question" ? "approval" : a.kind;
  const data: Record<string, string> = { title: a.title, body: card?.line ?? a.body, ek: a.kind, pri: "", reply: a.kind === "finished" || a.kind === "question" ? "1" : "0" };
  const aid = a.data?.approval_id ?? (a.data?.call_id ? `q-${a.data.open_session ?? a.session_id}.${a.data.call_id}` : a.data?.plan_id ? `plan-${a.data.open_session ?? a.session_id}.${a.data.plan_id}` : undefined);
  if (aid) data.aid = String(aid);
  // A plan is read whole in the app before it is approved: its notification opens it, and allows nothing.
  if (a.data?.plan_id) { data.hold = "plan"; data.opts = JSON.stringify(["deny"]); }
  if (a.kind === "approval") {
    // An alert from before cards recorded this says nothing: no Allow.
    const held: string[] = card?.hold ?? (Array.isArray(a.data?.hold) ? a.data.hold : a.data?.risk === "high" ? ["risk"] : []);
    data.hold = held.join(",");
    data.opts = JSON.stringify((card ? card.glance : a.data?.glance === true) ? ["once", "deny"] : ["deny"]);
  }
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
    return alertPush(a, card ? gate!.form(card) : undefined);
  };
  // The phone's lasting notification while turns run (src/integrations/mobile/live.ts): what runs and
  // what waits on the owner, per session nobody started (an agent's part is its root's).
  const rootOf = (id: string) => {
    let at = id;
    for (let n = 0, p = store.session(at)?.parent_id; p && n < 32; n++, p = store.session(at)?.parent_id) at = p;
    return at;
  };
  const turnStart = (sid: string) => store.db.query<{ ts: number | null }, [string]>("SELECT MAX(ts) AS ts FROM events WHERE session_id = ? AND kind = 'turn_start'").get(sid)?.ts ?? undefined;
  const readLive = () => {
    const waits = new Map<string, number>();
    const add = (sid: string) => { const r = rootOf(sid); waits.set(r, (waits.get(r) ?? 0) + 1); };
    for (const a of gate?.approvals({ pending: true }) ?? []) add(a.session_id);
    for (const q of allPendingQuestions()) add(q.session_id);
    for (const p of plansWaiting()) add(p.session_id);
    const below = agentCounts({ store });
    return liveStatus(store.sessions().filter((s) => !s.parent_id).map((s) => {
      const running = deps.engine.isRunning(s.id) || (below.get(s.id) ?? 0) > 0;
      return { title: s.title, running, since: running ? turnStart(s.id) : undefined, needs: waits.get(s.id) ?? 0 };
    }));
  };
  const live = new LiveTicker(readLive, async (s) => {
    const recs = await push.send(mobile, mobile.globalSeq(), { kind: "live", high: false, data: liveData(s) });
    for (const r of recs) if (!r.ok) errors.capture("server", new Error(`phone push failed: ${r.error}`), { live: true, device: r.device_id });
  }, 20_000, () => push.configured() && mobile.pushTargets().length > 0);
  bus.on((f) => {
    if (f.t === "session" || (f.t === "feature" && (f.name === "approval" || f.name === "plan" || f.name === "automation"))) live.poke();
  });

  // Sessions the phone holds a notification for, so a withdraw goes only there.
  const shown = new Set<string>();
  registerChannel({
    id: "push",
    label: "Phone push",
    available: () => push.configured() && mobile.pushTargets().length > 0,
    async deliver(a) {
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
      await holdThenSend({
        needsAnswer: a.kind === "approval" || a.kind === "question",
        stillOpen,
        atDesk: async () => atDesk() || (await screenUnlocked()),
        sleep: (ms) => Bun.sleep(ms),
        send: async () => {
          const recs = await push.send(mobile, mobile.globalSeq(), pushOf(a));
          if (a.session_id && recs.some((r) => r.ok)) shown.add(a.session_id);
          for (const r of recs) if (!r.ok) errors.capture("server", new Error(`phone push failed: ${r.error}`), { alert: a.id, device: r.device_id });
          if (recs.length) changed();
        },
      });
    },
    // Nothing in the session is unread any more (answered or read on the
    // desktop): the phone takes down what it shows for it. Normal priority, no
    // notification of its own; the phone needs no network to act on it.
    async withdraw(sessionId) {
      if (!shown.delete(sessionId) || !push.configured() || !mobile.pushTargets().length) return;
      const recs = await push.send(mobile, mobile.globalSeq(), { kind: "withdraw", session_id: sessionId, high: false, data: {} });
      for (const r of recs) if (!r.ok) errors.capture("server", new Error(`phone push failed: ${r.error}`), { withdraw: sessionId, device: r.device_id });
      if (recs.length) changed();
    },
  });

  return {
    ...mobileApi({ ...deps, mobile, gate: () => gate, changed, checkpoints: () => checkpoints, fleetMachines: () => fleetMachines?.() ?? Promise.resolve([]), startFleetSession: (b) => (startFleetSession ? startFleetSession(b) : Promise.resolve(Response.json({ error: "this daemon has no machines to start a session on" }, { status: 409 }))),
      away: () => awayNow?.() ?? null, awaySeen: () => awaySeen?.(), ownerSeen: (ms) => void ownerSeen(ms) }),

    "/api/mobile/settings": {
      GET: () => json({ public_url: mobile.setting("public_url") ?? process.env.MOBILE_PUBLIC_URL ?? "", push: { configured: push.configured(), path: push.accountPath() } }),
    },
    // A one-time code, the link the app opens and its QR. The address is the
    // one the phone reaches this machine at (a tunnel); it is remembered.
    "/api/mobile/pair": {
      POST: async (req: Request) => {
        const b = await body(req);
        const url = String(b.public_url ?? mobile.setting("public_url") ?? process.env.MOBILE_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
        if (!/^https?:\/\/[^\s/]+/.test(url)) return bad("give the address the phone reaches this machine at (http or https)");
        mobile.setPublicUrl(url);
        const ttl = Math.min(86_400, Math.max(60, Number(b.ttl_seconds) || 600));
        const code = mobile.createPairCode(ttl);
        const pair_link = pairLink(url, code);
        return json({ code, public_url: url, pair_link, hermes_link: pairLink(url, code, "hermes"), qr_svg: renderSVG(pair_link, { border: 2 }), ttl_seconds: ttl, expires_ms: Date.now() + ttl * 1000 });
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
  };
};
