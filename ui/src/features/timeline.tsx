// The Timeline side panel: a session's story from one place. Imported once
// from main.tsx.
import { Route } from "lucide-react";
import { lazy } from "react";
import { panels, type Panel } from "../lib/extend.ts";
import { registerCommand } from "../lib/keys.ts";
import { getState } from "../lib/store.ts";
import { getUI, savePref } from "../lib/ui.ts";

panels.add({
  id: "timeline",
  label: "Timeline",
  icon: <Route className="size-4" />,
  order: 58,
  group: "History",
  component: lazy(() => import("../components/TimelinePanel.tsx")),
} as Panel & { group: string });

registerCommand({
  id: "panel-timeline",
  label: "Timeline panel: what happened in this session, and what it is doing now",
  group: "View",
  words: "history story log turns agents waits approvals failures what happened now receipt",
  when: () => { const r = getUI().route; return r.name === "session" && !!getState().sessions[r.id]; },
  run: () => savePref("panel", getUI().panel === "timeline" ? null : "timeline"),
});
