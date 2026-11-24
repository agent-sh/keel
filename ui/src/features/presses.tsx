// Settings > Telemetry: what the owner presses, from the local record the page
// keeps (lib/presses.ts). Imported once from main.tsx; it also starts the record.
import { MousePointerClick } from "lucide-react";
import { createElement, lazy } from "react";
import { settingsSections } from "../lib/extend.ts";
import { registerCommand } from "../lib/keys.ts";
import { installPresses } from "../lib/presses.ts";
import { navigate } from "../lib/ui.ts";

settingsSections.add({
  id: "telemetry",
  label: "Telemetry",
  words: "telemetry what you press presses clicks buttons controls most used never pressed interaction privacy local record usage of the interface",
  icon: createElement(MousePointerClick, { className: "size-4" }),
  order: 33.5,
  component: lazy(() => import("../components/PressesPanel.tsx")),
});

registerCommand({ id: "telemetry", label: "Telemetry: what you press", group: "General", words: "presses clicks controls most used never pressed", run: () => navigate({ name: "settings", section: "telemetry" }) });

installPresses();
