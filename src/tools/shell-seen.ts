// What a shell command shows the model of a file, or makes of it, for the
// overwrite guard of Write (guardOverwrite in files.ts): a file the session
// saw whole in a command's output, or made with a command of its own, is one it
// knows. Read from the command's words and the file's size, no model.
import { statSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { withoutHeredocs } from "../engine/work-calls.ts";
import { realOf } from "../core/paths.ts";
import { splitCommand, type Simple } from "../safety/shell.ts";
import type { ToolContext } from "./types.ts";

// A command's output past this is cut before the model reads it (INLINE_OK in claude.ts).
export const INLINE = 30_000;
// Whether the model reads all of a command's output: the shell tool cuts it past INLINE, and the engine cuts a
// result past what the session keeps inline for what carrying it costs (`ctx.inline`, src/tools/carry.ts).
export const uncut = (ctx: Pick<ToolContext, "inline">, output: string) => output.length <= Math.min(INLINE, ctx.inline?.cap ?? INLINE);

const WHOLE = new Set(["cat", "nl", "bat", "batcat", "less", "more"]);
const plain = (a: string) => a !== "" && !/[<>$`*?~{}()[\]\\'"&]/.test(a);
const at = (dir: string, p: string) => (isAbsolute(p) ? p : resolve(dir, p));
const groupRedirect = /[})][ \t]*(?:[0-9]+|&)?[<>]/;
const program = (w: string[]) => {
  let i = 0;
  while (i < w.length && /^\w+=/.test(w[i]!)) i++;
  return { name: (w[i] ?? "").split("/").pop() ?? "", args: w.slice(i + 1) };
};
const changesDir = (name: string) => name === "cd" || name === "pushd" || name === "popd";
const partsOf = (command: string): Simple[] =>
  groupRedirect.test(withoutHeredocs(command)) ? [] : splitCommand(command)?.filter((p) => !p.heredoc) ?? [];

// Follow only a plain `cd path && ...`: the next command depends on success.
// A different form, including a wrapped or nested cd, leaves later paths unknown.
function* located(parts: Simple[], dir: string) {
  let here = dir;
  let moved = false;
  const fallback = parts.some((p) => p.sep === "||");
  for (const part of parts) {
    if (part.words.some((w) => /^CDPATH\+?=/.test(w))) break;
    if (part.words.some(changesDir)) {
      const [cmd, path] = part.words;
      if (cmd !== "cd" || !path || part.words.length !== 2 || !plain(path) || path.startsWith("-") ||
          part.nested || part.flow || part.unknown || part.dyn || /[<>]/.test(part.text) ||
          part.sep !== "&&" || part.led || fallback) break;
      here = at(here, path);
      moved = true;
      continue;
    }
    if (!part.nested && !part.flow && !part.unknown) yield { ...program(part.words), part, here };
    // After an independent command boundary, the overall exit code no longer proves the cd ran.
    if (moved && part.sep !== "&&") break;
  }
}

// `end`: the lines are the file's last ones (tail), not its first.
export type Shown = { path: string; lines: number; end?: true };

// The files a command prints from their first line, and how many lines it prints
// at most (Infinity for the whole file): `cat F`, `sed -n 1,$p F`, `head -n N F`,
// `tail -n N F`. A file is whole when it has no more lines than that. A command
// that filters its output through a pipe shows what the filter keeps: no read.
// `dir`: where the command starts; a `cd` to a plain path moves it.
export function shown(command: string, dir: string): Shown[] {
  const parts = partsOf(command);
  if (parts.some((p) => p.sep === "|" || p.sep === "|&" || p.led === "|" || p.led === "|&")) return [];
  const out: Shown[] = [];
  for (const { name, args, part, here } of located(parts, dir)) {
    if (part.dyn || (!WHOLE.has(name) && name !== "head" && name !== "tail" && name !== "sed")) continue;
    // The error stream sent anywhere takes nothing from what the command shows.
    const seg = part.text.replace(/(^|\s)2>>?\s*(&1|[^\s&|;<>]+)/g, "$1");
    // Any other redirect (to a file, to /dev/null, `&>`) sends the lines somewhere the model does not read.
    if (seg.includes(">")) continue;
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
    // Sed numbers across its operands unless run with -s, which we do not credit.
    const read = name === "sed" && Number.isFinite(lines) ? files.slice(0, 1) : files;
    for (const f of read) if (plain(f)) out.push({ path: at(here, f), lines, ...(name === "tail" ? { end: true as const } : {}) });
  }
  return out;
}

// The files a command writes with a redirect or tee: its own, whatever they held.
export function made(command: string, dir: string): string[] {
  const out: string[] = [];
  for (const { name, args, part, here } of located(partsOf(command), dir)) {
    // An append does not replace the text that was already there.
    for (const m of part.text.matchAll(/(?:^|[^0-9&<>])>(?![>&])\s*([^\s;&|<>]+)/g)) {
      const p = m[1]!.replace(/^['"]|['"]$/g, "");
      if (plain(p) && !p.startsWith("/dev/")) out.push(at(here, p));
    }
    if (name === "tee" && !part.dyn && !args.some((a) => a === "--append" || /^-[^-]*a/.test(a))) {
      for (const a of args) if (!a.startsWith("-") && plain(a) && !a.startsWith("/dev/")) out.push(at(here, a));
    }
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
      if (!st.isFile() || st.size > SEEN_BYTES || !uncut(ctx, output)) continue;
      if (Number.isFinite(s.lines) && lineCount(s.path) > s.lines) continue;
      ctx.seen.set(realOf(s.path), st.mtimeMs);
    }
    for (const p of made(command, dir)) {
      const st = statSync(p);
      if (st.isFile()) ctx.seen.set(realOf(p), st.mtimeMs);
    }
  } catch {}
}
