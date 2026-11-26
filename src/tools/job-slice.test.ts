import { expect, test } from "bun:test";
import { inSlice, jobSlice, memoryCap, memoryProps, memoryWords, MEMORY_DEFAULT, sizeText, SHARED_SLICE, sliceKeeper, SLICES, unattendedProps } from "./job-slice.ts";

test("a job is the owner's when he typed it or attends its turn, else unattended; unknown stays the owner's", () => {
  expect(jobSlice({ byOwner: true, attended: false })).toBe("owner");
  expect(jobSlice({ attended: true })).toBe("owner");
  expect(jobSlice({})).toBe("owner");
  expect(jobSlice({ attended: false })).toBe("unattended");
});

test("the unattended slice weighs what one job scope did, and a bad value falls back", () => {
  expect(unattendedProps({})).toEqual(["CPUWeight=50", "IOWeight=50"]);
  expect(unattendedProps({ KEEL_SANDBOX_CPU_WEIGHT: "20", KEEL_SANDBOX_IO_WEIGHT: "x" })).toEqual(["CPUWeight=20", "IOWeight=50"]);
});

test("a scope's command is put in a slice once, after systemd-run's head; anything else is left as it is", () => {
  const head = ["systemd-run", "--user", "--scope"];
  expect(inSlice([...head, "--slice=app.slice", "-p", "CPUWeight=50", "--", "bwrap", "x"], head, SLICES.unattended))
    .toEqual([...head, "--slice=app-keelunattended.slice", "-p", "CPUWeight=50", "--", "bwrap", "x"]);
  expect(inSlice(["bwrap", "x"], head, SLICES.unattended)).toEqual(["bwrap", "x"]);
  expect(inSlice([...head, "bash"], head, SLICES.unattended)).toEqual([...head, "bash"]);
});

test("the unattended memory cap is a size as systemd writes one, or 0 for none; anything else is refused", () => {
  const G = 1024 ** 3;
  expect(memoryCap(MEMORY_DEFAULT)).toEqual({ bytes: 24 * G });
  expect(memoryCap("512M")).toEqual({ bytes: 512 * 1024 ** 2 });
  expect(memoryCap(" 1.5gb ")).toEqual({ bytes: 1.5 * G });
  expect(memoryCap("2T")).toEqual({ bytes: 2 * 1024 ** 4 });
  expect(memoryCap("4096")).toEqual({ bytes: 4096 });
  expect(memoryCap(4096)).toEqual({ bytes: 4096 });
  expect(memoryCap("0")).toEqual({ bytes: null });
  expect(memoryCap(0)).toEqual({ bytes: null });
  for (const bad of ["", "24 X", "-1G", "0.0001", "24GiB", "50%", null, true, {}, "infinity"]) expect(memoryCap(bad)).toHaveProperty("error");
});

test("a cap is MemoryMax with MemoryHigh a little under it and no swap; no cap sets each back to infinity", () => {
  const G = 1024 ** 3;
  expect(memoryProps(24 * G)).toEqual([`MemoryMax=${24 * G}`, `MemoryHigh=${24 * G - 0.75 * G}`, "MemorySwapMax=0"]);
  expect(memoryProps(null)).toEqual(["MemoryMax=infinity", "MemoryHigh=infinity", "MemorySwapMax=infinity"]);
  expect(sizeText(24 * G)).toBe("24 GB");
  expect(sizeText(1.5 * G)).toBe("1.5 GB");
  expect(memoryWords(1, 24 * G)).toStartWith("Killed for memory: the kernel ended a process of this command");
  expect(memoryWords(2, 24 * G)).toContain("a memory cap of 24 GB");
  expect(memoryWords(3)).not.toContain("cap");
});

test("only the owner's daemon changes the shared slice: the default state folder, or keel-bun.service's main process", () => {
  const d = "/home/u/.local/state/keel-bun";
  expect(sliceKeeper({ stateDir: d, defaultDir: d, pid: 10 })).toBeUndefined();
  expect(sliceKeeper({ stateDir: "/home/u/.local/share/keel-bun/state", defaultDir: d, pid: 10, unitPid: 10 })).toBeUndefined();
  // dev.sh, smoke.sh and the command line e2e: a folder of their own, not the unit's process
  expect(sliceKeeper({ stateDir: "/home/u/.cache/keel-work/bun/dev-4100/state", defaultDir: d, pid: 11, unitPid: 10 })).toBe(SHARED_SLICE);
  expect(sliceKeeper({ stateDir: "/x/state", defaultDir: d, pid: 11, unitPid: 0 })).toBe(SHARED_SLICE);
  expect(sliceKeeper({ stateDir: "/x/state", defaultDir: d, pid: 11 })).toBe(SHARED_SLICE);
  expect(sliceKeeper({ defaultDir: d, pid: 10, unitPid: 10 })).toContain("no daemon named its state folder");
});
