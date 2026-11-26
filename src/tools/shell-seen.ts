// What a shell command shows the model of a file, or makes of it, for the
// overwrite guard of Write (guardOverwrite in files.ts): a file the session
// saw whole in a command's output, or made with a command of its own, is one it
// knows. Read from the command's words and the file's size, no model.
import { statSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { segments, withoutHeredocs } from "../engine/work-calls.ts";
import { realOf } from "../core/paths.ts";
import type { ToolContext } from "./types.ts";

// A command's output past this is cut before the model reads it (INLINE_OK in claude.ts).
export const INLINE = 30_000;

const WHOLE = new Set(["cat", "nl", "bat", "batcat", "less", "more"]);
const words = (s: string) => s.trim().split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, "")).filter(Boolean);
const plain = (a: string) => a !== "" && !/[<>$`*?~{}()\\]/.test(a);
const at = (dir: string, p: string) => (isAbsolute(p) ? p : resolve(dir, p));

// `end`: the lines are the file's last ones (tail), not its first.
export type Shown = { path: string; lines: number; end?: true };

// The files a command prints from their first line, and how many lines it prints
// at most (Infinity for the whole file): `cat F`, `sed -n 1,$p F`, `head -n N F`,
// `tail -n N F`. A file is whole when it has no more lines than that. A command
// that filters its output through a pipe shows what the filter keeps: no read.
// `dir`: where the command starts; a `cd` to a plain path moves it.
export function shown(command: string, dir: string): Shown[] {
  const text = withoutHeredocs(command);
  const piped = /(^|[^|])\|([^|]|$)/.test(text);
  const out: Shown[] = [];
  let here = dir;
  for (const seg of segments(command)) {
    const w = words(seg);
    let i = 0;
    while (i < w.length && /^\w+=/.test(w[i]!)) i++;
    const name = (w[i] ?? "").split("/").pop() ?? "";
    const args = w.slice(i + 1);
    if (name === "cd") { if (args[0] && plain(args[0]) && args[0] !== "-") here = at(here, args[0]); continue; }
    if (piped || (!WHOLE.has(name) && name !== "head" && name !== "tail" && name !== "sed")) continue;
    if (/(^|[^2&])>/.test(seg.replace(/\d?>\s*\/dev\/null|2>&1/g, ""))) continue;
    let lines = Infinity;
    const files: string[] = [];
    let script = name === "sed";
    let sedQuiet = false;
    let ok = true;
    for (let k = 0; k < args.length; k++) {
      const a = args[k]!;
      if (name === "sed" && a === "-n") { sedQuiet = true; continue; }
      if (name === "sed" && (a === "-e" || a === "-i" || a.startsWith("-i") || a === "-s" || a === "-E" || a === "-r")) { if (a !== "-E" && a !== "-r") ok = false; continue; }
      if (name === "head" || name === "tail") {
        const m = /^-n?(\d+)$/.exec(a) ?? /^--lines=(\d+)$/.exec(a);
        if (m) { lines = Number(m[1]); continue; }
        if (a === "-n" || a === "--lines") { const v = args[++k] ?? ""; if (/^\d+$/.test(v)) lines = Number(v); else ok = false; continue; }
        if (/^-[cqvz]|^--bytes|^-c/.test(a)) { ok = false; continue; }
      }
      if (a.startsWith("-") && a.length > 1) continue;
      if (script && name === "sed") {
        script = false;
        const m = /^(?:1,(\d+|\$))?p$/.exec(a);
        if (!sedQuiet || !m) ok = false;
        else if (m[1] && m[1] !== "$") lines = Number(m[1]);
        continue;
      }
      files.push(a);
    }
    if (name === "head" && lines === Infinity) lines = 10;
    if (name === "tail" && lines === Infinity) lines = 10;
    if (!ok) continue;
    for (const f of files) if (plain(f)) out.push({ path: at(here, f), lines, ...(name === "tail" ? { end: true as const } : {}) });
  }
  return out;
}

// The files a command writes with a redirect or tee: its own, whatever they held.
export function made(command: string, dir: string): string[] {
  const out: string[] = [];
  let here = dir;
  for (const seg of segments(command)) {
    const w = words(seg);
    if (w[0] === "cd" && w[1] && plain(w[1])) { here = at(here, w[1]); continue; }
    for (const m of seg.matchAll(/(?:^|[^0-9&>])>{1,2}\s*(?!&)([^\s;&|<>]+)/g)) {
      const p = m[1]!.replace(/^['"]|['"]$/g, "");
      if (plain(p) && !p.startsWith("/dev/")) out.push(at(here, p));
    }
    const t = w.indexOf("tee");
    if (t >= 0) for (const a of w.slice(t + 1)) if (!a.startsWith("-") && plain(a) && !a.startsWith("/dev/")) out.push(at(here, a));
  }
  return out;
}

// A file longer than this is not one a command's output held whole (the output is cut at INLINE), and is not
// read to count its lines: the count reads the whole file on the loop.
export const SEEN_BYTES = INLINE - 2_000;
export const lineCount = (p: string) => { const t = readFileSync(p, "utf8"); return t === "" ? 0 : t.split("\n").length - (t.endsWith("\n") ? 1 : 0); };

// After a command that ended with status 0: the files it showed whole and the
// files it made are ones the session knows (`ctx.seen`, by the file's time).
export function markSeen(ctx: ToolContext, command: string, dir: string, output: string): void {
  try {
    for (const s of shown(command, dir)) {
      const st = statSync(s.path);
      if (!st.isFile() || st.size > SEEN_BYTES || output.length > INLINE) continue;
      if (Number.isFinite(s.lines) && lineCount(s.path) > s.lines) continue;
      ctx.seen.set(realOf(s.path), st.mtimeMs);
    }
    for (const p of made(command, dir)) {
      const st = statSync(p);
      if (st.isFile()) ctx.seen.set(realOf(p), st.mtimeMs);
    }
  } catch {}
}
