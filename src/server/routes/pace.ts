// The pace of a session's unattended turns (src/automation/pace.ts), for its menu's dialog.
//
// GET /api/sessions/:id/pace
//   -> { session_id, pace_min, from, waiting, at?, last_end?, waited, joined, day }
//   pace_min: the pace in force (0: off); from: "session" (its own pace_min), "default" (the owner's
//   pace.unattended_min) or "agent" (an agent keeps no pace of its own unless its session sets one).
//   waiting / at: inputs that wait for the pace now and when they go. waited / joined: since the daemon
//   started, inputs that waited and turns they did not start. day: its turns of the last 24 hours by what
//   started them (src/automation/pace-read.ts), read on the read thread; ?day=0 leaves it out (the dock's read).
// The pace itself is the session setting pace_min (PATCH /api/sessions/:id, 0 for off, null for the default).
// Content-free: counts, times and dollars.
import { sessionRef } from "../../admin/session-ref.ts";
import * as pace from "../../automation/pace.ts";
import type { PaceDay } from "../../automation/pace-read.ts";
import { seesOutside } from "../admission.ts";
import type { RouteModule } from "../app.ts";
import { readsOf } from "../reads.ts";

export const paceRoutes: RouteModule = ({ store }) => ({
  "/api/sessions/:id/pace": {
    GET: async (req: Request & { params: { id: string } }) => {
      const s = sessionRef(store, req.params.id, seesOutside(req));
      const v = pace.view(s.id);
      if (new URL(req.url).searchParams.get("day") === "0") return Response.json(v, { headers: { "cache-control": "no-store" } });
      const day = await readsOf(store).run("pace.day", { session: s.id, now: Date.now(), pace_ms: v.pace_min * 60_000 }) as PaceDay;
      return Response.json({ ...v, day }, { headers: { "cache-control": "no-store" } });
    },
  },
});
