// What an edit did to a file's diagnostics, and the words the model reads
// about it. An edit moves lines, so a diagnostic is the same one before and
// after when its severity, code, source and message match, wherever it sits:
// the ones the file has more of afterwards are new, the ones it has fewer of
// are fixed. The text is written once, into the edit's own result: only what
// is new, errors first, a bounded list, and nothing when nothing changed.

// 1 error, 2 warning, 3 information, 4 hint (the protocol's DiagnosticSeverity).
export type Diag = { line: number; col: number; severity: 1 | 2 | 3 | 4; code?: string; source?: string; message: string };

// A server's diagnostic as the protocol sends it, read defensively: a server
// that sends nonsense gives no diagnostic, never an exception.
export function fromLsp(raw: unknown): Diag[] {
  if (!Array.isArray(raw)) return [];
  const out: Diag[] = [];
  for (const d of raw) {
    const start = d?.range?.start;
    if (typeof d?.message !== "string" || typeof start?.line !== "number") continue;
    const sev = d.severity === 2 || d.severity === 3 || d.severity === 4 ? d.severity : 1; // no severity: the client decides, and an unmarked problem is an error
    const code = typeof d.code === "string" || typeof d.code === "number" ? String(d.code) : undefined;
    out.push({ line: start.line + 1, col: (typeof start.character === "number" ? start.character : 0) + 1, severity: sev, ...(code ? { code } : {}), ...(typeof d.source === "string" && d.source ? { source: d.source } : {}), message: d.message });
  }
  return out;
}

const keyOf = (d: Diag) => `${d.severity}\0${d.source ?? ""}\0${d.code ?? ""}\0${d.message}`;

export type DiagDiff = { added: Diag[]; fixed: Diag[] };

// `before` and `after` are one file's diagnostics. Added: in file order.
export function diffDiagnostics(before: Diag[], after: Diag[]): DiagDiff {
  const had = new Map<string, Diag[]>();
  for (const d of before) { const k = keyOf(d); had.set(k, [...(had.get(k) ?? []), d]); }
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
const oneLine = (s: string) => {
  const t = s.replace(/\s*\n\s*/g, " ").trim();
  return t.length > MESSAGE_MAX ? `${t.slice(0, MESSAGE_MAX - 1)}…` : t;
};
// A diagnostic's text cannot close the block it is written in or open another.
const inert = (s: string) => s.replace(/<(?=\/?diagnostics\b)/gi, "&lt;");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export const LIST_MAX = 10;

export type FileDiff = { path: string; diff: DiagDiff; after: Diag[] };
// `late`: these belong to an edit whose result was written before the server
// answered. `pending`: files of this call the server has not answered for yet.
export type RenderOpts = { server: string; level: DiagLevel; late?: boolean; pending?: string[]; max?: number };
export type Rendered = { text: string; errors: number; warnings: number; fixed: number; listed: number; pending: number };

// The block appended to a tool result, or "" when there is nothing to say.
// `files`: each file's diff, the edited ones first; paths as the model writes them.
export function renderDiagnostics(files: FileDiff[], o: RenderOpts): Rendered {
  const want = counts(o.level);
  const max = o.max ?? LIST_MAX;
  const rows: { path: string; d: Diag }[] = [];
  let fixed = 0;
  let remain = 0;
  for (const f of files) {
    for (const d of f.diff.added) if (want(d)) rows.push({ path: f.path, d });
    // Fixed ones are counted at the level shown: a hint that went away is no fix.
    fixed += f.diff.fixed.filter(want).length;
    remain += f.after.filter((d) => d.severity === 1).length;
  }
  rows.sort((a, b) => a.d.severity - b.d.severity); // stable: errors first, each group in file order
  const errors = rows.filter((r) => r.d.severity === 1).length;
  const warnings = rows.length - errors;
  const pending = o.pending ?? [];
  if (!rows.length && !fixed && !pending.length) return { text: "", errors: 0, warnings: 0, fixed: 0, listed: 0, pending: 0 };
  const head: string[] = [];
  if (errors) head.push(`${plural(errors, "new error")}`);
  if (warnings) head.push(`${plural(warnings, "new warning")}`);
  if (fixed) head.push(`${fixed} fixed`);
  const lines: string[] = [];
  if (head.length) {
    // After a fix with nothing new, the model learns whether it is done with the file.
    const left = !rows.length && fixed ? (remain ? `, ${plural(remain, "error")} still in ${files.length === 1 ? "this file" : "these files"}` : ", no errors left") : "";
    lines.push(`${o.late ? "From an earlier edit (the language server answered after its result was written): " : ""}${head.join(", ")}${left}.`);
  }
  const listed = rows.slice(0, max);
  for (const { path, d } of listed) {
    const code = codeText(d);
    lines.push(`${path}:${d.line}:${d.col} ${d.severity === 1 ? "error" : "warning"}${code ? ` ${code}` : ""} ${oneLine(d.message)}`);
  }
  if (rows.length > listed.length) lines.push(`and ${rows.length - listed.length} more.`);
  if (pending.length) lines.push(`Not checked yet: ${pending.join(", ")} (the language server has not answered). What it finds comes with the result of your next edit or read of ${pending.length === 1 ? "that file" : "those files"}.`);
  return {
    text: `<diagnostics server="${o.server}">\n${inert(lines.join("\n"))}\n</diagnostics>`,
    errors, warnings, fixed, listed: listed.length, pending: pending.length,
  };
}
