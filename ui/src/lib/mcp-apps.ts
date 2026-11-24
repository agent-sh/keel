// The MCP Apps a session's calls drew (src/server/routes/mcp-apps.ts): each
// app as it was kept, with the calls it made, loaded when its card is shown
// and kept current by "mcp_app_call" frames.
import { useEffect, useSyncExternalStore } from "react";
import type { AppCallRow } from "../../../src/mcp/apps.ts";
import { api, onFeature, reportUnlessGone } from "./store.ts";

export type { AppCallRow };
export type AppView = { id: string; server: string; tool: string; uri: string; error: string | null; prefers_border: boolean | null; csp: Record<string, string[]>; height: number | null; input: unknown; result: unknown; page: boolean; created: number };
type Kept = { app: AppView | null; calls: AppCallRow[]; failed?: string };

const key = (sessionId: string, app: string) => `${sessionId}\u0000${app}`;
let byApp: Record<string, Kept> = {};
const subs = new Set<() => void>();
const changed = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
const EMPTY: Kept = { app: null, calls: [] };

async function load(sessionId: string, app: string) {
  try {
    const r = await api<{ app: AppView; calls: AppCallRow[] }>(`/api/sessions/${sessionId}/mcp-apps/${encodeURIComponent(app)}`);
    // A frame that came while the list loaded is newer than the list.
    const live = new Map((byApp[key(sessionId, app)]?.calls ?? []).map((c) => [c.id, c]));
    const calls = r.calls.map((c) => (live.get(c.id)?.ended && !c.ended ? live.get(c.id)! : c));
    for (const c of live.values()) if (!calls.some((x) => x.id === c.id)) calls.push(c);
    byApp = { ...byApp, [key(sessionId, app)]: { app: r.app, calls: calls.sort((a, b) => a.seq - b.seq) } };
  } catch (e) {
    byApp = { ...byApp, [key(sessionId, app)]: { app: null, calls: [], failed: (e as Error).message } };
    reportUnlessGone(e);
  }
  changed();
}

export function useMcpApp(sessionId: string | undefined, app: string): Kept {
  useEffect(() => {
    if (sessionId && !(key(sessionId, app) in byApp)) {
      byApp = { ...byApp, [key(sessionId, app)]: EMPTY };
      void load(sessionId, app);
    }
  }, [sessionId, app]);
  return useSyncExternalStore(subscribe, () => (sessionId ? byApp[key(sessionId, app)] ?? EMPTY : EMPTY));
}

onFeature({
  frame(f) {
    if (f.name !== "mcp_app_call" || !f.session_id) return;
    const c = f.data as AppCallRow;
    const k = key(f.session_id, c.app);
    const was = byApp[k];
    if (!was) return;
    byApp = { ...byApp, [k]: { ...was, calls: [...was.calls.filter((x) => x.id !== c.id), c].sort((a, b) => a.seq - b.seq) } };
    changed();
  },
  reconnect() {
    for (const k of Object.keys(byApp)) {
      const [sessionId, app] = k.split("\u0000") as [string, string];
      void load(sessionId, app);
    }
  },
});
