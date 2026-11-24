import { expect, test } from "./isolate.ts";
import { HAIKU, shoot } from "./shots.ts";

// Feature: the sandbox's syscall filter state is shown beside the sandbox's own state, in the
// permission menu and on the network page. The scripted daemon's sandbox reports no filter, so the
// daemon's two answers are given the filter's fields here, as a daemon that has the filter sends them.
test("sandbox filter: its state in the permission menu and the network page", async ({ page, request }) => {
  const { session } = await (await request.post("/api/sessions", { data: { model: HAIKU } })).json();
  for (const [seccomp, reason, shot] of [[true, undefined, "on"], [false, "bwrap refused --seccomp", "off"]] as const) {
    const filter = { available: true, seccomp, ...(reason ? { seccompReason: reason } : {}) };
    await page.route("**/api/permissions/settings", async (route) => {
      const r = await route.fetch();
      const j = await r.json();
      await route.fulfill({ response: r, json: { ...j, sandbox: { ...j.sandbox, ...filter } } });
    });
    await page.route("**/api/egress?*", async (route) => {
      const r = await route.fetch();
      const j = await r.json();
      await route.fulfill({ response: r, json: { ...j, sandbox: { ...j.sandbox, default: "workspace-write", ...filter } } });
    });
    await page.goto(`/s/${session.id}`);
    await page.getByTestId("permission-menu").click();
    const said = page.getByTestId("sandbox-filter");
    await expect(said).toContainText(seccomp ? "syscall filter is on" : "syscall filter is off: bwrap refused --seccomp");
    await shoot(page, `sandbox-filter-${shot}-menu`);
    await page.keyboard.press("Escape");
    await page.goto("/settings/network");
    await expect(page.getByTestId("network-unseen")).toContainText(seccomp ? "syscall filter is on" : "syscall filter is off: bwrap refused --seccomp");
    await shoot(page, `sandbox-filter-${shot}-network`);
    await page.unrouteAll();
  }
});
