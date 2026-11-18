// The admin lane's place in the workbench: usage, resources, storage and the
// daemon as settings sections, each with a palette command.
import { BarChart3, Cpu } from "lucide-react";
import { createElement, lazy } from "react";
import { settingsSections } from "./extend.ts";
import { registerCommand } from "./keys.ts";
import { navigate } from "./ui.ts";

settingsSections.add({
  id: "usage",
  label: "Usage",
  words: "usage cost spend tokens cache hit rate latency first token ttft errors telemetry stats tools",
  icon: createElement(BarChart3, { className: "size-4" }),
  order: 30,
  component: lazy(() => import("../components/UsagePanel.tsx").then((m) => ({ default: m.UsagePanel }))),
});

settingsSections.add({
  id: "resources",
  label: "Resources",
  words: "resources memory cpu disk processes rss threads",
  icon: createElement(Cpu, { className: "size-4" }),
  order: 31,
  component: lazy(() => import("../components/ResourcesPanel.tsx").then((m) => ({ default: m.ResourcesPanel }))),
});

registerCommand({ id: "resources", label: "Resources", group: "General", words: "memory cpu disk processes", run: () => navigate({ name: "settings", section: "resources" }) });
registerCommand({ id: "usage", label: "Usage", group: "General", words: "cost spend tokens cache latency stats", run: () => navigate({ name: "settings", section: "usage" }) });
