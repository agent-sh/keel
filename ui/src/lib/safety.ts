// Client state of the permission gate: open approval cards, each session's
// mode and sandbox, and the standing grants. Fed by REST and feature frames.
import { useSyncExternalStore } from "react";
import type { Approval, BatchResult, SessionPerm } from "../../../src/safety/gate.ts";
import type { Rule, Suggest } from "../../../src/safety/policy.ts";
import { cardOrder } from "../../../src/safety/card-order.ts";
import { api, newer, onFeature, readAtOpen, reportError } from "./store.ts";

export type { Approval, Rule, SessionPerm, Suggest };
export type ModeInfo = { id: SessionPerm["mode"]; name: string; description: string; group?: string; summary?: string };
export type ModeGroup = { id: string; name: string };
export type SandboxInfo = { available: boolean; reason?: string; seccomp?: boolean; seccompReason?: string };

type State = {
  approvals: Record<string, Approval[]>; // open cards per session
  perms: Record<string, SessionPerm>;
  grants: Rule[];
  modes: ModeInfo[];
  modeGroups: ModeGroup[];
  sandbox: SandboxInfo | null;
  defaultMode: string | null; // the mode new sessions start in (the owner's setting)
};

let state: State = { approvals: {}, perms: {}, grants: [], modes: [], modeGroups: [], sandbox: null, defaultMode: null };
const subs = new Set<() => void>();
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
};
export const getSafetyModes = () => state.modes;
// The store as it is now, for an action that reads it once (a navigation).
export const getSafety = () => state;
export function useSafety<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}

const put = (list: Approval[], a: Approval) => {
  const rest = list.filter((x) => x.id !== a.id);
  return a.state === "pending" ? cardOrder([...rest, a]) : rest;
};

// Receipt order is not decision order: frames that land while a snapshot is
// on its way are replayed over it, so an older snapshot never brings back an
// answered card or hides a new one.
const inflight = new Set<Approval[]>();
async function hydrate<T>(load: () => Promise<T>): Promise<[T, Approval[]]> {
  const seen: Approval[] = [];
  inflight.add(seen);
  try {
    return [await load(), seen];
  } finally {
    inflight.delete(seen);
  }
}
const replay = (list: Approval[], seen: Approval[], session?: string) =>
  seen.filter((a) => !session || a.session_id === session).reduce(put, cardOrder(list));

// Sessions on screen now (counted per view): a reconnect rereads these, not
// every session this tab has ever shown. The rest come from the global list.
const shown = new Map<string, number>();

export const safety = {
  // A session deleted meanwhile is dropped, not an error: its views unmount,
  // and a reconnect no longer asks for it.
  async loadSession(id: string) {
    try {
      const [[a, p], seen] = await hydrate(() => Promise.all([
        api<{ approvals: Approval[] }>(`/api/sessions/${id}/approvals`),
        api<{ perm: SessionPerm; rev?: number }>(`/api/sessions/${id}/permissions`),
      ]));
      // The mode is ordered by the bus rev: a snapshot read before a newer
      // perm frame never puts back the mode that frame replaced (a stale
      // read must not loosen what the owner just set, or tighten it back).
      set({ approvals: { ...state.approvals, [id]: replay(a.approvals, seen, id) }, perms: newer(`${id}:perm`, p.rev, true) ? { ...state.perms, [id]: p.perm } : state.perms });
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
      shown.delete(id);
      const { [id]: _a, ...approvals } = state.approvals;
      const { [id]: _p, ...perms } = state.perms;
      set({ approvals, perms });
    }
  },
  // A view shows this session's cards and mode: loaded now, and again on a
  // reconnect while the view stays. Returns the release.
  watch(id: string): () => void {
    shown.set(id, (shown.get(id) ?? 0) + 1);
    safety.loadSession(id).catch(reportError);
    return () => {
      const n = (shown.get(id) ?? 1) - 1;
      if (n > 0) shown.set(id, n);
      else shown.delete(id);
    };
  },
  // Open cards of every session (the sidebar marks the sessions that wait on the owner).
  async loadPending() {
    const [r, seen] = await hydrate(() => api<{ approvals: Approval[] }>("/api/approvals"));
    const by: Record<string, Approval[]> = Object.fromEntries(Object.keys(state.approvals).map((k) => [k, []]));
    for (const a of r.approvals) (by[a.session_id] ??= []).push(a);
    for (const a of seen) by[a.session_id] ??= [];
    set({ approvals: Object.fromEntries(Object.entries(by).map(([k, list]) => [k, replay(list, seen, k)])) });
  },
  async loadSettings() {
    const r = await api<{ default_mode?: string; modes: ModeInfo[]; mode_groups?: ModeGroup[]; sandbox?: SandboxInfo }>("/api/permissions/settings");
    set({ modes: r.modes, modeGroups: r.mode_groups ?? [], sandbox: r.sandbox ?? null, defaultMode: r.default_mode ?? null });
  },
  async loadGrants() {
    const r = await api<{ grants: Rule[] }>("/api/permissions/grants");
    set({ grants: r.grants });
  },
  setPerm: async (id: string, patch: Partial<Omit<SessionPerm, "session_id">>) => {
    const r = await api<{ perm: SessionPerm; rev?: number }>(`/api/sessions/${id}/permissions`, { method: "PUT", body: JSON.stringify(patch) });
    if (newer(`${id}:perm`, r.rev, true)) set({ perms: { ...state.perms, [id]: r.perm } });
  },
  // `seen: "whole"`: the card's word that all of the request's text was on
  // screen before the answer. The daemon takes an allow of a text one line
  // does not show whole only with it (src/safety/card.ts), from any client.
  answer: (sessionId: string, approvalId: string, body: { choice: string; reason?: string; rules?: Suggest[]; seen?: "whole" }) =>
    api(`/api/sessions/${sessionId}/approvals/${approvalId}`, { method: "POST", body: JSON.stringify({ ...body, via: "page" }) }),
  // "Mine" on a card of a write beyond the owner's accounts: the namespace it names joins his list (Settings > Permissions >
  // Your accounts), then the card is allowed once.
  addNamespace: (namespace: string) => api("/api/accounts/namespaces", { method: "POST", body: JSON.stringify({ namespace }) }),
  // The same press on an MCP tool's card: the tool is marked as a read of its server, then the card is allowed once.
  markRead: (server: string, tool: string) => api(`/api/mcp/servers/${encodeURIComponent(server)}/reads`, { method: "POST", body: JSON.stringify({ tool }) }),
  // Several cards allowed once with one answer: the daemon refuses the whole
  // list if it names one that is answered alone, and says how each went.
  // (The one caller is "allow all", which covers only requests whose text
  // stood whole on screen: lib/approvals.ts, batches.)
  answerMany: (sessionId: string, ids: string[]) =>
    api<{ results: BatchResult[] }>(`/api/sessions/${sessionId}/approvals`, { method: "POST", body: JSON.stringify({ choice: "once", ids, seen: "whole", via: "page" }) }),
  restore: async (id: string) => {
    await api(`/api/permissions/grants/${id}/restore`, { method: "POST" });
    await safety.loadGrants();
  },
  revoke: async (id: string) => {
    await api(`/api/permissions/grants/${id}`, { method: "DELETE" });
    set({ grants: state.grants.filter((g) => g.id !== id) });
  },
};

onFeature({
  frame(f) {
    if (f.name === "approval") {
      const a = f.data as Approval;
      for (const seen of inflight) seen.push(a);
      set({ approvals: { ...state.approvals, [a.session_id]: put(state.approvals[a.session_id] ?? [], a) } });
    } else if (f.name === "perm") {
      const p = f.data as SessionPerm;
      if (newer(`${p.session_id}:perm`, f.rev)) set({ perms: { ...state.perms, [p.session_id]: p } });
    } else if (f.name === "grants") {
      safety.loadGrants().catch(reportError);
    }
  },
  reconnect() {
    pending();
    if (state.modes.length) safety.loadSettings().catch(reportError);
    for (const id of shown.keys()) safety.loadSession(id).catch(reportError);
  },
});
// The open cards of every session, read as the page loads.
const pending = readAtOpen(() => safety.loadPending());
