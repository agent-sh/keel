// A safety rule change tried on the stored calls before it is on (src/safety/trial.ts): Settings > Safety's
// rule trial and `keel safety trial`. The loop gathers the facts every session shares; the calls are read and
// replayed on the read thread, one trial at a time, within its budget. A change the owner tried is saved here
// too, as the same change: only a change this daemon replayed saves, and a passkey signs that change's hash.
//
// The daemon tries settings diffs only (namespaces, grants, a mode). A patch of the rules' source is a developer's
// trial: `keel safety trial --patch` runs it in its own process over a read-only connection to the store, with the
// facts this module answers at /api/safety/trial/facts. The daemon never loads code a request names or carries.
import { createHash } from "node:crypto";
import { settings, patchSettings } from "../../admin/settings.ts";
import { parseNamespace } from "../../safety/accounts.ts";
import type { Gate } from "../../safety/gate.ts";
import { isMode } from "../../safety/policy.ts";
import type { Presence } from "../../safety/presence.ts";
import { sandboxStatus } from "../../safety/sandbox.ts";
import { canonicalChange, checkChange, emptyChange, namespacesWith, type RuleChange, type TrialReport } from "../../safety/trial.ts";
import { DAYS_MAX, type TrialAsk } from "../../safety/trial-read.ts";
import { buildId } from "../../core/build.ts";
import { catalogReady } from "../../tools/catalog.ts";
import { RUN_CODE } from "../../tools/codemode.ts";
import { toolFacts } from "../../tools/registry.ts";
import type { Deps, RouteModule } from "../app.ts";
import { readsOf } from "../reads.ts";
import { gate, presence } from "./permissions.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
// How long a replayed change may be saved after its trial: the owner reads the replay, then saves.
const TRIED_MS = 60 * 60_000;
const TRIED_MAX = 64;

const ownNames = (): string[] => (settings().accounts?.namespaces as string[] | undefined) ?? [];

// What is wrong with a change, its namespaces' words included, or null.
function wrong(c: unknown): string | null {
  const why = checkChange(c, isMode);
  if (why) return why;
  for (const n of (c as RuleChange | undefined)?.namespaces?.add ?? []) if (!parseNamespace(n)) return `${JSON.stringify(n)} names no namespace: write HOST/OWNER (a bare OWNER is on github.com), or npm:@scope, pypi:name, crates:name`;
  return null;
}

// The hash a change is known by: the trial that replayed it and the passkey action that saves it.
export const changeHash = (c?: RuleChange) => createHash("sha256").update(canonicalChange(c)).digest("hex");
export const saveAction = (c?: RuleChange) => `trial-save:${changeHash(c)}`;

type TrialGate = Pick<Gate, "trialFacts" | "rules" | "revoke" | "addStanding">;
type TrialPresence = Pick<Presence, "allows">;

// `gateOf`, `presenceOf`: the permission routes' gate and passkeys; `read`: the trial on the read thread (a test
// gives its own of each).
export function trialRoutes(
  deps: Pick<Deps, "store">, gateOf: () => TrialGate | undefined, presenceOf: () => TrialPresence | undefined,
  read: (ask: TrialAsk) => Promise<TrialReport> = (ask) => readsOf(deps.store).run("safety.trial", ask),
) {
  let running: number | undefined;
  const tried = new Map<string, number>();
  const facts = async (g: TrialGate): Promise<Omit<TrialAsk, "days" | "change">> => {
    const mcp = await Promise.race([catalogReady(), new Promise<[]>((r) => setTimeout(() => r([]), 200))]).catch(() => []);
    return {
      ...g.trialFacts(), tools: toolFacts(), runCode: RUN_CODE, mcpCall: "mcp_call",
      mcp: mcp.map((t) => ({ qualified: t.qualified, name: t.name, readOnly: !!t.readOnly })),
      namespaces: ownNames(), sandbox: sandboxStatus().available, rev: buildId(),
    };
  };
  return {
    // The facts a trial is replayed with, for the command line's own trial of a patch.
    "/api/safety/trial/facts": {
      GET: async () => {
        const g = gateOf();
        if (!g) return bad("the permission gate is not up", 503);
        return json({ ...(await facts(g)), days_max: DAYS_MAX });
      },
    },
    "/api/safety/trial": {
      POST: async (req: Request) => {
        const g = gateOf();
        if (!g) return bad("the permission gate is not up", 503);
        const b = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
        if ("patch" in b || "repo" in b) return bad("the daemon tries settings changes only (namespaces, grants, a mode): a patch of the rules is tried by `keel safety trial --patch` in its own process");
        const days = b.days === undefined ? 7 : Number(b.days);
        if (!Number.isInteger(days) || days < 1 || days > DAYS_MAX) return bad(`days is a whole number from 1 to ${DAYS_MAX}: a trial runs within its time budget on the read thread`);
        const why = wrong(b.change);
        if (why) return bad(why);
        if (running !== undefined) return json({ error: `a trial is running (it began ${Math.round((Date.now() - running) / 1000)} s ago): one runs at a time`, running: true }, 409);
        running = Date.now();
        try {
          const change = b.change && !emptyChange(b.change as RuleChange) ? (b.change as RuleChange) : undefined;
          const ask: TrialAsk = { days, ...(change ? { change } : {}), ...(await facts(g)) };
          const report = await read(ask);
          if (change) {
            const now = Date.now();
            for (const [h, at] of tried) if (now - at > TRIED_MS) tried.delete(h);
            if (tried.size >= TRIED_MAX) tried.delete(tried.keys().next().value!);
            tried.set(changeHash(change), now);
          }
          return json({ ...report, change_hash: change ? changeHash(change) : null });
        } finally {
          running = undefined;
        }
      },
    },
    // The change tried, made: namespaces in the settings, grants made and revoked. A mode is tried, never saved here.
    "/api/safety/trial/save": {
      POST: async (req: Request) => {
        const g = gateOf();
        if (!g) return bad("the permission gate is not up", 503);
        const b = ((await req.json().catch(() => null)) ?? {}) as { change?: unknown };
        const why = wrong(b.change);
        if (why) return bad(why);
        const c = b.change as RuleChange | undefined;
        if (!c || emptyChange(c)) return bad("the change changes nothing");
        if (c.mode) return bad("a mode is tried, not saved here: set it on a session, or as the mode new sessions start in");
        const at = tried.get(changeHash(c));
        if (at === undefined || Date.now() - at > TRIED_MS) return json({ error: "try this change first: only a change whose replay you saw is saved here" }, 409);
        const pk = presenceOf();
        if (pk && !pk.allows(req, saveAction(c))) return json({ error: "this needs your passkey from a remote device", presence: { action: saveAction(c) } }, 428);
        const ids = new Set(g.rules().map((r) => r.id));
        for (const id of c.grants?.remove ?? []) if (!ids.has(id)) return bad(`no grant ${id}`, 404);
        if (c.namespaces) {
          const r = patchSettings({ accounts: { namespaces: namespacesWith(ownNames(), c) } });
          if (!r.ok) return bad(r.error, r.status ?? 400);
        }
        for (const id of c.grants?.remove ?? []) g.revoke(id);
        for (const a of c.grants?.add ?? []) g.addStanding(a.kind, a.pattern, a.scope);
        tried.delete(changeHash(c));
        return json({ ok: true, namespaces: ownNames(), grants: g.rules() });
      },
    },
  };
}

export const safetyTrialRoutes: RouteModule = (deps) => trialRoutes(deps, () => gate, () => presence);
