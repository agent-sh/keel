import type { RouteModule } from "../app.ts";
import { permissionRoutes } from "./permissions.ts";

// Each feature module adds one line here.
export const routeModules: RouteModule[] = [
  permissionRoutes,
];
