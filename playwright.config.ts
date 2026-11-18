import { defineConfig } from "@playwright/test";

// One e2e per feature, driving the real daemon and a real model (Haiku, the
// cheapest listed), with screenshots in both themes saved for review.
export default defineConfig({
  testDir: "test/e2e",
  outputDir: `${process.env.HOME}/.cache/keel-work/bun/e2e-out`,
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.KEEL_URL ?? "http://127.0.0.1:47961",
    viewport: { width: 1920, height: 1040 },
    headless: true,
    trace: "retain-on-failure",
  },
});
