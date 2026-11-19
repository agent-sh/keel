// The phone: pairing and the device list for the workbench (/api/mobile), the
// Hermes Mobile API the phone app calls (/v1), and phone push as an alert channel.
import { renderSVG } from "uqr";
import { atDesk, registerChannel, type Alert } from "../../automation/alerts.ts";
import { holdThenSend, screenUnlocked } from "../../integrations/mobile/hold.ts";
import * as push from "../../integrations/mobile/push.ts";
import { hostOf, MobileStore } from "../../integrations/mobile/store.ts";
import { mobileApi, pairLink } from "../../integrations/mobile/v1.ts";
import type { Deps, RouteModule } from "../app.ts";
import { addAllowedHosts } from "../admission.ts";
import { pendingQuestions } from "../../tools/interact.ts";
import { gate } from "./permissions.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
const body = async (req: Request) => ((await req.json().catch(() => ({}))) ?? {}) as any;

// What an alert becomes on the phone: the kind the app's wake handler knows,
// who asks and what may be answered from the notification.
export function alertPush(a: Alert): push.PushMessage {
  const kind = a.kind === "question" ? "approval" : a.kind;
  const data: Record<string, string> = { title: a.title, body: a.body, ek: a.kind, pri: "", reply: a.kind === "finished" || a.kind === "question" ? "1" : "0" };
  const aid = a.data?.approval_id ?? (a.data?.call_id ? `q-${a.data.call_id}` : undefined);
  if (aid) data.aid = String(aid);
  if (a.kind === "approval") data.opts = JSON.stringify(a.data?.risk === "high" ? ["once", "deny"] : ["once", "session", "deny"]);
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
          const recs = await push.send(mobile, mobile.globalSeq(), alertPush(a));
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
    ...mobileApi({ ...deps, mobile, gate: () => gate, changed }),

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
        return json({ code, public_url: url, pair_link, qr_svg: renderSVG(pair_link, { border: 2 }), ttl_seconds: ttl, expires_ms: Date.now() + ttl * 1000 });
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
