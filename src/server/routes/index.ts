import { automationRoutes } from "../../automation/index.ts";
import type { RouteModule } from "../app.ts";
import { checkpointRoutes } from "./checkpoints.ts";
import { draftRoutes } from "./drafts.ts";
import { errorRoutes } from "./errors.ts";
import { adminRoutes } from "./admin.ts";
import { telemetryRoutes } from "./telemetry.ts";
import { driveRoutes } from "./drive.ts";
import { fleetRoutes } from "./fleet.ts";
import { resourceRoutes } from "./resources.ts";
import { mcpRoutes } from "./mcp.ts";
import { voiceRoutes } from "./voice.ts";
import { mobileRoutes } from "./mobile.ts";
import { permissionRoutes } from "./permissions.ts";
import { secretRoutes } from "./secrets.ts";
import { trustRoutes } from "./trust.ts";
import { planRoutes } from "./plan.ts";
import { providersRoutes } from "./providers.ts";
import { profileRoutes } from "./profile.ts";
import { pwaRoutes } from "./pwa.ts";
import { toolRoutes } from "./tools.ts";
import { usageRoutes } from "./usage.ts";
import { searchRoutes } from "./search.ts";
import { integrationRoutes } from "./integrations.ts";
import { importRoutes } from "./imports.ts";
import { takeoverRoutes } from "./takeover.ts";
import { hookRoutes } from "./hooks.ts";
import { workspaceRoutes } from "./workspace.ts";
import { worktreeRoutes } from "./worktrees.ts";
import { reviewRoutes } from "./reviews.ts";
import { turnRoutes } from "./turns.ts";
import { switchRoutes } from "./switch.ts";
import { sideRoutes } from "./side.ts";
import { treeRoutes } from "./tree.ts";
import { attachmentRoutes } from "./attachments.ts";
import { runRoutes } from "./run.ts";
import { marksRoutes } from "./marks.ts";

// Each feature module adds one line here.
export const routeModules: RouteModule[] = [
  permissionRoutes, // first: its beforeTool gate decides before the others run
  planRoutes,
  trustRoutes, // protected files are watched around calls the gate let through
  checkpointRoutes,
  workspaceRoutes,
  pwaRoutes,
  mcpRoutes,
  voiceRoutes, // after mcp: it bundles the say tool
  toolRoutes,
  searchRoutes,
  providersRoutes,
  profileRoutes,
  worktreeRoutes,
  reviewRoutes,
  turnRoutes,
  switchRoutes,
  sideRoutes,
  treeRoutes,
  attachmentRoutes,
  usageRoutes,
  errorRoutes,
  resourceRoutes,
  adminRoutes,
  automationRoutes,
  integrationRoutes,
  driveRoutes,
  fleetRoutes, // after the gates: sends a placed session's workspace calls to their machine
  mobileRoutes, // after automation: it registers the phone as an alert channel
  draftRoutes,
  marksRoutes, // after automation: unread marks are its alerts
  importRoutes,
  takeoverRoutes, // taking over a session another harness runs
  hookRoutes,
  runRoutes, // the command line: keel run, keel send
  secretRoutes, // the last gate: a call runs with its secrets put back, after every hook saw the placeholder
  telemetryRoutes, // last: its tool timing starts after every gate
];
