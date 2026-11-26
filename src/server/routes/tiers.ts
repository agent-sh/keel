// The owner's agent tiers (agents.tiers, src/engine/tiers.ts) and their one-time import from his own words.
//
// GET  /api/agent-tiers/import          { state: null | "used" | "dismissed", tiers, draft? }: whether the card shows
// POST /api/agent-tiers/import/draft    a small model of his chain reads his typed messages of the last days that
//                                       speak of models, tiers or effort -> { rows, said } (404: none of his words do)
// POST /api/agent-tiers/import/use { rows }   his yes: the rows become agents.tiers, the import is done
// POST /api/agent-tiers/import/dismiss       he put the card away: it does not show again
import { patchSettings, settings } from "../../admin/settings.ts";
import type { StoredEvent } from "../../core/types.ts";
import { asTiers, DRAFT_OUT, draftRows, IMPORT_DAYS, modelWords, TIERS_SYSTEM, tiersPrompt, wordsFor, type DraftRow } from "../../engine/tiers-import.ts";
import { tiersProblem } from "../../engine/tiers.ts";
import { typedText } from "../../safety/public-send.ts";
import type { RouteModule } from "../app.ts";
import { readsOf } from "../reads.ts";

const DRAFT_MS = 120_000;
// How many of his messages are read from the store before the filter.
const SCAN = 600;

export const tierRoutes: RouteModule = ({ store, engine, providers, errors }) => {
  let draft: { rows: DraftRow[]; said: number } | undefined;
  let drafting: Promise<Response> | undefined;
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  const state = () => settings().agents.tiers_import as null | "used" | "dismissed";

  const makeDraft = async (): Promise<Response> => {
    const since = Date.now() - IMPORT_DAYS * 86_400_000;
    // His messages in his own sessions (no agent's, none another harness runs), newest first, read on the read thread.
    const rows = await readsOf(store).sql<{ session_id: string; model: string; data: string; kind: string }>(
      "SELECT e.session_id, s.model, e.data, e.kind FROM sessions s JOIN events e ON e.session_id = s.id WHERE s.updated > ? AND s.parent_id IS NULL AND s.outside IS NULL AND e.kind = 'user' AND e.ts > ? ORDER BY e.ts DESC LIMIT ?",
      [since, since, SCAN],
    );
    const listed = await providers.models();
    const texts: string[] = [];
    let at: { id: string; model: string } | undefined;
    for (const r of rows) {
      let data: any;
      try { data = JSON.parse(r.data); } catch { continue; }
      const t = typedText({ kind: "user", data } as StoredEvent);
      if (!t) continue;
      texts.push(t);
      at ??= { id: r.session_id, model: r.model };
    }
    const said = wordsFor(texts, modelWords(listed));
    if (!said.length || !at) return json({ error: `None of your messages of the last ${IMPORT_DAYS} days speaks of models, tiers or effort.` }, 404);
    // Counted on his newest session that holds such words, on its model.
    const got = await engine.small(at.id, at.model, { system: TIERS_SYSTEM, prompt: tiersPrompt(said, listed), out: DRAFT_OUT, signal: AbortSignal.timeout(DRAFT_MS), at: "the tiers' import", holds: (t) => !!draftRows(t, listed) });
    const out = got ? draftRows(got.text, listed) : undefined;
    if (!out) return json({ error: "No small model could write your words as a table. Set the tiers by hand below." }, 502);
    draft = { rows: out, said: said.length };
    return json(draft);
  };

  return {
    "/api/agent-tiers/import": {
      GET: () => json({ state: state(), tiers: settings().agents.tiers.length, ...(draft ? { draft } : {}) }),
    },
    "/api/agent-tiers/import/draft": {
      POST: async () => {
        if (state()) return json({ error: "the import was used or put away already" }, 409);
        // Two presses make one request.
        drafting ??= makeDraft().catch((e) => { errors.capture("server", e, { at: "the tiers' import" }); return json({ error: String((e as Error).message ?? e) }, 500); }).finally(() => { drafting = undefined; });
        return (await drafting).clone();
      },
    },
    "/api/agent-tiers/import/use": {
      POST: async (req: Request) => {
        if (state()) return json({ error: "the import was used or put away already" }, 409);
        const body = (await req.json().catch(() => ({}))) as { rows?: DraftRow[] };
        if (!Array.isArray(body.rows) || !body.rows.length) return json({ error: "rows is the list of tiers to use" }, 400);
        const tiers = asTiers(body.rows);
        const bad = tiersProblem(tiers);
        if (bad) return json({ error: bad }, 400);
        const r = patchSettings({ agents: { tiers, tiers_import: "used" } });
        if (!r.ok) return json({ error: r.error }, r.status ?? 400);
        draft = undefined;
        return json({ tiers });
      },
    },
    "/api/agent-tiers/import/dismiss": {
      POST: () => {
        const r = patchSettings({ agents: { tiers_import: "dismissed" } });
        if (!r.ok) return json({ error: r.error }, r.status ?? 400);
        draft = undefined;
        return json({ ok: true });
      },
    },
  };
};
