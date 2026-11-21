// Every branch of the session in one view: the owner's prompts and the
// summaries, forks indented where an edit or "answer again" split the
// conversation, the branch shown marked, labels on top. A row shows its branch.
// The rows are one tree for the keyboard: one Tab stop, the arrows move between
// rows (both sides of a split), Enter or Space shows a row's branch, F2 names it.
import { Bookmark, Layers, Pencil, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import type { Session } from "../../../src/core/types.ts";
import { reportError, useStore } from "../lib/store.ts";
import { tree, type TreeNode, type TreeState } from "../lib/tree.ts";
import { ago, cn, when } from "../lib/utils.ts";

const use = <T,>(sel: (s: TreeState) => T) => useSyncExternalStore(tree.subscribe, () => sel(tree.state()));

// `onKeys`: the box is closing by its own keys (saved or cancelled), not by a
// click elsewhere, so the row it belongs to takes the focus back.
function LabelInput({ sid, eventId, value, onKeys }: { sid: string; eventId: string; value: string; onKeys?: () => void }) {
  const [text, setText] = useState(value);
  const save = () => tree.label(sid, eventId, text.trim() || null).catch(reportError);
  return (
    <input
      autoFocus
      data-testid="label-input"
      value={text}
      maxLength={200}
      placeholder="Name this place"
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") { onKeys?.(); save(); }
        if (e.key === "Escape") { onKeys?.(); tree.edit(null); }
      }}
      onBlur={() => tree.edit(null)}
      className="h-7 min-w-0 flex-1 rounded-md border border-line-strong bg-raised px-2 text-caption outline-none"
    />
  );
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="inline-flex max-w-48 shrink-0 items-center gap-1 truncate rounded-sm bg-brass-soft px-1.5 py-px text-micro font-medium text-fg" data-testid="label-chip"><Bookmark className="size-3 shrink-0 text-brass" />{children}</span>;
}

function Row({ n, sid, depth, fork, working, stop, onStop }: { n: TreeNode; sid: string; depth: number; fork: boolean; working: boolean; stop: boolean; onStop: () => void }) {
  const editing = use((s) => s.editing === n.event_id);
  const row = useRef<HTMLDivElement>(null);
  const back = useRef(false);
  useEffect(() => {
    if (editing || !back.current) return;
    back.current = false;
    row.current?.focus();
  }, [editing]);
  return (
    <div
      ref={row}
      role="treeitem"
      aria-level={depth + 1}
      aria-current={n.active ? "true" : undefined}
      aria-disabled={(working && !n.active) || undefined}
      aria-keyshortcuts="F2"
      tabIndex={stop ? 0 : -1}
      data-testid="tree-node"
      data-event={n.event_id}
      data-active={n.active || undefined}
      onFocus={(e) => { if (e.target === e.currentTarget) onStop(); }}
      onClick={() => !working && tree.go(sid, n.event_id, n.active ? undefined : n.head_event_id).catch(reportError)}
      title={working && !n.active ? "Another branch can be shown when the turn ends" : n.active ? "On the branch shown: go to it" : "Show this branch"}
      style={{ paddingLeft: `${0.75 + depth * 1.1}rem` }}
      className={cn("group/n relative flex min-h-8 cursor-default items-center gap-2 rounded-md py-1 pr-2 text-ui hover:bg-hover focus-visible:bg-hover", !n.active && "text-muted")}
    >
      {depth > 0 && <span className="absolute top-0 bottom-0 border-l border-line" style={{ left: `${0.35 + (depth - 1) * 1.1 + 0.55}rem` }} />}
      <span className={cn("relative z-10 grid size-3.5 shrink-0 place-items-center rounded-full border-2", n.active ? "border-accent bg-accent" : "border-line-strong bg-panel", fork && "ring-2 ring-accent-soft")}>
        {n.kind === "summary" && <Layers className="size-2 text-accent-fg" />}
      </span>
      {editing ? (
        <LabelInput sid={sid} eventId={n.event_id} value={n.label ?? ""} onKeys={() => { back.current = true; }} />
      ) : (
        <>
          <span className={cn("min-w-0 flex-1 truncate", n.kind === "summary" && "italic")}>{n.preview}</span>
          {n.label && <Chip>{n.label}</Chip>}
          <span className="shrink-0 text-micro tabular-nums text-faint" title={when(n.ts_ms)}>{ago(n.ts_ms)}</span>
          <button
            type="button"
            aria-label="Label"
            tabIndex={-1}
            title={n.label ? "Rename the label (F2)" : "Label this prompt (F2)"}
            onClick={(e) => { e.stopPropagation(); tree.edit(n.event_id); }}
            className="grid size-6 shrink-0 place-items-center rounded-sm text-faint opacity-0 hover:bg-hover hover:text-fg group-hover/n:opacity-100 focus-visible:opacity-100"
          >
            <Pencil className="size-3" />
          </button>
        </>
      )}
    </div>
  );
}

export function BranchTree({ session }: { session: Session }) {
  const data = use((s) => s.trees[session.id]);
  const editing = use((s) => s.editing);
  const count = useStore((s) => s.events[session.id]?.length ?? 0);
  useEffect(() => { tree.load(session.id).catch(reportError); }, [session.id, session.head, count]);
  const kids = useMemo(() => {
    const m = new Map<string | null, TreeNode[]>();
    for (const n of data?.nodes ?? []) (m.get(n.parent_event_id) ?? m.set(n.parent_event_id, []).get(n.parent_event_id)!).push(n);
    return m;
  }, [data]);
  const [visited, setVisited] = useState<string | null>(null);
  if (!data) return null;
  const working = session.phase === "working";
  // The row the Tab key lands on: the last one visited, else the newest prompt of the branch shown.
  const nodes = data.nodes;
  const stop = nodes.some((n) => n.event_id === visited) ? visited : (nodes.find((n) => n.active && !nodes.some((c) => c.active && c.parent_event_id === n.event_id)) ?? nodes[0])?.event_id;
  // Keys on a row (a label box keeps its own): Up and Down through every row,
  // Left to the split a row hangs under, Right into the rows under it.
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = e.target as HTMLElement;
    if (at.getAttribute("role") !== "treeitem" || e.ctrlKey || e.metaKey || e.altKey) return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    const i = rows.indexOf(at);
    const level = (el?: HTMLElement) => Number(el?.getAttribute("aria-level"));
    let to: HTMLElement | undefined;
    if (e.key === "ArrowDown") to = rows[i + 1];
    else if (e.key === "ArrowUp") to = rows[i - 1];
    else if (e.key === "Home") to = rows[0];
    else if (e.key === "End") to = rows.at(-1);
    else if (e.key === "ArrowLeft") to = rows.slice(0, i).findLast((r) => level(r) < level(at));
    else if (e.key === "ArrowRight") to = level(rows[i + 1]) > level(at) ? rows[i + 1] : undefined;
    else if (e.key === "Enter" || e.key === " ") at.click();
    else if (e.key === "F2") tree.edit(at.dataset.event!);
    else return;
    e.preventDefault();
    to?.focus();
  };
  const branches = [...kids.values()].filter((l) => l.length > 1).length;

  // A chain stays flat; where it splits, each way is indented under the split.
  const chain = (list: TreeNode[], depth: number): ReactNode =>
    list.map((n) => {
      const below = kids.get(n.event_id) ?? [];
      return (
        <Fragment key={n.event_id}>
          <Row n={n} sid={session.id} depth={depth} fork={below.length > 1} working={working} stop={n.event_id === stop} onStop={() => setVisited(n.event_id)} />
          {below.length === 1 ? chain(below, depth) : below.length > 1 ? below.map((b) => <Fragment key={b.event_id}>{chain([b], depth + 1)}</Fragment>) : null}
        </Fragment>
      );
    });
  const extra = data.labels.filter((l) => !data.nodes.some((n) => n.event_id === l.event_id));

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="branch-tree">
      <div className="border-b border-line px-4 py-3">
        <p className="text-ui font-medium">Branches</p>
        <p className="text-caption text-muted">
          {data.nodes.length} prompts{branches ? `, split in ${branches} place${branches > 1 ? "s" : ""}` : ", one line"}. A row shows its branch; the filled dots are the one shown.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {data.labels.length > 0 && (
          <section className="mb-3 border-b border-line pb-3" data-testid="labels">
            <p className="px-3 pb-1 text-micro font-medium uppercase tracking-wide text-faint">Labels</p>
            {data.labels.map((l) => {
              const node = data.nodes.find((n) => n.event_id === l.event_id);
              return (
                <div key={l.event_id} className="group/l flex min-h-8 items-center gap-2 rounded-md px-3 hover:bg-hover" data-testid="label-row">
                  {/* A prompt's label is renamed on its row in the tree: one box, not two that take the focus from each other. */}
                  {editing === l.event_id && !node ? <LabelInput sid={session.id} eventId={l.event_id} value={l.label} /> : (
                    <button type="button" disabled={working && !(node?.active ?? l.active)} onClick={() => tree.go(session.id, l.event_id).catch(reportError)} className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-50">
                      <Chip>{l.label}</Chip>
                      <span className="min-w-0 flex-1 truncate text-caption text-muted">{node?.preview ?? l.preview ?? ""}</span>
                    </button>
                  )}
                  <button type="button" aria-label="Remove the label" title="Remove the label" onClick={() => tree.label(session.id, l.event_id, null).catch(reportError)} className="grid size-6 place-items-center rounded-sm text-faint opacity-0 hover:text-danger group-hover/l:opacity-100 focus-visible:opacity-100">
                    <X className="size-3" />
                  </button>
                </div>
              );
            })}
          </section>
        )}
        {editing && extra.every((l) => l.event_id !== editing) && !data.nodes.some((n) => n.event_id === editing) && (
          <div className="mb-3 flex items-center gap-2 px-3"><Bookmark className="size-3.5 text-brass" /><LabelInput sid={session.id} eventId={editing} value="" /></div>
        )}
        {data.nodes.length === 0 ? <p className="px-3 py-8 text-center text-ui text-faint">No prompts yet.</p> : (
          <div role="tree" aria-label="Branches" data-jump-keeps-focus onKeyDown={onKey}>{chain(kids.get(null) ?? [], 0)}</div>
        )}
      </div>
    </div>
  );
}
