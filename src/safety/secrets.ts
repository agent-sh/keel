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
// Tool input fields that describe a call to the owner and run nothing.
// The fields of a shell tool that hold its script.
export const SHELL_FIELDS: ReadonlySet<string> = new Set(["command", "cmd"]);
const PLACE = /\[secret:([0-9a-f]{8})\]|\[value of \$([A-Za-z_][A-Za-z0-9_]*)\]/g;
const PLACE_AT = new RegExp(PLACE.source, "y");
const RESERVED = /^(PATH|HOME|USER|SHELL|PWD|OLDPWD|TERM|LANG|LC_\w*|TZ|TMPDIR|IFS|PS\d|BASH_ENV|ENV|BASH_\w*|LD_\w*|DYLD_\w*|GIT_\w*|SSH_\w*|PYTHON\w*|NODE_OPTIONS|NODE_PATH|PERL5\w*|RUBY\w*|KEEL_\w*|XDG_\w*|DISPLAY|WAYLAND_\w*|DBUS_\w*)$/;

export const nameError = (name: string): string | null =>
  !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) ? "a name is letters, digits and _, not starting with a digit"
    : RESERVED.test(name) ? `${name} decides how commands start; pick another name` : null;

type Listener = (ev: { type: "found"; session_id: string; secret: SecretMeta } | { type: "changed"; secret: SecretMeta } | { type: "forgotten"; id: string }) => void;

// A shell script with each placeholder replaced by a reference to the
// variable `name` returns, quoted for where it stands: bare text and $( )
// get "${V}", a double-quoted string ${V}, a single-quoted one closes and
// reopens around "${V}" (an $'...' string reopens as $'). The body of a
// heredoc whose word is unquoted (<<EOF) expands variables but takes quotes
// as text: it gets ${V}. A quoted heredoc (<<'EOF') expands nothing, so no
// reference can stand there: its placeholders stay as written and `stuck`
// hears of each. A placeholder `name` returns null for stays as written.
export function shellRefs(text: string, name: (id: string | undefined, varName: string | undefined) => string | null, stuck?: (placeholder: string) => void): string {
  type Ctx = "top" | "sq" | "ansi" | "dq" | "sub";
  const stack: Ctx[] = ["top"];
  // Heredocs opened on the current line: their bodies start at its end.
  const pending: { word: string; quoted: boolean; tabs: boolean }[] = [];
  let out = "";
  const ref = (i: number): { len: number; v: string | null; raw: string } | null => {
    PLACE_AT.lastIndex = i;
    const m = PLACE_AT.exec(text);
    return m ? { len: m[0].length, v: name(m[1], m[2]), raw: m[0] } : null;
  };
  for (let i = 0; i < text.length;) {
    const ctx = stack.at(-1)!;
    if (text[i] === "[") {
      const r = ref(i);
      if (r?.v) {
        out += ctx === "dq" ? `\${${r.v}}` : ctx === "sq" ? `'"\${${r.v}}"'` : ctx === "ansi" ? `'"\${${r.v}}"$'` : `"\${${r.v}}"`;
        i += r.len;
        continue;
      }
    }
    const c = text[i]!;
    if (ctx === "sq") { if (c === "'") stack.pop(); out += c; i++; continue; }
    if (ctx === "ansi") { if (c === "\\") { out += text.slice(i, i + 2); i += 2; continue; } if (c === "'") stack.pop(); out += c; i++; continue; }
    if (c === "\\") { out += text.slice(i, i + 2); i += 2; continue; }
    if (ctx === "dq") {
      if (c === '"') stack.pop();
      else if (c === "$" && text[i + 1] === "(") { stack.push("sub"); out += "$("; i += 2; continue; }
      out += c; i++; continue;
    }
    // A heredoc operator (not <<<): its word, quoted in any part or not.
    if (c === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
      const h = /^<<(-?)[ \t]*((?:'[^'\n]*'|"[^"\n]*"|\\.|[^\s;&|<>()])+)/.exec(text.slice(i));
      if (h) {
        pending.push({ word: h[2]!.replace(/'([^']*)'|"([^"]*)"|\\(.)/g, "$1$2$3"), quoted: /['"\\]/.test(h[2]!), tabs: h[1] === "-" });
        out += h[0];
        i += h[0].length;
        continue;
      }
    }
    // The end of a line with heredocs open: their bodies, line by line, up to each word.
    if (c === "\n" && pending.length) {
      out += c;
      i++;
      for (const d of pending.splice(0)) {
        while (i < text.length) {
          const end = text.indexOf("\n", i);
          const line = text.slice(i, end < 0 ? text.length : end);
          if ((d.tabs ? line.replace(/^\t+/, "") : line) === d.word) { out += line; i += line.length; if (end >= 0) { out += "\n"; i++; } break; }
          let body = "";
          for (let j = 0; j < line.length;) {
            if (line[j] === "[") {
              const r = ref(i + j);
              if (r) {
                if (r.v && !d.quoted) body += `\${${r.v}}`;
                else { if (r.v && d.quoted) stuck?.(r.raw); body += r.raw; }
                j += r.len;
                continue;
              }
            }
            body += line[j];
            j++;
          }
          out += body;
          i += line.length;
          if (end >= 0) { out += "\n"; i++; }
        }
      }
      continue;
    }
    // top or inside $( ): quotes open, a ( nests, a ) closes a $(.
    if (c === "'") stack.push("sq");
    else if (c === '"') stack.push("dq");
    else if (c === "$" && text[i + 1] === "'") { stack.push("ansi"); out += "$'"; i += 2; continue; }
    else if (c === "$" && text[i + 1] === "(") { stack.push("sub"); out += "$("; i += 2; continue; }
    else if (c === "(" && ctx === "sub") stack.push("sub");
    else if (c === ")" && ctx === "sub") stack.pop();
    out += c; i++;
  }
  return out;
}

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

  // A shell tool's input with its script fields' placeholders made quoted
  // references to variables set on the child process only (`env`), so the
  // value arrives byte for byte and is never spliced into the script's syntax.
  // Only those fields: a command is where a credential is used. Every other
  // field and tool keeps the placeholder (an internal tool would store the
  // value, a model-consulting one would send it to a model).
  // `stuck`: placeholders of known secrets where no reference can stand (a quoted heredoc).
  reveal<T extends Record<string, unknown>>(v: T, sessionId: string, shell: ReadonlySet<string>): { value: T; used: string[]; env: Record<string, string>; stuck: string[] } {
    const used: string[] = [];
    const env: Record<string, string> = {};
    const stuck: string[] = [];
    const find = (id: string | undefined, name: string | undefined) => {
      const e = id ? this.byId.get(id) : [...this.byId.values()].find((x) => x.name === name && this.holds(x, sessionId));
      return e && this.holds(e, sessionId) ? e : undefined;
    };
    if (!v || typeof v !== "object") return { value: v, used, env, stuck };
    const out: Record<string, unknown> = { ...v };
    for (const k of shell) {
      const y = v[k];
      if (typeof y !== "string") continue;
      out[k] = shellRefs(y, (id, name) => {
        const e = find(id, name);
        if (!e) return null;
        used.push(e.id);
        env[`KEEL_SECRET_${e.id}`] = e.value;
        return `KEEL_SECRET_${e.id}`;
      }, (p) => stuck.push(p));
    }
    return { value: (used.length ? out : v) as T, used, env, stuck };
  }

  // Every known value in a request's messages replaced by its placeholder,
  // nothing else looked for: the last check on what is sent to a provider.
  // Every string is masked, at any depth, except the provider's own bytes at
  // their known places: an image's or document's data, a signed thinking block
  // (its text, signature and opaque item), a redacted thinking block's data
  // and a tool call's signature. What holds no known value is returned as it
  // is (the same objects, the same bytes).
  mask<T>(messages: T): T {
    if (!this.byValue.size) return messages;
    const known = [...this.byValue.values()].sort((a, b) => b.value.length - a.value.length);
    const str = (x: string) => {
      let out = x;
      for (const e of known) if (out.includes(e.value)) out = out.split(e.value).join(this.placeholder(e));
      return out;
    };
    // Any JSON value, every string in it.
    const all = (x: any): any => {
      if (typeof x === "string") return str(x);
      if (Array.isArray(x)) { let c = false; const a = x.map((y) => { const z = all(y); if (z !== y) c = true; return z; }); return c ? a : x; }
      if (x && typeof x === "object") { let c = false; const o: any = {}; for (const [k, y] of Object.entries(x)) { const z = all(y); if (z !== y) c = true; o[k] = z; } return c ? o : x; }
      return x;
    };
    // An object with some of its own fields left as they are.
    const except = (x: any, keep: string[]) => {
      let c = false;
      const o: any = {};
      for (const [k, y] of Object.entries(x)) { const z = keep.includes(k) ? y : all(y); if (z !== y) c = true; o[k] = z; }
      return c ? o : x;
    };
    const block = (b: any): any => {
      if (!b || typeof b !== "object" || Array.isArray(b)) return all(b);
      switch (b.type) {
        case "image": case "document": return except(b, ["data"]);
        case "thinking": return b.signature || b.opaque ? b : except(b, []);
        case "redacted_thinking": return except(b, ["data"]);
        case "tool_use": return except(b, ["signature"]);
        case "tool_result": {
          const o = except(b, ["content"]);
          const content = Array.isArray(b.content) ? b.content.map(block) : all(b.content);
          const moved = Array.isArray(b.content) ? content.some((y: any, k: number) => y !== b.content[k]) : content !== b.content;
          return o === b && !moved ? b : { ...o, content: moved ? content : b.content };
        }
        default: return all(b);
      }
    };
    if (!Array.isArray(messages)) return all(messages);
    let changed = false;
    const out = (messages as any[]).map((m) => {
      if (!m || typeof m !== "object" || !Array.isArray(m.content)) { const z = all(m); if (z !== m) changed = true; return z; }
      const content = m.content.map(block);
      const same = content.every((y: any, k: number) => y === m.content[k]);
      if (same) return m;
      changed = true;
      return { ...m, content };
    });
    return (changed ? out : messages) as T;
  }

  // A tool input bound for another machine: each placeholder of this
  // session's secrets in its named form, never the value. That machine puts
  // back a secret it holds under the same name (resolveNamed); a secret with
  // no name cannot be matched there and is refused.
  forPeer<T>(v: T, sessionId: string): { value: T; names: string[] } | { error: string } {
    const names = new Set<string>();
    const unnamed: string[] = [];
    const sub = (s: string) => s.replace(PLACE, (m, id: string | undefined, name: string | undefined) => {
      const e = id ? this.byId.get(id) : [...this.byId.values()].find((x) => x.name === name && this.holds(x, sessionId));
      if (!e || !this.holds(e, sessionId)) return m;
      if (!e.name) { unnamed.push(m); return m; }
      names.add(e.name);
      return this.placeholder(e);
    });
    const walk = (x: any): any => typeof x === "string" ? sub(x) : Array.isArray(x) ? x.map(walk) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])) : x;
    const value = walk(v);
    if (unnamed.length) return { error: `${[...new Set(unnamed)].join(", ")} has no name, so another machine cannot hold it: name it, give it to that machine under the same name, and call again` };
    return { value, names: [...names] };
  }

  // On the machine a call was sent to: its shell fields' named placeholders
  // resolved against the secrets this daemon holds under those names, as
  // quoted variable references with the values in `env`. A name this daemon
  // does not hold (or holds twice, with two values) is refused by name.
  resolveNamed<T extends Record<string, unknown>>(v: T, shell: ReadonlySet<string>): { value: T; env: Record<string, string> } | { missing: string[]; ambiguous: string[] } {
    const env: Record<string, string> = {};
    const missing = new Set<string>(), ambiguous = new Set<string>();
    if (!v || typeof v !== "object") return { value: v, env };
    const out: Record<string, unknown> = { ...v };
    for (const k of shell) {
      const y = v[k];
      if (typeof y !== "string") continue;
      out[k] = shellRefs(y, (_id, name) => {
        if (!name) return null;
        const all = [...this.byId.values()].filter((x) => x.name === name);
        if (!all.length) { missing.add(name); return null; }
        if (all.length > 1) { ambiguous.add(name); return null; }
        env[`KEEL_SECRET_${all[0]!.id}`] = all[0]!.value;
        return `KEEL_SECRET_${all[0]!.id}`;
      }, (p) => missing.add(`${p.match(/\$(\w+)/)?.[1] ?? p} (inside a quoted heredoc, where nothing expands)`));
    }
    if (missing.size || ambiguous.size) return { missing: [...missing], ambiguous: [...ambiguous] };
    return { value: out as T, env };
  }

  // Every known value with its placeholder (a stream filter replaces them).
  pairs(): [string, string][] {
    return [...this.byValue.values()].map((e) => [e.value, this.placeholder(e)]);
  }

  // Named secrets of the session, for the environment of its commands.
  env(sessionId: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const e of this.byId.values()) if (e.name && this.holds(e, sessionId)) env[e.name] = e.value;
    return env;
  }
}

export const vault = new Vault();
