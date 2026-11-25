// Client state of secrets: the requests a tool waits on, and the secrets a
// session holds (kept out of its history). Fed by REST and "secret" frames.
import { useSyncExternalStore } from "react";
import type { SecretMeta } from "../../../src/safety/secrets.ts";
import type { SecretRequest } from "../../../src/server/routes/secrets.ts";
import { api, onFeature, readAtOpen, reportError, reportUnlessGone } from "./store.ts";

export type { SecretMeta, SecretRequest };

type State = {
  requests: Record<string, SecretRequest[]>;
  secrets: Record<string, SecretMeta[]>;
  fresh: Record<string, string[]>; // found since the page opened, not yet dismissed
};
let state: State = { requests: {}, secrets: {}, fresh: {} };
const subs = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
};
export const useSecrets = <T,>(sel: (s: State) => T): T => useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => sel(state));

const loaded = new Set<string>();
const upsert = (list: SecretMeta[] = [], m: SecretMeta) => [...list.filter((x) => x.id !== m.id), m];

export const secrets = {
  // A view shows this session's secrets: read as the page loads (once, at its socket's open) or at once after.
  watch(sessionId: string) {
    loaded.add(sessionId);
    readAtOpen(() => secrets.load(sessionId), "secrets");
  },
  async load(sessionId: string) {
    loaded.add(sessionId);
    const r = await api<{ secrets: SecretMeta[]; requests: SecretRequest[] }>(`/api/sessions/${sessionId}/secrets`);
    set({ secrets: { ...state.secrets, [sessionId]: r.secrets }, requests: { ...state.requests, [sessionId]: r.requests } });
  },
  // `confirm`: keep a value the daemon said ordinary text holds (a 409 with `ordinary`).
  give: (sessionId: string, id: string, value: string, confirm = false) => api(`/api/sessions/${sessionId}/secrets/${id}`, { method: "POST", body: JSON.stringify({ value, ...(confirm && { confirm }) }) }),
  decline: (sessionId: string, id: string, reason?: string) => api(`/api/sessions/${sessionId}/secrets/${id}`, { method: "POST", body: JSON.stringify({ deny: true, reason }) }),
  rename: (id: string, name: string | null) => api<{ secret: SecretMeta }>(`/api/secrets/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  forget: (id: string) => api(`/api/secrets/${id}`, { method: "DELETE" }),
  dismiss(sessionId: string, id: string) {
    set({ fresh: { ...state.fresh, [sessionId]: (state.fresh[sessionId] ?? []).filter((x) => x !== id) } });
  },
};

onFeature({
  frame(f) {
    if (f.name !== "secret") return;
    const d = f.data;
    const sid = f.session_id as string | undefined;
    if (d.request && sid) {
      const list = (state.requests[sid] ?? []).filter((r) => r.id !== d.request.id);
      set({ requests: { ...state.requests, [sid]: d.state === "open" ? [...list, d.request] : list } });
    } else if (d.found && sid) {
      const m = d.found as SecretMeta;
      // A secret the owner gave on a card needs no notice; one found in text does.
      const fresh = m.source === "card" ? state.fresh[sid] ?? [] : [...(state.fresh[sid] ?? []).filter((x) => x !== m.id), m.id];
      set({ secrets: { ...state.secrets, [sid]: upsert(state.secrets[sid], m) }, fresh: { ...state.fresh, [sid]: fresh } });
    } else if (d.changed) {
      const m = d.changed as SecretMeta;
      const next = { ...state.secrets };
      for (const s of m.sessions) if (next[s]) next[s] = upsert(next[s], m);
      set({ secrets: next });
    } else if (d.forgotten) {
      const next = Object.fromEntries(Object.entries(state.secrets).map(([k, v]) => [k, v.filter((x) => x.id !== d.forgotten)]));
      set({ secrets: next });
    }
  },
  reconnect() {
    for (const id of loaded) secrets.load(id).catch(reportUnlessGone);
  },
});
