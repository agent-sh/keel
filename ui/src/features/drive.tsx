// Sessions elsewhere: the owner's Claude Code, Codex and agy sessions in a
// side panel tab, a settings section naming the agent view, and a command.
// Imported once from main.tsx.
import { AppWindow } from "lucide-react";
import { lazy } from "react";
import { panels, settingsSections } from "../lib/extend.ts";
import { registerCommand } from "../lib/keys.ts";
import { getState } from "../lib/store.ts";
import { getUI, navigate, savePref } from "../lib/ui.ts";

panels.add({
  id: "elsewhere",
  label: "Elsewhere",
  icon: <AppWindow className="size-4" />,
  order: 40,
  component: lazy(() => import("../components/ElsewherePanel.tsx").then((m) => ({ default: m.ElsewherePanel }))),
});

settingsSections.add({
  id: "elsewhere",
  label: "Sessions elsewhere",
  words: "agent view claude code codex agy outside sessions drive terminal tmux",
  icon: <AppWindow className="size-4" />,
  order: 40,
  component: lazy(() => import("../components/ElsewherePanel.tsx").then((m) => ({ default: m.ElsewhereSettings }))),
});

const inSession = () => {
  const r = getUI().route;
  return r.name === "session" && !!getState().sessions[r.id];
};

registerCommand({
  id: "panel-elsewhere",
  label: "Sessions elsewhere: Claude Code, Codex and agy",
  group: "View",
  words: "outside other harness terminal drive message claude codex agy",
  when: inSession,
  run: () => savePref("panel", getUI().panel === "elsewhere" ? null : "elsewhere"),
}, {
  id: "settings-elsewhere",
  label: "Settings: the agent view for sessions elsewhere",
  group: "General",
  words: "agent view outside sessions",
  run: () => navigate({ name: "settings", section: "elsewhere" }),
});
