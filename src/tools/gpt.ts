// The tool profile GPT models are trained on: the Codex tool set on
// openai/codex main (exec_command and write_stdin over a real PTY,
// apply_patch in the V4A grammar, update_plan, request_user_input).
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { atCwd, realOf } from "../core/paths.ts";
import { heldFile } from "../core/store-files.ts";
import { hold } from "./files.ts";
import { APPLY_PATCH_GRAMMAR as grammar } from "./apply_patch_grammar.ts";
import { ask, type Question } from "./interact.ts";
import { cleanTerm, findJob, hasUnread, running, startJob, takeUnread, waitJob, writeJob, type Job } from "./jobs.ts";
import { goneCwd, logDir, shellCwd } from "./shell.ts";
import { skillTool } from "./skills.ts";
import { fail, ok, type Tool, type ToolContext } from "./types.ts";
import { applyPatch, extractShellApplyPatch, patchTargetPaths } from "./v4a.ts";

const obj = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: "object", properties, required, additionalProperties: false });

const clamp = (v: unknown, def: number, lo: number, hi: number) => Math.min(Math.max(Number(v) || def, lo), hi);

// About four bytes a token: keep the head and the tail of a long output.
function truncate(text: string, maxTokens: number, log?: string): { text: string; original?: number } {
  const budget = maxTokens * 4;
  if (text.length <= budget) return { text };
  const head = text.slice(0, Math.floor(budget / 2));
  const tail = text.slice(-Math.floor(budget / 2));
  return { text: `${head}\n…${Math.ceil((text.length - budget) / 4)} tokens truncated${log ? ` (the whole output is in ${log})` : ""}…\n${tail}`, original: Math.ceil(text.length / 4) };
}

// The model names its own output budget in tokens (max_output_tokens, 10,000
// by default and at most MAX_TOKENS): the result is cut to it here, with the
// log named, so the engine's cap is that budget plus the few lines around it.
const MAX_TOKENS = 50_000;
const EXEC_CAP = MAX_TOKENS * 4 + 1000;

function execResult(job: Job, t0: number, maxTokens: number): string {
  const raw = takeUnread(job);
  const cut = truncate(job.pty ? cleanTerm(raw) : raw, maxTokens, job.log);
  const text = cut.text;
  // Counted on everything this read covered, not only the part kept in memory.
  const original = cut.original || (job.taken ?? 0) > raw.length ? Math.max(cut.original ?? 0, Math.ceil((job.taken ?? 0) / 4)) : undefined;
  const lines = [`Chunk ID: ${Math.random().toString(16).slice(2, 8)}`, `Wall time: ${((Date.now() - t0) / 1000).toFixed(4)} seconds`];
  if (!running(job)) lines.push(`Process exited with code ${job.exitCode ?? (job.signal ? 128 : -1)}`);
  else lines.push(`Process running with session ID ${job.num}`);
  if (original) lines.push(`Original token count: ${original}`);
  lines.push("Output:");
  return `${lines.join("\n")}\n${text}`;
}

async function runPatch(text: string, base: string, ctx: ToolContext) {
  try {
    // The gate judged these files where they land before the call ran (policy.ts reads a patch as the edit of
    // them): one outside the session's folder that it let through is written, as a Write there is. (The judged
    // paths when the gate named them; else the patch's own targets.)
    const cleared = patchTargetPaths(text).map((p) => realOf(atCwd(base, p)));
    const r = await applyPatch(ctx.cwd, text, { base, allowOutside: ctx.judged ?? cleared, judged: ctx.judged, looked: ctx.looked, sessionId: ctx.sessionId });
    for (const f of r.files) ctx.seen.set(resolve(base, f.path), Date.now());
    return ok(r.summary);
  } catch (e) {
    return fail(`apply_patch verification failed: ${(e as Error).message}`);
  }
}

const execCwd = (ctx: ToolContext, input: any) => input?.workdir ? resolve(shellCwd(ctx), input.workdir) : shellCwd(ctx);

// The shell a call runs its command with: the one it names, else the owner's.
const execShell = (input: any): string => (typeof input?.shell === "string" && input.shell) || process.env.SHELL || "bash";

const exec_command: Tool = {
  name: "exec_command",
  resultCap: EXEC_CAP,
  readOnly: false,
  kind: "shell",
  appliesPatch: true,
  cwdOf: execCwd,
  // The owner's own shell, when it is a bash, is bash wherever it is installed.
  interpreter: (input) => { const sh = execShell(input); return sh === process.env.SHELL && /(^|\/)bash$/.test(sh) ? "bash" : sh; },
  autoShell: ({ cmd, ...options }) => typeof cmd === "string" && options.shell === "bash" && options.login === false && !extractShellApplyPatch(cmd)
    ? { command: cmd, interpreter: "bash -c", options } : undefined,
  description: "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
  input_schema: obj({
    cmd: { type: "string", description: "Shell command to execute." },
    workdir: { type: "string", description: "Working directory for the command. Defaults to the turn cwd." },
    tty: { type: "boolean", description: "True allocates a PTY for the command; false or omitted uses plain pipes." },
    yield_time_ms: { type: "number", description: "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms." },
    max_output_tokens: { type: "number", description: "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy." },
    shell: { type: "string", description: "Shell binary to launch. Defaults to the user's default shell." },
    login: { type: "boolean", description: "Request login-shell startup. Omit to inherit." },
    sandbox_permissions: { type: "string", enum: ["use_default", "require_escalated"], description: "Per-command sandbox override. Defaults to `use_default`; use `require_escalated` for unsandboxed execution." },
    justification: { type: "string", description: "User-facing approval question for `require_escalated`; omit otherwise." },
    prefix_rule: { type: "array", items: { type: "string" }, description: "Reusable approval prefix for `cmd`, only with `sandbox_permissions: \"require_escalated\"`; for example [\"git\", \"pull\"]." },
  }, ["cmd"]),
  async run(input, ctx) {
    if (input.cmd != null && typeof input.cmd !== "string") return fail("exec_command failed: cmd must be one string");
    const cmd: string = input.cmd ?? "";
    if (!cmd.trim()) return fail("exec_command failed: cmd is empty");
    const cwd = execCwd(ctx, input);
    const gone = goneCwd(ctx, cwd);
    if (gone) return fail(`exec_command failed: ${gone}`);
    // Models trained on Codex often send apply_patch through the shell.
    const sp = extractShellApplyPatch(cmd);
    if (sp) return runPatch(sp.patch, sp.cd ? atCwd(cwd, sp.cd) : cwd, ctx);
    const shell = execShell(input);
    const t0 = Date.now();
    const job = startJob({
      sessionId: ctx.sessionId, command: cmd, cwd, logDir: logDir(ctx), pty: !!input.tty,
      argv: [shell, input.login === false ? "-c" : "-lc", cmd], wrap: ctx.wrapSpawn, callId: ctx.callId, handle: "num",
    });
    await waitJob(job, clamp(input.yield_time_ms, 10_000, 250, 30_000), ctx.signal);
    return ok(execResult(job, t0, clamp(input.max_output_tokens, 10_000, 100, MAX_TOKENS)));
  },
};

const write_stdin: Tool = {
  name: "write_stdin",
  resultCap: EXEC_CAP,
  readOnly: false,
  kind: "control",
  description: "Writes characters to an existing unified exec session and returns recent output.",
  input_schema: obj({
    session_id: { type: "number", description: "Identifier of the running unified exec session." },
    chars: { type: "string", description: "Bytes to write to stdin. Defaults to empty, which polls without writing." },
    yield_time_ms: { type: "number", description: "Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default." },
    max_output_tokens: { type: "number", description: "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy." },
  }, ["session_id"]),
  async run(input, ctx) {
    const job = findJob(ctx.sessionId, Number(input.session_id));
    if (!job || (!running(job) && !hasUnread(job))) return fail(`write_stdin failed: Unknown process id ${input.session_id}${job ? `: it has ended${job.exitCode != null ? ` (exit code ${job.exitCode})` : ""}` : ""}`);
    const chars = String(input.chars ?? "");
    if (chars && !writeJob(job, chars)) {
      if (!job.pty) return fail("write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open");
    }
    const t0 = Date.now();
    const wait = chars ? clamp(input.yield_time_ms, 250, 0, 30_000) : clamp(input.yield_time_ms, 5_000, 5_000, 300_000);
    await waitJob(job, wait, ctx.signal);
    return ok(execResult(job, t0, clamp(input.max_output_tokens, 10_000, 100, MAX_TOKENS)));
  },
};

export const applyPatchTool: Tool = {
  name: "apply_patch",
  readOnly: false,
  kind: "edit",
  cwdOf: shellCwd,
  description: "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
  freeform: { syntax: "lark", definition: grammar },
  input_schema: obj({ input: { type: "string", description: "The entire contents of the apply_patch command" } }, ["input"]),
  run: (input, ctx) => runPatch(typeof input === "string" ? input : String(input.input ?? input.patch ?? ""), shellCwd(ctx), ctx),
};

const update_plan: Tool = {
  name: "update_plan",
  readOnly: true,
  description: "Updates the task plan.\nProvide an optional explanation and a list of plan items, each with a step and status.\nAt most one step can be in_progress at a time.\n",
  input_schema: obj({
    explanation: { type: "string", description: "Optional explanation for this plan update." },
    plan: {
      type: "array", description: "The list of steps",
      items: obj({ step: { type: "string", description: "Task step text." }, status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "Step status." } }, ["step", "status"]),
    },
  }, ["plan"]),
  async run(input) {
    if (!Array.isArray(input.plan)) return fail("failed to parse function arguments: plan must be a list");
    if (input.plan.filter((p: any) => p.status === "in_progress").length > 1) return fail("At most one step can be in_progress at a time.");
    return ok("Plan updated");
  },
};

const request_user_input: Tool = {
  name: "request_user_input",
  readOnly: true,
  asksOwner: true,
  description: "Request user input for one to three short questions and wait for the response.",
  input_schema: obj({
    questions: {
      type: "array", description: "Questions to show the user. Prefer 1 and do not exceed 3",
      items: obj({
        id: { type: "string", description: "Stable identifier for mapping answers (snake_case)." },
        header: { type: "string", description: "Short header label shown in the UI (12 or fewer chars)." },
        question: { type: "string", description: "Single-sentence prompt shown to the user." },
        options: {
          type: "array",
          description: "Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with \"(Recommended)\". Do not include an \"Other\" option in this list; the client will add a free-form \"Other\" option automatically.",
          items: obj({ label: { type: "string", description: "User-facing label (1-5 words)." }, description: { type: "string", description: "One short sentence explaining impact/tradeoff if selected." } }, ["label", "description"]),
        },
      }, ["id", "header", "question", "options"]),
    },
  }, ["questions"]),
  async run(input, ctx) {
    const qs: Question[] = input.questions ?? [];
    if (!qs.length || qs.some((q) => !q.options?.length)) return fail("request_user_input requires non-empty options for every question");
    const a = await ask(ctx);
    if (!a) return fail("request_user_input was interrupted before the user answered");
    const answers = Object.fromEntries(qs.map((q, i) => {
      const x = a[q.id] ?? a[String(i)] ?? { picked: [] };
      return [q.id, { answers: [...x.picked, ...(x.other?.trim() ? [`user_note: ${x.other.trim()}`] : [])] }];
    }));
    return { ...ok(JSON.stringify({ answers })), shown: { answers: a } };
  },
};

// Codex's view_image: a local image into the context, for a model that
// inspects screenshots, plots or diagrams already on disk. A relative path is
// the shell's folder's.
const view_image: Tool = {
  name: "view_image",
  readOnly: true,
  description: "View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk.",
  input_schema: obj({ path: { type: "string", description: "Local filesystem path to an image file." } }, ["path"]),
  async run(input, ctx) {
    const raw = String(input?.path ?? "").trim();
    if (!raw) return fail("view_image needs a path");
    const p = realOf(atCwd(shellCwd(ctx), raw));
    // (The file is held for the read: what is read is the file that was judged.)
    const h = hold(p, ctx, "read");
    if ("refused" in h) return fail(h.refused);
    try {
    let st;
    try { st = statSync(h.io); } catch { return fail(`unable to locate image at \`${p}\``); }
    if (!st.isFile()) return fail(`image path \`${p}\` is not a file`);
    { const held = heldFile(p); if (held) return fail(held); }
    const type = Bun.file(p).type;
    if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) return fail(`\`${p}\` is not a PNG, JPEG, GIF or WebP image (${type})`);
    if (st.size > 20 * 1024 * 1024) return fail(`\`${p}\` is ${(st.size / 1048576).toFixed(0)} MB; resize it (e.g. magick) and view the copy`);
    ctx.seen.set(p, st.mtimeMs);
    return { content: [{ type: "image", media_type: type, data: Buffer.from(await Bun.file(h.io).arrayBuffer()).toString("base64"), path: p }] };
    } finally { h.close(); }
  },
};

export const gptTools: Tool[] = [
  exec_command, write_stdin, applyPatchTool, update_plan, request_user_input, view_image,
  skillTool("skill", "name", "arguments"),
];

