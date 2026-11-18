// The providers lane's place in the workbench: a settings section and a command.
import { Plug } from "lucide-react";
import { createElement, lazy } from "react";
import { settingsSections } from "./extend.ts";
import { registerCommand } from "./keys.ts";
import { navigate } from "./ui.ts";

settingsSections.add({
  id: "providers",
  label: "Providers",
  words: "provider plugin sign in key listing endpoint subscription plan price",
  icon: createElement(Plug, { className: "size-4" }),
  order: 11,
  component: lazy(() => import("../components/ProvidersPanel.tsx").then((m) => ({ default: m.ProvidersSettings }))),
});

registerCommand({ id: "providers", label: "Providers", group: "General", words: "plugins sign in keys listings", run: () => navigate({ name: "settings", section: "providers" }) });
