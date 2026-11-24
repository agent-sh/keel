// Secret values kept out of what is written outside the Store: job sidecars and
// logs, spill files, trace rows. The secrets feature registers the redactor
// (src/server/routes/secrets.ts); without it text passes through unchanged.
import { credentialName, detect, entropy, wordSwap, type Words } from "../safety/secrets.ts";

export type Concealer = {
  // Text with every known secret value (and anything that looks like one) as its placeholder.
  // `words`: whose words the text is (src/safety/secrets.ts Words; output when not said).
  text(s: string, sessionId: string | null, words?: Words): string;
  // The known values and their placeholders, for a stream filtered outside the daemon.
  // `word`: a value that is ordinary text, replaced only where it stands as a whole word.
  pairs(): [value: string, placeholder: string, word?: boolean][];
};

let current: Concealer | null = null;
export const setConcealer = (c: Concealer | null) => void (current = c);
// (A test puts back what was there.)
export const getConcealer = () => current;
export const conceal = (s: string, sessionId: string | null = null, words?: Words): string => (current && s ? current.text(s, sessionId, words) : s);
// Every string of a JSON value concealed (a record written to disk or sent whole).
export function concealDeep<T>(v: T, sessionId: string | null = null): T {
  if (!current) return v;
  const walk = (x: any): any =>
    typeof x === "string" ? conceal(x, sessionId) : Array.isArray(x) ? x.map(walk) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])) : x;
  return walk(v);
}
export const secretPairs = (): [string, string, boolean?][] => current?.pairs() ?? [];

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
  for (const [value, placeholder, word] of secretPairs()) {
    if (word) out = wordSwap(out, value, placeholder);
    else if (value.length >= 8 && out.includes(value)) out = out.split(value).join(placeholder);
  }
  return keyShaped(out);
}
export function keyShapedDeep<T>(v: T): T {
  const walk = (x: any): any =>
    typeof x === "string" ? keyShaped(x) : Array.isArray(x) ? x.map(walk) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])) : x;
  return walk(v);
}

// A byte stream with known values replaced as it passes, a value split across
// chunks included: only the end of a chunk that could start a value is held
// back until the next chunk (or the end) says what it is. A value marked as a
// word (ordinary text) is replaced only where it stands as a whole word: no
// letter, digit or _ of any script joined to it (the characters beside it are
// decoded from their UTF-8 bytes, so a curly quote or an ellipsis is a
// boundary and a CJK letter is not), and never inside a placeholder; a whole
// one at a chunk's end waits for the next character, and the bytes of a
// character a chunk cut wait for the rest of it. Self-contained (it runs as
// the source of a filter process too, see jobs.ts).
export function streamConcealer(pairs: [string, string, boolean?][]) {
  const list = pairs.map(([v, p, w]) => [Buffer.from(v).toString("latin1"), Buffer.from(p).toString("latin1"), !!w] as const).filter(([v]) => v.length > 0).sort((a, b) => b[0].length - a[0].length);
  const place = /\[secret:[0-9a-f]{8}\]|\[value of \$[A-Za-z_][A-Za-z0-9_]*\]/g;
  const wordChar = /^[\p{L}\p{N}_]$/u;
  // `prev`: the last character given out (decoded), what stands before what is held.
  let held = "", prev = "";
  const decode = (b: string) => [...Buffer.from(b, "latin1").toString("utf8")].pop() ?? "";
  const width = (c: number) => (c < 0xc0 ? 1 : c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4);
  // The character that ends at byte i, and the one that starts at byte j (undefined: not here yet).
  const before = (s: string, i: number) => {
    if (i <= 0) return prev;
    let k = i - 1;
    while (k > 0 && i - k < 4 && (s.charCodeAt(k) & 0xc0) === 0x80) k--;
    return decode(s.slice(k, i));
  };
  const after = (s: string, j: number) => (j >= s.length || j + width(s.charCodeAt(j)) > s.length ? undefined : decode(s.slice(j, j + width(s.charCodeAt(j)))));
  const wordy = (c: string) => wordChar.test(c);
  // The bytes at the end of s that start a character the chunk cut.
  const cutChar = (s: string) => {
    for (let k = s.length - 1; k >= 0 && k >= s.length - 3; k--) {
      const c = s.charCodeAt(k);
      if ((c & 0xc0) === 0x80) continue;
      return c >= 0xc0 && s.length - k < width(c) ? s.length - k : 0;
    }
    return 0;
  };
  const swap = (s: string, atEnd: boolean) => {
    for (const [v, p, w] of list) {
      if (!w) { s = s.split(v).join(p); continue; }
      if (!s.includes(v)) continue;
      // The placeholders in s, and one the chunk's end may still be writing.
      const spans = [...s.matchAll(place)].map((m) => [m.index!, m.index! + m[0].length] as const);
      const open = atEnd ? 0 : placeStart(s);
      if (open) spans.push([s.length - open, s.length]);
      let out = "", at = 0;
      for (let i = s.indexOf(v); i >= 0; i = s.indexOf(v, i + 1)) {
        const j = i + v.length;
        const next = after(s, j);
        if (i < at || wordy(before(s, i)) || (next === undefined ? !atEnd : wordy(next)) || spans.some(([a, b]) => i < b && j > a)) continue;
        out += s.slice(at, i) + p;
        at = j;
      }
      if (at) s = out + s.slice(at);
    }
    return s;
  };
  // The end of s that may be the start of a placeholder, held with a word so the next chunk sees it whole.
  const words = list.some(([, , w]) => w);
  const placeStart = (s: string) => {
    const k = s.lastIndexOf("[");
    if (!words || k < 0 || s.length - k > 80) return 0;
    const t = s.slice(k);
    const open = "[secret:".startsWith(t) || /^\[secret:[0-9a-f]{0,8}$/.test(t) || "[value of $".startsWith(t) || /^\[value of \$[A-Za-z_][A-Za-z0-9_]*$/.test(t);
    return open ? t.length : 0;
  };
  // The longest end of s that is the start of some value (all of a word's: the next character decides).
  const pending = (s: string) => {
    let keep = placeStart(s);
    for (const [v, , w] of list) for (let n = Math.min(w ? v.length : v.length - 1, s.length); n > keep; n--) if (s.endsWith(v.slice(0, n))) { keep = n; break; }
    return keep;
  };
  return {
    push(chunk: Uint8Array): Buffer {
      const all = held + Buffer.from(chunk).toString("latin1");
      const cut = cutChar(all);
      const s = swap(all.slice(0, all.length - cut), false);
      const keep = pending(s);
      held = s.slice(s.length - keep) + all.slice(all.length - cut);
      const out = s.slice(0, s.length - keep);
      if (out) prev = before(out, out.length);
      return Buffer.from(out, "latin1");
    },
    end(): Buffer {
      const s = swap(held, true);
      held = "";
      return Buffer.from(s, "latin1");
    },
  };
}
