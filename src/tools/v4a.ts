// The V4A patch format (`*** Begin Patch` ... `*** End Patch`) that GPT models
// are trained to write: parser, matcher and applier.
//
// Grammar and leniencies follow openai/codex `codex-rs/apply-patch`: `@@ <anchor>`
// lines that position a chunk, `*** End of File` chunks matched against the file
// tail, four passes of decreasing strictness when locating old lines, line
// endings kept as they are in the file. Keel differs on purpose where the
// reference loses work or surprises the model:
//
// - a chunk that only adds lines after an `@@ <anchor>` goes right after the
//   anchor line (the reference appends it to the end of the file);
// - `*** Add File` or `*** Move to` over an existing file is an error, not a
//   silent overwrite;
// - every action is staged in memory first: a later action sees an earlier one
//   on the same file, and a failing hunk leaves every file untouched;
// - paths are resolved through symlinks and must stay inside the workspace.
import { chmod, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { buildDiff } from "./diff.ts";
import { atCwd, contains, realOf } from "../core/paths.ts";
import { heldWrite } from "../core/store-files.ts";
import { hold, type HoldContext } from "./files.ts";

export * from "./v4a-parse.ts";
import { parsePatch, patchTargetPaths, type Chunk, type PatchFile, type PatchResult } from "./v4a-parse.ts";

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function normalisePunctuation(s: string): string {
  return s
    .trim()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018-\u201B]/g, "'")
    .replace(/[\u201C-\u201F]/g, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

const PASSES: ((a: string, b: string) => boolean)[] = [
  (a, b) => a === b,
  (a, b) => a.trimEnd() === b.trimEnd(),
  (a, b) => a.trim() === b.trim(),
  (a, b) => normalisePunctuation(a) === normalisePunctuation(b),
];

// Finds `pattern` in `lines` at or after `start`: exact, then ignoring trailing
// whitespace, then surrounding whitespace, then with typographic punctuation
// folded to ASCII. With `eof` the tail of the file is tried first.
export function seekSequence(lines: string[], pattern: string[], start: number, eof: boolean): number | null {
  if (!pattern.length) return start;
  if (pattern.length > lines.length) return null;
  const last = lines.length - pattern.length;
  const search = (from: number): number | null => {
    if (from > last) return null;
    for (const same of PASSES) {
      for (let i = from; i <= last; i++) if (pattern.every((p, k) => same(lines[i + k]!, p))) return i;
    }
    return null;
  };
  if (eof) {
    const f = search(Math.max(last, start));
    if (f !== null) return f;
  }
  return search(start);
}

type Line = { text: string; end: string | null };

// A file split into lines, each remembering its own line ending.
function parseSource(contents: string): { lines: Line[]; preferred: string } {
  const lines: Line[] = [];
  let preferred: string | null = null;
  const re = /\r\n|\r|\n/g;
  let at = 0;
  for (let m; (m = re.exec(contents)); ) {
    preferred ??= m[0];
    lines.push({ text: contents.slice(at, m.index), end: m[0] });
    at = m.index + m[0].length;
  }
  if (at < contents.length) lines.push({ text: contents.slice(at), end: null });
  return { lines, preferred: preferred ?? "\n" };
}

const short = (line: string) => { const l = line.trim(); return l.length > 60 ? `${l.slice(0, 60)}...` : l; };

// Why `wanted` is not in the file at or below line `cursor`: the hunk's text is
// above the cursor, or which of its lines differs from what the file has where
// the most of its lines line up.
function contextMiss(lines: string[], wanted: string[], head: string, cursor: number, what: string): Error {
  const above = seekSequence(lines, wanted, 0, false);
  if (above !== null && above < cursor) {
    const place = wanted.length === 1 ? `line ${above + 1}` : `lines ${above + 1}-${above + wanted.length}`;
    return new Error(`${head}\nIts text is at ${place} of the file, above line ${cursor + 1} where the patch had got to. Put the hunks of a file in the order of the file, each below its own \`@@\` line, and send the patch again.`);
  }
  // Vote for a start: each hunk line found in the file says where it would begin.
  const votes = new Map<number, number>();
  const index = new Map<string, number[]>();
  lines.forEach((l, i) => { const k = l.trim(); if (k) (index.get(k) ?? index.set(k, []).get(k)!).push(i); });
  wanted.forEach((w, j) => {
    const places = index.get(w.trim());
    if (!places || places.length > 20) return;
    for (const i of places) if (i >= j) votes.set(i - j, (votes.get(i - j) ?? 0) + Math.min(w.trim().length, 64));
  });
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  if (!best) return new Error(`${head}\nNone of the lines of ${what} are in the file. Read the file again and send the patch again.`);
  const start = best[0];
  for (let k = 0; k < wanted.length; k++) {
    const have = lines[start + k];
    if (have === undefined || !PASSES.some((same) => same(have, wanted[k]!))) {
      const at = start + k + 1;
      const fileHas = have === undefined ? "the file ends there" : have.trim() ? `the file has '${short(have)}'` : "the file has a blank line";
      const line = wanted[k]!.trim() ? `'${short(wanted[k]!)}'` : "a blank line";
      return new Error(`${head}\nLine ${k + 1} of ${what}, ${line}, differs from line ${at} of the file: ${fileHas}. Correct it from the file and send the patch again.`);
    }
  }
  return new Error(`${head}\nRead the file again and send the patch again.`);
}

function applyChunks(original: string, chunks: Chunk[], path: string): string {
  const src = parseSource(original);
  const lines = src.lines.map((l) => l.text);
  const reps: [number, number, string[]][] = [];
  let cursor = 0;

  chunks.forEach((chunk, i) => {
    const name = `hunk ${i + 1} of ${chunks.length}${chunk.anchor ? ` (@@ ${short(chunk.anchor)})` : ""}`;
    if (chunk.anchor !== null) {
      const at = seekSequence(lines, [chunk.anchor], cursor, false);
      if (at === null) {
        throw contextMiss(lines, [chunk.anchor], `Failed to find context '${short(chunk.anchor)}' in ${path}: the \`@@\` line of hunk ${i + 1} of ${chunks.length}.`, cursor, "the `@@` line");
      }
      cursor = at + 1;
    }
    if (!chunk.old_lines.length) {
      reps.push([chunk.anchor !== null && !chunk.is_end_of_file ? cursor : lines.length, 0, chunk.new_lines]);
      return;
    }
    let pattern = chunk.old_lines;
    let fresh = chunk.new_lines;
    let found = seekSequence(lines, pattern, cursor, chunk.is_end_of_file);
    if (found === null && pattern[pattern.length - 1] === "") {
      // A trailing empty old line stands for the file's final newline, which is
      // not a line of its own here. Retry without it.
      pattern = pattern.slice(0, -1);
      if (fresh[fresh.length - 1] === "") fresh = fresh.slice(0, -1);
      found = seekSequence(lines, pattern, cursor, chunk.is_end_of_file);
    }
    if (found === null) throw contextMiss(lines, chunk.old_lines, `Failed to find expected lines in ${path}: ${name}.`, cursor, "the hunk");
    // Context lines stay exactly as they are in the file; only the spans
    // between them are replaced.
    let oldAt = 0, newAt = 0;
    for (const [oc, nc] of chunk.context) {
      if (oc >= pattern.length || nc >= fresh.length) break;
      if (oldAt !== oc || newAt !== nc) reps.push([found + oldAt, oc - oldAt, fresh.slice(newAt, nc)]);
      oldAt = oc + 1;
      newAt = nc + 1;
    }
    if (oldAt !== pattern.length || newAt !== fresh.length) reps.push([found + oldAt, pattern.length - oldAt, fresh.slice(newAt)]);
    cursor = found + pattern.length;
  });

  reps.sort((a, b) => a[0] - b[0]);
  // Untouched lines keep their endings; new lines get the file's; the result
  // always ends with a line ending.
  const out: Line[] = [];
  let at = 0;
  for (const [start, len, fresh] of reps) {
    out.push(...src.lines.slice(at, Math.max(at, start)));
    for (const text of fresh) out.push({ text, end: src.preferred });
    at = Math.max(at, start) + len;
  }
  out.push(...src.lines.slice(at));
  return out.map((l) => l.text + (l.end ?? src.preferred)).join("");
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export type PatchTarget = { raw: string; real: string; inside: boolean };

// Every path of a patch, resolved; relative paths start at `base`, and `root` is
// the workspace they must stay in.
export async function patchTargets(root: string, base: string, text: string): Promise<PatchTarget[]> {
  const r = await realpath(root);
  return Promise.all(patchTargetPaths(text).map(async (raw) => {
    const real = realOf(atCwd(base, raw));
    return { raw, real, inside: contains(r, real) };
  }));
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

type Staged = {
  display: string;
  original: string | null;  // on disk before the patch; null when absent
  current: string | null;   // after the actions so far
  mode: number | null;
  movedFrom: { display: string; text: string } | null;
};

export type ApplyOptions = {
  base?: string;             // where relative paths start (default: cwd)
  allowOutside?: string[];   // real paths outside the workspace a gate cleared
  judged?: string[];         // the files the call was judged for (ToolContext.judged): nothing else is opened
  looked?: Record<string, string | null>; // and the file each was at the gate's look (ToolContext.looked)
  sessionId?: string;        // the session the patch is applied for (what its gate cleared lately holds a call with no `judged`)
  // Asked of each file the patch changes, before anything is written: words refuse the whole patch (a file the
  // session may change only in part: src/tools/reading.ts).
  check?: (real: string, before: string, after: string) => string | undefined;
};

// Parses and applies a V4A patch inside the workspace `cwd`.
export async function applyPatch(cwd: string, text: string, opts: ApplyOptions = {}): Promise<PatchResult> {
  const hunks = parsePatch(text);
  if (!hunks.length) throw new Error("V4A patch contained no file operations");
  const root = await realpath(cwd);
  const base = opts.base ?? cwd;
  const allowed = new Set(opts.allowOutside ?? []);
  const files = new Map<string, Staged>();
  const order: string[] = [];

  const resolvePath = async (raw: string) => {
    // (Where the kernel reaches it: the path a gate judged, and the one opened below.)
    const real = realOf(atCwd(base, raw));
    if (!contains(root, real) && !allowed.has(real)) throw new Error(`patch path ${raw} resolves to ${real}, which is outside the workspace`);
    // The daemon's own store and claim, by name or as the same file under another, and its state folder: never read, replaced or removed from here.
    const held = heldWrite(real);
    if (held) throw new Error(held);
    return real;
  };
  const entry = async (real: string): Promise<Staged> => {
    let e = files.get(real);
    if (e) return e;
    const display = contains(root, real) ? relative(root, real) || "." : real;
    let original: string | null = null;
    let mode: number | null = null;
    // The file is held while it is read: the file that was judged, by its descriptor (files.ts hold).
    const h = await hold(real, opts, "read");
    if ("refused" in h) throw new Error(h.refused);
    try {
      if (h.existed) {
        const st = await stat(h.io);
        if (!st.isFile()) throw new Error(`${display} is not a regular file`);
        const bytes = await readFile(h.io);
        try { original = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { throw new Error(`${display} is not UTF-8 text and cannot be patched`); }
        mode = st.mode & 0o7777;
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    } finally { h.close(); }
    e = { display, original, current: original, mode, movedFrom: null };
    files.set(real, e);
    order.push(real);
    return e;
  };

  // Everything is computed in memory first: a later action sees what an earlier
  // one did, and a failure leaves the workspace untouched.
  for (const h of hunks) {
    if (h.type === "add") {
      const e = await entry(await resolvePath(h.path));
      if (e.current !== null) throw new Error(`Add File: ${h.path} already exists. Use '*** Update File: ${h.path}' to change it, or delete it first.`);
      e.current = h.contents;
    } else if (h.type === "delete") {
      const e = await entry(await resolvePath(h.path));
      if (e.current === null) throw new Error(`Failed to delete file ${h.path}: it does not exist. Check the path.`);
      e.current = null;
    } else {
      const real = await resolvePath(h.path);
      const e = await entry(real);
      const before = e.current;
      if (before === null) throw new Error(`Failed to read file to update ${h.path}: it does not exist. Check the path, or use \`*** Add File: ${h.path}\` to create it.`);
      const after = h.chunks.length ? applyChunks(before, h.chunks, h.path) : before;
      if (h.move_to === null) { e.current = after; continue; }
      const destReal = await resolvePath(h.move_to);
      if (destReal === real) { e.current = after; continue; }
      e.current = null;
      const target = await entry(destReal);
      if (target.current !== null) throw new Error(`Move to: ${h.move_to} already exists; refusing to overwrite it`);
      target.current = after;
      target.mode = e.mode;
      target.movedFrom = { display: e.display, text: before };
    }
  }

  const out: PatchFile[] = [];
  const summary: string[] = [];
  const movedAway = new Set([...files.values()].flatMap((f) => (f.movedFrom ? [f.movedFrom.display] : [])));
  for (const real of order) {
    const f = files.get(real)!;
    if (f.original === f.current) continue;
    let kind: PatchFile["kind"];
    let before: string;
    if (f.original === null) {
      if (f.current === null) continue;
      kind = f.movedFrom ? "move" : "add";
      before = f.movedFrom?.text ?? "";
    } else if (f.current === null) { kind = "delete"; before = f.original; }
    else { kind = "update"; before = f.original; }
    const d = buildDiff(f.display, before, f.current ?? "");
    const counts = `(+${d.added} -${d.removed})`;
    if (kind === "add") summary.push(`A ${f.display} ${counts}`);
    else if (kind === "delete") { if (!movedAway.has(f.display)) summary.push(`D ${f.display} ${counts}`); }
    else if (kind === "move") summary.push(`R ${f.movedFrom!.display} -> ${f.display} ${counts}`);
    else summary.push(`M ${f.display} ${counts}`);
    out.push({ path: f.display, kind, diff: d.diff, added: d.added, removed: d.removed, ...(f.movedFrom ? { moved_from: f.movedFrom.display } : {}) });
  }
  if (!out.length) throw new Error("the patch applies and changes nothing: what it would write is already there. Do not repeat it.");
  for (const real of order) {
    const f = files.get(real)!;
    const no = f.original !== null && f.current !== null && f.original !== f.current && !f.movedFrom ? opts.check?.(real, f.original, f.current) : undefined;
    if (no) throw new Error(no);
  }

  // New contents first, deletions last: a failed write never loses the source of a move.
  for (const real of order) {
    const f = files.get(real)!;
    if (f.original !== f.current && f.current !== null) {
      try { await writeAtomic(real, f.current, f.mode, opts); }
      catch (e) { throw new Error(`cannot write ${f.display}: ${(e as Error).message}`); }
    }
  }
  for (const real of order) {
    const f = files.get(real)!;
    if (f.original !== null && f.current === null) {
      // (Removed by its name inside its folder, held: a name is not followed when it is removed.)
      const h = await hold(real, opts, "folder");
      if ("refused" in h) throw new Error(h.refused);
      try { await rm(h.beside(basename(real))); } finally { h.close(); }
    }
  }
  return { files: out, summary: `Success. Updated the following files:\n${summary.join("\n")}` };
}

// Writes through a temp file in the same directory, keeping the permission bits.
async function writeAtomic(path: string, content: string, mode: number | null, ctx: HoldContext) {
  // The folder is held (made when missing): the temp file is made in it and takes the file's name there, which is
  // not followed if it is a link by then.
  const h = await hold(path, ctx, "folder");
  if ("refused" in h) throw new Error(h.refused);
  const tmp = h.beside(`.${basename(path)}.keel-tmp-${crypto.randomUUID()}`);
  try {
    await writeFile(tmp, content, { flag: "wx" });
    if (mode !== null) await chmod(tmp, mode);
    await rename(tmp, h.beside(basename(path)));
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  } finally { h.close(); }
}

export { buildDiff };
