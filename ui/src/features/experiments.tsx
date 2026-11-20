// Experiments and feature observability in the workbench: two settings
// sections, their commands, and a rating under each reply. Imported once from main.tsx.
import { Activity, FlaskConical, ThumbsDown, ThumbsUp } from "lucide-react";
import { lazy, useSyncExternalStore } from "react";
import type { StoredEvent } from "../../../src/core/types.ts";
import { rowActions, settingsSections } from "../lib/extend.ts";
import { registerCommand } from "../lib/keys.ts";
import { api, reportError } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";
import { navigate } from "../lib/ui.ts";

settingsSections.add(
  {
    id: "observability",
    label: "Observability",
    words: "observability features readers run_code code mode compaction cache lifetime speed tool set outcome rating thumbs regression alert savings counterfactual trend",
    icon: <Activity className="size-4" />,
    order: 34,
    component: lazy(() => import("../components/ObservabilityPanel.tsx")),
  },
  {
    id: "experiments",
    label: "Experiments",
    words: "experiment experiments a/b ab test arms variant control hypothesis bootstrap interval significant offline live guard stop decision",
    icon: <FlaskConical className="size-4" />,
    order: 35,
    component: lazy(() => import("../components/ExperimentsPanel.tsx")),
  },
);

registerCommand(
  { id: "observability", label: "Observability: is each feature paying off", group: "General", words: "features regression savings readers", run: () => navigate({ name: "settings", section: "observability" }) },
  { id: "experiments", label: "Experiments", group: "General", words: "a/b test arms", run: () => navigate({ name: "settings", section: "experiments" }) },
);

// The owner's ratings, per session, loaded when a reply of it is first drawn.
const ratings = new Map<string, Record<string, number>>();
const loading = new Set<string>();
const subs = new Set<() => void>();
let version = 0;
const bump = () => { version++; subs.forEach((f) => f()); };
function ensure(sessionId: string) {
  if (ratings.has(sessionId) || loading.has(sessionId)) return;
  loading.add(sessionId);
  api<{ ratings: Record<string, number> }>(`/api/features/ratings?session_id=${encodeURIComponent(sessionId)}`)
    .then((r) => { ratings.set(sessionId, r.ratings); bump(); }).catch(reportError).finally(() => loading.delete(sessionId));
}
function rate(e: StoredEvent, value: 1 | -1) {
  const mine = ratings.get(e.session_id) ?? {};
  const next = mine[e.id] === value ? 0 : value; // pressing the same thumb again takes it back
  ratings.set(e.session_id, { ...mine, [e.id]: next });
  bump();
  api("/api/features/rating", { method: "POST", body: JSON.stringify({ event_id: e.id, value: next }) }).catch((x) => {
    ratings.set(e.session_id, mine);
    bump();
    reportError(x);
  });
}

function Thumb({ e, value }: { e: StoredEvent; value: 1 | -1 }) {
  useSyncExternalStore((f) => (subs.add(f), () => void subs.delete(f)), () => version);
  ensure(e.session_id);
  const on = ratings.get(e.session_id)?.[e.id] === value;
  const Icon = value === 1 ? ThumbsUp : ThumbsDown;
  return <Icon className={cn("size-3.5", on && (value === 1 ? "fill-current text-ok" : "fill-current text-danger"))} data-rated={on ? "on" : "off"} />;
}

// Under a turn's reply (the footer's event is the turn's end): the rating is the turn's.
const isReply = (e: StoredEvent) => e.kind === "turn_end" || e.kind === "assistant";
rowActions.add(
  { id: "rate-up", label: "Good reply", on: "assistant", when: isReply, icon: (e) => <Thumb e={e} value={1} />, run: (e) => rate(e, 1) },
  { id: "rate-down", label: "Bad reply", on: "assistant", when: isReply, icon: (e) => <Thumb e={e} value={-1} />, run: (e) => rate(e, -1) },
);
