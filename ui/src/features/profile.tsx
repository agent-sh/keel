// The session's profile as a side-panel tab: its model and route, reasoning and
// speed with what the model offers, the tools its family gets and how they
// edit, and the instruction files its prompt carries. Imported from main.tsx.
import { SlidersHorizontal } from "lucide-react";
import { lazy } from "react";
import { panels } from "../lib/extend.ts";
import { registerCommand } from "../lib/keys.ts";
import { getUI, savePref } from "../lib/ui.ts";

panels.add({
  id: "profile",
  label: "Profile",
  icon: <SlidersHorizontal className="size-4" />,
  order: 45,
  component: lazy(() => import("../components/ProfilePanel.tsx").then((m) => ({ default: m.ProfilePanel }))),
});

registerCommand({
  id: "panel-profile", label: "Session profile: model, speed, tools, instructions", group: "View",
  words: "model provider family tools edit grammar instructions agents.md speed effort",
  when: () => getUI().route.name === "session",
  run: () => savePref("panel", getUI().panel === "profile" ? null : "profile"),
});
