// The context popup's account of what the next request carries: the system
// prompt by its blocks, every tool definition by its source, and the messages
// by where they came from. Sizes are estimates scaled to the provider's count
// (src/engine/context-parts.ts), so each carries a "~".
import { ChevronRight } from "lucide-react";
import type { ContextParts } from "../lib/store.ts";
import { cn, fmtTokens } from "../lib/utils.ts";

const tok = (n: number) => (n ? `~${fmtTokens(n)}` : "0");

function Section({ id, title, tokens, open, children }: { id: string; title: string; tokens: number; open?: boolean; children: React.ReactNode }) {
  return (
    <details open={open} className="group" data-testid="context-part" data-part={id}>
      <summary className="flex cursor-default list-none items-center gap-1 rounded-md py-0.5 text-caption [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3 shrink-0 text-faint transition-transform group-open:rotate-90" />
        <span className="min-w-0 flex-1 truncate font-medium text-fg">{title}</span>
        <span className="tabular-nums text-fg" data-testid="context-part-tokens">{tok(tokens)}</span>
      </summary>
      <div className="ml-4 mt-0.5 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 text-caption tabular-nums">{children}</div>
    </details>
  );
}

const Row = ({ label, tokens, id }: { label: string; tokens: number; id: string }) => (
  <div className="contents" data-testid="context-row" data-row={id}>
    <span className="truncate text-muted" title={label}>{label}</span>
    <span className="text-right">{tok(tokens)}</span>
  </div>
);

export function ContextPartsView({ parts }: { parts: ContextParts }) {
  const { system, tools, messages } = parts;
  return (
    <div className="mt-3 flex flex-col gap-1" data-testid="context-parts">
      <Section id="system" title="System prompt" tokens={system.tokens}>
        {system.blocks.map((b) => <Row key={b.key} id={`system:${b.key}`} label={b.label} tokens={b.tokens} />)}
      </Section>
      <Section id="tools" title="Tool definitions" tokens={tools.tokens} open>
        {tools.groups.map((g) => (
          <div key={g.key} className="contents" data-testid="tools-group" data-group={g.key}>
            <span className="truncate text-muted" title={g.label}>
              {g.label} <span className="text-faint">{g.kind === "builtin" ? `${g.tools}` : `${g.carried} of ${g.tools}`}</span>
            </span>
            <span className="text-right">{tok(g.tokens)}</span>
            {g.save && <span className={cn("col-span-2 -mt-0.5 mb-0.5 text-faint")} data-testid="tools-save">{g.save}</span>}
          </div>
        ))}
        {parts.native_tools && tools.groups.some((g) => g.kind !== "builtin" && !g.carried) && (
          <span className="col-span-2 text-faint" data-testid="tools-unloaded-note">A source with none loaded costs nothing: tool search brings a tool in only when the model asks for it.</span>
        )}
      </Section>
      <Section id="messages" title="Messages" tokens={messages.tokens} open>
        {messages.rows.map((r) => <Row key={r.key} id={`message:${r.key}`} label={r.label} tokens={r.tokens} />)}
      </Section>
      <p className="mt-1 text-caption text-faint" data-testid="context-parts-note">
        {parts.measured
          ? `Estimates: each part is sized from its bytes, then scaled so the parts add up to the ${fmtTokens(parts.total_tokens)} tokens the provider counted.`
          : "Estimates from bytes: no reply has counted this context yet, so the system prompt and tools come on top of the total above."}
      </p>
    </div>
  );
}
