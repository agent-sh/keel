// What took a stall's time, decided from /proc text recorded from real
// threads: one in fsync, one in wait4 and waitid, one waiting for a child in
// a loop of its own, one runnable while its wait for a processor grows, one
// stopped. No file is read here.
import { expect, test } from "bun:test";
import {
  callOf, commandOf, decide, type Lookup, parseEpoll, parseLoad, parsePidfd, parsePressure, parseSchedstat, parseStat, parseSyscall,
  parseThrottled, placeOf, type Sample, sampleOf, syscallName, type ThreadFile, UNSEEN,
} from "./stall-cause.ts";

const dirs = { state: "/home/u/.local/share/keel/state", config: "/home/u/.config/keel" };
// A thread's stat line as the kernel writes it; the name may hold spaces and brackets.
const stat = (state: string, user: number, sys: number, name = "bun") =>
  `926160 (${name}) ${state} 926144 926118 926118 0 -1 4194304 1467 0 0 0 ${user} ${sys} 0 0 20 0 2 0 55960376 99082240 3089 18446744073709551615 4333568 8024065 140733972947168 0 0 0 0 16781312 2 1 0 0 17 2 0 0 0 0 0 11038136 11672456 202993664 140733972956345 140733972956360 140733972956360 140733972959207 0\n`;
const none: Lookup = { link: () => undefined, pidfd: () => undefined, epoll: () => [], child: () => undefined };
type Files = Partial<Record<ThreadFile, string>>;
const samples = (rows: [number, Files][], look: Lookup = none, ep = 1): Sample[] => {
  const memo = {};
  return rows.map(([t, files]) => sampleOf(t, ep, (f) => files[f], "x64", dirs, look, memo)!);
};

test("the files are read as the kernel writes them", () => {
  expect(parseStat(stat("D", 1, 99))).toEqual({ state: "D", user_ticks: 1, sys_ticks: 99 });
  expect(parseStat(stat("S", 4, 2, "a (odd) name"))).toEqual({ state: "S", user_ticks: 4, sys_ticks: 2 });
  expect(parseStat("nothing")).toBeUndefined();
  expect(parseSyscall("running\n")).toBe("running");
  expect(parseSyscall("-1 0x7ffe015219b0 0x1af6d86\n")).toEqual({ nr: -1, args: [] });
  expect(parseSyscall("74 0x9 0x0 0x0 0x0 0x0 0x0 0x7fffa0be4768 0x7e0a92aac7c2\n")).toEqual({ nr: 74, args: [9n, 0n, 0n, 0n, 0n, 0n] });
  expect(parseSchedstat("1014934835 16131221 337\n")).toEqual({ run_ns: 1014934835, wait_ns: 16131221 });
  expect(parsePressure("some avg10=3.65 avg60=2.91 avg300=4.36 total=35215915047\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n")).toBe(3.65);
  expect(parseLoad("12.18 11.71 14.15 10/7243 919825\n")).toBe(12.18);
  expect(parseThrottled("usage_usec 100\nnr_periods 4\nnr_throttled 3\nthrottled_usec 2500000\n")).toBe(2500);
  expect(parsePidfd("pos:\t0\nflags:\t02000002\nmnt_id:\t16\nino:\t1057\nPid:\t230901\nNSpid:\t230901\n")).toBe(230901);
  expect(parseEpoll("pos:\t0\nflags:\t02000002\ntfd:       11 events:       19 data: 0 pos:0 ino:421 sdev:10\ntfd:       13 events: 19 data: 1\n")).toEqual([11, 13]);
  // The same call has another number on each architecture.
  expect([syscallName(74, "x64"), syscallName(82, "arm64"), syscallName(61, "x64"), syscallName(260, "arm64"), syscallName(441, "arm64"), syscallName(9999, "x64")])
    .toEqual(["fsync", "fsync", "wait4", "wait4", "epoll_pwait2", "system call 9999"]);
});

test("a file is named by its place under the state or config folder, and one outside them not at all", () => {
  const p = (link: string) => placeOf(link, dirs).text;
  expect(p(`${dirs.state}/keel.db-wal`)).toBe("the store's log (keel.db-wal)");
  expect(p(`${dirs.state}/keel.db`)).toBe("the store's database (keel.db)");
  expect(p(`${dirs.state}/worktrees/site-4f2a/src/deep/file.ts`)).toBe("a file under worktrees/site-4f2a");
  expect(p(`${dirs.state}/backups/keel-2026/attachments/ab/photo.png`)).toBe("state/backups/keel-2026/attachments/...");
  expect(p(`${dirs.config}/mcp.json`)).toBe("config/mcp.json");
  expect(p("/home/u/projects/secret-plan/notes.md")).toBe("a file outside its state and config folders");
  expect(p("/home/u/projects/gone.txt (deleted)")).toBe("a file outside its state and config folders (deleted since)");
  expect([p("pipe:[4321]"), p("socket:[99]"), p("anon_inode:[eventpoll]"), p("/dev/pts/3"), p("/dev/null")]).toEqual(["a pipe", "a socket", "its event queue", "a terminal", "the device /dev/null"]);
  // A child is its program and its first argument: no path, nothing after, nothing that looks like a setting or an address.
  expect(commandOf("git\n", "/usr/bin/git\0rev-parse\0--show-toplevel\0")).toBe("git rev-parse");
  expect(commandOf("git\n", "git\0-C\0/home/u/projects/secret-plan\0status\0")).toBe("git -C");
  expect(commandOf("curl\n", "curl\0https://user:pw@host/x\0")).toBe("curl");
  expect(commandOf("sh\n", "sh\0/home/u/run.sh\0")).toBe("sh");
  expect(commandOf("kworker\n", "")).toBe("kworker");
});

test("a thread in fsync of the store's log: the row names the call and the file", () => {
  const look: Lookup = { ...none, link: (fd) => (fd === 9 ? `${dirs.state}/keel.db-wal` : undefined) };
  const call = "74 0x9 0x0 0x0 0x0 0x0 0x0 0x7fffa0be4768 0x7e0a92aac7c2\n";
  const got = samples([
    [0, { stat: stat("D", 1, 99), schedstat: "1007162206 16087436 299\n", syscall: call, wchan: "rq_qos_wait" }],
    [100, { stat: stat("D", 1, 100), schedstat: "1014934835 16131221 337\n", syscall: call, wchan: "jbd2_log_wait_commit" }],
    [5000, { stat: stat("D", 1, 100), schedstat: "1015134835 16131221 340\n", syscall: call, wchan: "jbd2_log_wait_commit" }],
    [5100, { stat: stat("R", 1, 100), schedstat: "1015620085 16131221 352\n", syscall: "running\n", wchan: "0" }],
  ], look);
  expect(got[0]!.call).toEqual({ name: "fsync", on: { kind: "store log", text: "the store's log (keel.db-wal)" } });
  const c = decide(got, { load: 3.2, pressure: { cpu: 2, io: 61 } }, 5200);
  expect(c).toMatchObject({ kind: "call", key: "fsync store log", text: "5.1 s in fsync of the store's log (keel.db-wal) (IO pressure 61%)", state: "D", wchan: "jbd2_log_wait_commit", call: { name: "fsync", on: "the store's log (keel.db-wal)" } });
  expect(c.sampled_ms).toBe(5100);
  expect(c.run_ms).toBe(8);
});

test("a thread in wait4 or waitid: the row names the child by its program and first argument", () => {
  const look: Lookup = { ...none, child: (pid) => (pid === 926170 ? commandOf("git\n", "git\0rev-parse\0--git-common-dir\0") : pid === 926585 ? commandOf("sleep\n", "sleep\x001\x00") : undefined) };
  const wait4 = "61 0xe21da 0x7fff2e7718bc 0x0 0x0 0x0 0x0 0x7fff2e771858 0x76d81eeac7c2\n";
  const got = samples([
    [0, { stat: stat("S", 1, 0), schedstat: "16566722 6357114 7\n", syscall: wait4, wchan: "do_wait" }],
    [3000, { stat: stat("S", 1, 0), schedstat: "16566722 6357114 7\n", syscall: wait4, wchan: "do_wait" }],
    [3020, { stat: stat("R", 1, 0), schedstat: "16919466 6357114 12\n", syscall: "running\n" }],
  ], look);
  const c = decide(got, { load: 1 }, 3100);
  expect(c).toMatchObject({ kind: "child", key: "child git", text: "3.0 s waiting for a child: git rev-parse (pid 926170)", wchan: "do_wait", call: { name: "wait4", child: { pid: 926170, command: "git rev-parse" } } });
  // waitid names the kind of id first, then the id.
  expect(callOf(parseSyscall("247 0x1 0xe2379 0x7fff2e771830 0x4 0x0 0x0 0x7fff2e7717c8 0x76d81eeac7c2\n") as any, "x64", dirs, look)).toEqual({ name: "waitid", child: { pid: 926585, command: "sleep 1" } });
  // A child that is gone by the time it is looked up is still a child.
  expect(callOf(parseSyscall(wait4) as any, "x64", dirs, none)).toEqual({ name: "wait4", child: { pid: 926170, command: "a process that is gone" } });
});

test("a synchronous child waited for in a loop of its own is found through the loop's pidfd", () => {
  // As recorded: the main thread in epoll_pwait2 on another queue than its loop's, which holds the child's pidfd.
  const look: Lookup = {
    link: (fd) => ({ 9: "anon_inode:[eventpoll]", 11: "pipe:[77]", 12: "anon_inode:[pidfd]" })[fd],
    epoll: (fd) => (fd === 9 ? [11, 12] : []),
    pidfd: (fd) => (fd === 12 ? 230901 : undefined),
    child: (pid) => (pid === 230901 ? "sleep 3" : undefined),
  };
  const call = "441 0x9 0x3f8cc1838e0 0x400 0x0 0x7ffe0151f3d0 0x8 0x7ffe0151f3d0 0x1af6e08\n";
  const got = samples([
    [0, { stat: stat("S", 0, 0), schedstat: "9642161 0 4\n", syscall: call, wchan: "ep_poll" }],
    [2800, { stat: stat("S", 0, 0), schedstat: "9642161 0 4\n", syscall: call, wchan: "ep_poll" }],
    [2810, { stat: stat("R", 0, 0), schedstat: "10139517 0 21\n", syscall: "running\n" }],
  ], look);
  expect(decide(got, {}, 3000)).toMatchObject({ kind: "child", key: "child sleep", text: "2.8 s waiting for a child: sleep 3 (pid 230901)" });
  // The same call with no child in its queue is a wait in a loop of its own, and says no more than that.
  expect(callOf(parseSyscall(call) as any, "x64", dirs, none)).toEqual({ name: "epoll_pwait2" });
});

test("a runnable thread whose wait for a processor grows is a starved machine, with the load and the pressure of the time", () => {
  // The wait is counted when it ends: the samples in between show a runnable thread whose counters stand still.
  const got = samples([
    [0, { stat: stat("R", 150, 0), schedstat: "1509129791 217298 31\n", syscall: "running\n" }],
    [100, { stat: stat("R", 150, 0), schedstat: "1509129791 217298 31\n", syscall: "running\n" }],
    [1200, { stat: stat("R", 151, 0), schedstat: "1519129791 1000217298 33\n", syscall: "running\n" }],
    [2300, { stat: stat("R", 152, 1), schedstat: "1709129791 2100217298 40\n", syscall: "running\n" }],
  ]);
  const c = decide(got, { load: 22.4, pressure: { cpu: 41.2, io: 0.4 } }, 2400);
  expect(c).toMatchObject({ kind: "cpu_wait", key: "cpu_wait", text: "2.1 s waiting for a processor (machine load 22, CPU pressure 41%)", wait_ms: 2100, run_ms: 200 });
  // A fifth of a second of its own code is in the shares, and too small a part to be in the row's words.
  expect(c.shares.map((x) => [x.kind, x.ms])).toEqual([["cpu_wait", 2100], ["compute", 200]]);
  expect(c.also).toBeUndefined();
  expect(c.note).toBeUndefined();
  // Under a unit's quota the same wait says whose limit it was.
  expect(decide(got, { load: 1, pressure: { cpu: 3 }, throttled_ms: 5200 }, 2400).text).toBe("2.1 s waiting for a processor (machine load 1, CPU pressure 3%, held back by its unit's processor quota)");
});

test("a thread on a processor the whole time computed, and the watcher says it cannot see which code", () => {
  const got = samples([
    [0, { stat: stat("R", 20, 0), schedstat: "211775050 24900 6\n", syscall: "running\n" }],
    [1400, { stat: stat("R", 160, 0), schedstat: "1611775050 124900 14\n", syscall: "running\n" }],
    [2800, { stat: stat("R", 300, 0), schedstat: "3007775050 224900 31\n", syscall: "running\n" }],
  ]);
  const c = decide(got, { load: 9 }, 3000);
  expect(c).toMatchObject({ kind: "compute", key: "compute", text: "2.8 s in its own code", run_ms: 2796, kernel_ms: 0, note: UNSEEN });
  // Processor time in the kernel is a system call's work, not JavaScript: it is not blamed on the daemon's code.
  const kernel = samples([
    [0, { stat: stat("R", 1, 9), schedstat: "111040514 736246 16\n", syscall: "running\n" }],
    [1000, { stat: stat("R", 1, 97), schedstat: "990456032 15829160 291\n", syscall: "running\n" }],
  ]);
  expect(decide(kernel, {}, 1000)).toMatchObject({ kind: "compute", text: "0.9 s on a processor in the kernel, for system calls of its own" });
  expect(decide(kernel, {}, 1000).note).toBeUndefined();
});

test("a stopped thread, a stopped process and a suspended machine are told apart", () => {
  // The thread alone was seen stopped (a debugger held it).
  const held = samples([
    [0, { stat: stat("T", 0, 0, "sleep"), schedstat: "1560978 0 2\n", syscall: "230 0x0 0x0 0x7ffd 0x0 0x0 0x0 0x7ffd 0x7f\n" }],
    [3000, { stat: stat("T", 0, 0, "sleep"), schedstat: "1560978 0 2\n", syscall: "230 0x0 0x0 0x7ffd 0x0 0x0 0x0 0x7ffd 0x7f\n" }],
    [3050, { stat: stat("R", 0, 0, "sleep"), schedstat: "1660978 0 3\n", syscall: "running\n" }],
  ]);
  expect(decide(held, {}, 3100)).toMatchObject({ kind: "stopped", key: "stopped", text: "3.0 s stopped (a stop signal or a debugger held its thread)" });
  // The whole process: the watcher did not run either, and marks the sample after its own gap.
  const at = (t: number, gap?: Sample["gap"]): Sample => ({ t, ep: 2, state: gap ? "R" : "T", run_ns: 11224527, wait_ns: 0, user_ticks: 0, sys_ticks: 0, ...(gap ? { gap } : {}) });
  expect(decide([at(0), at(3100, "stopped")], { load: 9 }, 3000)).toMatchObject({ kind: "stopped", text: "3.0 s stopped (a stop signal, a debugger or a frozen unit)", run_ms: 0, wait_ms: 0 });
  // Idle, the loop measures a stall short: the row's part is no longer than the row, and the share keeps what was seen.
  expect(decide([at(0), at(3100, "stopped")], {}, 2300)).toMatchObject({ text: "2.3 s stopped (a stop signal, a debugger or a frozen unit)", shares: [{ kind: "stopped", ms: 3100 }] });
  expect(decide([at(0), at(2600, "suspended")], { suspended_ms: 41_000 }, 2500)).toMatchObject({ kind: "suspended", key: "suspended", text: "the machine was suspended", suspended_ms: 41_000 });
});

test("what the watcher did not see is said, and samples of another stall are not counted", () => {
  expect(decide([], {}, 2000)).toMatchObject({ kind: "unknown", key: "unknown", text: "the watcher saw none of it" });
  const call = "74 0x9 0x0 0x0 0x0 0x0 0x0 0x7fffa0be4768 0x7e0a92aac7c2\n";
  const first = samples([[0, { stat: stat("D", 0, 0), schedstat: "100 0 1\n", syscall: call }], [900, { stat: stat("R", 0, 0), schedstat: "100 0 1\n" }]], none, 1);
  const second = samples([[5000, { stat: stat("D", 0, 0), schedstat: "100 0 1\n", syscall: call }], [5700, { stat: stat("R", 0, 0), schedstat: "100 0 1\n" }]], none, 2);
  // Two runs of samples: the four seconds between them belong to neither.
  const c = decide([...first, ...second], {}, 2000);
  expect(c.sampled_ms).toBe(1600);
  // A stall seen only at its end says how much of it was seen.
  expect(decide(second, {}, 2000).text).toBe("0.7 s in fsync of a file (seen for the last 0.7 s of it)");
});
