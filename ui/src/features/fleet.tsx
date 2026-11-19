// The fleet lane's pieces of the workbench: the Machines settings page and a
// palette command. Sessions of other machines join the session list through
// lib/fleet.ts. Imported once from main.tsx.
import { Globe, Network } from "lucide-react";
import { lazy } from "react";
import { panels, settingsSections } from "../lib/extend.ts";
import "../lib/fleet.ts";
import { registerCommand } from "../lib/keys.ts";
import { navigate } from "../lib/ui.ts";

settingsSections.add({
  id: "machines",
  label: "Machines",
  words: "fleet machine peer daemon ssh host remote pair link gpu",
  icon: <Network className="size-4" />,
  order: 15,
  component: lazy(() => import("../components/MachinesPanel.tsx").then((m) => ({ default: m.MachinesSettings }))),
});

panels.add({
  id: "preview",
  label: "Preview",
  icon: <Globe className="size-4" />,
  order: 40,
  component: lazy(() => import("../components/PreviewPanel.tsx").then((m) => ({ default: m.PreviewPanel }))),
});

registerCommand({ id: "machines", label: "Machines: the fleet, its links and checks", group: "Go", words: "fleet peer daemon ssh remote", run: () => navigate({ name: "settings", section: "machines" }) });
