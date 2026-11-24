// Which providers may see a folder's content: the pure rule (content-routes.ts
// applies it). The owner names, per folder, the providers its sessions' model
// calls may go to, and a default for every other folder. A folder's entry
// covers the folders under it, the deepest entry winning. Nothing named
// anywhere: every provider is allowed, as before the rule existed.
//
// A session's content is its own folder's and that of every session above
// it: an agent reads its parent's task, a verifier the goal it checks. So a
// session may use only the providers every folder on its chain allows.

export type RouteRule = { default: string[] | null; folders: Record<string, string[]> };
// null: no entry covers any folder of the chain, so any provider is allowed.
// `by`: the entries that decided (a folder key, or "default").
export type Allowed = { providers: string[]; by: string[] } | null;

export const EMPTY_RULE: RouteRule = { default: null, folders: {} };

// Why a model call is made, as the ledger names it, and the calls the rule
// decides before any request (an agent's model, a fallback, a successor's).
export type RoutePurpose = "turn" | "summary" | "side" | "reader" | "warm" | "sampling" | "title" | "judge" | "verifier" | "agent" | "fallback" | "successor";

// What happens instead when a call of that purpose would cross.
export const INSTEAD: Record<RoutePurpose, string> = {
  turn: "Switch the session to a model of an allowed provider",
  summary: "No summary is made on that model",
  side: "The answer is not given. Ask on a model of an allowed provider",
  reader: "An allowed reader reads instead, or nothing is read",
  warm: "The cache is not kept warm",
  sampling: "The server's request is refused",
  title: "An allowed small model writes the title, or the first prompt's words stay",
  judge: "An allowed judge model decides, or the call is held for the owner",
  verifier: "The verifier runs on an allowed model of the goal or the session",
  agent: "The agent is not started on that model",
  fallback: "The turn stays on its own model",
  successor: "The successor runs on an allowed model, or none starts",
};

const strip = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
// A folder as the rule compares it: `~` is the home folder, no trailing slash.
export const normFolder = (p: string, home: string): string => strip(p === "~" ? home : p.startsWith("~/") ? `${strip(home)}/${p.slice(2)}` : p);

const under = (folder: string, key: string) => folder === key || folder.startsWith(key === "/" ? "/" : `${key}/`);

// How a folder is spelled before it is compared: content-routes.ts resolves links, so a folder
// reached through a link and its real path are one folder. The pure rule takes the path as given.
export type Spell = (p: string) => string;
const same: Spell = (p) => p;

// The folder whose content a session holds. A session in a worktree of Keel's (its row: the main
// checkout's root and the worktree's path) works on that repository's content, so it is held to
// the repository's folder, at the same place under it; a session outside its worktree is its own.
export function originOf(workspace: string, wt: { repo_root: string; path: string } | null | undefined): string {
  if (!wt?.path || !wt.repo_root) return workspace;
  const path = strip(wt.path), ws = strip(workspace);
  if (!under(ws, path)) return workspace;
  return ws === path ? strip(wt.repo_root) : `${strip(wt.repo_root)}${ws.slice(path.length)}`;
}

// The entry that decides one folder: the deepest folder entry holding it, else the default.
export function folderEntry(rule: RouteRule, folder: string, home: string, spell: Spell = same): { providers: string[]; by: string } | null {
  const f = spell(normFolder(folder, home));
  let best: { key: string; n: string } | undefined;
  for (const key of Object.keys(rule.folders ?? {})) {
    const n = spell(normFolder(key, home));
    if (under(f, n) && (!best || n.length > best.n.length)) best = { key, n };
  }
  if (best) return { providers: rule.folders[best.key]!, by: best.key };
  return rule.default ? { providers: rule.default, by: "default" } : null;
}

// What every folder of a chain allows (the session's own, then each one above it).
export function allowedFor(rule: RouteRule, folders: readonly string[], home: string, spell: Spell = same): Allowed {
  let providers: string[] | null = null;
  const by: string[] = [];
  for (const f of folders) {
    const e = folderEntry(rule, f, home, spell);
    if (!e) continue;
    providers = providers ? providers.filter((p) => e.providers.includes(p)) : [...new Set(e.providers)];
    if (!by.includes(e.by)) by.push(e.by);
  }
  return providers ? { providers, by } : null;
}

export const allows = (a: Allowed, provider: string): boolean => !a || a.providers.includes(provider);

// The provider of a qualified model id (provider:model).
export const providerOf = (model: string): string => model.slice(0, Math.max(0, model.indexOf(":")));

// The candidates whose provider the rule allows, in their order.
export const allowedOnly = <T extends { provider: string }>(a: Allowed, list: readonly T[]): T[] => list.filter((m) => allows(a, m.provider));

// The first model of `ids` the rule allows (by its provider), else undefined.
export const firstAllowed = (a: Allowed, ids: readonly (string | null | undefined)[]): string | undefined =>
  ids.find((id): id is string => !!id && allows(a, providerOf(id)));

export type Crossing = { purpose: RoutePurpose; provider: string; model: string; by: string[]; allowed: string[] };

// What is said of a call that would cross, once per purpose and provider. The rule's entries come
// last: a turn's failure keeps the first 300 characters.
export function crossingText(c: Crossing): string {
  const allowed = c.allowed.length ? c.allowed.join(", ") : "none";
  return `${c.purpose} call to ${c.model} not sent: provider ${c.provider} is not allowed for this session's folder (allowed: ${allowed}). ${INSTEAD[c.purpose]}. Rule: ${c.by.join(", ")}.`;
}

// The owner's setting, checked before it is saved.
export function checkRule(v: any): string | undefined {
  const list = (x: unknown, what: string) => {
    if (!Array.isArray(x) || x.some((p) => typeof p !== "string" || !p.trim() || p.includes(":"))) return `${what} must be a list of provider ids`;
    return undefined;
  };
  if (v.default !== null && v.default !== undefined) {
    const bad = list(v.default, "default");
    if (bad) return bad;
  }
  if (!v.folders || typeof v.folders !== "object" || Array.isArray(v.folders)) return "folders must be an object of folder: providers";
  for (const [k, p] of Object.entries(v.folders)) {
    if (!(k.startsWith("/") || k === "~" || k.startsWith("~/"))) return `folder ${k} must be an absolute path or start with ~/`;
    const bad = list(p, `folder ${k}`);
    if (bad) return bad;
  }
  return undefined;
}
