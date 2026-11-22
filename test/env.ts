// A test file's own settings of the environment: set now, put back when the
// file ends. The environment is the process's, and every test file of a run
// shares the process, so a setting left behind is every later file's. Which
// files come later is the order of the folder on the disk: it differs from one
// machine to the next (test/preload.ts names a file that leaves one).
import { afterAll } from "bun:test";

// `undefined` unsets a variable for the file.
export function ownEnv(set: Record<string, string | undefined>): void {
  const before = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]));
  const put = (to: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(to)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  };
  put(set);
  afterAll(() => put(before));
}
