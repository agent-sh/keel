// An event pushed into the session from outside (src/mcp/channel.ts): a
// connected server's or a webhook loop's. Never the owner's words: it is
// shown under its source's name, apart from the prompts, with the routing
// attributes the source gave it.
import { RadioTower, Webhook } from "lucide-react";
import type { StoredEvent } from "../../../src/core/types.ts";
import { bodyOf } from "../../../src/mcp/channel-text.ts";
import { ago, when } from "../lib/utils.ts";
import { Markdown } from "./Markdown.tsx";

// The daemon escapes only the frame's own tag inside it; only that is undone.
const unframe = (s: string) => s.replace(/&lt;(\s*\/?\s*channel)/gi, "<$1");

export function ChannelEvent({ e }: { e: StoredEvent }) {
  const d = e.data as { text?: string; source?: string; via?: string; attrs?: Record<string, string>; cut?: number };
  const hook = d.via === "webhook";
  const Icon = hook ? Webhook : RadioTower;
  const attrs = Object.entries(d.attrs ?? {}).filter(([k]) => k !== "event_id" && k !== "loop");
  return (
    <div id={`e-${e.id}`} className="flex flex-col gap-1.5 animate-in" data-testid="channel-event" data-event-id={e.id} data-source={d.source}>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 k-label">
        <Icon className="size-3.5 text-accent" />
        From <span className="text-muted" data-testid="channel-source">{d.source ?? "a connected source"}</span>
        <span className="font-normal" title={when(e.ts)}>· {ago(e.ts)}</span>
        <span className="font-normal">· {hook ? "a webhook loop" : "a connected server"}, not you</span>
      </div>
      <div className="rounded-lg border border-dashed border-line-strong bg-sunken/60 px-4 py-2.5 text-read leading-relaxed text-fg">
        {attrs.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1" data-testid="channel-attrs">
            {attrs.map(([k, v]) => <span key={k} className="k-chip font-mono text-micro">{k}={v}</span>)}
          </div>
        )}
        <Markdown text={unframe(bodyOf(String(d.text ?? "")))} />
        {!!d.cut && <p className="mt-1.5 text-caption text-faint">{d.cut.toLocaleString("en-US")} characters of it were cut in the middle (an event holds 16 KB).</p>}
      </div>
    </div>
  );
}
