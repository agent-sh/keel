// Verified owner presence: passkeys (WebAuthn) for what a remote device asks
// for with the owner's authority. A request from the desk itself (the page at
// localhost) needs none. From anywhere else, once a passkey is enrolled, a
// high-risk approval and authority changes (a mode that asks less, a grant,
// the gate's settings) need a fresh assertion signed over that exact action:
// the challenge is the hash of the action and a nonce, a receipt covers that
// one action once, within the ceremony's timeout. Only public keys are stored.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { Store } from "../core/store.ts";
import { forwarded, peerIsRemote } from "../server/admission.ts";

const TIMEOUT = 300_000; // the upstream ceremony timeout; receipts last as long
const SCHEMA = `CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, rp_id TEXT NOT NULL, origin TEXT NOT NULL, public_key TEXT NOT NULL, counter INTEGER NOT NULL, transports TEXT, label TEXT, created INTEGER NOT NULL, used INTEGER);`;

export type Passkey = { id: string; rp_id: string; origin: string; label: string | null; created: number; used: number | null };
type Ceremony = { kind: "register" | "authenticate"; challenge: string; origin: string; rpID: string; action?: string; expires: number };

// A request another daemon forwarded (the fleet forwarder) reaches this one's
// API as a loopback call from itself, which alone would count as the desk. The
// caller's standing over there travels with it instead (signed by the link
// key, checked by the linked route) and is handed to the inner call under a
// key only this process knows: a standing header without that key is a
// forgery and counts as a remote device with passkeys enrolled.
export type Standing = { local: boolean; enrolled: boolean; present: string | null };
const g = globalThis as { __keelInnerKey?: string };
const INNER = (g.__keelInnerKey ??= randomBytes(32).toString("hex"));
const FORGED: Standing = { local: false, enrolled: true, present: null };

// `peer`: the name this daemon knows the forwarding daemon by. It is said in
// the record of an answer that came through it, and decides nothing.
export const innerHeaders = (s: Standing, peer?: string): Record<string, string> => ({ "x-keel-standing": JSON.stringify(s), "x-keel-standing-key": INNER, ...(peer ? { "x-keel-standing-peer": encodeURIComponent(peer) } : {}) });

// The linked machine a forwarded request came through, by this daemon's name for it; null for a request that was not forwarded.
export function forwardedPeer(req: Request): string | null {
  const key = req.headers.get("x-keel-standing-key") ?? "";
  if (key.length !== INNER.length || !timingSafeEqual(Buffer.from(key), Buffer.from(INNER))) return null;
  if (req.headers.get("x-keel-standing") === null) return null;
  try { return decodeURIComponent(req.headers.get("x-keel-standing-peer") ?? "") || "a linked machine"; } catch { return "a linked machine"; }
}

export function forwardedStanding(req: Request): Standing | null {
  const raw = req.headers.get("x-keel-standing");
  if (raw === null) return null;
  const key = req.headers.get("x-keel-standing-key") ?? "";
  if (key.length !== INNER.length || !timingSafeEqual(Buffer.from(key), Buffer.from(INNER))) return FORGED;
  try {
    const s = JSON.parse(raw);
    return { local: s.local === true, enrolled: s.enrolled !== false, present: typeof s.present === "string" ? s.present : null };
  } catch {
    return FORGED;
  }
}

// The desk: the page was opened at localhost (or the loopback address) and no
// proxy stands between. Everything else is a remote device.
export function isLocal(req: Request): boolean {
  const fwd = forwardedStanding(req);
  if (fwd) return fwd.local;
  if (forwarded(req) || peerIsRemote(req)) return false;
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
  const local = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
  if (!local(host)) return false;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try { return local(new URL(origin).hostname.toLowerCase()); } catch { return false; }
}

const originOf = (req: Request) => {
  const o = req.headers.get("origin");
  if (!o) throw Object.assign(new Error("a passkey ceremony needs the page's Origin"), { status: 400 });
  return o;
};

// The relying party of a ceremony: the page's host name. WebAuthn takes a
// domain or localhost and refuses an IP address (the browser fails the
// ceremony with "is an invalid domain"), the loopback address included.
const rpOf = (origin: string) => {
  const host = new URL(origin).hostname;
  if (isIP(host.replace(/^\[|\]$/g, ""))) throw Object.assign(new Error(`a passkey is tied to a name, and this page is open at an address (${host}): open Keel at localhost or at its HTTPS name`), { status: 400 });
  return host;
};

export class Presence {
  private ceremonies = new Map<string, Ceremony>();
  private receipts = new Map<string, { action: string; expires: number }>();
  private codes = new Map<string, number>(); // enrollment code -> expiry

  constructor(private store: Store) {
    store.migrate(SCHEMA);
  }

  list(): Passkey[] {
    return this.store.db.query<Passkey, []>("SELECT id, rp_id, origin, label, created, used FROM passkeys ORDER BY created").all();
  }
  enrolled(): boolean {
    return !!this.store.db.query("SELECT 1 FROM passkeys LIMIT 1").get();
  }
  remove(id: string): boolean {
    return this.store.db.query("DELETE FROM passkeys WHERE id = ?").run(id).changes > 0;
  }

  // A one-time code shown at the desk, typed on the device that enrolls.
  code(): { code: string; expires: number } {
    const code = Array.from({ length: 8 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[randomInt(32)]).join("");
    const expires = Date.now() + 10 * 60_000;
    this.codes.set(code, expires);
    return { code, expires };
  }

  private sweep() {
    const now = Date.now();
    for (const [k, c] of this.ceremonies) if (c.expires < now) this.ceremonies.delete(k);
    for (const [k, r] of this.receipts) if (r.expires < now) this.receipts.delete(k);
    for (const [k, e] of this.codes) if (e < now) this.codes.delete(k);
  }

  async registerStart(req: Request, code?: string) {
    this.sweep();
    const origin = originOf(req);
    if (!isLocal(req)) {
      const c = (code ?? "").trim().toUpperCase();
      if (!c || !this.codes.has(c)) throw Object.assign(new Error("enrolling from another device needs the code shown at the desk (Settings > Safety > Add a device)"), { status: 403 });
      this.codes.delete(c);
    }
    const rpID = rpOf(origin);
    const options = await generateRegistrationOptions({
      rpName: "Keel", rpID, userName: "owner", userDisplayName: "Keel owner", timeout: TIMEOUT, attestationType: "none",
      userID: new TextEncoder().encode("keel-owner"),
      excludeCredentials: this.list().filter((p) => p.rp_id === rpID).map((p) => ({ id: p.id })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
    const ceremony = crypto.randomUUID();
    this.ceremonies.set(ceremony, { kind: "register", challenge: options.challenge, origin, rpID, expires: Date.now() + TIMEOUT });
    return { ceremony, options };
  }

  async registerFinish(req: Request, ceremony: string, credential: any, label?: string) {
    const c = this.ceremonies.get(ceremony);
    this.ceremonies.delete(ceremony); // consumed once, whatever happens
    if (!c || c.kind !== "register" || c.expires < Date.now()) throw Object.assign(new Error("unknown, expired or used ceremony"), { status: 400 });
    if (originOf(req) !== c.origin) throw Object.assign(new Error("the ceremony belongs to another origin"), { status: 400 });
    const v = await verifyRegistrationResponse({ response: credential, expectedChallenge: c.challenge, expectedOrigin: c.origin, expectedRPID: c.rpID, requireUserVerification: true });
    if (!v.verified || !v.registrationInfo) throw Object.assign(new Error("the passkey could not be verified"), { status: 400 });
    const cred = v.registrationInfo.credential;
    this.store.db.query("INSERT INTO passkeys (id, rp_id, origin, public_key, counter, transports, label, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(cred.id, c.rpID, c.origin, Buffer.from(cred.publicKey).toString("base64"), cred.counter, JSON.stringify(cred.transports ?? []), label?.slice(0, 80) || null, Date.now());
    return { id: cred.id };
  }

  // An assertion over one action. The challenge commits to the action.
  async authStart(req: Request, action: string) {
    this.sweep();
    const origin = originOf(req);
    const rpID = rpOf(origin);
    const keys = this.list().filter((p) => p.rp_id === rpID);
    if (!keys.length) throw Object.assign(new Error(`no passkey is enrolled for ${rpID}: enroll this device in Settings > Safety`), { status: 400 });
    const nonce = randomBytes(16).toString("hex");
    const challenge = createHash("sha256").update(`${action}\n${nonce}`).digest();
    const options = await generateAuthenticationOptions({ rpID, challenge, timeout: TIMEOUT, userVerification: "required", allowCredentials: keys.map((k) => ({ id: k.id })) });
    const ceremony = crypto.randomUUID();
    this.ceremonies.set(ceremony, { kind: "authenticate", challenge: options.challenge, origin, rpID, action, expires: Date.now() + TIMEOUT });
    return { ceremony, options };
  }

  async authFinish(req: Request, ceremony: string, credential: any): Promise<{ receipt: string; action: string }> {
    const c = this.ceremonies.get(ceremony);
    this.ceremonies.delete(ceremony);
    if (!c || c.kind !== "authenticate" || c.expires < Date.now() || !c.action) throw Object.assign(new Error("unknown, expired or used ceremony"), { status: 400 });
    if (originOf(req) !== c.origin) throw Object.assign(new Error("the ceremony belongs to another origin"), { status: 400 });
    const row = this.store.db.query<{ id: string; public_key: string; counter: number; transports: string | null; rp_id: string }, [string]>("SELECT * FROM passkeys WHERE id = ?").get(String(credential?.id ?? ""));
    if (!row || row.rp_id !== c.rpID) throw Object.assign(new Error("that passkey is not enrolled here"), { status: 400 });
    const v = await verifyAuthenticationResponse({
      response: credential, expectedChallenge: c.challenge, expectedOrigin: c.origin, expectedRPID: c.rpID, requireUserVerification: true,
      credential: { id: row.id, publicKey: new Uint8Array(Buffer.from(row.public_key, "base64")), counter: row.counter, transports: row.transports ? JSON.parse(row.transports) : undefined },
    });
    if (!v.verified) throw Object.assign(new Error("the passkey's signature did not verify"), { status: 400 });
    this.store.db.query("UPDATE passkeys SET counter = ?, used = ? WHERE id = ?").run(v.authenticationInfo.newCounter, Date.now(), row.id);
    const receipt = randomBytes(24).toString("base64url");
    this.receipts.set(receipt, { action: c.action, expires: Date.now() + TIMEOUT });
    return { receipt, action: c.action };
  }

  // Whether the request may do `action`: from the desk, before any passkey is
  // enrolled, or with a receipt for exactly that action (used up here).
  // A forwarded request: its own daemon's desk, a receipt redeemed there for
  // exactly this action, or no passkey enrolled on either daemon.
  allows(req: Request, action: string): boolean {
    const fwd = forwardedStanding(req);
    if (fwd) return fwd.local || fwd.present === action || (!fwd.enrolled && !this.enrolled());
    if (isLocal(req) || !this.enrolled()) return true;
    return this.redeem(req) === action;
  }

  // The action of the request's receipt, used up here; null for none.
  redeem(req: Request): string | null {
    const token = req.headers.get("x-keel-presence");
    if (!token) return null;
    const r = this.receipts.get(token);
    this.receipts.delete(token);
    return r && r.expires >= Date.now() ? r.action : null;
  }

  // What the forwarder tells the other daemon about this request's caller.
  standing(req: Request): Standing {
    const local = isLocal(req);
    return { local, enrolled: this.enrolled(), present: local ? null : this.redeem(req) };
  }
}
