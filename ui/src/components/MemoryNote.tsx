// What tacit or a hook added before a prompt: one quiet line that opens to the text.
import { Collapsible } from "@base-ui/react/collapsible";
import { Brain, ChevronRight } from "lucide-react";

export function MemoryNote({ text, hooks, label = "Memory from tacit" }: { text: string; hooks: string[]; label?: string }) {
  const body = text
    .replace(/<(memory|hook)[^>]*>\n?/g, "")
    .replace(/<\/(memory|hook)>/g, "")
    .replace(/^From the owner's memory store.*\n/gm, "")
    .trim();
  const facts = body.split("\n").filter((l) => /^\s*-\s/.test(l)).length;
  return (
    <Collapsible.Root className="group/mem self-center" data-testid="memory-note">
      <Collapsible.Trigger className="mx-auto flex items-center gap-1.5 rounded-md px-2 py-0.5 text-caption text-faint outline-none hover:bg-hover hover:text-muted focus-visible:ring-2 focus-visible:ring-accent/30">
        <Brain className="size-3.5" />
        <span>
          {label}{facts ? ` · ${facts} fact${facts === 1 ? "" : "s"}` : ""}
          {hooks.length ? ` · ${hooks.join(", ")}` : ""}
        </span>
        <ChevronRight className="size-3 transition-transform group-data-[open]/mem:rotate-90" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="mt-1.5 w-[min(40rem,100%)] overflow-hidden rounded-lg border border-line bg-panel px-3 py-2">
        <pre className="whitespace-pre-wrap break-words font-mono text-micro leading-relaxed text-muted" data-testid="memory-text">{body}</pre>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
