import { BellRing } from "lucide-react";
import { lazy } from "react";
import { auto } from "../../lib/automation.ts";
import { settingsSections, slash } from "../../lib/extend.ts";
import { actions, getState } from "../../lib/store.ts";
import { getUI, navigate } from "../../lib/ui.ts";

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
  words: "notifications desktop command notify inbox routes push",
  icon: <BellRing className="size-4" />,
  order: 40,
  component: lazy(() => import("./AlertSettings.tsx")),
});
