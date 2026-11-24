// ChatGPT sign-in (the Codex backend): the plan pays, the Codex CLI's sign-in
// in ~/.codex/auth.json is the credential, its `/models` is the listing.
//
// Refresh follows the Codex CLI's own rules for several processes on one file
// (codex-rs/login auth manager): renew when less than five minutes are left,
// read the file again first and take a token another process already renewed,
// write the new tokens back atomically and only over the tokens that were read.
// The Codex CLI reloads the file on a 401 before it refreshes, so it keeps
// working on what keel-bun wrote.
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrokerAddress, directBrokerOrigin } from "./broker-address.ts";
import { fingerprint } from "./creds.ts";
import { ctxFor, httpEvents, runEvents } from "./drive.ts";
import { getJson, fetchFailure, ProviderError, scrub } from "./http.ts";
import type { Delta, ListedModel, Provider, ProviderRequest, ProviderStatus } from "./types.ts";
import { responsesWire } from "./wires/responses.ts";
import { fromChatgptUsage, type WindowReading } from "./limits.ts";
import { ResponsesSockets, WsTooLarge, WsUnavailable } from "./responses-ws.ts";
import { homeDir } from "../core/paths";

const REFRESH_MARGIN = 5 * 60_000;
// The Codex CLI's public client id, used only when the file names none.
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

type AuthFile = {
  tokens?: { access_token?: string; refresh_token?: string; id_token?: string; account_id?: string; oauth_provenance?: { issuer?: string; client_id?: string } };
  last_refresh?: string;
  [k: string]: unknown;
};

export function jwtExpiryMs(token: string): number | undefined {
  try {
    const p = token.split(".")[1]!;
    const claims = JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return typeof claims.exp === "number" ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

// The client version Codex's models cache was written for, if it names one.
export function cachedVersion(home: string): string | undefined {
  try {
    const v = JSON.parse(readFileSync(join(home, "models_cache.json"), "utf8")).client_version;
    return typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

// The higher of two x.y.z versions, by number; either may be missing.
export function newerVersion(a?: string, b?: string): string | undefined {
  if (!a || !b) return a ?? b;
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]! ? a : b;
  return a;
}

export class CodexProvider implements Provider {
  readonly id = "chatgpt";
  readonly label = "ChatGPT sign-in";
  readonly wire = "openai_responses" as const;
  readonly family = "gpt" as const;
  private home = process.env.CODEX_HOME ?? join(homeDir(), ".codex");
  private file = join(this.home, "auth.json");
  readonly broker = new BrokerAddress("KEEL_CODEX_BASE_URL", process.env.KEEL_CODEX_BASE_URL);
  private get base() { return (this.broker.value ?? "https://chatgpt.com/backend-api/codex").replace(/\/$/, ""); }
  private refreshing: Promise<AuthFile> | null = null;

  private read(): AuthFile | null {
    try {
      return JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return null;
    }
  }

  available() {
    return existsSync(this.file) && !!this.read()?.tokens?.access_token;
  }

  // The stored sign-in as it is on disk, with nothing asked or renewed: when its access token ends, and whether
  // a refresh token is there to renew it. Null when not signed in.
  stored(): { expires_at_ms?: number; refreshable: boolean } | null {
    const t = this.read()?.tokens;
    if (!t?.access_token) return null;
    return { expires_at_ms: jwtExpiryMs(t.access_token), refreshable: !!t.refresh_token };
  }

  identity() {
    return fingerprint(this.id, this.broker.identity?.replace(/\/$/, "") ?? this.base, this.read()?.tokens?.account_id);
  }

  status(): ProviderStatus {
    const ok = this.available();
    return {
      id: this.id, label: this.label, wire: this.wire, kind: "builtin", available: ok,
      detail: ok ? "~/.codex/auth.json" : "not signed in: run `codex login`",
      sign_in: ok ? undefined : { command: "codex login" },
    };
  }

  // A usable sign-in: renewed first when it is about to expire, or when the
  // backend refused it (`force`).
  private async auth(force = false): Promise<AuthFile> {
    const a = this.read();
    if (!a?.tokens?.access_token) throw new ProviderError("auth", "ChatGPT: not signed in: run `codex login`");
    const exp = jwtExpiryMs(a.tokens.access_token) ?? Infinity;
    if (!force && exp - Date.now() > REFRESH_MARGIN) return a;
    this.refreshing ??= this.refresh(a.tokens.access_token).finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async refresh(stale: string): Promise<AuthFile> {
    const now = this.read();
    const t = now?.tokens;
    if (!now || !t?.refresh_token) throw new ProviderError("auth", "ChatGPT: the sign-in has no refresh token: run `codex login`");
    // Another process (a Codex CLI) renewed it meanwhile.
    if (t.access_token && t.access_token !== stale && (jwtExpiryMs(t.access_token) ?? Infinity) - Date.now() > REFRESH_MARGIN) return now;
    const issuer = (t.oauth_provenance?.issuer ?? "https://auth.openai.com").replace(/\/$/, "");
    const r = await fetch(`${issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: t.oauth_provenance?.client_id ?? CODEX_CLIENT_ID, grant_type: "refresh_token", refresh_token: t.refresh_token }),
      signal: AbortSignal.timeout(30_000),
    }).catch((e) => { throw fetchFailure("ChatGPT sign-in renewal", e); });
    const body: any = await r.json().catch(() => ({}));
    if (!r.ok || !body.access_token) {
      const code = body.error?.code ?? body.error ?? r.status;
      throw new ProviderError("auth", `ChatGPT: the sign-in could not be renewed (${scrub(String(code))}): run \`codex login\``);
    }
    // Write over the tokens read only: a newer file from another process wins.
    const latest = this.read();
    if (latest?.tokens?.refresh_token !== t.refresh_token) return latest!;
    const next: AuthFile = {
      ...latest,
      tokens: { ...latest.tokens, access_token: body.access_token, refresh_token: body.refresh_token ?? t.refresh_token, id_token: body.id_token ?? t.id_token },
      last_refresh: new Date().toISOString(),
    };
    const tmp = `${this.file}.keel-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    return next;
  }

  private headers(a: AuthFile, sessionKey?: string): Record<string, string> {
    const h: Record<string, string> = { authorization: `Bearer ${a.tokens!.access_token}`, originator: "keel", "OpenAI-Beta": "responses=experimental" };
    if (a.tokens?.account_id) h["chatgpt-account-id"] = a.tokens.account_id;
    if (sessionKey) h.session_id = sessionKey;
    return h;
  }

  // The client version the backend's listing is asked for. The backend lists
  // only the models a client of that version knows, so it is the newer of the
  // Codex CLI this daemon would run and the version in Codex's models cache:
  // the cache is written by whichever Codex ran last, which can be an older
  // install elsewhere on the machine. Read again at each listing; the CLI is
  // asked again only when its binary changed (an upgrade).
  private clientVersion(): string {
    return newerVersion(this.cliVersion(), cachedVersion(this.home)) ?? "0.1.0";
  }

  private cli: { key: string; version: string | undefined } | null = null;
  private cliVersion(): string | undefined {
    const bin = Bun.which("codex", { PATH: process.env.PATH ?? "" });
    let key = "";
    try { const st = statSync(bin ?? ""); key = `${bin}:${st.size}:${st.mtimeMs}`; } catch {}
    if (this.cli?.key === key) return this.cli.version;
    const out = key ? Bun.spawnSync([bin!, "--version"], { stderr: "ignore" }).stdout?.toString() ?? "" : "";
    this.cli = { key, version: /(\d+\.\d+\.\d+)/.exec(out)?.[1] };
    return this.cli.version;
  }

  async list(): Promise<ListedModel[]> {
    const a = await this.auth();
    const d = await getJson(this.label, `${this.base}/models?client_version=${this.clientVersion()}`, this.headers(a), [a.tokens!.access_token!]);
    return (d.models ?? [])
      .filter((m: any) => m.visibility !== "hide" && m.supported_in_api !== false)
      .map((m: any): ListedModel => ({
        model: m.slug,
        name: m.display_name,
        context: m.context_window,
        efforts: (m.supported_reasoning_levels ?? []).map((l: any) => l.effort).filter(Boolean),
        family: "gpt",
        billing: { kind: "subscription", plan: "ChatGPT" },
        images: Array.isArray(m.input_modalities) ? m.input_modalities.includes("image") : undefined,
        // The tiers the backend sells for this model (Fast is `priority`,
        // Ultrafast `ultrafast`), sent as Codex sends them: `service_tier` plus
        // its routing hint. A plan has no per-token price; the note says what
        // it costs in plan usage.
        speeds: Array.isArray(m.service_tiers) && m.service_tiers.length
          ? m.service_tiers.filter((t: any) => typeof t?.id === "string").map((t: any) => ({
            id: t.id, label: t.name ?? t.id, note: t.description, body: { service_tier: t.id },
            headers: { "x-codex-routing-hint": `model=${m.slug};tier=${t.id}` },
          }))
          : undefined,
      }));
  }

  // A request for a response asks the backend not to echo what Keel does not
  // read: the tool catalog the request sent, and the usage's attribution per
  // item (the totals stay). Codex sends the same on every Responses request
  // and WebSocket handshake (codex-rs core client.rs build_responses_headers,
  // openai/codex#62863 and #63219); the echo repeats the whole catalog in each
  // response event of a stream.
  private responseHeaders(a: AuthFile, sessionKey?: string): Record<string, string> {
    return { ...this.headers(a, sessionKey), "x-codex-exclude": "tools,usage.attribution" };
  }

  // The plan's windows as Codex's /status reads them.
  async usage(): Promise<WindowReading[]> {
    const a = await this.auth();
    const d = await getJson(this.label, `${this.base.replace(/\/codex$/, "")}/wham/usage`, this.headers(a), [a.tokens!.access_token!]);
    return fromChatgptUsage(d);
  }

  // The Responses WebSocket of the backend (Codex main's default transport).
  private sockets = new ResponsesSockets(this.label, () => `${this.base.replace(/^http/, "ws")}/responses`);

  async stream(req: ProviderRequest, onDelta: (d: Delta) => void) {
    let a = await this.auth();
    const ctx = ctxFor(this.id, req, req.efforts ?? []);
    // The routing hint (model and tier) goes with the handshake: one socket per speed too.
    // And per purpose: a reader or a side answer on the session's own model
    // would replace the response the turn's socket holds, and the turn's next
    // request would be sent whole.
    const key = `${req.sessionKey ?? ""}|${req.model}|${req.extraHeaders?.["x-codex-routing-hint"] ?? ""}|${req.purpose ?? "turn"}`;
    // Use HTTP for a reloadable loopback broker: it reports a precise connect
    // refusal and never reuses a socket from before a port move.
    if (req.sessionKey && !directBrokerOrigin(this.base) && this.sockets.usable(key)) {
      const headers = { ...this.responseHeaders(a, req.sessionKey), "OpenAI-Beta": "responses_websockets=2026-02-06", ...req.extraHeaders };
      try {
        const res = await runEvents(responsesWire("codex"), req, ctx, onDelta, this.sockets.events(key, headers, req, (m) => this.rateEvent(m, req)));
        delete res.served;
        return res;
      } catch (e) {
        if (e instanceof WsTooLarge) this.sockets.oversized();
        else if (e instanceof WsUnavailable) this.sockets.refused(key);
        else throw e;
      }
    }
    const res = await runEvents(responsesWire("codex"), req, ctx, onDelta, httpEvents({
      label: this.label, url: `${this.base}/responses`, headers: this.responseHeaders(a, req.sessionKey), secrets: [a.tokens!.access_token!],
      onAuthFailure: async () => {
        a = await this.auth(true);
        return this.responseHeaders(a, req.sessionKey);
      },
    }, req));
    // The backend answers `service_tier: "default"` whatever served the call
    // (measured: a Fast or Ultrafast request still comes back faster), so its
    // echo says nothing; the tier asked for is what is recorded.
    delete res.served;
    return res;
  }

  // The plan's windows arrive on the socket as a `codex.rate_limits` event
  // instead of the HTTP answer's headers; they are read the same way.
  private rateEvent(m: any, req: ProviderRequest) {
    if (m?.type !== "codex.rate_limits" || !req.onHeaders) return;
    const h = new Headers();
    for (const slot of ["primary", "secondary"] as const) {
      const w = m.rate_limits?.[slot];
      if (!w || typeof w.used_percent !== "number") continue;
      h.set(`x-codex-${slot}-used-percent`, String(w.used_percent));
      if (w.window_minutes) h.set(`x-codex-${slot}-window-minutes`, String(w.window_minutes));
      if (w.reset_at) h.set(`x-codex-${slot}-reset-at`, String(w.reset_at));
    }
    req.onHeaders(h);
  }
}
