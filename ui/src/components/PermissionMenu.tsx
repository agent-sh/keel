import { Dialog } from "@base-ui/react/dialog";
import { Popover } from "@base-ui/react/popover";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { Switch } from "@base-ui/react/switch";
import { ChevronDown, Shield, ShieldCheck, ShieldOff, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { safety, useSafety, type SessionPerm } from "../lib/safety.ts";
import { reportError } from "../lib/store.ts";
import { useUI } from "../lib/ui.ts";
import { ago, cn } from "../lib/utils.ts";

const PROFILES: { id: SessionPerm["sandbox"]; name: string; hint: string }[] = [
  { id: "off", name: "Off", hint: "Commands run as you" },
  { id: "workspace-write", name: "Workspace", hint: "Write only the workspace" },
  { id: "read-only", name: "Read only", hint: "Write nothing" },
];

// The session's permission mode and sandbox, in the session header.
export function PermissionMenu({ sessionId }: { sessionId: string }) {
  const perm = useSafety((s) => s.perms[sessionId]);
  const modes = useSafety((s) => s.modes);
  const sandbox = useSafety((s) => s.sandbox);
  const [grantsOpen, setGrantsOpen] = useState(false);
  // /permissions with no mode opens this menu.
  const [open, setOpen] = useState(false);
  const signal = useUI((s) => s.permMenu);
  const atMount = useRef(signal);
  useEffect(() => { if (signal !== atMount.current) setOpen(true); }, [signal]);

  useEffect(() => {
    safety.loadSession(sessionId).catch(reportError);
    if (!modes.length) safety.loadSettings().catch(reportError);
  }, [sessionId]);

  if (!perm) return null;
  const mode = modes.find((m) => m.id === perm.mode);
  const set = (patch: Partial<Omit<SessionPerm, "session_id">>) => safety.setPerm(sessionId, patch).catch(reportError);
  const Icon = perm.mode === "full-auto" ? ShieldOff : perm.sandbox !== "off" ? ShieldCheck : Shield;

  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          data-testid="permission-menu"
          className={cn(
            "inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-caption text-muted hover:bg-hover hover:text-fg data-popup-open:bg-hover",
            perm.mode === "full-auto" && "text-warn",
          )}
        >
          <Icon className="size-3.5" />
          <span data-testid="permission-mode" className="max-sm:sr-only">{mode?.name ?? perm.mode}</span>
          {perm.sandbox !== "off" && <span className="rounded bg-accent-soft px-1 text-micro text-accent">sandbox</span>}
          <ChevronDown className="size-3 opacity-60" />
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner align="end" sideOffset={6} className="z-50">
            <Popover.Popup className="w-[min(22rem,calc(100vw-1.5rem))] origin-[var(--transform-origin)] rounded-lg border border-line bg-raised p-1.5 shadow-2 transition-[scale,opacity] duration-150 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0">
              <Popover.Title className="px-2 pt-1 pb-1.5 text-micro font-medium text-faint">Permissions</Popover.Title>
              <RadioGroup value={perm.mode} onValueChange={(v) => set({ mode: v as SessionPerm["mode"] })} className="flex flex-col">
                {modes.map((m) => (
                  <label key={m.id} className="flex cursor-default gap-2.5 rounded-lg px-2 py-1.5 hover:bg-hover has-[[data-checked]]:bg-accent-soft/60">
                    <Radio.Root value={m.id} data-testid={`mode-${m.id}`} className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border border-line-strong outline-none focus-visible:ring-2 focus-visible:ring-accent/40 data-checked:border-accent">
                      <Radio.Indicator className="size-2 rounded-full bg-accent" />
                    </Radio.Root>
                    <span className="min-w-0">
                      <span className="block text-ui font-medium">{m.name}</span>
                      <span className="block text-caption leading-snug text-muted">{m.description}</span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
              <div className="mx-2 my-1.5 h-px bg-line" />
              <div className="px-2 py-1">
                <div className="flex items-baseline justify-between">
                  <span className="text-ui font-medium">Sandbox for commands</span>
                  {sandbox && !sandbox.available && <span className="text-micro text-warn" title={sandbox.reason}>unavailable</span>}
                </div>
                <div className="mt-1.5 grid grid-cols-3 gap-1 rounded-lg bg-panel p-0.5" role="radiogroup" aria-label="Sandbox">
                  {PROFILES.map((p) => (
                    <button
                      key={p.id}
                      role="radio"
                      aria-checked={perm.sandbox === p.id}
                      data-testid={`sandbox-${p.id}`}
                      title={p.hint}
                      disabled={p.id !== "off" && sandbox?.available === false}
                      onClick={() => set({ sandbox: p.id })}
                      className={cn(
                        "h-7 rounded-md text-caption text-muted disabled:opacity-40",
                        perm.sandbox === p.id ? "bg-raised text-fg shadow-2" : "hover:text-fg",
                      )}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-caption leading-snug text-muted">
                  {sandbox && !sandbox.available ? sandbox.reason : PROFILES.find((p) => p.id === perm.sandbox)!.hint + (perm.sandbox === "off" ? "." : ", in bubblewrap.")}
                </p>
                <label className={cn("mt-2 flex items-center justify-between", perm.sandbox === "off" && "opacity-40")}>
                  <span className="text-ui">Network in the sandbox</span>
                  <Switch.Root
                    checked={perm.network}
                    disabled={perm.sandbox === "off"}
                    onCheckedChange={(v) => set({ network: v })}
                    data-testid="sandbox-network"
                    className="relative h-5 w-9 rounded-full bg-line-strong transition-colors data-checked:bg-accent"
                  >
                    <Switch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-raised shadow-2 transition-transform data-checked:translate-x-[18px]" />
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
  const byScope = Object.entries(
    grants.reduce<Record<string, typeof grants>>((acc, g) => ((acc[g.lifetime === "session" ? "For one session" : g.scope] ??= []).push(g), acc), {}),
  );
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px] transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0" />
        <Dialog.Popup
          data-testid="grants-panel"
          className="fixed right-4 top-4 bottom-4 z-50 flex w-[min(36rem,calc(100vw-2rem))] flex-col rounded-2xl border border-line bg-raised shadow-2 transition-[transform,opacity] duration-200 data-starting-style:translate-x-4 data-starting-style:opacity-0 data-ending-style:translate-x-4 data-ending-style:opacity-0"
        >
          <div className="flex items-center border-b border-line px-4 py-3">
            <Dialog.Title className="font-semibold">Grants</Dialog.Title>
            <span className="ml-2 text-caption text-faint">what runs without asking</span>
            <Dialog.Close className="ml-auto grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg">
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {grants.length === 0 && <p className="px-3 py-8 text-center text-ui text-faint">No grants yet. "Always allow" on an approval adds one.</p>}
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
                      onClick={() => safety.revoke(g.id).catch(reportError)}
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
