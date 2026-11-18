import { automationRoutes } from "../../automation/index.ts";
import type { RouteModule } from "../app.ts";
import { boardRoutes } from "./board.ts";
import { checkpointRoutes } from "./checkpoints.ts";
import { draftRoutes } from "./drafts.ts";
import { errorRoutes } from "./errors.ts";
import { telemetryRoutes } from "./telemetry.ts";
import { driveRoutes } from "./drive.ts";
import { fleetRoutes } from "./fleet.ts";
import { resourceRoutes } from "./resources.ts";
import { mcpRoutes } from "./mcp.ts";
import { voiceRoutes } from "./voice.ts";
import { mobileRoutes } from "./mobile.ts";
import { permissionRoutes } from "./permissions.ts";
import { secretRoutes } from "./secrets.ts";
import { providersRoutes } from "./providers.ts";
import { pwaRoutes } from "./pwa.ts";
import { toolRoutes } from "./tools.ts";
import { usageRoutes } from "./usage.ts";
import { searchRoutes } from "./search.ts";
import { integrationRoutes } from "./integrations.ts";
import { importRoutes } from "./imports.ts";
import { workspaceRoutes } from "./workspace.ts";
import { worktreeRoutes } from "./worktrees.ts";
import { reviewRoutes } from "./reviews.ts";
import { turnRoutes } from "./turns.ts";
import { switchRoutes } from "./switch.ts";
import { sideRoutes } from "./side.ts";
import { treeRoutes } from "./tree.ts";

// Each feature module adds one line here.
export const routeModules: RouteModule[] = [
  permissionRoutes, // first: its beforeTool gate decides before the others run
  secretRoutes, // after the gate: a call it allowed runs with its secrets put back
  checkpointRoutes,
  workspaceRoutes,
  pwaRoutes,
  mcpRoutes,
  voiceRoutes, // after mcp: it bundles the say tool
  toolRoutes,
  searchRoutes,
  providersRoutes,
  worktreeRoutes,
  reviewRoutes,
  turnRoutes,
  switchRoutes,
  sideRoutes,
  treeRoutes,
  usageRoutes,
  errorRoutes,
  resourceRoutes,
  automationRoutes,
  integrationRoutes,
  driveRoutes,
  fleetRoutes, // after the gates: sends a placed session's workspace calls to their machine
  mobileRoutes, // after automation: it registers the phone as an alert channel
  draftRoutes,
  boardRoutes,
  importRoutes,
  telemetryRoutes, // last: its tool timing starts after every gate
];
