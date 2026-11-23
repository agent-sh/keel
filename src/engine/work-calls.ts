// What a tool call did to the files of the work, read from its name and input
// alone (no model, no disk): the files it read, for every family's tools.
// A compaction keeps the rules a session read in a file (a brief, a task
// file) as file statements (settle in compact.ts): only a read of a local
// file counts, never a web fetch, a search, an MCP tool or a command that
// reaches another machine.
import type { StoredEvent } from "../core/types.ts";

// Each family's own file readers (src/tools/claude.ts, gemini.ts): the path is in `file_path`.
const READERS = new Set(["Read", "read_file"]);
// The shell tools of each family, and where the command is in their input.
const SHELLS: Record<string, string> = { Bash: "command", run_shell_command: "command", exec_command: "cmd" };
// Programs that print a file they are given.
const PRINTERS = new Set(["cat", "head", "tail", "nl", "bat", "batcat", "less", "more", "sed"]);
// Programs whose output may come from another machine or the web: a command
// that runs one is not a read of a local file, whatever else it prints.
// (A local script that fetches a page cannot be told from its name; an
// interpreter's inline code is held to be one.)
const REMOTE = new Set([
  "curl", "wget", "gh", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "telnet", "ftp", "http", "https", "xh", "aria2c",
  "lynx", "w3m", "links", "websocat", "docker", "podman", "kubectl", "aws", "gcloud", "az",
  "python", "python3", "node", "bun", "deno", "perl", "ruby", "php", "uv", "uvx", "npx", "bunx",
]);

const words = (segment: string) => segment.trim().split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, "")).filter(Boolean);
const program = (w: string[]) => {
  let i = 0;
  while (i < w.length && (/^\w+=/.test(w[i]!) || ["sudo", "env", "nice", "time", "command", "exec", "nohup"].includes(w[i]!))) i++;
  return { name: (w[i] ?? "").split("/").pop() ?? "", args: w.slice(i + 1) };
};

// The commands of a shell line: split on its separators (a quoted separator
// splits too: a read is then missed, never invented).
export const segments = (command: string) => command.split(/&&|\|\||[;|\n]/).filter((s) => s.trim());

// The files a shell command prints, when that is all it can show of the
// outside: [] when it prints none or runs a program that can reach another
// machine. A redirect to a file is a copy, not a read.
export function shellReads(command: string): string[] {
  const out: string[] = [];
  for (const seg of segments(command)) {
    const { name, args } = program(words(seg));
    if (REMOTE.has(name)) return [];
    if (name === "git" && /^(fetch|pull|clone|ls-remote|remote)$/.test(args[0] ?? "")) return [];
    if (!PRINTERS.has(name) || /(^|[^2&])>/.test(seg.replace(/\d?>\s*\/dev\/null|2>&1/g, ""))) continue;
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

export type FileText = { paths: string[]; text: string };

// The outputs of the branch's local file reads that ran, newest first.
// `keep`: a test of a read's text (a caller keeps only those that hold what it looks for).
export function fileTexts(lineage: readonly Pick<StoredEvent, "kind" | "data">[], keep: (text: string) => boolean = () => true): FileText[] {
  const calls = new Map<string, string[]>();
  const out: FileText[] = [];
  for (const e of lineage) {
    if (e.kind === "assistant") {
      for (const b of e.data.blocks ?? []) if (b.type === "tool_use") { const p = fileReads(b.name, b.input); if (p.length) calls.set(b.id, p); }
    } else if (e.kind === "tool_result") {
      for (const r of e.data.results ?? []) {
        const paths = calls.get(r.tool_use_id);
        // (A command that failed still printed what it printed: the words are matched, not the status.)
        if (!paths) continue;
        const text = resultText(r.content);
        if (keep(text)) out.push({ paths, text });
      }
    }
  }
  return out.reverse();
}
