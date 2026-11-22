// Client state of the fleet: the machines, which machine ran each tool call,
// and the machine a new session starts on. Sessions of other daemons go into
// the main store under "<machine>--<id>".
import { tellRemote, type SessionState } from "./watch.ts";
import { useSyncExternalStore } from "react";
import type { Frame, Session } from "../../../src/core/types.ts";
import { asRemote, relayed, splitId } from "./fleet-ids.ts";
import { actions, api, apply, dropSession, getState, onFeature, reportError, reportUnlessGone } from "./store.ts";
import { setMachines } from "./reach.ts";

export type Facts = { hostname: string; os: string; arch: string; cpus: number; load1: number; mem_total_mb: number; mem_available_mb?: number; gpu?: string; tools: string[]; sandbox: boolean; keel_version: string; root?: string; measured_ms?: number; helper_dir?: string; home?: string };
export type Machine = {
  id: string; name: string; source: "local" | "daemon" | "ssh"; enabled: boolean; state: string; reason?: string; checked_ms?: number;
  // When it was last heard before it went out of reach (absent while it answers).
  offline_since_ms?: number;
  auto_connect?: boolean; messages?: "allow" | "hold"; queue?: { running: number; waiting: number; limit?: number }; facts?: Facts;
  daemon?: { state: string; reason?: string; daemon_id?: string; server_name?: string; version?: string; retry_at_ms?: number };
  ssh_host?: string; workspace_root?: string; colour?: string; daemon_url?: string; daemon_port?: number; max_jobs?: number; detail?: string;
  // An ssh machine with no daemon of its own: the aliases that reach it, the one in use, what Keel put there.
  transport?: "ssh" | "daemon"; routes?: string[]; route?: string; helper?: { runtime: string; helper: string; uploaded: string[]; dir: string };
};
export type RemoteDirs = { path: string; parent: string | null; root: string; is_git: boolean; dirs: { name: string; path: string; is_git: boolean }[] };
export type FleetMachineView = { id: string; name: string; state: string; sessions: Session[]; states?: Record<string, SessionState>; states_rev?: number; questions?: Extract<Frame, { t: "questions" }>; reason?: string; colour?: string; stale?: boolean; retry_at_ms?: number; since_ms?: number };

type State = {
  machines: Machine[];
  view: FleetMachineView[];
  pairs: { daemon_id: string; name: string | null; created: number }[];
  steps: Record<string, Record<string, { machine: string; name: string }>>;
  newMachine: string; // "" = this machine, "auto" = the placement rules
  rules: Rule[];
  autoPlace: Place | null; // where Auto would put a new session now (null: not asked yet)
};
export type Place = { machine_id: string; machine: string; reason: string; rule?: number };
export type Rule = { when: { kind?: "session" | "subagent" | "run"; local_busy?: boolean; needs_gpu?: boolean; heavy?: boolean }; machine: string; note?: string };

let state: State = { machines: [], view: [], pairs: [], steps: {}, newMachine: localStorage.getItem("keel.newMachine") ?? "", rules: [], autoPlace: null };
const subs = new Set<() => void>();
const set = (p: Partial<State>) => { state = { ...state, ...p }; subs.forEach((f) => f()); };
export const useFleet = <T,>(sel: (s: State) => T): T => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => sel(state));
export const getFleet = () => state;

export const machineName = (id?: string | null) => (id ? state.machines.find((m) => m.id === id)?.name ?? state.view.find((m) => m.id === id)?.name ?? id : undefined);
export const machineColour = (id?: string | null) => (id ? state.machines.find((m) => m.id === id)?.colour ?? state.view.find((m) => m.id === id)?.colour : undefined);

// Whether a machine answers now: "ok" (ready or busy), "connecting" (being
// reached, or not checked yet), or "offline" (it did not answer), with why.
export type Reach = { state: "ok" | "connecting" | "offline"; reason?: string };
export function machineReach(id: string, s: Pick<State, "machines" | "view"> = state): Reach {
  const m = s.machines.find((x) => x.id === id);
  const v = s.view.find((x) => x.id === id);
  if (!m && !v) return { state: "connecting" };
  const reason = m?.daemon?.reason ?? m?.reason ?? v?.reason;
  if (m?.state === "offline" || m?.daemon?.state === "offline" || v?.state === "offline" || v?.stale) return { state: "offline", reason };
  if (m && (["starting", "unknown"].includes(m.state) || m.daemon?.state === "connecting")) return { state: "connecting", reason };
  return { state: "ok" };
}

// The machines that do not answer, with since when: what the list's count says
// and what marks their sessions' states (lib/reach.ts). The daemon keeps
// `offline_since_ms` on a machine until it has stayed heard a while, so the
// mark holds through a machine that comes and goes; whether a machine can be
// asked something now is machineReach, which follows every word.
function tellReach() {
  setMachines(
    state.machines.filter((m) => m.enabled && m.id !== "local" && (m.offline_since_ms || machineReach(m.id).state === "offline"))
      .map((m) => ({ id: m.id, name: m.name, since: m.offline_since_ms ?? m.checked_ms ?? 0, reason: m.daemon?.reason ?? m.reason })),
    Object.fromEntries(state.machines.filter((m) => m.id !== "local").map((m) => [m.id, m.name])),
  );
}

export function setNewMachine(id: string) {
  localStorage.setItem("keel.newMachine", id);
  set({ newMachine: id });
}

export const fleet = {
  // Which machine each tool call of a session ran on, read once per session:
  // every tool row asks, one request answers them all. A read that failed is
  // forgotten, so the next row that asks (the session opened again) reads again.
  stepsAsked: {} as Record<string, Promise<void>>,
  ensureSteps(sessionId: string): Promise<void> {
    if (splitId(sessionId)) return Promise.resolve();
    return (this.stepsAsked[sessionId] ??= this.loadSteps(sessionId).catch((e) => {
      delete this.stepsAsked[sessionId];
      throw e;
    }));
  },
  async loadMachines() {
    const [m, p, r] = await Promise.all([
      api<{ machines: Machine[] }>("/api/fleet/machines"),
      api<{ pairs: State["pairs"] }>("/api/fleet/pairs"),
      api<{ rules: Rule[] }>("/api/fleet/placement"),
    ]);
    set({ machines: m.machines, pairs: p.pairs, rules: r.rules });
    tellReach();
  },
  // One view across machines: the other daemons' sessions join the main store.
  async loadView() {
    // Answers can come back out of order: one asked before the last applied
    // one is older news (a stale list must not bring back a row a newer one dropped).
    const mine = ++viewAsked;
    const r = await api<{ machines: FleetMachineView[] }>("/api/fleet?others");
    if (mine < viewApplied) return;
    viewApplied = mine;
    set({ view: r.machines });
    tellReach();
    const { sessions: cur, events } = getState();
    const next: Record<string, Session> = Object.fromEntries(Object.entries(cur).filter(([id]) => !splitId(id)));
    for (const m of r.machines) {
      if (m.id === "local") continue;
      const questions = m.questions && relayed(m.id, m.questions);
      if (questions) apply(questions);
      // Each of its sessions' state as that daemon tells it: shown with the list, not at its next change.
      if (m.states) tellRemote(m.id, m.states, m.states_rev);
      for (const s of m.sessions) {
        const rs = asRemote(m.id, s);
        const held = cur[rs.id];
        // The relay's session listing can lag its event frames. The loaded
        // transcript takes its head from those frames or the session snapshot.
        next[rs.id] = held && held.updated > rs.updated ? held
          : held && events[rs.id] ? { ...rs, head: held.head } : rs;
      }
    }
    for (const s of Object.values(next)) apply({ t: "session", session: s });
    // A machine that shows nothing current keeps the rows it last showed; only a
    // fresh list says a session is gone from it.
    const fresh = new Set(r.machines.filter((m) => !m.stale).map((m) => m.id));
    for (const id of Object.keys(cur)) {
      const sid = splitId(id);
      if (!sid || next[id]) continue;
      if (fresh.has(sid.machine) || !r.machines.some((m) => m.id === sid.machine)) dropSession(id);
      else apply({ t: "session", session: cur[id]! });
    }
  },
  async loadSteps(sessionId: string) {
    if (splitId(sessionId)) return;
    const r = await api<{ steps: State["steps"][string] }>(`/api/sessions/${sessionId}/fleet`);
    set({ steps: { ...state.steps, [sessionId]: r.steps } });
  },
  add: (b: object) => api<{ id: string; machines: Machine[] }>("/api/fleet/machines", { method: "POST", body: JSON.stringify(b) }).then((r) => (set({ machines: r.machines }), r)),
  patch: (id: string, b: object) => api<Machine>(`/api/fleet/machines/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(b) }).then(() => fleet.loadMachines()),
  remove: (id: string) => api<{ machines: Machine[] }>(`/api/fleet/machines/${encodeURIComponent(id)}`, { method: "DELETE" }).then((r) => set({ machines: r.machines })),
  check: async (id: string) => {
    const r = await api<Machine>(`/api/fleet/machines/${encodeURIComponent(id)}/check`, { method: "POST" });
    if (id.startsWith("ssh:")) set({ machines: state.machines.map((m) => (m.id === id ? { ...m, ...r } : m)) });
    else await fleet.loadMachines();
    return r;
  },
  unpair: (daemonId: string) => api(`/api/fleet/pairs/${encodeURIComponent(daemonId)}`, { method: "DELETE" }).then(() => fleet.loadMachines()),
  // Where Auto places a new session, asked again each time it is shown.
  previewAuto: () => api<Place>("/api/fleet/place", { method: "POST", body: JSON.stringify({ kind: "session" }) }).then((p) => (set({ autoPlace: p }), p)),
  // Auto sends the place the start box showed (expect); the daemon says when it changed.
  createOn: (machine: string, text: string, model?: string, images?: unknown[], localWorkspace?: string, expect?: string, workspace?: string) =>
    api<{ session: Session }>("/api/fleet/sessions", { method: "POST", body: JSON.stringify({ machine, text, model, images, local_workspace: localWorkspace, expect_machine: expect, workspace }) })
      .then((r) => (apply({ t: "session", session: r.session }), r.session))
      .catch((e) => {
        if (machine === "auto") void fleet.previewAuto().catch(reportError);
        throw e;
      }),
  dirs: (id: string, path?: string) => api<RemoteDirs>(`/api/fleet/machines/${encodeURIComponent(id)}/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  saveRules: (rules: Rule[]) => api<{ rules: Rule[] }>("/api/fleet/placement", { method: "POST", body: JSON.stringify({ rules }) }).then((r) => set({ rules: r.rules })),
};

let viewAsked = 0;
let viewApplied = 0;
let viewTimer: Timer | undefined;
const reloadView = () => { clearTimeout(viewTimer); viewTimer = setTimeout(() => fleet.loadView().catch(reportError), 150); };
let machinesTimer: Timer | undefined;
const reloadMachines = () => { clearTimeout(machinesTimer); machinesTimer = setTimeout(() => fleet.loadMachines().then(reloadView).catch(reportError), 200); };

onFeature({
  frame(f) {
    if (f.name === "fleet_frame") {
      // The states that come with a relay's snapshot.
      if ((f.data.frame as { t: string }).t === "states") return tellRemote(f.data.machine, (f.data.frame as unknown as { states: Record<string, SessionState> }).states ?? {}, (f.data.frame as { rev?: number }).rev);
      // That daemon's inbox is its own. What it raises for a session shown here, this
      // daemon keeps as an alert of its own and tells in its own frame (src/fleet/follow.ts).
      const inner = f.data.frame as { t: string; name?: string; data?: { kind?: string } };
      if (inner.t === "feature" && inner.name === "automation" && (inner.data?.kind === "alert" || inner.data?.kind === "alerts_read")) return;
      const fr = relayed(f.data.machine, f.data.frame);
      if (fr) apply(fr);
    } else if (f.name === "fleet_machines") reloadMachines();
    else if (f.name === "fleet_sessions") {
      reloadView();
      // The link to that machine came back: transcripts of its sessions open
      // here catch up on what was said meanwhile (merged by event id).
      const machine = (f.data as { machine?: string } | undefined)?.machine;
      for (const id of Object.keys(getState().events)) if (machine && splitId(id)?.machine === machine) actions.loadSession(id).catch(reportUnlessGone);
    }
    else if (f.name === "fleet_step" && f.session_id) {
      set({ steps: { ...state.steps, [f.session_id]: { ...state.steps[f.session_id], [f.data.call_id]: { machine: f.data.machine, name: f.data.name } } } });
    }
  },
  reconnect() {
    fleet.loadMachines().then(() => fleet.loadView()).catch(reportError);
  },
});
