// The V4A patch format's parser (see v4a.ts): what a patch says, with no file read or written. The permission
// policy reads a patch's targets with it, and a trial of a rule change replays that policy (src/safety/trial-rules.ts),
// so it imports nothing that holds a file or a setting.
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
      for (const m of [ADD_FILE, UPDATE_FILE, DELETE_FILE, MOVE_TO]) if (line.trim().startsWith(m)) push(line.trim().slice(m.length));
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
