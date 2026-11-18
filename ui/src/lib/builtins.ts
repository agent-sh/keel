// The workbench's own commands and slash commands. Feature lanes register
// theirs the same way from their own modules; an id registered again wins.
import { FolderTree } from "lucide-react";
import { createElement, lazy } from "react";
import { panels, slash } from "./extend.ts";
import { fuzzy, registerCommand } from "./keys.ts";
import { actions, getState, reportError } from "./store.ts";
import { getUI, navigate, savePref, setTheme, setUI, type ThemePref } from "./ui.ts";

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
const lastReply = (id: string) => {
  const ev = [...(getState().events[id] ?? [])].reverse().find((e) => e.kind === "assistant" && e.data.blocks.some((b: any) => b.type === "text" && b.text.trim()));
  return ev?.data.blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n\n") ?? "";
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
  { id: "sidebar", label: "Toggle the sidebar", group: "View", keys: "mod+b", inInput: true, run: () => savePref("sidebar", !getUI().sidebar) },
  { id: "model-menu", label: "Choose a model", group: "Session", keys: "alt+m", inInput: true, words: "switch model", run: () => setUI({ modelMenu: getUI().modelMenu + 1 }) },
  { id: "copy-reply", label: "Copy the last reply", group: "Session", keys: "mod+shift+c", inInput: true, when: () => !!current(), run: () => navigator.clipboard.writeText(lastReply(current()!.id)) },
  { id: "stop", label: "Stop the turn", group: "Session", keys: "escape", when: () => current()?.phase === "working", run: () => actions.interrupt(current()!.id).catch(reportError) },
  { id: "archive", label: "Archive this session", group: "Session", when: () => !!current(), run: () => { actions.patch(current()!.id, { archived: true }).catch(reportError); navigate({ name: "new" }); } },
  { id: "copy-link", label: "Copy a link to this session", group: "Session", when: () => !!current(), run: () => navigator.clipboard.writeText(location.href) },
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
      const best = getState().models.map((m) => ({ m, s: fuzzy(arg, `${m.name} ${m.id}`) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s)[0];
      if (!best) throw new Error(`No listed model matches "${arg}".`);
      if (session) return actions.patch(session.id, { model: best.m.id }).then(() => {});
      setUI({ newModel: best.m.id });
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
  // Named here so the menu shows them; the lanes that build them register a `run`.
  { id: "compact", label: "Summarize the history to free context" },
  { id: "review", label: "Review the changes in this folder" },
  { id: "init", label: "Write an AGENTS.md for this folder" },
  { id: "permissions", label: "Change what runs without asking" },
  { id: "mcp", label: "Manage tool servers" },
  { id: "agents", label: "Show running agents" },
  { id: "export", label: "Export this session" },
);
