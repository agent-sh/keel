// The branches ready to land across the owner's sessions, for Home and the Inbox: the cards the phone decides
// from (src/integrations/mobile/landings.ts) that have nothing missing, read when a page shows the feed, told
// to it as one `landings` frame whenever the list changed (src/server/scope.ts), never polled. The owner lands
// one here the way the phone does: the queue builds it on the base, checks that tree and fast-forwards, and the
// request is refused when the card's facts, read again, are not the ones shown (its print).
// Nothing here counts as something that needs the owner: it is a list of what could land, not a request.
import { report as agentReport, rootSession, send as sendToAgent } from "../../automation/agents.ts";
import type { LandCard } from "../../board/card.ts";
import { landings } from "../../integrations/mobile/landings.ts";
import type { Deps, RouteModule } from "../app.ts";
import { sessionOfCaller } from "../caller.ts";
import { feedHeard } from "../feed-heard.ts";
import { workBoard } from "./board.ts";
import { landing } from "./landing.ts";
import { presence } from "./permissions.ts";

// What changes a card's facts, in the frames the daemon already emits: an agent's record (it ended, a reviewer
// answered), the landing queue, a branch head that moved, the overlap and pair forecasts, a review.
const MOVES = new Set(["landing", "pairs", "overlap", "tree_review", "reviews", "pictures"]);
const SETTLE_MS = 1_200;

export const readyRoutes: RouteModule = (deps: Deps) => {
  const { store, bus, errors } = deps;
  const L = landings({
    store, board: workBoard, landing: () => landing, rootOf: rootSession, report: agentReport,
    sendBack: (id, text, key) => sendToAgent(id, text, false, key, undefined, undefined, "owner_back"),
  });

  const ready = async (fresh = false): Promise<LandCard[]> => (await L.list(fresh)).filter((c) => c.ready);
  const printOf = (cards: LandCard[]) => cards.map((c) => `${c.key}:${c.fp}`).join("|");

  // One read at a time; one asked for while it runs is made again after it.
  let told = "", busy = false, again = false;
  async function refresh() {
    if (busy) { again = true; return; }
    busy = true;
    try {
      const cards = await ready(true);
      const print = printOf(cards);
      if (print !== told) { told = print; bus.emit({ t: "feature", name: "landings", data: { cards } }); }
    } catch (e) {
      errors.capture("server", e, { at: "ready to land" });
    } finally {
      busy = false;
      if (again) { again = false; schedule(); }
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  function schedule() {
    // Nobody shows the list: nothing is read. The page reads it whole when it opens the feed.
    if (timer || !feedHeard.of("landings")) return;
    timer = setTimeout(() => { timer = undefined; void refresh(); }, SETTLE_MS);
    timer.unref?.();
  }
  bus.on((f) => {
    if (f.t !== "feature") return;
    if (f.name === "automation" ? (f.data as { kind?: string } | undefined)?.kind === "agent" : MOVES.has(f.name)) schedule();
  });

  const json = (data: unknown, status = 200) => Response.json(data, { status });
  return {
    "/api/landings": {
      GET: async () => {
        const cards = await ready();
        // What a page was shown last is what the next frame is compared with.
        told = printOf(cards);
        return json({ cards });
      },
    },
    // Land one card, only on the facts it was shown with: the owner's own hand, and from a remote device
    // its passkey, as the other landing routes ask.
    "/api/landings/:key/land": {
      POST: async (req: any, srv: Bun.Server<unknown>) => {
        const by = sessionOfCaller(req, srv);
        if (by) return json({ error: `this is the owner's: a session's command (session ${by}) does not land branches through the API` }, 403);
        if (presence && !presence.allows(req, "landing")) return json({ error: "this needs your passkey from a remote device", presence: { action: "landing" } }, 428);
        const b = await req.json().catch(() => ({}));
        const fp = typeof b?.fp === "string" ? b.fp : "";
        if (!fp) return json({ error: "fp is the print of the card as it was shown" }, 400);
        let key: string;
        try { key = decodeURIComponent(req.params.key); } catch { return json({ error: "the key is not a valid path part" }, 400); }
        const r = await L.land(key, fp);
        schedule();
        return "status" in r ? json({ error: r.error, card: r.card }, r.status) : json(r);
      },
    },
  };
};
