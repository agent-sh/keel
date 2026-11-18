// The tool profile Claude models were trained on (Claude Code's names and
// shapes): Bash, Read, Write, Edit, Glob, Grep.
import { statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { fail, ok, type Tool, type ToolContext } from "./types.ts";
import { spill } from "./spill.ts";

const abs = (p: string, ctx: ToolContext) => (isAbsolute(p) ? p : resolve(ctx.cwd, p));
const mtime = (p: string) => { try { return statSync(p).mtimeMs; } catch { return -1; } };

const Bash: Tool = {
  name: "Bash",
  readOnly: false,
  description:
    "Run a bash command in the session's working directory and return stdout and stderr. " +
    "Use for builds, tests, git and any shell work. Long output is cut and saved to a file whose path is given.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to run" },
      timeout: { type: "number", description: "Timeout in milliseconds (default 120000, max 600000)" },
      description: { type: "string", description: "What the command does, in 5-10 words" },
    },
    required: ["command"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const timeout = Math.min(Number(input.timeout) || 120_000, 600_000);
    const argv = ["bash", "-c", input.command];
    const proc = Bun.spawn(ctx.wrapSpawn ? ctx.wrapSpawn(argv) : argv, {
      cwd: ctx.cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env, KEEL_SESSION: ctx.sessionId },
      timeout,
      killSignal: "SIGKILL",
      signal: ctx.signal,
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    let text = out + (err ? (out ? "\n" : "") + err : "");
    if (proc.signalCode) text += `\n[killed: ${proc.signalCode}${proc.signalCode === "SIGKILL" ? `, timeout ${timeout} ms` : ""}]`;
    text = (await spill(text, ctx.spillDir, "bash")).trimEnd();
    const body = `${text || "(no output)"}\n[exit ${code}]`;
    return code === 0 ? ok(body) : fail(body);
  },
};

const Read: Tool = {
  name: "Read",
  readOnly: true,
  description:
    "Read a file. Returns lines numbered from 1 (cat -n style). Use offset and limit for large files. Images are returned as images.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path" },
      offset: { type: "number", description: "Line to start from (1-based)" },
      limit: { type: "number", description: "Number of lines (default 2000)" },
    },
    required: ["file_path"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const p = abs(input.file_path, ctx);
    const f = Bun.file(p);
    if (!(await f.exists())) return fail(`File does not exist: ${p}`);
    if (/^image\/(png|jpeg|gif|webp)$/.test(f.type)) {
      const data = Buffer.from(await f.arrayBuffer()).toString("base64");
      ctx.seen.set(p, mtime(p));
      return { content: [{ type: "image", media_type: f.type, data }] };
    }
    const text = await f.text();
    ctx.seen.set(p, mtime(p));
    if (!text) return ok("(empty file)");
    const lines = text.split("\n");
    const start = Math.max(1, Number(input.offset) || 1);
    const limit = Number(input.limit) || 2000;
    const slice = lines.slice(start - 1, start - 1 + limit);
    const body = slice.map((l, i) => `${String(start + i).padStart(6)}\t${l.length > 2000 ? l.slice(0, 2000) + "…" : l}`).join("\n");
    const more = start - 1 + limit < lines.length ? `\n[${lines.length - (start - 1 + limit)} more lines; use offset]` : "";
    return ok(body + more);
  },
};

function guardWrite(p: string, ctx: ToolContext): string | null {
  const m = mtime(p);
  if (m === -1) return null; // new file
  const seen = ctx.seen.get(p);
  if (seen === undefined) return `Read ${p} before changing it.`;
  if (seen !== m) return `${p} changed since it was read; Read it again.`;
  return null;
}

const Write: Tool = {
  name: "Write",
  readOnly: false,
  description: "Write a file, creating parent directories. An existing file must be Read first.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute path" },
      content: { type: "string" },
    },
    required: ["file_path", "content"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const p = abs(input.file_path, ctx);
    const g = guardWrite(p, ctx);
    if (g) return fail(g);
    await mkdir(dirname(p), { recursive: true });
    await Bun.write(p, input.content);
    ctx.seen.set(p, mtime(p));
    return ok(`Wrote ${p} (${input.content.split("\n").length} lines)`);
  },
};

const Edit: Tool = {
  name: "Edit",
  readOnly: false,
  description:
    "Replace an exact string in a file. old_string must match exactly once unless replace_all is set. Read the file first.",
  input_schema: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
    },
    required: ["file_path", "old_string", "new_string"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const p = abs(input.file_path, ctx);
    const g = guardWrite(p, ctx);
    if (g) return fail(g);
    const text = await Bun.file(p).text();
    if (input.old_string === input.new_string) return fail("old_string and new_string are the same.");
    const n = text.split(input.old_string).length - 1;
    if (n === 0) return fail("old_string not found in the file.");
    if (n > 1 && !input.replace_all) return fail(`old_string matches ${n} times; add context or set replace_all.`);
    const next = input.replace_all
      ? text.split(input.old_string).join(input.new_string)
      : text.replace(input.old_string, () => input.new_string);
    await Bun.write(p, next);
    ctx.seen.set(p, mtime(p));
    return ok(`Edited ${p} (${n} replacement${n > 1 ? "s" : ""})`);
  },
};

const Glob: Tool = {
  name: "Glob",
  readOnly: true,
  description: "Find files by glob pattern (e.g. src/**/*.ts), newest first.",
  input_schema: {
    type: "object",
    properties: { pattern: { type: "string" }, path: { type: "string" } },
    required: ["pattern"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const root = input.path ? abs(input.path, ctx) : ctx.cwd;
    const files: { p: string; m: number }[] = [];
    for await (const f of new Bun.Glob(input.pattern).scan({ cwd: root, absolute: true, onlyFiles: true })) {
      if (f.includes("/node_modules/") || f.includes("/.git/")) continue;
      files.push({ p: f, m: mtime(f) });
      if (files.length >= 5000) break;
    }
    files.sort((a, b) => b.m - a.m);
    if (!files.length) return ok("No files found.");
    return ok(files.slice(0, 200).map((f) => f.p).join("\n") + (files.length > 200 ? `\n[${files.length - 200} more]` : ""));
  },
};

const Grep: Tool = {
  name: "Grep",
  readOnly: true,
  description:
    "Search file contents with ripgrep. output_mode: files_with_matches (default), content (matching lines), count.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      glob: { type: "string" },
      output_mode: { type: "string", enum: ["content", "files_with_matches", "count"] },
      "-i": { type: "boolean" },
      "-n": { type: "boolean" },
      "-C": { type: "number" },
      head_limit: { type: "number" },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const args = ["rg", "--color=never", "--max-columns=500"];
    const mode = input.output_mode ?? "files_with_matches";
    if (mode === "files_with_matches") args.push("-l");
    else if (mode === "count") args.push("-c");
    else { args.push(input["-n"] === false ? "-N" : "-n"); if (input["-C"]) args.push("-C", String(input["-C"])); }
    if (input["-i"]) args.push("-i");
    if (input.glob) args.push("--glob", input.glob);
    args.push("--", input.pattern, input.path ? abs(input.path, ctx) : ctx.cwd);
    const proc = Bun.spawn(args, { cwd: ctx.cwd, stdout: "pipe", stderr: "pipe", signal: ctx.signal });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code === 1) return ok("No matches.");
    if (code !== 0) return fail(err || `rg exit ${code}`);
    let lines = out.trimEnd().split("\n");
    const limit = Number(input.head_limit) || 250;
    const extra = lines.length > limit ? `\n[${lines.length - limit} more]` : "";
    lines = lines.slice(0, limit);
    return ok(await spill(lines.join("\n") + extra, ctx.spillDir, "grep"));
  },
};

export const claudeTools: Tool[] = [Bash, Read, Write, Edit, Glob, Grep];
