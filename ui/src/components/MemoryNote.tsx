// What tacit or a hook added before a prompt: one quiet line that opens to the text.
import { Collapsible } from "@base-ui/react/collapsible";
import { Popover } from "@base-ui/react/popover";
import { Brain, ChevronRight, RotateCw, Webhook } from "lucide-react";
import type { StoredEvent } from "../../../src/core/types.ts";

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

// Notes the harness adds around a turn (memory, a hook, a continue after a daemon restart),
// folded into one quiet row of chips on the turn's footer; a chip opens its text.
export function TurnNotes({ notes, working }: { notes: StoredEvent[]; working: boolean }) {
  if (!notes.length) return null;
  return (
    <span className="k-notes" data-testid="turn-notes">
      {notes.map((e) => {
        if (e.kind === "user") {
          return (
            <span key={e.id} className="k-note-chip" data-testid="restart-note" title={`Continued by itself after a daemon restart${working ? ". Stop ends it." : ""}`}>
              <RotateCw className="size-3" /> restarted
            </span>
          );
        }
        const hook = e.data.hook as string | undefined;
        const body = cleanNote(String(e.data.text ?? ""));
        const facts = body.split("\n").filter((l) => /^\s*-\s/.test(l)).length;
        const hooks: string[] = hook ? [hook] : e.data.memory?.hooks ?? [];
        // The helper's own note (src/helper/): the events and remembered items a prompt brought.
        const mine = e.data.memory?.source === "helper";
        const label = hook ? "hook" : `${mine ? "helper" : "memory"}${facts ? ` ${facts}` : ""}`;
        const from = hook ? "From a hook" : mine ? "Helper context" : "Memory from tacit";
        return (
          <span key={e.id} className="k-note-chip-wrap" data-testid="memory-note">
            <Popover.Root>
              <Popover.Trigger className="k-note-chip" title={`${from}${facts ? `, ${facts} fact${facts === 1 ? "" : "s"}` : ""}${hooks.length ? `, ${hooks.join(", ")}` : ""}`}>
                {hook ? <Webhook className="size-3" /> : <Brain className="size-3" />} {label}
                <span className="sr-only">{hooks.join(", ")}</span>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Positioner sideOffset={6} align="start" className="z-50 outline-none">
                  <Popover.Popup className="k-note-pop">
                    <p className="k-note-pop-head">{from}{hooks.length ? `, ${hooks.join(", ")}` : ""}</p>
                    <pre className="whitespace-pre-wrap break-words font-mono text-micro leading-relaxed text-muted" data-testid="memory-text">{body}</pre>
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>
          </span>
        );
      })}
    </span>
  );
}

const cleanNote = (text: string) => text
  .replace(/<(memory|hook|digest|remembered)[^>]*>\n?/g, "")
  .replace(/<\/(memory|hook|digest|remembered)>/g, "")
  .replace(/^From the owner's memory store.*\n/gm, "")
  .trim();
