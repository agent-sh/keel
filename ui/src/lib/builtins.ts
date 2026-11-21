// The workbench's own commands and slash commands. Feature lanes register
// theirs the same way from their own modules; an id registered again wins.
import { copyOrSay } from "./copy.ts";
import { FolderTree } from "lucide-react";
import { createElement, lazy } from "react";
import { panels, slash } from "./extend.ts";
import { fuzzy, registerCommand } from "./keys.ts";
import { getSafetyModes, safety } from "./safety.ts";
import { actions, getState, reportError } from "./store.ts";
import { leafOf, lineage } from "../../../src/core/tree.ts";
import { getUI, navigate, notePick, savePref, setScale, setTheme, setUI, stepScale, type ThemePref } from "./ui.ts";
import { resolveModelArg } from "./picker.ts";
import { toggleList } from "./rail.ts";
import { switchSession } from "./switch.ts";
import { stopHere } from "./automation.ts";

const current = () => {
  const r = getUI().route;
  return r.name === "session" ? getState().sessions[r.id] : undefined;
};
const visible = () => Object.values(getState().sessions).filter((s) => !s.archived).sort((a, b) => b.updated - a.updated);
function step(dir: 1 | -1) {
  const list = visible();
  const cur = current();
  if (!list.length) return;
  const i = cur ? list.findIndex((s) => s.id === cur.id) : -1;
  navigate({ name: "session", id: list[(i + dir + list.length) % list.length]!.id });
}
const newIn = (ws?: string) => {
  if (ws) savePref("newWorkspace", ws);
  navigate({ name: "new" });
};
// The last turn's reply on the branch on screen (a previewed one included),
// all of its text around its tool calls: what its footer's Copy gives.
const lastReply = (id: string) => {
  const all = getState().events[id] ?? [];
  const s = getState().sessions[id];
  if (!s) return "";
  const p = getUI().preview;
  const head = p?.session === id && all.some((e) => e.id === p.event) && !lineage(all, s.head).some((e) => e.id === p.event) ? leafOf(all, p.event) : s.head;
  const line = lineage(all, head);
  const text: string[] = [];
  for (let i = line.length - 1; i >= 0; i--) {
    const e = line[i]!;
    // A turn starts at a prompt (a restart or harness note inside it does not), as the footer counts it.
    if (e.kind === "user" && e.data.origin !== "restart" && e.data.origin !== "harness") { if (text.length) break; continue; }
    if (e.kind === "assistant" && e.data.stop !== "refusal") {
      const t = e.data.blocks.filter((b: any) => b.type === "text" && b.text.trim()).map((b: any) => b.text);
      text.unshift(...t);
    }
  }
  return text.join("\n\n");
};

panels.add({
  id: "files",
  label: "Files",
  icon: createElement(FolderTree, { className: "size-4" }),
  order: 10,
  component: lazy(() => import("../components/FilesPanel.tsx").then((m) => ({ default: m.FilesPanel }))),
});
const togglePanel = (id: string) => savePref("panel", getUI().panel === id ? null : id);

registerCommand(
  { id: "panel-files", label: "Files panel", group: "View", keys: "mod+shift+e", inInput: true, words: "browse tree read", when: () => !!current(), run: () => togglePanel("files") },
  { id: "panel-close", label: "Close the side panel", group: "View", keys: "mod+\\", inInput: true, when: () => !!getUI().panel, run: () => savePref("panel", null) },
  { id: "palette", label: "Search sessions and commands", group: "General", keys: "mod+k", inInput: true, run: () => setUI({ palette: !getUI().palette }) },
  { id: "shortcuts", label: "Keyboard shortcuts", group: "General", keys: "mod+/", inInput: true, run: () => setUI({ shortcuts: !getUI().shortcuts }) },
  { id: "new-session", label: "New session", group: "Sessions", keys: "mod+shift+o", inInput: true, words: "start create", run: () => newIn() },
  { id: "new-here", label: "New session in this folder", group: "Sessions", words: "clear fresh", when: () => !!current(), run: () => newIn(current()!.workspace) },
  { id: "next-session", label: "Next session", group: "Sessions", keys: "mod+shift+]", inInput: true, run: () => step(1) },
  { id: "prev-session", label: "Previous session", group: "Sessions", keys: "mod+shift+[", inInput: true, run: () => step(-1) },
  { id: "sidebar", label: "Show or fold the session list", group: "View", keys: "mod+b", inInput: true, words: "sidebar rail toggle", run: () => toggleList() },
  { id: "text-bigger", label: "Bigger text", group: "View", keys: "mod+= mod+shift+=", inInput: true, words: "zoom font size larger letters", run: () => stepScale(1) },
  { id: "text-smaller", label: "Smaller text", group: "View", keys: "mod+-", inInput: true, words: "zoom font size letters", run: () => stepScale(-1) },
  { id: "text-reset", label: "Default text size", group: "View", keys: "mod+0", inInput: true, words: "zoom font size reset letters", run: () => setScale(1) },
  { id: "model-menu", label: "Choose a model", group: "Session", keys: "alt+m", inInput: true, words: "switch model", run: () => setUI({ modelMenu: getUI().modelMenu + 1 }) },
  { id: "copy-reply", label: "Copy the last reply", group: "Session", keys: "mod+shift+c", inInput: true, when: () => !!current(), run: () => void copyOrSay(lastReply(current()!.id)) },
  // A panel lying over the conversation takes Escape first: it closes, and the
  // turn working behind it is not stopped by the same press.
  { id: "panel-leave", label: "Close the panel over the conversation", group: "View", keys: "escape", when: () => !!document.querySelector('.k-side[data-mode="sheet"]'), run: () => savePref("panel", null) },
  // In an agent's session Escape goes back to the session that started it, as
  // leaving a view does; stopping the agent is its own labeled button.
  { id: "stop", label: "Stop the turn", group: "Session", keys: "escape", when: () => current()?.phase === "working" && !current()?.parent_id, run: () => void stopHere(current()!) },
  { id: "to-parent", label: "Back to the session that started this agent", group: "Session", keys: "escape", when: () => !!current()?.parent_id, run: () => navigate({ name: "session", id: current()!.parent_id! }) },
  { id: "stop-agent", label: "Stop this agent", group: "Session", when: () => current()?.phase === "working" && !!current()?.parent_id, run: () => void stopHere(current()!) },
  { id: "archive", label: "Archive this session", group: "Session", when: () => !!current(), run: () => { actions.patch(current()!.id, { archived: true }).catch(reportError); navigate({ name: "new" }); } },
  { id: "copy-link", label: "Copy a link to this session", group: "Session", when: () => !!current(), run: () => void copyOrSay(location.href) },
  { id: "end", label: "Go to the end and follow", group: "Session", keys: "end mod+end", when: () => !!current(), run: () => dispatchEvent(new Event("keel:end")) },
  { id: "settings", label: "Settings", group: "General", keys: "mod+,", inInput: true, words: "preferences options", run: () => navigate({ name: "settings", section: "general" }) },
  { id: "errors", label: "Show recorded errors", group: "General", words: "failures bugs log", run: () => setUI({ errors: true }) },
  { id: "theme-light", label: "Theme: light", group: "View", words: "appearance", run: () => setTheme("light") },
  { id: "theme-dark", label: "Theme: dark", group: "View", words: "appearance", run: () => setTheme("dark") },
  { id: "theme-system", label: "Theme: follow the system", group: "View", words: "appearance auto", run: () => setTheme("system") },
  { id: "refresh-models", label: "Refresh the model listings", group: "General", words: "providers reload", run: () => actions.loadModels(true).catch(reportError) },
);

slash.add(
  {
    id: "model",
    label: "Switch the model",
    hint: "[name]",
    run: (arg, { session }) => {
      if (!arg) return setUI({ modelMenu: getUI().modelMenu + 1 });
      // An exact route id picks that route; a name two routes share is asked
      // about, never settled by the listing's order. The switch goes through
      // the same cache warning as the picker.
      const r = resolveModelArg(arg, getState().models, fuzzy);
      if ("none" in r) throw usage(`No listed model matches "${arg}".`);
      if ("tie" in r) throw usage(`"${arg}" matches ${r.tie.join(", ")}. Give the full id.`);
      notePick(r.id);
      if (session) return switchSession(session.id, { model: r.id }).then(() => {});
      setUI({ newModel: r.id });
    },
  },
  { id: "clear", label: "Start fresh in this folder", run: (_a, { session }) => newIn(session?.workspace) },
  { id: "new", label: "New session", run: () => newIn() },
  { id: "rename", label: "Rename this session", hint: "<title>", when: ({ session }) => !!session, run: (arg, { session }) => { if (session && arg) return actions.patch(session.id, { title: arg }).then(() => {}); } },
  { id: "archive", label: "Archive this session", when: ({ session }) => !!session, run: (_a, { session }) => { actions.patch(session!.id, { archived: true }).catch(reportError); navigate({ name: "new" }); } },
  { id: "stop", label: "Stop the turn", when: ({ session }) => session?.phase === "working", run: (_a, { session }) => actions.interrupt(session!.id).then(() => {}) },
  { id: "theme", label: "Change the theme", hint: "light | dark | system", run: (arg) => setTheme((["light", "dark", "system"].includes(arg) ? arg : getUI().theme === "dark" ? "light" : "dark") as ThemePref) },
  { id: "settings", label: "Open settings", run: () => navigate({ name: "settings", section: "general" }) },
  { id: "shortcuts", label: "Keyboard shortcuts", run: () => setUI({ shortcuts: true }) },
  { id: "errors", label: "Show recorded errors", run: () => setUI({ errors: true }) },
  // Prompts the model runs in this session (the folder's own instructions).
  {
    id: "review",
    label: "Review the changes in this folder and report what is wrong",
    hint: "[base branch or what to look at]",
    when: ({ session }) => !!session,
    sends: true,
    run: (arg, { session }) => actions.send(session!.id, reviewPrompt(arg)).then(() => {}),
  },
  {
    id: "init",
    label: "Write an AGENTS.md for this folder",
    when: ({ session }) => !!session,
    sends: true,
    run: (_a, { session }) => actions.send(session!.id, INIT_PROMPT).then(() => {}),
  },
  {
    id: "permissions",
    label: "Change what runs without asking",
    hint: "[ask | auto-edits | auto | full-auto | read-only | plan | reviewer]",
    when: ({ session }) => !!session,
    run: async (arg, { session }) => {
      if (!arg) return setUI({ permMenu: getUI().permMenu + 1 });
      if (!getSafetyModes().length) await safety.loadSettings();
      const want = arg.toLowerCase().replace(/\s+/g, "-");
      const mode = getSafetyModes().find((m) => m.id === want || m.name.toLowerCase().replace(/\s+/g, "-") === want);
      if (!mode) throw usage(`No mode "${arg}". Modes: ${getSafetyModes().map((m) => m.id).join(", ")}.`);
      await safety.setPerm(session!.id, { mode: mode.id });
    },
  },
  { id: "agents", label: "Show every session and its agents, by folder", run: () => toggleList(true) },
);
// A placeholder never replaces a command a lane registered (import order varies).
for (const p of [
  { id: "compact", label: "Summarize the history to free context" },
  { id: "mcp", label: "Manage tool servers" },
  { id: "export", label: "Export this session" },
]) if (!slash.all().some((i) => i.id === p.id)) slash.add(p);

// What /review asks: Codex's working-tree review, as a prompt in the session.
export function reviewPrompt(arg: string) {
  const target = /^[\w./-]+$/.test(arg) && !arg.includes(" ")
    ? `the changes on this branch against ${arg} (git diff ${arg}...HEAD, plus uncommitted and untracked files)`
    : "the uncommitted changes in this folder (git diff HEAD and the untracked files)";
  const focus = arg && !/^[\w./-]+$/.test(arg) ? `\nLook in particular at: ${arg}` : "";
  return `Review ${target}. Do not edit anything. Report what is wrong: bugs, missed cases, broken contracts, risky changes and missing tests, most serious first, each with the file and line and why it matters. Say plainly when you find nothing worth changing.${focus}`;
}

export const INIT_PROMPT =
  "Write an AGENTS.md at the root of this folder for agents that will work here. Read the project first (README, build and test files, the layout, recent git history). Cover: what the project is, how to build, test and run it, the layout of the code, and the conventions a change must follow. Keep it short and specific to this project; no generic advice. If an AGENTS.md exists, improve it instead of starting over.";

// An error in what was typed after a command: shown, not recorded as a failure.
function usage(message: string) { return Object.assign(new Error(message), { usage: true }); }
