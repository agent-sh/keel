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
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { buildDiff } from "./diff.ts";
import { contains } from "../core/paths.ts";

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File:";
const DELETE_FILE = "*** Delete File:";
const UPDATE_FILE = "*** Update File:";
const MOVE_TO = "*** Move to:";
const EOF_MARKER = "*** End of File";
const ENVIRONMENT_ID = "*** Environment ID:";

export type Chunk = {
  // Text after `@@ `: a line (usually a class or function header) the chunk follows.
  anchor: string | null;
  // Lines to find in the file (context and removed), and what replaces them
  // (context and added), in order.
  old_lines: string[];
  new_lines: string[];
  // [old index, new index] of each context line, so it stays byte-identical.
  context: [number, number][];
  // `*** End of File` followed the chunk: its old lines are the file's tail.
  is_end_of_file: boolean;
};

export type Hunk =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; move_to: string | null; chunks: Chunk[] };

export type PatchFile = {
  path: string;
  kind: "add" | "delete" | "update" | "move";
  diff: string;
  added: number;
  removed: number;
  moved_from?: string;
};

export type PatchResult = { files: PatchFile[]; summary: string };

const newChunk = (anchor: string | null = null): Chunk => ({ anchor, old_lines: [], new_lines: [], context: [], is_end_of_file: false });
const chunkEmpty = (c: Chunk) => c.old_lines.length === 0 && c.new_lines.length === 0;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const header = (line: string, marker: string) => (line.startsWith(marker) ? line.slice(marker.length).trim() : null);

const invalidHeader = (line: string, n: number) =>
  new Error(`invalid hunk at line ${n}, '${line.trim()}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`);

const unexpectedUpdateLine = (line: string, n: number) =>
  new Error(`invalid hunk at line ${n}, Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`);

// The anchor of an `@@` line. A unified-diff range (`@@ -3,7 +3,8 @@ fn main() {`)
// is a common slip: the range is dropped and the text after it is the anchor.
export function anchorText(head: string): string | null {
  if (!head.startsWith("@@")) return null;
  let text = head.slice(2).trim();
  const m = /^-[\d,]+ \+[\d,]+ (@@(?: .*)?)$/.exec(text);
  if (m) text = m[1]!.slice(2).trim();
  return text ? text : null;
}

// Body lines between the markers. Text before `*** Begin Patch` and after the
// last `*** End Patch` (a heredoc wrapper, a code fence) is ignored.
function patchBody(text: string): string[] {
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const start = lines.findIndex((l) => l.trim() === BEGIN_PATCH);
  if (start < 0) throw new Error("invalid patch: The first line of the patch must be '*** Begin Patch'");
  let end = -1;
  for (let i = lines.length - 1; i > start; i--) if (lines[i]!.trim() === END_PATCH) { end = i; break; }
  if (end < 0) throw new Error("invalid patch: The last line of the patch must be '*** End Patch'");
  return lines.slice(start + 1, end);
}

// Parses a V4A patch into its file actions without touching the filesystem.
export function parsePatch(text: string): Hunk[] {
  type Mode = "started" | "add" | "delete" | "update";
  const body = patchBody(text);
  const hunks: Hunk[] = [];
  let mode: Mode = "started";
  let pendingBlankAdds = 0;
  let updateLine = 0;

  const checkUpdate = (n: number) => {
    const last = hunks[hunks.length - 1];
    if (last?.type !== "update") return;
    if (!last.chunks.length && last.move_to === null) throw new Error(`invalid hunk at line ${updateLine}, Update file hunk for path '${last.path}' is empty`);
    const lc = last.chunks[last.chunks.length - 1];
    if (lc && chunkEmpty(lc)) throw new Error(`invalid hunk at line ${n}, Update hunk does not contain any lines`);
  };

  body.forEach((line, idx) => {
    const n = idx + 2; // 1-based within the patch, counting the Begin line
    // Inside an update only an unindented marker is a header; an indented one is
    // a context line that happens to look like a marker.
    const head = mode === "update" ? line.trimEnd() : line.trim();
    if (mode === "started" && head.startsWith(ENVIRONMENT_ID)) return;

    let hunk: Hunk | null = null;
    let next: Mode = mode;
    let p: string | null;
    if ((p = header(head, ADD_FILE)) !== null) { hunk = { type: "add", path: p, contents: "" }; next = "add"; }
    else if ((p = header(head, DELETE_FILE)) !== null) { hunk = { type: "delete", path: p }; next = "delete"; }
    else if ((p = header(head, UPDATE_FILE)) !== null) { hunk = { type: "update", path: p, move_to: null, chunks: [] }; next = "update"; }
    if (hunk) {
      checkUpdate(n);
      if (!hunk.path) throw new Error(`invalid hunk at line ${n}, the file path is missing`);
      hunks.push(hunk);
      mode = next;
      pendingBlankAdds = 0;
      updateLine = n;
      return;
    }

    const last = hunks[hunks.length - 1]!;
    if (mode === "started" || mode === "delete") {
      if (line.trim()) throw invalidHeader(line, n);
    } else if (mode === "add" && last.type === "add") {
      if (line.startsWith("+")) {
        last.contents += "\n".repeat(pendingBlankAdds) + line.slice(1) + "\n";
        pendingBlankAdds = 0;
      } else if (!line.trim()) {
        // A bare blank line between added lines is an empty added line; one
        // before the next header is just spacing.
        pendingBlankAdds++;
      } else if (line.trimEnd() !== EOF_MARKER) {
        // (The marker is not in the grammar for added files, but models write it.)
        throw invalidHeader(line, n);
      }
    } else if (mode === "update" && last.type === "update") {
      const chunks = last.chunks;
      const lc = chunks[chunks.length - 1];
      const isAnchor = head === "@@" || head.startsWith("@@ ");
      if (lc?.is_end_of_file) {
        if (!head) return;
        if (!isAnchor) throw new Error(`invalid hunk at line ${n}, Expected update hunk to start with a @@ context marker, got: '${line}'`);
      }
      if (!chunks.length && last.move_to === null) {
        const dest = header(head, MOVE_TO);
        if (dest !== null) {
          if (!dest) throw new Error(`invalid hunk at line ${n}, the move destination is missing`);
          last.move_to = dest;
          return;
        }
      }
      if (isAnchor) {
        if (lc && chunkEmpty(lc)) throw unexpectedUpdateLine(line, n);
        chunks.push(newChunk(anchorText(head)));
        return;
      }
      if (head === EOF_MARKER) {
        if (!lc || chunkEmpty(lc)) throw new Error(`invalid hunk at line ${n}, Update hunk does not contain any lines`);
        lc.is_end_of_file = true;
        return;
      }
      let kind: " " | "+" | "-";
      let t: string;
      if (line === "") { kind = " "; t = ""; }
      else if ("+- ".includes(line[0]!)) { kind = line[0] as " " | "+" | "-"; t = line.slice(1); }
      else if (lc && !chunkEmpty(lc)) throw new Error(`invalid hunk at line ${n}, Expected update hunk to start with a @@ context marker, got: '${line}'`);
      else throw unexpectedUpdateLine(line, n);
      if (!chunks.length) chunks.push(newChunk());
      const c = chunks[chunks.length - 1]!;
      if (kind === " ") { c.context.push([c.old_lines.length, c.new_lines.length]); c.old_lines.push(t); c.new_lines.push(t); }
      else if (kind === "+") c.new_lines.push(t);
      else c.old_lines.push(t);
    }
  });
  checkUpdate(body.length + 2);
  return hunks;
}

// Paths a patch touches (sources and move destinations), without applying it.
// A patch that does not parse still reports the paths its headers name.
export function patchTargetPaths(text: string): string[] {
  const out: string[] = [];
  const push = (p: string | null) => { p = p?.trim() ?? ""; if (p && !out.includes(p)) out.push(p); };
  try {
    for (const h of parsePatch(text)) { push(h.path); if (h.type === "update") push(h.move_to); }
  } catch {
    for (const line of text.split("\n")) {
      for (const m of [ADD_FILE, UPDATE_FILE, DELETE_FILE, MOVE_TO]) if (line.trimEnd().startsWith(m)) push(line.trimEnd().slice(m.length));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shell-wrapped invocations (the forms Codex accepts inside a shell call)
// ---------------------------------------------------------------------------

export type ShellPatch =
  | { kind: "not_patch" }
  | { kind: "patch"; patch: string; cd: string | null }
  | { kind: "rejected"; reason: string };

const SHELL_FORM_HELP =
  "apply_patch must be the only command in the call. Accepted forms: `apply_patch <<'EOF'` + patch + `EOF`, `apply_patch \"<patch>\"`, each optionally after `cd DIR &&`. Send any other command as a separate call.";

const isPatchCommand = (w: string) => w === "apply_patch" || w === "applypatch";

// Splits off one shell word (bare, single-quoted or double-quoted).
function takeWord(s: string): [string, string] | null {
  s = s.replace(/^[ \t]+/, "");
  if (!s) return null;
  const q = s[0]!;
  if (q === "'" || q === '"') {
    const end = s.indexOf(q, 1);
    return end < 0 ? null : [s.slice(1, end), s.slice(end + 1)];
  }
  const m = /[\s&;|<>]/.exec(s);
  const end = m ? m.index : s.length;
  return end > 0 ? [s.slice(0, end), s.slice(end)] : null;
}

export function parseShellApplyPatch(command: string): ShellPatch {
  const trimmed = command.trim();
  const firstLine = trimmed.split("\n")[0] ?? "";
  // The first word decides; words inside another command's quoted text or
  // heredoc body are not invocations.
  const leadsWithCd = takeWord(firstLine)?.[0] === "cd";
  const invokes = firstLine.split(/[&;|]/).some((seg, i) => {
    const w = takeWord(seg);
    return !!w && isPatchCommand(w[0]) && (i === 0 || leadsWithCd || w[1].trimStart().startsWith("<<"));
  });
  if (!invokes) return { kind: "not_patch" };
  const reject = (why: string): ShellPatch => ({ kind: "rejected", reason: `${why} ${SHELL_FORM_HELP}` });

  let w = takeWord(trimmed);
  if (!w) return reject("The command could not be read.");
  let [word, rest] = w;
  let cd: string | null = null;
  if (word === "cd") {
    const d = takeWord(rest);
    if (!d) return reject("`cd` needs exactly one directory.");
    const afterDir = d[1].replace(/^[ \t]+/, "");
    if (!afterDir.startsWith("&&")) return reject("`cd DIR` must be joined to apply_patch with `&&`.");
    cd = d[0];
    w = takeWord(afterDir.slice(2));
    if (!w) return reject("Nothing follows `cd DIR &&`.");
    [word, rest] = w;
  }
  if (!isPatchCommand(word)) return reject("A command runs before apply_patch.");
  rest = rest.replace(/^[ \t]+/, "");

  if (rest.startsWith("<<")) {
    let after = rest.slice(2);
    if (after.startsWith("-")) after = after.slice(1);
    const nl = after.indexOf("\n");
    const line = nl < 0 ? after : after.slice(0, nl);
    const body = nl < 0 ? "" : after.slice(nl + 1);
    let delim = line.trim();
    const qm = /^'(.*)'$/.exec(delim) ?? /^"(.*)"$/.exec(delim);
    if (qm) delim = qm[1]!;
    if (!delim || !/^\w+$/.test(delim)) return reject("Something follows the heredoc start on the same line.");
    const lines = body.split("\n");
    let end = lines.findIndex((l) => l.trim() === delim);
    let patchLines: string[];
    let tail: string[];
    if (end >= 0) { patchLines = lines.slice(0, end); tail = lines.slice(end + 1); }
    else {
      // No terminator line: everything after the patch itself is the tail.
      end = lines.map((l) => l.trim()).lastIndexOf(END_PATCH);
      if (end >= 0) { patchLines = lines.slice(0, end + 1); tail = lines.slice(end + 1); }
      else { patchLines = lines; tail = []; }
    }
    if (tail.some((l) => l.trim())) return reject("A command follows the patch heredoc.");
    return { kind: "patch", patch: patchLines.join("\n"), cd };
  }

  const quote = rest[0];
  if (quote !== "'" && quote !== '"') return reject("The patch must be a heredoc or one quoted argument.");
  const inner = rest.slice(1);
  const end = inner.lastIndexOf(quote);
  if (end < 0) return reject("The quoted patch is not closed.");
  if (inner.slice(end + 1).trim()) return reject("A command follows the quoted patch.");
  let patch = inner.slice(0, end);
  if (quote === '"') patch = patch.replace(/\\(["$`\\])/g, "$1");
  return { kind: "patch", patch, cd };
}

// The patch (and `cd` directory) when `command` is an accepted apply_patch
// invocation; null for anything else, including rejected forms.
export function extractShellApplyPatch(command: string): { patch: string; cd: string | null } | null {
  const r = parseShellApplyPatch(command);
  return r.kind === "patch" ? { patch: r.patch, cd: r.cd } : null;
}

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

// Resolves `raw` (relative to `base`) through every symlink of its existing
// part; the rest, not created yet, is appended.
async function realish(p: string): Promise<string> {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      const real = await realpath(cur);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch (e: any) {
      if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw e;
      const up = dirname(cur);
      if (up === cur) return p;
      tail.push(basename(cur));
      cur = up;
    }
  }
}


export type PatchTarget = { raw: string; real: string; inside: boolean };

// Every path of a patch, resolved; relative paths start at `base`, and `root` is
// the workspace they must stay in.
export async function patchTargets(root: string, base: string, text: string): Promise<PatchTarget[]> {
  const r = await realpath(root);
  return Promise.all(patchTargetPaths(text).map(async (raw) => {
    const real = await realish(isAbsolute(raw) ? raw : resolve(base, raw));
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
    const real = await realish(isAbsolute(raw) ? raw : resolve(base, raw));
    if (!contains(root, real) && !allowed.has(real)) throw new Error(`patch path ${raw} resolves to ${real}, which is outside the workspace`);
    return real;
  };
  const entry = async (real: string): Promise<Staged> => {
    let e = files.get(real);
    if (e) return e;
    const display = contains(root, real) ? relative(root, real) || "." : real;
    let original: string | null = null;
    let mode: number | null = null;
    try {
      const st = await lstat(real);
      if (!st.isFile()) throw new Error(`${display} is not a regular file`);
      const bytes = await readFile(real);
      try { original = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new Error(`${display} is not UTF-8 text and cannot be patched`); }
      mode = st.mode & 0o7777;
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
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

  // New contents first, deletions last: a failed write never loses the source of a move.
  for (const real of order) {
    const f = files.get(real)!;
    if (f.original !== f.current && f.current !== null) {
      try { await writeAtomic(real, f.current, f.mode); }
      catch (e) { throw new Error(`cannot write ${f.display}: ${(e as Error).message}`); }
    }
  }
  for (const real of order) {
    const f = files.get(real)!;
    if (f.original !== null && f.current === null) await rm(real);
  }
  return { files: out, summary: `Success. Updated the following files:\n${summary.join("\n")}` };
}

// Writes through a temp file in the same directory, keeping the permission bits.
async function writeAtomic(path: string, content: string, mode: number | null) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(path)}.keel-tmp-${crypto.randomUUID()}`);
  try {
    await writeFile(tmp, content);
    if (mode !== null) await chmod(tmp, mode);
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export { buildDiff };
