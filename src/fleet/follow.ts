// Following other machines from this daemon, so a session there reads like
// one here.
//
// Its alerts: the daemon a session runs on raises them (finished, failed,
// needs the owner, an agent of it does), and its relay brings each as a
// frame. This daemon keeps it as an alert of its own (alerts.mirror), so the
// row's mark, the inbox, the channels and the count work as for a session
// here. When its link opens, what was raised while it was down is read, what
// was read on either side meanwhile is made the same, and a read here that
// could not be told there is told.
//
// Its reach: a machine that goes out of reach is said once as an alert, when
// it has stayed out a little while (a daemon that restarts is back before
// that), and the absence is kept in the activity list when it is over. Over
// is when the machine has stayed heard (fleet.ts, steadyMs): one that comes
// and goes is one absence.
import type { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import * as alerts from "../automation/alerts.ts";
import * as connection from "../automation/connection.ts";
import type { MachineRow } from "./db.ts";
import type { Fleet } from "./fleet.ts";
import { LinkError, plainReason } from "./link.ts";

// Out of reach this long before the owner is told: a restart of that daemon, or a blip of the link, is over sooner.
export const offlineAlertMs = () => Number(process.env.KEEL_FLEET_OFFLINE_ALERT_MS) || 15_000;
const CATCH_UP = 200; // the recent alerts read of a machine when its link opens (every unread one comes with them)

const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function bindFollow(f: Fleet, bus: Bus, errors: ErrorTracker): () => void {
  const reading = new Set<string>();
  // The machines whose list was read since their link last opened: an alert told live is then the newest known of there.
  const level = new Set<string>();
  // What that daemon raised, and what was read, while this one did not hear it.
  const catchUp = async (machine: string) => {
    level.delete(machine);
    if (reading.has(machine)) return;
    reading.add(machine);
    try {
      const r = await f.handsJson<{ alerts?: alerts.Alert[] }>(machine, `/api/fleet/linked/alerts?limit=${CATCH_UP}&with_unread`, { idempotent: true });
      if (Array.isArray(r.alerts)) { alerts.mirrorSince(machine, r.alerts); level.add(machine); }
      alerts.tellPendingReads(machine);
    } catch (e) {
      // Out of reach again: the next open of its link reads them.
      if (!(e instanceof LinkError)) errors.capture("server", e, { at: "fleet alerts", machine });
    } finally {
      reading.delete(machine);
    }
  };

  const off = bus.on((fr) => {
    if (fr.t !== "feature") return;
    if (fr.name === "fleet_sessions") {
      const machine = (fr.data as { machine?: string } | undefined)?.machine;
      if (machine) void catchUp(machine);
      return;
    }
    if (fr.name !== "fleet_frame") return;
    const { machine, frame } = fr.data as { machine: string; frame: any };
    if (frame?.t === "session" && frame.deleted && frame.session?.id) return alerts.farGone(machine, frame.session.id);
    if (frame?.t !== "feature" || frame.name !== "automation") return;
    const { kind, data } = (frame.data ?? {}) as { kind?: string; data?: any };
    if (kind === "alert") alerts.mirror(machine, data, level.has(machine));
    else if (kind === "alerts_read" && data?.unread) alerts.farWasUnread(machine, data.unread);
    else if (kind === "alerts_read" && data) alerts.farWasRead(machine, { ids: data.ids, session_id: data.session_id, all: data.all });
  });

  alerts.farHook.has = (session) => {
    const m = session.match(/^([A-Za-z0-9]+)--([\w-]+)$/);
    return !!m && f.remoteHas(m[1]!, m[2]!);
  };
  alerts.farHook.name = (machine) => f.row(machine)?.name;
  alerts.farHook.target = async (machine, alert) => {
    try {
      return await f.handsJson<alerts.Target>(machine, `/api/fleet/linked/alerts/${encodeURIComponent(alert)}/target`, { idempotent: true, timeout: 5_000 });
    } catch {
      return null;
    }
  };
  // Rejects while that machine does not answer: the read is kept and told when its link opens.
  alerts.farHook.read = (machine, ids) => f.handsJson(machine, "/api/fleet/linked/alerts/read", { method: "POST", body: JSON.stringify({ ids }) });
  alerts.farHook.unread = (machine, alert) => f.handsJson(machine, `/api/fleet/linked/alerts/${encodeURIComponent(alert)}/unread`, { method: "POST" });

  // ---- reach
  const holds = new Map<string, Timer>();
  // `least`: the shortest wait (at this daemon's start the machine is first asked again).
  const hold = (m: MachineRow, since: number, least = 0) => {
    clearTimeout(holds.get(m.id));
    holds.set(m.id, setTimeout(() => {
      holds.delete(m.id);
      try {
        const now = f.row(m.id);
        if (!now || now.offline_since !== since || now.state !== "offline" || alerts.raisedOffline(m.id, since)) return; // heard again, removed, or said already
        const theirs = !f.isSsh(now);
        const why = plainReason(now.reason);
        alerts.raise("machine", null, `${now.name} is offline`,
          `${now.name} does not answer since ${clock(since)}.${theirs ? " Its sessions show as they were then." : ""}`,
          { machine_offline: m.id, since_ms: since, ...(why ? { reason: why.slice(0, 200) } : {}) });
      } catch (e) {
        errors.capture("server", e, { at: "fleet offline alert", machine: m.id });
      }
    }, Math.max(least, since + offlineAlertMs() - Date.now())));
  };
  f.onReach = (m, change) => {
    // Out again after a moment of being heard: the same absence, which the alert already said or is about to.
    if (change.state === "offline") return hold(m, change.since);
    clearTimeout(holds.get(m.id));
    holds.delete(m.id);
    // Back, and it has stayed: nothing is left for the owner to do about its alert, which now says it is
    // back and after how long, and the absence is kept.
    const back = Date.now() - f.steadyFor();
    alerts.offlineOver(m.id, change.since, back, m.name, clock);
    alerts.readWhere("machine_offline", m.id);
    connection.machineAbsence({ id: m.id, name: m.name }, change.since, back, plainReason(m.reason) || undefined);
  };
  for (const m of f.rows()) {
    // Out of reach since before this daemon started: said once all the same.
    if (m.offline_since && m.state === "offline") hold(m, m.offline_since, offlineAlertMs());
    // Back for good when the last daemon stopped: an alert it had no time to read is read.
    else if (!m.offline_since) alerts.readWhere("machine_offline", m.id);
  }

  return () => {
    off();
    for (const t of holds.values()) clearTimeout(t);
    holds.clear();
    f.onReach = undefined;
  };
}
