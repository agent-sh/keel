// The folders that are a session's own, each with how Keel knows it, and what
// Keel's own facts settle about a high-risk command inside them. Pure: the gate
// gathers the places and the repository facts.
//
// A place is the session's own when Keel can show where it came from: the
// session's folder, the worktree Keel made for it, the scratch folder Keel made
// for it, or a folder named as its own (a scratch folder) in words Keel stored
// from someone who may give it one: the task its parent session gave it, the
// messages that parent sent it since, and the owner's own messages. Text the
// agent wrote, read or fetched (a brief it opened, a tool's output) never adds
// a place.
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { contains } from "../core/paths.ts";
import { gitCall, located, type Look } from "./autonomy.ts";
import type { RiskRule } from "./risk-words.ts";
import { isReadOnly, type Simple } from "./shell.ts";

export type PlaceFrom = "folder" | "worktree" | "scratch" | "parent" | "owner";
export type OwnPlace = { path: string; from: PlaceFrom };

// How each kind of place is said to the judge.
const SAID: Record<PlaceFrom, string> = {
  folder: "the session's folder",
  worktree: "the git worktree Keel made for this session",
  scratch: "the scratch folder Keel made for this session",
  parent: "named as this session's own in the task or a message its parent session gave it",
  owner: "named as this session's own in the owner's message",
};

// The words that name a folder as the reader's own, right before the path: "Scratch dir PATH", "scratch folder:
// PATH", "Your scratch folder: PATH", "your own directory is PATH". Nothing looser ("from scratch", "use PATH").
const BEFORE = /(?:\bscratch\s+(?:dir|directory|folder)|\byour\s+(?:own\s+)?(?:scratch\s+|work\s+)?(?:folder|directory|dir))\s*(?:is\s+|at\s+|in\s+|under\s+)?[:=]?\s*$/i;
// A sentence that says no, or names something else as the place: the path in it is not given.
const NEGATED = /\b(?:not|never|no|don't|dont|doesn't|avoid|instead|except|other than|rather than|without|nor)\b|n't\b/i;
// A path in running text: absolute, or from the home folder.
const PATH = /(?<![\w./~$-])((?:~|\$HOME|\$\{HOME\})(?:\/[^\s`'"(),;<>|*?{}\[\]]*)?|\/[^\s`'"(),;<>|*?{}\[\]]+)/g;
// Folders of the home that hold the owner's keys, settings and programs: never anyone's scratch.
const HOME_KEPT = /^\.(ssh|gnupg|config|local|aws|azure|kube|docker|password-store|mozilla|pki|cargo|rustup|npm|bun|nvm)(\/|$)/;
const TEMPS = ["/tmp", "/var/tmp", "/dev/shm"];

// The folders a text names as the reader's own. A path that stops at a placeholder or an expansion
// (`lanes-work/<TASK-ID>/`, `$S/x`) names no folder; the home, what holds it, a folder of the owner's own keys
// and settings, and a folder high in the tree are never one.
export function namedPlaces(text: string, home: string): string[] {
  const out = new Set<string>();
  for (const m of text.slice(0, 200_000).matchAll(PATH)) {
    const raw = m[1]!, at = m.index!, end = at + raw.length;
    const after = text.slice(end, end + 200), before = text.slice(Math.max(0, at - 200), at);
    if (/^[<$*{]/.test(after)) continue;
    // (Only within the sentence the path stands in, and only a sentence that does not say no.)
    const clause = before.split(/[.!?;]\s|\n/).pop() ?? "";
    const rest = after.split(/[.!?;,(]|\s-\s|\n/)[0] ?? "";
    if (!BEFORE.test(clause) || NEGATED.test(clause) || NEGATED.test(rest)) continue;
    const word = raw.replace(/[.,:;]+$/, "").replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
    if (!isAbsolute(word)) continue;
    const p = resolve(word);
    if (!fitsAsPlace(p, home)) continue;
    out.add(p);
  }
  return [...out].slice(0, 16);
}

// Whether a folder can be anyone's scratch: two levels or more below the home (outside the folders of the
// owner's keys and settings), or a folder of its own under a temporary folder.
export function fitsAsPlace(p: string, home: string): boolean {
  if (contains(p, home)) return false;
  if (contains(home, p)) {
    const rel = p.slice(home.length + 1);
    return rel.split("/").filter(Boolean).length >= 2 && !HOME_KEPT.test(rel);
  }
  // (The machine's own temporary folder too, read when asked: TMPDIR can name one anywhere.)
  return [...TEMPS, tmpdir()].some((t) => p.startsWith(`${t}/`) && p.length > t.length + 1);
}

// The place a path is in, the most specific first (a scratch folder inside the session's folder is still its folder).
export function placeOf(p: string, places: OwnPlace[]): OwnPlace | null {
  let best: OwnPlace | null = null;
  for (const x of places) if (contains(x.path, p) && (!best || x.path.length > best.path.length)) best = x;
  return best;
}

// The places as the judge reads them.
export function ownFacts(places: OwnPlace[]): string {
  if (!places.length) return "";
  const lines = places.map((x) => `- ${x.path}: ${SAID[x.from]}`);
  return `Folders that are this session's own, from Keel's records (nothing the agent wrote, read or fetched adds to this list):\n${lines.join("\n")}`;
}

// One reason the rules flagged a part of a command, with the part it stands for (null: the line as a whole).
export type PartRisk = { at: number | null; rule: RiskRule; why: string };

// What Keel's facts settle about a high-risk command: `allow` when every reason it is high risk is a discard of
// git work inside the session's own places with nothing there to lose; `deny` when such a discard would lose
// uncommitted work, which nothing brings back; null when the judge decides.
export type Settled = { allow: string } | { deny: string; lost: number } | null;

// The git forms that discard a working tree's state that Keel's facts can count, and what each discards for certain.
// A clean that also takes ignored files (-x, -X) deletes what no count here shows (.env, data, an ignored nested
// repository): never settled. A hard reset or a checkout to another commit can also overwrite an untracked file the
// target tracks: those are left to the judge when there is one.
type Discard = { sub: string; certain: "tracked" | "untracked" | "both"; target?: string };
function discardOf(sub: string, args: string[]): Discard | null | "never" {
  const named = args.filter((x) => !x.startsWith("-"));
  if (sub === "reset") return args.includes("--hard") ? { sub, certain: "tracked", target: named[0] } : null;
  if (sub === "checkout" || sub === "switch" || sub === "restore") {
    const dd = args.indexOf("--");
    const source = sub === "restore" ? args.find((x, k) => /^(-s|--source)$/.test(args[k - 1] ?? "") || x.startsWith("--source=")) : dd > 0 ? args.slice(0, dd).find((x) => !x.startsWith("-")) : named.length >= 2 ? named[0] : undefined;
    return { sub, certain: "tracked", ...(source ? { target: source.replace(/^--source=/, "") } : {}) };
  }
  if (sub === "clean") return args.some((x) => x === "--ignored" || (/^-[a-zA-Z]+$/.test(x) && /[xX]/.test(x))) ? "never" : { sub, certain: "untracked" };
  if (sub === "worktree" && args[0] === "remove") return { sub, certain: "both" };
  return null;
}
// Parts before a discard that change no working tree: what is counted now is what the discard meets.
const STILL = /^(fetch|log|status|rev-parse|rev-list|show|diff|merge-base|branch|tag|worktree|ls-files|describe|cat-file|for-each-ref|reflog|remote)$/;

// `look` reads the repository now (repofacts.readRepo): a count kept from an earlier look is not what the discard meets.
export function settleOwn(a: { parts: Simple[]; risks: PartRisk[]; cwd: string; home: string; places: OwnPlace[]; look: Look }): Settled {
  if (!a.places.length || !a.risks.length || a.risks.some((r) => r.at === null || r.rule !== "destroys")) return null;
  // A GIT_ variable anywhere on the line can point git at another repository than the folder's.
  if (a.parts.some((p) => p.words.some((w) => /^GIT_/.test(w)))) return null;
  const where = located(a.parts, a.cwd, a.home);
  const at = [...new Set(a.risks.map((r) => r.at!))].sort((x, y) => x - y);
  const said: string[] = [];
  for (const i of at) {
    const part = where[i];
    if (!part) return null;
    const g = gitCall(part.s.words, part.dir, a.home);
    const d = g ? discardOf(g.sub, g.args) : null;
    if (!g || !g.dir || !d || d === "never") return null;
    let repo = g.dir;
    if (g.sub === "worktree") {
      const named = g.args.slice(1).find((x) => !x.startsWith("-"));
      if (!named || /[$`*?~]/.test(named)) return null;
      repo = isAbsolute(named) ? resolve(named) : resolve(g.dir, named);
    }
    const place = placeOf(repo, a.places);
    if (!place) return null;
    const f = a.look(repo);
    if (!f) return null;
    const tracked = d.certain === "untracked" ? 0 : f.dirty();
    const untracked = d.certain === "tracked" ? 0 : f.untracked();
    if (tracked === null || untracked === null) return null;
    // Changes git was told not to look at: no count shows them, and a reset or a checkout takes them.
    const hidden = f.hidden?.() ?? null;
    if (hidden === null || hidden > 0) return null;
    const text = part.s.text.slice(0, 120);
    // A checkout or restore of some paths meets only the changes under them: the repository's count says nothing
    // lost when it is 0, and is not what is lost when it is more (the judge reads it then).
    const whole = !(g.sub === "checkout" || g.sub === "restore") || g.args.some((x) => x === "." || x === ":/" || x === "./" || /^(-f|--force|--discard-changes)$/.test(x));
    if (tracked + untracked > 0 && !whole) return null;
    if (tracked + untracked > 0) {
      const what = [tracked ? `${tracked} uncommitted tracked change${tracked === 1 ? "" : "s"}` : "", untracked ? `${untracked} untracked file${untracked === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
      return {
        lost: tracked + untracked,
        deny: `Refused by Keel's rules: \`${text}\` would discard ${what} in ${f.root}, which nothing brings back. This is not a judgment of your task: save them first (commit them, or write a patch with git diff), in a call of its own, then run it again. The counts are read before the command runs, so a commit earlier in the same line does not count. The owner can let one retry through.`,
      };
    }
    // What the counts do not show is left to the judge: an untracked file a target may overwrite, commits a hard
    // reset leaves behind, a removed worktree's commits that no ref holds.
    if (d.target !== undefined && (f.untracked() ?? 1) > 0) return null;
    if (g.sub === "reset" && d.target !== undefined && f.ahead?.(d.target) !== 0) return null;
    if (g.sub === "worktree" && f.headOnRef?.() !== true) return null;
    // Nothing to lose now; and nothing earlier in the line makes something to lose before it runs.
    const earlier = where.slice(0, i).every((p) => {
      if (isReadOnly(p.s) || p.s.words[0] === "cd" || p.s.heredoc) return true;
      const e = gitCall(p.s.words, p.dir, a.home);
      return !!e && STILL.test(e.sub) && !(e.sub === "branch" && e.args.some((x) => /^-[a-zA-Z]*[dDmMfF]/.test(x))) && !(e.sub === "worktree" && e.args[0] !== "list" && e.args[0] !== "prune");
    });
    if (!earlier) return null;
    said.push(`\`${text}\` runs in ${f.root} (${SAID[place.from]}), which has ${d.certain === "tracked" ? "no uncommitted tracked change" : d.certain === "untracked" ? "no untracked file" : "nothing uncommitted and its commit on a branch"} to lose${g.sub === "reset" && d.target !== undefined ? `, and no commit of its own that ${d.target} lacks` : ""}`);
  }
  return { allow: `Keel's facts settle why the rules flagged it: ${said.join("; ")}.` };
}

// The shape of a call, for counting an owner's later allow of the same call in the same session: the tool and the
// command or input with what changes from one run to the next (hashes, numbers, ports, spacing) folded.
export function shapeOf(tool: string, text: string): string {
  const t = text.slice(0, 4000).replace(/\b[0-9a-f]{7,64}\b/g, "<hash>").replace(/\b\d+\b/g, "<n>").replace(/\s+/g, " ").trim();
  return new Bun.CryptoHasher("sha256").update(`${tool}\0${t}`).digest("hex").slice(0, 32);
}
