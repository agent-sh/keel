// What a tool call did to the files of the work, read from its name and input
// alone (no model, no disk): the files it read, for every family's tools.
// A compaction keeps the lines a session read in a file (a brief, a task
// file) as file statements (settle in compact.ts): only a read of a local
// file counts, never a web fetch, a search, an MCP tool, a command that runs
// anything but a printer, or a file the session downloaded.
import type { StoredEvent } from "../core/types.ts";

// Each family's own file readers (src/tools/claude.ts, gemini.ts): the path is in `file_path`.
const READERS = new Set(["Read", "read_file"]);
// The shell tools of each family, and where the command is in their input.
const SHELLS: Record<string, string> = { Bash: "command", run_shell_command: "command", exec_command: "cmd" };
// Programs that print a file they are given.
const PRINTERS = new Set(["cat", "head", "tail", "nl", "bat", "batcat", "less", "more", "sed"]);
// What else a command that reads a file may run: it moves to a folder or
// prints its own words. A command with any other program in it (a wrapper
// such as timeout or xargs, a script, a build tool) may print what came from
// anywhere, so it is not a read of a local file.
const QUIET = new Set(["cd", "echo", "printf", "pwd", "true"]);
// Programs that fetch from another machine or the web: a file one of them
// writes holds what it fetched, not a local file's words.
const REMOTE = new Set([
  "curl", "wget", "gh", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "telnet", "ftp", "http", "https", "xh", "aria2c",
  "lynx", "w3m", "links", "websocat", "docker", "podman", "kubectl", "aws", "gcloud", "az",
  "python", "python3", "node", "bun", "deno", "perl", "ruby", "php", "uv", "uvx", "npx", "bunx",
]);

const words = (segment: string) => segment.trim().split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, "")).filter(Boolean);
// A segment's program and its arguments, past variable assignments only:
// a wrapper (sudo, timeout, env) is the program, and it is not a printer.
const program = (w: string[]) => {
  let i = 0;
  while (i < w.length && /^\w+=/.test(w[i]!)) i++;
  return { name: (w[i] ?? "").split("/").pop() ?? "", args: w.slice(i + 1) };
};

// A shell line without the bodies of its here-documents: what a heredoc
// holds is a program's input or a file's text (a script, code with `>` in
// it), not commands of the line.
export function withoutHeredocs(command: string): string {
  const out: string[] = [];
  let end: string | null = null;
  for (const l of command.split("\n")) {
    if (end !== null) { if (l.trim() === end) end = null; continue; }
    out.push(l);
    const m = l.match(/<<-?\s*['"]?([\w.-]+)['"]?/);
    if (m) end = m[1]!;
  }
  return out.join("\n");
}

// The commands of a shell line: split on its separators (a quoted separator
// splits too: a read is then missed, never invented).
export const segments = (command: string) => withoutHeredocs(command).split(/&&|\|\||[;|\n]/).filter((s) => s.trim());

// The files a shell command prints, when that is all it shows: every
// program of it is a printer or moves and prints its own words (QUIET);
// [] otherwise. A redirect to a file is a copy, not a read.
export function shellReads(command: string): string[] {
  const out: string[] = [];
  for (const seg of segments(command)) {
    const { name, args } = program(words(seg));
    if (QUIET.has(name)) continue;
    if (!PRINTERS.has(name)) return [];
    if (/(^|[^2&])>/.test(seg.replace(/\d?>\s*\/dev\/null|2>&1/g, ""))) continue;
    let script = name === "sed" && !args.includes("-e");
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a.startsWith("-")) { if ((name === "head" || name === "tail") && /^-[nc]$/.test(a)) i++; continue; }
      if (script) { script = false; continue; }
      if (/[<>$`*?]/.test(a)) continue;
      out.push(a);
    }
  }
  return out;
}

// The local files a call read, [] when it read none.
export function fileReads(name: string, input: any): string[] {
  if (READERS.has(name)) return typeof input?.file_path === "string" && input.file_path ? [input.file_path] : [];
  const key = SHELLS[name];
  return key && typeof input?.[key] === "string" ? shellReads(input[key]) : [];
}

// A tool result's text, with the line numbers a reader puts before each line
// (`N<tab>`, as Read and `nl` write them) taken off.
export function resultText(content: unknown): string {
  const t = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n") : "";
  return t.replace(/^ *\d+\t/gm, "");
}

// The files a shell command downloads: what a fetching program writes with
// its output flags, by name from the URL, or where the line's output is
// redirected or copied (tee); the local end of a copy from another machine.
export function shellDownloads(command: string): string[] {
  const out: string[] = [];
  const segs = segments(command);
  const fetches = segs.some((seg) => REMOTE.has(program(words(seg)).name) || /^git$/.test(program(words(seg)).name) && /\b(clone|fetch|pull)\b/.test(seg));
  if (!fetches) return out;
  for (const seg of segs) {
    const { name, args } = program(words(seg));
    for (const m of seg.matchAll(/(?:^|[^0-9&>])>{1,2}\s*([^\s;&|]+)/g)) out.push(m[1]!.replace(/^['"]|['"]$/g, ""));
    if (name === "tee") out.push(...args.filter((a) => !a.startsWith("-")));
    if (!REMOTE.has(name)) continue;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      const eq = a.match(/^--(?:output|output-document)=(.+)$/);
      if (eq) out.push(eq[1]!);
      else if (/^(-o|-O|--output|--output-document)$/.test(a) && args[i + 1] && !(name === "curl" && a === "-O")) out.push(args[++i]!);
    }
    // A file named from the URL: curl -O, a plain wget.
    const url = args.find((a) => /^https?:\/\//.test(a));
    if (url && ((name === "curl" && args.some((a) => a === "-O" || a === "--remote-name")) || (name === "wget" && !args.some((a) => /^(-O|--output-document)/.test(a))))) {
      const base = url.replace(/[?#].*$/, "").split("/").filter(Boolean).pop();
      if (base && !/^https?:$/.test(base)) out.push(base);
    }
    // scp and rsync: the destination, when it is local.
    if ((name === "scp" || name === "rsync") && args.length && !args.at(-1)!.includes(":")) out.push(args.at(-1)!);
  }
  return out.filter((p) => p && !p.startsWith("/dev/"));
}

export type FileText = { paths: string[]; text: string };

const samePath = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

// Reads the outputs of a branch's local file reads, event by event (the read
// thread hands it a session's rounds as it reads them): what `keep` takes
// of each read's text, newest first. A read of a file the branch downloaded
// before it is not a local file's words. (A command that failed still
// printed what it printed: the words are matched, not the status.)
export function fileReader(keep: (text: string) => boolean = () => true) {
  const calls = new Map<string, string[]>();
  const downloaded: string[] = [];
  const out: FileText[] = [];
  return {
    add(e: Pick<StoredEvent, "kind" | "data">) {
      if (e.kind === "assistant") {
        for (const b of e.data.blocks ?? []) {
          if (b.type !== "tool_use") continue;
          const key = SHELLS[b.name];
          if (key && typeof b.input?.[key] === "string") downloaded.push(...shellDownloads(b.input[key]));
          const p = fileReads(b.name, b.input).filter((x) => !downloaded.some((d) => samePath(d, x)));
          if (p.length) calls.set(b.id, p);
        }
      } else if (e.kind === "tool_result") {
        for (const r of e.data.results ?? []) {
          const paths = calls.get(r.tool_use_id);
          if (!paths) continue;
          const text = resultText(r.content);
          if (keep(text)) out.unshift({ paths, text });
        }
      }
    },
    texts: (): FileText[] => out,
  };
}

// The outputs of the branch's local file reads that ran, newest first.
// `keep`: a test of a read's text (a caller keeps only those that hold what it looks for).
export function fileTexts(lineage: readonly Pick<StoredEvent, "kind" | "data">[], keep: (text: string) => boolean = () => true): FileText[] {
  const r = fileReader(keep);
  for (const e of lineage) r.add(e);
  return r.texts();
}
