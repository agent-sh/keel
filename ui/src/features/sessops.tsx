// Session marks and conversation operations in the workbench: the Session
// side-panel tab and the slash commands for them. Imported from main.tsx.
import { Bookmark } from "lucide-react";
import { lazy } from "react";
import { panels, slash } from "../lib/extend.ts";
import { registerCommand } from "../lib/keys.ts";
import { pin, setDone, setTags } from "../lib/sessops.ts";
import { getUI, savePref } from "../lib/ui.ts";

panels.add({
  id: "session",
  label: "Session",
  icon: <Bookmark className="size-4" />,
  order: 44,
  component: lazy(() => import("../components/SessionPanel.tsx").then((m) => ({ default: m.SessionPanel }))),
});

registerCommand({
  id: "panel-session", label: "Session marks: pin, tags, done, step budget, messages", group: "View",
  words: "pin unpin tag tags done finished budget steps messages peer archive recap folder skill",
  when: () => getUI().route.name === "session",
  run: () => savePref("panel", getUI().panel === "session" ? null : "session"),
});

const need = <T,>(s: T | undefined): T => {
  if (!s) throw Object.assign(new Error("Open a session first."), { usage: true });
  return s;
};

slash.add(
  { id: "pin", label: "Pin this session: its station stays on the bridge", run: (_a, { session }) => pin(need(session).id, true) },
  { id: "unpin", label: "Unpin this session", run: (_a, { session }) => pin(need(session).id, false) },
  {
    id: "tag",
    label: "Tag this session; -name removes a tag",
    hint: "<name>[, -name]",
    run: async (arg, { session }) => {
      const s = need(session);
      const words = arg.split(",").map((w) => w.trim()).filter(Boolean);
      if (!words.length) return savePref("panel", "session");
      let tags = [...(s.settings.tags ?? [])];
      for (const w of words) {
        if (w.startsWith("-")) tags = tags.filter((t) => t.toLowerCase() !== w.slice(1).trim().toLowerCase());
        else tags.push(w);
      }
      await setTags(s.id, tags);
    },
  },
  { id: "done", label: "Mark the work finished (your next message reopens it)", run: (_a, { session }) => setDone(need(session).id, true).then(() => {}) },
);
