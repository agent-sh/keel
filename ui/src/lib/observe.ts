// Traces, the debug bundle and "fix this", shared by the Errors panel, the
// Traces side panel and the Logs settings.
import { api } from "./store.ts";
import { getUI, navigate, savePref, setUI } from "./ui.ts";

export type Span = {
  span_id: string;
  trace_id: string;
  parent_id: string | null;
  session_id: string;
  kind: "turn" | "request" | "tool";
  name: string;
  start_ms: number;
  end_ms: number | null;
  status: "running" | "ok" | "error" | "interrupted";
  error: string | null;
  error_type: string | null;
  error_id: string | null;
  attrs: Record<string, any>;
  replayable: boolean;
};

export type BundleTarget = { error_id?: string; session_id?: string; turn_event?: string };

const query = (t: BundleTarget) => new URLSearchParams(Object.entries(t).filter(([, v]) => v) as [string, string][]).toString();

export async function bundleText(t: BundleTarget): Promise<string> {
  const r = await fetch(`/api/debug/bundle?${query(t)}`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  return r.text();
}

export async function copyBundle(t: BundleTarget) {
  await navigator.clipboard.writeText(await bundleText(t));
}

// A new session asked to find the cause and fix it, with the bundle on disk; the page goes there.
export async function fixThis(t: BundleTarget) {
  const r = await api<{ session: { id: string }; path: string }>("/api/debug/fix", { method: "POST", body: JSON.stringify(t) });
  setUI({ errors: false });
  navigate({ name: "session", id: r.session.id });
  return r;
}

// The trace the Traces panel shows when it opens next.
let focus: string | null = null;
const subs = new Set<() => void>();
export const traceFocus = {
  get: () => focus,
  set(id: string | null) { focus = id; subs.forEach((f) => f()); },
  subscribe: (f: () => void) => (subs.add(f), () => void subs.delete(f)),
};

export function openTrace(sessionId: string, traceId: string | null) {
  traceFocus.set(traceId);
  setUI({ errors: false });
  if (getUI().panel !== "traces") savePref("panel", "traces");
  navigate({ name: "session", id: sessionId });
}

// The trace id of a turn is its turn_start event id without the dashes.
export const traceOfTurn = (turnEvent: string) => turnEvent.replace(/-/g, "").toLowerCase();

export const spanMs = (s: Span) => (s.end_ms ?? Date.now()) - s.start_ms;
export const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
