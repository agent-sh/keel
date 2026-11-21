// The zone a text states and the times it shows are the same zone, in
// whichever zone the process runs.
import { expect, test } from "bun:test";
import { localDay, localStamp, localTime, zonedStamp, zoneLabel, zoneNote } from "./clock.ts";

test("a stamp is the local time, and the label is the offset that turns it back into the moment", () => {
  for (const ts of [Date.UTC(2026, 0, 2, 14, 40, 0), Date.UTC(2026, 6, 15, 23, 59, 59, 250), Date.UTC(2026, 10, 21, 0, 0, 1)]) {
    const label = zoneLabel(ts);
    expect(label).toMatch(/^UTC(?:[+-]\d\d:\d\d)?$/);
    // Read back as an ISO time with that offset, the stamp is the same moment.
    const offset = label === "UTC" ? "Z" : label.slice(3);
    expect(Date.parse(`${localStamp(ts).replace(" ", "T")}${offset}`)).toBe(Math.floor(ts / 1000) * 1000);
    expect(localStamp(ts)).toBe(`${localDay(ts)} ${localTime(ts)}`);
    expect(localTime(ts, true)).toBe(`${localTime(ts)}.${String(ts % 1000).padStart(3, "0")}`);
    expect(zonedStamp(ts)).toBe(`${localStamp(ts)} ${label}`);
    expect(zoneNote(ts)).toBe(`Times are local (${label})`);
  }
});
