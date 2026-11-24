// A safety rule change tried on the stored calls before it is on (src/safety/trial.ts): Settings > Safety's
// rule trial and `keel safety trial`. The loop gathers the facts every session shares; the calls are read and
// replayed on the read thread. A change the owner tried is saved here too, as the same change.
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { settings, patchSettings } from "../../admin/settings.ts";
import { parseNamespace } from "../../safety/accounts.ts";
import { isMode } from "../../safety/policy.ts";
import { sandboxStatus } from "../../safety/sandbox.ts";
import { checkChange, emptyChange, namespacesWith, type RuleChange } from "../../safety/trial.ts";
import { DAYS_MAX, type TrialAsk } from "../../safety/trial-read.ts";
import { buildId } from "../../core/build.ts";
import { git } from "../../core/git.ts";
import { catalogReady } from "../../tools/catalog.ts";
import { RUN_CODE } from "../../tools/codemode.ts";
import { toolFacts } from "../../tools/registry.ts";
import type { RouteModule } from "../app.ts";
import { readsOf } from "../reads.ts";
import { gate, presence } from "./permissions.ts";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const bad = (error: string, status = 400) => json({ error }, status);
// The longest patch a trial takes.
const PATCH_MAX = 1_000_000;

const ownNames = (): string[] => (settings().accounts?.namespaces as string[] | undefined) ?? [];

// What is wrong with a change, its namespaces' words included, or null.
function wrong(c: unknown): string | null {
  const why = checkChange(c, isMode);
  if (why) return why;
  for (const n of (c as RuleChange | undefined)?.namespaces?.add ?? []) if (!parseNamespace(n)) return `${JSON.stringify(n)} names no namespace: write HOST/OWNER (a bare OWNER is on github.com), or npm:@scope, pypi:name, crates:name`;
  return null;
}

// A patch's two sides: the repository's source as it is, and patched. `git apply` makes the patched side, in a
// folder of its own, so the repository is never changed.
export async function patchSides(repo: string, patch: string): Promise<{ base: string; cand: string; dir: string } | { error: string }> {
  if (!isAbsolute(repo) || !existsSync(join(repo, "src", "safety", "trial-rules.ts"))) return { error: `${repo} holds no Keel source (src/safety/trial-rules.ts)` };
  const dir = join(tmpdir(), `keel-trial-${Bun.randomUUIDv7()}`);
  try {
    for (const side of ["base", "cand"]) {
      cpSync(join(repo, "src"), join(dir, side, "src"), { recursive: true });
      if (existsSync(join(repo, "node_modules"))) symlinkSync(join(repo, "node_modules"), join(dir, side, "node_modules"));
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "change.patch"), patch);
    // (Plain: the copy is no repository, and no config of one is wanted.)
    const r = await git(join(dir, "cand"), ["apply", "--whitespace=nowarn", join(dir, "change.patch")], { mode: "plain" });
    if (r.code !== 0) { rmSync(dir, { recursive: true, force: true }); return { error: `the patch does not apply to ${repo}: ${r.err.trim().slice(0, 400)}` }; }
    return { base: join(dir, "base", "src", "safety", "trial-rules.ts"), cand: join(dir, "cand", "src", "safety", "trial-rules.ts"), dir };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return { error: `the patch's copies could not be made: ${(e as Error).message}` };
  }
}

export const safetyTrialRoutes: RouteModule = ({ store }) => ({
  "/api/safety/trial": {
    POST: async (req: Request) => {
      const g = gate;
      if (!g) return bad("the permission gate is not up", 503);
      const b = ((await req.json().catch(() => null)) ?? {}) as { days?: unknown; change?: unknown; patch?: unknown; repo?: unknown };
      const days = b.days === undefined ? 7 : Number(b.days);
      if (!Number.isInteger(days) || days < 1 || days > DAYS_MAX) return bad(`days is a whole number from 1 to ${DAYS_MAX}`);
      const why = wrong(b.change);
      if (why) return bad(why);
      if (b.patch !== undefined && (typeof b.patch !== "string" || !b.patch.trim() || b.patch.length > PATCH_MAX)) return bad("patch is the text of a unified diff");
      if (b.patch !== undefined && typeof b.repo !== "string") return bad("a patch names the repository its paths are in (repo)");
      const sides = typeof b.patch === "string" ? await patchSides(b.repo as string, b.patch) : undefined;
      if (sides && "error" in sides) return bad(sides.error);
      try {
        const mcp = await Promise.race([catalogReady(), new Promise<[]>((r) => setTimeout(() => r([]), 200))]).catch(() => []);
        const ask: TrialAsk = {
          days, ...(b.change && !emptyChange(b.change as RuleChange) ? { change: b.change as RuleChange } : {}),
          ...g.trialFacts(), tools: toolFacts(), runCode: RUN_CODE, mcpCall: "mcp_call",
          mcp: mcp.map((t) => ({ qualified: t.qualified, name: t.name, readOnly: !!t.readOnly })),
          namespaces: ownNames(), sandbox: sandboxStatus().available, rev: buildId(),
          ...(sides ? { base: sides.base, cand: sides.cand } : {}),
        };
        return json(await readsOf(store).run("safety.trial", ask));
      } finally {
        if (sides) rmSync(sides.dir, { recursive: true, force: true });
      }
    },
  },
  // The change tried, made: namespaces in the settings, grants made and revoked. A mode is tried, never saved here.
  "/api/safety/trial/save": {
    POST: async (req: Request) => {
      const g = gate;
      if (!g) return bad("the permission gate is not up", 503);
      if (presence && !presence.allows(req, "grant")) return json({ error: "this needs your passkey from a remote device", presence: { action: "grant" } }, 428);
      const b = ((await req.json().catch(() => null)) ?? {}) as { change?: unknown };
      const why = wrong(b.change);
      if (why) return bad(why);
      const c = b.change as RuleChange | undefined;
      if (!c || emptyChange(c)) return bad("the change changes nothing");
      if (c.mode) return bad("a mode is tried, not saved here: set it on a session, or as the mode new sessions start in");
      const ids = new Set(g.rules().map((r) => r.id));
      for (const id of c.grants?.remove ?? []) if (!ids.has(id)) return bad(`no grant ${id}`, 404);
      if (c.namespaces) {
        const r = patchSettings({ accounts: { namespaces: namespacesWith(ownNames(), c) } });
        if (!r.ok) return bad(r.error, r.status ?? 400);
      }
      for (const id of c.grants?.remove ?? []) g.revoke(id);
      for (const a of c.grants?.add ?? []) g.addStanding(a.kind, a.pattern, a.scope);
      return json({ ok: true, namespaces: ownNames(), grants: g.rules() });
    },
  },
});
