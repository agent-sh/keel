import { BellRing, Bot, ListChecks } from "lucide-react";
import { lazy } from "react";
import { seeAllAgents } from "../../lib/agent-seen.ts";
import { auto, setAdvisorSession } from "../../lib/automation.ts";
import { panels, settingsSections, slash } from "../../lib/extend.ts";
import { showInboxView } from "../../lib/inbox-view.ts";
import { isMac, registerCommand } from "../../lib/keys.ts";
import { actions, getState, ensureModels, reportError } from "../../lib/store.ts";
import { getUI, navigate, savePref } from "../../lib/ui.ts";

// The inbox opens from the keys and the palette too (the list's footer holds it: SidebarExtras.tsx).
registerCommand({
  id: "inbox", label: "Open the inbox", group: "General", keys: "alt+b", inInput: () => !isMac, over: () => !!document.querySelector('[data-testid="inbox-list"]'),
  words: "alerts notifications unread bell finished failed", run: () => void dispatchEvent(new Event("keel:inbox")),
});

// Unread is the owner's to set and to clear: a session marked unread keeps its mark until it is
// opened again, and one command clears every unread mark (alerts, rows, agents that ended).
const onScreen = () => { const r = getUI().route; const s = r.name === "session" ? getState().sessions[r.id] : undefined; return s && !s.parent_id && !s.machine ? s : undefined; };
registerCommand(
  { id: "mark-unread", label: "Mark this session unread", group: "Session", words: "come back later keep flag dot", when: () => !!onScreen(), run: () => void auto.unreadSession(onScreen()!.id).catch(reportError) },
  { id: "clear-unread", label: "Clear all unread", group: "General", words: "mark all read seen indicators dots bell inbox", run: () => { seeAllAgents(); auto.read().catch(reportError); } },
);
// What happened, across sessions: the Inbox's Activity view, from the palette (it had no command of its own).
registerCommand({
  id: "activity", label: "Show activity: what happened in every session", group: "General",
  words: "activity history happened past log turns agents restarts timeline everything", run: () => showInboxView({ tab: "activity" }),
});
registerCommand({
  id: "activity-failures", label: "Show what went wrong: failures in every session", group: "General",
  words: "activity failures failed errors wrong declined refused problems", run: () => showInboxView({ tab: "activity", activity: { failures: true } }),
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
// resume or clear; /goal alone opens the panel. Typed in the start box, an
// objective starts a session as a first message does and is its goal there.
slash.add({
  id: "goal",
  label: "Keep working until a condition holds, checked after each turn",
  hint: "[objective | pause | resume | clear]",
  run: async (arg, ctx) => {
    const a = arg.trim();
    let session = ctx.session;
    if (!session) {
      const usage = (m: string) => Object.assign(new Error(m), { usage: true });
      if (!a || ["pause", "resume", "clear", "stop", "off", "cancel"].includes(a)) throw usage("Type the goal after /goal to start a session that works toward it.");
      if (!ctx.start) throw usage("A goal is set in its session: start the session on that machine, then type /goal there.");
      session = await ctx.start();
    }
    savePref("panel", "tasks");
    if (!a) return;
    if (a === "pause" || a === "resume") return void (await auto.patchGoal(session.id, { status: a === "pause" ? "paused" : "pursuing" }));
    if (["clear", "stop", "off", "cancel"].includes(a)) return void (await auto.clearGoal(session.id));
    await auto.setGoal(session.id, { objective: a, replace: true });
  },
});
