// GET /api/health/check[?cwd=DIR]: the health check (src/admin/health.ts), run
// when asked, never on a timer. It changes none of the owner's files or
// settings and spends no tokens: a provider is asked for its model listing, never
// for an answer (Codex and Grok, whose listing can renew a sign-in, are read from
// the stored sign-in). `cwd`: the folder whose skills,
// commands, agents and hooks are read beside the owner's (the daemon's own
// working folder by default). `keel doctor` and Settings > Health ask here.
import { runHealth } from "../../admin/health.ts";
import type { HealthReport } from "../../admin/health-rows.ts";
import type { RouteModule } from "../app.ts";
import { readsOf } from "../reads.ts";
import { join } from "node:path";

// One check per folder at a time: a second ask while one runs gets the same answer.
let running: { cwd: string; p: Promise<HealthReport> } | undefined;

export const healthRoutes: RouteModule = ({ store, providers, workspace }) => ({
  // Seven complete Jerusalem calendar days, plus today to date. Counts only.
  "/api/cards/daily": {
    GET: async () => Response.json(await readsOf(store).run("cards.daily", { now: Date.now(), log_dir: join(store.stateDir, "logs") }), { headers: { "cache-control": "no-store" } }),
  },
  "/api/health/check": {
    GET: async (req: Request) => {
      const cwd = new URL(req.url).searchParams.get("cwd") || workspace;
      if (running?.cwd === cwd) return Response.json(await running.p);
      const mine = { cwd, p: runHealth({ store, providers }, cwd) };
      running = mine;
      try { return Response.json(await mine.p); } finally { if (running === mine) running = undefined; }
    },
  },
});
