import { expect, test } from "bun:test";
import { isScratch } from "../test/e2e/scratch.ts";

// The e2e fixture removes the sessions a test made. It does so only on a
// scratch daemon, told from what the daemon says of itself: a daemon somebody
// works on, reached by a mistaken KEEL_URL, keeps every session.
test("the e2e fixture takes only a scripted or a dev daemon with its own state folder for scratch", () => {
  const home = "/home/someone";
  // A daemon in use: the built binary, the default state folder or one of its owner's choosing.
  expect(isScratch({ argv: ["/usr/bin/keel", "serve"], state_dir: `${home}/.local/state/keel-bun`, home, providers: ["anthropic", "openai"] })).toBe(false);
  expect(isScratch({ argv: ["/usr/bin/keel", "serve", "--state-dir", "/data/keel"], state_dir: "/data/keel", home, providers: ["bedrock"] })).toBe(false);
  // A dev daemon on the default state folder is somebody's too.
  expect(isScratch({ argv: ["bun", "--hot", "src/main.ts", "serve", "--dev"], state_dir: `${home}/.local/state/keel-bun/`, home, providers: ["bedrock"] })).toBe(false);
  // What the daemon did not say counts against it.
  expect(isScratch({})).toBe(false);
  expect(isScratch({ argv: ["bun", "src/main.ts", "serve", "--dev"], providers: [] })).toBe(false);
  // Scratch: the dev script's daemon (a state folder of its own), and any daemon with the scripted provider.
  expect(isScratch({ argv: ["bun", "--hot", "src/main.ts", "serve", "--dev", "--state-dir", "/scratch/dev/state"], state_dir: "/scratch/dev/state", home, providers: ["bedrock"] })).toBe(true);
  expect(isScratch({ argv: ["/usr/bin/keel", "serve"], state_dir: `${home}/.local/state/keel-bun`, home, providers: ["scripted", "acp"] })).toBe(true);
});
