// Secret values kept out of what is written outside the Store: job sidecars and
// logs, spill files, trace rows. The secrets feature registers the redactor
// (src/server/routes/secrets.ts); without it text passes through unchanged.
import { credentialName, detect, entropy } from "../safety/secrets.ts";

export type Concealer = {
  // Text with every known secret value (and anything that looks like one) as its placeholder.
  text(s: string, sessionId: string | null): string;
  // The known values and their placeholders, for a stream filtered outside the daemon.
  pairs(): [value: string, placeholder: string][];
};

let current: Concealer | null = null;
export const setConcealer = (c: Concealer) => void (current = c);
export const conceal = (s: string, sessionId: string | null = null): string => (current && s ? current.text(s, sessionId) : s);
// Every string of a JSON value concealed (a record written to disk or sent whole).
export function concealDeep<T>(v: T, sessionId: string | null = null): T {
  if (!current) return v;
  const walk = (x: any): any =>
    typeof x === "string" ? conceal(x, sessionId) : Array.isArray(x) ? x.map(walk) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])) : x;
  return walk(v);
}
export const secretPairs = (): [string, string][] => current?.pairs() ?? [];

// Anything shaped like a credential, whoever's it is and whether or not Keel
// knows it. This runs on text that is read (a failure's line, a sample, a
// notice to a model, the log), so it must hide a key and leave ordinary text
// alone: a file name, a hash, an id, `key=value` in a sentence. Two passes:
// the vault's own detection (exact token formats, a password in a URL, an
// Authorization header, a private key, a random value assigned to a
// credential's name: src/safety/secrets.ts), then the common prefixes in a
// looser length, for a key the exact formats miss (a cut one, a new format).
// A prefix counts only in its real form after a word boundary (`sk-`, not any
// word that starts "sk"), and a `key=` only as a name of its own with a value
// that mixes letters and digits.
const KEY_SHAPES = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abposr]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}\b|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;
// `sk-`, `xai-` and `AIza` also open ordinary names (sk-learn-notebooks-2026): a key has a
// run of ten or more letters and digits mixed between its hyphens, a name has words and a number.
const PREFIXED = /\b(?:sk-|xai-|AIza)[A-Za-z0-9_-]{16,}/g;
const mixedRun = (m: string) => m.split("-").some((seg) => seg.length >= 10 && /[A-Za-z]/.test(seg) && /\d/.test(seg));
const BEARER = /(\bbearer\s+)(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{12,}/gi;
const NAMED = /(?<![\w-])((?:(?:x-)?api[_-]?key|key|(?:access|auth|id|refresh)[_-]?token|token|secret|password|passwd|sig|signature)=)(?=[^&\s"']*[A-Za-z])(?=[^&\s"']*\d)[^&\s"']{8,}/gi;
// A random value given to a credential's name, whatever follows it (the vault's rule wants the
// value to end at a space or a quote, since its placeholder is sent again; a failure's line
// goes on with a colon or a comma: `SECRET_KEY = abc123...: rejected`). The name decides, as there.
const ASSIGNED = /(?<![\w.-])([A-Za-z_][\w.-]*)(["']?[ \t]*(?:=>|:=|=|:)[ \t]*["']?)([A-Za-z0-9_\-+/.~!@#%^*]{12,200}={0,3})/g;
const randomValue = (v: string) => /[A-Za-z]/.test(v) && /\d/.test(v) && entropy(v) >= 3.5 && !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(v);
function assigned(text: string): string {
  const re = new RegExp(ASSIGNED.source, "g");
  let out = "", from = 0;
  for (let m: RegExpExecArray | null; (m = re.exec(text));) {
    // A candidate that is not one gives its text back: the next may start inside it.
    if (!credentialName(m[1]!) || !randomValue(m[3]!)) { re.lastIndex = m.index + 1; continue; }
    out += text.slice(from, m.index) + m[1] + m[2] + HIDDEN;
    from = m.index + m[0].length;
  }
  return out + text.slice(from);
}
const HIDDEN = "<redacted>";
export function keyShaped(text: string): string {
  if (!text) return text;
  let out = text;
  const hits = detect(text);
  for (let i = hits.length - 1; i >= 0; i--) out = out.slice(0, hits[i]!.start) + HIDDEN + out.slice(hits[i]!.end);
  return assigned(out).replace(BEARER, `$1${HIDDEN}`).replace(NAMED, `$1${HIDDEN}`).replace(KEY_SHAPES, HIDDEN).replace(PREFIXED, (m) => (mixedRun(m) ? HIDDEN : m));
}
// The one scrub of what is stored about a failure (an error row, a span's
// error, a failure's sample, a tool's failure line), applied where it is
// captured: the known secrets as their placeholders, then anything else that
// is shaped like a key. So no notice, list or bundle made from those rows can
// carry one.
export const scrubbed = (text: string, sessionId: string | null = null): string => (text ? keyShaped(conceal(text, sessionId)) : text);
// The same for a line of the log. It teaches the vault nothing (the vault's own redaction
// issues a placeholder for what it finds, and a log line is no place to learn a secret from):
// the values it already knows become their placeholders, anything else key-shaped is hidden.
export function scrubbedLine(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [value, placeholder] of secretPairs()) if (value.length >= 8 && out.includes(value)) out = out.split(value).join(placeholder);
  return keyShaped(out);
}
export function keyShapedDeep<T>(v: T): T {
  const walk = (x: any): any =>
    typeof x === "string" ? keyShaped(x) : Array.isArray(x) ? x.map(walk) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])) : x;
  return walk(v);
}

// A byte stream with known values replaced as it passes, a value split across
// chunks included: only the end of a chunk that could start a value is held
// back until the next chunk (or the end) says what it is. Self-contained (it
// runs as the source of a filter process too, see jobs.ts).
export function streamConcealer(pairs: [string, string][]) {
  const list = pairs.map(([v, p]) => [Buffer.from(v).toString("latin1"), Buffer.from(p).toString("latin1")] as const).filter(([v]) => v.length > 0);
  let held = "";
  const swap = (s: string) => {
    for (const [v, p] of [...list].sort((a, b) => b[0].length - a[0].length)) s = s.split(v).join(p);
    return s;
  };
  // The longest end of s that is the start of some value.
  const pending = (s: string) => {
    let keep = 0;
    for (const [v] of list) for (let n = Math.min(v.length - 1, s.length); n > keep; n--) if (s.endsWith(v.slice(0, n))) { keep = n; break; }
    return keep;
  };
  return {
    push(chunk: Uint8Array): Buffer {
      const s = swap(held + Buffer.from(chunk).toString("latin1"));
      const keep = pending(s);
      held = s.slice(s.length - keep);
      return Buffer.from(s.slice(0, s.length - keep), "latin1");
    },
    end(): Buffer {
      const s = held;
      held = "";
      return Buffer.from(s, "latin1");
    },
  };
}
