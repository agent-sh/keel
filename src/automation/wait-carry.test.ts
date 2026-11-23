import { expect, test } from "bun:test";
import { CARRY_MAX, carryText, jobLine, stalled, waitingProc, writesPath } from "./wait-carry.ts";

test("the job that writes a waited file: a redirection or tee into it, with ~, $HOME and the command's own variables put in", () => {
  const at = (cmd: string, path = "/h/w/logs/e2e.log") => writesPath(cmd, "/h/repo", "/h", path);
  expect(at("bunx playwright test > ~/w/logs/e2e.log 2>&1")).toBe(true);
  expect(at("S=~/w; scripts/smoke.sh >> $S/logs/e2e.log 2>&1")).toBe(true);
  expect(at('L="$HOME/w/logs"; bun test 2>&1 | tee -a ${L}/e2e.log')).toBe(true);
  expect(at("bun test &> ../w/logs/e2e.log", "/h/w/logs/e2e.log")).toBe(true);
  expect(at("bun test > logs/e2e.log", "/h/repo/logs/e2e.log")).toBe(true);
  // A command that reads it, one that writes another file, a variable not known here: not its writer.
  expect(at("tail -5 ~/w/logs/e2e.log")).toBe(false);
  expect(at("bun test > ~/w/logs/e2e.log.old")).toBe(false);
  expect(at("bun test > $OUT/e2e.log")).toBe(false);
});

test("what a wake carries of a file: what it gained, its end when more, cut at a line's start, with where the rest is", () => {
  const base = { path: "/x/log", from: 10, size: 40, fromStart: false, unchanged: false, binary: false };
  expect(carryText({ ...base, text: "ok 1\nok 2\n" })).toBe("What /x/log gained since the wait began (from byte 10 of 40):\nok 1\nok 2");
  expect(carryText({ ...base, fromStart: true, from: 0, text: "all\n" })).toBe("/x/log (40 bytes):\nall");
  expect(carryText({ ...base, text: "" })).toBe("Nothing was added to /x/log since the wait began.");
  expect(carryText({ ...base, unchanged: true, text: "end\n" })).toStartWith("The end of /x/log (nothing was added since the wait began):");
  expect(carryText({ ...base, binary: true, text: "" })).toBe("/x/log holds binary data (40 bytes): it is not carried.");
  const lines = Array.from({ length: 4000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const big = carryText({ ...base, size: lines.length, text: lines });
  const body = big.split("\n").slice(2).join("\n");
  expect(body.length).toBeLessThanOrEqual(CARRY_MAX);
  expect(body).toStartWith("line ");
  expect(body).toEndWith(`line 3999 ${"x".repeat(20)}`);
  expect(big.split("\n")[1]).toMatch(/^\[\d+ characters before this are not carried: Read the file for them\]$/);
  // Bytes the read left out before what it read are said too, and a line it began inside of is not carried in part.
  expect(carryText({ ...base, text: "tail of a line\nwhole\n", skipped: 500 })).toBe("What /x/log gained since the wait began (from byte 10 of 40):\n[500 bytes and 15 characters before this are not carried: Read the file for them]\nwhole");
});

test("what is known of the job, in a line", () => {
  const now = 10 * 60_000;
  const j = { id: "b1", command: "bun test  ./x\n", started: 0, running: true, live: true, lastOutput: now - 30_000 };
  expect(jobLine(j, now)).toBe("Job b1 (`bun test ./x`) that writes it is running, for 10 min, its last output 30 s ago.");
  expect(jobLine({ ...j, running: false, live: false, exit: 1, ended: now - 120_000 }, now)).toBe("Job b1 (`bun test ./x`) that writes it ended 2 min ago (exit 1), its last output 30 s ago.");
  expect(jobLine({ ...j, running: false, live: true, exit: 0, ended: now - 1000, lastOutput: undefined }, now)).toBe("Job b1 (`bun test ./x`) that writes it ended 1 s ago (exit 0); processes it started still run.");
});

test("a stall: quiet past its time, and no process of it waits on something else", () => {
  expect(stalled({ now: 1000, since: 0, waiting: false, after: 1000 })).toBe(true);
  expect(stalled({ now: 999, since: 0, waiting: false, after: 1000 })).toBe(false);
  expect(stalled({ now: 5000, since: 0, waiting: true, after: 1000 })).toBe(false);
});

test("a job's process that waits on something is not stuck: a timer, the network, a lock, the disk, a child moved out of its cgroup", () => {
  const t = (o: Partial<Parameters<typeof waitingProc>[0]["threads"][0]>) => ({ state: "S", wchan: "", ...o });
  const p = (o: Partial<Parameters<typeof waitingProc>[0]["threads"][0]> = {}, more: Partial<Parameters<typeof waitingProc>[0]> = {}) => waitingProc({ comm: "python3", threads: [t(o)], childOutside: false, ...more });
  for (const wchan of ["hrtimer_nanosleep", "do_nanosleep", "do_epoll_wait", "ep_poll", "do_sys_poll", "do_select", "poll_schedule_timeout.constprop.0", "inet_csk_accept", "sk_wait_data", "unix_stream_read_generic", "locks_lock_inode_wait"]) expect([wchan, p({ wchan })]).toEqual([wchan, true]);
  expect(p({ state: "D" })).toBe(true);
  expect(p({ wchan: "do_wait" }, { comm: "bash", childOutside: true })).toBe(true);
  expect(p({}, { comm: "ssh" })).toBe(true);
  // A blocking read of a socket waits on the other end; one of a terminal waits for a person.
  expect(p({ wchan: "wait_woken", fd: "socket:[4242]" })).toBe(true);
  expect(p({ wchan: "wait_woken", fd: "/dev/pts/7" })).toBe(false);
  // A named FIFO another program writes; the job's own pipe, whose writer is in the job.
  expect(p({ wchan: "pipe_wait_readable", fd: "/w/ff", fifo: true })).toBe(true);
  expect(p({ wchan: "pipe_wait_readable", fd: "pipe:[77]", fifo: false })).toBe(false);
  expect(p({ wchan: "anon_pipe_read", fd: "/w/ff", fifo: true })).toBe(true);
  expect(p({ wchan: "anon_pipe_read", fd: "pipe:[78]", fifo: false })).toBe(false);
  // A thread held on a file the daemon cannot read is not called stuck.
  expect(p({ wchan: "wait_woken" })).toBe(true);
  expect(p({ wchan: "anon_pipe_read" })).toBe(true);
  // A main thread that joins a sleeping thread: the sleeper says it waits.
  expect(waitingProc({ comm: "python3", threads: [t({ wchan: "futex_do_wait" }), t({ wchan: "hrtimer_nanosleep" })], childOutside: false })).toBe(true);
  // A shell waiting on its own command, a deadlock, a stopped process: not waiting on anything outside.
  for (const wchan of ["do_wait", "futex_do_wait", "futex_wait_queue", "do_signal_stop", "0", ""]) expect([wchan, p({ wchan })]).toEqual([wchan, false]);
});

test("a writer's open file, its end, and a wait it leaves spent", async () => {
  const { opensForWrite, writerGone, spentAtTurnEnd, othersText, WRITER_GRACE_MS } = await import("./wait-carry.ts");
  // (fdinfo flags in octal: O_WRONLY 01, O_RDWR 02, with O_APPEND, O_LARGEFILE and O_CLOEXEC set.)
  expect(["0100001", "02102001", "02", "0102002"].map(opensForWrite)).toEqual([true, true, true, true]);
  expect(["0100000", "02100000", "", "zz"].map(opensForWrite)).toEqual([false, false, false, false]);
  const now = 100_000;
  expect(writerGone({ running: false, alive: false, ended: now - WRITER_GRACE_MS, now })).toBe(true);
  expect(writerGone({ running: false, alive: false, ended: now - 10, now })).toBe(false);
  expect(writerGone({ running: false, alive: true, ended: now - 60_000, now })).toBe(false);
  expect(writerGone({ running: true, alive: true, now })).toBe(false);
  expect(spentAtTurnEnd({ ended: 5, alive: false, told: true })).toBe(true);
  expect(spentAtTurnEnd({ ended: 5, alive: false, told: false })).toBe(false);
  expect(spentAtTurnEnd({ ended: 5, alive: true, told: true })).toBe(false);
  expect(spentAtTurnEnd({ alive: false, told: true })).toBe(false);
  const clock = () => "12:30";
  expect(othersText([], "TaskStop", clock)).toBe("");
  expect(othersText([{ id: "a1", kind: "timer", due: 1, note: 'check "runs"\n' }, { id: "b2", kind: "log" }], "cancel_wait", clock))
    .toBe('Still set: timer wait a1 (due 12:30, "check runs"), log wait b2. If this wake is what one of them waited for, cancel it with cancel_wait in this turn\'s calls: a wait left set wakes you again, after your report too.');
  const many = Array.from({ length: 7 }, (_, i) => ({ id: `w${i}`, kind: "file" }));
  expect(othersText(many, "TaskStop", clock)).toContain("file wait w4 and 2 more.");
});
