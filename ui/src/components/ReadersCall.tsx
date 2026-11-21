import { Collapsible } from "@base-ui/react/collapsible";
import { BookOpenText, ChevronRight } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { ToolResultBlock, ToolUseBlock } from "../../../src/core/types.ts";
import type { PartState, ReadProgress } from "../../../src/engine/readers.ts";
import { onFeature } from "../lib/store.ts";
import { resultText, shortPath } from "../lib/tools.ts";
import { cn, fmtCost } from "../lib/utils.ts";
import { Markdown } from "./Markdown.tsx";

type Shown = {
  question: string; whole?: boolean; sources: number; chars: number; parts?: PartState[]; models?: string[];
  cost?: number; plan?: boolean; working?: { model: string; cost?: number }; unread?: string[]; skipped?: string[]; compiled?: boolean;
  checked?: { quotes: number; verbatim: number; atLine: number; refs: number; valid: number };
};
type Props = { use: ToolUseBlock; result?: ToolResultBlock; live?: boolean; sessionId?: string; cwd?: string };

// A job's progress while it runs, by call id (feature frames "readers").
const progress = new Map<string, ReadProgress>();
const subs = new Set<() => void>();
onFeature({
  frame(f) {
    if (f.name !== "readers") return;
    const { call_id, ...p } = f.data as ReadProgress & { call_id: string };
    progress.set(call_id, p);
    for (const s of subs) s();
  },
});
const subscribe = (cb: () => void) => { subs.add(cb); return () => void subs.delete(cb); };

const DOT: Record<PartState["state"], string> = { waiting: "bg-faint", reading: "bg-brass animate-pulse-dot", read: "bg-ok", nothing: "bg-line-strong", unread: "bg-danger" };
const WORD: Record<PartState["state"], string> = { waiting: "waiting", reading: "reading", read: "findings", nothing: "nothing relevant", unread: "unread" };

// A reading job: the question, its parts and who read each, what it cost
// against the working model reading the same material, and the compiled answer.
export function ReadersCall({ use, result, live, sessionId, cwd }: Props) {
  const input: any = use.input ?? {};
  const shown = (result as (ToolResultBlock & { shown?: { readers?: Shown } }) | undefined)?.shown?.readers;
  const now = useSyncExternalStore(subscribe, () => progress.get(use.id));
  useEffect(() => { if (result) progress.delete(use.id); }, [result, use.id]);
  const parts = shown?.parts ?? now?.parts ?? [];
  const state = live ? "live" : !result ? "running" : result.is_error ? "error" : "ok";
  const [open, setOpen] = useState(false);
  const out = resultText(result);
  // The answer is the result's text before Keel's own bracketed notes.
  const cut = out.search(/\n\n\[(?:[^\n]* read (?:every line of )?\d+ sources?|Short enough|No reader)/);
  const answer = cut >= 0 ? out.slice(0, cut) : out;
  const notes = cut >= 0 ? out.slice(cut).trim() : "";
  const done = parts.filter((p) => p.state !== "waiting" && p.state !== "reading").length;
  const sources = [...(input.paths ?? []), ...(input.urls ?? [])].map(String);
  const short = (covers: string) => covers.split(", ").map((c) => shortPath(c, cwd)).join(", ");
  // One model read every part: named once in the summary, not on each row.
  const oneModel = new Set(parts.map((p) => p.model).filter(Boolean)).size <= 1;
  const other = shown?.working && !(shown.models?.length === 1 && shown.models[0] === shown.working.model);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="group/tool rounded-lg border border-line bg-raised shadow-1 animate-in" data-testid="tool-call" data-call={use.id} data-tool={use.name} data-state={state} data-kind="readers">
      <Collapsible.Trigger className="flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-ui hover:bg-hover">
        <span className={cn("grid size-6 shrink-0 place-items-center rounded-sm", state === "error" ? "bg-danger-soft text-danger" : state === "running" || state === "live" ? "bg-brass-soft text-brass" : "bg-sunken text-muted")}>
          <BookOpenText className="size-3.5" />
        </span>
        <span className="shrink-0 font-medium">Readers</span>
        <span className="min-w-0 truncate text-muted">{input.question ?? ""}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-micro tabular-nums">
          {parts.length > 0 && (
            <span className="rounded-full bg-sunken px-1.5 py-px text-muted" data-testid="readers-parts">
              {result ? `${parts.length} part${parts.length === 1 ? "" : "s"}` : `${done}/${parts.length} read${now?.compiling ? " · compiling" : ""}`}
            </span>
          )}
          {shown?.models?.length ? <span className="text-muted">{shown.models.join(", ")}</span> : null}
          {shown?.cost !== undefined ? <span className="font-mono text-muted" data-testid="readers-cost">{fmtCost(shown.cost)}</span> : shown?.plan ? <span className="text-muted" data-testid="readers-cost">on plan</span> : null}
          {shown?.unread?.length ? <span className="text-danger">{shown.unread.length} unread</span> : null}
          {(state === "running" || state === "live") && <span className="size-1.5 rounded-full bg-brass animate-pulse-dot" />}
          {state === "error" && <span className="text-danger">failed</span>}
          <ChevronRight className="size-3.5 text-faint transition-transform group-data-[open]/tool:rotate-90" />
        </span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="k-tool-panel overflow-hidden border-t border-line" data-testid="readers-panel">
        <div className="flex flex-col gap-2.5 p-2.5">
          {sources.length > 0 && <div className="truncate font-mono text-micro text-faint" title={sources.join("\n")}>{sources.map((x) => shortPath(x, cwd)).join("  ")}</div>}
          {shown && (
            <div className="text-caption text-muted" data-testid="readers-summary">
              {shown.sources} source{shown.sources === 1 ? "" : "s"}, {shown.chars.toLocaleString("en-US")} characters
              {shown.whole ? ", short enough to read whole" : shown.models?.length ? ` read by ${shown.models.join(" and ")}${shown.compiled ? ", findings compiled" : ""}` : " read"}
              {shown.checked && shown.checked.quotes > 0 && (
                <> · <span className={shown.checked.verbatim < shown.checked.quotes ? "text-danger" : undefined} data-testid="readers-checked">
                  {shown.checked.verbatim} of {shown.checked.quotes} quotes found word for word
                </span></>
              )}
              {shown.cost !== undefined && <> · readers {fmtCost(shown.cost)}</>}
              {other && shown.working?.cost !== undefined && <> · {shown.working.model} would pay at least {fmtCost(shown.working.cost)} to read it once</>}
            </div>
          )}
          {parts.length > 1 && (
            <ol className="flex flex-col gap-1 rounded-md border border-line bg-sunken px-2.5 py-2" data-testid="readers-part-list">
              {parts.map((p) => (
                <li key={p.k} className="flex items-center gap-2 text-caption" data-state={p.state}>
                  <span className={cn("size-1.5 shrink-0 rounded-full", DOT[p.state])} />
                  <span className="w-12 shrink-0 text-faint tabular-nums">Part {p.k}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-micro text-muted" title={p.covers}>{short(p.covers)}</span>
                  <span className={cn("shrink-0 text-micro", p.state === "unread" ? "text-danger" : "text-faint")} title={p.error}>{WORD[p.state]}{p.model && !oneModel ? ` · ${p.model}` : ""}</span>
                </li>
              ))}
            </ol>
          )}
          {answer && (
            <div className={cn("rounded-md border border-line bg-code px-3 py-2 text-ui", result?.is_error && "text-danger")} data-testid="readers-answer">
              {result?.is_error ? <pre className="font-mono text-caption whitespace-pre-wrap">{answer}</pre> : <Markdown text={answer} sessionId={sessionId} />}
            </div>
          )}
          {notes && <pre className="font-mono text-micro whitespace-pre-wrap break-words text-faint" data-testid="readers-notes">{notes}</pre>}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
