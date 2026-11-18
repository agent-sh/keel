// The safety lane's side panels and commands: what the session changed
// (checkpoints and rewind) and the branch review. Imported once from main.tsx.
import { FileDiff, GitPullRequestArrow, ShieldCheck } from "lucide-react";
import { lazy } from "react";
import { panels, settingsSections } from "../lib/extend.ts";
import { registerCommand } from "../lib/keys.ts";
import { safety } from "../lib/safety.ts";
import { getState, reportError } from "../lib/store.ts";
import { getUI, savePref } from "../lib/ui.ts";

panels.add(
  {
    id: "changes",
    label: "Changes",
    icon: <FileDiff className="size-4" />,
    order: 20,
    component: lazy(() => import("../components/ChangesPanel.tsx").then((m) => ({ default: m.ChangesPanel }))),
  },
  {
    id: "review",
    label: "Review",
    icon: <GitPullRequestArrow className="size-4" />,
    order: 30,
    component: lazy(() => import("../components/BranchReview.tsx").then((m) => ({ default: m.BranchReview }))),
  },
);

settingsSections.add({
  id: "safety",
  label: "Safety",
  words: "permissions mode reviewer review model secrets passkey trust hooks quarantine",
  icon: <ShieldCheck className="size-4" />,
  order: 20,
  component: lazy(() => import("../components/SafetySettings.tsx").then((m) => ({ default: () => <m.SafetySettings /> }))),
});

const inSession = () => {
  const r = getUI().route;
  return r.name === "session" && !!getState().sessions[r.id];
};
const toggle = (id: string) => savePref("panel", getUI().panel === id ? null : id);

registerCommand(
  { id: "panel-changes", label: "Changes panel: diffs, rewind and revert", group: "View", keys: "mod+shift+d", inInput: true, words: "checkpoint undo rewind revert diff", when: inSession, run: () => toggle("changes") },
  { id: "panel-review", label: "Review the branch", group: "View", words: "pull request comment worktree", when: inSession, run: () => toggle("review") },
);

safety.loadPending().catch(reportError);
