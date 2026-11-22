import { hookSaid } from "../engine/hooks.ts";
// What an edit did to a file's diagnostics, and the words the model reads
// about it. An edit moves lines, so a diagnostic is the same one before and
// after when its severity, code, source and message match and the line it
// sits on reads the same, whatever that line's number: the ones the file has
// more of afterwards are new, the ones it has fewer of are fixed. (With the
// line's words in the comparison, an error fixed in one place while the same
// message appears in another is one fixed and one new, not nothing.) The text is written once, into the edit's own result: only what
// is new, errors first, a bounded list, and nothing when nothing changed.

// 1 error, 2 warning, 3 information, 4 hint (the protocol's DiagnosticSeverity).
// `at`: the words of the line it is on, when the document's text was at hand.
export type Diag = { line: number; col: number; severity: 1 | 2 | 3 | 4; code?: string; source?: string; message: string; at?: string };

// What is kept of one file's diagnostics and of each one's text: a server
// that sends a hundred thousand, or a megabyte in one field, costs the daemon
// neither the memory nor the time (every later step is linear in what is kept).
export const FILE_MAX = 2000;
const FIELD_MAX = { message: 600, code: 40, source: 40 };

// A server's diagnostic as the protocol sends it, read defensively: a server
// that sends nonsense gives no diagnostic, never an exception.
export function fromLsp(raw: unknown, text?: string): Diag[] {
  if (!Array.isArray(raw)) return [];
  const lines = text === undefined || !raw.length ? undefined : text.split("\n");
  const out: Diag[] = [];
  for (const d of raw) {
    if (out.length >= FILE_MAX) break;
    const start = d?.range?.start;
    if (typeof d?.message !== "string" || typeof start?.line !== "number") continue;
    const sev = d.severity === 2 || d.severity === 3 || d.severity === 4 ? d.severity : 1; // no severity: the client decides, and an unmarked problem is an error
    const code = typeof d.code === "string" || typeof d.code === "number" ? String(d.code).slice(0, FIELD_MAX.code) : undefined;
    out.push({ line: start.line + 1, col: (typeof start.character === "number" ? start.character : 0) + 1, severity: sev, ...(code ? { code } : {}), ...(typeof d.source === "string" && d.source ? { source: d.source.slice(0, FIELD_MAX.source) } : {}), message: d.message.slice(0, FIELD_MAX.message), ...(lines ? { at: (lines[start.line] ?? "").trim().slice(0, 160) } : {}) });
  }
  return out;
}

const keyOf = (d: Diag) => `${d.severity}\0${d.source ?? ""}\0${d.code ?? ""}\0${d.message}\0${d.at ?? ""}`;

export type DiagDiff = { added: Diag[]; fixed: Diag[] };

// `before` and `after` are one file's diagnostics. Added: in file order.
export function diffDiagnostics(before: Diag[], after: Diag[]): DiagDiff {
  const had = new Map<string, Diag[]>();
  for (const d of before) { const k = keyOf(d); const list = had.get(k); if (list) list.push(d); else had.set(k, [d]); }
  const added: Diag[] = [];
  for (const d of [...after].sort((a, b) => a.line - b.line || a.col - b.col)) {
    const left = had.get(keyOf(d));
    if (left?.length) left.pop();
    else added.push(d);
  }
  return { added, fixed: [...had.values()].flat() };
}

// What is counted and listed: errors only, or warnings too. Information and
// hints (an unused name, a style note) are never an edit's failure.
export type DiagLevel = "errors" | "warnings";
const counts = (level: DiagLevel) => (d: Diag) => d.severity === 1 || (level === "warnings" && d.severity === 2);

// The code as a reader knows it: `TS2322` for the TypeScript compiler's 2322,
// a named or lettered code (E0308, F821, reportMissingImports) as it is.
export function codeText(d: Diag): string {
  if (!d.code) return "";
  return /^\d+$/.test(d.code) && d.source && /^[a-z]{1,6}$/i.test(d.source) ? `${d.source.toUpperCase()}${d.code}` : d.code;
}

const MESSAGE_MAX = 300;
// A server's words are another program's: they reach the model on one line,
// without control, escape or direction characters, and through the same
// neutralizer a hook's words go through (no tag opens or closes, no harness mark).
const plain = (s: string, max: number) => {
  const t = hookSaid(s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]+/g, " ").replace(/\s+/g, " ").trim(), max * 4);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
// The whole block in bytes: a result an edit wrote grows by no more than this.
export const BLOCK_MAX = 1500;
const bytes = (s: string) => Buffer.byteLength(s);

export const LIST_MAX = 10;

export type FileDiff = { path: string; diff: DiagDiff; after: Diag[] };
// `late`: these belong to an edit whose result was written before the server
// answered. `pending`: files of this call the server has not answered for
// yet. `unchecked`: files it could not be asked about (no answer for the file
// as it was, or the server ended). `clean`: files of a late answer that has
// nothing new, so "not checked yet" and "checked, clean" read differently.
// `room`: the bytes the result has left under its cap.
export type RenderOpts = { server: string; level: DiagLevel; late?: boolean; pending?: string[]; unchecked?: string[]; clean?: string[]; max?: number; room?: number };
export type Rendered = { text: string; errors: number; warnings: number; fixed: number; listed: number; pending: number };

const NONE: Rendered = { text: "", errors: 0, warnings: 0, fixed: 0, listed: 0, pending: 0 };
const names = (paths: string[]) => { const shown = paths.slice(0, 5).map((p) => plain(p, 120)); return `${shown.join(", ")}${paths.length > shown.length ? ` and ${paths.length - shown.length} more` : ""}`; };

// The block appended to a tool result, or "" when there is nothing to say.
// `files`: each file's diff, the edited ones first; paths as the model writes them.
export function renderDiagnostics(files: FileDiff[], o: RenderOpts): Rendered {
  const want = counts(o.level);
  const rows: { path: string; d: Diag }[] = [];
  let fixed = 0;
  let remain = 0;
  for (const f of files) {
    for (const d of f.diff.added) if (want(d)) rows.push({ path: f.path, d });
    // Fixed ones are counted at the level shown: a hint that went away is no fix.
    for (const d of f.diff.fixed) if (want(d)) fixed++;
    for (const d of f.after) if (d.severity === 1) remain++;
  }
  rows.sort((a, b) => a.d.severity - b.d.severity); // stable: errors first, each group in file order
  let errors = 0;
  for (const r of rows) if (r.d.severity === 1) errors++;
  const warnings = rows.length - errors;
  const pending = o.pending ?? [];
  const unchecked = o.unchecked ?? [];
  const clean = !rows.length && !fixed ? o.clean ?? [] : [];
  if (!rows.length && !fixed && !pending.length && !unchecked.length && !clean.length) return NONE;
  const head: string[] = [];
  if (errors) head.push(`${plural(errors, "new error")}`);
  if (warnings) head.push(`${plural(warnings, "new warning")}`);
  if (fixed) head.push(`${fixed} fixed`);
  const from = o.late ? "From an earlier edit (the language server answered after its result was written): " : "";
  const first: string[] = [];
  if (head.length) {
    // After a fix with nothing new, the model learns whether it is done with the file.
    const left = !rows.length && fixed ? (remain ? `, ${plural(remain, "error")} still in ${files.length === 1 ? "this file" : "these files"}` : ", no errors left") : "";
    first.push(`${from}${head.join(", ")}${left}.`);
  } else if (clean.length) first.push(`${from}${names(clean)} checked: no new errors.`);
  const last: string[] = [];
  if (pending.length) last.push(`Not checked yet: ${names(pending)} (the language server has not answered). Its answer comes with a later tool result; nothing needs to be read or run for it.`);
  if (unchecked.length) last.push(`Not checked: ${names(unchecked)} (the language server gave no answer for ${unchecked.length === 1 ? "it" : "them"}).`);
  const server = plain(o.server, 80).replace(/"/g, "'");
  const wrap = (lines: string[]) => `<diagnostics server="${server}">\n${lines.join("\n")}\n</diagnostics>`;
  const line = ({ path, d }: { path: string; d: Diag }) => {
    const code = plain(codeText(d), 40);
    return `${plain(path, 200)}:${d.line}:${d.col} ${d.severity === 1 ? "error" : "warning"}${code ? ` ${code}` : ""} ${plain(d.message, MESSAGE_MAX)}`;
  };
  // As many of the list as the block's bytes hold; the rest is a count.
  const cap = Math.min(BLOCK_MAX, o.room ?? BLOCK_MAX);
  const listed: string[] = [];
  const build = () => wrap([...first, ...listed, ...(rows.length > listed.length && (listed.length || !first.length) ? [`and ${rows.length - listed.length} more.`] : []), ...last]);
  for (const r of rows.slice(0, o.max ?? LIST_MAX)) {
    listed.push(line(r));
    if (bytes(build()) > cap) { listed.pop(); break; }
  }
  const text = build();
  if (bytes(text) > cap) return NONE; // no room in this result: the caller keeps what it owes
  return { text, errors, warnings, fixed, listed: listed.length, pending: pending.length };
}
