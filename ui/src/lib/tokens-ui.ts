// The session's token view as a side-panel tab, with a palette command.
import { Coins } from "lucide-react";
import { createElement, lazy } from "react";
import { panels } from "./extend.ts";
import { registerCommand } from "./keys.ts";
import { getUI, savePref } from "./ui.ts";

panels.add({
  id: "usage",
  label: "Tokens",
  icon: createElement(Coins, { className: "size-4" }),
  order: 40,
  component: lazy(() => import("../components/SessionUsage.tsx").then((m) => ({ default: m.SessionUsage }))),
});

registerCommand({
  id: "panel-usage", label: "Tokens panel", group: "View", words: "usage cost cache tokens per turn",
  when: () => getUI().route.name === "session",
  run: () => savePref("panel", getUI().panel === "usage" ? null : "usage"),
});
