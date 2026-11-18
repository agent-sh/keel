// The configured plugins and the providers they offer.
import { familyOf } from "../family.ts";
import { ctxFor, runEvents } from "../drive.ts";
import type { Delta, Family, ListedModel, Provider, ProviderRequest, ProviderStatus, Wire } from "../types.ts";
import type { WireCodec } from "../wires/common.ts";
import { anthropicBody, anthropicWire } from "../wires/anthropic.ts";
import { chatWire } from "../wires/chat.ts";
import { geminiWire } from "../wires/gemini.ts";
import { responsesWire } from "../wires/responses.ts";
import { readPlugins } from "./config.ts";
import { PluginProcess, type PluginModel, type PluginProviderDecl } from "./host.ts";
import type { WindowReading } from "../limits.ts";

const FAMILIES = new Set(["claude", "gpt", "gemini"]);

function codecFor(d: PluginProviderDecl, thinks: boolean): WireCodec {
  const prefix = d.system_prefix;
  switch (d.wire) {
    case "anthropic_messages":
      return { ...anthropicWire, body: (req, ctx) => ({ ...anthropicBody(req, ctx, prefix), stream: true }) };
    case "openai_responses":
      return responsesWire("openai", prefix);
    case "chat_completions":
      return chatWire({}, prefix);
    default:
      return geminiWire({ responseEnvelope: d.response_envelope?.field, thinking: thinks }, prefix);
  }
}

export class PluginProvider implements Provider {
  readonly id: string;
  readonly label: string;
  readonly wire: Wire;
  readonly family: Family;

  constructor(readonly proc: PluginProcess, readonly decl: PluginProviderDecl) {
    this.id = `${proc.entry.id}/${decl.id}`;
    this.label = decl.label;
    this.wire = decl.wire as Wire;
    this.family = decl.wire === "anthropic_messages" ? "claude" : decl.wire === "gemini_generate_content" ? "gemini" : decl.wire === "openai_responses" ? "gpt" : "other";
  }

  available() {
    return !this.decl.unusable && this.proc.providerAvailable(this.decl.id);
  }

  status(): ProviderStatus {
    const s = this.proc.status.get(this.decl.id);
    const off = this.proc.entry.providers[this.decl.id]?.enabled === false;
    const detail = this.decl.unusable ?? (off ? "turned off in plugins.toml"
      : this.proc.state !== "ready" ? `plugin ${this.proc.state.replace("_", " ")}${this.proc.reason ? `: ${this.proc.reason}` : ""}`
      : s?.state && s.state !== "ready" ? `${s.state.replace("_", " ")}${s.detail ? `: ${s.detail}` : ""}` : s?.detail);
    return {
      id: this.id, label: this.label, wire: this.wire, kind: "plugin", available: this.available(), detail, account: s?.account,
      sign_in: s?.sign_in ? { command: s.sign_in.command, note: s.sign_in.note } : undefined,
    };
  }

  // The plan windows the plugin's status states, and a `limited` state's reset.
  async usage(): Promise<WindowReading[]> {
    const s = this.proc.status.get(this.decl.id);
    const out: WindowReading[] = (s?.usage_windows ?? [])
      .filter((w) => typeof w.used_percent === "number")
      .map((w, i) => ({ id: w.id ?? `window-${i}`, label: w.label ?? w.id ?? "Plan window", used_percent: w.used_percent, resets_at_ms: w.resets_at_ms }));
    if (s?.state === "limited") out.push({ id: "limited", label: "Limited", used_percent: 100, resets_at_ms: s.reset_at_ms, note: s.detail });
    return out;
  }

  private model(id: string): PluginModel | undefined {
    return this.proc.models.get(this.decl.id)?.models.find((m) => m.id === id);
  }

  async list(): Promise<ListedModel[]> {
    await this.proc.whenSettled();
    // Listed at start; a refresh asks again.
    if (Date.now() - (this.proc.models.get(this.decl.id)?.at ?? 0) > 5_000) await this.proc.listModels();
    const g = this.proc.models.get(this.decl.id);
    if (!g?.models.length && g?.problem) throw new Error(g.problem);
    return (g?.models ?? [])
      .filter((m) => m.capabilities?.tools !== false)
      .map((m): ListedModel => {
        const r = m.capabilities?.reasoning;
        const b = m.billing;
        return {
          model: m.id,
          name: m.label,
          context: m.context_window,
          output: m.max_output,
          family: m.family && FAMILIES.has(m.family) ? (m.family as Family) : familyOf(m.id, this.family),
          efforts: r?.kind === "levels" ? r.levels : undefined,
          images: m.capabilities?.images,
          billing: b?.kind === "subscription" ? { kind: "subscription", plan: b.plan } : b?.kind === "per_token" ? { kind: "per_token" } : { kind: "unknown" },
          price: b?.kind === "per_token" && b.currency === "USD" && b.input_per_mtok !== undefined && b.output_per_mtok !== undefined
            ? { input: b.input_per_mtok, output: b.output_per_mtok, cache_read: b.cache_read_per_mtok, cache_write: b.cache_write_per_mtok, estimated: b.estimated }
            : undefined,
        };
      });
  }

  async stream(req: ProviderRequest, onDelta: (d: Delta) => void) {
    const m = this.model(req.model);
    const thinks = m?.capabilities?.reasoning ? m.capabilities.reasoning.kind !== "none" : true;
    const codec = codecFor(this.decl, thinks);
    const ctx = ctxFor(this.id, req, req.efforts ?? []);
    const headers: Record<string, string> = { "content-type": "application/json", accept: this.decl.stream_format === "json_array" ? "application/json" : "text/event-stream" };
    if (this.wire === "anthropic_messages") headers["anthropic-version"] = "2023-06-01";
    const sessionId = req.sessionKey || `keel-${Bun.hash(req.system).toString(16).padStart(24, "0").slice(0, 24)}`;
    return runEvents(codec, req, ctx, onDelta, (body) =>
      this.proc.request({ provider: this.decl, model: req.model, sessionId, operation: "turn", headers, body, signal: req.signal }));
  }
}

export class Plugins {
  procs = new Map<string, PluginProcess>();
  file: string | null = null;
  error?: string;
  onChange?: () => void;

  constructor(private stateDir: string, private capture: (e: unknown, ctx?: unknown) => void, private version = "0.1.0") {
    // A hot reload builds a new registry in the same process: the previous
    // one's plugins stop, so no process is left behind.
    const g = globalThis as { __keelPlugins?: Plugins };
    g.__keelPlugins?.stopAll();
    g.__keelPlugins = this;
  }

  // Reads plugins.toml: a changed entry restarts its plugin, a removed one stops.
  load() {
    const { file, entries, error } = readPlugins();
    this.file = file;
    this.error = error;
    const ids = new Set(entries.map((e) => e.id));
    for (const [id, p] of this.procs) if (!ids.has(id)) { p.stop("removed from plugins.toml"); this.procs.delete(id); }
    for (const e of entries) {
      const cur = this.procs.get(e.id);
      if (cur && cur.entry.fingerprint === e.fingerprint && cur.state !== "stopped") continue;
      if (cur && cur.state !== "stopped") cur.stop("its entry changed");
      const p = new PluginProcess(e, this.stateDir, this.version, this.capture);
      p.onChange = () => this.onChange?.();
      this.procs.set(e.id, p);
      p.start();
    }
  }

  providers(): PluginProvider[] {
    return [...this.procs.values()].flatMap((p) => p.providers.map((d) => new PluginProvider(p, d)));
  }

  async settled() {
    await Promise.all([...this.procs.values()].map((p) => p.whenSettled()));
  }

  async freshen() {
    await Promise.all([...this.procs.values()].map((p) => p.freshen().catch(() => {})));
  }

  summary() {
    return [...this.procs.values()].map((p) => ({
      id: p.entry.id,
      state: p.state,
      name: p.name,
      version: p.version,
      protocol_version: p.protocol,
      pid: p.pid,
      reason: p.reason,
      restart_in_ms: p.state === "restarting" ? Math.max(0, p.restartAt - Date.now()) : undefined,
      stderr_tail: p.state !== "ready" && p.stderrTail ? p.stderrTail.slice(-600) : undefined,
      violations: p.violations,
      providers: p.providers.map((d) => {
        const pp = new PluginProvider(p, d);
        const l = p.models.get(d.id);
        return { ...pp.status(), wire: d.wire, unusable: d.unusable, models: l?.models.length ?? 0, listing_problem: l?.problem };
      }),
    }));
  }

  stopAll() {
    for (const p of this.procs.values()) p.stop("keel-bun stopped");
  }
  killAll() {
    for (const p of this.procs.values()) p.killNow();
  }
}
