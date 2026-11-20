// The Artifacts tab of the side panel: what the session made (ArtifactsPanel.tsx).
import { Shapes } from "lucide-react";
import { lazy } from "react";
import { panels } from "../lib/extend.ts";
import { registerCommand } from "../lib/keys.ts";
import { getUI, savePref } from "../lib/ui.ts";

panels.add({
  id: "artifacts",
  label: "Artifacts",
  icon: <Shapes className="size-4" />,
  order: 12,
  group: "Work",
  component: lazy(() => import("../components/ArtifactsPanel.tsx").then((m) => ({ default: m.ArtifactsPanel }))),
} as Parameters<typeof panels.add>[0]);

registerCommand({
  id: "panel-artifacts", label: "Artifacts: what this session made", group: "View", words: "files images reports pages outputs made changed",
  when: () => getUI().route.name === "session",
  run: () => savePref("panel", getUI().panel === "artifacts" ? null : "artifacts"),
});
