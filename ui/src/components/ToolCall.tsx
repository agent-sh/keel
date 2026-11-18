import { Collapsible } from "@base-ui/react/collapsible";
import {
  Check, ChevronRight, Circle, CircleDot, FilePen, FilePlus2, FileText, FolderSearch, FolderTree, Globe,
  ListChecks, MessageCircleQuestion, NotebookPen, Plug, Search, Sparkles, SquareTerminal, Square, Wrench, X,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { ToolResultBlock, ToolUseBlock } from "../../../src/core/types.ts";
import { diffLines, splitLines } from "../../../src/tools/diff.ts";
import { actions } from "../lib/store.ts";
import {
  patchFiles, planItems, questions, resultImages, resultText, shellBody, shellStatus, shortPath, stripAnsi, toolKind,
  type PlanItem, type ToolKind,
} from "../lib/tools.ts";
import { FLEET_LABEL, fleetSummary, MachineBadge } from "./Fleet.tsx";
import { cn } from "../lib/utils.ts";
import { AGENT_TOOLS, AgentCall, toolSummary } from "./automation/TranscriptExtras.tsx";

const ICONS: Record<ToolKind, typeof Wrench> = {
  shell: SquareTerminal, stdin: SquareTerminal, stop: Square, read: FileText, edit: FilePen, write: FilePlus2, patch: FilePen,
  notebook: NotebookPen, search: Search, glob: FolderSearch, list: FolderTree, web: Globe, fetch: Globe, plan: ListChecks,
  ask: MessageCircleQuestion, skill: Sparkles, mcp: Plug, other: Wrench,
};

const LABEL: Partial<Record<ToolKind, string>> = {
  shell: "Run", stdin: "Input", stop: "Stop", read: "Read", edit: "Edit", write: "Write", patch: "Patch", notebook: "Notebook",
  search: "Search", glob: "Find", list: "List", web: "Web search", fetch: "Fetch", plan: "Plan", ask: "Question", skill: "Skill",
};

type Props = { use: ToolUseBlock; result?: ToolResultBlock; live?: boolean; sessionId?: string; cwd?: string; waiting?: boolean };

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
    case "mcp": return name === "search_tools" ? `search ${input.query ?? ""}` : input.tool ?? name;
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

export function ToolCall({ use, result, live, sessionId, cwd, waiting }: Props) {
  if (AGENT_TOOLS.has(use.name)) return <AgentCall use={use} result={result} live={live} />;
  const kind = toolKind(use.name);
  const input: any = use.input ?? {};
  if (kind === "ask" && !live) return <QuestionCard use={use} result={result} sessionId={sessionId} waiting={waiting} />;
  if (kind === "plan" && !live) return <PlanCard items={planItems(use.name, input)} explanation={input.explanation} />;
  return <GenericCall use={use} result={result} live={live} sessionId={sessionId} cwd={cwd} kind={kind} input={input} />;
}

function GenericCall({ use, result, live, sessionId, cwd, kind, input }: Props & { kind: ToolKind; input: any }) {
  const Icon = ICONS[kind];
  const out = resultText(result);
  const images = resultImages(result);
  const state = !result ? "running" : result.is_error ? "error" : "ok";
  const diff = useMemo(() => editDiff(kind, input), [kind, input]);
  const shell = kind === "shell" || kind === "stdin" ? shellStatus(out) : {};
  // Diffs are what the owner wants to see: small ones start open.
  const [open, setOpen] = useState(() => !!diff && diff.lines.length <= 40 && !live);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="group/tool rounded-lg border border-line bg-raised shadow-1 animate-in" data-testid="tool-call" data-tool={use.name} data-state={live ? "live" : state} data-kind={kind}>
      <Collapsible.Trigger className="flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-ui hover:bg-hover">
        <span className={cn("grid size-6 shrink-0 place-items-center rounded-sm", state === "error" ? "bg-danger-soft text-danger" : state === "running" ? "bg-brass-soft text-brass" : "bg-sunken text-muted")}>
          <Icon className="size-3.5" />
        </span>
        <span className="shrink-0 font-medium">{LABEL[kind] ?? FLEET_LABEL[use.name] ?? use.name}</span>
        <span className={cn("min-w-0 truncate text-muted", kind === "shell" && input.description ? "text-ui" : "font-mono text-caption")}>{summary(kind, use.name, input, cwd)}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-micro tabular-nums">
          <MachineBadge sessionId={sessionId} callId={use.id} />
          {diff && (diff.added > 0 || diff.removed > 0) && (
            <span className="font-mono"><span className="text-ok">+{diff.added}</span> <span className="text-danger">-{diff.removed}</span></span>
          )}
          {shell.background && <span className="rounded-full bg-accent-soft px-1.5 py-px text-accent-ink" data-testid="tool-background">background</span>}
          {shell.session && <span className="rounded-full bg-accent-soft px-1.5 py-px text-accent-ink">session {shell.session}</span>}
          {state === "running" && <span className="size-1.5 rounded-full bg-brass animate-pulse-dot" />}
          {state === "error" && <span className="text-danger">{shell.exit !== undefined ? `exit ${shell.exit}` : "failed"}</span>}
          <ChevronRight className="size-3.5 text-faint transition-transform group-data-[open]/tool:rotate-90" />
        </span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="overflow-hidden border-t border-line">
        {(kind === "shell" || kind === "stdin") && <Terminal name={use.name} input={input} out={out} error={state === "error"} />}
        {diff && <DiffView diff={diff} />}
        {kind === "write" && input.content !== undefined && <Preview text={String(input.content)} />}
        {!diff && kind !== "shell" && kind !== "stdin" && kind !== "write" && !live && kind === "other" && (
          <pre className="px-3 pt-2.5 font-mono text-micro whitespace-pre-wrap break-all text-faint">{JSON.stringify(input, null, 2).slice(0, 4000)}</pre>
        )}
        {kind !== "shell" && kind !== "stdin" && out && (!diff || state === "error") && (
          <pre className={cn(
            "m-2.5 max-h-80 overflow-auto rounded-md border border-line bg-code p-2.5 font-mono text-caption leading-relaxed whitespace-pre-wrap break-all",
            result?.is_error ? "text-danger" : "text-muted",
          )}>{out}</pre>
        )}
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
  const body = stripAnsi(shellBody(name, out)).trimEnd();
  return (
    <div className="m-2.5 overflow-hidden rounded-md border border-line bg-code font-mono text-caption leading-relaxed" data-testid="terminal">
      {cmd && (
        <pre className="border-b border-line px-2.5 py-2 whitespace-pre-wrap break-all text-fg">
          <span className="select-none text-accent-ink">$ </span>{cmd}
        </pre>
      )}
      {name === "write_stdin" && input.chars && <pre className="border-b border-line px-2.5 py-1.5 text-accent-ink">{JSON.stringify(input.chars)}</pre>}
      {body && <pre className={cn("max-h-80 overflow-auto px-2.5 py-2 whitespace-pre-wrap break-all", error ? "text-danger" : "text-muted")}>{body}</pre>}
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
    <div className="m-2.5 flex flex-col gap-2" data-testid="diff">
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
      <pre className="max-h-80 overflow-auto px-2.5 py-2 font-mono text-caption leading-[1.55] whitespace-pre-wrap break-all text-muted">{shown.join("\n")}</pre>
      {lines.length > shown.length && <div className="border-t border-line px-2.5 py-1 text-micro text-faint">{lines.length - shown.length} more lines</div>}
    </div>
  );
}

export function PlanCard({ items, explanation, compact }: { items: PlanItem[]; explanation?: string; compact?: boolean }) {
  // Only the live checklist (the dock) pulses; plans in the transcript are history.
  const done = items.filter((i) => i.status === "completed").length;
  return (
    <div className={cn("rounded-lg border border-line bg-raised shadow-1 animate-in", compact ? "px-3 py-2" : "px-3.5 py-3")} data-testid="plan">
      {!compact && (
        <div className="mb-2 flex items-center gap-2 text-ui">
          <ListChecks className="size-3.5 text-muted" />
          <span className="font-medium">Plan</span>
          <span className="text-caption text-faint tabular-nums">{done}/{items.length}</span>
          <div className="ml-auto h-1 w-24 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${items.length ? (100 * done) / items.length : 0}%` }} />
          </div>
        </div>
      )}
      {explanation && !compact && <p className="mb-2 text-caption text-muted">{explanation}</p>}
      <ul className="flex flex-col gap-1">
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

function QuestionCard({ use, result, sessionId, waiting }: Props) {
  const qs = questions(use.name, use.input);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const answered = !!result && !result.is_error;
  const open = !result && waiting;
  const toggle = (q: { id: string; multi: boolean }, label: string) => setPicked((p) => {
    const cur = p[q.id] ?? [];
    return { ...p, [q.id]: q.multi ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label] };
  });
  const ready = qs.every((q) => (picked[q.id]?.length ?? 0) > 0 || (other[q.id] ?? "").trim());
  const submit = async () => {
    if (!sessionId) return;
    setSending(true);
    setErr("");
    try {
      await actions.answer(sessionId, use.id, Object.fromEntries(qs.map((q) => [q.id, { picked: picked[q.id] ?? [], other: other[q.id] }])));
    } catch (e) {
      setErr((e as Error).message);
      setSending(false);
    }
  };
  return (
    <div className={cn("rounded-lg border bg-raised animate-in", open ? "border-accent/50 shadow-2" : "border-line shadow-1")} data-testid="question" data-state={open ? "open" : answered ? "answered" : "closed"}>
      <div className="flex items-center gap-2 border-b border-line px-3.5 py-2 text-ui">
        <MessageCircleQuestion className={cn("size-3.5", open ? "text-accent-ink" : "text-muted")} />
        <span className="font-medium">{open ? "The agent is asking" : answered ? "Answered" : "Question"}</span>
        {open && <span className="ml-auto size-1.5 rounded-full bg-accent animate-pulse-dot" />}
      </div>
      <div className="flex flex-col gap-4 px-3.5 py-3">
        {qs.map((q) => (
          <fieldset key={q.id} className="flex flex-col gap-2">
            <legend className="mb-1.5 flex items-baseline gap-2">
              {q.header && <span className="rounded-md bg-accent-soft px-1.5 py-px text-micro font-medium uppercase tracking-wide text-accent-ink">{q.header}</span>}
              <span className="text-read font-medium leading-snug">{q.question}</span>
            </legend>
            {q.options.length > 0 && (
              <div className={cn("grid gap-1.5", q.options.length > 2 ? "sm:grid-cols-2" : "sm:grid-cols-2")} role={q.multi ? "group" : "radiogroup"}>
                {q.options.map((o) => {
                  const on = (picked[q.id] ?? []).includes(o.label);
                  return (
                    <button
                      key={o.label}
                      type="button"
                      role={q.multi ? "checkbox" : "radio"}
                      aria-checked={on}
                      disabled={!open || sending}
                      onClick={() => toggle(q, o.label)}
                      data-testid="question-option"
                      className={cn(
                        "flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/30",
                        on ? "border-accent bg-accent-soft" : "border-line bg-sunken hover:border-line-strong",
                        !open && "cursor-default opacity-80",
                      )}
                    >
                      <span className="text-ui font-medium">{o.label}</span>
                      {o.description && <span className="text-caption leading-snug text-muted">{o.description}</span>}
                    </button>
                  );
                })}
              </div>
            )}
            {open && (
              <input
                value={other[q.id] ?? ""}
                onChange={(e) => setOther((o) => ({ ...o, [q.id]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === "Enter" && ready) submit(); }}
                placeholder={q.options.length ? "Or type your own answer" : "Type your answer"}
                data-testid="question-other"
                className="h-8 rounded-md border border-line bg-sunken px-3 text-ui outline-none placeholder:text-faint focus:border-accent"
              />
            )}
          </fieldset>
        ))}
        {open && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={!ready || sending}
              onClick={submit}
              data-testid="question-submit"
              className="h-8 rounded-md bg-accent px-3.5 hover:bg-accent-hover text-ui font-medium text-accent-fg transition-opacity disabled:opacity-40"
            >
              {sending ? "Sending" : "Answer"}
            </button>
            {err && <span className="text-caption text-danger">{err}</span>}
          </div>
        )}
        {result && (
          <p className={cn("text-caption", result.is_error ? "text-danger" : "text-muted")} data-testid="question-result">
            {answerSummary(resultText(result))}
          </p>
        )}
      </div>
    </div>
  );
}

function answerSummary(text: string): string {
  const pairs = [...text.matchAll(/"([^"]*)"="([^"]*)"/g)].map((m) => m[2]);
  if (pairs.length) return `Answered: ${pairs.join(" · ")}`;
  try {
    const j = JSON.parse(text);
    return `Answered: ${Object.values(j.answers ?? {}).map((v: any) => (Array.isArray(v?.answers) ? v.answers.join(", ") : String(v))).join(" · ")}`;
  } catch {
    return text;
  }
}

