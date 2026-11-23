// The tool profile Claude models are trained on: Claude Code's current names,
// argument shapes and result wording (code.claude.com/docs/en/tools-reference).
import { realOf } from "../core/paths.ts";
import { heldWrite } from "../core/store-files.ts";
import { abs, editFile, editShown, globFiles, guardOverwrite, hold, mtime, readFile, ripgrep, writeFile } from "./files.ts";
import { answerText, ask, type Question } from "./interact.ts";
import { findJob, jobsOf, running, stopJob } from "./jobs.ts";
import { headTail, runShell, shellCwd } from "./shell.ts";
import { skillTool } from "./skills.ts";
import { fail, ok, type Tool } from "./types.ts";
import { fetchFor, webSearch } from "./web.ts";

const INLINE_OK = 30_000;
const INLINE_FAIL = 10_000;
const PREVIEW = 2_000;
// Exit 1 means "nothing found" or "differs" for these, not a failure.
const BENIGN_1 = /^\s*(grep|rg|egrep|fgrep|find|diff|test|\[|git\s+(diff|grep))\b/;

const obj = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: "object", properties, required, additionalProperties: false });

const Bash: Tool = {
  name: "Bash",
  // A wait polled again in a shell gets a line naming the wait tool (src/engine/wait-poll.ts); a background
  // command's end starts a turn of its idle session, and an agent waits on one it started.
  urgent: "command-end-wakes",
  readOnly: false,
  kind: "shell",
  cwdOf: shellCwd,
  tracesChecks: true, // runs on runShell (src/tools/shell.ts)
  autoShell: ({ command, ...options }) => typeof command === "string" ? { command, interpreter: "bash -c", options } : undefined,
  description:
    "Run a bash command and return its output (stdout and stderr together). The working directory carries over " +
    "between calls when you cd inside the project; environment variables do not. Default timeout 120000 ms, " +
    "max 600000; a command still running at its timeout moves to the background instead of being killed. " +
    "Set run_in_background for servers, watchers and long jobs: you get a task ID and a log file to Read, " +
    "and its end wakes you with a notice, so do not sleep, poll or wait for it: do other work or end your turn. " +
    "Stop one with TaskStop once you no longer need it (as an agent, you are not done while one you started runs). " +
    "Quote paths with spaces. Prefer the Read, Edit and Write tools for files.",
  input_schema: obj({
    command: { type: "string", description: "The command to execute" },
    timeout: { type: "number", description: "Optional timeout in milliseconds (max 600000)" },
    description: { type: "string", description: "What the command does, in 5-10 words" },
    run_in_background: { type: "boolean", description: "Run in the background; read its output file later" },
    // (Claude Code's own parameter and wording. The gate asks the owner for every call that sets it.)
    dangerouslyDisableSandbox: { type: "boolean", description: "Set this to true to dangerously override sandbox mode and run commands without sandboxing." },
  }, ["command"]),
  async run(input, ctx) {
    if (input.command != null && typeof input.command !== "string") return fail("command must be one string.");
    const command = input.command ?? "";
    if (!command.trim()) return fail("command is empty.");
    const timeout = Math.min(Math.max(Number(input.timeout) || 120_000, 1000), 600_000);
    const r = await runShell(ctx, {
      command, description: input.description, timeoutMs: timeout, background: !!input.run_in_background, onTimeout: "background",
    });
    if (r.state === "refused") return fail(r.error);
    if (r.state === "running") {
      const moved = !input.run_in_background;
      const head = moved
        ? `Command did not complete within its ${Math.round(timeout / 1000)}s timeout and was moved to the background with ID: ${r.job.id}.`
        : `Command running in background with ID: ${r.job.id}.`;
      const cwd = moved && /\b(cd|pushd|popd|chdir)\b/.test(command)
        ? `\nSession cwd remains ${ctx.cwd}; directory changes made by the backgrounded command do not apply to subsequent commands.` : "";
      const sofar = r.output.trim() ? `\nOutput so far:\n${headTail(r.output.trimEnd(), PREVIEW)}` : "";
      return ok(`${head} Output is being written to: ${r.job.log}${cwd}${sofar}`);
    }
    const out = r.output.trimEnd();
    const failed = r.signal ? true : r.exitCode !== 0 && !(r.exitCode === 1 && BENIGN_1.test(command));
    const note = r.cwdNote ? `\n${r.cwdNote}` : "";
    if (failed) {
      const why = r.job.stopReason ? `Command ${r.job.stopReason}` : r.signal ? `Killed by ${r.signal}` : `Exit code ${r.exitCode}`;
      return fail(`${why}\n${headTail(out, INLINE_FAIL)}${note}`.trimEnd());
    }
    if (out.length > INLINE_OK) {
      return ok(`Output too large (${(out.length / 1024).toFixed(1)}KB). Full output saved to: ${r.job.log}\n\nPreview (first ${PREVIEW / 1000}KB):\n${out.slice(0, PREVIEW)}\n...${note}`);
    }
    return ok((out || "(no output)") + note);
  },
};

const TaskStop: Tool = {
  name: "TaskStop",
  readOnly: false,
  kind: "control",
  description: "Stop a running background task by its ID (from Bash run_in_background or a command moved to the background).",
  input_schema: obj({
    task_id: { type: "string", description: "The ID of the background task to stop" },
    shell_id: { type: "string", description: "Deprecated: use task_id instead" },
  }, []),
  async run(input, ctx) {
    const id = String(input.task_id ?? input.shell_id ?? "");
    const j = findJob(ctx.sessionId, id);
    if (!j) {
      const live = jobsOf(ctx.sessionId).filter(running).map((x) => `${x.id} (${x.description ?? x.command.slice(0, 60)})`);
      return fail(`No background task ${id}. Running: ${live.join(", ") || "none"}.`);
    }
    if (!running(j)) return ok(`Task ${j.id} already ended (exit ${j.exitCode}).`);
    const left = await stopJob(j, "was stopped");
    if (left.length) return fail(`Task ${j.id} would not stop: process ${left.join(", ")} of it is still running. Its output is in ${j.log}.`);
    return ok(`Stopped task ${j.id}. Its output is in ${j.log}.`);
  },
};

const Read: Tool = {
  name: "Read",
  readOnly: true,
  // It pages the file itself (READ_CHARS a page, the range the model asked
  // for, more only with allow_large and room for it): a cut middle with a
  // copy of the file in the spill would serve worse than the next page.
  resultCap: Infinity,
  description:
    "Read a file by absolute path. Text comes back with line numbers (cat -n style); by default up to 2000 lines " +
    "from the start, use offset and limit for other parts of long files. Images (PNG, JPEG, GIF, WebP) come back " +
    "as images. PDFs: short ones whole as text; for longer ones pass pages, e.g. \"1-5\" (max 20), to see them " +
    "as page images. Jupyter notebooks come back as cells with outputs. Read files, not directories (use ls).",
  input_schema: obj({
    file_path: { type: "string", description: "The absolute path to the file to read" },
    offset: { type: "integer", description: "The line number to start reading from" },
    limit: { type: "integer", description: "The number of lines to read" },
    pages: { type: "string", description: "Page range for PDF files, e.g. \"1-5\"" },
    allow_large: { type: "boolean", description: "Read a text file, or a line range of one, over the usual size limits, up to what still fits in your context. Only when you need all of it." },
  }, ["file_path"]),
  async run(input, ctx) {
    const r = await readFile(abs(String(input.file_path ?? ""), ctx), ctx, {
      offset: Number(input.offset) || undefined, limit: Number(input.limit) || (input.offset || input.allow_large ? undefined : 2000), pages: input.pages, large: !!input.allow_large,
    });
    return { content: r.content, is_error: r.error };
  },
};

const Write: Tool = {
  name: "Write",
  readOnly: false,
  kind: "edit",
  description:
    "Create a file or overwrite one with the full content given, creating parent directories. Overwriting an " +
    "existing file needs a Read of it first. For partial changes use Edit.",
  input_schema: obj({
    file_path: { type: "string", description: "The absolute path to the file to write" },
    content: { type: "string", description: "The content to write to the file" },
  }, ["file_path", "content"]),
  async run(input, ctx) {
    const p = abs(String(input.file_path ?? ""), ctx);
    const content = String(input.content ?? "");
    const existed = mtime(p) !== -1;
    const g = await guardOverwrite(p, ctx);
    if (g) return fail(g);
    if (existed && content.includes("�")) return fail("The content holds U+FFFD, the mark of bytes that did not decode; write the real characters.");
    { const no = await writeFile(p, content, ctx); if (no) return fail(no); }
    return ok(existed ? `The file ${p} has been updated successfully.` : `File created successfully at: ${p}`);
  },
};

const Edit: Tool = {
  name: "Edit",
  readOnly: false,
  kind: "edit",
  description:
    "Replace an exact string in a file. old_string must match the file exactly (whitespace and indentation " +
    "included) and appear once, unless replace_all is set; add surrounding lines to make it unique. Read the " +
    "file first and copy the text after the line-number prefix.",
  input_schema: obj({
    file_path: { type: "string", description: "The absolute path to the file to modify" },
    old_string: { type: "string", description: "The text to replace" },
    new_string: { type: "string", description: "The text to replace it with (must be different from old_string)" },
    replace_all: { type: "boolean", description: "Replace all occurrences of old_string (default false)" },
  }, ["file_path", "old_string", "new_string"]),
  async run(input, ctx) {
    const p = abs(String(input.file_path ?? ""), ctx);
    const r = await editFile(p, String(input.old_string ?? ""), String(input.new_string ?? ""), !!input.replace_all, ctx);
    if ("error" in r) return fail(r.error);
    return { ...ok(`The file ${p} has been updated successfully.${r.ok}`), shown: editShown(r.before, String(input.old_string ?? "")) };
  },
};

const NotebookEdit: Tool = {
  name: "NotebookEdit",
  readOnly: false,
  kind: "edit",
  description:
    "Replace, insert or delete one cell of a Jupyter notebook. cell_id is the id shown by Read. insert adds after " +
    "cell_id (or at the start without one) and needs cell_type. Replacing a code cell clears its outputs.",
  input_schema: obj({
    notebook_path: { type: "string", description: "The absolute path to the notebook" },
    cell_id: { type: "string", description: "The ID of the cell to edit" },
    new_source: { type: "string", description: "The new source for the cell" },
    cell_type: { type: "string", enum: ["code", "markdown"] },
    edit_mode: { type: "string", enum: ["replace", "insert", "delete"] },
  }, ["notebook_path", "new_source"]),
  async run(input, ctx) {
    const p = abs(String(input.notebook_path ?? ""), ctx);
    if (!ctx.seen.has(p)) return fail(`Read ${p} before editing it.`);
    { const held = heldWrite(p); if (held) return fail(held); }
    let nb: any;
    const h = hold(p, ctx, "read");
    if ("refused" in h) return fail(h.refused);
    if (!h.existed) { h.close(); return fail(`${p} does not exist.`); }
    try { nb = JSON.parse(await Bun.file(h.io).text()); } catch (e) { return fail(`Cannot parse the notebook: ${(e as Error).message}`); } finally { h.close(); }
    const cells: any[] = nb.cells ?? [];
    const mode = input.edit_mode ?? "replace";
    const idx = input.cell_id === undefined ? -1 : cells.findIndex((c, i) => (c.id ?? `cell-${i}`) === input.cell_id);
    if (mode !== "insert" && idx === -1) return fail(`No cell ${input.cell_id}. Read the notebook for the ids.`);
    const source = String(input.new_source ?? "").split(/(?<=\n)/);
    if (mode === "delete") cells.splice(idx, 1);
    else if (mode === "insert") {
      if (!input.cell_type) return fail("cell_type is required to insert a cell.");
      const cell: any = { cell_type: input.cell_type, id: Math.random().toString(36).slice(2, 10), metadata: {}, source };
      if (input.cell_type === "code") Object.assign(cell, { execution_count: null, outputs: [] });
      cells.splice(idx + 1, 0, cell);
    } else {
      const c = cells[idx];
      c.source = source;
      if (input.cell_type) c.cell_type = input.cell_type;
      if (c.cell_type === "code") Object.assign(c, { execution_count: null, outputs: [] });
      else { delete c.outputs; delete c.execution_count; }
    }
    nb.cells = cells;
    { const no = await writeFile(p, JSON.stringify(nb, null, 1) + "\n", ctx); if (no) return fail(no); }
    return ok(`Updated cell ${input.cell_id ?? "(start)"} of ${p} (${mode}).`);
  },
};

const Glob: Tool = {
  name: "Glob",
  readOnly: true,
  description: "Find files by glob pattern (\"**/*.ts\", \"src/**/*.{js,jsx}\"), newest first, at most 100.",
  input_schema: obj({
    pattern: { type: "string", description: "The glob pattern to match files against" },
    path: { type: "string", description: "The directory to search in (default: the working directory)" },
  }, ["pattern"]),
  async run(input, ctx) {
    const root = input.path ? abs(input.path, ctx) : ctx.cwd;
    // (The session's own folder when no path is given: held as itself.)
    const r = await globFiles(String(input.pattern ?? ""), root, ctx.cwd, 100, input.path ? ctx : { judged: [realOf(root)] });
    if ("error" in r) return fail(r.error);
    const stopped = r.stopped ? `\n(${r.stopped})` : "";
    if (!r.files.length) return ok(`No files found${stopped}`);
    // More matches than are shown is one thing; a scan that never examined them all is another.
    const more = r.ceiling ? `\n(${r.ceiling})` : r.truncated ? "\n(Results are truncated. Consider using a more specific path or pattern.)" : "";
    return ok(r.files.join("\n") + more + stopped);
  },
};

const Grep: Tool = {
  name: "Grep",
  readOnly: true,
  description:
    "Search file contents with ripgrep (regex syntax: escape { } ( ) etc.). output_mode: files_with_matches " +
    "(default), content (matching lines; -A/-B/-C context, -n line numbers), count. Filter with glob or type " +
    "(js, py, rust...). multiline lets . and patterns span lines. Respects .gitignore.",
  input_schema: obj({
    pattern: { type: "string", description: "The regular expression pattern to search for" },
    path: { type: "string", description: "File or directory to search in (default: the working directory)" },
    glob: { type: "string", description: "Glob to filter files, e.g. \"*.js\" or \"*.{ts,tsx}\"" },
    output_mode: { type: "string", enum: ["content", "files_with_matches", "count"] },
    "-B": { type: "number", description: "Lines before each match (content mode)" },
    "-A": { type: "number", description: "Lines after each match (content mode)" },
    "-C": { type: "number", description: "Lines before and after each match (content mode)" },
    "-n": { type: "boolean", description: "Show line numbers (content mode, default true)" },
    "-i": { type: "boolean", description: "Case insensitive search" },
    type: { type: "string", description: "File type to search (rg --type)" },
    head_limit: { type: "number", description: "Limit output to the first N entries (default 250)" },
    offset: { type: "number", description: "Skip the first N entries" },
    multiline: { type: "boolean", description: "Match across lines" },
  }, ["pattern"]),
  async run(input, ctx) {
    const r = await ripgrep({
      pattern: String(input.pattern ?? ""), path: input.path, glob: input.glob, type: input.type, mode: input.output_mode,
      ignoreCase: input["-i"], lineNumbers: input["-n"], before: input["-B"], after: input["-A"], context: input["-C"],
      multiline: input.multiline, headLimit: input.head_limit, offset: input.offset,
    }, ctx);
    return { content: r.text, is_error: r.error };
  },
};

const WebFetch: Tool = {
  name: "WebFetch",
  readOnly: true,
  web: { fetches: (input) => [String(input?.url ?? "")], links: true, public: (input, own) => !own(String(input?.url ?? "")) },
  description:
    "Fetch a URL (http is upgraded to https) and answer prompt from the page: a long page is read by a smaller, faster " +
    "model that returns what the prompt asks for, and the whole page is saved to a file you can Read; a short page " +
    "comes back as markdown (PDFs as text). Write prompt as the question to answer. Local and private addresses are " +
    "refused: use curl in Bash for those. A redirect to another host is reported, not followed.",
  input_schema: obj({
    url: { type: "string", description: "The URL to fetch content from" },
    prompt: { type: "string", description: "The prompt to run on the fetched content: what to find or extract" },
  }, ["url", "prompt"]),
  async run(input, ctx) {
    const r = await fetchFor(String(input.url ?? ""), String(input.prompt ?? ""), ctx);
    return { content: r.text, is_error: r.error };
  },
};

const WebSearch: Tool = {
  name: "WebSearch",
  readOnly: true,
  web: { search: true },
  description:
    "Search the web for current information and return result titles, URLs and snippets. Read a result with " +
    "WebFetch. Scope with allowed_domains or blocked_domains (not both).",
  input_schema: obj({
    query: { type: "string", description: "The search query to use" },
    allowed_domains: { type: "array", items: { type: "string" }, description: "Only include results from these domains" },
    blocked_domains: { type: "array", items: { type: "string" }, description: "Never include results from these domains" },
  }, ["query"]),
  async run(input, ctx) {
    if (input.allowed_domains?.length && input.blocked_domains?.length) return fail("Use allowed_domains or blocked_domains, not both.");
    const r = await webSearch(String(input.query ?? ""), { allowed_domains: input.allowed_domains, blocked_domains: input.blocked_domains }, ctx.signal);
    return { content: r.text, is_error: r.error };
  },
};

const TodoWrite: Tool = {
  name: "TodoWrite",
  readOnly: true,
  description:
    "Keep the session's task checklist, shown to the owner. Send the whole list each time. Use it for work of " +
    "three or more steps; exactly one task in_progress while you work; mark a task completed as soon as it is done.",
  input_schema: obj({
    todos: {
      type: "array",
      items: obj({
        content: { type: "string", minLength: 1 },
        status: { type: "string", enum: ["pending", "in_progress", "completed"] },
        activeForm: { type: "string", minLength: 1, description: "Present-continuous form shown while in progress" },
      }, ["content", "status", "activeForm"]),
    },
  }, ["todos"]),
  async run(input) {
    if (!Array.isArray(input.todos)) return fail("todos must be a list.");
    return ok("Todos have been modified successfully. Keep using the list to track progress, and continue with the current task.");
  },
};

const AskUserQuestion: Tool = {
  name: "AskUserQuestion",
  readOnly: true,
  asksOwner: true,
  description:
    "Ask the owner 1-4 multiple-choice questions when you need a decision or clarification, and wait for the " +
    "answer. Each question has a short header (max 12 chars) and 2-4 options; the owner can also type their own " +
    "answer. Put a recommended option first and add \"(Recommended)\" to its label.",
  input_schema: obj({
    questions: {
      type: "array", minItems: 1, maxItems: 4,
      items: obj({
        question: { type: "string", description: "The complete question, ending with a question mark" },
        header: { type: "string", description: "Very short label (max 12 chars)" },
        options: {
          type: "array", minItems: 2, maxItems: 4,
          items: obj({ label: { type: "string" }, description: { type: "string" } }, ["label", "description"]),
        },
        multiSelect: { type: "boolean", description: "Allow more than one option" },
      }, ["question", "header", "options", "multiSelect"]),
    },
  }, ["questions"]),
  async run(input, ctx) {
    const qs: Question[] = (input.questions ?? []).map((q: any, i: number) => ({ id: String(i), ...q }));
    if (!qs.length) return fail("questions is empty.");
    const a = await ask(ctx);
    if (!a) return fail("The owner did not answer; the turn was interrupted.");
    const pairs = qs.map((q) => `"${q.question}"="${answerText(a[q.id] ?? { picked: [] })}"`).join(", ");
    return { ...ok(`User has answered your questions: ${pairs}. You can now continue with the user's answers in mind.`), shown: { answers: a } };
  },
};

export const claudeTools: Tool[] = [
  Bash, Read, Edit, Write, NotebookEdit, Glob, Grep, TaskStop, TodoWrite, AskUserQuestion, WebFetch, WebSearch,
  skillTool("Skill", "skill", "args", "Run a skill listed in the system prompt by name, with optional args. Its instructions come back as the result; follow them."),
];

