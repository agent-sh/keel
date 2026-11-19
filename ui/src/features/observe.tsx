// Observability in the workbench: the Traces side panel, the Logs and traces
// settings and their commands. Imported once from main.tsx.
import { Activity, ScrollText } from "lucide-react";
import { lazy } from "react";
import { panels, settingsSections } from "../lib/extend.ts";
import { registerCommand } from "../lib/keys.ts";
import { getState } from "../lib/store.ts";
import { getUI, navigate, savePref } from "../lib/ui.ts";

panels.add({
  id: "traces",
  label: "Traces",
  icon: <Activity className="size-4" />,
  order: 60,
  component: lazy(() => import("../components/TracesPanel.tsx")),
});

settingsSections.add({
  id: "logs",
  label: "Logs and traces",
  words: "log logs debug trace traces opentelemetry otel otlp export phoenix langfuse jaeger",
  icon: <ScrollText className="size-4" />,
  order: 70,
  component: lazy(() => import("../components/LogsSettings.tsx")),
});

const inSession = () => {
  const r = getUI().route;
  return r.name === "session" && !!getState().sessions[r.id];
};

registerCommand(
  { id: "panel-traces", label: "Traces panel: requests, tools and timings per turn", group: "View", words: "trace debug latency request id wire failure", when: inSession, run: () => savePref("panel", getUI().panel === "traces" ? null : "traces") },
  { id: "open-logs", label: "Daemon log", group: "View", words: "logs debug tail", run: () => navigate({ name: "settings", section: "logs" }) },
);
