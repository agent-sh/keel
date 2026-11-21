// The tool profile Gemini models are trained on: Gemini CLI's names and
// shapes (packages/core/src/tools/definitions/model-family-sets/gemini-3.ts).
import { readdirSync, statSync } from "node:fs";
import { claimNote, isClaimFile } from "../core/claim.ts";
import { decodeText } from "../core/text.ts";
import { join } from "node:path";
import { notFound } from "./missing.ts";
import { abs, editFile, globFiles, guardOverwrite, lineRange, mtime, numbered, readFile, ripgrep, WHOLE_FILE_BYTES, writeFile } from "./files.ts";
import { answerText, ask, type Question } from "./interact.ts";
import { jobsOf, running, waitJob } from "./jobs.ts";
import { headTail, runShell, shellCwd } from "./shell.ts";
import { skillTool } from "./skills.ts";
import { fail, ok, type Tool } from "./types.ts";
import { fetchFor, webSearch } from "./web.ts";

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required });

const run_shell_command: Tool = {
  name: "run_shell_command",
  readOnly: false,
  kind: "shell",
  cwdOf: (ctx, input) => input?.dir_path ? abs(input.dir_path, ctx) : shellCwd(ctx),
  autoShell: ({ command, ...options }) => typeof command === "string" ? { command, interpreter: "bash -c", options } : undefined,
  description:
    "Executes a given shell command as `bash -c <command>`. Set is_background for servers and watchers; " +
    "a command still running after 5 minutes moves to the background. The result gives Output, Exit Code and " +
    "Background PIDs.",
  input_schema: obj({
    command: { type: "string", description: "Exact bash command to execute as `bash -c <command>`" },
    description: { type: "string", description: "Brief description of the command for the user." },
    dir_path: { type: "string", description: "Optional: the absolute path of the directory to run the command in." },
    is_background: { type: "boolean", description: "Set to true if this command should be run in the background (e.g. for long-running servers or watchers). The command will be started, allowed to run for a brief moment to check for immediate errors, and then moved to the background." },
    delay_ms: { type: "integer", description: "Optional. Delay in milliseconds to wait after starting the process in the background. Useful to allow the process to start and generate initial output before returning." },
  }, ["command"]),
  async run(input, ctx) {
    // A background start with a delay runs in front for that long, then moves behind.
    const delay = input.is_background ? Math.max(0, Number(input.delay_ms) || 0) : 0;
    const r = await runShell(ctx, {
      command: String(input.command ?? ""), description: input.description, cwd: input.dir_path ? abs(input.dir_path, ctx) : undefined,
      timeoutMs: delay || 300_000, background: !!input.is_background && !delay, onTimeout: "background",
    });
    if (r.state === "refused") return fail(r.error);
    if (r.state === "running") {
      return ok(`Command moved to the background.\nBackground PIDs: ${r.job.pid}\nOutput file: ${r.job.log}${r.output.trim() ? `\nOutput so far: ${headTail(r.output, 2000)}` : ""}`);
    }
    const out = headTail(r.output.trimEnd(), 30_000) || "(empty)";
    const lines = [`Command: ${input.command}`, `Directory: ${r.job.cwd}`, `Output: ${out}`, `Exit Code: ${r.exitCode ?? "(none)"}`];
    if (r.signal) lines.push(`Signal: ${r.signal}`);
    if (r.cwdNote) lines.push(r.cwdNote);
    return { content: lines.join("\n"), is_error: r.exitCode !== 0 || !!r.signal };
  },
};

const read_file: Tool = {
  name: "read_file",
  readOnly: true,
  description: "Reads and returns the content of a specified file. Use start_line and end_line for targeted reads of long files. Handles text, images and PDF files.",
  input_schema: obj({
    file_path: { type: "string", description: "The path to the file to read." },
    start_line: { type: "integer", description: "Optional: the 1-based line number to start reading from." },
    end_line: { type: "integer", description: "Optional: the 1-based line number to end reading at (inclusive)." },
  }, ["file_path"]),
  async run(input, ctx) {
    const p = abs(String(input.file_path ?? ""), ctx);
    const s = Number(input.start_line) || undefined;
    const e = Number(input.end_line) || undefined;
    if (s || e) {
      if (mtime(p) === -1) return fail(notFound(p, ctx.cwd));
      if (isClaimFile(p)) return fail(claimNote(p));
      const limit = e ? e - (s ?? 1) + 1 : undefined;
      if (limit !== undefined && limit < 1) return fail(`end_line ${e} is before start_line ${s}: no line is in that range. Leave end_line out to read on from start_line.`);
      if (Bun.file(p).size > WHOLE_FILE_BYTES) {
        // Too large to read whole: only the lines up to the range's end are read.
        const r = await lineRange(p, { offset: s ?? 1, limit, number: false, signal: ctx.signal });
        if (r.stopped) return fail(`The read of ${p} was stopped before it reached line ${s ?? 1}.`);
        ctx.seen.set(p, mtime(p));
        return r.past ? fail(`${p} has ${r.total} lines; line ${s} is past the end.`) : ok(r.body);
      }
      const { text } = decodeText(new Uint8Array(await Bun.file(p).arrayBuffer()));
      ctx.seen.set(p, mtime(p));
      // As a whole read says it: an empty file has no line 1 to be past.
      if (!text) return ok(`${p} exists but is empty.`);
      const r = numbered(text, s ?? 1, limit, false);
      // The same answer as for a file read in chunks: a start past the end is said, not an empty success.
      return s && s > r.total ? fail(`${p} has ${r.total} lines; line ${s} is past the end.`) : ok(r.body);
    }
    const r = await readFile(p, ctx, {});
    if (typeof r.content === "string" && !r.error) return ok(r.content.replace(/^ *\d+\t/gm, ""));
    return { content: r.content, is_error: r.error };
  },
};

const write_file: Tool = {
  name: "write_file",
  readOnly: false,
  kind: "edit",
  description: "Writes the complete content to a file, automatically creating missing parent directories. Overwrites existing files. Best for new or small files; use 'replace' for targeted edits.",
  input_schema: obj({
    file_path: { type: "string", description: "Path to the file." },
    content: { type: "string", description: "The content to write to the file. Do not use omission placeholders; provide complete literal content." },
  }, ["file_path", "content"]),
  async run(input, ctx) {
    const p = abs(String(input.file_path ?? ""), ctx);
    const existed = mtime(p) !== -1;
    const g = guardOverwrite(p, ctx);
    if (g) return fail(g);
    await writeFile(p, String(input.content ?? ""), ctx);
    return ok(existed ? `Successfully overwrote file: ${p}.` : `Successfully created and wrote to new file: ${p}.`);
  },
};

const replace: Tool = {
  name: "replace",
  readOnly: false,
  kind: "edit",
  description:
    "Replaces text within a file. By default, the tool expects to find and replace exactly ONE occurrence of `old_string`. " +
    "Set `allow_multiple` to replace every occurrence. Include enough surrounding context to target one place.",
  input_schema: obj({
    file_path: { type: "string", description: "The path to the file to modify." },
    instruction: { type: "string", description: "A clear, semantic instruction for the code change." },
    old_string: { type: "string", description: "The exact literal text to replace, including whitespace and indentation." },
    new_string: { type: "string", description: "The exact literal text to replace `old_string` with." },
    allow_multiple: { type: "boolean", description: "If true, the tool will replace all occurrences of `old_string`." },
  }, ["file_path", "instruction", "old_string", "new_string"]),
  async run(input, ctx) {
    const p = abs(String(input.file_path ?? ""), ctx);
    if (input.old_string === "" && mtime(p) === -1) {
      await writeFile(p, String(input.new_string ?? ""), ctx);
      return ok(`Created new file: ${p} with provided content.`);
    }
    const r = await editFile(p, String(input.old_string ?? ""), String(input.new_string ?? ""), !!input.allow_multiple, ctx);
    if ("error" in r) return fail(`Failed to edit: ${r.error}`);
    return ok(`Successfully modified file: ${p}.${r.ok}`);
  },
};

const glob: Tool = {
  name: "glob",
  readOnly: true,
  description: "Efficiently finds files matching specific glob patterns (e.g., `src/**/*.ts`, `**/*.md`), returning absolute paths sorted by modification time (newest first).",
  input_schema: obj({
    pattern: { type: "string", description: "The glob pattern to match against (e.g., '**/*.py', 'docs/*.md')." },
    dir_path: { type: "string", description: "Optional: the absolute path to the directory to search within." },
    case_sensitive: { type: "boolean" },
    respect_git_ignore: { type: "boolean" },
  }, ["pattern"]),
  async run(input, ctx) {
    const root = input.dir_path ? abs(input.dir_path, ctx) : ctx.cwd;
    const r = await globFiles(String(input.pattern ?? ""), root, ctx.cwd, 200);
    if ("error" in r) return fail(r.error);
    const stopped = r.stopped ? `\n(${r.stopped})` : "";
    if (!r.files.length) return ok(`No files found matching pattern "${input.pattern}" within ${root}${stopped}`);
    // A scan cut at its ceiling orders only what it examined, and says so.
    const order = r.ceiling ? "newest first among the matches examined" : "sorted by modification time (newest first)";
    return ok(`Found ${r.files.length}${r.truncated ? "+" : ""} file(s) matching "${input.pattern}" within ${root}, ${order}:\n${r.files.join("\n")}${r.ceiling ? `\n(${r.ceiling})` : ""}${stopped}`);
  },
};

const grep_search: Tool = {
  name: "grep_search",
  readOnly: true,
  description: "Searches for a regular expression pattern within file contents (ripgrep). Returns matching lines with file paths and line numbers.",
  input_schema: obj({
    pattern: { type: "string", description: "The pattern to search for (Rust-flavored regex by default)." },
    dir_path: { type: "string", description: "Directory or file to search. Defaults to the working directory." },
    include_pattern: { type: "string", description: "Glob pattern to filter files (e.g., '*.ts', 'src/**')." },
    exclude_pattern: { type: "string", description: "Regex to exclude matching lines from the results." },
    names_only: { type: "boolean", description: "Only return file paths." },
    case_sensitive: { type: "boolean", description: "Case-sensitive search (default false)." },
    fixed_strings: { type: "boolean", description: "Treat pattern as a literal string." },
    context: { type: "integer" }, after: { type: "integer" }, before: { type: "integer" },
    no_ignore: { type: "boolean" },
    max_matches_per_file: { type: "integer" },
    total_max_matches: { type: "integer", description: "Maximum total matches to return (default 100)." },
  }, ["pattern"]),
  async run(input, ctx) {
    const r = await ripgrep({
      pattern: String(input.pattern ?? ""), path: input.dir_path, glob: input.include_pattern, fixed: input.fixed_strings,
      mode: input.names_only ? "files_with_matches" : "content", ignoreCase: input.case_sensitive !== true,
      context: input.context, after: input.after, before: input.before, headLimit: Number(input.total_max_matches) || 100,
    }, ctx);
    let text = r.text;
    if (input.exclude_pattern && !r.error) {
      try { const re = new RegExp(input.exclude_pattern); text = text.split("\n").filter((l) => !re.test(l)).join("\n"); } catch {}
    }
    return { content: text, is_error: r.error };
  },
};

const list_directory: Tool = {
  name: "list_directory",
  readOnly: true,
  description: "Lists the names of files and subdirectories directly within a specified directory path.",
  input_schema: obj({
    dir_path: { type: "string", description: "The path to the directory to list" },
    ignore: { type: "array", items: { type: "string" }, description: "List of glob patterns to ignore" },
  }, ["dir_path"]),
  async run(input, ctx) {
    const dir = abs(String(input.dir_path ?? "."), ctx);
    let names: string[];
    try { names = readdirSync(dir); } catch { return fail(`Directory not found or not readable: ${dir}`); }
    const ign = (input.ignore ?? []).map((g: string) => new Bun.Glob(g));
    const rows = names.filter((n) => !ign.some((g: any) => g.match(n))).map((n) => {
      let d = false;
      try { d = statSync(join(dir, n)).isDirectory(); } catch {}
      return { n, d };
    }).sort((a, b) => Number(b.d) - Number(a.d) || a.n.localeCompare(b.n));
    return ok(`Directory listing for ${dir}:\n${rows.map((r) => (r.d ? `[DIR] ${r.n}` : r.n)).join("\n")}`);
  },
};

const write_todos: Tool = {
  name: "write_todos",
  readOnly: true,
  description: "Keeps the list of subtasks for a complex request, shown to the user. Send the whole list each time; one task in_progress at a time.",
  input_schema: obj({
    todos: {
      type: "array", description: "The complete list of todo items. This will replace the existing list.",
      items: obj({
        description: { type: "string", description: "The description of the task." },
        status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"], description: "The current status of the task." },
      }, ["description", "status"]),
    },
  }, ["todos"]),
  async run(input) {
    const t: any[] = input.todos ?? [];
    return ok(`Successfully updated the todo list. The current list is now:\n${t.map((x, i) => `${i + 1}. [${x.status}] ${x.description}`).join("\n")}`);
  },
};

const google_web_search: Tool = {
  name: "google_web_search",
  readOnly: true,
  description: "Searches the web and returns results with titles, URLs and snippets. Follow up with 'web_fetch' to read a result.",
  input_schema: obj({ query: { type: "string", description: "The search query to find information on the web." } }, ["query"]),
  async run(input, ctx) {
    const r = await webSearch(String(input.query ?? ""), {}, ctx.signal);
    return { content: r.text, is_error: r.error };
  },
};

const web_fetch: Tool = {
  name: "web_fetch",
  readOnly: true,
  description: "Fetches up to 20 URLs named in the prompt (http/https) and answers the prompt from their content.",
  input_schema: obj({
    prompt: { type: "string", description: "A prompt that includes the URL(s) (up to 20) to fetch and what to look for." },
  }, ["prompt"]),
  async run(input, ctx) {
    const urls = [...new Set(String(input.prompt ?? "").match(/https?:\/\/[^\s<>"')\]]+/g) ?? [])].slice(0, 20);
    if (!urls.length) return fail("The prompt must contain at least one URL starting with http:// or https://.");
    const parts = await Promise.all(urls.map(async (u) => {
      const r = await fetchFor(u, String(input.prompt), ctx).catch((e) => ({ text: String(e.message), error: true }));
      return `--- ${u} ---\n${r.text}`;
    }));
    return ok(parts.join("\n\n"));
  },
};

const ask_user: Tool = {
  name: "ask_user",
  readOnly: true,
  asksOwner: true,
  description: "Ask the user one or more questions to gather preferences or clarify requirements, and wait for the answers.",
  input_schema: obj({
    questions: {
      type: "array", minItems: 1, maxItems: 4,
      items: obj({
        question: { type: "string", description: "The complete question to ask the user." },
        header: { type: "string", description: "Very short label (max 16 chars)." },
        type: { type: "string", enum: ["choice", "text", "yesno"], description: "Question type (default choice)." },
        options: { type: "array", items: obj({ label: { type: "string" }, description: { type: "string" } }, ["label", "description"]) },
        multiSelect: { type: "boolean" },
        placeholder: { type: "string" },
      }, ["question", "header", "type"]),
    },
  }, ["questions"]),
  async run(input, ctx) {
    const qs: Question[] = (input.questions ?? []).map((q: any, i: number) => ({
      id: String(i), ...q, options: q.type === "yesno" ? [{ label: "Yes" }, { label: "No" }] : q.options ?? [],
    }));
    const a = await ask(ctx);
    if (!a) return fail("The user did not answer; the turn was interrupted.");
    return { ...ok(JSON.stringify({ answers: Object.fromEntries(qs.map((q) => [q.id, answerText(a[q.id] ?? { picked: [] })])) })), shown: { answers: a } };
  },
};

// Gemini CLI's background process tools (tools/shellBackgroundTools.ts).
const list_background_processes: Tool = {
  name: "list_background_processes",
  readOnly: true,
  description: "Lists all active and recently completed background shell processes orchestrating by the agent.",
  input_schema: { type: "object", properties: {} },
  async run(_input, ctx) {
    const js = jobsOf(ctx.sessionId).filter((j) => j.background || j.ended === undefined);
    if (!js.length) return ok("No background processes found.");
    return ok(js.map((j) => `- [PID ${j.pid}] ${running(j) ? "RUNNING" : "EXITED"}: \`${j.command}\`${j.exitCode != null ? ` (Exit Code: ${j.exitCode})` : ""}${j.signal ? ` (Signal: ${j.signal})` : ""}`).join("\n"));
  },
};

const read_background_output: Tool = {
  name: "read_background_output",
  readOnly: true,
  description: "Reads the output log of a background shell process. Support reading tail snapshot.",
  input_schema: obj({
    pid: { type: "integer", description: "The process ID (PID) of the background process to inspect." },
    lines: { type: "integer", minimum: 1, description: "Optional. Number of lines to read from the end of the log. Defaults to 100." },
    delay_ms: { type: "integer", description: "Optional. Delay in milliseconds to wait before reading the output. Useful to allow the process to start and generate initial output." },
  }, ["pid"]),
  async run(input, ctx) {
    const j = jobsOf(ctx.sessionId).find((x) => x.pid === Number(input.pid));
    if (!j) return fail(`Access denied. Background process ID ${input.pid} not found in this session's history.`);
    if (Number(input.delay_ms) > 0) await waitJob(j, Number(input.delay_ms), ctx.signal);
    let text: string;
    try { text = await Bun.file(j.log).text(); } catch { return ok(`No output log found for process ID ${j.pid}. It might not have produced output or was cleaned up.`); }
    if (!text) return ok("Log is empty.");
    const all = text.replace(/\n$/, "").split("\n");
    const n = Math.max(1, Number(input.lines) || 100);
    return ok(`${n < all.length ? `Showing last ${n} of ${all.length} lines:` : "Full Log Output:"}\n${all.slice(-n).join("\n")}`);
  },
};

export const geminiTools: Tool[] = [
  run_shell_command, list_background_processes, read_background_output, read_file, write_file, replace, glob, grep_search, list_directory, write_todos,
  google_web_search, web_fetch, ask_user,
  skillTool("activate_skill", "name", null, "Activates a skill listed in the system prompt by name and returns its instructions."),
];

