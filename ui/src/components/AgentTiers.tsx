// The owner's agent tiers (agents.tiers, src/engine/tiers.ts): a short table of a tier's name, its model, its
// effort and the agent types or task kinds that use it. A spawn that names no model starts on its tier. While
// the table is empty, a card offers to read it from his own words once (src/server/routes/tiers.ts).
import { ArrowUp } from "lucide-react";
import { useEffect, useState } from "react";
import type { Tier } from "../../../src/engine/tiers.ts";
import type { DraftRow } from "../../../src/engine/tiers-import.ts";
import { api, reportError, useModels } from "../lib/store.ts";
import { cn } from "../lib/utils.ts";
import { ModelMenu } from "./ModelMenu.tsx";
import { Cell, Group, Notice, Row, Table, type Col } from "./settings/kit.tsx";
import { Seg } from "./Seg.tsx";
import { useSettings } from "./StoragePanel.tsx";

const COLS: Col[] = [{ head: "Tier" }, { head: "Model", grow: true }, { head: "Effort" }, { head: "Used by", minor: true }, { head: "", end: true }];
const DRAFT_COLS: Col[] = [{ head: "Tier" }, { head: "Model" }, { head: "Effort" }, { head: "Used by" }, { head: "Your words", grow: true }];
const usesText = (u?: string[]) => (u?.length ? u.map((x) => (x === "default" ? "every other agent" : x)).join(", ") : "when named");

type ImportState = { state: null | "used" | "dismissed"; tiers: number; draft?: { rows: DraftRow[]; said: number } };

function ImportCard({ onUsed }: { onUsed: () => void }) {
  const models = useModels();
  const [st, setSt] = useState<ImportState | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  useEffect(() => { api<ImportState>("/api/agent-tiers/import").then(setSt).catch(reportError); }, []);
  if (!st || st.state || st.tiers > 0) return null;
  const draft = st.draft;
  const read = () => {
    setBusy(true); setProblem("");
    api<{ rows: DraftRow[]; said: number }>("/api/agent-tiers/import/draft", { method: "POST" })
      .then((d) => setSt({ ...st, draft: d })).catch((e) => setProblem(e.message)).finally(() => setBusy(false));
  };
  const use = () => {
    setBusy(true);
    api("/api/agent-tiers/import/use", { method: "POST", body: JSON.stringify({ rows: draft!.rows }) })
      .then(() => { setSt({ ...st, state: "used" }); onUsed(); }).catch((e) => setProblem(e.message)).finally(() => setBusy(false));
  };
  const away = () => api("/api/agent-tiers/import/dismiss", { method: "POST" }).then(() => setSt({ ...st, state: "dismissed" })).catch(reportError);
  return (
    <div className="mb-4" data-testid="tiers-import">
      <Notice title="Use the tiers from your words">
        {!draft ? (
          <>
            <p>A small model reads what you typed in the last two weeks about models, tiers and effort, and writes it as a table. Nothing is kept until you say so.</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="button" className="k-btn k-btn-lg" disabled={busy} onClick={read} data-testid="tiers-import-read">{busy ? "Reading" : "Read my words"}</button>
              <button type="button" className="k-btn" data-quiet="" onClick={away} data-testid="tiers-import-away">Not wanted</button>
              {problem && <span className="text-caption text-faint" data-testid="tiers-import-problem">{problem}</span>}
            </div>
          </>
        ) : (
          <>
            <p>From {draft.said} of your messages. Check each row against your words; a model that is not listed now falls to the next tier.</p>
            <div className="-mx-5 mt-3">
              <Table cols={DRAFT_COLS} label="Tiers from your words" testid="tiers-import-rows">
                {draft.rows.map((r) => (
                  <Row key={r.name} name={<span className="font-medium text-fg">{r.name}</span>} testid="tiers-import-row">
                    <Cell col={DRAFT_COLS[1]!}><span className={cn(!r.listed && "text-warn")} title={r.model}>{models.find((m) => m.id === r.model)?.name ?? r.model}{!r.listed && " (not listed)"}</span></Cell>
                    <Cell col={DRAFT_COLS[2]!}>{r.effort ?? "its own"}</Cell>
                    <Cell col={DRAFT_COLS[3]!}>{usesText(r.use)}</Cell>
                    <Cell col={DRAFT_COLS[4]!} className="text-muted"><q>{r.words}</q></Cell>
                  </Row>
                ))}
              </Table>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="button" className="k-btn k-btn-lg" disabled={busy || !draft.rows.length} onClick={use} data-testid="tiers-import-use">Use these tiers</button>
              <button type="button" className="k-btn" data-quiet="" onClick={away} data-testid="tiers-import-away">Not wanted</button>
              {problem && <span className="text-caption text-faint" data-testid="tiers-import-problem">{problem}</span>}
            </div>
          </>
        )}
      </Notice>
    </div>
  );
}

export function AgentTiers() {
  const models = useModels();
  const [settings, patch] = useSettings();
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [uses, setUses] = useState("");
  const [problem, setProblem] = useState("");
  if (!settings) return null;
  const tiers: Tier[] = settings.agents?.tiers ?? [];
  const save = (next: Tier[]) => patch({ agents: { tiers: next } }).then(() => setProblem("")).catch((e: Error) => setProblem(e.message));
  const info = (id: string) => models.find((m) => m.id === id);
  const efforts = info(model)?.efforts ?? [];
  const missing = !name.trim() ? "Name the tier." : tiers.some((t) => t.name.toLowerCase() === name.trim().toLowerCase()) ? "A tier of that name is in the table." : !model ? "Choose its model." : "";
  const add = () => {
    if (missing) return;
    const use = uses.split(",").map((u) => u.trim()).filter(Boolean);
    save([...tiers, { name: name.trim(), model, ...(effort ? { effort } : {}), ...(use.length ? { use } : {}) }]).then(() => { setName(""); setModel(""); setEffort(""); setUses(""); });
  };
  const move = (i: number) => save(tiers.map((t, k) => (k === i - 1 ? tiers[i]! : k === i ? tiers[i - 1]! : t)));
  return (
    <Group
      testid="agent-tiers" title="Agent tiers" count={tiers.length || undefined} pad
      hint="An agent started with no model runs on its tier's model and effort."
      help="A spawn can name a tier, or a task kind a tier lists. Without one, an agent takes the tier its type's definition names, else a tier that lists its type, else the reader tier for Explore agents, else the tier that lists default. Readers read through the reader tier's model first, at their own low effort: they take only its model. A tier whose model is not listed gives way to the next one down (an agent that does more than read never falls to the reader tier), the tier for every other agent gives way to a model a trial is trying, and the spawn's result says which tier it took and why."
    >
      <ImportCard onUsed={() => { patch({}).catch(reportError); }} />
      {tiers.length > 0 && (
        <div className="-mx-5 mb-4">
          <Table cols={COLS} label="Agent tiers" testid="tiers-table">
            {tiers.map((t, i) => (
              <Row key={t.name} name={<span className="font-medium text-fg">{t.name}</span>} testid="tier-row">
                <Cell col={COLS[1]!} title={t.model}>{info(t.model)?.name ?? t.model}{!info(t.model) && <span className="text-warn"> (not listed)</span>}</Cell>
                <Cell col={COLS[2]!}>{t.effort ?? "its own"}</Cell>
                <Cell col={COLS[3]!}>{usesText(t.use)}</Cell>
                <Cell col={COLS[4]!}>
                  <span className="inline-flex items-center gap-1">
                    {i > 0 && <button type="button" className="k-btn" data-quiet="" aria-label={`Move ${t.name} up`} title="Move up: a tier gives way to the one below it" onClick={() => move(i)}><ArrowUp className="size-3.5" aria-hidden /></button>}
                    <button type="button" className="k-btn" data-quiet="" aria-label={`Remove the tier ${t.name}`} onClick={() => save(tiers.filter((_, k) => k !== i))}>Remove</button>
                  </span>
                </Cell>
              </Row>
            ))}
          </Table>
        </div>
      )}
      <form className={cn("flex flex-col gap-3", tiers.length > 0 && "border-t border-line pt-4")} onSubmit={(e) => { e.preventDefault(); add(); }} data-testid="tier-form">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <label className="flex flex-col gap-1 text-caption text-muted">
            Tier
            <input className="k-field w-36" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} data-testid="tier-name" />
          </label>
          <div className="flex flex-col gap-1 text-caption text-muted">
            Model
            <ModelMenu value={model} placeholder="Choose a model" onChange={(id) => { if (id) { setModel(id); setEffort(""); } }} />
          </div>
          <div className="flex flex-col gap-1 text-caption text-muted">
            Effort
            <Seg wrap label="Effort" value={effort} onChange={setEffort} testid="tier-effort" options={[{ value: "", label: "Its own" }, ...efforts.map((x) => ({ value: x, label: x }))]} />
          </div>
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-caption text-muted">
            Used by
            <input className="k-field min-w-48" placeholder="Agent types or task kinds, comma separated; default for every other agent" value={uses} onChange={(e) => setUses(e.target.value)} data-testid="tier-uses" />
          </label>
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" className="k-btn k-btn-lg" disabled={!!missing} data-testid="tier-add">Add the tier</button>
          <span className={cn("text-caption", missing || problem ? "text-faint" : "text-muted")} data-testid="tier-hint">{problem || missing || `${name.trim()}: ${info(model)?.name ?? model}${effort ? ` at ${effort}` : ""}, for ${usesText(uses.split(",").map((u) => u.trim()).filter(Boolean))}.`}</span>
        </div>
      </form>
    </Group>
  );
}
