// Unified patches (git diff -p) as files and numbered lines, shared by the
// daemon (hunk revert, the size cap) and the UI's diff view.

// A hunk line carries `body`: its lines as git wrote them (what a hunk revert
// sends back, so the daemon can check the hunk still reads the same).
export type PatchLine = { kind: "add" | "del" | "ctx" | "hunk"; text: string; old?: number; new?: number; noEol?: boolean; body?: string };
export type FilePatch = { path: string; lines: PatchLine[]; binary: boolean; oldMode?: string; newMode?: string; partial?: boolean };

// A path as git writes it in a header: bare, or C-quoted when it holds a
// double quote, a backslash or a control character ("a/notes \"draft\".txt").
export function unquote(s: string): string {
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
  const bytes: number[] = [];
  const body = s.slice(1, -1);
  const esc: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") { bytes.push(...new TextEncoder().encode(c)); continue; }
    const n = body[++i] ?? "";
    if (/[0-7]/.test(n)) { bytes.push(parseInt(body.slice(i, i + 3), 8)); i += 2; }
    else bytes.push(esc[n] ?? n.charCodeAt(0));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// The path of a `diff --git a/P b/P` header (renames are off, so both sides
// name the same file, which may hold spaces).
export function headerPath(line: string): string | null {
  if (!line.startsWith("diff --git ")) return null;
  const rest = line.slice(11);
  if (rest.startsWith('"')) {
    const m = rest.match(/^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*"|\S.*)$/);
    const b = m ? unquote(m[2]!) : null;
    return b ? b.replace(/^b\//, "") : null;
  }
  if (rest.endsWith('"')) {
    const q = rest.match(/("(?:[^"\\]|\\.)*")$/);
    return q ? unquote(q[1]!).replace(/^b\//, "") : null;
  }
  const len = (rest.length - 5) / 2;
  if (Number.isInteger(len) && len > 0 && rest.startsWith("a/") && rest.slice(len + 2, len + 5) === " b/") return rest.slice(len + 5);
  const m = rest.match(/^a\/(.*) b\/(.*)$/);
  return m ? m[2]! : rest;
}

export function parsePatch(patch: string): FilePatch[] {
  const files: FilePatch[] = [];
  let cur: FilePatch | null = null;
  let o = 0;
  let n = 0;
  let hunk: PatchLine | null = null;
  for (const raw of patch.split("\n")) {
    const path = headerPath(raw);
    if (path === null && hunk && /^[-+ \\]/.test(raw)) hunk.body = hunk.body ? `${hunk.body}\n${raw}` : raw;
    if (path !== null) {
      cur = { path, lines: [], binary: false };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (!cur.lines.length) {
      if (raw.startsWith("Binary files")) { cur.binary = true; continue; }
      if (raw.startsWith("old mode ")) { cur.oldMode = raw.slice(9).trim(); continue; }
      if (raw.startsWith("new mode ")) { cur.newMode = raw.slice(9).trim(); continue; }
      if (/^(---|\+\+\+|index |new file|deleted file|similarity|rename )/.test(raw)) continue;
    }
    if (raw.startsWith("@@")) {
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      o = Number(m?.[1] ?? 0);
      n = Number(m?.[2] ?? 0);
      hunk = { kind: "hunk", text: raw, body: "" };
      cur.lines.push(hunk);
      continue;
    }
    // "\ No newline at end of file" belongs to the line before it.
    if (raw.startsWith("\\")) {
      const last = cur.lines.at(-1);
      if (last && last.kind !== "hunk") last.noEol = true;
      continue;
    }
    if (raw.startsWith("+")) cur.lines.push({ kind: "add", text: raw.slice(1), new: n++ });
    else if (raw.startsWith("-")) cur.lines.push({ kind: "del", text: raw.slice(1), old: o++ });
    else if (raw.startsWith(" ")) cur.lines.push({ kind: "ctx", text: raw.slice(1), old: o++, new: n++ });
  }
  return files;
}

// A patch held to `cap` bytes of UTF-8: cut after the last whole line, so no
// character or line is split; `partial` names the file whose diff the cut
// ends inside (its shown part is real, the rest is left out).
export function capPatch(patch: string, cap: number): { diff: string; truncated: boolean; partial?: string } {
  const bytes = new TextEncoder().encode(patch);
  if (bytes.length <= cap) return { diff: patch, truncated: false };
  const nl = bytes.lastIndexOf(10, cap - 1);
  // One line longer than the cap: a prefix that ends on a whole character.
  const diff = nl > 0 ? new TextDecoder().decode(bytes.subarray(0, nl + 1)) : new TextDecoder().decode(bytes.subarray(0, cap)).replace(/�+$/, "");
  const rest = new TextDecoder().decode(bytes.subarray(nl > 0 ? nl + 1 : cap, Math.min(bytes.length, (nl > 0 ? nl + 1 : cap) + 11)));
  const headers = [...diff.matchAll(/^diff --git .*$/gm)];
  const last = headers.at(-1);
  const partial = last && !rest.startsWith("diff --git ") ? headerPath(last[0]) ?? undefined : undefined;
  return { diff, truncated: true, partial };
}

// One hunk of one file's diff, as a patch git can apply (headers kept).
export function hunkPatch(diff: string, path: string, index: number, header: string): string | null {
  const sections = diff.split(/^(?=diff --git )/m);
  const sec = sections.find((x) => headerPath(x.slice(0, x.indexOf("\n") >>> 0)) === path);
  if (!sec) return null;
  const lines = sec.split("\n");
  const first = lines.findIndex((l) => l.startsWith("@@"));
  if (first < 0) return null;
  const starts = lines.map((l, i) => (l.startsWith("@@") ? i : -1)).filter((i) => i >= 0);
  const at = starts[index];
  if (at === undefined || lines[at] !== header) return null;
  const end = starts[index + 1] ?? lines.length;
  const body = lines.slice(at, end);
  while (body.length && body.at(-1) === "") body.pop();
  return [...lines.slice(0, first), ...body].join("\n") + "\n";
}
