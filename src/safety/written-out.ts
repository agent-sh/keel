// A push or a gh write whose place or text the rules cannot read because the line spells it with a variable or a
// substitution: the folder it runs in (`cd "$D"`, `git -C $D`), the remote (`git push $R`), what it sends
// (`git push origin $H:main`), the repository (`gh -R $X`), the address (`gh api repos/$X/...`). The rules place a
// write by the words of the line and place nothing by such a word, so the call would ask the owner whatever the line
// does, and the card could offer no standing answer. The model that wrote the line knows the value: the gate sends
// the line back once to be written out (gate.ts), and the line that comes back is judged exactly, as any other.
// Nothing here widens what runs: a refusal stands in the place of a card.
//
// Pure: the words of the line in, the words it could not read out.
import { laid } from "./risk.ts";
import { name as baseName } from "./risk-words.ts";
import { splitCommand, type Simple } from "./shell.ts";

export type Unwritten = { word: string; what: "folder" | "remote" | "source" | "repository" | "address" };

// git's own options that take the next word (accounts.ts gitWrites reads the same ones).
const GIT_VALUED = new Set(["-c", "--work-tree", "--namespace", "--exec-path"]);
// git push's options that take the next word.
const PUSH_VALUED = new Set(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);
const GH_REPO = new Set(["-R", "--repo"]);
// gh api's options that take the next word (public-send.ts reads the same ones).
const API_VALUED = new Set(["--hostname", "-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field", "--input", "-q", "--jq", "-t", "--template", "--cache", "-p", "--preview"]);

// Whether the word at `k` of a part's command is made by an expansion ($x, "$x", $(...), `...`).
const made = (part: Simple, at: number, k: number) => !!part.dyn?.includes(at + k);

// The operand of the `cd` that left the folder of part `i` unknown, when it is one an expansion made.
function lostBy(parts: Simple[], runs: { words: string[]; at: number }[], i: number): string | undefined {
  for (let j = i - 1; j >= 0; j--) {
    const part = parts[j]!, w = runs[j]!.words;
    if (part.heredoc || (w[0] !== "cd" && w[0] !== "pushd")) continue;
    const k = w.findIndex((a, n) => n > 0 && !a.startsWith("-"));
    if (k < 0) return undefined;
    if (made(part, runs[j]!.at, k)) return w[k];
    // (A written-out folder from the root or the home: what came before it no longer counts.)
    if (/^(\/|~(\/|$))/.test(w[k]!)) return undefined;
  }
  return undefined;
}

export function unwritten(command: string, cwd: string, home: string): Unwritten[] {
  if (!/\b(push|gh)\b/.test(command) || !/[$`]/.test(command)) return [];
  const parts = splitCommand(command);
  if (!parts) return [];
  const pre = laid(parts, cwd, home);
  const out: Unwritten[] = [];
  const seen = new Set<string>();
  const add = (word: string | undefined, what: Unwritten["what"]) => {
    if (word === undefined || seen.has(`${what}\0${word}`)) return;
    seen.add(`${what}\0${word}`);
    out.push({ word: word.length > 80 ? `${word.slice(0, 80)}...` : word, what });
  };
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!, run = pre.runs[i]!, w = run.words;
    if (part.heredoc) continue;
    const prog = baseName(w[0]);
    if (prog === "git") {
      let k = 1;
      const folders: string[] = [];
      for (; k < w.length && w[k]!.startsWith("-"); k++) {
        const o = w[k]!;
        if (o === "-C" || o === "--git-dir") { k++; if (w[k] !== undefined && made(part, run.at, k)) folders.push(w[k]!); }
        else if (o.startsWith("--git-dir=")) { if (made(part, run.at, k)) folders.push(o.slice(10)); }
        else if (GIT_VALUED.has(o)) k++;
      }
      if (w[k] !== "push") continue;
      for (const f of folders) add(f, "folder");
      if (pre.dirs[i] === null && !folders.length) add(lostBy(parts, pre.runs, i), "folder");
      let first = true;
      for (let n = k + 1; n < w.length; n++) {
        const a = w[n]!;
        if (a === "--") continue;
        if (PUSH_VALUED.has(a)) { n++; continue; }
        if (a.startsWith("-")) continue;
        if (made(part, run.at, n)) add(a, first ? "remote" : "source");
        first = false;
      }
    } else if (prog === "gh") {
      const api = w[1] === "api";
      let address = false;
      for (let n = 1; n < w.length; n++) {
        const a = w[n]!;
        if (GH_REPO.has(a)) { n++; if (w[n] !== undefined && made(part, run.at, n)) add(w[n], "repository"); continue; }
        if (a.startsWith("--repo=")) { if (made(part, run.at, n)) add(a.slice(7), "repository"); continue; }
        if (api && API_VALUED.has(a)) { n++; continue; }
        if (a.startsWith("-")) continue;
        // (gh api's first plain word after `api` is the address it calls.)
        if (api && n > 1 && !address) { address = true; if (made(part, run.at, n)) add(a, "address"); }
      }
      if (pre.dirs[i] === null) add(lostBy(parts, pre.runs, i), "folder");
    }
  }
  return out;
}

const WHAT: Record<Unwritten["what"], string> = { folder: "the folder", remote: "the remote", source: "what it pushes", repository: "the repository", address: "the address" };

// What the model is told: which words, what to send instead, and that the same line again goes on as it is.
export function writeOutRefusal(u: Unwritten[]): string {
  const said = u.slice(0, 4).map((x) => `${WHAT[x.what]} (${x.word})`).join(", ");
  return `Refused before it ran: where a push or a gh write goes, and what it sends, is read from the words of the line, and this line spells ${said} with a variable or a substitution. Nothing was run. `
    + "Send it again with that written out: the folder as a path, the remote by its name or address, the commit or branch by its hash or name. A line that can be read is judged for what it does and is not held for this. "
    + "A value you do not know before the line runs: get it in a call of its own first. The same line sent again as it is is judged as it is, and the owner is asked.";
}
