import { expect, test } from "bun:test";
import { inSlice, jobSlice, SLICES, unattendedProps } from "./job-slice.ts";

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
