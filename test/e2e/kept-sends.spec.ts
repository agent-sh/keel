import { expect, test, type Page } from "./isolate.ts";
import { HAIKU, shoot } from "./shots.ts";

// Feature: what the page keeps of a message that did not go (the shelf above
// the box) stays right across tabs, reloads and a daemon that went away: a
// second tab's box gives up an image the kept send took, a deleted session
// leaves no kept words behind, a send whose tab was closed is not lost in the
// tabs still open, a kept image is read again after a failed read, the New
// session button says when its box holds a message that did not go, and an
// unconfirmed send clears itself once the transcript shows the message.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGM4YaOh0XOHAUIBACUCBXmhkn0oAAAAAElFTkSuQmCC";

const composer = (p: Page) => p.getByTestId("composer");
const saved = (p: Page) => p.getByTestId("saved-draft");
const boxImages = (p: Page) => p.getByTestId("attachments").locator("img");

// A session, an image in its draft, and a send of both that the daemon
// refuses after the owner typed on: the message is kept above the box with
// its image, and the box holds the newer words.
async function keptWithImage(page: Page, request: any, title: string) {
  const a = (await (await request.post("/api/sessions", { data: { model: HAIKU, title } })).json()).session.id as string;
  const messages = `/api/sessions/${a}/messages`;
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(messages, async (r) => {
    held.resolve();
    await release.promise;
    await r.fulfill({ status: 400, json: { error: "The daemon refused this message." } });
  }, { times: 1 });
  await page.goto(`/s/${a}`);
  expect((await request.post(`/api/sessions/${a}/draft`, { data: { images: [{ name: "first.png", mime: "image/png", data: PNG }], origin: "capture" } })).ok()).toBe(true);
  await expect(page.getByTestId("attachments").getByRole("img", { name: "first.png" })).toBeVisible();
  return {
    a,
    refuse: async () => {
      await composer(page).fill("With the first screenshot.");
      await composer(page).press("Enter");
      await held.promise;
      await composer(page).fill("Typed after it.");
      release.resolve();
      await expect(saved(page)).toContainText("first.png");
    },
  };
}

// EXTRA-S12. Two tabs on one session: both boxes show the draft's image. One
// tab's send is refused and kept with that image; the other tab's box gives
// it up, so its next message does not carry an image the kept send owns.
test("a second tab's box gives up an image the kept send took", async ({ page, context, request }) => {
  const other = await context.newPage();
  const k = await keptWithImage(page, request, "Kept image, two tabs");
  await other.goto(`/s/${k.a}`);
  await expect(other.getByTestId("attachments").getByRole("img", { name: "first.png" })).toBeVisible();
  await k.refuse();
  await expect(saved(other)).toContainText("first.png");
  await expect(boxImages(other)).toHaveCount(0);
  await expect(boxImages(page)).toHaveCount(0);
  // The other tab's next message goes without it.
  const sent = other.waitForRequest((r) => r.method() === "POST" && r.url().endsWith(`/api/sessions/${k.a}/messages`));
  await composer(other).fill("From the second tab.");
  await composer(other).press("Enter");
  expect((await sent).postDataJSON().images ?? []).toEqual([]);
  await expect(saved(other)).toContainText("first.png");
  await request.delete(`/api/sessions/${k.a}`);
});

// EXTRA-S13. A session deleted while no page was open leaves its kept sends
// and its typed draft in the browser's storage: the next load removes them
// (an archived session keeps its own), and a send that fails after its
// session was deleted is not written back.
test("what was kept for a deleted session is removed at the next load", async ({ page, request }) => {
  const mk = async (title: string) => (await (await request.post("/api/sessions", { data: { model: HAIKU, title } })).json()).session.id as string;
  const [open, gone, archived] = [await mk("Kept keys, open"), await mk("Kept keys, deleted"), await mk("Kept keys, archived")];
  await page.goto(`/s/${open}`);
  await page.evaluate((ids) => {
    for (const id of ids) {
      localStorage.setItem(`keel.sends.${id}`, JSON.stringify([{ id: `kept-${id}`, text: "kept words", images: [], queue: false, state: "refused", error: "refused" }]));
      localStorage.setItem(`keel.draft.${id}`, "typed words");
    }
  }, [gone, archived]);
  // No page is open while the one is deleted and the other archived.
  await page.goto("about:blank");
  await request.delete(`/api/sessions/${gone}`);
  expect((await request.patch(`/api/sessions/${archived}`, { data: { archived: true } })).ok()).toBe(true);
  const stored = (k: string) => page.evaluate((key) => localStorage.getItem(key), k);
  await page.goto(`/s/${open}`);
  await expect.poll(() => stored(`keel.sends.${gone}`)).toBeNull();
  await expect.poll(() => stored(`keel.draft.${gone}`)).toBeNull();
  expect(await stored(`keel.sends.${archived}`)).toContain("kept words");
  expect(await stored(`keel.draft.${archived}`)).toBe("typed words");

  // A send still out when its session is deleted: its failure writes nothing back.
  const messages = `/api/sessions/${open}/messages`;
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(messages, async (r) => {
    held.resolve();
    await release.promise;
    await r.fulfill({ status: 404, json: { error: "no such session" } });
  }, { times: 1 });
  await composer(page).fill("Sent just before the session went.");
  await composer(page).press("Enter");
  await held.promise;
  await request.delete(`/api/sessions/${open}`);
  await expect(page.locator(`[data-testid="session-row"][data-session="${open}"]`)).toHaveCount(0);
  const answered = page.waitForResponse((r) => r.url().endsWith(messages));
  release.resolve();
  await answered;
  await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  expect(await stored(`keel.sends.${open}`)).toBeNull();
  await request.delete(`/api/sessions/${archived}`);
});
