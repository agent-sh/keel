// Secrets in prompts, commands and tool output. A secret is kept out of
// everything Keel stores, shows or sends to a provider: it is replaced by a
// placeholder `[secret:<8 hex>]` (or `[value of $NAME]` once it has a name).
// The value lives only in this process, for the sessions it belongs to; a tool
// call that names the placeholder runs with the value, and commands of the
// session get named secrets as environment variables. A restart forgets them.
import { createHmac, randomBytes } from "node:crypto";

export type SecretMeta = { id: string; kind: string; name?: string; source: Source; sessions: string[]; created: number; placeholder: string };
type Source = "prompt" | "output" | "card" | "command";
type Entry = { id: string; value: string; kind: string; name?: string; source: Source; sessions: Set<string>; created: number };

// Token formats with a fixed shape (gitleaks' rules, the common ones). The
// whole match is the secret unless the rule has a group.
export const RULES: { kind: string; re: RegExp }[] = [
  { kind: "private key", re: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S]{64,}?-----END[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: "AWS access key", re: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/g },
  { kind: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36}\b/g },
  { kind: "GitHub token", re: /\bgithub_pat_\w{82}\b/g },
  { kind: "GitLab token", re: /\bglpat-[\w-]{20}\b/g },
  { kind: "Anthropic key", re: /\bsk-ant-(?:api|admin)\d{2}-[\w-]{80,110}\b/g },
  { kind: "OpenAI key", re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "OpenAI key", re: /\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/g },
  { kind: "OpenRouter key", re: /\bsk-or-v1-[0-9a-f]{64}\b/g },
  { kind: "Google API key", re: /\bAIza[\w-]{35}\b/g },
  { kind: "Slack token", re: /\bxox[abposr]-(?:\d+-)?[0-9A-Za-z-]{10,}\b/g },
  { kind: "Slack webhook", re: /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}/g },
  { kind: "Stripe key", re: /\b(?:sk|rk)_(?:test|live|prod)_[0-9A-Za-z]{10,99}\b/g },
  { kind: "npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: "PyPI token", re: /\bpypi-AgEIcHlwaS5vcmc[\w-]{50,}\b/g },
  { kind: "Hugging Face token", re: /\bhf_[A-Za-z]{34}\b/g },
  { kind: "SendGrid key", re: /\bSG\.[\w-]{22}\.[\w-]{43}\b/g },
  { kind: "Twilio key", re: /\bSK[0-9a-fA-F]{32}\b/g },
  { kind: "Groq key", re: /\bgsk_[A-Za-z0-9]{52}\b/g },
  { kind: "xAI key", re: /\bxai-[A-Za-z0-9]{80}\b/g },
  { kind: "DigitalOcean token", re: /\bdo[opr]_v1_[a-f0-9]{64}\b/g },
  { kind: "JSON web token", re: /\bey[A-Za-z0-9]{17,}\.ey[A-Za-z0-9/_-]{17,}\.[A-Za-z0-9/_-]{10,}={0,2}/g },
  { kind: "password in a URL", re: /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{1,64}:([^\s:@/]{6,128})@[\w.-]+/g },
  { kind: "Authorization header", re: /\b(?:Authorization|Proxy-Authorization)\s*:\s*(?:Bearer|Basic|token)\s+([A-Za-z0-9._~+/=-]{16,})/gi },
];

// A value assigned to a secret-sounding name (`API_KEY=...`, `"password": "..."`),
// kept only when it looks random: letters and digits mixed, high entropy.
const ASSIGN = /\b[\w.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|passwd|pwd|credential|auth[_-]?key|private[_-]?key|access[_-]?key)[\w.-]*["']?\s*(?:=|:|:=|=>)\s*["']?([A-Za-z0-9_\-+/=.~!@#$%^&*]{12,200})["']?/gi;

export function entropy(s: string): number {
  const n = new Map<string, number>();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const k of n.values()) h -= (k / s.length) * Math.log2(k / s.length);
  return h;
}
const looksRandom = (v: string) => v.length >= 12 && /[A-Za-z]/.test(v) && /\d/.test(v) && entropy(v) >= 3.5 && !/^(?:true|false|null|undefined)$/i.test(v);

export type Hit = { start: number; end: number; value: string; kind: string };

// Every secret in the text, longest first where they overlap.
export function detect(text: string): Hit[] {
  if (text.length < 12) return [];
  const hits: Hit[] = [];
  const take = (m: RegExpExecArray, kind: string) => {
    const g = m[1];
    const start = g ? m.index + m[0].indexOf(g) : m.index;
    const value = g ?? m[0];
    if (!value.startsWith("[secret:") && !value.startsWith("[value")) hits.push({ start, end: start + value.length, value, kind });
  };
  for (const r of RULES) for (const m of text.matchAll(r.re)) take(m as RegExpExecArray, r.kind);
  for (const m of text.matchAll(ASSIGN)) if (looksRandom(m[1]!) && !/^\$|\$\{|\$\(/.test(m[1]!)) take(m as RegExpExecArray, "secret value");
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Hit[] = [];
  for (const h of hits) if (!out.length || h.start >= out.at(-1)!.end) out.push(h);
  return out;
}

const KEY = randomBytes(32);
const PLACE = /\[secret:([0-9a-f]{8})\]|\[value of \$([A-Za-z_][A-Za-z0-9_]*)\]/g;
const RESERVED = /^(PATH|HOME|USER|SHELL|PWD|OLDPWD|TERM|LANG|LC_\w*|TZ|TMPDIR|IFS|PS\d|BASH_ENV|ENV|BASH_\w*|LD_\w*|DYLD_\w*|GIT_\w*|SSH_\w*|PYTHON\w*|NODE_OPTIONS|NODE_PATH|PERL5\w*|RUBY\w*|KEEL_\w*|XDG_\w*|DISPLAY|WAYLAND_\w*|DBUS_\w*)$/;

export const nameError = (name: string): string | null =>
  !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) ? "a name is letters, digits and _, not starting with a digit"
    : RESERVED.test(name) ? `${name} decides how commands start; pick another name` : null;

type Listener = (ev: { type: "found"; session_id: string; secret: SecretMeta } | { type: "changed"; secret: SecretMeta } | { type: "forgotten"; id: string }) => void;

export class Vault {
  private byValue = new Map<string, Entry>();
  private byId = new Map<string, Entry>();
  private listeners = new Set<Listener>();
  // A child session (a subagent, a reviewer) may use its parent's secrets.
  parentOf: (sessionId: string) => string | null | undefined = () => null;

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  private tell(ev: Parameters<Listener>[0]) {
    for (const l of this.listeners) try { l(ev); } catch {}
  }

  placeholder = (e: Pick<Entry, "id" | "name">) => (e.name ? `[value of $${e.name}]` : `[secret:${e.id}]`);
  meta = (e: Entry): SecretMeta => ({ id: e.id, kind: e.kind, name: e.name, source: e.source, sessions: [...e.sessions], created: e.created, placeholder: this.placeholder(e) });

  list(sessionId?: string): SecretMeta[] {
    return [...this.byId.values()].filter((e) => !sessionId || this.holds(e, sessionId)).map(this.meta);
  }

  // Keep a value: the same value is the same entry for the life of the process.
  add(value: string, kind: string, source: Source, sessionId: string | null, name?: string): Entry {
    let e = this.byValue.get(value);
    const fresh = !e;
    if (!e) {
      const id = createHmac("sha256", KEY).update(value).digest("hex").slice(0, 8);
      e = { id, value, kind, source, sessions: new Set(), created: Date.now(), name };
      this.byValue.set(value, e);
      this.byId.set(id, e);
    }
    if (name && !e.name) e.name = name;
    const joined = sessionId && !e.sessions.has(sessionId);
    if (sessionId) e.sessions.add(sessionId);
    if (sessionId && (fresh || joined)) this.tell({ type: "found", session_id: sessionId, secret: this.meta(e) });
    return e;
  }

  rename(id: string, name: string | null): SecretMeta {
    const e = this.byId.get(id);
    if (!e) throw Object.assign(new Error("no such secret (a restart forgets them)"), { status: 404 });
    if (name) {
      const err = nameError(name);
      if (err) throw Object.assign(new Error(err), { status: 400 });
      for (const o of this.byId.values()) if (o !== e && o.name === name && [...o.sessions].some((s) => e.sessions.has(s))) o.name = undefined;
    }
    e.name = name || undefined;
    this.tell({ type: "changed", secret: this.meta(e) });
    return this.meta(e);
  }

  forget(id: string): boolean {
    const e = this.byId.get(id);
    if (!e) return false;
    this.byId.delete(id);
    this.byValue.delete(e.value);
    this.tell({ type: "forgotten", id });
    return true;
  }

  forgetSession(sessionId: string) {
    for (const e of [...this.byId.values()]) {
      e.sessions.delete(sessionId);
      if (!e.sessions.size) this.forget(e.id);
    }
  }

  private holds(e: Entry, sessionId: string): boolean {
    for (let s: string | null | undefined = sessionId, n = 0; s && n < 8; s = this.parentOf(s), n++) if (e.sessions.has(s)) return true;
    return false;
  }

  // Text with every known value and every newly found secret replaced.
  redact(text: string, sessionId: string | null, source: Source): string {
    if (!text) return text;
    let out = text;
    // Known values first (longest first, so a value inside another stays whole).
    if (this.byValue.size) {
      const known = [...this.byValue.values()].filter((e) => out.includes(e.value)).sort((a, b) => b.value.length - a.value.length);
      for (const e of known) {
        out = out.split(e.value).join(this.placeholder(e));
        if (sessionId && !e.sessions.has(sessionId)) this.add(e.value, e.kind, source, sessionId);
      }
    }
    // Text cut short (a title) can end in the first part of a known value.
    for (const e of this.byValue.values()) {
      for (let n = Math.min(e.value.length - 1, out.length); n >= 8; n--) {
        if (out.endsWith(e.value.slice(0, n))) { out = out.slice(0, -n) + this.placeholder(e); break; }
      }
    }
    const hits = detect(out);
    if (!hits.length) return out;
    let r = "";
    let at = 0;
    for (const h of hits) {
      const e = this.add(h.value, h.kind, source, sessionId);
      r += out.slice(at, h.start) + this.placeholder(e);
      at = h.end;
    }
    return r + out.slice(at);
  }

  // A JSON value with every string redacted, except what must stay byte-exact
  // (images, provider signatures and opaque reasoning).
  redactDeep<T>(v: T, sessionId: string | null, source: Source): T {
    const walk = (x: any, key?: string): any => {
      if (typeof x === "string") return key === "data" || key === "signature" || key === "opaque" ? x : this.redact(x, sessionId, source);
      if (Array.isArray(x)) {
        let changed = false;
        const a = x.map((y) => { const z = walk(y); if (z !== y) changed = true; return z; });
        return changed ? a : x;
      }
      if (x && typeof x === "object") {
        if (x.type === "thinking" || x.type === "redacted_thinking" || x.type === "image") return x;
        let changed = false;
        const o: any = {};
        for (const [k, y] of Object.entries(x)) { const z = walk(y, k); if (z !== y) changed = true; o[k] = z; }
        return changed ? o : x;
      }
      return x;
    };
    return walk(v);
  }

  // A tool input with the placeholders of the session's secrets put back.
  reveal<T>(v: T, sessionId: string): { value: T; used: string[] } {
    const used: string[] = [];
    const sub = (s: string) => s.replace(PLACE, (m, id: string | undefined, name: string | undefined) => {
      const e = id ? this.byId.get(id) : [...this.byId.values()].find((x) => x.name === name && this.holds(x, sessionId));
      if (!e || !this.holds(e, sessionId)) return m;
      used.push(e.id);
      return e.value;
    });
    const walk = (x: any): any =>
      typeof x === "string" ? sub(x) : Array.isArray(x) ? x.map(walk) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])) : x;
    return { value: walk(v), used };
  }

  // Named secrets of the session, for the environment of its commands.
  env(sessionId: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const e of this.byId.values()) if (e.name && this.holds(e, sessionId)) env[e.name] = e.value;
    return env;
  }
}

export const vault = new Vault();
