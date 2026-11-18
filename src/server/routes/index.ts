import type { RouteModule } from "../app.ts";
import { permissionRoutes } from "./permissions.ts";
import { workspaceRoutes } from "./workspace.ts";

// Each feature module adds one line here.
export const routeModules: RouteModule[] = [
  permissionRoutes,
  workspaceRoutes,
];
