// The Lane plan panel (src/automation/lane-plans.ts): a plan of lanes checked before its agents start.
// Imported once from main.tsx.
import { Rows3 } from "lucide-react";
import { lazy } from "react";
import { panels } from "../lib/extend.ts";
import { registerCommand } from "../lib/keys.ts";
import { getState } from "../lib/store.ts";
import { getUI, savePref } from "../lib/ui.ts";

panels.add({
  id: "lanes",
  label: "Lane plan",
  icon: <Rows3 className="size-4" />,
  order: 35,
  group: "Work",
  hint: "lanes before they start: files, overlaps, order",
  component: lazy(() => import("../components/LanePlan.tsx").then((m) => ({ default: m.LanePlan }))),
});

const inSession = () => {
  const r = getUI().route;
  return r.name === "session" && !!getState().sessions[r.id];
};
registerCommand({
  id: "panel-lanes", label: "Lane plan: the files each lane will touch, where lanes meet, and the order to start them", group: "View", words: "plan lanes parallel agents overlap conflict order coordinator", when: inSession,
  run: () => savePref("panel", getUI().panel === "lanes" ? null : "lanes"),
});
