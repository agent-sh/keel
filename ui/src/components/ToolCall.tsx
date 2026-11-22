import { Collapsible } from "@base-ui/react/collapsible";
import { Ansi } from "./Ansi.tsx";
import {
  Brain, Check, ChevronRight, Circle, CircleAlert, CircleCheck, CircleDot, Clock, FilePen, FilePlus2, FileText, FolderSearch, FolderTree, Globe,
  ListChecks, MessageCircleQuestion, NotebookPen, Plug, RotateCcw, Search, Sparkles, SquareTerminal, Square, TriangleAlert, Webhook, Wrench, X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { setUI, useUI } from "../lib/ui.ts";
import type { ToolResultBlock, ToolUseBlock } from "../../../src/core/types.ts";
import { diffLines, splitLines } from "../../../src/tools/diff.ts";
import { api } from "../lib/store.ts";
import { stopKind } from "../../../src/core/stops.ts";
import { allowRetry, refusedBy, useBlocked } from "../lib/blocked.ts";
import {
  patchFiles, planItems, resultImages, resultText, shellBody, splitDiagnostics, splitMemory, splitNested, shellStatus, shortPath, toolKind,
  type PlanItem, type ResultDiagnostics, type ToolKind,
} from "../lib/tools.ts";
import { FLEET_LABEL, fleetSummary, MachineBadge } from "./Fleet.tsx";
import { cn } from "../lib/utils.ts";
import { AGENT_TOOLS, AgentCall, toolSummary } from "./automation/TranscriptExtras.tsx";
import { CodeCall } from "./CodeCall.tsx";
import { ReadersCall } from "./ReadersCall.tsx";
import { Copyable } from "./CopyButton.tsx";
import { stripAnsiText } from "../../../src/core/ansi.ts";
import { AskedUnder, QuestionCard } from "./QuestionCard.tsx";

// The file a call names, for its copy line.
const pathOf = (input: any): string | undefined => { const p = input?.file_path ?? input?.path ?? input?.notebook_path; return typeof p === "string" && p ? p : undefined; };

const ICONS: Record<ToolKind, typeof Wrench> = {
  shell: SquareTerminal, stdin: SquareTerminal, stop: Square, read: FileText, edit: FilePen, write: FilePlus2, patch: FilePen,
  notebook: NotebookPen, search: Search, glob: FolderSearch, list: FolderTree, web: Globe, fetch: Globe, plan: ListChecks,
  ask: MessageCircleQuestion, skill: Sparkles, mcp: Plug, other: Wrench,
};

const LABEL: Partial<Record<ToolKind, string>> = {
  shell: "Run", stdin: "Input", stop: "Stop", read: "Read", edit: "Edit", write: "Write", patch: "Patch", notebook: "Notebook",
  search: "Search", glob: "Find", list: "List", web: "Web search", fetch: "Fetch", plan: "Plan", ask: "Question", skill: "Skill",
};

type Props = { use: ToolUseBlock; result?: ToolResultBlock; live?: boolean; sessionId?: string; cwd?: string };

function summary(kind: ToolKind, name: string, input: any, cwd?: string): string {
  switch (kind) {
    case "shell": return input.description || input.cmd || input.command || "";
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
    case "search": return `${input.pattern ?? ""}${input.path || input.dir_path ? `  in ${shortPath(input.path ?? input.dir_path, cwd)}` : ""}`;
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
  return `${done}/${items.length} done${now ? ` · ${now.active ?? now.text}` : ""}`;
}

// What the owner's hooks did to a call rides with its result: the input they
// gave it in place of the model's, and an allow that answered its ask.
type HookMark = { input?: any; allowed?: string };

// The line that says so: the card shows the input that ran, this names what the model asked for.
function HookRow({ hook, asked, name, cwd, alone }: { hook: HookMark; asked: any; name: string; cwd?: string; alone?: boolean }) {
  return (
    <div className={cn("flex items-start gap-2 px-3 py-2 text-caption text-muted", alone ? "rounded-lg border border-line bg-raised" : "border-t border-line")} data-testid="tool-hook">
      <Webhook className="mt-0.5 size-3.5 shrink-0 text-faint" />
      <p className="min-w-0 flex-1">
        {hook.input !== undefined && <>A hook changed this call before it was judged. The model asked for <span className="font-mono text-micro break-all text-fg" data-testid="tool-asked">{summary(toolKind(name), name, asked ?? {}, cwd) || JSON.stringify(asked ?? {}).slice(0, 400)}</span>. </>}
        {hook.allowed !== undefined && <span data-testid="tool-hook-allowed">A hook allowed it without asking you{hook.allowed ? `: ${hook.allowed}` : ""}.</span>}
      </p>
    </div>
  );
}

// The cards of calls that change files: only they show a diagnostics row.
const EDITS = new Set<ToolKind>(["edit", "write", "patch", "notebook"]);

// What a language server found after the edit, as the model was told it:
// always in view under the call, the new ones listed, a fix as one line.
function DiagnosticsRow({ d }: { d: ResultDiagnostics }) {
  const errors = d.lines.some((l) => l.severity === "error");
  const Icon = d.pending && !d.lines.length ? Clock : errors ? CircleAlert : d.lines.length ? TriangleAlert : CircleCheck;
  return (
    <div className="flex items-start gap-2 border-t border-line px-3 py-2 text-caption" data-testid="tool-diagnostics" data-state={errors ? "errors" : d.lines.length ? "warnings" : d.pending ? "pending" : "fixed"}>
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", errors ? "text-danger" : d.lines.length ? "text-warn" : d.pending ? "text-faint" : "text-ok")} />
      <div className="min-w-0 flex-1">
        <p className="text-muted">
          <span className="font-medium text-fg">{d.server || "Diagnostics"}</span>
          {d.late && <span className="text-faint"> · from an earlier edit</span>}
          <span data-testid="tool-diagnostics-head"> · {d.head}</span>
        </p>
        {d.lines.length > 0 && (
          <ul className="mt-1 flex flex-col gap-0.5 font-mono text-micro leading-relaxed">
            {d.lines.map((l, i) => (
              <li key={i} className="break-words" data-testid="tool-diagnostic">
                <span className="text-faint">{l.where}</span> <span className={l.severity === "error" ? "text-danger" : "text-warn"}>{l.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// A result that was cut names the file with all of it ("saved to <path>").
// Whether the storage retention has removed that file since: asked once per
// result that names one, so the row says what became of it.
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

export function ToolCall({ use: asked, result, live, sessionId, cwd }: Props) {
  const hook = (result as (ToolResultBlock & { shown?: { hook?: HookMark } }) | undefined)?.shown?.hook;
  // Every card shows the input that ran.
  const use = hook?.input !== undefined ? { ...asked, input: hook.input } : asked;
  const beside = (card: ReactNode) => (hook ? <div className="flex flex-col gap-1.5">{card}<HookRow hook={hook} asked={asked.input} name={use.name} cwd={cwd} alone /></div> : card);
  if (AGENT_TOOLS.has(use.name)) return beside(<AgentCall use={use} result={result} live={live} />);
  if (use.name === "run_code") return beside(<CodeCall use={use} result={result} live={live} sessionId={sessionId} cwd={cwd} />);
  if (use.name === "AskReaders" || use.name === "ask_readers") return beside(<ReadersCall use={use} result={result} live={live} sessionId={sessionId} cwd={cwd} />);
  const kind = toolKind(use.name);
  const input: any = use.input ?? {};
  if (kind === "ask" && !live) return beside(<QuestionCard use={use} result={result} sessionId={sessionId} />);
  if (kind === "plan" && !live) return beside(<PlanCard items={planItems(use.name, input)} explanation={input.explanation} rejected={result?.is_error ? resultText(result) : undefined} />);
  const call = <GenericCall use={use} result={result} live={live} sessionId={sessionId} cwd={cwd} kind={kind} input={input} hook={hook} asked={asked.input} />;
  // A server asked the owner something while this call runs: a line says so under the call.
  return result ? call : <AskedUnder use={use} sessionId={sessionId}>{call}</AskedUnder>;
}

function GenericCall({ use, result, live, sessionId, cwd, kind, input, hook, asked }: Props & { kind: ToolKind; input: any; hook?: HookMark; asked?: any }) {
  const Icon = ICONS[kind];
  const { text: out, nested, memory, diagnostics } = useMemo(() => { const m = splitMemory(resultText(result)); const d = EDITS.has(kind) ? splitDiagnostics(m.text) : { text: m.text, diagnostics: [] }; return { ...splitNested(d.text), memory: m.memory, diagnostics: d.diagnostics }; }, [result, kind]);
  const images = resultImages(result);
  const spillGone = useSpillRemoved(sessionId, out);
  const refused = useBlocked(sessionId).find((b) => b.calls?.includes(use.id));
  // A call the owner's stop or a daemon restart ended did not fail: it reads "stopped" or "cut".
  const ended = result?.is_error ? stopKind(result.content) : undefined;
  const state = !result ? "running" : refused ? "refused" : ended ?? (result.is_error ? "error" : "ok");
  const diff = useMemo(() => editDiff(kind, input), [kind, input]);
  const shell = kind === "shell" || kind === "stdin" ? shellStatus(out) : {};
  // Diffs are what the owner wants to see: small ones start open.
  const [open, setOpen] = useState(() => !!diff && diff.lines.length <= 40 && !live);
  // A search hit on this call or its output opens this card (not a sibling call of the same reply).
  const focused = useUI((s) => s.focusCall === use.id);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focused) return;
    setOpen(true);
    setUI({ focusCall: null });
    // After the transcript has scrolled to the reply that holds it (its frame comes first).
    requestAnimationFrame(() => requestAnimationFrame(() => { root.current?.scrollIntoView({ block: "center" }); root.current?.classList.add("flash"); setTimeout(() => root.current?.classList.remove("flash"), 1600); }));
  }, [focused]);
  return (
    <Collapsible.Root ref={root} open={open} onOpenChange={setOpen} className="k-tool-call group/tool rounded-lg border border-line bg-raised shadow-1 animate-in" data-testid="tool-call" data-call={use.id} data-tool={use.name} data-state={live ? "live" : state} data-kind={kind}>
      <Collapsible.Trigger className="flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-ui hover:bg-hover">
        <span className={cn("grid size-6 shrink-0 place-items-center rounded-sm", state === "error" || state === "refused" ? "bg-danger-soft text-danger" : state === "running" ? "bg-brass-soft text-brass" : "bg-sunken text-muted")}>
          <Icon className="size-3.5" />
        </span>
        <span className="k-tool-name shrink-0 font-medium">{LABEL[kind] ?? FLEET_LABEL[use.name] ?? use.name}</span>
        <span className={cn("min-w-0 truncate text-muted", kind === "shell" && input.description ? "text-ui" : "font-mono text-caption")}>{summary(kind, use.name, input, cwd)}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-micro tabular-nums">
          <MachineBadge sessionId={sessionId} callId={use.id} />
          {diff && (diff.added > 0 || diff.removed > 0) && (
            <span className="font-mono"><span className="text-ok">+{diff.added}</span> <span className="text-danger">-{diff.removed}</span></span>
          )}
          {nested.length > 0 && <span className="rounded-full bg-sunken px-1.5 py-px text-muted" data-testid="tool-nested" title={nested.map((n) => n.path).join("\n")}>+ {nested.length === 1 ? shortPath(nested[0]!.path, cwd) : `${nested.length} instruction files`}</span>}
          {hook?.input !== undefined && <span className="rounded-full bg-sunken px-1.5 py-px text-muted" data-testid="tool-rewritten">changed by a hook</span>}
          {shell.background && <span className="rounded-full bg-accent-soft px-1.5 py-px text-accent-ink" data-testid="tool-background">background</span>}
          {shell.session && <span className="rounded-full bg-accent-soft px-1.5 py-px text-accent-ink">session {shell.session}</span>}
          {state === "running" && <span className="size-1.5 rounded-full bg-brass animate-pulse-dot" />}
          {state === "error" && <span className="text-danger">{shell.exit !== undefined ? `exit ${shell.exit}` : "failed"}</span>}
          {ended && <span className="text-warn" data-testid="tool-ended" title={ended === "cut" ? "A daemon restart cut this call. It may have partly run." : "You stopped the turn while this call ran."}>{ended === "cut" ? "cut by a restart" : "stopped"}</span>}
          {state === "refused" && <span className="text-danger" data-testid="tool-refused">refused</span>}
          <ChevronRight className="size-3.5 text-faint transition-transform group-data-[open]/tool:rotate-90" />
        </span>
      </Collapsible.Trigger>
      {refused && sessionId && (
        // A refused call says so where it sits: who refused it, why, and the retry the owner can let through.
        <div className="flex items-start gap-3 border-t border-line px-3 py-2" data-testid="tool-refusal">
          <p className="min-w-0 flex-1 text-caption text-muted"><span className="font-medium text-danger">{refusedBy(refused)}.</span> {refused.reason}</p>
          {refused.retry
            ? <span className="shrink-0 text-caption text-faint" data-testid="tool-retry-allowed">Retry allowed</span>
            : <button data-testid="tool-retry" onClick={() => allowRetry(sessionId, refused.id)} className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line px-2.5 text-caption hover:bg-hover"><RotateCcw className="size-3" /> Allow one retry</button>}
        </div>
      )}
      {hook && <HookRow hook={hook} asked={asked} name={use.name} cwd={cwd} />}
      {diagnostics.map((d, i) => <DiagnosticsRow key={i} d={d} />)}
      <Collapsible.Panel className="k-tool-panel overflow-hidden border-t border-line">
        {pathOf(input) && kind !== "shell" && (
          <Copyable text={pathOf(input)!} label="Copy the path" testid="copy-path" className="k-tool-path">
            <span className="block truncate px-3 pt-2 pr-9 font-mono text-micro text-faint" title={pathOf(input)}>{pathOf(input)}</span>
          </Copyable>
        )}
        {(kind === "shell" || kind === "stdin") && <Terminal name={use.name} input={input} out={out} error={state === "error"} />}
        {diff && <DiffView diff={diff} />}
        {kind === "write" && input.content !== undefined && <Preview text={String(input.content)} />}
        {!diff && kind !== "shell" && kind !== "stdin" && kind !== "write" && !live && kind === "other" && (
          <Copyable text={JSON.stringify(input, null, 2)} label="Copy the input" testid="copy-input">
            <pre className="px-3 pt-2.5 pr-9 font-mono text-micro whitespace-pre-wrap break-all text-faint">{JSON.stringify(input, null, 2).slice(0, 4000)}</pre>
          </Copyable>
        )}
        {kind !== "shell" && kind !== "stdin" && out && (!diff || state === "error") && (
          <Copyable text={out} label="Copy the output" testid="copy-output" className="m-2.5">
            <pre className={cn(
              "max-h-80 overflow-auto rounded-md border border-line bg-code p-2.5 pr-9 font-mono text-caption leading-relaxed whitespace-pre-wrap break-all",
              result?.is_error && !ended ? "text-danger" : "text-muted",
            )}>{out}</pre>
          </Copyable>
        )}
        {spillGone && <p className="mx-2.5 mb-2.5 text-caption text-faint" data-testid="spill-removed">The full output this result names was removed by the storage retention. Run the command again to get it.</p>}
        {nested.map((n) => (
          <details key={n.path} className="mx-2.5 mb-2.5 rounded-md border border-line bg-sunken" data-testid="nested-instructions">
            <summary className="cursor-pointer px-2.5 py-1.5 text-caption text-muted">Instructions loaded: <span className="font-mono">{shortPath(n.path, cwd)}</span></summary>
            <pre className="max-h-64 overflow-auto border-t border-line p-2.5 font-mono text-caption leading-relaxed whitespace-pre-wrap break-words text-muted">{n.body}</pre>
          </details>
        ))}
        {memory.map((m, i) => (
          <details key={i} className="mx-2.5 mb-2.5 rounded-md border border-line bg-sunken" data-testid="tool-memory">
            <summary className="flex cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-caption text-muted"><Brain className="size-3.5 text-faint" />Memory from {m.source}<span className="text-faint">· {m.hook}</span></summary>
            <pre className="max-h-64 overflow-auto border-t border-line p-2.5 font-mono text-caption leading-relaxed whitespace-pre-wrap break-words text-muted">{m.body}</pre>
          </details>
        ))}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pb-3">
            {images.map((im, i) => <img key={i} src={`data:${im.media_type};base64,${im.data}`} className="max-h-64 rounded-lg border border-line" alt="" />)}
          </div>
        )}
        {!out && !diff && kind !== "shell" && <div className="h-2.5" />}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function Terminal({ name, input, out, error }: { name: string; input: any; out: string; error: boolean }) {
  const cmd = input.cmd ?? input.command;
  // Output keeps the program's colors, as in a terminal (a test run's red and green).
  const body = shellBody(name, out).trimEnd();
  return (
    <div className="k-terminal m-2.5 overflow-hidden rounded-md border border-line bg-code font-mono text-caption leading-relaxed" data-testid="terminal">
      {cmd && (
        <Copyable text={String(cmd)} label="Copy the command" testid="copy-command">
          <pre className="border-b border-line px-2.5 py-2 pr-9 whitespace-pre-wrap break-all text-fg">
            <span className="select-none text-accent-ink">$ </span>{cmd}
          </pre>
        </Copyable>
      )}
      {name === "write_stdin" && input.chars && <pre className="border-b border-line px-2.5 py-1.5 text-accent-ink">{JSON.stringify(input.chars)}</pre>}
      {body && (
        <Copyable text={() => stripAnsiText(body)} label="Copy the output" testid="copy-output">
          <pre className={cn("max-h-80 overflow-auto px-2.5 py-2 pr-9 whitespace-pre-wrap break-all", error ? "text-danger" : "text-muted")}><Ansi text={body} /></pre>
        </Copyable>
      )}
    </div>
  );
}

type Diff = { files: { path?: string; op?: string; lines: { t: " " | "+" | "-" | "@"; text: string }[] }[]; lines: unknown[]; added: number; removed: number };

function editDiff(kind: ToolKind, input: any): Diff | null {
  if (kind === "edit" && typeof input.old_string === "string" && typeof input.new_string === "string") {
    const ops = diffLines(splitLines(input.old_string), splitLines(input.new_string));
    const lines = ops.map((o) => ({ t: o.t, text: o.line }));
    return { files: [{ lines }], lines, added: ops.filter((o) => o.t === "+").length, removed: ops.filter((o) => o.t === "-").length };
  }
  if (kind === "patch") {
    const files = patchFiles(patchText(input)).map((f) => ({
      path: f.moveTo ? `${f.path} → ${f.moveTo}` : f.path, op: f.op,
      lines: f.lines.map((l) => ({ t: (l.startsWith("@@") ? "@" : l[0] === "+" || l[0] === "-" ? l[0] : " ") as " " | "+" | "-" | "@", text: l.startsWith("@@") ? l : l.slice(1) })),
    }));
    const all = files.flatMap((f) => f.lines);
    return { files, lines: all, added: all.filter((l) => l.t === "+").length, removed: all.filter((l) => l.t === "-").length };
  }
  return null;
}

function DiffView({ diff }: { diff: Diff }) {
  return (
    <div className="k-diff m-2.5 flex flex-col gap-2" data-testid="diff">
      {diff.files.map((f, i) => (
        <div key={i} className="overflow-hidden rounded-md border border-line bg-code">
          {f.path && (
            <div className="flex items-center gap-2 border-b border-line px-2.5 py-1.5 text-micro">
              <span className={cn("rounded px-1 font-medium uppercase tracking-wide", f.op === "add" ? "text-ok" : f.op === "delete" ? "text-danger" : "text-muted")}>{f.op}</span>
              <span className="truncate font-mono text-fg">{f.path}</span>
            </div>
          )}
          <div className="max-h-96 overflow-auto py-1 font-mono text-caption leading-[1.55]">
            {f.lines.map((l, j) => (
              <div key={j} className={cn(
                "flex px-2.5 whitespace-pre-wrap break-all",
                l.t === "+" && "bg-ok/12 text-fg", l.t === "-" && "bg-danger/10 text-fg", l.t === " " && "text-muted", l.t === "@" && "text-faint",
              )}>
                <span className={cn("w-4 shrink-0 select-none", l.t === "+" ? "text-ok" : l.t === "-" ? "text-danger" : "text-faint")}>{l.t === "@" ? "" : l.t}</span>
                <span className="min-w-0">{l.text || " "}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Preview({ text }: { text: string }) {
  const lines = text.split("\n");
  const shown = lines.slice(0, 60);
  return (
    <div className="m-3 mt-2.5 overflow-hidden rounded-md border border-line bg-code">
      <Copyable text={text} label="Copy the content" testid="copy-content">
        <pre className="max-h-80 overflow-auto px-2.5 py-2 pr-9 font-mono text-caption leading-[1.55] whitespace-pre-wrap break-all text-muted">{shown.join("\n")}</pre>
      </Copyable>
      {lines.length > shown.length && <div className="border-t border-line px-2.5 py-1 text-micro text-faint">{lines.length - shown.length} more lines</div>}
    </div>
  );
}

// `rejected`: the tool refused this update (its error); the plan before it stands.
export function PlanCard({ items, explanation, compact, rejected }: { items: PlanItem[]; explanation?: string; compact?: boolean; rejected?: string }) {
  // Only the live checklist (the dock) pulses; plans in the transcript are history.
  const done = items.filter((i) => i.status === "completed").length;
  return (
    <div className={cn("k-plan rounded-lg border bg-raised shadow-1 animate-in", rejected ? "border-warn/40" : "border-line", compact ? "px-3 py-2" : "px-3.5 py-3")} data-testid="plan" data-rejected={rejected ? "" : undefined}>
      {!compact && (
        <div className="mb-2 flex items-center gap-2 text-ui">
          <ListChecks className="size-3.5 text-muted" />
          <span className="font-medium">{rejected ? "Plan update not applied" : "Plan"}</span>
          {!rejected && (
            <>
              <span className="text-caption text-faint tabular-nums">{done}/{items.length}</span>
              <div className="ml-auto h-1 w-24 overflow-hidden rounded-full bg-line">
                <div className="k-plan-fill h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${items.length ? (100 * done) / items.length : 0}%` }} />
              </div>
            </>
          )}
        </div>
      )}
      {rejected && <p className={cn("text-caption text-warn", items.length > 0 && "mb-2")} data-testid="plan-rejected">{rejected} The plan before it stays.</p>}
      {explanation && !compact && <p className="mb-2 text-caption text-muted">{explanation}</p>}
      <ul className={cn("flex flex-col gap-1", rejected && "opacity-60")}>
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-2 text-ui leading-snug" data-status={it.status}>
            <span className="mt-0.5 shrink-0">
              {it.status === "completed" ? <Check className="size-3.5 text-ok" />
                : it.status === "in_progress" ? <CircleDot className={cn("size-3.5 text-accent-ink", compact && "animate-pulse-dot")} />
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
