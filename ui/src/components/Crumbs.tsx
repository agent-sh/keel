// An agent's way up its tree, in its head before its title: the root session,
// then each agent between, each a link to that session (as a nested agent's
// thread links up to the one that started it in Codex). A session that is
// nobody's agent has none.
import { ChevronRight, CornerLeftUp } from "lucide-react";
import { Fragment, useMemo, type MouseEvent } from "react";
import type { Session } from "../../../src/core/types.ts";
import { useAuto } from "../lib/automation.ts";
import { crumbsOf } from "../lib/agent-lines.ts";
import { useStore } from "../lib/store.ts";
import { navigate } from "../lib/ui.ts";

const SEP = "\u0000";

export function Crumbs({ s }: { s: Session }) {
  const agents = useAuto((x) => x.agents);
  // The sessions on the way up, from the agent records; their titles as one string, so a change of
  // another session moves nothing here.
  const ids = useMemo(() => (s.parent_id ? crumbsOf(Object.values(agents), () => undefined, s.id, (id) => (id === s.id ? s.parent_id : undefined)).slice(0, -1) : []), [agents, s.id, s.parent_id]);
  const titles = useStore((x) => ids.map((c) => x.sessions[c.session_id]?.title || c.title).join(SEP));
  if (!ids.length) return null;
  const names = titles.split(SEP);
  const go = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    // A press with a key held, or another button, is the browser's (a new tab, a copy of the link).
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate({ name: "session", id });
  };
  const link = (c: { session_id: string }, words: string, testid: string, title: string) => (
    <a href={`/s/${c.session_id}`} className="k-station-crumb" data-testid={testid} data-session={c.session_id} title={title} onClick={(e) => go(e, c.session_id)} draggable={false}>{words}</a>
  );
  const parent = ids[ids.length - 1]!;
  const path = names.join(" > ");
  // As wide as the head allows (bridge.css): the whole way up; the root and one link up to the agent that
  // started this one; in a narrow head, one mark that goes to the root, the way up in its tip.
  return (
    <nav className="k-station-crumbs" aria-label="Up the agent tree" data-testid="station-crumbs">
      <a href={`/s/${ids[0]!.session_id}`} className="k-station-crumb-mark" data-testid="station-crumb-mark" data-session={ids[0]!.session_id} title={`Up the tree: ${path}`} aria-label={`Up the tree: ${path}`} onClick={(e) => go(e, ids[0]!.session_id)} draggable={false}>
        <CornerLeftUp aria-hidden="true" />
      </a>
      {ids.map((c, i) => (
        <span key={c.session_id} className="k-station-crumb-step" data-root={i === 0 || undefined} data-mid={i > 0 || undefined}>
          {link(c, names[i]!, "station-crumb", `${i === 0 ? "The session this tree started in" : "The agent that started the next"}: ${names[i]}`)}
          <ChevronRight className="k-station-crumb-sep" aria-hidden="true" />
        </span>
      ))}
      {ids.length > 1 && (
        <span className="k-station-crumb-step" data-more="">
          {link(parent, "\u2026", "station-crumb-up", `Up: ${names.slice(1).join(" > ")}`)}
          <ChevronRight className="k-station-crumb-sep" aria-hidden="true" />
        </span>
      )}
    </nav>
  );
}
