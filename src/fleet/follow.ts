// Following other machines from this daemon, so a session there reads like
// one here.
//
// Its alerts: the daemon a session runs on raises them (finished, failed,
// needs the owner, an agent of it does), and its relay brings each as a
// frame. This daemon keeps it as an alert of its own (alerts.mirror), so the
// row's mark, the inbox, the channels and the count work as for a session
// here. What was raised while the link was down is read when it opens again.
// A read there is a read here, and a read here is told there.
//
// Its reach: a machine that goes out of reach is said once as an alert, when
// it has stayed out a little while (a daemon that restarts is back before
// that), and the absence is kept in the activity list when it ends.
import type { Bus } from "../core/bus.ts";
import type { ErrorTracker } from "../core/errors.ts";
import * as alerts from "../automation/alerts.ts";
import * as connection from "../automation/connection.ts";
import type { MachineRow } from "./db.ts";
import type { Fleet } from "./fleet.ts";
import { LinkError } from "./link.ts";

// Out of reach this long before the owner is told: a restart of that daemon, or a blip of the link, is over sooner.
export const OFFLINE_ALERT_MS = Number(process.env.KEEL_FLEET_OFFLINE_ALERT_MS) || 15_000;
const CATCH_UP = 200; // the alerts read of a machine when its link opens
// Heard this long, a machine is back: the bound a relay's stream must hold to count as read (fleet.ts).
export const STEADY_MS = Number(process.env.KEEL_FLEET_STEADY_MS) || 30_000;

const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function bindFollow(f: Fleet, bus: Bus, errors: ErrorTracker): () => void {
  const reading = new Set<string>();
  // The machines whose list was read since their link last opened: an alert told live is then the newest known of there.
  const level = new Set<string>();
  // What that daemon raised while this one did not hear it.
  const catchUp = async (machine: string) => {
    level.delete(machine);
    if (reading.has(machine)) return;
    reading.add(machine);
    try {
      const r = await f.handsJson<{ alerts?: alerts.Alert[] }>(machine, `/api/fleet/linked/alerts?limit=${CATCH_UP}`, { idempotent: true });
      if (Array.isArray(r.alerts)) { alerts.mirrorSince(machine, r.alerts); level.add(machine); }
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
    else if (kind === "alerts_read" && data && !data.unread) alerts.farWasRead(machine, { ids: data.ids, session_id: data.session_id, all: data.all });
  });

  alerts.farHook.has = (session) => {
    const m = session.match(/^([A-Za-z0-9]+)--([\w-]+)$/);
    return !!m && f.remoteHas(m[1]!, m[2]!);
  };
  alerts.farHook.target = async (machine, alert) => {
    try {
      return await f.handsJson<alerts.Target>(machine, `/api/fleet/linked/alerts/${encodeURIComponent(alert)}/target`, { idempotent: true, timeout: 5_000 });
    } catch {
      return null;
    }
  };
  alerts.farHook.read = (machine, ids) => {
    f.handsJson(machine, "/api/fleet/linked/alerts/read", { method: "POST", body: JSON.stringify({ ids }) })
      .catch((e) => { if (!(e instanceof LinkError)) errors.capture("server", e, { at: "fleet alerts read", machine }); });
  };

  // ---- reach
  // The absence the owner is told of, per machine. A machine heard again for
  // less than STEADY_MS and lost again never came back: it is the same
  // absence (one alert, one row in the activity list), however often its
  // stream opens and is cut.
  type Absence = { since: number; hold?: Timer; back?: { at: number; timer: Timer } };
  const absences = new Map<string, Absence>();
  // `least`: the shortest wait (at this daemon's start the machine is first asked again).
  const hold = (m: MachineRow, a: Absence, least = 0) => {
    clearTimeout(a.hold);
    a.hold = setTimeout(() => {
      a.hold = undefined;
      try {
        const now = f.row(m.id);
        if (!now?.offline_since || absences.get(m.id) !== a || a.back || alerts.raisedOffline(m.id, a.since)) return; // heard again, removed, or said already
        const theirs = !f.isSsh(now);
        alerts.raise("failed", null, `${now.name} is offline`,
          `Not heard from since ${clock(a.since)}${now.reason ? `: ${now.reason}` : ""}.${theirs ? " Its sessions show as they were then." : ""}`,
          { machine_offline: m.id, since_ms: a.since });
      } catch (e) {
        errors.capture("server", e, { at: "fleet offline alert", machine: m.id });
      }
    }, Math.max(least, a.since + OFFLINE_ALERT_MS - Date.now()));
  };
  f.onReach = (m, change) => {
    let a = absences.get(m.id);
    if (change.state === "offline") {
      if (a?.back) { clearTimeout(a.back.timer); a.back = undefined; } // heard for a moment only: the absence goes on
      else absences.set(m.id, (a = { since: change.since }));
      return hold(m, a!);
    }
    if (!a) absences.set(m.id, (a = { since: change.since }));
    clearTimeout(a.hold);
    a.hold = undefined;
    const at = Date.now();
    // The pages say it at once. The absence is over once the machine has stayed heard:
    // then nothing is left for the owner to do about its alert, and it is kept in the activity list.
    bus.emit({ t: "feature", name: "fleet_back", data: { machine: m.id, name: m.name, since: change.since, at } });
    const over = a;
    clearTimeout(over.back?.timer);
    over.back = {
      at,
      timer: setTimeout(() => {
        if (absences.get(m.id) === over) absences.delete(m.id);
        try {
          alerts.readWhere("machine_offline", m.id);
          connection.machineAbsence({ id: m.id, name: m.name }, over.since, at, m.reason ?? undefined);
        } catch (e) {
          errors.capture("server", e, { at: "fleet back", machine: m.id });
        }
      }, STEADY_MS),
    };
  };
  for (const m of f.rows()) {
    // Out of reach since before this daemon started: said once all the same.
    if (m.offline_since && m.state === "offline") { const a: Absence = { since: m.offline_since }; absences.set(m.id, a); hold(m, a, OFFLINE_ALERT_MS); }
    // Heard when the last daemon stopped: an alert it had no time to read is read.
    else alerts.readWhere("machine_offline", m.id);
  }

  return () => {
    off();
    for (const a of absences.values()) { clearTimeout(a.hold); clearTimeout(a.back?.timer); }
    absences.clear();
    f.onReach = undefined;
  };
}
