import { BellRing, Bot, ListChecks } from "lucide-react";
import { lazy } from "react";
import { auto, setAdvisorSession } from "../../lib/automation.ts";
import { panels, settingsSections, slash } from "../../lib/extend.ts";
import { isMac, registerCommand } from "../../lib/keys.ts";
import { actions, getState, ensureModels } from "../../lib/store.ts";
import { getUI, navigate, savePref } from "../../lib/ui.ts";

// The inbox opens from the keys and the palette too (the list's footer holds it: SidebarExtras.tsx).
registerCommand({
  id: "inbox", label: "Open the inbox", group: "General", keys: "alt+b", inInput: () => !isMac, over: () => !!document.querySelector('[data-testid="inbox-list"]'),
  words: "alerts notifications unread bell finished failed", run: () => void dispatchEvent(new Event("keel:inbox")),
});

// The automation lane's entries in the workbench: /loop and Settings > Alerts.
slash.add({
  id: "loop",
  label: "Run a prompt again on an interval, or let the model pace it",
  hint: "[5m] [prompt]",
  run: async (arg, { session }) => {
    let id = session?.id;
    if (!id) {
      const ui = getUI();
      const s = await actions.create("", ui.newModel || getState().defaultModel || undefined, ui.newWorkspace || undefined);
      id = s.id;
      navigate({ name: "session", id });
    }
    const r = await auto.command(id, `/loop ${arg}`.trim());
    if (!r.handled) throw new Error("The loop was not created.");
  },
});

settingsSections.add({
  id: "alerts",
  label: "Alerts",
  words: "notifications desktop command notify inbox routes push snooze",
  icon: <BellRing className="size-4" />,
  order: 40,
  component: lazy(() => import("./AlertSettings.tsx")),
});

// /advisor [model | off | default]: the advisor of this session. A name matches
// a listed model by id or name; without one it opens Settings > Agents.
slash.add({
  id: "advisor",
  label: "Choose the model this session may consult for advice",
  hint: "[model | off | default]",
  run: async (arg, { session }) => {
    const a = arg.trim();
    // Bare: the page opens on this session's own choice (this session, the default, off).
    if (!a || !session) { setAdvisorSession(session ? { id: session.id, title: session.title || "this session" } : null); return navigate({ name: "settings", section: "agents" }); }
    if (a === "off" || a === "default") return void (await auto.setSessionAdvisor(session.id, a === "off" ? "off" : null));
    const w = a.toLowerCase();
    await ensureModels();
    const ms = getState().models.filter((m) => !m.hidden);
    const hit = ms.find((m) => m.id === a) ?? ms.find((m) => m.id.toLowerCase().includes(w) || m.name.toLowerCase().includes(w));
    if (!hit) throw new Error(`No listed model matches "${a}".`);
    await auto.setSessionAdvisor(session.id, hit.id);
  },
});

settingsSections.add({
  id: "agents",
  label: "Agents",
  words: "advisor consult second opinion subagents model",
  icon: <Bot className="size-4" />,
  order: 13,
  component: lazy(() => import("../surfaces/Agents.tsx")),
});

// The session's goal and the task list the model and the owner share.
panels.add({
  id: "tasks",
  label: "Tasks",
  icon: <ListChecks className="size-4" />,
  order: 15,
  when: (s) => !s.parent_id,
  component: lazy(() => import("./TasksPanel.tsx").then((m) => ({ default: m.TasksPanel }))),
});

// /goal <objective> sets the session's goal (it starts a turn); /goal pause,
// resume or clear; /goal alone opens the panel.
slash.add({
  id: "goal",
  label: "Keep working until a condition holds, checked after each turn",
  hint: "[objective | pause | resume | clear]",
  run: async (arg, { session }) => {
    const a = arg.trim();
    if (!session) throw new Error("Open a session first.");
    savePref("panel", "tasks");
    if (!a) return;
    if (a === "pause" || a === "resume") return void (await auto.patchGoal(session.id, { status: a === "pause" ? "paused" : "pursuing" }));
    if (["clear", "stop", "off", "cancel"].includes(a)) return void (await auto.clearGoal(session.id));
    await auto.setGoal(session.id, { objective: a, replace: true });
  },
});
