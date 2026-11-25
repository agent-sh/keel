// A session Claude Code or Codex runs on a machine reached over ssh, opened
// from its row (src/fleet/far-outside.ts): this daemon holds its row and its
// title, nothing of what it says. The pane says where it runs and in what, and
// one press opens the import sheet at it: a copy is read from that machine.
import type { Session } from "../../../src/core/types.ts";
import { OUTSIDE_LABEL } from "../../../src/core/watch.ts";
import { stateLabel } from "../../../src/core/state-words.ts";
import { openImport } from "../lib/integrations-ui.ts";
import { useSessionState } from "../lib/watch.ts";
import { SidebarButton } from "./SessionHeader.tsx";
import { useWhere, Where } from "./Where.tsx";
import { Mark } from "./Mark.tsx";

export function FarOutside({ session }: { session: Session }) {
  const o = session.outside!;
  const tool = OUTSIDE_LABEL[o.harness] ?? o.harness;
  const w = useWhere(session);
  const st = useSessionState(session);
  const name = w?.name ?? "another machine";
  return (
    <div className="flex flex-1 flex-col" data-testid="far-outside" data-harness={o.harness}>
      <div className="flex h-12 min-w-0 items-center gap-2 px-2 md:px-4">
        <SidebarButton />
        <span className="min-w-0 truncate text-ui text-fg" data-testid="far-outside-title">{session.title || `${tool} session`}</span>
        <Where s={session} />
      </div>
      <div className="m-auto max-w-sm px-4 text-center">
        <p className="flex items-center justify-center gap-2 text-ui text-fg">
          <Mark w={st.watch} st={st} />
          <span data-testid="far-outside-where">{tool} runs this session on {name}</span>
        </p>
        <p className="mt-1 text-caption text-muted" data-testid="far-outside-state">{st.text ?? stateLabel(st)}. What it says stays on {name}: import a copy to read it here or go on with it.</p>
        <button type="button" className="k-btn k-btn-lg mt-3" data-testid="far-outside-import"
          onClick={() => void openImport({ q: "", harness: o.harness, id: o.source_id, path: "", machine: session.machine ?? undefined })}>
          Import a copy
        </button>
      </div>
    </div>
  );
}
