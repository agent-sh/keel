import { Collapsible } from "@base-ui/react/collapsible";
import { Ansi } from "./Ansi.tsx";
import { Brain, Check, ChevronRight, Circle, CircleDot, Link2, RotateCcw, Webhook, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { setUI, useUI } from "../lib/ui.ts";
import type { ToolResultBlock, ToolUseBlock } from "../../../src/core/types.ts";
import { diffLines, splitLines } from "../../../src/tools/diff.ts";
import type { PatchLine } from "../../../src/safety/patch.ts";
import { actions, api, failed, reportError } from "../lib/store.ts";
import { bounded } from "../lib/scrollback.ts";
import { changeOf, failureLine } from "../lib/work.ts";
import { CallDiff, type CallFile } from "./DiffView.tsx";
import { stopKind } from "../../../src/core/stops.ts";
import { allowRetry, refusedBy, useBlocked } from "../lib/blocked.ts";
import {
  patchFiles, planItems, resultImages, resultText, shellBody, splitMemory, splitNested, shellStatus, shortPath, toolKind, type PlanItem,
  type ToolKind,
} from "../lib/tools.ts";
import { FLEET_LABEL, fleetSummary, MachineBadge } from "./Fleet.tsx";
import { cn } from "../lib/utils.ts";
import { AGENT_TOOLS, AgentCall, toolSummary } from "./automation/TranscriptExtras.tsx";
import { CodeCall } from "./CodeCall.tsx";
import { ReadersCall } from "./ReadersCall.tsx";
import { AskedUnder, QuestionCard } from "./QuestionCard.tsx";
import { Copyable, CopyButton } from "./CopyButton.tsx";
import { stripAnsiText } from "../../../src/core/ansi.ts";
import { splitDiagnostics, type ResultDiagnostics } from "../lib/tools.ts";

// The file a call names, for its copy line.
const pathOf = (input: any): string | undefined => { const p = input?.file_path ?? input?.path ?? input?.notebook_path; return typeof p === "string" && p ? p : undefined; };

// What a call did, as its line begins: one word while it runs, one when it is over.
const LABEL: Partial<Record<ToolKind, [string, string]>> = {
  shell: ["Running", "Ran"], stdin: ["Sending input", "Sent input"], stop: ["Stopping", "Stopped"], read: ["Reading", "Read"], edit: ["Editing", "Edited"],
  write: ["Writing", "Wrote"], patch: ["Patching", "Patched"], notebook: ["Editing", "Edited"], search: ["Searching", "Searched"], glob: ["Finding", "Found"],
  list: ["Listing", "Listed"], web: ["Searching the web", "Searched the web"], fetch: ["Fetching", "Fetched"], plan: ["Plan", "Plan"], ask: ["Question", "Question"],
  skill: ["Loading skill", "Skill"],
};

// `lead`: what the model thought on the way to it, shown when the call is opened.
type Props = { use: ToolUseBlock; result?: ToolResultBlock; live?: boolean; sessionId?: string; cwd?: string; lead?: ReactNode };

function summary(kind: ToolKind, name: string, input: any, cwd?: string): string {
  switch (kind) {
    // The command itself: what the model calls it is the model's word for it (the line's tooltip).
    case "shell": return String(input.cmd ?? input.command ?? "").split("\n").find((l) => l.trim())?.trim() ?? "";
    case "stdin": return input.chars ? JSON.stringify(input.chars) : `poll session ${input.session_id ?? ""}`;
    case "stop": return input.task_id ?? input.shell_id ?? "";
    case "read": {
      const p = shortPath(input.file_path ?? "", cwd);
      const from = input.offset ?? input.start_line;
      const range = input.pages ? ` pages ${input.pages}` : from || input.limit || input.end_line ? `:${from ?? 1}${input.limit ? `+${input.limit}` : input.end_line ? `-${input.end_line}` : ""}` : "";
      return p + range;
    }
    case "edit": case "write": return shortPath(input.file_path ?? "", cwd);
    case "notebook": return shortPath(input.notebook_path ?? "", cwd);
    case "patch": return patchFiles(patchText(input)).map((f) => f.path).join(", ");
    case "search": { const at = input.path ?? input.dir_path; return `${input.pattern ?? ""}${at && at !== cwd ? `  in ${shortPath(at, cwd)}` : ""}`; }
    case "glob": return input.pattern ?? "";
    case "list": return shortPath(input.dir_path ?? "", cwd);
    case "web": return input.query ?? "";
    case "fetch": return input.url ?? input.prompt ?? "";
    case "skill": return [input.skill ?? input.name, input.args ?? input.arguments].filter(Boolean).join(" ");
    // A dispatcher names its tool; a tool called by its own name shows its input.
    case "mcp": return name === "search_tools" || name === "ToolSearch" ? `search ${input.query ?? ""}` : input.tool ?? (JSON.stringify(input).slice(0, 120) || name);
    case "plan": return planSummary(planItems(name, input));
    default: return toolSummary(name, input) ?? fleetSummary(name, input) ?? JSON.stringify(input).slice(0, 120);
  }
}

const patchText = (input: any) => (typeof input === "string" ? input : String(input?.input ?? input?.patch ?? ""));

function planSummary(items: PlanItem[]): string {
  const done = items.filter((i) => i.status === "completed").length;
  const now = items.find((i) => i.status === "in_progress");
  return `${done} of ${items.length} done${now ? `, now: ${now.active ?? now.text}` : ""}`;
}

// What the owner's hooks did to a call rides with its result: the input they
// gave it in place of the model's, and an allow that answered its ask.
type HookMark = { input?: any; allowed?: string };
const hookOf = (result: ToolResultBlock | undefined) => (result as (ToolResultBlock & { shown?: { hook?: HookMark } }) | undefined)?.shown?.hook;

// The line that says so, under the call's own: the call shows the input that ran, this names what the model asked for.
function HookRow({ hook, asked, name, cwd }: { hook: HookMark; asked: any; name: string; cwd?: string }) {
  return (
    <div className="k-line-hook" data-testid="tool-hook">
      <Webhook className="mt-0.5 size-3.5 shrink-0" />
      <p className="min-w-0 flex-1">
        {hook.input !== undefined && <>A hook changed this call before it was judged. The model asked for <span className="font-mono text-micro break-all text-fg" data-testid="tool-asked">{summary(toolKind(name), name, asked ?? {}, cwd) || JSON.stringify(asked ?? {}).slice(0, 400)}</span>. </>}
        {hook.allowed !== undefined && <span data-testid="tool-hook-allowed">A hook allowed it without asking you{hook.allowed ? `: ${hook.allowed}` : ""}.</span>}
      </p>
    </div>
  );
}

// The calls that change files: only they show what a language server found.
const EDITS = new Set<ToolKind>(["edit", "write", "patch", "notebook"]);

// What a language server found after the edit, as the model was told it: under
// the call's line, opened or not. The server and what it says, then a row a finding.
function DiagnosticsRow({ d }: { d: ResultDiagnostics }) {
  const errors = d.lines.some((l) => l.severity === "error");
  return (
    <div className="k-line-diag" data-testid="tool-diagnostics" data-state={errors ? "errors" : d.lines.length ? "warnings" : d.pending ? "pending" : "fixed"}>
      <div>
        <span className="k-diag-name">{d.server || "Diagnostics"}</span>
        <span className="k-diag-what" data-testid="tool-diagnostics-head">{d.late ? "from an earlier edit: " : ""}{d.head}</span>
      </div>
      {d.lines.map((l, i) => (
        <div key={i} data-testid="tool-diagnostic" data-severity={l.severity}>
          <span className="k-diag-name" data-code="">{l.where}</span>
          <span className="k-diag-what" data-code="">{l.text}</span>
        </div>
      ))}
    </div>
  );
}

// A result that was cut names the file with all of it ("saved to <path>").
// Whether the storage retention has removed that file since: asked once per
// result that names one, so the call says what became of it.
const SAVED = /saved to:? (\/\S+?\.(?:txt|log|md))/g;
function useSpillRemoved(sessionId: string | undefined, out: string): boolean {
  const [gone, setGone] = useState(false);
  const paths = useMemo(() => [...new Set([...out.matchAll(SAVED)].map((m) => m[1]!))], [out]);
  useEffect(() => {
    if (!sessionId || !paths.length) return setGone(false);
    let live = true;
    api<{ removed: string[] }>("/api/storage/retention/removed", { method: "POST", body: JSON.stringify({ session_id: sessionId, paths }) })
      .then((r) => { if (live) setGone(r.removed.length > 0); }, () => {});
    return () => { live = false; };
  }, [sessionId, paths]);
  return gone;
}

export function ToolCall({ use: asked, result, live, sessionId, cwd, lead }: Props) {
  const hook = hookOf(result);
  // Every call shows the input that ran.
  const use = hook?.input !== undefined ? { ...asked, input: hook.input } : asked;
  const beside = (card: ReactNode) => (hook ? <div className="flex flex-col">{card}<HookRow hook={hook} asked={asked.input} name={use.name} cwd={cwd} /></div> : card);
  if (AGENT_TOOLS.has(use.name)) return beside(<AgentCall use={use} result={result} live={live} />);
  if (use.name === "run_code") return beside(<CodeCall use={use} result={result} live={live} sessionId={sessionId} cwd={cwd} />);
  if (use.name === "AskReaders" || use.name === "ask_readers") return beside(<ReadersCall use={use} result={result} live={live} sessionId={sessionId} cwd={cwd} />);
  const kind = toolKind(use.name);
  const input: any = use.input ?? {};
  if (kind === "ask" && !live) return beside(<QuestionCard use={use} result={result} sessionId={sessionId} />);
  const call = <GenericCall use={use} result={result} live={live} sessionId={sessionId} cwd={cwd} kind={kind} input={input} lead={lead} hook={hook} asked={asked.input} />;
  // A server asked the owner something while this call runs: a line says so under the call.
  return result ? call : <AskedUnder use={use} sessionId={sessionId}>{call}</AskedUnder>;
}

function GenericCall({ use, result, live, sessionId, cwd, kind, input, lead, hook, asked }: Props & { kind: ToolKind; input: any; hook?: HookMark; asked?: any }) {
  const { text: out, nested, memory, diagnostics } = useMemo(() => { const m = splitMemory(resultText(result)); const d = EDITS.has(kind) ? splitDiagnostics(m.text) : { text: m.text, diagnostics: [] }; return { ...splitNested(d.text), memory: m.memory, diagnostics: d.diagnostics }; }, [result, kind]);
  const images = resultImages(result);
  const spillGone = useSpillRemoved(sessionId, out);
  const refused = useBlocked(sessionId).find((b) => b.calls?.includes(use.id));
  // A call the owner's stop or a daemon restart ended did not fail: it reads "stopped" or "cut".
  const ended = result?.is_error ? stopKind(result.content) : undefined;
  const state = !result ? "running" : refused ? "refused" : ended ?? (result.is_error ? "error" : "ok");
  const isShell = kind === "shell" || kind === "stdin";
  const shell = isShell ? shellStatus(out) : {};
  const plan = kind === "plan" ? planItems(use.name, input) : null;
  // Closed until asked for: its line says what it did. A command that runs is
  // open while it does, so its output shows as it arrives.
  const [picked, setPicked] = useState<boolean | null>(null);
  const open = picked ?? (kind === "shell" && state === "running" && !live && !!sessionId);
  const files = useMemo(() => (open ? callFiles(kind, use, cwd, (result as { shown?: { line?: number } } | undefined)?.shown?.line) : null), [open, kind, use, cwd, result]);
  const change = useMemo(() => (kind === "edit" || kind === "write" || kind === "patch" ? changeOf(use) : null), [kind, use]);
  // A search hit on this call or its output opens this card (not a sibling call of the same reply).
  const focused = useUI((s) => s.focusCall === use.id);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focused) return;
    setPicked(true);
    setUI({ focusCall: null });
    // After the transcript has scrolled to the reply that holds it (its frame comes first).
    requestAnimationFrame(() => requestAnimationFrame(() => { root.current?.scrollIntoView({ block: "center" }); root.current?.classList.add("flash"); setTimeout(() => root.current?.classList.remove("flash"), 1600); }));
  }, [focused]);
  const rejected = plan && result?.is_error && !ended ? resultText(result) : undefined;
  // Why it failed, in a line of its own output, while the call is closed.
  const why = state === "error" && !open && !rejected ? shortPaths(failureLine(result), cwd) : "";
  // A plan update says where the plan stands: the step in progress, and how many are done.
  const planNow = plan?.find((i) => i.status === "in_progress");
  const planDone = plan?.filter((i) => i.status === "completed").length ?? 0;
  const what = plan ? (planNow ? planNow.active ?? planNow.text : plan.length && planDone === plan.length ? "Every step done" : plan.length ? "Not started" : "No steps") : summary(kind, use.name, input, cwd);
  const words = kind === "plan" || kind === "skill" || kind === "other" || kind === "mcp" || kind === "stop";
  return (
    <Collapsible.Root ref={root} open={open} onOpenChange={setPicked} className="k-tool-call group/tool" data-testid="tool-call" data-call={use.id} data-tool={use.name} data-state={live ? "live" : state} data-kind={kind}>
      <Collapsible.Trigger className="k-line" title={isShell && input.description ? `The model's note: ${input.description}` : undefined}>
        <span className="k-line-verb">{rejected ? "Plan update not applied" : LABEL[kind]?.[state === "running" ? 0 : 1] ?? FLEET_LABEL[use.name] ?? use.name}</span>
        <span className="k-line-what" data-words={words ? "" : undefined}>{what}</span>
        <span className="k-line-end">
          <MachineBadge sessionId={sessionId} callId={use.id} />
          {plan && plan.length > 0 && !rejected && <span className="k-line-plan" data-testid="plan-count"><Pips done={planDone} total={plan.length} />{planDone}/{plan.length}</span>}
          {change && (change.added > 0 || change.removed > 0) && <Delta added={change.added} removed={change.removed} />}
          {nested.length > 0 && <span className="k-chip" data-testid="tool-nested" title={nested.map((n) => n.path).join("\n")}>+ {nested.length === 1 ? shortPath(nested[0]!.path, cwd) : `${nested.length} instruction files`}</span>}
          {hook?.input !== undefined && <span className="k-chip" data-testid="tool-rewritten">changed by a hook</span>}
          {shell.background && <span className="k-chip" data-testid="tool-background">background</span>}
          {shell.session && <span className="k-chip">session {shell.session}</span>}
          {state === "running" && <span className="k-line-run" aria-label="running" />}
          {state === "error" && <span className="text-danger">{shell.exit !== undefined ? `exit ${shell.exit}` : "failed"}</span>}
          {ended && <span className="text-warn" data-testid="tool-ended" title={ended === "cut" ? "A daemon restart cut this call. It may have partly run." : "You stopped the turn while this call ran."}>{ended === "cut" ? "cut by a restart" : "stopped"}</span>}
          {state === "refused" && <span className="text-danger" data-testid="tool-refused">refused</span>}
          <ChevronRight className="k-line-chev" />
        </span>
      </Collapsible.Trigger>
      {why && <p className="k-line-why" data-testid="tool-why">{why}</p>}
      {rejected && <p className="k-line-why" data-testid="plan-rejected">{rejected} The plan before it stays.</p>}
      {refused && sessionId && (
        // A refused call says so where it sits: who refused it, why, and the retry the owner can let through.
        <div className="flex items-start gap-3 py-1.5 pl-2.5 pr-2" data-testid="tool-refusal">
          <p className="min-w-0 flex-1 text-caption text-muted"><span className="font-medium text-danger">{refusedBy(refused)}.</span> {refused.reason}</p>
          {refused.retry
            ? <span className="shrink-0 text-caption text-faint" data-testid="tool-retry-allowed">Retry allowed</span>
            : <button data-testid="tool-retry" onClick={() => allowRetry(sessionId, refused.id)} className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 text-caption hover:bg-hover"><RotateCcw className="size-3" /> Allow one retry</button>}
        </div>
      )}
      {hook && <HookRow hook={hook} asked={asked} name={use.name} cwd={cwd} />}
      {diagnostics.map((d, i) => <DiagnosticsRow key={i} d={d} />)}
      <Collapsible.Panel className="k-tool-panel overflow-hidden">
        <div className="k-tool-body">
          {lead}
          {isShell && <Terminal name={use.name} input={input} out={out} error={state === "error"} running={state === "running" && !live} sessionId={sessionId} callId={use.id} />}
          {plan && plan.length > 0 && <div className={rejected ? "opacity-60" : undefined}><PlanCard items={plan} explanation={input.explanation} /></div>}
          {files && (
            <CallDiff files={files} actions={(f) => (
              <>
                {kind === "write" && typeof input.content === "string" && <CopyButton text={String(input.content)} label="Copy the content" testid="copy-content" />}
                {(f as CallFile).full && <CopyButton text={(f as CallFile).full!} label={`Copy the path ${(f as CallFile).full}`} testid="copy-path" icon={<Link2 />} />}
              </>
            )} />
          )}
          {!files && pathOf(input) && !isShell && (
            <Copyable text={pathOf(input)!} label="Copy the path" testid="copy-path" className="k-tool-path">
              <span className="block truncate py-0.5 pr-9 font-mono text-caption text-faint" title={pathOf(input)}>{shortPath(pathOf(input)!, cwd)}</span>
            </Copyable>
          )}
          {!files && !isShell && !plan && !live && kind === "other" && (
            <Copyable text={JSON.stringify(input, null, 2)} label="Copy the input" testid="copy-input">
              <pre className="k-out max-h-64 text-faint">{JSON.stringify(input, null, 2).slice(0, 4000)}</pre>
            </Copyable>
          )}
          {!isShell && !plan && out && (!files || state === "error") && (
            <Copyable text={out} label="Copy the output" testid="copy-output">
              <pre className={cn("k-out max-h-80", result?.is_error && !ended ? "text-danger" : "text-muted")}>{out}</pre>
            </Copyable>
          )}
          {spillGone && <p className="text-caption text-faint" data-testid="spill-removed">The full output this result names was removed by the storage retention. Run the command again to get it.</p>}
          {nested.map((n) => (
            <details key={n.path} className="rounded-md border border-line bg-sunken" data-testid="nested-instructions">
              <summary className="cursor-pointer px-2.5 py-1.5 text-caption text-muted">Instructions loaded: <span className="font-mono">{shortPath(n.path, cwd)}</span></summary>
              <pre className="max-h-64 overflow-auto border-t border-line p-2.5 font-mono text-caption leading-relaxed whitespace-pre-wrap break-words text-muted">{n.body}</pre>
            </details>
          ))}
          {memory.map((m, i) => (
            <details key={i} className="rounded-md border border-line bg-sunken" data-testid="tool-memory">
              <summary className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-caption text-muted"><Brain className="size-3.5 text-faint" />Memory from {m.source}<span className="text-faint">, {m.hook}</span></summary>
              <pre className="max-h-64 overflow-auto border-t border-line p-2.5 font-mono text-caption leading-relaxed whitespace-pre-wrap break-words text-muted">{m.body}</pre>
            </details>
          ))}
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {images.map((im, i) => <img key={i} src={`data:${im.media_type};base64,${im.data}`} className="max-h-64 rounded-lg border border-line" alt="" />)}
            </div>
          )}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

// Paths in a line of output as the call's own line names them: under the session's folder, else from the home folder.
const shortPaths = (line: string, cwd?: string) => (cwd ? line.replaceAll(`${cwd}/`, "") : line).replace(/\/home\/[^/\s]+\//g, "~/");

// A plan's steps as marks: the done ones filled.
function Pips({ done, total }: { done: number; total: number }) {
  if (total > 12) return null;
  return <span className="k-pips" aria-hidden="true">{Array.from({ length: total }, (_, i) => <i key={i} data-done={i < done ? "" : undefined} />)}</span>;
}

// Lines added and removed, as every diff's head says them.
export function Delta({ added, removed }: { added: number; removed: number }) {
  return <span className="k-delta"><span className="text-ok">+{added}</span> <span className="text-danger">-{removed}</span></span>;
}

// The change a call made, as the lines of a diff: the same block Changes and
// Review show. `start`: the line of the file an edit began at, when the tool said so.
const WRITE_SHOWN = 800;
function callFiles(kind: ToolKind, use: ToolUseBlock, cwd?: string, start?: number): CallFile[] | null {
  const input: any = use.input ?? {};
  const { added, removed } = changeOf(use);
  const path = typeof input.file_path === "string" ? input.file_path : "";
  if (kind === "edit" && typeof input.old_string === "string" && typeof input.new_string === "string") {
    // Numbered when the tool said where in the file the text was: a number counted from the snippet's start would name the wrong line.
    let o = start ?? 0, n = start ?? 0;
    const no = (v: number) => (start === undefined ? undefined : v);
    const lines: PatchLine[] = diffLines(splitLines(input.old_string), splitLines(input.new_string)).map((op) =>
      op.t === "+" ? { kind: "add", text: op.line, new: no(n++) } : op.t === "-" ? { kind: "del", text: op.line, old: no(o++) } : { kind: "ctx", text: op.line, old: no(o++), new: no(n++) });
    return [{ path: shortPath(path, cwd), full: path, status: "M", added, removed, lines }];
  }
  if (kind === "write" && typeof input.content === "string") {
    const all = splitLines(input.content);
    const lines: PatchLine[] = all.slice(0, WRITE_SHOWN).map((text, i) => ({ kind: "add", text, new: i + 1 }));
    if (all.length > WRITE_SHOWN) lines.push({ kind: "hunk", text: `${all.length - WRITE_SHOWN} more lines` });
    return [{ path: shortPath(path, cwd), full: path, status: "A", added, removed, lines }];
  }
  if (kind === "patch") {
    return patchFiles(patchText(input)).map((f) => {
      let o = 1, n = 1;
      const known = f.op !== "update"; // a hunk of an update names its place by its context, not by a line number
      const lines: PatchLine[] = f.lines.map((l) =>
        l.startsWith("@@") ? { kind: "hunk", text: l }
          : l[0] === "+" ? { kind: "add", text: l.slice(1), new: known ? n++ : undefined }
          : l[0] === "-" ? { kind: "del", text: l.slice(1), old: known ? o++ : undefined }
          : { kind: "ctx", text: l.slice(1), old: known ? o++ : undefined, new: known ? n++ : undefined });
      return {
        path: f.moveTo ? `${shortPath(f.path, cwd)} → ${shortPath(f.moveTo, cwd)}` : shortPath(f.path, cwd), full: f.moveTo ?? f.path, status: f.op === "add" ? "A" : f.op === "delete" ? "D" : "M",
        added: lines.filter((l) => l.kind === "add").length, removed: lines.filter((l) => l.kind === "del").length, lines,
      };
    });
  }
  return null;
}

// Where a result was cut to fit: the command's whole output is in its log.
const TOO_LARGE = /^Output too large \(([\d.]+ ?KB)\)\. Full output saved to: \S+\n\nPreview \(first ([\d.]+ ?KB)\):\n([\s\S]*?)\n\.\.\.\n?([\s\S]*)$/;
const CUT = /\n\n\[\.\.\. (\d+) (?:characters|chars) cut[^\]]*\]\n\n/;

function Terminal({ name, input, out, error, running, sessionId, callId }: { name: string; input: any; out: string; error: boolean; running?: boolean; sessionId?: string; callId?: string }) {
  const cmd = input.cmd ?? input.command;
  // Output keeps the program's colors, as in a terminal (a test run's red and green).
  const body = shellBody(name, out).trimEnd();
  const big = TOO_LARGE.exec(body);
  const cut = big ? null : CUT.exec(body);
  const shown = big ? big[3]! : body;
  const [whole, setWhole] = useState(false);
  const tone = error ? "text-danger" : "text-muted";
  return (
    <div className="k-terminal overflow-hidden rounded-md border border-line bg-code font-mono text-caption leading-relaxed" data-testid="terminal">
      {cmd && (
        <Copyable text={String(cmd)} label="Copy the command" testid="copy-command">
          <pre className="border-b border-line px-2.5 py-2 pr-9 whitespace-pre-wrap break-all text-fg">
            <span className="select-none text-accent-ink">$ </span>{cmd}
          </pre>
        </Copyable>
      )}
      {name === "write_stdin" && input.chars && <pre className="border-b border-line px-2.5 py-1.5 text-accent-ink">{JSON.stringify(input.chars)}</pre>}
      {running && sessionId && callId ? <CallLog sessionId={sessionId} callId={callId} follow />
        : whole && sessionId && callId ? <CallLog sessionId={sessionId} callId={callId} onLeave={() => setWhole(false)} />
        : shown && (
          <Copyable text={() => stripAnsiText(shown)} label="Copy the output" testid="copy-output">
            {cut ? (
              <pre className={cn("max-h-80 overflow-auto px-2.5 py-2 pr-9 whitespace-pre-wrap break-all", tone)}>
                <Ansi text={shown.slice(0, cut.index)} />
                <span className="k-out-gap" data-testid="output-gap">{Number(cut[1]).toLocaleString("en-US")} characters not shown here</span>
                <Ansi text={shown.slice(cut.index + cut[0].length)} />
              </pre>
            ) : <pre className={cn("max-h-80 overflow-auto px-2.5 py-2 pr-9 whitespace-pre-wrap break-all", tone)}><Ansi text={shown} /></pre>}
          </Copyable>
        )}
      {(big || cut) && !whole && !running && (
        <div className="k-out-more" data-testid="output-more">
          <span>{big ? `The first ${big[2]} of ${big[1]} of output.` : "The start and the end of a long output."}</span>
          {sessionId && callId && <button type="button" data-testid="output-whole" onClick={() => setWhole(true)} className="k-out-link">Show the whole output</button>}
        </div>
      )}
      {big?.[4]?.trim() && <pre className="border-t border-line px-2.5 py-1.5 whitespace-pre-wrap break-all text-faint">{big[4].trim()}</pre>}
    </div>
  );
}

// The output of a call's command from its log: followed while it runs (the
// newest part, as the Terminal pane keeps it), or read from its start a part
// at a time. Until the command has a log the call says that nothing came yet.
type LogPart = { text: string; from: number; to: number; size: number; running?: boolean; job?: string };
function CallLog({ sessionId, callId, follow, onLeave }: { sessionId: string; callId: string; follow?: boolean; onLeave?: () => void }) {
  const [text, setText] = useState("");
  const [part, setPart] = useState<{ from: number; to: number; size: number; before: number[] } | null>(null);
  const [gone, setGone] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  const job = useRef<string | null>(null);
  const read = (from: number) => api<LogPart>(job.current ? `/api/sessions/${sessionId}/terminal/${job.current}/log?from=${from}` : `/api/sessions/${sessionId}/terminal/call/${encodeURIComponent(callId)}/log?from=${from}`)
    .then((r) => { if (r.job) job.current = r.job; return r; });
  useEffect(() => {
    let stop = false;
    let t: Timer | undefined;
    if (!follow) {
      read(0).then((r) => { if (!stop) { setText(r.text); setPart({ ...r, before: [] }); } }).catch((e) => ((e as { status?: number }).status === 404 ? setGone(true) : reportError(e, { at: "call log" })));
      return () => { stop = true; };
    }
    let at = 0;
    const pull = async () => {
      try {
        // Caught up in a few reads; far behind, the newest part is what a follower shows.
        for (let n = 0; !stop && n < 8; n++) {
          const r = await read(at);
          if (r.to > at) { const add = r.text; setText((m) => bounded(m + add, 64 * 1024).text); at = r.to; }
          if (r.to >= r.size) break;
          if (n === 7) at = Math.max(at, r.size - 32 * 1024);
        }
      } catch (e) { if ((e as { status?: number }).status !== 404) reportError(e, { at: "call log" }); }
      if (!stop) t = setTimeout(pull, 1000);
    };
    t = setTimeout(pull, 150);
    return () => { stop = true; clearTimeout(t); };
  }, [sessionId, callId, follow]);
  useEffect(() => { const p = pre.current; if (p && follow) p.scrollTop = p.scrollHeight; }, [text, follow]);
  const go = (from: number, before: number[]) => read(from).then((r) => { setText(r.text); setPart({ ...r, before }); if (pre.current) pre.current.scrollTop = 0; }).catch((e) => reportError(e, { at: "call log" }));
  if (gone) return <p className="k-out-more" data-testid="output-gone"><span>The command's log is no longer kept.</span>{onLeave && <button type="button" onClick={onLeave} className="k-out-link">Back</button>}</p>;
  return (
    <>
      {part && (
        <div className="k-out-more" data-testid="output-log-bar">
          <span className="tabular-nums">The whole output, {part.from.toLocaleString("en-US")} to {part.to.toLocaleString("en-US")} of {part.size.toLocaleString("en-US")} bytes</span>
          {part.before.length > 0 && <button type="button" data-testid="output-prev" className="k-out-link" onClick={() => go(part.before.at(-1)!, part.before.slice(0, -1))}>Earlier part</button>}
          {part.to < part.size && <button type="button" data-testid="output-next" className="k-out-link" onClick={() => go(part.to, [...part.before, part.from])}>Next part</button>}
          {onLeave && <button type="button" data-testid="output-leave" className="k-out-link" onClick={onLeave}>Show less</button>}
        </div>
      )}
      <pre ref={pre} data-testid={follow ? "live-output" : "whole-output"} aria-live={follow ? "off" : undefined} className={cn("overflow-auto px-2.5 py-2 whitespace-pre-wrap break-all text-muted", follow ? "max-h-56" : "max-h-96")}>
        {text ? <Ansi text={text} /> : <span className="text-faint">{follow ? "No output yet." : part ? "Nothing here." : "Reading the log."}</span>}
      </pre>
    </>
  );
}

// The steps of a plan, as a list: under a plan update's line in the conversation, and in the strip above the message box.
// `live`: the list is the plan as it stands now (the strip): the step in progress pulses.
export function PlanCard({ items, explanation, live }: { items: PlanItem[]; explanation?: string; live?: boolean }) {
  return (
    <div className="k-plan px-3 py-2" data-testid="plan">
      {explanation && <p className="mb-2 text-caption text-muted">{explanation}</p>}
      <ul className="flex flex-col gap-1">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-2 text-ui leading-snug" data-status={it.status}>
            <span className="mt-0.5 shrink-0">
              {it.status === "completed" ? <Check className="size-3.5 text-ok" />
                : it.status === "in_progress" ? <CircleDot className={cn("size-3.5 text-accent-ink", live && "animate-pulse-dot")} />
                : it.status === "cancelled" ? <X className="size-3.5 text-faint" />
                : <Circle className="size-3.5 text-faint" />}
            </span>
            <span className={cn(
              it.status === "completed" && "text-muted line-through decoration-line-strong",
              it.status === "in_progress" && "font-medium text-fg",
              it.status === "cancelled" && "text-faint line-through",
              it.status === "pending" && "text-fg/85",
            )}>{it.status === "in_progress" && it.active ? it.active : it.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
