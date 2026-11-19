// The terminal pane: a side panel of every command the session ran, and a
// palette command with Claude Code's key for it. Imported once from main.tsx.
import { SquareTerminal } from "lucide-react";
import { lazy } from "react";
import { panels } from "../lib/extend.ts";
import { registerCommand } from "../lib/keys.ts";
import { getUI, savePref } from "../lib/ui.ts";

panels.add({
  id: "terminal",
  label: "Terminal",
  icon: <SquareTerminal className="size-4" />,
  order: 25,
  component: lazy(() => import("../components/TerminalPanel.tsx").then((m) => ({ default: m.TerminalPanel }))),
});

registerCommand({
  id: "panel-terminal", label: "Terminal panel", group: "View", keys: "ctrl+`", inInput: true, words: "commands shell output jobs background",
  when: () => getUI().route.name === "session",
  run: () => savePref("panel", getUI().panel === "terminal" ? null : "terminal"),
});
