// The integrations lane's place in the workbench: a settings section, the
// /memory command, and how a memory note reads in the transcript.
import { Brain, Cable, Share, Webhook } from "lucide-react";
import { createElement, Fragment, lazy } from "react";
import { headerActions, settingsSections, slash } from "./extend.ts";
import { registerCommand } from "./keys.ts";
import { reportError } from "./store.ts";
import { getUI, navigate } from "./ui.ts";

settingsSections.add({
  id: "integrations",
  label: "Memory and supervisor",
  words: "tacit memory momentum supervisor socket hooks",
  icon: createElement(Brain, { className: "size-4" }),
  order: 40,
  component: lazy(() => import("../components/IntegrationsPanel.tsx").then((m) => ({ default: m.IntegrationsSettings }))),
});

settingsSections.add({
  id: "acp-agents",
  label: "ACP agents",
  words: "acp agent client protocol zed opencode codex gemini claude kimi registry external",
  icon: createElement(Cable, { className: "size-4" }),
  order: 45,
  component: lazy(() => import("../components/AcpAgentsPanel.tsx").then((m) => ({ default: m.AcpAgentsSettings }))),
});

settingsSections.add({
  id: "hooks",
  label: "Hooks",
  words: "hooks pretooluse posttooluse stop prompt hooks.json trust pin",
  icon: createElement(Webhook, { className: "size-4" }),
  order: 15,
  component: lazy(() => import("../components/surfaces/Hooks.tsx")),
});

registerCommand({ id: "integrations", label: "Memory and supervisor", group: "General", words: "tacit momentum", run: () => navigate({ name: "settings", section: "integrations" }) });

// The Memory panel (Settings > Usage, Memory), on what one session was given
// when a session is named. With that page already open nothing mounts again:
// it is told by an event (the name is UsagePanel's USAGE_LINK).
export function openMemory(session?: string) {
  history.pushState(null, "", `/settings/usage?view=memory${session ? `&session=${session}` : ""}`);
  navigate({ name: "settings", section: "usage" });
  dispatchEvent(new Event("keel-usage-link"));
}
registerCommand({
  id: "memory-panel", label: "Memory: what was given, search, correct", group: "View", words: "tacit facts given unused search correct wrong",
  run: () => { const r = getUI().route; openMemory(r.name === "session" ? r.id : undefined); },
});

slash.add({
  id: "memory",
  label: "Memory for this session",
  hint: "on | off | feed on | feed off; alone: what it was given",
  when: (c) => !!c.session,
  async run(arg, c) {
    const a = arg.trim().toLowerCase();
    if (!a && c.session) return openMemory(c.session.id);
    const body = a === "off" ? { use_memory: false } : a === "on" ? { use_memory: true } : a === "feed off" ? { feed_memory: false } : a === "feed on" ? { feed_memory: true } : null;
    if (!body || !c.session) return;
    const r = await fetch(`/api/sessions/${c.session.id}/memory`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) reportError(new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`));
  },
});

// Import and export of sessions. The sheets load on first use, in a root of
// their own beside the shell (the shell is not edited for them).
let host: Promise<{ setImportOpen(o: boolean): void; openExport(s: any): void }> | null = null;
function sheets() {
  return (host ??= Promise.all([import("../components/ImportSheet.tsx"), import("../components/ExportDialog.tsx"), import("react-dom/client")]).then(([imp, exp, dom]) => {
    const el = document.body.appendChild(document.createElement("div"));
    el.dataset.host = "import-export";
    dom.createRoot(el).render(createElement(Fragment, null, createElement(imp.ImportOverlay), createElement(exp.ExportOverlay)));
    return { setImportOpen: imp.setImportOpen, openExport: exp.openExport };
  }));
}
export const openImport = () => sheets().then((m) => m.setImportOpen(true)).catch(reportError);
const openExport = (s: any) => sheets().then((m) => m.openExport(s)).catch(reportError);

registerCommand({ id: "import-sessions", label: "Import sessions", group: "General", words: "claude code codex rust keel history import resume", run: openImport });
slash.add({ id: "import", label: "Import sessions from Claude Code, Codex or the Rust Keel", run: () => void openImport() });
slash.add({ id: "export", label: "Export this session or take it to another tool", when: ({ session }) => !!session, run: (_a, { session }) => void openExport(session) });
headerActions.add({ id: "export", label: "Export or take it elsewhere", icon: createElement(Share, { className: "size-4" }), run: (s) => void openExport(s) });
