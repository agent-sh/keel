// Ported from the Rust keel's signature, replay and pairing fixtures
// (keel-integrations sig_v2.rs and mobile_v1.rs tests).
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../core/store.ts";
import {
  approvalMessage, canonicalB64, canonicalMessage, checkAndClaim, encodeDerSig, PAIR_FAILURES_PER_SOURCE, PAIR_FAILURES_TOTAL,
  PairLimiter, parseDerSig, requestSource, type ReplayStore,
} from "./sig.ts";
import { MobileStore } from "./store.ts";

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pub = new Uint8Array(publicKey.export({ type: "spki", format: "der" })).toBase64();
  const sigOf = (msg: Uint8Array | string) => new Uint8Array(sign("sha256", typeof msg === "string" ? Buffer.from(msg) : msg, { key: privateKey, dsaEncoding: "der" }));
  return { pub, sign: (msg: Uint8Array | string) => sigOf(msg).toBase64(), raw: sigOf };
}

const memStore = (): ReplayStore => {
  const m = new Map<string, number>();
  return { claim: (id, exp) => (m.has(id) ? false : (m.set(id, exp), true)) };
};
const enc = (s: string) => new TextEncoder().encode(s);

describe("signature replay v2", () => {
  test("blocks replay, the high-S twin and non-canonical Base64; scopes are separate", async () => {
    const k = keypair();
    const now = Math.floor(Date.now() / 1000);
    const ts = String(now);
    const msg = canonicalMessage("POST", "/v1/chats/c1/messages", ts, '{"text":"hi"}');
    const der = k.raw(msg);
    const sig = der.toBase64();
    const { r, s } = parseDerSig(der)!;
    const twin = encodeDerSig(r, N - s).toBase64();
    expect(twin).not.toBe(sig);
    const store = memStore();

    expect(await checkAndClaim(sig, k.pub, msg, ts, "request", now, store)).toBe("valid");
    expect(await checkAndClaim(sig, k.pub, msg, ts, "request", now, store)).toBe("rejected");
    expect(await checkAndClaim(twin, k.pub, msg, ts, "request", now, store)).toBe("rejected");
    expect(await checkAndClaim(twin, k.pub, msg, ts, "approval", now, store)).toBe("valid");

    expect(canonicalB64("YQ==")).not.toBeNull();
    expect(canonicalB64("YR==")).toBeNull();
    expect(canonicalB64("YQ")).toBeNull();
    expect(canonicalB64(" YQ==")).toBeNull();
  });

  test("a wrong body, a stale timestamp or another key fails; a store failure is not 'unauthorized'", async () => {
    const k = keypair(), other = keypair();
    const now = Math.floor(Date.now() / 1000);
    const ts = String(now);
    const msg = canonicalMessage("GET", "/v1/me", ts, "");
    expect(await checkAndClaim(k.sign(msg), k.pub, canonicalMessage("GET", "/v1/me", ts, "x"), ts, "request", now, memStore())).toBe("rejected");
    expect(await checkAndClaim(k.sign(msg), other.pub, msg, ts, "request", now, memStore())).toBe("rejected");
    expect(await checkAndClaim(k.sign(msg), k.pub, msg, ts, "request", now + 301, memStore())).toBe("rejected");
    const broken: ReplayStore = { claim: () => { throw new Error("locked"); } };
    expect(await checkAndClaim(k.sign(msg), k.pub, msg, ts, "request", now, broken)).toBe("store_unavailable");
  });

  test("a version 2 approval signature is bound to its answer", async () => {
    const k = keypair();
    const now = Math.floor(Date.now() / 1000);
    const ts = String(now);
    const signedFor = enc(approvalMessage("q-1", "once", ts, true, "staging"));
    const sig = k.sign(signedFor);
    expect(await checkAndClaim(sig, k.pub, enc(approvalMessage("q-1", "once", ts, true, "production")), ts, "approval", now, memStore())).toBe("rejected");
    expect(await checkAndClaim(sig, k.pub, enc(approvalMessage("q-1", "once", ts, true, "staging")), ts, "approval", now, memStore())).toBe("valid");
    // A version 1 signature presented as version 2 does not verify.
    const v1 = k.sign(approvalMessage("q-2", "once", ts, false));
    expect(await checkAndClaim(v1, k.pub, enc(approvalMessage("q-2", "once", ts, true, "x")), ts, "approval", now, memStore())).toBe("rejected");
  });

  test("a claimed signature is still refused after the store is reopened", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mobile-"));
    const k = keypair();
    const now = Math.floor(Date.now() / 1000);
    const ts = String(now);
    const msg = canonicalMessage("GET", "/v1/me", ts, "");
    const sig = k.sign(msg);
    const first = new Store(dir);
    expect(await checkAndClaim(sig, k.pub, msg, ts, "request", now, new MobileStore(first))).toBe("valid");
    first.db.close();
    expect(await checkAndClaim(sig, k.pub, msg, ts, "request", now, new MobileStore(new Store(dir)))).toBe("rejected");
  });
});

describe("pairing", () => {
  test("a code pairs once and the pair limit keys on what the caller cannot choose", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mobile-"));
    const m = new MobileStore(new Store(dir));
    const code = m.createPairCode(600);
    expect(m.claimPairCode(code, "p", "a", "b", false)).not.toBeNull();
    expect(m.claimPairCode(code, "p", "a", "b", false)).toBeNull();
    expect(m.pairCodes()).toBe(0);

    const spoof = (n: number) => new Headers({ "cf-connecting-ip": `198.51.100.${n}`, "x-real-ip": `198.51.100.${n}`, "x-forwarded-for": `198.51.100.${n}, 10.0.0.1` });
    const lim = new PairLimiter();
    const now = 1_000_000;
    for (let n = 0; n < PAIR_FAILURES_PER_SOURCE; n++) {
      const src = requestSource(spoof(n), "203.0.113.9");
      expect(lim.blocked(src, now)).toBe(false);
      lim.fail(src, now);
    }
    expect(lim.blocked(requestSource(spoof(99), "203.0.113.9"), now)).toBe(true);
    expect(lim.blocked(requestSource(spoof(0), "203.0.113.10"), now)).toBe(false);
    expect(lim.blocked("203.0.113.9", now + 301)).toBe(false);

    expect(requestSource(spoof(7), "127.0.0.1")).toBe("198.51.100.7");
    const xff = new Headers({ "x-forwarded-for": "1.1.1.1, 192.0.2.44" });
    expect(requestSource(xff, "::1")).toBe("192.0.2.44");
    expect(requestSource(xff, "192.0.2.1")).toBe("192.0.2.1");
    expect(requestSource(new Headers(), "127.0.0.1")).toBe("127.0.0.1");
    expect(requestSource(xff, null)).toBe("unknown");

    // Through a tunnel each request can claim a new address; the total is bounded.
    const all = new PairLimiter();
    let blockedAt = -1;
    for (let n = 0; n < PAIR_FAILURES_TOTAL + 5; n++) {
      const src = requestSource(new Headers({ "cf-connecting-ip": `198.51.${n >> 8}.${n & 255}` }), "127.0.0.1");
      if (all.blocked(src, now)) { blockedAt = n; break; }
      all.fail(src, now);
    }
    expect(blockedAt).toBe(PAIR_FAILURES_TOTAL);
  });
});

describe("sync cursor", () => {
  test("is global, so a short session is not hidden behind a long one", () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "keel-mobile-")));
    const m = new MobileStore(store);
    const a = store.createSession({ model: "m", workspace: "/w", title: "long" });
    const b = store.createSession({ model: "m", workspace: "/w", title: "short" });
    for (let i = 0; i < 40; i++) store.append(a.id, "user", { text: `a${i}` });
    const first = m.eventsAfter(0, 2000);
    expect(first.length).toBe(40);
    const cursor = m.globalSeq();
    expect(cursor).toBe(first.at(-1)!.gseq);
    store.append(b.id, "user", { text: "b0" });
    store.append(a.id, "user", { text: "a40" });
    expect(m.eventsAfter(cursor, 2000).map((e) => e.data.text)).toEqual(["b0", "a40"]);
    expect(m.eventsAfter(m.globalSeq(), 2000)).toEqual([]);
  });
});
