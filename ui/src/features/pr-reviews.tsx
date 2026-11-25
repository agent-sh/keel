// Pull request reviews from GitHub: Settings > Pull requests (the watched
// repositories and the reviews), and in a review's own session the panel with
// its draft and the button that posts it. Imported once from main.tsx.
import { GitPullRequest } from "lucide-react";
import { lazy } from "react";
import { headerActions, panels, settingsSections } from "../lib/extend.ts";
import { registerCommand } from "../lib/keys.ts";
import { navigate } from "../lib/ui.ts";

const TAG = "pr-review";
const isReview = (s: { settings?: { tags?: string[] } }) => !!s.settings?.tags?.includes(TAG);

settingsSections.add({
  id: "pull-requests",
  label: "Pull requests",
  words: "github pull request review watch repository poll post draft comment trigger token gh",
  icon: <GitPullRequest className="size-4" />,
  order: 22,
  component: lazy(() => import("../components/PrReviews.tsx")),
});

panels.add({
  id: "pr-review",
  label: "Pull request",
  icon: <GitPullRequest className="size-4" />,
  order: 5,
  hint: "the review's draft and posting it",
  when: isReview,
  component: lazy(() => import("../components/PrReviews.tsx").then((m) => ({ default: m.PrReviewPanel }))),
});

headerActions.add({ id: "pr-review", label: "Pull request review: the draft and posting it", icon: <GitPullRequest className="size-4" />, when: isReview, run: () => void import("../components/SidePanel.tsx").then((m) => m.openPanel("pr-review")) });

registerCommand({ id: "pull-requests", label: "Pull request reviews: watched repositories", group: "General", words: "github pull request review watch post", run: () => navigate({ name: "settings", section: "pull-requests" }) });
