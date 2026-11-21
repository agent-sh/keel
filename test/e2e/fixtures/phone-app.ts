// A stand-in for the phone app: it pairs with a one-time code and signs every
// request as the app does (METHOD, path and query, time, body hash; P-256).
import type { APIRequestContext } from "@playwright/test";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

export type Key = { priv: KeyObject; pub: string };
export const key = (): Key => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { priv: privateKey, pub: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
};
export const sig = (k: Key, msg: string) => sign("sha256", Buffer.from(msg), { key: k.priv, dsaEncoding: "der" }).toString("base64");
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

export class Phone {
  token = "";
  id = "";
  constructor(private http: APIRequestContext, readonly req = key(), readonly apr = key()) {}
  headers(method: string, path: string, body: string | Uint8Array, ts = String(Math.floor(Date.now() / 1000))) {
    return { authorization: `Bearer ${this.token}`, "x-hm-ts": ts, "x-hm-sig": sig(this.req, `${method}\n${path}\n${ts}\n${sha(body)}`), "content-type": "application/json" };
  }
  async call(method: "GET" | "POST" | "DELETE", path: string, data?: unknown, extra: Record<string, string> = {}) {
    const body = data === undefined ? "" : JSON.stringify(data);
    const headers = { ...this.headers(method, path, body), ...extra };
    return this.http.fetch(path, { method, headers, data: body || undefined });
  }
  // Raw bytes, as the app uploads a file.
  async upload(path: string, bytes: Uint8Array, mime: string) {
    return this.http.fetch(path, { method: "POST", headers: { ...this.headers("POST", path, bytes), "content-type": mime }, data: Buffer.from(bytes) });
  }
  // Pairs through the workbench's pairing route, as scanning its code does.
  async pair(name = "Stand-in phone") {
    const made = await (await this.http.post("/api/mobile/pair", { data: { public_url: "https://keel.example.test" } })).json();
    const r = await (await this.http.post("/v1/pair", { data: { code: made.code, pub: this.req.pub, apub: this.apr.pub, device_name: name, lock: true } })).json();
    this.token = r.token;
    this.id = r.device_id;
    return this;
  }
  // The event stream from a cursor: its frames as they arrive, and a way to cut it.
  async stream(base: string, since?: number) {
    const path = since === undefined ? "/v1/events" : `/v1/events?since=${since}`;
    const cut = new AbortController();
    const res = await fetch(`${base}${path}`, { headers: this.headers("GET", path, ""), signal: cut.signal });
    const frames: any[] = [];
    (async () => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body as any) {
        buf += dec.decode(chunk, { stream: true });
        for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) frames.push(JSON.parse(buf.slice(0, i).replace(/^data: /, "")));
      }
    })().catch(() => {});
    return { frames, status: res.status, close: () => cut.abort() };
  }
}
