// Secret values kept out of what is written outside the Store: job sidecars and
// logs, spill files, trace rows. The secrets feature registers the redactor
// (src/server/routes/secrets.ts); without it text passes through unchanged.
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
// knows it: a bearer token, a key in a query, and the key forms of the common
// providers and hosts. Wider than the vault's rules on purpose (those issue a
// placeholder that can be sent again, so they must be exact): this is for
// text that is only read, where a string that merely looks like a key costs
// nothing to hide.
const KEY_SHAPES = /\b(?:(?:sk|xai|AIza)[-_A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g;
export function keyShaped(text: string): string {
  return text
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1<redacted>")
    .replace(/((?:api[_-]?)?key=)[^&\s"]+/gi, "$1<redacted>")
    .replace(KEY_SHAPES, "<redacted>");
}
// The one scrub of what is stored about a failure (an error row, a span's
// error, a failure's sample, a tool's failure line), applied where it is
// captured: the known secrets as their placeholders, then anything else that
// is shaped like a key. So no notice, list or bundle made from those rows can
// carry one.
export const scrubbed = (text: string, sessionId: string | null = null): string => (text ? keyShaped(conceal(text, sessionId)) : text);
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
