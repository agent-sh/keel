// The owner's presses, local only (src/admin/presses.ts says what is kept).
//   POST   /api/presses   a batch from the page: { surface, presses: [{ c, v, s?, t }], seen: [{ c, v }], opens: [{ ms, n, cold, v, t }] } -> { record }
//                         With recording off nothing is stored and `record` is false: the page stops sending.
//   GET    /api/presses?days=   what the owner presses, most used first per view, the controls never pressed, and p50 and p95 of session opens
//   DELETE /api/presses   forgets every press and every drawn control
// A batch is stored with the other side writes (src/core/side.ts): a few rows every few seconds cost no commit of their own.
import { cleanBatch, clearPresses, PRESS_SCHEMA, storePresses } from "../../admin/presses.ts";
import { registerSettings, settings } from "../../admin/settings.ts";
import type { RouteModule } from "../app.ts";
import { readsOf } from "../reads.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });

registerSettings("presses", { record: true }, (v) => (typeof v.record !== "boolean" ? "record is true or false" : undefined));
const recording = () => settings().presses?.record !== false;

export const pressRoutes: RouteModule = ({ store }) => {
  store.migrate(PRESS_SCHEMA);
  return {
    "/api/presses": {
      POST: async (req: Request) => {
        if (!recording()) return json({ record: false });
        const now = Date.now();
        const b = cleanBatch(await req.json().catch(() => null), now);
        if (b.presses.length || b.seen.length || b.opens.length) store.side.later("the owner's presses", () => storePresses(store.db, b, now));
        return json({ record: true });
      },
      GET: async (req: Request) => {
        const days = Number(new URL(req.url).searchParams.get("days")) || undefined;
        return json({ record: recording(), ...(await readsOf(store).run("presses.report", { days })) });
      },
      DELETE: () => {
        clearPresses(store.db);
        return json({ ok: true });
      },
    },
  };
};
