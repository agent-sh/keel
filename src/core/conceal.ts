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
export const secretPairs = (): [string, string][] => current?.pairs() ?? [];

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
