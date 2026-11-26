// The workbench's own commands and slash commands. Feature lanes register
// theirs the same way from their own modules; an id registered again wins.
import { copyOrSay } from "./copy.ts";
import { announce } from "./announce.ts";
import { tipSay } from "./tips.ts";
import { FolderTree } from "lucide-react";
import { createElement, lazy } from "react";
import { panels, slash } from "./extend.ts";
import { fuzzy, isMac, registerCommand } from "./keys.ts";
import { shell } from "./shell.ts";
import { DESK_QUERY } from "./phone.ts";
import { getSafetyModes, safety } from "./safety.ts";
import { archive } from "./sessops.ts";
import { actions, getState, reportError, ensureModels } from "./store.ts";
import { leafOf, lineage } from "../../../src/core/tree.ts";
import { getUI, navigate, notePick, savePref, setScale, setTheme, setUI, stepScale, type ThemePref } from "./ui.ts";
import { resolveModelArg } from "./picker.ts";
import { toggleList } from "./rail.ts";
import { fmtTokens, focusBox } from "./utils.ts";
import { confirmAction } from "../components/Confirm.tsx";
import { switchSession } from "./switch.ts";
import { open as openSwitcher } from "./switcher.ts";
import { stopHere } from "./automation.ts";
import { BACKGROUND_COMMAND_KEYS, commandInFront, moveToBackground } from "./background.ts";
import { leaveHome, leaveLook, lookNow, stopHeld, underHome } from "./looks.ts";

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
// A new session starts where the owner is working: in the folder of the session on
// screen. Not from a session on another machine (its folder is not one of this
// machine's) or one whose folder is gone; from the start page the folder chosen there stays.
export const newSession = () => {
  const s = current();
  newIn(s && !s.machine && !s.workspace_gone ? s.workspace : undefined);
};
// The last turn's reply on the branch on screen (a previewed one included),
// all of its text around its tool calls: what its footer's Copy gives.
const lastReply = (id: string): string | Promise<string> => {
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
    if (e.kind === "user" && e.data.origin !== "restart" && e.data.origin !== "harness") { if (text.length) return text.join("\n\n"); continue; }
    if (e.kind === "assistant" && e.data.stop !== "refusal") {
      const t = e.data.blocks.filter((b: any) => b.type === "text" && b.text.trim()).map((b: any) => b.text);
      text.unshift(...t);
    }
  }
  // No prompt before the reply in what the page holds: when the branch goes on
  // above it (a turn longer than a part), the daemon has the whole reply.
  if (line.length && line[0]!.parent !== null) return actions.reply(id, { last: true, head: head === s.head ? undefined : head ?? undefined });
  return text.join("\n\n");
};

// A session keeps the tools and system prompt it was last sent across a daemon
// upgrade (its cached context is not written again); this takes the running
// build's now, and says what happened.
const adoptBuild = async (id: string) => {
  const [was, ctx] = await Promise.all([actions.buildState(id), actions.context(id)]);
  const now = await actions.adoptBuild(id);
  const took = now.adoptions[0] && now.adoptions[0].ts !== was.adoptions[0]?.ts;
  const cost = `rewrites about ${fmtTokens(ctx.context_used_tokens)} tokens`;
  const said = now.asked ? `This build's tools and prompt are taken at the turn's next request, which ${cost}.` : took ? `The session now uses this build's tools and prompt: its next request ${cost}.` : "The session already uses this build's tools and prompt.";
  tipSay(null, said, 4200);
  announce(said);
};
// The same for every open session, after saying what it costs.
export const adoptAllBuilds = async () => {
  const p = await actions.buildPins();
  const say = (said: string) => { tipSay(null, said, 4200); announce(said); };
  if (!p.sessions.length && !p.unknown) return say(p.asked ? "The sessions behind already take this build's tools and prompt at their next request." : "Every open session already uses this build's tools and prompt.");
  const n = (k: number) => `${k} session${k === 1 ? "" : "s"}`;
  const body = [
    p.sessions.length ? `${n(p.sessions.length)} carr${p.sessions.length === 1 ? "ies" : "y"} an earlier build's tools or prompt. Taking this build's rewrites about ${fmtTokens(p.tokens)} tokens of cached context at their next requests.` : "",
    p.unknown ? `${n(p.unknown)} ${p.unknown === 1 ? "has" : "have"} not been compared with this build yet: what differs there is rewritten too.` : "",
  ].filter(Boolean).join("\n\n");
  if (!(await confirmAction({ title: "Use this build's tools and prompt in every session?", body, action: "Use this build's", careful: true }))) return;
  const { asked } = await actions.adoptAllBuilds();
  say(`${n(asked)} take${asked === 1 ? "s" : ""} this build's tools and prompt at the next request.`);
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
  { id: "palette", label: "Search sessions and commands", group: "General", keys: "mod+k", inInput: true, over: () => getUI().palette, run: () => setUI({ palette: !getUI().palette }) },
  { id: "shortcuts", label: "Keyboard shortcuts", group: "General", keys: "mod+/", inInput: true, over: () => getUI().shortcuts, run: () => setUI({ shortcuts: !getUI().shortcuts }) },
  // (In the desktop app the key every app has for it: a browser tab cannot take that one.)
  { id: "new-session", label: "New session", group: "Sessions", keys: shell ? "mod+n mod+shift+o" : "mod+shift+o", inInput: true, words: "start create", run: newSession },
  { id: "new-here", label: "New session in this folder", group: "Sessions", words: "clear fresh", when: () => !!current(), run: () => newIn(current()!.workspace) },
  { id: "next-session", label: "Next session", group: "Sessions", keys: "mod+shift+]", inInput: true, run: () => step(1) },
  { id: "prev-session", label: "Previous session", group: "Sessions", keys: "mod+shift+[", inInput: true, run: () => step(-1) },
  // The switcher of the last six sessions visited, with no key held (its keys are lib/switcher.ts's own).
  { id: "recent-sessions", label: "Recent sessions", group: "Sessions", words: "switch back previous visited last", run: () => openSwitcher(1) },
  // (On a Mac, Option with a letter types a character: in a field the Alt letter keys stay the field's.)
  // From anywhere to the list in one key: the row of the session on screen, else the first. Up and Down move, Enter opens.
  { id: "focus-list", label: "Focus the session list", group: "Sessions", keys: "alt+l", inInput: () => !isMac, words: "sidebar rows keyboard jump", run: () => (document.querySelector<HTMLElement>('[data-testid="session-list"] [data-testid="session-row"][aria-current="page"]') ?? document.querySelector<HTMLElement>('[data-testid="session-list"] [data-testid="session-row"]'))?.focus() },
  { id: "sidebar", label: "Show or fold the session list", group: "View", keys: "mod+b", inInput: true, words: "sidebar rail toggle", run: () => toggleList() },
  { id: "text-bigger", label: "Bigger text", group: "View", keys: "mod+= mod+shift+=", inInput: true, words: "zoom font size larger letters", run: () => stepScale(1) },
  { id: "text-smaller", label: "Smaller text", group: "View", keys: "mod+-", inInput: true, words: "zoom font size letters", run: () => stepScale(-1) },
  { id: "text-reset", label: "Default text size", group: "View", keys: "mod+0", inInput: true, words: "zoom font size reset letters", run: () => setScale(1) },
  { id: "model-menu", label: "Choose a model", group: "Session", keys: "alt+m", inInput: true, words: "switch model effort", run: () => setUI({ modelMenu: getUI().modelMenu + 1 }) },
  { id: "effort-menu", label: "Choose the effort", group: "Session", keys: "alt+e", inInput: true, when: () => !!current(), words: "reasoning effort thinking level", run: () => setUI({ effortMenu: getUI().effortMenu + 1 }) },
  // The page as a picker: the element clicked goes to the message box by name, source, tokens and picture (lib/point.ts).
  // It points at a menu or a dialog too, so the key works over one. Not on a phone: there is no pointer to point with.
  { id: "point", label: "Point at the page", group: "Session", keys: "alt+.", inInput: () => !isMac, over: () => true, when: () => matchMedia(DESK_QUERY).matches, words: "pick element inspect this screenshot feedback ui", run: () => setUI({ pointAsk: getUI().pointAsk + 1 }) },
  { id: "copy-reply", label: "Copy the last reply", group: "Session", keys: "mod+shift+c", inInput: true, when: () => !!current(), run: () => void copyOrSay(() => lastReply(current()!.id)) },
  // A panel lying over the conversation takes Escape first: it closes, and the
  // turn working behind it is not stopped by the same press.
  { id: "panel-leave", label: "Close the panel over the conversation", group: "View", keys: "escape", where: "while one is open", when: () => !!document.querySelector('.k-side[data-mode="sheet"]'), run: () => savePref("panel", null) },
  // In an agent's session Escape goes back to the session that started it, as
  // leaving a view does; stopping the agent is its own labeled button.
  // What lies over a pane's session is left first (lib/looks.ts): a look, or the start page. The pane
  // shows the session it holds again. In a look Escape never stops a turn, and on a card of the look
  // it is the card's own key (the look's bar does not offer it there). The press after that, in the
  // pane that was uncovered, does not stop that pane's turn either: it says how to (stopHeld).
  { id: "look-back", label: "Back to the session the pane holds", group: "Bridge", keys: "escape", where: "from a look or the start page", words: "leave look return", when: () => !!lookNow() && !document.activeElement?.closest("[data-ask-card]"), run: () => { const l = lookNow(); if (l) leaveLook(l.id); } },
  // From a card of the look (where Escape is the card's own key: an approval's denial) Shift Escape
  // leads back, in one press. The look's bar names that key while the keyboard is on a card.
  { id: "look-back-card", label: "Leave the look", group: "Bridge", keys: "shift+escape", where: "from one of its cards", inInput: true, words: "leave look return card", when: () => !!lookNow() && !!(document.activeElement?.closest("[data-ask-card]") || document.activeElement?.closest("[data-ask-part]")), run: () => { const l = lookNow(); if (l) leaveLook(l.id); } },
  { id: "home-back", label: "Back to the session the pane holds", group: "Bridge", keys: "escape", where: "from a look or the start page", when: () => !!underHome(), run: () => void leaveHome() },
  { id: "stop", label: "Stop the turn", group: "Session", keys: "escape", where: "while a turn works or a compaction is written", when: () => (current()?.phase === "working" || getState().status[current()?.id ?? ""]?.kind === "compacting") && !current()?.parent_id && !lookNow(), run: () => { if (!stopHeld(current()!.id)) void stopHere(current()!); } },
  { id: "command-background", label: "Move the running command to the background", group: "Session", keys: BACKGROUND_COMMAND_KEYS, inInput: true, where: "while a command runs in front of a call", words: "shell bash terminal detach job wait", when: () => !!current() && commandInFront(), run: () => void moveToBackground(current()!.id) },
  { id: "to-parent", label: "Back to the session that started this agent", group: "Session", keys: "escape", where: "in an agent's session", when: () => !!current()?.parent_id && !lookNow(), run: () => navigate({ name: "session", id: current()!.parent_id! }) },
  { id: "stop-agent", label: "Stop this agent", group: "Session", when: () => current()?.phase === "working" && !!current()?.parent_id, run: () => void stopHere(current()!) },
  { id: "archive", label: "Archive this session", group: "Session", when: () => !!current(), run: () => { archive(current()!).catch(reportError); navigate({ name: "new" }); } },
  { id: "copy-link", label: "Copy a link to this session", group: "Session", when: () => !!current(), run: () => void copyOrSay(location.href) },
  { id: "end", label: "Go to the end and follow", group: "Conversation", keys: "end mod+end", when: () => !!current(), run: () => dispatchEvent(new CustomEvent("keel:end", { detail: current()!.id })) }, // the pane worked in, not every transcript on screen
  // The transcript of the pane with the keys moves to the prompt before or after the one it is on.
  // On a Mac, Option Up and Down move the caret by paragraph: in a field they stay the field's.
  { id: "prev-prompt", label: "Previous prompt", group: "Conversation", keys: "alt+arrowup", inInput: () => !isMac, words: "message question earlier jump back", when: () => !!current(), run: () => dispatchEvent(new CustomEvent("keel:prompt", { detail: { session: current()!.id, dir: -1 } })) },
  { id: "next-prompt", label: "Next prompt", group: "Conversation", keys: "alt+arrowdown", inInput: () => !isMac, words: "message question later jump forward", when: () => !!current(), run: () => dispatchEvent(new CustomEvent("keel:prompt", { detail: { session: current()!.id, dir: 1 } })) },
  // Back to typing from anywhere in the pane worked in (Escape does it from a prompt reached by the two above).
  { id: "focus-box", label: "Focus the message box", group: "Conversation", keys: "shift+escape", where: "from the conversation", inInput: true, words: "composer input type reply write", when: () => !!current(), run: () => focusBox(current()!.id) },
  { id: "settings", label: "Settings", group: "General", keys: "mod+,", inInput: true, words: "preferences options", run: () => navigate({ name: "settings", section: "general" }) },
  { id: "errors", label: "Show recorded errors", group: "General", keys: "alt+r", inInput: () => !isMac, over: () => getUI().errors, words: "failures bugs log", run: () => setUI({ errors: !getUI().errors }) },
  { id: "theme-light", label: "Theme: light", group: "View", words: "appearance", run: () => setTheme("light") },
  { id: "theme-dark", label: "Theme: dark", group: "View", words: "appearance", run: () => setTheme("dark") },
  { id: "theme-system", label: "Theme: follow the system", group: "View", words: "appearance auto", run: () => setTheme("system") },
  { id: "refresh-models", label: "Refresh the model listings", group: "General", words: "providers reload", run: () => actions.loadModels(true).catch(reportError) },
  { id: "adopt-build", label: "Use this build's tools and prompt in this session now (rewrites its cached context)", group: "Sessions", words: "upgrade pinned cache adopt update", when: () => !!current(), run: () => adoptBuild(current()!.id).catch(reportError) },
  { id: "adopt-build-all", label: "Use this build's tools and prompt in every session (says the cost first)", group: "Sessions", words: "upgrade pinned cache adopt update all", run: () => adoptAllBuilds().catch(reportError) },
);

slash.add(
  {
    id: "model",
    label: "Switch the model",
    hint: "[name]",
    run: async (arg, { session }) => {
      if (!arg) return setUI({ modelMenu: getUI().modelMenu + 1 });
      // A name is looked for in the whole listing.
      await ensureModels();
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
  { id: "new", label: "New session", run: newSession },
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
  { id: "adopt-build", label: "Use this build's tools and prompt now (rewrites the cached context)", hint: "[all]", when: ({ session }) => !!session, run: (arg, { session }) => (arg.trim() === "all" ? adoptAllBuilds() : adoptBuild(session!.id)) },
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
