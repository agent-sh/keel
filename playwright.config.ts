import { defineConfig } from "@playwright/test";

// One e2e per feature, driving the real daemon and a real model (Haiku, the
// cheapest listed), with screenshots in both themes saved for review.
// The daemon under test is named every time (KEEL_URL): specs change daemon-wide
// settings while they run (a spend limit, the permission mode), so a default
// address would put them on whatever daemon a person is using there.
const url = process.env.KEEL_URL;
if (!url) throw new Error("Set KEEL_URL to the scratch dev daemon the specs drive (scripts/dev.sh <port>), e.g. KEEL_URL=http://127.0.0.1:<port>.");

// Playwright empties its output folder when a run starts, traces included. Each
// daemon gets its own folder (one run per daemon at a time, since specs change
// its settings), and no folder sits inside another run's: a run with a shared
// or parent folder deletes the traces of a run still writing them (ENOENT on
// a .trace or .network file at context close).
const outputDir = `${process.env.HOME}/.cache/keel-work/bun/e2e-out/${new URL(url).port || "80"}`;

export default defineConfig({
  testDir: "test/e2e",
  outputDir,
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: url,
    viewport: { width: 1920, height: 1040 },
    headless: true,
    trace: "retain-on-failure",
    // Specs drive one session at a time: the bridge shows only the helm
    // (focus mode). bridge.spec.ts clears this to drive several stations.
    storageState: { cookies: [], origins: [{ origin: new URL(url).origin, localStorage: [{ name: "keel.focus", value: "true" }] }] },
  },
});
