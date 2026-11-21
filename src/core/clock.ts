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
