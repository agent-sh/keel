// The landing queue's after step (land.after in .keel/checks.json) is held the way a hooks file is.
// It is the one step of a landing that runs outside Keel's own worktrees: in the checkout that has
// the base out, after the base moved, where a repository deploys or restarts what it ships. So it
// runs only while the owner's pin holds exactly its command and the content of every file under
// .keel/ it runs (src/integrations/hooks.ts coveredFiles: a script it names, the rest of a folder
// of .keel/ the script sits in). A new or changed one does not run: the entries still land and are
// pushed, and the outcome says the step was held and why. The pin also holds the rest of the land
// block the step comes after (where it pushes, its setup, its checks and their commands), so a
// landing that sends the push elsewhere holds the step too. It holds nothing else: what its
// commands read from the rest of the tree (scripts/, package.json) is not held, so a step that
// matters keeps its script under .keel/.
//
// What it is checked against is read where the step runs, at the moment it would run: the command
// as the base had it before the batch, the files as the landed commit has them. A landing that
// changes the script holds the step until the owner trusts the new one.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoOf, settingFor } from "../checks/ledger.ts";
import { FILE, overlay, parseChecks, readChecks, type Check } from "../checks/named.ts";
import { readLand, type LandRules } from "./rules.ts";
import type { Store } from "../core/store.ts";
import { contains, realOf } from "../core/paths.ts";
import { coveredFiles, linksOut, pinDigest, pinKey, projectRoot } from "../integrations/hooks.ts";

// A command longer than rules.ts takes is no step; the files' text is shown up to this.
export const AFTER_SHOWN_MAX = 100_000;

export type AfterStep = { command: string; root: string; covers: string[]; links: string[]; sha256: string };

// The land block the step comes after, as one text for the digest: where it pushes, its setup, and each check with
// the command it runs.
export function landText(rules: LandRules, named: readonly Check[]): string {
  const checks = (rules.checks ?? []).map((c) => { const n = named.find((x) => x.name === c.name); return [c.name, c.args, n ? [n.run, n.dir, n.args] : null]; });
  return JSON.stringify({ push: rules.push ?? null, setup: rules.setup ?? null, checks });
}

// The after step as it would run in `root`: its command and the files of .keel/ it runs, with the digest a pin holds.
export function afterStep(command: string, root: string, land: string): AfterStep {
  const groups = { land: [{ hooks: [{ type: "command" as const, command }] }] };
  const files = coveredFiles(root, groups as any);
  // A .keel/ that is a link out of the repository: the pin cannot hold what it points at.
  const keel = join(root, ".keel");
  const out = (() => { try { return lstatSync(keel).isSymbolicLink() && !contains(realOf(root), realOf(keel)) ? [keel] : []; } catch { return []; } })();
  const rel = (f: string) => f.slice(root.length + 1);
  return { command, root, covers: files.map(rel), links: [...out, ...linksOut(root, files)].map(rel), sha256: pinDigest(`land.after\u0000${command}\u0000${land}`, root, files) };
}

// The repository's land block as its checkout has it now: the owner's setting for it, else the file (as the queue
// reads it from the base: src/landing/queue.ts rulesOf).
export function landOf(root: string): { rules: LandRules; named: Check[] } {
  let text: string | undefined;
  try { text = readFileSync(join(root, FILE), "utf8"); } catch { text = undefined; }
  let raw: any;
  try { raw = text === undefined ? undefined : JSON.parse(text); } catch { raw = undefined; }
  const r = repoOf(root);
  const setting = r ? (settingFor(r.scope) as any) : undefined;
  const named = overlay(text === undefined ? undefined : parseChecks(text), setting === undefined ? undefined : readChecks(setting));
  return { rules: readLand(setting?.land ?? raw?.land), named: named?.checks ?? [] };
}

export type AfterView = { path: string; state: "none" | "new" | "changed" | "pinned" | "refused"; command?: string; sha256?: string; covers?: string[]; texts?: { path: string; text: string }[]; land?: { push?: string; setup?: string; checks: string[] }; problems: string[] };

export class AfterPins {
  constructor(private store: Store) {
    store.migrate("CREATE TABLE IF NOT EXISTS land_after_pins (root TEXT PRIMARY KEY, sha256 TEXT NOT NULL, created INTEGER NOT NULL);");
  }
  pinned(root: string): string | undefined {
    return this.store.db.query<{ sha256: string }, [string]>("SELECT sha256 FROM land_after_pins WHERE root = ?").get(pinKey(root))?.sha256;
  }
  // Why the step may not run in `where` (a folder of the repository `repo` at the commit it runs on), or nothing.
  // `land`: the land block the batch runs with (landText).
  held(repo: string, command: string, where: string, land: string): string | undefined {
    const s = afterStep(command, where, land);
    if (s.links.length) return `${s.links.join(", ")} ${s.links.length > 1 ? "are links" : "is a link"} out of .keel/: the pin cannot hold what ${s.links.length > 1 ? "they run" : "it runs"}`;
    const pin = this.pinned(repo);
    if (pin === s.sha256) return undefined;
    const what = s.covers.length ? `the after step and ${s.covers.join(", ")}` : "the after step";
    return pin ? `${what} changed since the owner trusted ${s.covers.length ? "them" : "it"}: the owner trusts the new version in the Trust panel` : `the owner has not trusted ${what} yet: the Trust panel shows ${s.covers.length ? "them" : "it"}`;
  }
  // The step as the owner reads it before trusting it: the command and each covered file whole.
  show(cwd: string): AfterView {
    const root = projectRoot(cwd);
    const path = join(root, FILE);
    const { rules, named } = landOf(root);
    const command = rules.after;
    if (!command) return { path, state: "none", problems: [] };
    const s = afterStep(command, root, landText(rules, named));
    const problems: string[] = [];
    if (s.links.length) problems.push(`${s.links.join(", ")} ${s.links.length > 1 ? "are links" : "is a link"} out of .keel/: the pin cannot hold what ${s.links.length > 1 ? "they run" : "it runs"}`);
    const texts = s.covers.map((p) => {
      let text = "";
      try { text = readFileSync(join(root, p), "utf8"); } catch { text = "(missing)"; }
      return { path: p, text };
    });
    if (texts.reduce((n, t) => n + t.text.length, command.length) > AFTER_SHOWN_MAX) problems.push(`the step and its files are longer than Keel shows whole (${AFTER_SHOWN_MAX} characters), so they cannot be trusted`);
    const pin = this.pinned(root);
    const state = problems.length ? "refused" : !pin ? "new" : pin === s.sha256 ? "pinned" : "changed";
    const land = { ...(rules.push ? { push: rules.push } : {}), ...(rules.setup ? { setup: rules.setup } : {}), checks: (rules.checks ?? []).map((c) => { const n = named.find((x) => x.name === c.name); return `${[c.name, ...c.args].join(" ")}${n ? `: ${[n.run, ...c.args].join(" ")}` : " (not a named check)"}`; }) };
    return { path, state, command, sha256: s.sha256, covers: s.covers, texts, land, problems };
  }
  pin(cwd: string, digest: string): string | null {
    const s = this.show(cwd);
    if (s.state === "none") return "this repository names no after step (land.after in .keel/checks.json)";
    if (s.state === "refused") return s.problems.join("; ");
    if (s.sha256 !== digest) return "the step is no longer the one that was shown: read it again";
    this.store.db.query("INSERT INTO land_after_pins (root, sha256, created) VALUES (?, ?, ?) ON CONFLICT(root) DO UPDATE SET sha256 = excluded.sha256, created = excluded.created").run(pinKey(projectRoot(cwd)), digest, Date.now());
    return null;
  }
}
