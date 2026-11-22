// Times in the texts Keel writes for a reader (a model, a terminal, a bundle):
// the machine's own zone, which is the owner's, the same one an alert or a
// page shows, with the zone said where the text opens or on the line itself.
// Built from the date's own fields, never from a locale: the same text on
// every machine. No imports, so the page can load this file.
const two = (n: number) => String(n).padStart(2, "0");

// "UTC+02:00", "UTC-05:30", "UTC": the zone's offset at that moment (summer time moves it).
export function zoneLabel(at = Date.now()): string {
  const m = -new Date(at).getTimezoneOffset();
  return m === 0 ? "UTC" : `UTC${m < 0 ? "-" : "+"}${two(Math.floor(Math.abs(m) / 60))}:${two(Math.abs(m) % 60)}`;
}

export const localDay = (ts: number) => { const d = new Date(ts); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; };
// "11:58:01", or with `ms` "11:58:01.250".
export const localTime = (ts: number, ms = false) => { const d = new Date(ts); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}${ms ? `.${String(d.getMilliseconds()).padStart(3, "0")}` : ""}`; };
// "2026-11-21 11:58:01": a text that uses it says the zone once (zoneNote).
export const localStamp = (ts: number) => `${localDay(ts)} ${localTime(ts)}`;
// "2026-11-21 11:58:01 UTC+02:00": the zone on the line itself, for a line read alone.
export const zonedStamp = (ts: number) => `${localStamp(ts)} ${zoneLabel(ts)}`;
// What a text says once about its times.
export const zoneNote = (at = Date.now()) => `Times are local (${zoneLabel(at)})`;

// The times of one text. Its first line says the zone once (`note`); a time at
// another offset than the note's says its own ("02:50:00 UTC+02:00"), so rows
// from either side of a clock change read in the right order and no reader
// works out a duration across the change from two times of day. `at`: the
// moment the text is made for (its offset is the note's).
export type Zoned = { label: string; note: string; time: (ts: number, ms?: boolean) => string; stamp: (ts: number) => string; clock: (ts: number, beside?: number) => string };
export function zoned(at = Date.now()): Zoned {
  const label = zoneLabel(at);
  const own = (ts: number) => { const l = zoneLabel(ts); return l === label ? "" : ` ${l}`; };
  return {
    label, note: `Times are local (${label})`,
    time: (ts, ms = false) => `${localTime(ts, ms)}${own(ts)}`,
    stamp: (ts) => `${localStamp(ts)}${own(ts)}`,
    // The time of day, with the date when it is not the day of `beside`.
    clock: (ts, beside = at) => `${localDay(ts) === localDay(beside) ? localTime(ts) : localStamp(ts)}${own(ts)}`,
  };
}
// "09:51 UTC+02:00": a time of day said alone in a sentence, to the minute.
export const zonedClock = (ts: number) => `${localTime(ts).slice(0, 5)} ${zoneLabel(ts)}`;
// A sentence with two times: the zone once, after the later one; the earlier one says its own when it differs.
// "09:13:52 and came back at 09:13:53 UTC+02:00" is built by the caller from these two.
export const zonedPair = (a: number, b: number, fmt: (ts: number) => string = localTime): [string, string] =>
  [`${fmt(a)}${zoneLabel(a) === zoneLabel(b) ? "" : ` ${zoneLabel(a)}`}`, `${fmt(b)} ${zoneLabel(b)}`];
