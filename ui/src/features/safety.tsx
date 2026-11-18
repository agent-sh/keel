// The safety lane's side panels and commands: what the session changed
// (checkpoints and rewind) and the branch review. Imported once from main.tsx.
import { FileDiff, GitPullRequestArrow, ShieldCheck } from "lucide-react";
import { lazy } from "react";
import { panels, settingsSections } from "../lib/extend.ts";
import { registerCommand } from "../lib/keys.ts";
import { safety } from "../lib/safety.ts";
import { getState, reportError } from "../lib/store.ts";
import { getUI, savePref } from "../lib/ui.ts";
import { handoff } from "../lib/worktree.ts";
import { confirmAction } from "../components/Confirm.tsx";
import { slash } from "../lib/extend.ts";

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

const current = () => {
  const r = getUI().route;
  return r.name === "session" ? getState().sessions[r.id] : undefined;
};
// A handoff moves uncommitted work, so it is confirmed; a refusal is shown, not filed as an error.
async function move(to: "worktree" | "main") {
  const s = current();
  if (!s) return;
  const ok = await confirmAction(to === "worktree"
    ? { title: "Move this session to a new worktree?", body: "It goes on a new branch in its own folder. Uncommitted work moves with it, and the main checkout goes back to its last commit (the work is also kept on a ref).", action: "Move" }
    : { title: "Move this session to the main checkout?", body: "The main checkout switches to the session's branch and gets its uncommitted work; the worktree folder is removed. The main checkout must have no changes of its own.", action: "Move" });
  if (!ok) return;
  try {
    await handoff(s.id, to);
  } catch (e) {
    await confirmAction({ title: "The session was not moved", body: (e as Error).message, action: "OK" });
  }
}
registerCommand(
  { id: "handoff-worktree", label: "Move this session to a new worktree", group: "Session", words: "handoff branch isolate worktree", when: () => !!current() && !current()!.parent_id, run: () => void move("worktree") },
  { id: "handoff-main", label: "Move this session to the main checkout", group: "Session", words: "handoff branch local worktree", when: () => !!current(), run: () => void move("main") },
);
slash.add({ id: "worktree", label: "Move this session and its uncommitted work to a new worktree", run: () => move("worktree") });

safety.loadPending().catch(reportError);
