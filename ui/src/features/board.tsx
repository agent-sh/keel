// The work board panel (src/board/board.ts): the agents of the session's tree, each with its branch,
// checks, review, landed and live, kept from what Keel observes. Imported once from main.tsx.
import { LayoutList } from "lucide-react";
import { lazy } from "react";
import { panels } from "../lib/extend.ts";
import { registerCommand } from "../lib/keys.ts";
import { getState } from "../lib/store.ts";
import { getUI, savePref } from "../lib/ui.ts";

panels.add({
  id: "board",
  label: "Work board",
  icon: <LayoutList className="size-4" />,
  order: 36,
  group: "Work",
  hint: "its agents: branch, checks, review, landed",
  component: lazy(() => import("../components/WorkBoard.tsx").then((m) => ({ default: m.WorkBoard }))),
});

const inSession = () => {
  const r = getUI().route;
  return r.name === "session" && !!getState().sessions[r.id];
};
registerCommand({
  id: "panel-board", label: "Work board: each agent's branch, checks, review and landing", group: "View", words: "lanes agents coordinator status landed deployed review verdict", when: inSession,
  run: () => savePref("panel", getUI().panel === "board" ? null : "board"),
});
