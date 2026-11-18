// Grok plan sign-in (SuperGrok, X Premium+): xAI's device code sign-in
// (RFC 8628) at auth.x.ai with the Grok CLI's public client id, as the
// programs xAI announced plan sign-in for do. keel-bun keeps its own grant in
// <config>/xai-auth.json (mode 0600): xAI's refresh token is single-use, so a
// grant shared with another program would sign one of them out.
//
// Requests use the Responses API on the documented API first; a plan the API
// refuses moves the grant to the Grok CLI's proxy once, and the choice is saved.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configDir } from "./config.ts";
import { ctxFor, httpEvents, runEvents } from "./drive.ts";
import { getJson, ProviderError, scrub } from "./http.ts";
import type { Delta, ListedModel, Provider, ProviderRequest, ProviderStatus } from "./types.ts";
import { responsesWire } from "./wires/responses.ts";

const ISSUER = process.env.KEEL_XAI_ISSUER ?? "https://auth.x.ai";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";
const API = "https://api.x.ai/v1";
const PROXY = "https://cli-chat-proxy.grok.com/v1";
const MARGIN = 5 * 60_000;
const UA = "keel-bun";

type Grant = {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_at_ms: number;
  obtained_at_ms: number;
  surface: "api" | "cli_proxy";
  surface_confirmed?: boolean;
  client_version?: string;
  refresh_lost?: boolean;
};

export type SignIn = {
  state: "idle" | "pending" | "signed_in" | "failed";
  error?: string;
  step?: "device_code" | "approval" | "token" | "grant_write" | "listing" | "refresh";
  verification_uri?: string;
  verification_uri_complete?: string;
  user_code?: string;
  expires_at_ms?: number;
};

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

async function postForm(path: string, body: Record<string, string>, secrets: string[]): Promise<{ status: number; json: any }> {
  try {
    const r = await fetch(`${ISSUER}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": UA },
      body: form(body),
      signal: AbortSignal.timeout(60_000),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  } catch (e) {
    throw new ProviderError("network", `xAI sign-in request failed: ${scrub((e as Error).message, secrets)}`);
  }
}

export class XaiProvider implements Provider {
  readonly id = "grok";
  readonly label = "Grok plan";
  readonly wire = "openai_responses" as const;
  readonly family = "other" as const;
  private refreshing: Promise<Grant> | null = null;
  private signIn: SignIn = { state: "idle" };
  private attempt = 0;
  onSignedIn?: () => void;

  private get file() { return join(configDir(), "xai-auth.json"); }

  grant(): Grant | null {
    try {
      const g = JSON.parse(readFileSync(this.file, "utf8"));
      return g?.access_token ? g : null;
    } catch {
      return null;
    }
  }

  private save(g: Grant) {
    mkdirSync(configDir(), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(g, null, 2), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  available() {
    return !!this.grant();
  }

  status(): ProviderStatus {
    const g = this.grant();
    return {
      id: this.id, label: this.label, wire: this.wire, kind: "builtin", available: !!g,
      detail: g ? `signed in (${g.surface === "cli_proxy" ? "Grok CLI surface" : "xAI API"})` : "not signed in",
      sign_in: g ? undefined : { route: "/api/providers/grok/sign-in", note: "Sign in with your Grok plan." },
    };
  }

  // ---- sign-in ----

  signInState(): SignIn {
    if (this.signIn.state === "idle" && this.grant()) return { state: "signed_in" };
    return this.signIn;
  }

  async startSignIn(): Promise<SignIn> {
    const attempt = ++this.attempt;
    const { status, json } = await postForm("/oauth2/device/code", { client_id: CLIENT_ID, scope: SCOPE, referrer: "keel" }, []).catch((e) => {
      this.signIn = { state: "failed", step: "device_code", error: (e as Error).message };
      throw e;
    });
    if (status < 200 || status >= 300 || !json.device_code || !json.verification_uri) {
      const why = `${json.error ?? `HTTP ${status}`}${json.error_description ? `: ${json.error_description}` : ""}`;
      this.signIn = { state: "failed", step: "device_code", error: `xAI refused to start a sign-in (${why}). Check the network and try again.` };
      throw new ProviderError("auth", this.signIn.error!, status);
    }
    const safe = (u?: string) => (u && u.startsWith("https://") ? u : undefined);
    const expiresIn = Number(json.expires_in) > 0 ? Number(json.expires_in) : 300;
    this.signIn = {
      state: "pending",
      verification_uri: safe(json.verification_uri),
      verification_uri_complete: safe(json.verification_uri_complete),
      user_code: json.user_code,
      expires_at_ms: Date.now() + expiresIn * 1000,
    };
    void this.poll(attempt, json.device_code, json.user_code, Math.max(1, Number(json.interval) || 5), expiresIn);
    return this.signIn;
  }

  private async poll(attempt: number, deviceCode: string, userCode: string, interval: number, expiresIn: number) {
    const deadline = Date.now() + expiresIn * 1000;
    const secrets = [deviceCode, userCode];
    let last = "";
    const fail = (step: SignIn["step"], error: string) => {
      if (attempt === this.attempt) this.signIn = { state: "failed", step, error };
    };
    for (;;) {
      await Bun.sleep(interval * 1000);
      if (attempt !== this.attempt) return; // a newer sign-in took its place
      if (Date.now() >= deadline) return fail("approval", `The Grok sign-in code expired before it was approved${last ? ` (xAI's last answer: ${last})` : ""}: start the sign-in again.`);
      let r: { status: number; json: any };
      try {
        r = await postForm("/oauth2/token", { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: CLIENT_ID, device_code: deviceCode }, secrets);
      } catch (e) {
        last = (e as Error).message.slice(0, 120);
        continue;
      }
      if (r.status >= 200 && r.status < 300) {
        if (!r.json.access_token || !r.json.refresh_token) {
          return fail("token", `xAI approved the sign-in, but its answer lacked a token (it carried: ${Object.keys(r.json).sort().join(", ") || "no field"}): start again.`);
        }
        try {
          this.save(this.grantFrom(r.json, null));
        } catch (e) {
          return fail("grant_write", `Could not save ${this.file}: ${(e as Error).message}`);
        }
        if (attempt === this.attempt) this.signIn = { state: "signed_in" };
        this.onSignedIn?.();
        return;
      }
      const code = String(r.json.error ?? "");
      if (code === "authorization_pending") continue;
      if (code === "slow_down" || r.status === 429 || r.status >= 500) { interval += 5; last = `HTTP ${r.status} ${code}`; continue; }
      const said = scrub(`${code}${r.json.error_description ? `: ${r.json.error_description}` : ""}`, secrets);
      return fail("approval", code === "access_denied" ? `The Grok sign-in was refused in the browser (${said}): start again and approve it.`
        : code === "expired_token" ? `The Grok sign-in code expired (${said}): start the sign-in again.`
        : `xAI refused the sign-in (HTTP ${r.status}, ${said}): start the sign-in again.`);
    }
  }

  private grantFrom(b: any, prev: Grant | null): Grant {
    const now = Date.now();
    const life = Number(b.expires_in) > 0 ? Number(b.expires_in) * 1000 : 3600_000;
    return {
      access_token: b.access_token,
      refresh_token: b.refresh_token ?? prev?.refresh_token,
      id_token: b.id_token ?? prev?.id_token,
      expires_at_ms: now + life,
      obtained_at_ms: now,
      surface: prev?.surface ?? "api",
      surface_confirmed: prev?.surface_confirmed,
      client_version: prev?.client_version,
    };
  }

  async signOut(): Promise<boolean> {
    const g = this.grant();
    if (!g) return false;
    await postForm("/oauth2/revoke", { token: g.refresh_token, token_type_hint: "refresh_token", client_id: CLIENT_ID }, [g.refresh_token]).catch(() => {});
    rmSync(this.file, { force: true });
    this.signIn = { state: "idle" };
    return true;
  }

  // ---- tokens ----

  private async fresh(force = false): Promise<Grant> {
    const g = this.grant();
    if (!g) throw new ProviderError("auth", "Grok: not signed in: sign in from the providers panel");
    if (!force && g.expires_at_ms - Date.now() > MARGIN) return g;
    this.refreshing ??= this.renew(g).finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async renew(before: Grant): Promise<Grant> {
    const cur = this.grant() ?? before;
    if (cur.access_token !== before.access_token && cur.expires_at_ms - Date.now() > MARGIN) return cur;
    if (cur.refresh_lost) {
      // Sending the old refresh token again could revoke the grant.
      if (cur.expires_at_ms > Date.now()) return cur;
      throw new ProviderError("auth", "Grok: the sign-in could not be renewed: sign in again");
    }
    let r: { status: number; json: any };
    try {
      r = await postForm("/oauth2/token", { grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: cur.refresh_token }, [cur.refresh_token]);
    } catch (e) {
      // The renewal may have reached xAI and rotated the token: never resend it.
      this.save({ ...cur, refresh_lost: true });
      throw new ProviderError("auth", `Grok: the answer to a renewal was lost (${(e as Error).message}); the sign-in lasts until it expires`);
    }
    if (r.status >= 200 && r.status < 300 && r.json.access_token) {
      const g = this.grantFrom(r.json, cur);
      this.save(g);
      return g;
    }
    if (r.status === 403) throw new ProviderError("quota", "Grok: xAI refused to renew the sign-in for this plan (HTTP 403)", 403);
    throw new ProviderError("auth", `Grok: the sign-in was revoked or used up (${r.json.error ?? r.status}): sign in again`, r.status);
  }

  private base(g: Grant) {
    return process.env.KEEL_XAI_PLAN_BASE_URL ?? (g.surface === "cli_proxy" ? PROXY : API);
  }

  private clientVersion(g: Grant): string {
    if (g.client_version) return g.client_version;
    try {
      const v = JSON.parse(readFileSync(join(homedir(), ".grok/models_cache.json"), "utf8")).grok_version;
      if (/^[\d.]{1,32}$/.test(v)) return v;
    } catch {}
    return "1.0.13";
  }

  private headers(g: Grant, model?: string, sessionKey?: string): Record<string, string> {
    const h: Record<string, string> = { authorization: `Bearer ${g.access_token}`, "user-agent": UA };
    if (sessionKey) h["x-grok-conv-id"] = sessionKey;
    if (g.surface === "cli_proxy") {
      h["X-XAI-Token-Auth"] = "xai-grok-cli";
      h["x-grok-client-version"] = this.clientVersion(g);
      if (model) h["x-grok-model-override"] = model;
    }
    return h;
  }

  // The plan refused on the API: try the proxy once and keep that choice.
  private moveToProxy(g: Grant, why: ProviderError): Grant | null {
    if (g.surface !== "api" || g.surface_confirmed || process.env.KEEL_XAI_PLAN_BASE_URL) return null;
    if (!(why.status === 401 || why.status === 403 || why.status === 402 || why.kind === "quota")) return null;
    const next = { ...g, surface: "cli_proxy" as const };
    this.save(next);
    return next;
  }

  async list(): Promise<ListedModel[]> {
    let g = await this.fresh();
    const get = (gr: Grant) => getJson(this.label, `${this.base(gr)}/models`, this.headers(gr), [gr.access_token]);
    let d: any;
    try {
      d = await get(g);
    } catch (e) {
      const moved = e instanceof ProviderError ? this.moveToProxy(g, e) : null;
      if (!moved) throw e;
      g = moved;
      d = await get(g);
    }
    const rows: any[] = Array.isArray(d.data) ? d.data : Array.isArray(d.models) ? d.models
      : d.models && typeof d.models === "object" ? Object.entries(d.models).map(([id, r]: any) => ({ id, ...r })) : [];
    const field = (r: any, a: string, b: string) => r[a] ?? r[b] ?? r._meta?.[a] ?? r._meta?.[b];
    const out = rows
      .filter((r) => r?.id && !r.hidden && !/image|video|imagine|tts|voice/.test(r.id))
      .map((r): ListedModel => {
        const levels = (field(r, "reasoning_effort", "reasoningEffort") ?? r.capabilities?.reasoning_effort ?? [])
          .map((l: any) => (typeof l === "string" ? l : l?.value)).filter(Boolean);
        return {
          model: r.id,
          name: field(r, "display_name", "displayName") ?? r.name,
          context: field(r, "context_length", "contextWindow") ?? field(r, "context_window", "contextLength"),
          efforts: levels.length ? levels : undefined,
          billing: { kind: "subscription", plan: "Grok" },
        };
      });
    if (!out.length) throw new ProviderError("server", "Grok: the plan's listing named no chat model");
    if (!g.surface_confirmed) this.save({ ...g, surface_confirmed: true });
    return out;
  }

  // The plan's weekly window on the proxy surface.
  async window(): Promise<{ used_percent: number; resets_at_ms?: number; overage_enabled?: boolean } | null> {
    const g = this.grant();
    if (!g || g.surface !== "cli_proxy") return null;
    try {
      const d = await getJson(this.label, `${this.base(g)}/billing?format=credits`, { ...this.headers(g), "x-grok-client-mode": "cli" }, [g.access_token]);
      const used = d.config?.creditUsagePercent;
      if (typeof used !== "number") return null;
      const end = d.config?.currentPeriod?.end;
      const resets = typeof end === "number" ? (end < 1e11 ? end * 1000 : end) : typeof end === "string" ? Date.parse(end) : undefined;
      return { used_percent: Math.min(100, Math.max(0, used)), resets_at_ms: resets, overage_enabled: d.config?.onDemandEnabled };
    } catch {
      return null;
    }
  }

  async usage() {
    const w = await this.window();
    return w ? [{ id: "weekly", label: "Plan window", ...w }] : [];
  }

  async stream(req: ProviderRequest, onDelta: (d: Delta) => void) {
    let g = await this.fresh();
    const ctx = ctxFor(this.id, req, req.efforts ?? []);
    const run = (gr: Grant) => runEvents(responsesWire("xai"), req, ctx, onDelta, httpEvents({
      label: this.label, url: `${this.base(gr)}/responses`, headers: this.headers(gr, req.model, req.sessionKey), secrets: [gr.access_token],
      onAuthFailure: async () => {
        g = await this.fresh(true);
        return this.headers(g, req.model, req.sessionKey);
      },
    }, req));
    try {
      return await run(g);
    } catch (e) {
      const moved = e instanceof ProviderError ? this.moveToProxy(g, e) : null;
      if (!moved) throw e;
      return run(moved);
    }
  }
}

export const grantExists = () => existsSync(join(configDir(), "xai-auth.json"));
