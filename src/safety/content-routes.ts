// A folder's content stays on the providers the owner allowed for it
// (route-rule.ts holds the rule). Every model call made for a session asks
// `crossing` with the provider it would go to: the engine's one request path
// (turns, summaries, side answers, readers, titles, sampling, warm reads), the
// judge, and the choices made before a request (an agent's model, the overload
// fallback, a successor's model, a verifier's). A call that would cross is not
// sent: `sayCrossing` records it once per purpose and provider in the
// session's failures scope, and the caller falls back to an allowed route or
// does without (INSTEAD says which, per purpose).
//
// The setting is `content_routes` in the daemon settings: `default` (the
// providers of every folder no entry names, or null for any) and `folders`
// (a folder, absolute or under ~, to its providers).
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { registerSettings, settings } from "../admin/settings.ts";
import { allHooks } from "../engine/hooks.ts";
import type { Session } from "../core/types.ts";
import { allowedFor, allows, checkRule, crossingText, originOf, providerOf, type Allowed, type Crossing, type RoutePurpose, type RouteRule, type Spell } from "./route-rule.ts";

registerSettings("content_routes", { default: null, folders: {} }, checkRule);

export function routeRule(): RouteRule {
  const r = settings().content_routes;
  return { default: r?.default ?? null, folders: r?.folders ?? {} };
}

const unset = (r: RouteRule) => !r.default && !Object.keys(r.folders).length;

type Sessions = {
  session(id: string): Pick<Session, "id" | "workspace" | "parent_id"> | null | undefined;
  db?: { query(sql: string): { get(...a: any[]): unknown } };
};

// A folder spelled one way: links resolved, so a folder reached through a link and its real path are
// one folder. A folder that is not there (a rule written ahead, a session's folder since removed) is
// its nearest existing parent's real path with the rest as written.
export const realFolder: Spell = (p) => {
  try { return realpathSync.native(p); } catch {}
  const up = dirname(p);
  return up === p ? p : join(realFolder(up), basename(p));
};

// The worktree of Keel's a session works in (its row in the worktree manager's table), if any.
function worktreeOf(store: Sessions, id: string): { repo_root: string; path: string } | undefined {
  try { return (store.db?.query("SELECT repo_root, path FROM worktrees WHERE session_id = ?").get(id) as { repo_root: string; path: string } | null) ?? undefined; }
  catch { return undefined; } // no worktree was ever made: the table is not there
}

// The folders a session's content comes from: its own, then each session's above it. A session in a
// worktree of Keel's counts as its repository's folder (originOf), the owner's and an agent's alike,
// so a worktree under Keel's state folder holds the rule of the folder it was made from.
export function chainOf(store: Sessions, id: string): string[] {
  const out: string[] = [];
  let s = store.session(id);
  for (let i = 0; s && i < 32; i++) {
    const f = s.workspace ? originOf(s.workspace, worktreeOf(store, s.id)) : "";
    if (f && !out.includes(f)) out.push(f);
    s = s.parent_id ? store.session(s.parent_id) : undefined;
  }
  return out;
}

// What the rule allows for the session now; null when every provider is.
export function routeOf(store: Sessions, id: string, rule = routeRule()): Allowed {
  return unset(rule) ? null : allowedFor(rule, chainOf(store, id), homedir(), realFolder);
}

// A folder the rule decides by itself (a session about to be made there).
export function routeOfFolder(folder: string, rule = routeRule()): Allowed {
  return unset(rule) ? null : allowedFor(rule, [folder], homedir(), realFolder);
}

// The crossing a call of `purpose` to `model` would make, or undefined when the rule allows it.
// `provider`: the provider the call goes to, when the model id does not name it as its prefix.
export function crossing(store: Sessions, id: string, purpose: RoutePurpose, model: string, provider = providerOf(model)): Crossing | undefined {
  return crossingIn(routeOf(store, id), purpose, model, provider);
}

export function crossingIn(a: Allowed, purpose: RoutePurpose, model: string, provider = providerOf(model)): Crossing | undefined {
  if (allows(a, provider)) return undefined;
  return { purpose, provider, model, by: a!.by, allowed: a!.providers };
}

// The error a refused call throws: never retried, and its words say what happened instead.
export class RouteRefused extends Error {
  readonly kind = "route";
  readonly retryable = false;
  constructor(readonly crossing: Crossing) {
    super(crossingText(crossing));
    this.name = "RouteRefused";
  }
}

// Said once per purpose and provider in the session's failures scope (the
// failures hook groups repeats into one cause with a count). `tell`: the
// session's model hears of it with its next input; false when something else
// already tells it (a turn that fails on it says so itself).
export function sayCrossing(session: Session | null | undefined, c: Crossing, tell = true) {
  if (!session) return;
  for (const h of allHooks()) {
    try { h.routeRefused?.(session, c, tell); } catch { /* a hook that fails does not let the call through */ }
  }
}

// The first of `ids` the session's folder allows, in order; each one passed over before it is said
// once (record only: the choice that remains is the session's answer).
export function pickAllowed(store: Sessions, id: string, purpose: RoutePurpose, ids: readonly (string | null | undefined)[]): string | undefined {
  const a = routeOf(store, id);
  for (const m of ids) {
    if (!m) continue;
    const c = crossingIn(a, purpose, m);
    if (!c) return m;
    sayCrossing(store.session(id) as Session | undefined, c, false);
  }
  return undefined;
}
