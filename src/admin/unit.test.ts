// The generated unit and bringing an installed one up to it.
import { expect, test } from "bun:test";
import { unitFor, updateUnit } from "./unit.ts";

const generated = unitFor({ command: ["/opt/keel/bin/keel"], bind: "127.0.0.1:47960", totalMemory: 32 * 2 ** 30 });

test("the unit restarts the daemon after a tenth of a second and bounds the starts of one that cannot start", () => {
  expect(generated).toMatch(/^RestartSec=100ms$/m);
  expect(generated).toMatch(/^Restart=on-failure$/m);
  // In [Unit], where systemd reads them.
  const unit = generated.slice(0, generated.indexOf("[Service]"));
  expect(unit).toMatch(/^StartLimitIntervalSec=30$/m);
  expect(unit).toMatch(/^StartLimitBurst=8$/m);
  expect(generated).toMatch(/^Environment=BUN_GC_TIMER_DISABLE=1$/m);
});

test("an installed unit gets this build's lines and keeps every line of the owner's", () => {
  // A unit an older build wrote, with what an owner added to it: a description, a file of settings, a path, a folder.
  const installed = [
    "[Unit]",
    "Description=Keel, my sessions",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "EnvironmentFile=-%h/.config/keel/extra.env",
    'Environment="PATH=%h/.bun/bin:/usr/bin:/bin"',
    "ExecStart=%h/bin/keel serve --bind 127.0.0.1:47950 --state-dir %h/state",
    "WorkingDirectory=%h/projects",
    "Environment=KEEL_SUPERVISED=systemd",
    "Environment=KEEL_DRAIN_MS=120000",
    "Restart=on-failure",
    "RestartSec=2",
    "KillMode=process",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  const { text, changed } = updateUnit(installed, generated);
  expect(changed).toEqual([
    "added StartLimitIntervalSec=30",
    "added StartLimitBurst=8",
    "RestartSec=2 is now RestartSec=100ms",
    "added Environment=BUN_GC_TIMER_DISABLE=1",
    "added MemoryHigh=4096M",
    "added MemoryMax=8192M",
    "added OOMPolicy=continue",
  ]);
  // Every line the unit had is still there, in its order, but the one that was replaced.
  const kept = installed.split("\n").filter((l) => l !== "RestartSec=2");
  const now = text.split("\n");
  let at = -1;
  for (const l of kept) { const i = now.indexOf(l, at + 1); expect([l, i > at]).toEqual([l, true]); at = i; }
  // The new lines are in their sections: the bound on starts in [Unit], the rest in [Service].
  const section = (name: string) => text.slice(text.indexOf(`[${name}]`), text.indexOf("\n[", text.indexOf(`[${name}]`) + 1));
  expect(section("Unit")).toMatch(/^StartLimitIntervalSec=30\nStartLimitBurst=8$/m);
  expect(section("Service")).toMatch(/^RestartSec=100ms$/m);
  expect(section("Service")).toMatch(/^Environment=BUN_GC_TIMER_DISABLE=1$/m);
  // The owner's own drain time is not this build's to set.
  expect(text).toMatch(/^Environment=KEEL_DRAIN_MS=120000$/m);
  // The comment that explains an added line comes with it, once.
  expect(text.match(/A daemon that cannot start stops being started/g)?.length).toBe(1);
  // A second update changes nothing.
  expect(updateUnit(text, generated)).toEqual({ text, changed: [] });
  // A unit this build wrote needs nothing.
  expect(updateUnit(generated, generated).changed).toEqual([]);
});

test("the unit bounds the daemon's memory by a share of the machine, with a floor and a ceiling", async () => {
  const { memoryBounds } = await import("./unit.ts");
  const GB = 2 ** 30;
  // 64 GB: an eighth and a quarter, which are the ceilings.
  expect(memoryBounds(64 * GB)).toEqual({ high: 8 * GB, max: 16 * GB });
  // 32 GB: the shares.
  expect(memoryBounds(32 * GB)).toEqual({ high: 4 * GB, max: 8 * GB });
  // 8 GB and less: the floors.
  expect(memoryBounds(8 * GB)).toEqual({ high: 2 * GB, max: 4 * GB });
  expect(memoryBounds(2 * GB)).toEqual({ high: 2 * GB, max: 4 * GB });
  // More than 64 GB: the ceilings.
  expect(memoryBounds(512 * GB)).toEqual({ high: 8 * GB, max: 16 * GB });
  const unit = unitFor({ command: ["/opt/keel/bin/keel"], bind: "127.0.0.1:47960", totalMemory: 32 * GB });
  expect(unit).toMatch(/^MemoryHigh=4096M$/m);
  expect(unit).toMatch(/^MemoryMax=8192M$/m);
  expect(unit).toMatch(/^OOMPolicy=continue$/m);
  // An installed unit without them gets them; one that sets another bound gets this build's.
  const bare = unit.split("\n").filter((l) => !/^(MemoryHigh|MemoryMax|OOMPolicy)=|^# What the daemon and the servers|^# first, a process/.test(l)).join("\n");
  expect(updateUnit(bare, unit).changed).toEqual(["added MemoryHigh=4096M", "added MemoryMax=8192M", "added OOMPolicy=continue"]);
  expect(updateUnit(unit.replace("MemoryHigh=4096M", "MemoryHigh=1G"), unit).changed).toEqual(["MemoryHigh=1G is now MemoryHigh=4096M"]);
});
