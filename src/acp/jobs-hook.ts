// What an ACP agent runs apart from its foreground work (ACP v2's background list), as the session's background
// jobs: the routes that list and stop a session's commands read it (src/server/routes/tools.ts), and the ACP runner
// fills it (src/server/routes/acp.ts), so the tools code names no agent.
import type { BackgroundView } from "./v2.ts";

export const acpJobs: {
  list: (session: string) => BackgroundView[];
  // Stops one item alone: nothing when it was asked, else why it cannot be.
  stop: (session: string, id: string) => string | void;
  // Told when a session's list changed (the page reads it again).
  changed?: (session: string) => void;
} = { list: () => [], stop: () => "no agent runs here" };
