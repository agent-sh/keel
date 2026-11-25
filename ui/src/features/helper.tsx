// The helper's place in the workbench: its side panel (shown in the helper's
// own conversation), its settings section, and Ctrl J to open it from
// anywhere. The list's Helper entry is in Sidebar.tsx. Each says the name the owner gave it.
import { Sparkles } from "lucide-react";
import { lazy } from "react";
import { helperName, onHelper, openHelper } from "../lib/helper.ts";
import { type Panel, panels, settingsSections } from "../lib/extend.ts";
import { registerCommand } from "../lib/keys.ts";
import { reportError } from "../lib/store.ts";

const load = () => import("../components/HelperPanel.tsx");

// The panel is named as the owner named the helper, and again when they rename it.
const component = lazy(() => load().then((m) => ({ default: m.HelperPanel })));
const panel = (label: string): Panel => ({ id: "helper", label, icon: <Sparkles className="size-4" />, order: 5, when: (s) => !!s.settings.helper, component });
let named = helperName();
panels.add(panel(named));
onHelper(() => { if (helperName() !== named) panels.add(panel((named = helperName()))); });

settingsSections.add({
  id: "helper",
  label: "Helper",
  words: "helper assistant always on memory remembered gmail mail calendar digest",
  icon: <Sparkles className="size-4" />,
  order: 38,
  component: lazy(() => load().then((m) => ({ default: m.HelperSettings }))),
});

registerCommand({ id: "open-helper", label: "Open the helper", group: "Go", keys: "mod+j", inInput: true, words: "assistant memory mail", run: () => void openHelper().catch(reportError) });
