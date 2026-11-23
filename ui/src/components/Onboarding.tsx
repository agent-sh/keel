import { useEffect, useState } from "react";
import { INIT_PROMPT, reviewPrompt } from "../lib/builtins.ts";
import { keyLabel, QUEUE_KEYS } from "../lib/keys.ts";
import { actions, reportError, useStore } from "../lib/store.ts";
import { navigate, seedComposer } from "../lib/ui.ts";
import { cn } from "../lib/utils.ts";

// First run, part one: no provider lists a model, so nothing can start yet.
// Shows each provider's state and the way to set one up.
export function SetupProviders() {
  const report = useStore((s) => s.providers);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!report) actions.loadProviders().catch(reportError); }, [report]);
  const again = async () => {
    setBusy(true);
    try {
      await actions.loadProviders(true);
      await actions.loadModels(true);
    } catch (e) {
      reportError(e, { at: "onboarding refresh" });
    } finally {
      setBusy(false);
    }
  };
  const list = report?.providers ?? [];
  const failing = list.filter((p) => p.available && p.listing.state === "failed");
  return (
    <section className="k-setup-providers mb-6 rounded-lg border border-warn/50 bg-raised p-4" data-testid="setup-providers" aria-labelledby="setup-title">
      <h2 id="setup-title" className="text-base font-medium">Connect a model provider</h2>
      <p className="mt-1 text-ui text-muted">
        No provider lists a model yet, so a session cannot start. Keel finds keys in the environment and the keyring, signs in to ChatGPT and Grok plans, and takes any OpenAI-compatible endpoint.
      </p>
      {failing.length > 0 && (
        <ul className="k-setup-failing mt-3 flex flex-col gap-1.5" data-testid="setup-failing">
          {failing.map((p) => (
            <li key={p.id} className="text-caption">
              <span className="font-medium text-fg">{p.label}</span> <span className="text-danger">has a key but its listing failed: {p.listing.error}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => navigate({ name: "settings", section: "providers" })}
          className="h-8 rounded-md bg-accent px-3 text-ui font-medium text-accent-fg hover:bg-accent-hover"
          data-testid="setup-open-providers"
        >
          Set up a provider
        </button>
        <button type="button" disabled={busy} onClick={again} className="k-btn k-btn-lg" data-testid="setup-read-again">
          {busy ? "Reading the listings" : "I added a key, read again"}
        </button>
      </div>
    </section>
  );
}

const STARTERS = [
  { label: "Explain this project", text: "Explain how this project is laid out: what each top-level folder holds, how to build and test it, and where to start reading." },
  { label: "Write an AGENTS.md", text: INIT_PROMPT },
  { label: "Review my changes", text: reviewPrompt("") },
  { label: "Find a bug", text: "Run the tests, and if any fail, find the cause and propose the smallest fix. Do not change anything yet." },
];

// First run, part two: models are there, no session yet. Starters fill the
// message box (nothing is sent until Enter).
export function FirstSteps() {
  return (
    <section className="k-first-steps mt-8" data-testid="first-steps" aria-labelledby="first-title">
      <h2 id="first-title" className="mb-2 k-label">To start, pick one or write your own</h2>
      <div className="flex flex-wrap gap-2">
        {STARTERS.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={() => seedComposer(s.text, undefined)}
            className={cn("k-starter h-8 rounded-md border border-line px-3 text-ui text-muted hover:bg-hover hover:text-fg")}
            data-testid="starter"
          >
            {s.label}
          </button>
        ))}
      </div>
      <ul className="mt-6 flex flex-col gap-1.5 text-caption text-muted">
        <li>Each session works in one folder, the one above the box. Paste a screenshot or mention a file with @.</li>
        <li>While it works, Enter steers it and {keyLabel(QUEUE_KEYS).join(" ")} queues the next message. Edits and commands ask first; the mode next to the session title changes that.</li>
      </ul>
    </section>
  );
}
