import { Dialog } from "@base-ui/react/dialog";
import { Popover } from "@base-ui/react/popover";
import { Switch } from "@base-ui/react/switch";
import { ChevronDown, Shield, ShieldCheck, ShieldOff, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { safety, useSafety, type ModeGroup, type ModeInfo, type SessionPerm } from "../lib/safety.ts";
import { filterSaid } from "../lib/seccomp.ts";
import { reportError } from "../lib/store.ts";
import { useUI } from "../lib/ui.ts";
import { ago, cn } from "../lib/utils.ts";
import { Seg } from "./Seg.tsx";

const PROFILES: { id: SessionPerm["sandbox"]; name: string; hint: string }[] = [
  { id: "off", name: "Off", hint: "Commands run as you" },
  { id: "workspace-write", name: "Folder", hint: "Write only the folder" },
  { id: "read-only", name: "Read only", hint: "Write nothing" },
];

// Within a group, the modes from asking most to asking least.
const ORDER = ["ask", "auto-edits", "reviewer", "auto", "full-auto", "read-only", "plan"];
function grouped(modes: ModeInfo[], groups: ModeGroup[]): { name: string; modes: ModeInfo[] }[] {
  const rank = (m: ModeInfo) => { const i = ORDER.indexOf(m.id); return i < 0 ? ORDER.length : i; };
  const sorted = [...modes].sort((a, b) => rank(a) - rank(b));
  const out = groups.map((g) => ({ name: g.name, modes: sorted.filter((m) => m.group === g.id) }));
  // A mode whose group this page does not know is still listed.
  const rest = sorted.filter((m) => !groups.some((g) => g.id === m.group));
  return [...out, ...(rest.length ? [{ name: "Other", modes: rest }] : [])].filter((g) => g.modes.length);
}

// The session's permission mode and sandbox, in the session header.
export function PermissionMenu({ sessionId }: { sessionId: string }) {
  const perm = useSafety((s) => s.perms[sessionId]);
  const modes = useSafety((s) => s.modes);
  const groups = useSafety((s) => s.modeGroups);
  const sandbox = useSafety((s) => s.sandbox);
  const filter = filterSaid(sandbox);
  const [grantsOpen, setGrantsOpen] = useState(false);
  // /permissions with no mode opens this menu.
  const [open, setOpen] = useState(false);
  const signal = useUI((s) => s.permMenu);
  const atMount = useRef(signal);
  useEffect(() => { if (signal !== atMount.current) setOpen(true); }, [signal]);
  // The mode in use is whole in view as the menu opens. Where the list is longer than its room (large
  // text, a phone, a short window) it scrolls, and the mode in use, the tallest row with its whole
  // description, lay under the list's foot: cut, or out of sight for a mode further down. Measured in
  // layout lengths (the popup is still growing into place), and only as it opens: a pick moves no row.
  const popup = useRef<HTMLDivElement>(null);
  const showInUse = () => {
    const box = popup.current, row = box?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
    if (!box || !row) return;
    let top = 0;
    for (let el: HTMLElement | null = row; el && el !== box; el = el.offsetParent as HTMLElement | null) {
      if (!box.contains(el)) { top -= box.offsetTop + box.clientTop; break; }
      top += el.offsetTop;
    }
    const cs = getComputedStyle(box), [above, below] = [parseFloat(cs.paddingTop) || 0, parseFloat(cs.paddingBottom) || 0];
    const over = top + row.offsetHeight + below - (box.scrollTop + box.clientHeight);
    if (over > 0) box.scrollTop = Math.max(box.scrollTop, Math.min(top - above, box.scrollTop + over));
  };
  useEffect(() => {
    if (!open) return;
    // Once its room is known (the popup takes its height from where it is placed).
    let id = requestAnimationFrame(() => { showInUse(); id = requestAnimationFrame(showInUse); });
    return () => cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (!modes.length) safety.loadSettings().catch(reportError);
    return safety.watch(sessionId);
  }, [sessionId]);

  if (!perm) return null;
  const mode = modes.find((m) => m.id === perm.mode);
  const set = (patch: Partial<Omit<SessionPerm, "session_id">>) => safety.setPerm(sessionId, patch).catch(reportError);
  const Icon = perm.mode === "full-auto" ? ShieldOff : perm.sandbox !== "off" ? ShieldCheck : Shield;

  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen} onOpenChangeComplete={(o) => { if (o) showInUse(); }}>
        <Popover.Trigger
          data-testid="permission-menu"
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-caption text-muted hover:bg-hover hover:text-fg data-popup-open:bg-hover",
            perm.mode === "full-auto" && "text-warn",
          )}
        >
          <Icon className="size-3.5" />
          <span data-testid="permission-mode" className="k-permission-mode max-sm:sr-only">{mode?.name ?? perm.mode}</span>
          {perm.sandbox !== "off" && <span className="rounded bg-accent-soft px-1 text-micro text-accent">sandbox</span>}
          <ChevronDown className="size-3 opacity-60" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner align="end" sideOffset={6} className="z-50">
            <Popover.Popup ref={popup} className="max-h-[var(--available-height)] w-[min(22rem,calc(100vw-1.5rem))] origin-[var(--transform-origin)] overflow-y-auto rounded-lg border border-line bg-raised p-1.5 shadow-2 transition-[scale,opacity] data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0">
              <Popover.Title className="px-2 pt-1 pb-1.5 k-label">Permissions</Popover.Title>
              {/* Grouped by who decides; within a group, from asking most to asking least. Each row says
                  what runs and what asks; the whole description shows for the mode in use.
                  Nothing here changes on an arrow key: the arrows move the focus, and Space, Enter or a click chooses. */}
              <Seg
                rows
                manual
                label="Permission mode"
                value={perm.mode}
                onChange={(mode) => set({ mode })}
                options={grouped(modes, groups).flatMap((g) => g.modes.map((m, i) => ({
                  value: m.id,
                  testid: `mode-${m.id}`,
                  name: `${g.name}: ${m.name}: ${m.summary ?? m.description}`,
                  title: m.id === perm.mode ? undefined : m.description,
                  // The same heading as the Panels picker beside it.
                  before: i === 0 ? <div className="k-picker-group k-label" data-testid="mode-group">{g.name}</div> : undefined,
                  className: "group/mode flex w-full cursor-default gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring aria-checked:bg-accent-soft/60",
                  label: (
                    <>
                      <span aria-hidden className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border border-line-strong group-aria-checked/mode:border-accent">
                        <span className="hidden size-2 rounded-full bg-accent group-aria-checked/mode:block" />
                      </span>
                      <span className="min-w-0 flex-1" data-testid="mode-row" data-mode={m.id}>
                        <span className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-ui font-medium">{m.name}</span>
                          <span className="text-caption text-muted" data-testid="mode-summary">{m.summary}</span>
                        </span>
                        {m.id === perm.mode && <span className="mt-0.5 block text-caption leading-snug text-faint" data-testid="mode-description">{m.description}</span>}
                      </span>
                    </>
                  ),
                })))}
              />
              <div className="mx-2 my-1.5 h-px bg-line" />
              <div className="px-2 py-1">
                <div className="flex items-baseline justify-between">
                  <span className="text-ui font-medium">Sandbox for commands</span>
                  {sandbox && !sandbox.available && <span className="text-micro text-warn" title={sandbox.reason}>unavailable</span>}
                </div>
                <Seg
                  fill
                  manual
                  className="mt-1.5"
                  label="Sandbox"
                  value={perm.sandbox}
                  onChange={(id) => set({ sandbox: id })}
                  options={PROFILES.map((p) => ({ value: p.id, label: p.name, title: p.hint, testid: `sandbox-${p.id}`, disabled: p.id !== "off" && sandbox?.available === false }))}
                />
                <p className="mt-1.5 text-caption leading-snug text-muted">
                  {sandbox && !sandbox.available ? sandbox.reason : PROFILES.find((p) => p.id === perm.sandbox)!.hint + (perm.sandbox === "off" ? "." : ", in bubblewrap.")}
                </p>
                {filter && <p className={cn("mt-1 text-caption leading-snug", filter.on ? "text-faint" : "text-warn")} data-testid="sandbox-filter">{filter.words}</p>}
                {/* With the sandbox off the switch is dimmed; its name stays readable, quiet. */}
                <label className="mt-2 flex items-center justify-between">
                  <span className={cn("text-ui", perm.sandbox === "off" && "text-faint")}>Network in the sandbox</span>
                  <Switch.Root
                    checked={perm.network}
                    disabled={perm.sandbox === "off"}
                    onCheckedChange={(v) => set({ network: v })}
                    data-testid="sandbox-network"
                    className="k-switch"
                  >
                    <Switch.Thumb className="k-switch-thumb" />
                  </Switch.Root>
                </label>
              </div>
              <div className="mx-2 my-1.5 h-px bg-line" />
              <button
                data-testid="open-grants"
                onClick={() => { safety.loadGrants().catch(reportError); setGrantsOpen(true); }}
                className="w-full rounded-lg px-2 py-1.5 text-left text-ui hover:bg-hover"
              >
                Grants…
              </button>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <GrantsPanel open={grantsOpen} onOpenChange={setGrantsOpen} />
    </>
  );
}

const KIND = { shell: "Command", edit: "Edits", tool: "Tool" } as const;

export function GrantsPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const grants = useSafety((s) => s.grants);
  const [undo, setUndo] = useState<{ id: string; pattern: string } | null>(null);
  const byScope = Object.entries(
    grants.reduce<Record<string, typeof grants>>((acc, g) => ((acc[g.lifetime === "session" ? "For one session and its agents" : g.scope] ??= []).push(g), acc), {}),
  );
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-overlay transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <Dialog.Popup
          data-testid="grants-panel"
 className="fixed right-4 top-4 bottom-4 z-50 flex w-[min(36rem,calc(100vw-2rem))] flex-col rounded-2xl border border-line bg-raised shadow-2 transition-[transform,opacity] duration-(--dur-move) data-starting-style:translate-x-4 data-starting-style:opacity-0 data-ending-style:translate-x-4 data-ending-style:opacity-0"
        >
          <div className="flex items-center border-b border-line px-4 py-3">
            <Dialog.Title className="font-semibold">Grants</Dialog.Title>
            <span className="ml-2 text-caption text-faint">what runs without asking</span>
            <Dialog.Close className="ml-auto grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {undo && (
              <div className="mb-2 flex items-center gap-2 rounded-lg bg-accent-soft/50 px-3 py-1.5 text-caption" data-testid="grant-undo">
                <span className="min-w-0 flex-1 truncate">Revoked <code className="font-mono">{undo.pattern}</code></span>
                <button className="k-link font-medium text-accent hover:underline" onClick={() => safety.restore(undo.id).then(() => setUndo(null)).catch(reportError)}>Undo</button>
              </div>
            )}
            {grants.length === 0 && <p className="k-empty px-3 py-4">No grants yet. "Always allow" on an approval adds one.</p>}
            {byScope.map(([scope, list]) => (
              <section key={scope} className="mb-2">
                <h3 className="truncate px-3 pt-2 pb-1 font-mono text-micro text-faint" title={scope}>{scope}</h3>
                {list.map((g) => (
                  <div key={g.id} data-testid="grant" className="group flex items-center gap-2.5 rounded-lg px-3 py-1.5 hover:bg-hover">
                    <span className="w-16 shrink-0 text-caption text-muted">{KIND[g.kind]}</span>
                    <code className="min-w-0 flex-1 truncate font-mono text-caption">{g.pattern}</code>
                    <span className="text-micro tabular-nums text-faint">{ago(g.created)}</span>
                    <button
                      data-testid="revoke-grant"
                      title="Revoke"
                      onClick={() => safety.revoke(g.id).then(() => setUndo({ id: g.id, pattern: g.pattern })).catch(reportError)}
                      className="grid size-7 place-items-center rounded-md text-faint opacity-0 hover:bg-danger-soft hover:text-danger group-hover:opacity-100 focus-visible:opacity-100"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
              </section>
            ))}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
