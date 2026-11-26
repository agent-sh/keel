// Your asks (src/board/asks.ts): what the owner asked for in a top-level session, each with its state from
// facts. A panel; the session's menu and the dock's plan line open it. Imported once from main.tsx.
import { ListTodo } from "lucide-react";
import { lazy } from "react";
import { panels } from "../lib/extend.ts";
import { registerCommand } from "../lib/keys.ts";
import { getState } from "../lib/store.ts";
import { getUI, savePref } from "../lib/ui.ts";
import { hasAsks } from "../lib/asks-eligible.ts";


panels.add({
  id: "asks",
  label: "Your asks",
  icon: <ListTodo className="size-4" />,
  order: 35,
  group: "Work",
  hint: "what you asked for, and where it is",
  when: (s) => hasAsks(s),
  component: lazy(() => import("../components/AsksPanel.tsx").then((m) => ({ default: m.AsksPanel }))),
});

registerCommand({
  id: "panel-asks", label: "Your asks: what you asked for here, working, in review, on main or running", group: "View", words: "asks requests todo done status landed running owner",
  when: () => { const r = getUI().route; return r.name === "session" && hasAsks(getState().sessions[r.id]); },
  run: () => savePref("panel", getUI().panel === "asks" ? null : "asks"),
});
