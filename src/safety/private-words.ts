// Private words in text bound for a public place under the owner's name. Pure: the gate learns what is private
// (public-send.ts) and hands the words in, with the text to read.
//
// What counts as private:
//   quote    a whole sentence the owner typed in the session (eight words or more, as the same words in a row)
//   host     a name of the owner's machines or ssh hosts, a word of his list (Settings: private words)
//   project  the name of a folder he works in whose repository is not public (decided by the caller)
//   path     his home folder, as a path
//   secret   a token of a known shape, a value assigned to a credential's name, a value the vault holds
//
// A word is found as itself, never as part of a longer word: `buildbox` is in `buildbox.lan` and not in `buildboxes`.
// A short word (four characters or fewer) or a common one is not found inside a longer name written with - _ or .
// (`pico` is not in `model-pico-large`). A host term in the model position of `provider:model` is not a hit either.
// No word is found where a URL names its owner (`github.com/<owner>/`): that name is public by being there.

import { detect } from "./secrets.ts";

export type Kind = "quote" | "host" | "project" | "path" | "secret";
// `terms`: words found in any case, as whole words. `projects`: the same, but each hit is judged by the caller
// (a project's repository may be public). `homes`: folders written as paths. `sentences`: the owner's, raw.
export type Words = {
  terms: readonly string[];
  projects: readonly string[];
  homes: readonly string[];
  sentences: readonly string[];
  holds?: (text: string) => boolean;
  // Whether a word is one of ordinary text (the dictionary's): such a word is read with the strict edge of a short one.
  common?: (word: string) => boolean;
};
// `past`: the words found run past the line quoted (a sentence that wraps), so `text` does not show all of them.
export type Finding = { kind: Kind; word: string; where: string; line: number; text: string; past?: true; known?: (line: string) => Promise<boolean> };
// One piece of text with its place: its lines are numbered from `first`. `known` (a list of names) says whether the place
// the text goes to already has one of its lines.
export type Unit = { where: string; first: number; text: string; known?: (line: string) => Promise<boolean> };

export const QUOTE_WORDS = 8;
const LINE_SHOWN = 160;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const WORD = /[\p{L}\p{N}]+/gu;
const edge = (list: readonly string[]) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...new Set(list)].sort((a, b) => b.length - a.length).map(escape).join("|")})(?![\\p{L}\\p{N}])`, "giu");

const IN_NAME = /[\p{L}\p{N}]/u;
// A match that is a piece of a longer name: `-`, `_` or `.` joins it to more letters or digits on either side.
function inLongerName(text: string, at: number, len: number): boolean {
  const before = text[at - 1], after = text[at + len];
  if (before && "-_.".includes(before) && text[at - 2] && IN_NAME.test(text[at - 2]!)) return true;
  return !!after && "-_.".includes(after) && !!text[at + len + 1] && IN_NAME.test(text[at + len + 1]!);
}

const PROVIDER_CHAR = /[\p{L}\p{N}_.-]/u;
const ID_EDGE = /[\s"'`<>()\[\]{},;|&]/;
const COPY_COMMAND = /(?:^|[\s/;|&"'`])(?:scp|rsync)[ \t]/;
// Only a standalone model ID, not host:path, user@host:path or a piece of a URL or path.
// A bare copy operand can look identical to a model ID: keep the hit on copy
// command lines or when the line continues a command above it.
function modelPart(text: string, at: number, len: number): boolean {
  if (at < 2 || text[at - 1] !== ":" || !IN_NAME.test(text[at - 2]!) || !IN_NAME.test(text[at]!)) return false;
  const after = text[at + len];
  if (after && !ID_EDGE.test(after)) return false;
  let start = at - 2;
  while (start > 0 && PROVIDER_CHAR.test(text[start - 1]!)) start--;
  return IN_NAME.test(text[start]!) && (start === 0 || text[start - 1] === "=" || ID_EDGE.test(text[start - 1]!));
}
// A match in the owner's place of an address: `github.com/<here>/`.
function urlOwner(text: string, at: number, len: number): boolean {
  const after = text[at + len];
  if (after !== undefined && after !== "/" && /[\w-]/.test(after)) return false;
  return /[a-z0-9-]+(?:\.[a-z0-9-]+)+\/$/i.test(text.slice(Math.max(0, at - 80), at));
}

// The words of a text, lower case, with where each starts.
function wordsOf(text: string): { w: string[]; at: number[] } {
  const w: string[] = [], at: number[] = [];
  for (const m of text.matchAll(WORD)) { w.push(m[0].toLowerCase()); at.push(m.index); }
  return { w, at };
}

// The owner's sentences, those long enough to be his and not a common phrase.
export function sentencesOf(messages: readonly string[]): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const m of messages) {
    for (const s of m.split(/(?<=[.!?])\s+|\n+/)) {
      const n = wordsOf(s).w;
      if (n.length < QUOTE_WORDS) continue;
      const key = n.join(" ");
      if (!seen.has(key)) { seen.add(key); out.push(s.trim()); }
    }
  }
  return out;
}

const KEY_LEN = 5;
function indexOf(sentences: readonly string[]): Map<string, string[][]> {
  const idx = new Map<string, string[][]>();
  for (const s of sentences) {
    const w = wordsOf(s).w;
    if (w.length < QUOTE_WORDS) continue;
    const k = w.slice(0, KEY_LEN).join(" ");
    const l = idx.get(k);
    if (l) l.push(w); else idx.set(k, [w]);
  }
  return idx;
}

export type Matcher = (units: readonly Unit[]) => Finding[];

// What a text is read for. Built once for a set of words.
export function matcher(words: Words): Matcher {
  const termRe = words.terms.length ? edge(words.terms) : null;
  const projRe = words.projects.length ? edge(words.projects) : null;
  const homes = [...new Set(words.homes.map((h) => h.replace(/\/+$/, "")).filter((h) => h.length > 1))];
  const homeRe = homes.length ? new RegExp(`(?<![\\w.-])(?:${homes.map(escape).join("|")})(?![\\w-])`, "g") : null;
  const idx = indexOf(words.sentences);
  const strict = new Set([...words.terms, ...words.projects].filter((t) => t.length <= 4 || words.common?.(t)).map((t) => t.toLowerCase()));
  const fits = (text: string, m: RegExpMatchArray) => !urlOwner(text, m.index!, m[0].length) && !(strict.has(m[0].toLowerCase()) && inLongerName(text, m.index!, m[0].length));

  return (units) => {
    const out: Finding[] = [];
    const seen = new Map<string, Finding>();
    for (const u of units) {
      const text = u.text;
      if (!text.trim()) continue;
      // Where each line starts, to name the line of an offset.
      const starts: number[] = [0];
      for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
      const lineOf = (off: number) => {
        let lo = 0, hi = starts.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= off) lo = mid; else hi = mid - 1; }
        return lo;
      };
      const add = (kind: Kind, word: string, off: number, mask?: [number, number], shown?: string, end = off) => {
        const n = lineOf(off);
        const past = lineOf(end) !== n;
        const from = starts[n]!, to = n + 1 < starts.length ? starts[n + 1]! - 1 : text.length;
        let line = shown ?? text.slice(from, to);
        if (mask && shown === undefined) line = line.slice(0, Math.max(0, mask[0] - from)) + "[hidden]" + line.slice(Math.max(0, mask[1] - from));
        line = line.trim();
        if (line.length > LINE_SHOWN) line = `${line.slice(0, LINE_SHOWN)}...`;
        const key = `${kind}\0${word}\0${u.where}\0${u.first + n}`;
        // (One finding a line for a word. Two sentences that open alike on one line are one finding: past, when either is.)
        const had = seen.get(key);
        if (had) { if (past) had.past = true; return; }
        const found: Finding = { kind, word, where: u.where, line: u.first + n, text: line, ...(past ? { past } : {}) };
        seen.set(key, found);
        out.push(found);
      };
      let copyLine = -1, copying = false;
      if (termRe) for (const m of text.matchAll(termRe)) {
        if (!fits(text, m)) continue;
        if (strict.has(m[0].toLowerCase()) && modelPart(text, m.index, m[0].length)) {
          const n = lineOf(m.index);
          if (n !== copyLine) {
            copyLine = n;
            const start = starts[n]!;
            copying = /\\\r?\n$/.test(text.slice(Math.max(0, start - 3), start)) || COPY_COMMAND.test(text.slice(start, starts[n + 1]));
          }
          if (!copying) continue;
        }
        add("host", m[0], m.index);
      }
      if (projRe) for (const m of text.matchAll(projRe)) if (fits(text, m)) add("project", m[0], m.index);
      if (homeRe) for (const m of text.matchAll(homeRe)) add("path", m[0], m.index);
      if (idx.size) {
        const { w, at } = wordsOf(text);
        for (let i = 0; i + KEY_LEN <= w.length; i++) {
          const cands = idx.get(w.slice(i, i + KEY_LEN).join(" "));
          if (!cands) continue;
          for (const c of cands) {
            if (i + c.length > w.length) continue;
            let same = true;
            for (let k = KEY_LEN; k < c.length; k++) if (w[i + k] !== c[k]) { same = false; break; }
            if (same) add("quote", `${c.slice(0, 6).join(" ")} ...`, at[i]!, undefined, undefined, at[i + c.length - 1]!);
          }
        }
      }
      for (const h of detect(text)) add("secret", h.kind, h.start, [h.start, h.end]);
      if (words.holds?.(text)) add("secret", "a value the vault holds", 0, undefined, "(the line is not shown)");
    }
    return out;
  };
}

const SAYS: Record<Kind, string> = {
  quote: "your own words from this session",
  host: "a private host name or word",
  project: "a private project name",
  path: "a personal path",
  secret: "a secret",
};

// How many findings a card or a refusal quotes.
export const SHOWN = 6;
// The findings, said with the place and the line of each (at most `shown`).
export function say(found: readonly Finding[], shown = SHOWN): string {
  const lines = found.slice(0, shown).map((f) => `${f.where}:${f.line}: ${SAYS[f.kind]} (${f.word}): ${f.text}`);
  if (found.length > shown) lines.push(`and ${found.length - shown} more`);
  return lines.join("\n");
}
