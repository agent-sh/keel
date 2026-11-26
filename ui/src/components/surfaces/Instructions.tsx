// Customize > Instructions: the files a session's prompt carries, in the order
// it reads them, the ones not written yet, each one editable.
import { useCallback, useEffect, useState } from "react";
import { api, reportError, useStore } from "../../lib/store.ts";
import { navigate, sessionLeft, useUI } from "../../lib/ui.ts";
import { fmtSize } from "../../lib/utils.ts";
import { Blank, FileEditor, FolderLine, Ledger, ReaderHead, Seg, tilde, tok, useFolder, type Mark } from "./kit.tsx";

type State = "whole" | "cut" | "out" | "same" | "repeats" | "unread" | "held" | "had";
type File = { path: string; scope: "owner" | "parent" | "folder"; text: string; bytes: number; loaded: string; loaded_tokens: number; imports: boolean; truncated: boolean; state: State | null; cut_at: number | null; chars: number; note: string | null; trust: string | null };
// The chain as the prompt renders it, and for which model and window (a prediction for a folder with no session).
type Loads = { model: string | null; window: number | null; prediction: boolean; session: string | null; limit: number; room: number; carried: number; warnings: string[] };
type Finding = { level: string; rule: string; file: string; line: number; message: string };
type Lint = { installed: false } | { installed: true; at: null } | { installed: true; at: number; errors: number; warnings: number; failed: string | null; findings: Finding[] };
type View = { cwd: string; files: File[]; same: { path: string; of: string; note: string | null }[]; loads: Loads; create: { path: string; scope: "owner" | "folder" }[]; lint: Lint | null };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// agnix's last run on the folder's agent configs: one quiet line, its findings on a hover.
function LintLine({ lint }: { lint: Lint | null }) {
  if (!lint) return null;
  const said = !lint.installed ? "Not linted: agnix is not installed."
    : lint.at === null ? "agnix lints this folder's agent configs when a session starts here."
    : lint.failed ? `agnix's last run failed: ${lint.failed}`
    : lint.errors || lint.warnings ? `agnix: ${plural(lint.errors, "error")}, ${plural(lint.warnings, "warning")} in this folder's agent configs.`
    : "agnix: no errors or warnings in this folder's agent configs.";
  const title = lint.installed && lint.at !== null && !lint.failed ? lint.findings.map((f) => `${f.level} ${f.file || "(project)"}${f.line ? `:${f.line}` : ""} ${f.rule}: ${f.message}`).join("\n") : undefined;
  const tone = lint.installed && lint.at !== null && (lint.failed || lint.errors) ? "text-warn" : "text-muted";
  return (
    <p className={`mt-2 text-caption ${tone}`} data-testid="instructions-lint" title={title || undefined}>
      {said}{" "}
      {lint.installed && lint.at !== null && <button type="button" className="k-link underline underline-offset-2 hover:text-fg" onClick={() => navigate({ name: "settings", section: "health" })}>Health</button>}
    </p>
  );
}
// Which render the view shows: the model and window it is for, and what repeats.
function LoadsLine({ v }: { v: View }) {
  const l = v.loads;
  const win = l.window ? `${tok(l.window)} tokens` : "a window of unstated size, counted as 200k tokens";
  const said = `${l.prediction ? "As a new session here would load them" : "As this session's prompt renders them"}, on ${l.model ?? "the default model"} (${win}): up to ${l.limit.toLocaleString("en-US")} characters a file, ${l.room.toLocaleString("en-US")} for all.`;
  const same = v.same.length ? ` ${plural(v.same.length, "file")} the same as another, carried once.` : "";
  return <p className="mt-2 text-caption text-muted" data-testid="instructions-loads" data-prediction={l.prediction ? "true" : "false"}>{said}{same}</p>;
}
const SCOPE = { owner: "Yours, in every folder", parent: "A folder above", folder: "This folder" };
const WHERE = { owner: "yours", parent: "above", folder: "this folder" };
const base = (p: string) => p.endsWith("/.claude/CLAUDE.md") ? ".claude/CLAUDE.md" : p.slice(p.lastIndexOf("/") + 1);
const parent = (p: string, cwd: string) => {
  const dir = p.slice(0, p.lastIndexOf("/")) || "/";
  return cwd && (dir === cwd || dir.startsWith(`${cwd}/`)) ? `${base(cwd) || cwd}${dir.slice(cwd.length)}` : tilde(dir);
};

export default function Instructions() {
  const [cwd] = useFolder();
  const [v, setV] = useState<View | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [as, setAs] = useState<"file" | "loaded">("file");
  // The session open (or the one the owner came from) when it works in this folder: the chain on its own model's window.
  const open = useUI((u) => (u.route.name === "session" ? u.route.id : sessionLeft()));
  const sid = useStore((s) => (open && s.sessions[open]?.workspace === cwd ? open : undefined));
  const load = useCallback(() => (cwd ? api<View>(`/api/instructions?cwd=${encodeURIComponent(cwd)}${sid ? `&session=${encodeURIComponent(sid)}` : ""}`).then(setV).catch(reportError) : undefined), [cwd, sid]);
  useEffect(() => { load(); setSel(null); }, [load]);
  useEffect(() => { if (v && !sel) setSel(v.files[0]?.path ?? v.create[0]?.path ?? null); }, [v]);
  const file = v?.files.find((f) => f.path === sel);
  const blank = v?.create.find((f) => f.path === sel);
  const total = v?.files.reduce((n, f) => n + f.loaded_tokens, 0) ?? 0;
  const save = async (path: string, text: string) => setV(await api<View>("/api/instructions", { method: "PUT", body: JSON.stringify({ cwd, path, text, ...(sid && { session: sid }) }) }));
  const mark = (f: File): Mark => (f.trust === "new" || f.trust === "changed" ? "need" : "on");

  return (
    <div className="k-instructions" data-testid="instructions-settings">
      <FolderLine tally={[{ n: v?.files.length ?? 0, label: "files loaded" }, { n: total, label: "tokens a session" }]} />
      {v && <LoadsLine v={v} />}
      <LintLine lint={v?.lint ?? null} />
      <Ledger
        testid="instructions-ledger"
        selected={sel}
        onSelect={(id) => { setSel(id); setAs("file"); }}
        groups={[
          { id: "order", title: "Read in this order", entries: (v?.files ?? []).map((f, i) => ({ id: f.path, name: `${i + 1}  ${base(f.path)}`, desc: `${WHERE[f.scope]} · ${parent(f.path, cwd)}`, mark: mark(f), aside: `${tok(f.loaded_tokens)} tok`, testid: "instruction-entry" })) },
          { id: "create", title: "Not written yet", entries: (v?.create ?? []).map((f) => ({ id: f.path, name: base(f.path), desc: `${SCOPE[f.scope]}: ${parent(f.path, cwd)}`, mark: "off" as const, aside: "new", testid: "instruction-create" })) },
        ]}
      >
        {file ? (
          <>
            <ReaderHead
              title={SCOPE[file.scope]}
              path={file.path}
              right={file.imports || file.truncated || file.note ? <Seg label="Show" value={as} onChange={setAs} options={[["file", "The file"], ["loaded", "As loaded"]]} /> : undefined}
              facts={[
                ["Size", fmtSize(file.bytes)],
                ["In the prompt", `~${tok(file.loaded_tokens)} tokens`],
                ...(file.imports ? [["Imports", "@ lines brought in"] as [string, string]] : []),
                ...(file.state === "cut" && file.cut_at !== null ? [["Cut", `at ${file.cut_at.toLocaleString("en-US")} of ${file.chars.toLocaleString("en-US")} characters`] as [string, string]] : []),
                ...(file.note && file.state !== "cut" ? [["Loaded", file.note] as [string, string]] : []),
                ...(file.trust ? [["Trust", file.trust] as [string, string]] : []),
              ]}
            >
              {(file.trust === "new" || file.trust === "changed") && (
                <div className="k-issue mt-3" data-tone="need">
                  {file.trust === "changed" ? "Changed since you trusted it: sessions read the version you trusted." : "New: sessions leave it out until you trust it."} Saving it here trusts what you saved.
                </div>
              )}
            </ReaderHead>
            {as === "loaded" ? (
              <FileEditor name="as the prompt reads it" text={file.loaded} readOnly="what the session gets" testid="instruction-loaded" />
            ) : (
              <FileEditor
                name={base(file.path)}
                text={file.text}
                onSave={(t) => save(file.path, t)}
                note="New sessions read it. A running session keeps the prompt it started with (its cache stays)."
              />
            )}
          </>
        ) : blank ? (
          <>
            <ReaderHead
              title={SCOPE[blank.scope]}
              path={blank.path}
              desc={blank.scope === "owner"
                ? "Your own instructions, read first in every session, whatever the folder. The place Codex keeps as ~/.codex/AGENTS.md and Claude Code as ~/.claude/CLAUDE.md."
                : "This folder's AGENTS.md, the name Codex and OpenCode read. Every session reads it, and the folder's CLAUDE.md files beside it."}
            />
            <FileEditor name={base(blank.path)} text={""} onSave={async (t) => { await save(blank.path, t); setSel(blank.path); }} />
          </>
        ) : <Blank title="No instruction files">Pick a folder above.</Blank>}
      </Ledger>
      <p className="mt-3 text-caption text-muted">
        What a session remembers across sessions is the memory store, under <button type="button" className="k-link underline underline-offset-2 hover:text-fg" onClick={() => navigate({ name: "settings", section: "integrations" }, true)}>Memory and supervisor</button>.
      </p>
    </div>
  );
}
