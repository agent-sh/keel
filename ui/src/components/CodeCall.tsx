import { Collapsible } from "@base-ui/react/collapsible";
import { Braces } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ToolResultBlock, ToolUseBlock } from "../../../src/core/types.ts";
import { useCodeCalls, type CodeCall } from "../lib/codemode.ts";
import { marksAgain, marksOf, useMarked } from "../lib/marks.ts";
import { callHeld, callKey, letGo, useHeld, useLetGoUnseen } from "../lib/held.ts";
import { callState } from "../lib/work.ts";
import { resultText } from "../lib/tools.ts";
import { cn } from "../lib/utils.ts";
import { Apart, ToolCall } from "./ToolCall.tsx";

type Props = { use: ToolUseBlock; result?: ToolResultBlock; live?: boolean; sessionId?: string; cwd?: string; event?: string };
// How many of a program's calls stand under its closed line (as a step shows of its own).
const PEEK = 3;

// A run_code program: a line of the rail as every call is. Its calls are part of what happened: the
// ones that must be seen (marked, failed, denied, refused) stand under its closed line, each a line
// of its own; opened, it shows its code, every call it made and what it printed, the only part the
// model read.
export function CodeCall({ use, result, live, sessionId, cwd, event }: Props) {
  const calls = useCodeCalls(live ? undefined : sessionId, use.id);
  const code = String((use.input as any)?.code ?? "");
  const out = resultText(result);
  const state = live ? "live" : !result ? "running" : result.is_error ? "error" : "ok";
  // Open while it runs, so its calls show as it makes them; closed once it has ended, with the calls
  // that must be seen under its line. What the owner opened or closed stays as they left it.
  // (It stays open as it stood until it has left the view: lib/held.ts.)
  const [picked, pick] = useState<boolean | null>(null);
  useHeld();
  const held = callHeld(use.id, !result && !live);
  const setOpen = (to: boolean) => { pick(to); if (!to) letGo(callKey(use.id)); };
  const open = picked ?? ((!result && !live) || held);
  const root = useRef<HTMLDivElement>(null);
  useLetGoUnseen(root, callKey(use.id), held);
  const firstLine = code.split("\n").find((l) => l.trim() && !l.trim().startsWith("//"))?.trim() ?? "";
  // What the policy says of the calls it made is asked for as they come.
  useEffect(() => { if (sessionId && event && calls.length) marksAgain(sessionId, event); }, [sessionId, event, calls.length]);
  const marked = useMarked(sessionId, useMemo(() => [use, ...calls], [use, calls]));
  // Its own marks stand on its line; a mark of a call it made stands on that call, under the line.
  const own = marked.includes(`${use.id} `) ? marksOf(sessionId, use.id).filter((m) => !m.within && m.kind !== "denied") : [];
  const ended = (c: CodeCall): ToolResultBlock | undefined => c.result ?? (result ? { type: "tool_result", tool_use_id: c.id, is_error: true, content: "Did not finish: the program ended first." } : undefined);
  const states = calls.map((c) => callState(ended(c)));
  // How its calls ended, each said as what it is: failed, denied by the owner, refused.
  const count = (look: string) => states.filter((s) => s === look).length;
  const failed = count("error"), denied = count("denied"), refused = count("refused");
  const ends: [string, string][] = [];
  if (failed) ends.push(["fail", `${failed} failed`]);
  if (denied) ends.push(["own", `${denied} denied by you`]);
  if (refused) ends.push(["warn", `${refused} refused`]);
  const must = calls.filter((c, i) => marked.includes(`${c.id} `) || states[i] === "error" || states[i] === "denied" || states[i] === "refused");
  const inner = (c: CodeCall, peek: boolean) => <ToolCall key={c.id} use={{ type: "tool_use", id: c.id, name: c.tool, input: c.input }} result={ended(c)} sessionId={sessionId} cwd={cwd} peek={peek || undefined} auto={peek || undefined} />;
  return (
    <Collapsible.Root ref={root} open={open} onOpenChange={setOpen} className="k-tool-call group/tool" data-testid="tool-call" data-call={use.id} data-tool={use.name} data-state={state} data-kind="code" data-auto={picked === null ? "" : undefined} data-marked={own.length ? "" : undefined} data-calls-marked={must.some((c) => marked.includes(`${c.id} `)) ? "" : undefined}>
      <Collapsible.Trigger className="k-line">
        <span className="k-line-text" data-wrap={own.length ? "" : undefined}>
          <span className="k-line-verb">Code</span>{" "}
          {state === "error" && <><span className="k-line-state" data-tone="fail">failed</span>{" "}</>}
          {own.map((m) => <Fragment key={m.kind}><span className="k-line-state k-line-mark" data-tone="warn" data-testid="call-mark" data-mark={m.kind} title={m.why}>{m.short}</span>{" "}</Fragment>)}
          <span className="k-line-what" data-code="">{firstLine}</span>
        </span>
        <span className="k-line-end">
          <Apart />
          {calls.length > 0 && (
            <span className="k-line-count" data-testid="code-call-count">
              {calls.length} call{calls.length === 1 ? "" : "s"}{ends.map(([tone, text]) => <span key={tone} className="k-line-state" data-tone={tone}>, {text}</span>)}
            </span>
          )}
          {(state === "running" || state === "live") && <span className="k-line-run" aria-label="running" />}
        </span>
      </Collapsible.Trigger>
      {/* The first few of them, and how many more there are: the program opens to every one. */}
      {!open && must.length > 0 && (
        <div className="k-step-calls" data-testid="code-peek">
          {must.slice(0, PEEK).map((c) => inner(c, true))}
          {must.length > PEEK && <button type="button" className="k-line-more k-line-more-open" data-testid="code-peek-more" onClick={() => setOpen(true)}>and {must.length - PEEK} more like these: open the program</button>}
        </div>
      )}
      <Collapsible.Panel className="k-tool-panel overflow-hidden">
        <pre className="m-2.5 max-h-72 overflow-auto rounded-md border border-line bg-code p-2.5 font-mono text-caption leading-[1.55] whitespace-pre-wrap break-all text-fg" data-testid="code-source">{code}</pre>
        {calls.length > 0 && (
          <div className="k-quote mx-2.5 flex flex-col gap-1.5" data-testid="code-calls">
            {calls.map((c) => inner(c, false))}
          </div>
        )}
        {out && (
          <div className="m-2.5">
            <div className="mb-1 text-micro text-faint">Returned to the model</div>
            <pre className={cn("max-h-80 overflow-auto rounded-md border border-line bg-code p-2.5 font-mono text-caption leading-relaxed whitespace-pre-wrap break-all", result?.is_error ? "text-danger" : "text-muted")} data-testid="code-output">{out}</pre>
          </div>
        )}
        {!out && <div className="h-2.5" />}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
