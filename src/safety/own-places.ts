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

// The words that name a folder as the reader's own, right before the path ("Scratch dir: PATH", "your scratch
// folder PATH", "Yours go in PATH"), or around it ("Use PATH for everything").
const BEFORE = /(?:\bscratch(?:\s+(?:dir|directory|folder|space|area))?|\byour\s+(?:own\s+)?(?:folder|directory|dir)|\byours\s+go\s+in)\s*(?:is\s+|at\s+|in\s+|under\s+)?[:=]?\s*$/i;
const USE = /\buse\s+$/i, FOR_ALL = /^\s+for\s+everything\b/i;
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
    const after = text.slice(end, end + 40), before = text.slice(Math.max(0, at - 60), at);
    if (/^[<$*{]/.test(after)) continue;
    // (Only within the sentence the path stands in.)
    const clause = before.split(/[.!?]\s|\n/).pop() ?? "";
    if (!BEFORE.test(clause) && !(USE.test(clause) && FOR_ALL.test(after))) continue;
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
  return TEMPS.some((t) => p.startsWith(`${t}/`) && p.length > t.length + 1);
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

// The git forms that discard a working tree's state, and what each loses: tracked changes, untracked files, or both.
function discards(sub: string, args: string[]): "tracked" | "untracked" | "both" | null {
  if (sub === "reset") return args.includes("--hard") ? "tracked" : null;
  if (sub === "checkout" || sub === "switch" || sub === "restore") return "tracked";
  if (sub === "clean") return "untracked";
  if (sub === "worktree" && args[0] === "remove") return "both";
  return null;
}
// Parts before a discard that change no working tree: what is counted now is what the discard meets.
const STILL = /^(fetch|log|status|rev-parse|rev-list|show|diff|merge-base|branch|tag|worktree|ls-files|describe|cat-file|for-each-ref|reflog|remote)$/;

export function settleOwn(a: { parts: Simple[]; risks: PartRisk[]; cwd: string; home: string; places: OwnPlace[]; look: Look }): Settled {
  if (!a.places.length || !a.risks.length || a.risks.some((r) => r.at === null || r.rule !== "destroys")) return null;
  const where = located(a.parts, a.cwd, a.home);
  const at = [...new Set(a.risks.map((r) => r.at!))].sort((x, y) => x - y);
  const said: string[] = [];
  for (const i of at) {
    const part = where[i];
    if (!part) return null;
    const g = gitCall(part.s.words, part.dir, a.home);
    const kind = g ? discards(g.sub, g.args) : null;
    if (!g || !g.dir || !kind) return null;
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
    const tracked = kind === "untracked" ? 0 : f.dirty();
    const untracked = kind === "tracked" ? 0 : f.untracked();
    if (tracked === null || untracked === null) return null;
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
    // Nothing to lose now; and nothing earlier in the line makes something to lose before it runs.
    const earlier = where.slice(0, i).every((p) => {
      if (isReadOnly(p.s) || p.s.words[0] === "cd" || p.s.heredoc) return true;
      const e = gitCall(p.s.words, p.dir, a.home);
      return !!e && STILL.test(e.sub) && !(e.sub === "branch" && e.args.some((x) => /^-[a-zA-Z]*[dDmM]/.test(x))) && !(e.sub === "worktree" && e.args[0] !== "list" && e.args[0] !== "prune");
    });
    if (!earlier) return null;
    said.push(`\`${text}\` runs in ${f.root} (${SAID[place.from]}), which has ${kind === "tracked" ? "no uncommitted tracked change" : kind === "untracked" ? "no untracked file" : "nothing uncommitted"} to lose`);
  }
  return { allow: `Keel's facts settle why the rules flagged it: ${said.join("; ")}.` };
}

// The shape of a call, for counting an owner's later allow of the same call: the tool and the command or input
// with what changes from one run to the next (hashes, numbers, ports, the session's own folders) folded.
export function shapeOf(tool: string, text: string, places: string[]): string {
  let t = text.slice(0, 4000);
  for (const p of [...places].sort((x, y) => y.length - x.length)) if (p.length > 1) t = t.split(p).join("<own>");
  t = t.replace(/\b[0-9a-f]{7,64}\b/g, "<hash>").replace(/\b\d+\b/g, "<n>").replace(/\s+/g, " ").trim();
  return new Bun.CryptoHasher("sha256").update(`${tool}\0${t}`).digest("hex").slice(0, 32);
}
