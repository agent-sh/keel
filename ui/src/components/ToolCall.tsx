import { Collapsible } from "@base-ui/react/collapsible";
import { ChevronRight, FilePen, FileText, FolderSearch, Search, SquareTerminal, Wrench } from "lucide-react";
import type { ToolResultBlock, ToolUseBlock } from "../../../src/core/types.ts";
import { cn } from "../lib/utils.ts";

const ICONS: Record<string, typeof Wrench> = {
  Bash: SquareTerminal, Read: FileText, Write: FilePen, Edit: FilePen, Glob: FolderSearch, Grep: Search,
};

function summary(name: string, input: any): string {
  if (!input) return "";
  switch (name) {
    case "Bash": return input.description || input.command;
    case "Read": case "Write": case "Edit": return input.file_path;
    case "Glob": return input.pattern;
    case "Grep": return `${input.pattern}${input.path ? `  in ${input.path}` : ""}`;
    default: return JSON.stringify(input).slice(0, 120);
  }
}

function resultText(r?: ToolResultBlock): string {
  if (!r) return "";
  if (typeof r.content === "string") return r.content;
  return r.content.map((c) => (c.type === "text" ? c.text : `[image ${c.media_type}]`)).join("\n");
}

export function ToolCall({ use, result, live }: { use: ToolUseBlock; result?: ToolResultBlock; live?: boolean }) {
  const Icon = ICONS[use.name] ?? Wrench;
  const out = resultText(result);
  const state = !result ? "running" : result.is_error ? "error" : "ok";
  const input: any = use.input ?? {};
  return (
    <Collapsible.Root className="group/tool rounded-lg border border-line bg-raised shadow-1 animate-in" data-testid="tool-call">
      <Collapsible.Trigger className="flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-ui hover:bg-hover">
        <span className={cn(
          "grid size-6 shrink-0 place-items-center rounded-sm",
          state === "error" ? "bg-danger-soft text-danger" : state === "running" ? "bg-brass-soft text-brass" : "bg-sunken text-muted",
        )}>
          <Icon className="size-3.5" />
        </span>
        <span className="font-medium shrink-0">{use.name}</span>
        <span className={cn("min-w-0 truncate text-muted", use.name === "Bash" && input.description ? "text-ui" : "font-mono text-caption")}>{summary(use.name, input)}</span>
        <span className="ml-auto flex items-center gap-2 shrink-0">
          {state === "running" && <span className="size-1.5 rounded-full bg-brass animate-pulse-dot" />}
          {state === "error" && <span className="text-caption text-danger">failed</span>}
          <ChevronRight className="size-3.5 text-faint transition-transform group-data-[open]/tool:rotate-90" />
        </span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="overflow-hidden border-t border-line">
        {use.name === "Bash" && input.command && (
          <pre className="px-3 pt-2.5 font-mono text-caption text-fg whitespace-pre-wrap break-all"><span className="text-accent select-none">$ </span>{input.command}</pre>
        )}
        {use.name === "Edit" && (
          <div className="px-3 pt-2.5 font-mono text-caption leading-relaxed">
            <pre className="whitespace-pre-wrap break-all rounded-md bg-danger-soft/60 px-2 py-1 text-fg">{input.old_string}</pre>
            <pre className="mt-1 whitespace-pre-wrap break-all rounded-md bg-accent-soft/70 px-2 py-1 text-fg">{input.new_string}</pre>
          </div>
        )}
        {use.name !== "Bash" && use.name !== "Edit" && !live && (
          <pre className="px-3 pt-2.5 font-mono text-micro text-faint whitespace-pre-wrap break-all">{JSON.stringify(input, null, 2).slice(0, 4000)}</pre>
        )}
        {out && (
          <pre className={cn(
            "m-2.5 mt-2.5 max-h-80 overflow-auto rounded-md border border-line bg-code p-2.5 font-mono text-caption leading-relaxed whitespace-pre-wrap break-all",
            result?.is_error ? "text-danger" : "text-muted",
          )}>{out}</pre>
        )}
        {!out && <div className="h-2.5" />}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
