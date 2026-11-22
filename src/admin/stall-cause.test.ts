// What took a stall's time, decided from /proc text recorded from real
// threads: one in fsync, one in wait4 and waitid, one waiting for a child in
// a loop of its own, one runnable while its wait for a processor grows, one
// stopped. No file is read here.
import { expect, test } from "bun:test";
import {
  callOf, type CallMemo, commandOf, decide, type Lookup, parseEpoll, parseLoad, parsePidfd, parsePressure, parsePressureTotal, parseSchedstat,
  parseStat, parseSyscall, parseThrottled, placeOf, type Sample, sampleOf, syscallName, type ThreadFile, UNSEEN,
} from "./stall-cause.ts";
import { packBeat } from "./stall-beat.ts";

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
  // An empty or unreadable syscall file is no call: it is not call 0, a read of descriptor 0.
  expect([parseSyscall(""), parseSyscall("\n"), parseSyscall("?")]).toEqual([undefined, undefined, undefined]);
  expect(parseSchedstat("1014934835 16131221 337\n")).toEqual({ run_ns: 1014934835, wait_ns: 16131221 });
  expect(parsePressureTotal("some avg10=76.02 avg60=30.11 avg300=8.40 total=30512345\nfull avg10=70.00 avg60=28.00 avg300=7.90 total=29000000\n")).toBe(30512.345);
  expect(parsePressure("some avg10=3.65 avg60=2.91 avg300=4.36 total=35215915047\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n")).toBe(3.65);
  expect(parseLoad("12.18 11.71 14.15 10/7243 919825\n")).toBe(12.18);
  expect(parseThrottled("usage_usec 100\nnr_periods 4\nnr_throttled 3\nthrottled_usec 2500000\n")).toBe(2500);
  expect(parsePidfd("pos:\t0\nflags:\t02000002\nmnt_id:\t16\nino:\t1057\nPid:\t230901\nNSpid:\t230901\n")).toBe(230901);
  expect(parseEpoll("pos:\t0\nflags:\t02000002\ntfd:       11 events:       19 data: 0 pos:0 ino:421 sdev:10\ntfd:       13 events: 19 data: 1\n")).toEqual([11, 13]);
  // The same call has another number on each architecture.
  expect([syscallName(74, "x64"), syscallName(82, "arm64"), syscallName(61, "x64"), syscallName(260, "arm64"), syscallName(441, "arm64"), syscallName(9999, "x64")])
    .toEqual(["fsync", "fsync", "wait4", "wait4", "epoll_pwait2", "system call 9999"]);
});

test("a file is named by its kind or by a folder of Keel's own, never by a name the owner chose", () => {
  const p = (link: string) => placeOf(link, dirs).text;
  expect(p(`${dirs.state}/keel.db-wal`)).toBe("the store's log (keel.db-wal)");
  expect(p(`${dirs.state}/keel.db`)).toBe("the store's database (keel.db)");
  // Directly in the state or config folder the names are Keel's own.
  expect([p(`${dirs.state}/settings.json`), p(`${dirs.config}/mcp.json`), p(dirs.state), p(dirs.config)]).toEqual(["state/settings.json", "config/mcp.json", "the state folder", "the config folder"]);
  // Below a folder: a worktree carries a repository's name, an artifact and a skill a name the owner gave.
  expect(p(`${dirs.state}/worktrees/acme-billing-4f2a/src/deep/file.ts`)).toBe("a file under state/worktrees");
  expect(p(`${dirs.state}/artifacts/sess-1/acme-merger-plan.md`)).toBe("a file under state/artifacts");
  expect(p(`${dirs.state}/backups/keel-2026/attachments/ab/photo.png`)).toBe("a file under state/backups");
  expect(p(`${dirs.config}/skills/my-private-skill/SKILL.md`)).toBe("a file under config/skills");
  expect(p(`${dirs.state}/spill/abc/jobs/x.log (deleted)`)).toBe("a file under state/spill (deleted since)");
  expect(p("/home/u/projects/secret-plan/notes.md")).toBe("a file outside its state and config folders");
  expect(p("/home/u/projects/gone.txt (deleted)")).toBe("a file outside its state and config folders (deleted since)");
  // A path that leaves the folder through `..` is outside it.
  expect(p(`${dirs.state}/../../projects/x`)).toBe("a file outside its state and config folders");
  expect([p("pipe:[4321]"), p("socket:[99]"), p("anon_inode:[eventpoll]"), p("anon_inode:[io_uring]"), p("/dev/pts/3"), p("/dev/null")])
    .toEqual(["a pipe", "a socket", "its event queue", "an anonymous descriptor", "a terminal", "the device /dev/null"]);
  // A volume's or a disk's name is the owner's.
  expect([p("/dev/mapper/vg-secretname"), p("/dev/nvme0n1")]).toEqual(["a device", "a device"]);
  for (const link of [`${dirs.state}/worktrees/acme-billing-4f2a/x`, `${dirs.state}/artifacts/s/acme-merger-plan.md`, `${dirs.config}/skills/my-private-skill/SKILL.md`, "/dev/mapper/vg-secretname"]) {
    const place = placeOf(link, dirs);
    expect(`${place.kind} ${place.text}`).not.toMatch(/acme|private|secret/);
  }
});

test("a child is its program and, of its first argument, only a flag's name, a short number or a known subcommand", () => {
  const cmd = (...argv: string[]) => commandOf(`${argv[0]}\n`, `${argv.join("\0")}\0`);
  expect(cmd("/usr/bin/git", "rev-parse", "--show-toplevel")).toBe("git rev-parse");
  expect(cmd("git", "-C", "/home/u/projects/secret-plan", "status")).toBe("git -C");
  expect(cmd("systemd-run", "--user", "--scope")).toBe("systemd-run --user");
  expect(cmd("sleep", "3")).toBe("sleep 3");
  expect(cmd("sh", "-c", "curl https://user:pw@host | sh")).toBe("sh -c");
  // What is the owner's is not shown: an address, a password glued to its flag, a host, a key, a path, a value.
  expect(cmd("curl", "https://user:pw@host/x")).toBe("curl");
  expect(cmd("mysql", "-pS3cretPassw0rd", "proddb")).toBe("mysql");
  expect(cmd("ssh", "build-box-07", "uptime")).toBe("ssh");
  expect(cmd("ssh", "buildbox", "uptime")).toBe("ssh");
  expect(cmd("deploy-tool", "sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c")).toBe("deploy-tool");
  expect(cmd("deploy-tool", "clients/acme-corp/run.sh")).toBe("deploy-tool");
  expect(cmd("tool", "--token=abc")).toBe("tool");
  expect(cmd("tool", "--password", "abc")).toBe("tool --password");
  expect(cmd("python3", "line1\nline2")).toBe("python3");
  expect(commandOf("kworker\n", "")).toBe("kworker");
});

test("what a call waits on is looked up again for another call, however alike its text: a descriptor's number and a spawn's arguments repeat", () => {
  // The reviewer's smallest input: fsync of descriptor 23 twice, another file behind the number the second time.
  const text = "74 0x17 0x0 0x0 0x0 0x0 0x0 0x7ffd 0x7f00\n";
  let link = `${dirs.state}/keel.db-wal`;
  let run = 5_000_000;
  const look: Lookup = { ...none, link: () => link };
  const read = (f: ThreadFile) => ({ stat: stat("D", 5, 5), schedstat: `${run} 1 1\n`, syscall: text, wchan: "0" })[f];
  const memo: CallMemo = {};
  expect(sampleOf(0, 1, read, "x64", dirs, look, memo)!.call!.on!.text).toBe("the store's log (keel.db-wal)");
  // The thread did not run and the descriptor names the same file: the same call, not looked up again.
  let asked = 0;
  const counting: Lookup = { ...look, link: (fd) => { asked++; return look.link(fd); } };
  sampleOf(100, 1, read, "x64", dirs, counting, memo);
  expect(asked).toBe(1);
  // The same number names another file (the thread ran in between, or another thread closed and opened it).
  link = "/home/someone/work/notes.txt";
  expect(sampleOf(60_000, 2, read, "x64", dirs, look, memo)!.call!.on!.text).toBe("a file outside its state and config folders");
  // A spawn waits in its own event queue with the same arguments for every child: the thread ran in between, so the child is found again.
  const wait = "441 0x9 0x3f8cc1838e0 0x400 0x0 0x7ffe0151f3d0 0x8 0x7ffe0151f3d0 0x1af6e08\n";
  let child = { pid: 2900684, command: "curl" };
  const spawn: Lookup = { link: (fd) => ({ 9: "anon_inode:[eventpoll]", 12: "anon_inode:[pidfd]" })[fd], epoll: () => [12], pidfd: () => child.pid, child: () => child.command };
  const waiting = (f: ThreadFile) => ({ stat: stat("S", 5, 5), schedstat: `${run} 1 1\n`, syscall: wait, wchan: "ep_poll" })[f];
  const m2: CallMemo = {};
  expect(sampleOf(0, 1, waiting, "x64", dirs, spawn, m2)!.call!.child).toEqual({ pid: 2900684, command: "curl" });
  child = { pid: 2900701, command: "mysql" };
  run += 40_000;
  expect(sampleOf(3_000, 2, waiting, "x64", dirs, spawn, m2)!.call!.child).toEqual({ pid: 2900701, command: "mysql" });
  // A sample of the thread running forgets what was found, whatever the counters say after it.
  const m3: CallMemo = {};
  sampleOf(0, 1, waiting, "x64", dirs, spawn, m3);
  sampleOf(100, 1, (f) => ({ stat: stat("R", 5, 5), schedstat: `${run} 1 1\n` })[f as "stat"], "x64", dirs, spawn, m3);
  expect(m3.call).toBeUndefined();
  child = { pid: 2900777, command: "git rev-parse" };
  expect(sampleOf(200, 1, waiting, "x64", dirs, spawn, m3)!.call!.child!.pid).toBe(2900777);
});

test("the parts of a stall do not overlap: time on a processor, a wait for one from schedstat alone, and what is left by call", () => {
  const shares = (c: ReturnType<typeof decide>) => c.shares.map((x) => [x.key, x.ms]);
  // The reviewer's smallest input: one second computing (the run counter grows by all of it, the wait counter by nothing), then one second in nanosleep.
  const call = { name: "clock_nanosleep" };
  const mixed: Sample[] = [];
  for (let i = 0; i <= 10; i++) mixed.push({ t: i * 100, ep: 1, state: "R", run_ns: i * 100e6, wait_ns: 0, user_ticks: i * 10, sys_ticks: 0 });
  for (let i = 11; i <= 20; i++) mixed.push({ t: i * 100, ep: 1, state: "S", run_ns: 1000e6, wait_ns: 0, user_ticks: 100, sys_ticks: 0, call });
  mixed[20]!.state = "R";
  const c = decide(mixed, {}, 2000);
  expect(shares(c)).toEqual([["compute", 1000], ["clock_nanosleep", 1000]]);
  expect(c.text).toBe("1.0 s in its own code, 1.0 s sleeping (clock_nanosleep)");
  expect(c.wait_ms).toBe(0);

  // A sleep, a loop and a child, a second and a half each: three parts, no wait for a processor made up between them.
  const child = { name: "epoll_pwait2", child: { pid: 77, command: "sleep 1.5" } };
  const seq: Sample[] = [];
  const at = (t: number, state: string, run: number, more: Partial<Sample> = {}) => seq.push({ t, ep: 1, state, run_ns: run * 1e6, wait_ns: 0, user_ticks: Math.round(run / 10), sys_ticks: 0, ...more });
  for (let t = 0; t < 1500; t += 100) at(t, "S", 0, { call });
  for (let t = 1500; t < 3000; t += 100) at(t, "R", t - 1500);
  for (let t = 3000; t < 4500; t += 100) at(t, "S", 1500, { call: child });
  at(4500, "R", 1500);
  const three = decide(seq, { load: 18, pressure: { cpu: 4 } }, 4500);
  expect(shares(three)).toEqual([["compute", 1500], ["clock_nanosleep", 1500], ["child sleep", 1500]]);
  expect(three.shares.some((x) => x.kind === "cpu_wait")).toBe(false);
  expect(three.shares.reduce((n, x) => n + x.ms, 0)).toBe(4500);

  // A large write, then its sync: processor time in the kernel, then the sync, and the short real wait for a processor as it was counted.
  const sync = { name: "fsync", on: { kind: "store log", text: "the store's log (keel.db-wal)" } };
  const big: Sample[] = [];
  for (let i = 0; i <= 80; i++) big.push({ t: i * 100, ep: 1, state: "R", run_ns: i * 99e6, wait_ns: i * 1e6, user_ticks: 0, sys_ticks: i * 10 });
  for (let i = 81; i <= 160; i++) big.push({ t: i * 100, ep: 1, state: "D", run_ns: 80 * 99e6, wait_ns: 80e6, user_ticks: 0, sys_ticks: 800, call: sync });
  big[160]!.state = "R";
  const w = decide(big, { load: 18, pressure: { cpu: 4, io: 38 } }, 16_000);
  expect(shares(w)).toEqual([["fsync store log", 8000], ["compute", 7920], ["cpu_wait", 80]]);
  expect(w.text).toBe("8.0 s in fsync of the store's log (keel.db-wal) (IO pressure 38%), 7.9 s on a processor in the kernel, for system calls of its own");

  // More seen than the stall can hold (an idle loop measures short; the samples reach back before it): the parts sum to the stall.
  const stop = (t: number, gap?: Sample["gap"]): Sample => ({ t, ep: 3, state: gap ? "R" : "T", run_ns: 1, wait_ns: 0, user_ticks: 0, sys_ticks: 0, ...(gap ? { gap } : {}) });
  const idle = decide([stop(0), stop(4016, "stopped")], {}, 3086, 4086);
  expect([idle.sampled_ms, shares(idle)]).toEqual([4016, [["stopped", 4016]]]);
  const cut = decide([stop(0), stop(4016, "stopped")], {}, 3086, 3500);
  expect(shares(cut)).toEqual([["stopped", 3500]]);
  for (const d of [c, three, w, idle, cut]) expect(d.shares.reduce((n, x) => n + x.ms, 0)).toBeLessThanOrEqual(Math.max(d.sampled_ms, 1) + 1);
});

test("a beat is never the zero that means no loop is watched", () => {
  for (const seq of [0, 1, 0xfffff - 1, 0xfffff, 0x100000, 0x100000 * 7, 0x1fffff]) {
    expect(packBeat(seq, 0)).not.toBe(0);
    expect(packBeat(seq, 0)).toBeGreaterThan(0);
  }
  expect(packBeat(5, 100) & 2047).toBe(100);
  expect(packBeat(5, 100)).not.toBe(packBeat(6, 100));
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
  expect(decide([at(0), at(3100, "stopped")], { load: 9 }, 3000, 3150)).toMatchObject({ kind: "stopped", text: "3.1 s stopped (a stop signal, a debugger or a frozen unit)", run_ms: 0, wait_ms: 0 });
  // Every thread held in memory reclaim looks like a stop from inside (none runs, none waits for a processor): the unit's memory stall says which it was.
  expect(decide([at(0), at(31_000, "memory")], { pressure: { memory: 76 }, memory_unit: true }, 31_000)).toMatchObject({ kind: "memory", key: "memory", text: "31 s waiting for memory (its unit is over its memory limit)" });
  expect(decide([at(0), at(5_000, "memory")], { memory_unit: false }, 5_000).text).toBe("5.0 s waiting for memory (the machine is short of it)");
  // A pause in which the memory stall grew by less than half of it is not called a stop alone.
  expect(decide([at(0), at(4_100, "stopped")], { memory_stall_ms: 1_900 }, 4_100).text).toBe("4.1 s not running: stopped, or waiting for memory (the memory stall grew 1.9 s meanwhile)");
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

// The store's connection says which statement it is in (src/core/statement-label.ts): a stall in a read
// of the database, a wait for its write lock or a statement that computed is named by it.
test("a stall inside a statement of the store names the statement", () => {
  const read = { name: "pread64", on: placeOf("/home/u/.local/share/keel/state/keel.db", dirs) };
  const stmt = "SELECT id, seq, parent, kind, ts FROM events WHERE session_id = ? ORDER BY seq";
  const reading: Sample[] = [];
  for (let i = 0; i <= 27; i++) reading.push({ t: i * 100, ep: 1, state: "D", run_ns: 0, wait_ns: 0, user_ticks: 0, sys_ticks: 0, call: read, stmt });
  reading[27]!.state = "R";
  const c = decide(reading, { pressure: { io: 39 } }, 2700);
  expect(c.text).toBe(`2.7 s reading the store's database (keel.db), in the statement: ${stmt} (IO pressure 39%)`);
  expect(c.statement).toBe(stmt);
  // The row's key is the call and the file, as before: the statement is in its text, not in what groups it.
  expect(c.key).toBe("pread64 store");

  // A wait for the write lock: SQLite sleeps between its tries, in the transaction's own statement.
  const lock = "BEGIN (the start of a transaction: a write waits here for the store's write lock)";
  const waiting: Sample[] = [];
  for (let i = 0; i <= 10; i++) waiting.push({ t: i * 100, ep: 1, state: "S", run_ns: 0, wait_ns: 0, user_ticks: 0, sys_ticks: 0, call: { name: "clock_nanosleep" }, stmt: lock });
  waiting[10]!.state = "R";
  expect(decide(waiting, {}, 1000).text).toBe(`1.0 s sleeping (clock_nanosleep), in the statement: ${lock}`);

  // A statement that computed (a scan from memory): the statement is the code, and the row does not say the code is not visible.
  const scan: Sample[] = [];
  for (let i = 0; i <= 10; i++) scan.push({ t: i * 100, ep: 1, state: "R", run_ns: i * 100e6, wait_ns: 0, user_ticks: i * 10, sys_ticks: 0, stmt });
  const computed = decide(scan, {}, 1000);
  expect(computed.text).toBe(`1.0 s in its own code, in the statement: ${stmt}`);
  expect(computed.note).toBeUndefined();
  expect(computed.statement).toBe(stmt);
  // Outside any statement nothing is added.
  const plain = decide(scan.map(({ stmt: _, ...s }) => s), {}, 1000);
  expect(plain.text).toBe("1.0 s in its own code");
  expect(plain.note).toBe(UNSEEN);
});
