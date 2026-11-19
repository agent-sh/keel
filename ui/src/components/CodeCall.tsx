import { Collapsible } from "@base-ui/react/collapsible";
import { Braces, ChevronRight } from "lucide-react";
import { useState } from "react";
import type { ToolResultBlock, ToolUseBlock } from "../../../src/core/types.ts";
import { useCodeCalls } from "../lib/codemode.ts";
import { resultText } from "../lib/tools.ts";
import { cn } from "../lib/utils.ts";
import { ToolCall } from "./ToolCall.tsx";

type Props = { use: ToolUseBlock; result?: ToolResultBlock; live?: boolean; sessionId?: string; cwd?: string };

// A run_code program: its code, the calls it made (each a tool call card of
// its own, live while it runs) and what it printed, the only part the model read.
export function CodeCall({ use, result, live, sessionId, cwd }: Props) {
  const calls = useCodeCalls(live ? undefined : sessionId, use.id);
  const code = String((use.input as any)?.code ?? "");
  const out = resultText(result);
  const state = live ? "live" : !result ? "running" : result.is_error ? "error" : "ok";
  const [open, setOpen] = useState(!result && !live);
  const failed = calls.filter((c) => c.result?.is_error).length;
  const firstLine = code.split("\n").find((l) => l.trim() && !l.trim().startsWith("//"))?.trim() ?? "";
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="group/tool rounded-lg border border-line bg-raised shadow-1 animate-in" data-testid="tool-call" data-tool={use.name} data-state={state} data-kind="code">
      <Collapsible.Trigger className="flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-ui hover:bg-hover">
        <span className={cn("grid size-6 shrink-0 place-items-center rounded-sm", state === "error" ? "bg-danger-soft text-danger" : state === "running" || state === "live" ? "bg-brass-soft text-brass" : "bg-sunken text-muted")}>
          <Braces className="size-3.5" />
        </span>
        <span className="shrink-0 font-medium">Code</span>
        <span className="min-w-0 truncate font-mono text-caption text-muted">{firstLine}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-micro tabular-nums">
          {calls.length > 0 && (
            <span className="rounded-full bg-sunken px-1.5 py-px text-muted" data-testid="code-call-count">
              {calls.length} call{calls.length === 1 ? "" : "s"}{failed ? <span className="text-danger"> · {failed} failed</span> : null}
            </span>
          )}
          {(state === "running" || state === "live") && <span className="size-1.5 rounded-full bg-brass animate-pulse-dot" />}
          {state === "error" && <span className="text-danger">failed</span>}
          <ChevronRight className="size-3.5 text-faint transition-transform group-data-[open]/tool:rotate-90" />
        </span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="k-tool-panel overflow-hidden border-t border-line">
        <pre className="m-2.5 max-h-72 overflow-auto rounded-md border border-line bg-code p-2.5 font-mono text-caption leading-[1.55] whitespace-pre-wrap break-all text-fg" data-testid="code-source">{code}</pre>
        {calls.length > 0 && (
          <div className="mx-2.5 flex flex-col gap-1.5 border-l-2 border-line pl-2.5" data-testid="code-calls">
            {calls.map((c) => (
              <ToolCall key={c.id} use={{ type: "tool_use", id: c.id, name: c.tool, input: c.input }} result={c.result ?? (result ? { type: "tool_result", tool_use_id: c.id, is_error: true, content: "Did not finish: the program ended first." } : undefined)} sessionId={sessionId} cwd={cwd} />
            ))}
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
