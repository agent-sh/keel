// Sections of an instruction text, for telling what a chain of files already carries (pure).
//
// A section is a run of lines with no blank line in it, and a heading line is always one of its own,
// whether or not a blank line follows it: the block a rule is written as. A fenced code block is one
// section with what is around it, whatever its blank lines, so a dropped section never leaves a fence
// open. Two sections are the same when their text is, line ends and trailing spaces aside (norm), and
// so are the headings above them in their file, each level's nearest (`scoped`): the same words under
// "Codex only" and under "Claude Code only" are two rules, so are the same words under "# Codex only /
// ## Tests" and "# Claude Code only / ## Tests", and a file that says a rule again under its own
// heading may mean it for its own part. The chain's own `# /path` lines are no file's heading.
//
// What a later file says again is left out of it where it stands, with one line that says where the
// text is and under which heading (Carried.fresh). A heading is left out only when every section under
// it, to the next heading of its level or above, is: a new rule keeps its headings. A run of sections
// shorter than the line that would replace it is kept: leaving it out would cost more than it saves.

export const norm = (t: string): string => t.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();

// `key`: the section's own text; `under`: the headings above it in its file, outermost first, one a
// line ("" for none); `near`: the nearest of them; `scoped`: under and key together, what tells a
// carried section; `level`: a heading's number of #s, else 0.
export type Section = { start: number; end: number; key: string; heading: boolean; under: string; near: string; scoped: string; level: number };
const HEADING = /^ {0,3}(#{1,6})(\s|$)/;
const CHAIN = /^# \//;
const FENCE = /^ {0,3}(```|~~~)/;

export function sectionsOf(text: string): Section[] {
  const out: Section[] = [];
  let at = 0, start = -1, end = -1, heads = false, fence: string | null = null;
  let stack: { level: number; text: string }[] = [];
  const close = () => {
    if (start < 0) return;
    const key = norm(text.slice(start, end));
    if (heads) {
      const level = HEADING.exec(key)![1]!.length;
      out.push({ start, end, key, heading: true, under: "", near: "", scoped: key, level });
      if (CHAIN.test(key)) stack = [];
      else { stack = stack.filter((h) => h.level < level); stack.push({ level, text: key }); }
    } else {
      const under = stack.map((h) => h.text).join("\n");
      out.push({ start, end, key, heading: false, under, near: stack.at(-1)?.text ?? "", scoped: `${under}\n${key}`, level: 0 });
    }
    start = -1;
  };
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const lineEnd = at + line.length;
    const f = FENCE.exec(line)?.[1];
    if (fence) {
      if (f === fence) fence = null;
      end = lineEnd;
    } else if (!line.trim()) {
      close();
    } else if (HEADING.test(line)) {
      close();
      start = at; end = lineEnd; heads = true;
      close();
    } else {
      if (start < 0) { start = at; heads = false; }
      if (f) fence = f;
      end = lineEnd;
    }
    at += raw.length + 1;
  }
  close();
  return out;
}

// Where a line of a text is on disk (turn.ts expandMapped): each line of the text starts at `at`.
export type LineSource = { at: number; path: string; line: number };

export const linesOf = (text: string, path: string): LineSource[] => {
  const out: LineSource[] = [];
  let at = 0;
  text.split("\n").forEach((l, i) => { out.push({ at, path, line: i + 1 }); at += l.length + 1; });
  return out;
};

// The sections a chain carries, each with the file it came from.
export class Carried {
  private from = new Map<string, string>();
  has(key: string): boolean { return this.from.has(key); }
  add(text: string, path: string) { this.fresh(path, text, linesOf(text, path), { record: false }).commit(); }

  // A file's text without the sections the chain already carries, with its line map moved to match;
  // its new sections are carried from then on, unless `record` is false: the caller cuts the text and
  // calls `commit` with where the cut is, so what the cut left out is carried by no file. A section is
  // carried with the headings it has in the file as read, not in what is left of it.
  // `path`: the file, `lines`: where each line is on disk.
  fresh(path: string, text: string, lines: LineSource[] = linesOf(text, path), o: { record?: boolean } = {}): { text: string; lines: LineSource[]; left: number; commit: (upTo?: number) => void } {
    const secs = sectionsOf(text);
    const drop = secs.map((s) => !s.heading && this.from.has(s.scoped));
    // A heading goes when every section under it does, to the next heading of its level or above (its
    // own sub-headings' sections included); one with nothing under it stays.
    for (let i = 0; i < secs.length; i++) {
      if (!secs[i]!.heading) continue;
      let body = 0, gone = 0;
      for (let j = i + 1; j < secs.length && !(secs[j]!.heading && secs[j]!.level <= secs[i]!.level); j++) {
        if (secs[j]!.heading) continue;
        body++;
        if (drop[j]) gone++;
      }
      drop[i] = body > 0 && gone === body;
    }
    // Runs of dropped sections, each replaced by one line, unless the line is longer than the run.
    type Run = { a: number; b: number; note: string };
    const runs: Run[] = [];
    for (let i = 0; i < secs.length; i++) {
      if (!drop[i]) continue;
      let j = i;
      while (j + 1 < secs.length && drop[j + 1]) j++;
      const body = secs.slice(i, j + 1).filter((s) => !s.heading);
      const where = [...new Set(body.map((s) => this.from.get(s.scoped)!))];
      const heads = [...new Set(body.map((s) => s.near).filter(Boolean))];
      // (Counted without the headings that go with them.)
      const n = Math.max(1, body.length);
      const under = heads.length ? ` under ${heads.slice(0, 2).map((h) => `"${h}"`).join(", ")}${heads.length > 2 ? ` and ${heads.length - 2} more headings` : ""}` : "";
      const note = `(Left out here: ${n === 1 ? "a section" : `${n} sections`}${under} the same as in ${where.slice(0, 3).join(", ")}${where.length > 3 ? ` and ${where.length - 3} more` : ""}, above.)`;
      if (secs[j]!.end - secs[i]!.start > note.length) runs.push({ a: secs[i]!.start, b: secs[j]!.end, note });
      else for (let k = i; k <= j; k++) drop[k] = false;
      i = j;
    }
    // Where each kept section is in the text given back, for commit.
    const sourceAt = (at: number) => lines.findLast((x) => x.at <= at)?.path ?? path;
    const commitOf = (shift: (at: number) => number) => (upTo = Infinity) => {
      secs.forEach((x, i) => {
        if (x.heading || drop[i] || shift(x.end) > upTo || this.from.has(x.scoped)) return;
        this.from.set(x.scoped, sourceAt(x.start));
      });
    };
    if (!runs.length) {
      const commit = commitOf((at) => at);
      if (o.record !== false) commit();
      return { text, lines, left: 0, commit };
    }
    let out = "", from = 0, left = 0;
    const moved: LineSource[] = [];
    const keep = (a: number, b: number) => {
      for (const x of lines) if (x.at >= a && x.at < b) moved.push({ ...x, at: x.at - a + out.length });
      out += text.slice(a, b);
    };
    for (const r of runs) {
      keep(from, r.a);
      out += r.note;
      from = r.b;
      left++;
    }
    keep(from, text.length);
    const shift = (at: number) => at + runs.filter((r) => r.b <= at).reduce((n, r) => n + r.note.length - (r.b - r.a), 0);
    const commit = commitOf(shift);
    if (o.record !== false) commit();
    return { text: out, lines: moved, left, commit };
  }
}
