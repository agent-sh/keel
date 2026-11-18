import type { RouteModule } from "../app.ts";
import { checkpointRoutes } from "./checkpoints.ts";
import { mcpRoutes } from "./mcp.ts";
import { permissionRoutes } from "./permissions.ts";
import { pwaRoutes } from "./pwa.ts";
import { toolRoutes } from "./tools.ts";
import { workspaceRoutes } from "./workspace.ts";

// Each feature module adds one line here.
export const routeModules: RouteModule[] = [
  permissionRoutes, // first: its beforeTool gate decides before the others run
  checkpointRoutes,
  workspaceRoutes,
  pwaRoutes,
  mcpRoutes,
  toolRoutes,
];
