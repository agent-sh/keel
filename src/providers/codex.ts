// ChatGPT sign-in (the Codex backend): the plan pays, the Codex CLI's sign-in
// in ~/.codex/auth.json is the credential, its `/models` is the listing.
//
// Refresh follows the Codex CLI's own rules for several processes on one file
// (codex-rs/login auth manager): renew when less than five minutes are left,
// read the file again first and take a token another process already renewed,
// write the new tokens back atomically and only over the tokens that were read.
// The Codex CLI reloads the file on a 401 before it refreshes, so it keeps
// working on what keel-bun wrote.
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ctxFor, httpEvents, runEvents } from "./drive.ts";
import { getJson, ProviderError, scrub } from "./http.ts";
import type { Delta, ListedModel, Provider, ProviderRequest, ProviderStatus } from "./types.ts";
import { responsesWire } from "./wires/responses.ts";

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

export class CodexProvider implements Provider {
  readonly id = "chatgpt";
  readonly label = "ChatGPT sign-in";
  readonly wire = "openai_responses" as const;
  readonly family = "gpt" as const;
  private home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  private file = join(this.home, "auth.json");
  private base = (process.env.KEEL_CODEX_BASE_URL ?? "https://chatgpt.com/backend-api/codex").replace(/\/$/, "");
  private refreshing: Promise<AuthFile> | null = null;
  private version: string | null = null;

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
    }).catch((e) => { throw new ProviderError("network", `ChatGPT sign-in renewal: ${(e as Error).message}`); });
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

  // The client version the backend's listing is asked for: the installed Codex CLI's.
  private clientVersion(): string {
    if (this.version) return this.version;
    try {
      const cache = JSON.parse(readFileSync(join(this.home, "models_cache.json"), "utf8"));
      if (/^\d+\.\d+\.\d+$/.test(cache.client_version)) this.version = cache.client_version;
    } catch {}
    if (!this.version) {
      const out = Bun.spawnSync(["codex", "--version"], { stderr: "ignore" }).stdout?.toString() ?? "";
      this.version = /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? "0.1.0";
    }
    return this.version;
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
      }));
  }

  async stream(req: ProviderRequest, onDelta: (d: Delta) => void) {
    let a = await this.auth();
    const ctx = ctxFor(this.id, req, req.efforts ?? []);
    return runEvents(responsesWire("codex"), req, ctx, onDelta, httpEvents({
      label: this.label, url: `${this.base}/responses`, headers: this.headers(a, req.sessionKey), secrets: [a.tokens!.access_token!],
      onAuthFailure: async () => {
        a = await this.auth(true);
        return this.headers(a, req.sessionKey);
      },
    }, req.signal));
  }
}
