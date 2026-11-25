import { expect, test } from "bun:test";
import { readProcs } from "./proc-read.ts";

const live = process.platform === "linux";

// The sampler's reads of /proc, as the read thread runs them.
test.skipIf(!live)("a child is found with its command line, and its environment is read once", async () => {
  const kid = Bun.spawn(["sleep", "30"], { env: { ...process.env, KEEL_SESSION: "s-test" } });
  try {
    // The child can be seen between the new command line and the new name of its exec (the
    // name then is still its parent's): read until the name is the program's own, as a pass
    // of the sampler would a moment later.
    let first = readProcs({ self: process.pid, jobs: [], seen: [] });
    for (let i = 0; i < 200 && first.procs.find((p) => p.pid === kid.pid)?.name !== "sleep"; i++) {
      await Bun.sleep(5);
      first = readProcs({ self: process.pid, jobs: [], seen: [] });
    }
    const one = first.procs.find((p) => p.pid === kid.pid);
    expect(one?.cmdline.split("\0").filter(Boolean)).toEqual(["sleep", "30"]);
    expect(one?.ppid).toBe(process.pid);
    expect(one?.env?.session).toBe("s-test");
    // Seen under the same name: nothing of its environment is read again.
    const again = readProcs({ self: process.pid, jobs: [], seen: [[kid.pid, one!.name]] });
    expect(again.procs.find((p) => p.pid === kid.pid)?.env).toBeUndefined();
    // Seen under another name (it ran another program): read again.
    const renamed = readProcs({ self: process.pid, jobs: [], seen: [[kid.pid, "bash"]] });
    expect(renamed.procs.find((p) => p.pid === kid.pid)?.env?.session).toBe("s-test");
  } finally {
    kid.kill();
    await kid.exited;
  }
});

test.skipIf(!live)("a job with no cgroup is found by its leader, and its children are its own", async () => {
  const kid = Bun.spawn(["bash", "-c", "sleep 30 & wait"]);
  try {
    let got = readProcs({ self: process.pid, jobs: [{ id: "j1", pid: kid.pid }], seen: [] });
    for (let i = 0; i < 50 && !got.jobOf.some(([pid]) => pid !== kid.pid); i++) {
      await Bun.sleep(20);
      got = readProcs({ self: process.pid, jobs: [{ id: "j1", pid: kid.pid }], seen: [] });
    }
    expect(got.jobOf.every(([, id]) => id === "j1")).toBe(true);
    expect(got.jobOf.length).toBeGreaterThanOrEqual(2);
    expect(got.cgroups).toEqual([null]);
    expect(got.pids).toContain(kid.pid);
  } finally {
    kid.kill();
    await kid.exited;
  }
});
