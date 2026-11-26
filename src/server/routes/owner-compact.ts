// The owner's switch for compaction by price on his own session (src/engine/owner-compact.ts), and its numbers.
//
// GET /api/sessions/:id/price-compaction
//   -> { on, on_ms?, off_ms?, before, since? }
//   before / since: the session's own numbers in the window before the switch was turned on and in the one since
//   (src/admin/owner-compact-read.ts): steps, context (median, 90th percentile), first token (median), dollars and
//   dollars an hour, compactions. Read on the read thread. The switch itself is the session setting
//   owner_compact_by_price (PATCH /api/sessions/:id, which keeps when it moved).
// Content-free: counts, sizes, times and dollars.
import { sessionRef } from "../../admin/session-ref.ts";
import type { OwnerCompactNumbers } from "../../admin/owner-compact-read.ts";
import { seesOutside } from "../admission.ts";
import type { RouteModule } from "../app.ts";
import { readsOf } from "../reads.ts";

export const ownerCompactRoutes: RouteModule = ({ store }) => ({
  "/api/sessions/:id/price-compaction": {
    GET: async (req: Request & { params: { id: string } }) => {
      const s = sessionRef(store, req.params.id, seesOutside(req));
      if (s.parent_id) return Response.json({ error: "an agent compacts by price with its tree (compact_by_price), not by the owner's switch" }, { status: 400 });
      const on = s.settings.owner_compact_by_price_on_ms, off = s.settings.owner_compact_by_price_off_ms;
      const numbers = await readsOf(store).run("compact.ownerNumbers", { session: s.id, ...(on !== undefined ? { on } : {}), ...(off !== undefined ? { off } : {}), now: Date.now() }) as OwnerCompactNumbers;
      return Response.json({ on: s.settings.owner_compact_by_price === true, ...(on !== undefined ? { on_ms: on } : {}), ...(off !== undefined ? { off_ms: off } : {}), ...numbers }, { headers: { "cache-control": "no-store" } });
    },
  },
});
