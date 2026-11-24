import { expect, read, restore, test } from "./isolate.ts";

// The fixture every spec runs under (isolate.ts) puts changed daemon settings
// back after a test. A restoration the daemon refuses fails that test and
// names the endpoint and the status; one that works says nothing.
test("a refused settings restoration fails the test, a working one is quiet", async ({ request }) => {
  const path = "/api/permissions/settings";
  const before = await read(request);
  const mode = before[path]!.default_mode as string;
  const other = mode === "full-auto" ? "ask" : "full-auto";
  expect((await request.put(path, { data: { default_mode: other } })).ok()).toBe(true);

  // The daemon answers 500 to the write that restores.
  const writes: string[] = [];
  const refusing = {
    get: request.get.bind(request),
    put: request.put.bind(request),
    delete: request.delete.bind(request),
    fetch: (async (url: string, o: { method?: string }) => { writes.push(`${o.method} ${url}`); return { ok: () => false, status: () => 500 }; }) as any,
  };
  await expect(restore(refusing, before)).rejects.toThrow(`The daemon's settings were not put back after this test: PUT ${path} answered 500`);
  expect(writes).toEqual([`PUT ${path}`]);
  expect((await (await request.get(path)).json()).default_mode).toBe(other);

  // And one that does not get through at all.
  const cut = { ...refusing, fetch: (async () => { throw new Error("socket hang up"); }) as any };
  await expect(restore(cut, before)).rejects.toThrow(`PUT ${path} did not get through: socket hang up`);

  // The real daemon takes it: nothing is thrown, and the setting is back.
  await restore(request, before);
  expect((await (await request.get(path)).json()).default_mode).toBe(mode);
  // Nothing left to restore: no write at all.
  writes.length = 0;
  await restore(refusing, before);
  expect(writes).toEqual([]);
});

// The page fixture fails a test whose page the browser reported an observer loop on ("ResizeObserver loop
// completed with undelivered notifications"). This page makes one on purpose, so the test is expected to fail,
// and passes only while the fixture does fail it.
test("a page that resizes what its observer watches, inside the call, fails its test", async ({ page }) => {
  test.fail();
  await page.goto("/");
  await page.evaluate(() => new Promise<void>((done) => {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;top:0;left:0;height:10px;width:50px";
    document.body.append(box);
    let w = 50;
    const ro = new ResizeObserver(() => { w += 1; box.style.width = `${w}px`; });
    ro.observe(box);
    setTimeout(() => { ro.disconnect(); box.remove(); done(); }, 500);
  }));
});
