// Session marks and conversation operations in the workbench: the Session
// side-panel tab and the slash commands for them. Imported from main.tsx.
import { Bookmark, FoldVertical, ListCollapse } from "lucide-react";
import { createElement, lazy } from "react";
import { panels, rowActions, slash } from "../lib/extend.ts";
import { registerCommand } from "../lib/keys.ts";
import { moveSession, pin, setDone, setSkillMode, setTags, writeRecap } from "../lib/sessops.ts";
import { api } from "../lib/store.ts";
import { getUI, savePref } from "../lib/ui.ts";

panels.add({
  id: "session",
  label: "Session settings",
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
  { id: "pin", label: "Pin this session: its pane stays on the bridge", run: (_a, { session }) => pin(need(session).id, true) },
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

slash.add(
  {
    id: "recap",
    label: "Write a recap of where this session stands",
    run: async (_a, { session }) => {
      const s = need(session);
      savePref("panel", "session");
      await writeRecap(s.id);
    },
  },
  {
    id: "skill-mode",
    label: "Keep a skill on for every turn of this session (off turns it off)",
    hint: "<skill> | off",
    run: async (arg, { session }) => {
      const s = need(session);
      const a = arg.trim().replace(/^\//, "");
      if (!a) return savePref("panel", "session");
      if (a === "off") return void (await setSkillMode(s.id, null));
      const { skills } = await api<{ skills: { name: string }[] }>(`/api/sessions/${s.id}/skill-mode`);
      const hit = skills.find((k) => k.name === a) ?? skills.find((k) => k.name.includes(a));
      if (!hit) throw Object.assign(new Error(`No skill you can invoke matches "${a}".`), { usage: true });
      await setSkillMode(s.id, hit.name);
    },
  },
);

// Summarize a part of the conversation, from a prompt's row.
const summarize = (direction: "from" | "up_to") => (e: { id: string }, s: { id: string }) =>
  void import("../components/SummarizeDialog.tsx").then((m) => m.summarize({ sessionId: s.id, eventId: e.id, direction }));
rowActions.add(
  { id: "summarize-from", label: "Summarize from here", icon: createElement(FoldVertical, { className: "size-3.5" }), on: "user", idle: true, run: summarize("from") },
  { id: "summarize-up-to", label: "Summarize up to here", icon: createElement(ListCollapse, { className: "size-3.5" }), on: "user", idle: true, when: (e) => e.parent !== null, run: summarize("up_to") },
);

slash.add({
  id: "folder",
  label: "Move this session to another folder; the conversation goes on there",
  hint: "<path>",
  run: async (arg, { session }) => {
    const s = need(session);
    if (!arg.trim()) return savePref("panel", "session");
    await moveSession(s.id, { cwd: arg.trim() });
  },
});
