// Client state of the permission gate: open approval cards, each session's
// mode and sandbox, and the standing grants. Fed by REST and feature frames.
import { useSyncExternalStore } from "react";
import type { Approval, SessionPerm } from "../../../src/safety/gate.ts";
import type { Rule, Suggest } from "../../../src/safety/policy.ts";
import { api, onFeature, reportError } from "./store.ts";

export type { Approval, Rule, SessionPerm, Suggest };
export type ModeInfo = { id: SessionPerm["mode"]; name: string; description: string };
export type SandboxInfo = { available: boolean; reason?: string };

type State = {
  approvals: Record<string, Approval[]>; // open cards per session
  perms: Record<string, SessionPerm>;
  grants: Rule[];
  modes: ModeInfo[];
  sandbox: SandboxInfo | null;
};

let state: State = { approvals: {}, perms: {}, grants: [], modes: [], sandbox: null };
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
export function useSafety<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}

const loaded = new Set<string>();

export const safety = {
  // A session deleted meanwhile is dropped, not an error: its views unmount,
  // and a reconnect no longer asks for it.
  async loadSession(id: string) {
    loaded.add(id);
    try {
      const [a, p] = await Promise.all([
        api<{ approvals: Approval[] }>(`/api/sessions/${id}/approvals`),
        api<{ perm: SessionPerm }>(`/api/sessions/${id}/permissions`),
      ]);
      set({ approvals: { ...state.approvals, [id]: a.approvals }, perms: { ...state.perms, [id]: p.perm } });
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
      loaded.delete(id);
      const { [id]: _a, ...approvals } = state.approvals;
      const { [id]: _p, ...perms } = state.perms;
      set({ approvals, perms });
    }
  },
  // Open cards of every session (the sidebar marks the sessions that wait on the owner).
  async loadPending() {
    const r = await api<{ approvals: Approval[] }>("/api/approvals");
    const by: Record<string, Approval[]> = {};
    for (const a of r.approvals) (by[a.session_id] ??= []).push(a);
    set({ approvals: { ...Object.fromEntries(Object.keys(state.approvals).map((k) => [k, []])), ...by } });
  },
  async loadSettings() {
    const r = await api<{ modes: ModeInfo[]; sandbox?: SandboxInfo }>("/api/permissions/settings");
    set({ modes: r.modes, sandbox: r.sandbox ?? null });
  },
  async loadGrants() {
    const r = await api<{ grants: Rule[] }>("/api/permissions/grants");
    set({ grants: r.grants });
  },
  setPerm: async (id: string, patch: Partial<Omit<SessionPerm, "session_id">>) => {
    const r = await api<{ perm: SessionPerm }>(`/api/sessions/${id}/permissions`, { method: "PUT", body: JSON.stringify(patch) });
    set({ perms: { ...state.perms, [id]: r.perm } });
  },
  answer: (sessionId: string, approvalId: string, body: { choice: string; reason?: string; rules?: Suggest[] }) =>
    api(`/api/sessions/${sessionId}/approvals/${approvalId}`, { method: "POST", body: JSON.stringify(body) }),
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
      const list = (state.approvals[a.session_id] ?? []).filter((x) => x.id !== a.id);
      set({ approvals: { ...state.approvals, [a.session_id]: a.state === "pending" ? [...list, a] : list } });
    } else if (f.name === "perm") {
      const p = f.data as SessionPerm;
      set({ perms: { ...state.perms, [p.session_id]: p } });
    } else if (f.name === "grants") {
      safety.loadGrants().catch(reportError);
    }
  },
  reconnect() {
    safety.loadPending().catch(reportError);
    for (const id of loaded) safety.loadSession(id).catch(reportError);
  },
});
