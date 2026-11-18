import type { RouteModule } from "../app.ts";
import { checkpointRoutes } from "./checkpoints.ts";
import { errorRoutes } from "./errors.ts";
import { mcpRoutes } from "./mcp.ts";
import { permissionRoutes } from "./permissions.ts";
import { providersRoutes } from "./providers.ts";
import { pwaRoutes } from "./pwa.ts";
import { toolRoutes } from "./tools.ts";
import { usageRoutes } from "./usage.ts";
import { searchRoutes } from "./search.ts";
import { workspaceRoutes } from "./workspace.ts";
import { worktreeRoutes } from "./worktrees.ts";
import { turnRoutes } from "./turns.ts";

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
  usageRoutes,
  errorRoutes,
];
