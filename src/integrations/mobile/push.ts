// Push to the phone: data-only messages through Firebase Cloud Messaging HTTP
// v1, the channel the phone app listens on. The owner puts the service-account
// key of the app's Firebase project at <config>/fcm-service-account.json (Keel's
// own config folder, else the shared keel one). Without it nothing is sent and
// every caller is told which file is missing. Neither the key, the access token
// nor a push token is ever logged or returned.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configDir } from "../../providers/config.ts";
import { sha256Hex } from "./sig.ts";
import { outward } from "../../safety/egress.ts";
import type { MobileStore, PushRecord } from "./store.ts";

const FILE = "fcm-service-account.json";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

export function accountPath(): string {
  const own = join(configDir(), FILE);
  if (existsSync(own)) return own;
  const x = process.env.XDG_CONFIG_HOME;
  const shared = join(x?.startsWith("/") ? x : join(homedir(), ".config"), "keel", FILE);
  return existsSync(shared) ? shared : own;
}
export const configured = () => existsSync(accountPath());

// The app's Firebase client configuration beside the key, for GET /v1/push-config.
// `google-services.json`, as Firebase hands it out, holds one entry per Android
// package of the project: the asking app gets its own. `fcm-client.json` (api_key,
// app_id, project_id, sender_id) serves an app that names no package.
export const SERVICES_FILE = "google-services.json";
export function clientConfig(app?: string): { config: Record<string, string> | null; missing?: string } {
  if (!configured()) return { config: null, missing: accountPath() };
  const dir = join(accountPath(), "..");
  if (app) {
    const path = join(dir, SERVICES_FILE);
    let services: unknown = null;
    try {
      services = JSON.parse(readFileSync(path, "utf8"));
    } catch {}
    const config = services ? configForPackage(services, app) : null;
    if (config) return { config };
    if (app !== "dev.avifenesh.hermes") return { config: null, missing: path };
  }
  try {
    return { config: JSON.parse(readFileSync(join(dir, "fcm-client.json"), "utf8")) };
  } catch {
    return { config: null, missing: join(dir, app ? SERVICES_FILE : "fcm-client.json") };
  }
}

// One package's client entry of a google-services.json, in the app's shape.
export function configForPackage(services: any, pkg: string): Record<string, string> | null {
  const info = services?.project_info;
  const client = ((services?.client ?? []) as any[]).find((c) => c?.client_info?.android_client_info?.package_name === pkg);
  const key = client?.api_key?.find?.((k: any) => typeof k?.current_key === "string")?.current_key;
  const appId = client?.client_info?.mobilesdk_app_id;
  if (!info?.project_id || !info.project_number || typeof key !== "string" || typeof appId !== "string") return null;
  return { api_key: key, app_id: appId, project_id: String(info.project_id), sender_id: String(info.project_number) };
}

type Account = { project_id: string; client_email: string; private_key: string; token_uri: string };

function readAccount(): Account {
  const path = accountPath();
  if (!existsSync(path)) throw new PushNotSetUp(`push is not set up: put the service-account key of the app's Firebase project at ${path}`);
  let a: any;
  try {
    a = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path} is not a service-account key file`);
  }
  if (typeof a?.project_id !== "string" || typeof a.client_email !== "string" || typeof a.private_key !== "string")
    throw new Error(`${path} is not a service-account key file`);
  return { project_id: a.project_id, client_email: a.client_email, private_key: a.private_key, token_uri: a.token_uri || "https://oauth2.googleapis.com/token" };
}

export class PushNotSetUp extends Error {}

const b64url = (b: Uint8Array | string) => (typeof b === "string" ? new TextEncoder().encode(b) : b).toBase64({ alphabet: "base64url", omitPadding: true });

// RFC 7523 assertion, RS256 over the header and claims.
async function assertion(a: Account, now: number): Promise<string> {
  const input = `${b64url('{"alg":"RS256","typ":"JWT"}')}.${b64url(JSON.stringify({ iss: a.client_email, scope: SCOPE, aud: a.token_uri, iat: now, exp: now + 3600 }))}`;
  let key: CryptoKey;
  try {
    const der = Uint8Array.fromBase64(a.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
    key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    throw new Error("the private key of the service account is not a PKCS#8 RSA key");
  }
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input)));
  return `${input}.${b64url(sig)}`;
}

let cached: { value: string; until: number; account: string } | null = null;

async function accessToken(a: Account): Promise<string> {
  if (cached && cached.account === a.client_email && cached.until > Date.now()) return cached.value;
  const jwt = await assertion(a, Math.floor(Date.now() / 1000));
  let res: Response;
  try {
    res = await outward({ tool: "phone push", via: "token" }, () => fetch(a.token_uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
      signal: AbortSignal.timeout(20_000),
    }));
  } catch (e) {
    throw new Error(`the push service's token endpoint was not reached: ${(e as Error).message}`);
  }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.access_token !== "string")
    throw new Error(`the push service refused the service account (${res.status}): ${body.error_description ?? body.error ?? "no reason given"}`);
  // Renewed a minute early.
  cached = { value: body.access_token, until: Date.now() + (Number(body.expires_in) || 3600) * 1000 - 60_000, account: a.client_email };
  return cached.value;
}

// What one push carries before it is addressed. `kind` is what the app's wake
// handler knows: approval, finished, failed, test, ...
export type PushMessage = { kind: string; session_id?: string | null; high: boolean; data: Record<string, string> };

// The data of one push as the app gets it: `t` the kind, `c` the session, `s`
// the place in the event sequence, `n` the push's id (the app confirms it),
// then what the message carries (title, body, aid, opts).
export const pushData = (msg: PushMessage, seq: number, id: string): Record<string, string> => ({ t: msg.kind, c: msg.session_id ?? "", s: String(seq), n: id, ...msg.data });

// Sends to every paired device with a push token, or to one. Each attempt is
// recorded and returned; a throw means nothing could be tried.
export async function send(mobile: MobileStore, seq: number, msg: PushMessage, deviceId?: string): Promise<PushRecord[]> {
  const account = readAccount();
  const targets = mobile.pushTargets(deviceId);
  if (!targets.length) return [];
  const token = await accessToken(account);
  const base = (process.env.KEEL_FCM_URL || "https://fcm.googleapis.com").replace(/\/+$/, "");
  const url = `${base}/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`;
  const out: PushRecord[] = [];
  for (const t of targets) {
    const id = `push_${crypto.getRandomValues(new Uint8Array(8)).toHex()}`;
    const data = pushData(msg, seq, id);
    // Fifteen minutes: an alert is stale after that and the app syncs when it
    // opens. Only the live status collapses; alerts are each their own news.
    // The live status keeps a day: a phone offline past fifteen minutes would
    // otherwise miss the "nothing runs" that takes its notification down, and
    // the daemon, told it was sent, would not send it again. (The collapse key
    // keeps only the newest, so nothing piles up.)
    const android: any = { priority: msg.high ? "HIGH" : "NORMAL", ttl: msg.kind === "live" ? "86400s" : "900s" };
    if (msg.kind === "live") android.collapse_key = "live";
    const rec: PushRecord = { id, device_id: t.device_id, kind: msg.kind, session_id: msg.session_id ?? null, sent_ms: Date.now(), ok: false, error: "sending", acked_ms: null, token_hash: sha256Hex(t.token) };
    mobile.recordPush(rec);
    let ok = false, error: string | undefined;
    try {
      const res = await outward({ tool: "phone push", via: msg.kind, ...(msg.session_id ? { session: msg.session_id } : {}) }, () => fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ message: { token: t.token, data, android } }),
        signal: AbortSignal.timeout(20_000),
      }));
      ok = res.ok;
      if (!ok) {
        const d: any = await res.json().catch(() => ({}));
        // The app was removed or its token rotated: the push service says
        // UNREGISTERED for that token. Only the token tried is dropped, never a
        // newer one the phone registered meanwhile; any other 404 keeps it.
        const code = [d?.error?.status, ...((d?.error?.details ?? []) as any[]).map((x) => x?.errorCode)];
        if (code.includes("UNREGISTERED")) mobile.dropPushToken(t.token);
        if (res.status === 401) cached = null;
        error = `the push service answered ${res.status}: ${code.includes("UNREGISTERED") ? "UNREGISTERED" : d?.error?.status ?? d?.error?.message ?? "refused"}`;
      }
    } catch (e) {
      error = `the push service was not reached: ${(e as Error).message}`;
    }
    Object.assign(rec, { ok, error: error ?? null });
    mobile.recordPush(rec);
    const { token_hash: _, ...shown } = rec;
    out.push(shown);
  }
  return out;
}

export const testMessage = (): PushMessage => ({
  kind: "test",
  high: true,
  data: { title: "Keel test push", body: "If you can read this, push from this machine reaches the phone." },
});
