import type { RouteModule } from "../app.ts";
import { checkpointRoutes } from "./checkpoints.ts";
import { permissionRoutes } from "./permissions.ts";
import { workspaceRoutes } from "./workspace.ts";

// Each feature module adds one line here.
export const routeModules: RouteModule[] = [
  permissionRoutes, // first: its beforeTool gate decides before the others run
  checkpointRoutes,
  workspaceRoutes,
];
