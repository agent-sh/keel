// The zone a text states and the times it shows are the same zone, in
// whichever zone the process runs.
import { expect, test } from "bun:test";
import { peerMessageLines, type PeerMessageRow } from "../fleet/message-state.ts";
import { errorLines } from "../admin/error-rows.ts";
import { restartSummary, type Restart } from "../admin/life-rows.ts";
import { shownLine } from "../admin/logs.ts";
import { localDay, localStamp, localTime, zoned, zonedClock, zonedStamp, zoneLabel, zoneNote } from "./clock.ts";

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

// A text says its zone once. Across a clock change that one offset is wrong for the rows
// from before it: each of those says its own, so a newest-first list reads in order and
// two times of one line are never read as a duration.
test("a time on the other side of a clock change says its own offset", () => {
  // The machine's zone by name: the variable is given back as that name, since a deleted one
  // does not bring the zone back in a running process, and the files after this one read times too.
  const was = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const before = [zoneLabel(Date.UTC(2026, 0, 5)), zoneLabel(Date.UTC(2026, 6, 5))];
  process.env.TZ = "Europe/Paris";
  try {
    // 25 October 2026: 03:00 summer time becomes 02:00 (at 01:00 UTC).
    const at = (h: number, m: number) => Date.UTC(2026, 9, 25, h, m);
    const now = at(2, 30);
    const z = zoned(now);
    expect(z.note).toBe("Times are local (UTC+01:00)");
    // Newest first: 03:30, 02:50, 02:10, then the hour before the change, which the clock shows again.
    expect([at(2, 30), at(1, 50), at(1, 10), at(0, 50), at(0, 10)].map((t) => z.time(t))).toEqual(["03:30:00", "02:50:00", "02:10:00", "02:50:00 UTC+02:00", "02:10:00 UTC+02:00"]);
    expect(z.stamp(at(0, 50))).toBe("2026-10-25 02:50:00 UTC+02:00");
    expect(z.clock(at(0, 50), now)).toBe("02:50:00 UTC+02:00");
    expect(zonedClock(at(0, 50))).toBe("02:50 UTC+02:00");
    // A message sent before the change and handled after it: 20 minutes, not minus 40.
    const row = { id: "m", direction: "sent", other: { session_id: "0".repeat(36), title: "Receiver" }, text: "Tell me when the build is green.", state: "handled", created_ms: at(0, 50), state_ms: at(1, 10) } as unknown as PeerMessageRow;
    expect(peerMessageLines([row], z.stamp)[0]).toStartWith('2026-10-25 02:50:00 UTC+02:00  sent to "Receiver": handled at 2026-10-25 02:10:00.');
    // The errors list, the log and a restart's sentence, each across the change.
    const err = { id: "e1", ts: at(0, 50), source: "provider", message: "529", count: 2, read: false, resolved: false, sites: [{ session_id: "s1", title: "One", count: 2, ts: at(1, 10) }] } as any;
    const lines = errorLines([err], { now });
    expect(lines[0]).toEndWith("Times are local (UTC+01:00).");
    expect(lines[1]).toContain("2026-10-25 02:50:00 UTC+02:00  provider");
    expect(lines[2]).toContain("last 2026-10-25 02:10:00");
    expect(lines[2]).not.toContain("UTC+02:00");
    expect(shownLine({ ts: at(0, 50), level: "info", text: "x" }, z)).toBe("2026-10-25 02:50:00.000 UTC+02:00 INFO  x");
    const r: Restart = { id: "1", up_ms: at(1, 10), pid: 2, before: { pid: 1, started_ms: at(0, 0), down_ms: at(0, 50), how: "restart" }, turns: [] };
    expect(restartSummary(r)).toBe("The daemon stopped for a restart at 02:50:00 UTC+02:00 and came back at 02:10:00 UTC+01:00 (down 20 min); no turn was cut.");
  } finally {
    process.env.TZ = was;
  }
  // The zone is the machine's again.
  expect([zoneLabel(Date.UTC(2026, 0, 5)), zoneLabel(Date.UTC(2026, 6, 5))]).toEqual(before);
});
