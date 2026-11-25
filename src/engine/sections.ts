// Sections of an instruction text, for telling what a chain of files already carries (pure).
//
// A section is a run of lines with no blank line in it, and a heading line starts one of its own:
// the block a rule is written as. A fenced code block is one section with what is around it, whatever
// its blank lines, so a dropped section never leaves a fence open. Two sections are the same when their
// text is, line ends and trailing spaces aside (norm).
//
// What a later file says again is left out of it where it stands, with one line that says where the
// text is (Carried.fresh). A heading alone goes with the section under it: it is left out only when that
// section is, so a new rule keeps its heading. A run of sections shorter than the line that would
// replace it is kept: leaving it out would cost more than it saves.

export const norm = (t: string): string => t.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();

export type Section = { start: number; end: number; key: string; heading: boolean };
const HEADING = /^ {0,3}#{1,6}(\s|$)/;
const FENCE = /^ {0,3}(```|~~~)/;

export function sectionsOf(text: string): Section[] {
  const out: Section[] = [];
  let at = 0, start = -1, end = -1, heads = true, fence: string | null = null;
  const close = () => {
    if (start < 0) return;
    out.push({ start, end, key: norm(text.slice(start, end)), heading: heads });
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
    } else {
      const head = HEADING.test(line);
      if (head || start < 0) { close(); start = at; heads = true; }
      if (!head) heads = false;
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
  add(text: string, path: string) { for (const s of sectionsOf(text)) if (!s.heading && !this.from.has(s.key)) this.from.set(s.key, path); }

  // A file's text without the sections the chain already carries, with its line map moved to match;
  // its new sections are carried from then on. `path`: the file, `lines`: where each line is on disk.
  fresh(path: string, text: string, lines: LineSource[] = linesOf(text, path)): { text: string; lines: LineSource[]; left: number } {
    const secs = sectionsOf(text);
    const sourceAt = (at: number) => lines.findLast((x) => x.at <= at)?.path ?? path;
    const drop = secs.map((s) => !s.heading && this.from.has(s.key));
    // A heading goes with the section under it.
    for (let i = secs.length - 1; i >= 0; i--) if (secs[i]!.heading) drop[i] = i + 1 < secs.length && !secs[i + 1]!.heading ? drop[i + 1]! : false;
    for (let i = secs.length - 2; i >= 0; i--) if (secs[i]!.heading && secs[i + 1]!.heading) drop[i] = drop[i + 1]!;
    // Runs of dropped sections, each replaced by one line, unless the line is longer than the run.
    type Run = { a: number; b: number; note: string };
    const runs: Run[] = [];
    for (let i = 0; i < secs.length; i++) {
      if (!drop[i]) continue;
      let j = i;
      while (j + 1 < secs.length && drop[j + 1]) j++;
      const where = [...new Set(secs.slice(i, j + 1).filter((s) => !s.heading).map((s) => this.from.get(s.key)!))];
      // (Counted without the headings that go with them.)
      const n = Math.max(1, secs.slice(i, j + 1).filter((s) => !s.heading).length);
      const note = `(Left out here: ${n === 1 ? "a section" : `${n} sections`} the same as in ${where.slice(0, 3).join(", ")}${where.length > 3 ? ` and ${where.length - 3} more` : ""}, above.)`;
      if (secs[j]!.end - secs[i]!.start > note.length) runs.push({ a: secs[i]!.start, b: secs[j]!.end, note });
      else for (let k = i; k <= j; k++) drop[k] = false;
      i = j;
    }
    for (let i = 0; i < secs.length; i++) if (!drop[i] && !secs[i]!.heading && !this.from.has(secs[i]!.key)) this.from.set(secs[i]!.key, sourceAt(secs[i]!.start));
    if (!runs.length) return { text, lines, left: 0 };
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
    return { text: out, lines: moved, left };
  }
}
