// The integrations lane's place in the workbench: a settings section, the
// /memory command, and how a memory note reads in the transcript.
import { Brain, Share, Webhook } from "lucide-react";
import { createElement, Fragment, lazy } from "react";
import { headerActions, settingsSections, slash } from "./extend.ts";
import { registerCommand } from "./keys.ts";
import { reportError } from "./store.ts";
import { navigate } from "./ui.ts";

settingsSections.add({
  id: "integrations",
  label: "Memory and supervisor",
  words: "tacit memory momentum supervisor socket hooks",
  icon: createElement(Brain, { className: "size-4" }),
  order: 40,
  component: lazy(() => import("../components/IntegrationsPanel.tsx").then((m) => ({ default: m.IntegrationsSettings }))),
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

slash.add({
  id: "memory",
  label: "Memory for this session",
  hint: "on | off | feed on | feed off",
  when: (c) => !!c.session,
  async run(arg, c) {
    const a = arg.trim().toLowerCase();
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
slash.add({ id: "export", label: "Export this session or continue it in another tool", when: ({ session }) => !!session, run: (_a, { session }) => void openExport(session) });
headerActions.add({ id: "export", label: "Export or continue elsewhere", icon: createElement(Share, { className: "size-4" }), run: (s) => void openExport(s) });
