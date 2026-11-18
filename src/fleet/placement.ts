// Where work goes. An explicit choice always wins; otherwise the owner's rules
// are read in order and the first whose conditions all hold names the
// machine; a rule never sends work to a machine known to be offline; with no
// rule the work stays here. Placement only answers: it never moves anything.
export type When = { kind?: "session" | "subagent" | "run"; local_busy?: boolean; needs_gpu?: boolean; heavy?: boolean };
export type Rule = { when: When; machine: string; note?: string };
export type Want = { kind: "session" | "subagent" | "run"; heavy?: boolean; needs_gpu?: boolean; machine?: string };
export type Place = { machine_id: string; machine: string; explicit: boolean; reason: string; rule?: number };
export type MachineState = { id: string; name: string; state: string };

export const KINDS = ["session", "subagent", "run"] as const;

export function validate(raw: unknown, known: (m: string) => MachineState | undefined): Rule[] | string {
  if (!Array.isArray(raw)) return "rules must be a list";
  const out: Rule[] = [];
  for (const [i, r] of raw.entries()) {
    const n = i + 1;
    if (!r || typeof r !== "object" || typeof (r as any).machine !== "string") return `rule ${n}: needs a machine`;
    const w = ((r as any).when ?? {}) as Record<string, unknown>;
    if (typeof w !== "object") return `rule ${n}: when must be an object`;
    for (const k of Object.keys(w)) if (!["kind", "local_busy", "needs_gpu", "heavy"].includes(k)) return `rule ${n}: unknown condition ${k}`;
    if (w.kind !== undefined && !KINDS.includes(w.kind as any)) return `rule ${n}: kind must be session, subagent or run`;
    for (const k of ["local_busy", "needs_gpu", "heavy"]) if (w[k] !== undefined && typeof w[k] !== "boolean") return `rule ${n}: ${k} is true or false`;
    const m = known((r as any).machine);
    if (!m) return `rule ${n}: no machine ${(r as any).machine}`;
    out.push({ when: w as When, machine: m.id, note: typeof (r as any).note === "string" ? (r as any).note.slice(0, 200) : undefined });
  }
  return out;
}

export function place(want: Want, rules: Rule[], ctx: { local: MachineState; localBusy: boolean; machine: (id: string) => MachineState | undefined }): Place | string {
  if (!KINDS.includes(want.kind)) return `kind must be session, subagent or run`;
  if (want.machine && want.machine !== "auto") {
    const m = want.machine === "local" ? ctx.local : ctx.machine(want.machine);
    if (!m) return `no machine ${want.machine}`;
    return { machine_id: m.id, machine: m.name, explicit: true, reason: "chosen" };
  }
  for (const [i, r] of rules.entries()) {
    const w = r.when;
    if (w.kind && w.kind !== want.kind) continue;
    if (w.local_busy !== undefined && w.local_busy !== ctx.localBusy) continue;
    if (w.needs_gpu !== undefined && w.needs_gpu !== !!want.needs_gpu) continue;
    if (w.heavy !== undefined && w.heavy !== !!want.heavy) continue;
    const m = r.machine === "local" ? ctx.local : ctx.machine(r.machine);
    if (!m || m.state === "offline") continue;
    return { machine_id: m.id, machine: m.name, explicit: false, rule: i, reason: `rule ${i + 1}${r.note ? ` (${r.note})` : ""}` };
  }
  return { machine_id: ctx.local.id, machine: ctx.local.name, explicit: false, reason: "no rule applies: it stays here" };
}
