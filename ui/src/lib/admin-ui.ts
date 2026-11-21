// The admin lane's place in the workbench: usage, resources, storage and the
// daemon as settings sections, each with a palette command.
import { BarChart3, Cpu, HardDrive, Server } from "lucide-react";
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

settingsSections.add(
  {
    id: "storage",
    label: "Storage",
    words: "storage disk size cleanup delete archived old sessions backup restore archive policy leftovers retention keep spilled output usage records",
    icon: createElement(HardDrive, { className: "size-4" }),
    order: 32,
    component: lazy(() => import("../components/StoragePanel.tsx").then((m) => ({ default: m.StoragePanel }))),
  },
  {
    id: "daemon",
    label: "Daemon",
    words: "daemon restart drain keep awake sleep inhibit report status uptime",
    icon: createElement(Server, { className: "size-4" }),
    order: 33,
    component: lazy(() => import("../components/DaemonPanel.tsx").then((m) => ({ default: m.DaemonPanel }))),
  },
);

registerCommand(
  { id: "storage", label: "Storage", group: "General", words: "disk cleanup backup", run: () => navigate({ name: "settings", section: "storage" }) },
  { id: "daemon", label: "Daemon", group: "General", words: "restart keep awake report", run: () => navigate({ name: "settings", section: "daemon" }) },
);
registerCommand({ id: "resources", label: "Resources", group: "General", words: "memory cpu disk processes", run: () => navigate({ name: "settings", section: "resources" }) });
registerCommand({ id: "usage", label: "Usage", group: "General", words: "cost spend tokens cache latency stats", run: () => navigate({ name: "settings", section: "usage" }) });
