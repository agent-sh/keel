// Mail and calendar sources for the helper. A source is anything with this
// shape; Google (Gmail and Calendar over their REST APIs) is the one built
// in, and a stand-in reads a folder of JSON for the e2e. Other integrations
// the owner has as MCP servers reach the helper as they reach every session.
//
// The Google source uses an OAuth token file the owner already has, in place:
// it reads the refresh token, keeps the short-lived access token in memory
// and never writes, prints or copies the file.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type MailMsg = { id: string; thread_id: string; from: string; to?: string; subject: string; date: string; snippet: string; labels: string[]; body?: string; message_id?: string };
export type Outgoing = { to: string; cc?: string; subject: string; body: string; thread_id?: string; in_reply_to?: string };
export type CalEvent = { id: string; summary: string; start: string; end: string; location?: string; attendees?: number };
export type MailSource = {
  id: string;
  label: string;
  available(): boolean;
  account(): string | undefined;
  can: { modify: boolean; send: boolean; calendar: boolean };
  search(q: string, max: number): Promise<MailMsg[]>;
  read(id: string): Promise<MailMsg>;
  modify(id: string, add: string[], remove: string[]): Promise<void>;
  send(m: Outgoing): Promise<{ id: string }>;
  events(fromIso: string, toIso: string, max: number): Promise<CalEvent[]>;
  // The account's own labels (id and name), for keeping their names in memory.
  labels?(): Promise<{ id: string; name: string }[]>;
};

const BODY_CHARS = 12_000;
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");
const header = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`);
const oneLine = (v: string) => v.replace(/[\r\n]+/g, " ").trim();

// The message as RFC 5322 text: plain UTF-8, the account's own From.
export function rfc822(m: Outgoing): string {
  const h = [`To: ${oneLine(m.to)}`, ...(m.cc ? [`Cc: ${oneLine(m.cc)}`] : []), `Subject: ${header(oneLine(m.subject))}`,
    ...(m.in_reply_to ? [`In-Reply-To: ${oneLine(m.in_reply_to)}`, `References: ${oneLine(m.in_reply_to)}`] : []),
    "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"];
  return `${h.join("\r\n")}\r\n\r\n${Buffer.from(m.body, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n")}`;
}

function bodyOf(part: any): string {
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (p: any) => {
    if (!p) return;
    if (p.body?.data && p.mimeType === "text/plain") plain.push(unb64(p.body.data));
    else if (p.body?.data && p.mimeType === "text/html") html.push(unb64(p.body.data));
    for (const c of p.parts ?? []) walk(c);
  };
  walk(part);
  const text = plain.length ? plain.join("\n") : html.join("\n").replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ");
  const t = text.replace(/\n{3,}/g, "\n\n").trim();
  return t.length > BODY_CHARS ? `${t.slice(0, BODY_CHARS)}\n[... ${t.length - BODY_CHARS} more characters]` : t;
}

const toMsg = (m: any, withBody: boolean): MailMsg => {
  const hs = Object.fromEntries((m.payload?.headers ?? []).map((h: any) => [String(h.name).toLowerCase(), String(h.value)]));
  return {
    id: m.id, thread_id: m.threadId, from: hs.from ?? "", to: hs.to, subject: hs.subject ?? "(no subject)", date: hs.date ?? "",
    snippet: m.snippet ?? "", labels: m.labelIds ?? [], message_id: hs["message-id"], ...(withBody ? { body: bodyOf(m.payload) } : {}),
  };
};

type TokenFile = { client_id?: string; client_secret?: string; refresh_token?: string; token_uri?: string; account?: string; scopes?: string[] };

export class GoogleSource implements MailSource {
  id = "google";
  label = "Gmail and Calendar";
  private access: { token: string; until: number } | null = null;
  constructor(readonly path: string) {}

  private file(): TokenFile | null {
    try { return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as TokenFile) : null; } catch { return null; }
  }
  available() {
    const f = this.file();
    return !!(f?.refresh_token && f.client_id && f.client_secret);
  }
  account() {
    return this.file()?.account || undefined;
  }
  get can() {
    const s = this.file()?.scopes ?? [];
    const has = (x: string) => s.some((v) => v.endsWith(`/auth/${x}`));
    return { modify: has("gmail.modify"), send: has("gmail.send") || has("gmail.modify"), calendar: has("calendar") || has("calendar.readonly") || has("calendar.events") };
  }

  private async token(): Promise<string> {
    if (this.access && this.access.until > Date.now() + 60_000) return this.access.token;
    const f = this.file();
    if (!f?.refresh_token || !f.client_id || !f.client_secret) throw new Error(`no Google sign-in at ${this.path}`);
    const r = await fetch(f.token_uri || "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: f.client_id, client_secret: f.client_secret, refresh_token: f.refresh_token, grant_type: "refresh_token" }),
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok || !j.access_token) throw new Error(`Google sign-in refresh failed (${r.status}): ${j.error_description ?? j.error ?? "no token"}`);
    this.access = { token: j.access_token, until: Date.now() + Number(j.expires_in ?? 3000) * 1000 };
    return this.access.token;
  }

  private async api(url: string, init: RequestInit = {}): Promise<any> {
    const r = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${await this.token()}`, "content-type": "application/json" }, signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    if (!r.ok) {
      let msg = text.slice(0, 300);
      try { msg = JSON.parse(text).error?.message ?? msg; } catch {}
      throw new Error(`Google API ${r.status}: ${msg}`);
    }
    return text ? JSON.parse(text) : {};
  }

  async search(q: string, max: number): Promise<MailMsg[]> {
    const G = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
    const list = await this.api(`${G}?${new URLSearchParams({ q, maxResults: String(Math.min(50, Math.max(1, max))) })}`);
    const ids: string[] = (list.messages ?? []).map((m: any) => m.id);
    const meta = "format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=Message-ID";
    return Promise.all(ids.map(async (id) => toMsg(await this.api(`${G}/${id}?${meta}`), false)));
  }
  async read(id: string) {
    return toMsg(await this.api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`), true);
  }
  async labels() {
    const r = await this.api("https://gmail.googleapis.com/gmail/v1/users/me/labels");
    return (r.labels ?? []).filter((l: any) => l.type === "user" && l.id && l.name).map((l: any) => ({ id: String(l.id), name: String(l.name) }));
  }
  async modify(id: string, add: string[], remove: string[]) {
    await this.api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}/modify`, { method: "POST", body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }) });
  }
  async send(m: Outgoing) {
    const r = await this.api("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", body: JSON.stringify({ raw: b64url(rfc822(m)), ...(m.thread_id ? { threadId: m.thread_id } : {}) }) });
    return { id: String(r.id) };
  }
  async events(fromIso: string, toIso: string, max: number) {
    const q = new URLSearchParams({ timeMin: fromIso, timeMax: toIso, singleEvents: "true", orderBy: "startTime", maxResults: String(Math.min(100, Math.max(1, max))) });
    const r = await this.api(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`);
    return (r.items ?? []).map((e: any) => ({ id: e.id, summary: e.summary ?? "(no title)", start: e.start?.dateTime ?? e.start?.date ?? "", end: e.end?.dateTime ?? e.end?.date ?? "", location: e.location, attendees: e.attendees?.length }));
  }
}

// The e2e's stand-in: inbox.json in a folder (a list of messages), sends
// appended to outbox.jsonl there. Nothing leaves the machine.
export class StandinSource implements MailSource {
  id = "standin";
  label = "Mail stand-in (test)";
  can = { modify: true, send: true, calendar: true };
  constructor(readonly dir: string) { mkdirSync(dir, { recursive: true }); }
  private inbox(): MailMsg[] {
    try { return JSON.parse(readFileSync(join(this.dir, "inbox.json"), "utf8")); } catch { return []; }
  }
  available() { return true; }
  account() { return "owner@example.com"; }
  async search(q: string, max: number) {
    const words = q.toLowerCase().split(/\s+/).filter((w) => w && !w.includes(":"));
    return this.inbox().filter((m) => words.every((w) => `${m.from} ${m.subject} ${m.snippet}`.toLowerCase().includes(w))).slice(0, max).map(({ body: _, ...m }) => m);
  }
  async labels() {
    try { return JSON.parse(readFileSync(join(this.dir, "labels.json"), "utf8")) as { id: string; name: string }[]; } catch { return []; }
  }
  async read(id: string) {
    const m = this.inbox().find((x) => x.id === id);
    if (!m) throw new Error(`no message ${id}`);
    return m;
  }
  async modify(id: string, add: string[], remove: string[]) {
    appendFileSync(join(this.dir, "modified.jsonl"), JSON.stringify({ id, add, remove }) + "\n");
  }
  async send(m: Outgoing) {
    const id = `sent-${Date.now()}`;
    appendFileSync(join(this.dir, "outbox.jsonl"), JSON.stringify({ id, ...m }) + "\n");
    return { id };
  }
  async events() {
    return [{ id: "ev1", summary: "Standup", start: new Date(Date.now() + 3600_000).toISOString(), end: new Date(Date.now() + 5400_000).toISOString() }];
  }
}

// The source this daemon uses: the stand-in when KEEL_MAIL_STANDIN names a
// folder (scripts/dev.sh sets one, so a scratch daemon never reads real
// mail), else the Google token file (KEEL_GOOGLE_TOKEN, by default the one
// Hermes keeps).
export function mailSource(env = process.env): MailSource {
  if (env.KEEL_MAIL_STANDIN) return new StandinSource(env.KEEL_MAIL_STANDIN);
  return new GoogleSource(env.KEEL_GOOGLE_TOKEN || join(env.HOME ?? "", ".hermes/google_token.json"));
}
