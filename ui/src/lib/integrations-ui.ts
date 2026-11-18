// The integrations lane's place in the workbench: a settings section, the
// /memory command, and how a memory note reads in the transcript.
import { Brain } from "lucide-react";
import { createElement, lazy } from "react";
import { settingsSections, slash } from "./extend.ts";
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
