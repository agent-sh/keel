// A search inside other harnesses' transcripts: which files hold every word
// of a query, anywhere in what was said (a reply, a command, its output), not
// only in the title, folder and prompts the index keeps. The files are read by
// ripgrep (or grep where it is missing) in a process of its own, two batches
// at a time, one thread each and at a lower priority, so the daemon's loop
// never reads them and the machine's other work goes first. Each word is a fixed
// string matched without case; every later word reads only the files that
// held the words before it.
import { setPriority } from "node:os";
import { readText } from "../../core/proc.ts";

// How many files one search process is given, and how many run at once: a
// search may read every transcript of every other harness (gigabytes), so it
// takes two of the machine's processors at most, at a nice of 10.
const BATCH = 400;
const AT_ONCE = 2;
const NICE = 10;

type Tool = "rg" | "grep";
let tool: Tool | null | undefined;

async function run(cmd: string[], signal?: AbortSignal): Promise<{ out: string; code: number }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore", signal });
  try { setPriority(p.pid, NICE); } catch {} // (a process that ended already)
  const [out, code] = await Promise.all([readText(p.stdout, "import search"), p.exited]);
  return { out, code };
}

// The program that reads the files: ripgrep when it runs here, else grep.
async function which(): Promise<Tool | null> {
  if (tool !== undefined) return tool;
  for (const t of ["rg", "grep"] as const) {
    try { if ((await run([t, "--version"])).code === 0) return (tool = t); } catch {}
  }
  return (tool = null);
}

const argsOf = (t: Tool, word: string) => t === "rg"
  ? ["rg", "-l", "-F", "-i", "-j", "1", "--no-ignore", "--hidden", "--no-messages", "--no-config", "-e", word, "--"]
  : ["grep", "-l", "-F", "-i", "-s", "-e", word, "--"];

// Of `files`, those that hold `word`.
async function holding(t: Tool, word: string, files: string[], signal?: AbortSignal): Promise<string[]> {
  const batches: string[][] = [];
  for (let i = 0; i < files.length; i += BATCH) batches.push(files.slice(i, i + BATCH));
  const out: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const b = batches[next++]!;
      const r = await run([...argsOf(t, word), ...b], signal);
      // 0: some matched; 1: none did; anything else is a failure of the read (a file gone meanwhile is not one: -s, --no-messages).
      if (r.code > 1 && !r.out) throw new Error(`${t} exited ${r.code}`);
      for (const l of r.out.split("\n")) if (l) out.push(l);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, batches.length) }, worker));
  return out;
}

// The files of `files` that hold every word. null: no program here can read them.
export async function filesWithAll(words: string[], files: string[], signal?: AbortSignal): Promise<Set<string> | null> {
  const t = await which();
  if (!t) return null;
  let left = files;
  // The longest word first: it is the rarest, and leaves the fewest files to the others.
  for (const w of [...words].sort((a, b) => b.length - a.length)) {
    if (!left.length) break;
    left = await holding(t, w, left, signal);
  }
  return new Set(words.length ? left : []);
}
