import { automationRoutes } from "../../automation/index.ts";
import type { RouteModule } from "../app.ts";
import { checkpointRoutes } from "./checkpoints.ts";
import { draftRoutes } from "./drafts.ts";
import { errorRoutes } from "./errors.ts";
import { telemetryRoutes } from "./telemetry.ts";
import { driveRoutes } from "./drive.ts";
import { fleetRoutes } from "./fleet.ts";
import { resourceRoutes } from "./resources.ts";
import { mcpRoutes } from "./mcp.ts";
import { mobileRoutes } from "./mobile.ts";
import { permissionRoutes } from "./permissions.ts";
import { providersRoutes } from "./providers.ts";
import { pwaRoutes } from "./pwa.ts";
import { toolRoutes } from "./tools.ts";
import { usageRoutes } from "./usage.ts";
import { searchRoutes } from "./search.ts";
import { integrationRoutes } from "./integrations.ts";
import { workspaceRoutes } from "./workspace.ts";
import { worktreeRoutes } from "./worktrees.ts";
import { turnRoutes } from "./turns.ts";
import { switchRoutes } from "./switch.ts";

// Each feature module adds one line here.
export const routeModules: RouteModule[] = [
  permissionRoutes, // first: its beforeTool gate decides before the others run
  checkpointRoutes,
  workspaceRoutes,
  pwaRoutes,
  mcpRoutes,
  toolRoutes,
  searchRoutes,
  providersRoutes,
  worktreeRoutes,
  turnRoutes,
  switchRoutes,
  usageRoutes,
  errorRoutes,
  resourceRoutes,
  automationRoutes,
  integrationRoutes,
  driveRoutes,
  fleetRoutes, // after the gates: sends a placed session's workspace calls to their machine
  mobileRoutes, // after automation: it registers the phone as an alert channel
  draftRoutes,
  telemetryRoutes, // last: its tool timing starts after every gate
];
