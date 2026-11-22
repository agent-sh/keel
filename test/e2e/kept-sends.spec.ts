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
  const elsewhere = "01a1ffff-0000-7000-8000-00000000e2e0"; // a session this daemon's answer cannot be read about
  await page.goto(`/s/${open}`);
  await page.evaluate((ids) => {
    for (const id of ids) {
      localStorage.setItem(`keel.sends.${id}`, JSON.stringify([{ id: `kept-${id}`, text: "kept words", images: [], queue: false, state: "refused", error: "refused" }]));
      localStorage.setItem(`keel.draft.${id}`, "typed words");
    }
  }, [gone, archived, elsewhere]);
  // A 404 that is not the daemon's own word on the session (a proxy's, or another daemon on
  // this address that never held it) says nothing about it.
  await page.route(`**/api/sessions/${elsewhere}/draft`, (r) => r.fulfill({ status: 404, json: { error: "not found" } }));
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
  expect(await stored(`keel.sends.${elsewhere}`)).toContain("kept words");
  expect(await stored(`keel.draft.${elsewhere}`)).toBe("typed words");

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

// EXTRA-S14. A send whose tab is closed before the daemon answered is not
// left hidden in the tabs still open: a session's message goes out from one
// of them under its own id (the daemon takes it once), and a first message of
// the New box, which has no id, shows as unconfirmed.
test("a send whose tab was closed is taken up by a tab still open", async ({ page, context, request }) => {
  const a = (await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Send from a closed tab" } })).json()).session.id as string;
  const other = await context.newPage();
  await page.goto(`/s/${a}`);
  await other.goto(`/s/${a}`);
  await expect(composer(other)).toBeVisible();
  // The first tab's request is held and never reaches the daemon (held for the whole
  // context: a page's own routes are let through when it closes).
  const held = Promise.withResolvers<void>();
  const seen: string[] = [];
  await context.route(`**/api/sessions/${a}/messages`, (r) => {
    const first = r.request().frame().page() === page;
    seen.push(`${first ? "first" : "other"} ${r.request().postDataJSON().client_id}`);
    return first ? held.resolve() : r.fallback();
  });
  await composer(page).fill("Sent from a tab that was closed.");
  await composer(page).press("Enter");
  await held.promise;
  // While that tab lives its send is its own: the other tab shows nothing and sends nothing.
  await other.evaluate(() => new Promise((r) => setTimeout(r, 500)));
  await expect(saved(other)).toHaveCount(0);
  await page.close();
  // The tab still open sends it itself, under the id it was first sent with.
  await expect.poll(() => seen.filter((x) => x.startsWith("other ")), { timeout: 20_000 }).toEqual([seen[0]!.replace("first ", "other ")]);
  await expect(other.getByTestId("user-message").filter({ hasText: "Sent from a tab that was closed." })).toHaveCount(1, { timeout: 20_000 });
  await expect(saved(other)).toHaveCount(0);
  const texts = (await (await request.get(`/api/sessions/${a}`)).json()).events.filter((e: any) => e.kind === "user").map((e: any) => e.data.text);
  expect(texts).toEqual(["Sent from a tab that was closed."]);

  // The New box: its create has no id, so the tab still open says it is unconfirmed.
  const first = await context.newPage();
  await first.goto("/");
  await other.goto("/");
  const heldNew = Promise.withResolvers<void>();
  await context.route("**/api/sessions", (r) => (r.request().method() === "POST" && r.request().frame().page() === first ? heldNew.resolve() : r.fallback()));
  await first.getByTestId("new-composer").getByTestId("composer").fill("A first message from a tab that was closed.");
  await first.getByTestId("new-composer").getByTestId("composer").press("Enter");
  await heldNew.promise;
  await first.close();
  const kept = other.getByTestId("new-composer").getByTestId("saved-draft");
  await expect(kept).toHaveAttribute("data-state", "unconfirmed", { timeout: 15_000 });
  await expect(kept).toContainText("A first message from a tab that was closed.");
  await expect(kept.getByTestId("saved-reason")).toHaveText("The page that sent this went away before the daemon answered.");
  await kept.getByRole("button", { name: "Discard" }).click();
  await request.delete(`/api/sessions/${a}`);
});

// A browser that has Web Locks and refuses them to the page: a send the
// reload cut is not left hidden for good. The page that loads takes it for
// cut, as a browser without Web Locks does, and sends it again under its id.
test("a send cut by a reload goes out again where the browser refuses the lock", async ({ page, request }) => {
  const a = (await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Send cut, no lock" } })).json()).session.id as string;
  await page.addInitScript((sid) => {
    navigator.locks.request = (() => Promise.reject(new DOMException("no lock manager for this page", "SecurityError"))) as typeof navigator.locks.request;
    if (!sessionStorage.getItem("seeded")) localStorage.setItem(`keel.sends.${sid}`, JSON.stringify([{ id: "cut-by-reload", text: "Sent just before the reload.", images: [], queue: false, state: "sending" }]));
    sessionStorage.setItem("seeded", "1");
  }, a);
  await page.goto(`/s/${a}`);
  await expect(page.getByTestId("user-message").filter({ hasText: "Sent just before the reload." })).toHaveCount(1, { timeout: 20_000 });
  await expect(saved(page)).toHaveCount(0);
  expect((await (await request.get(`/api/sessions/${a}/sends/cut-by-reload`)).json()).stored).toBe(true);
  await request.delete(`/api/sessions/${a}`);
});

// EXTRA-S15. After a reload a kept send's image is read back from the
// session's draft. A read that failed (the daemon was restarting) is made
// again when the page reconnects: until then Retry and Restore wait.
test("a kept image that could not be read is read again on reconnect", async ({ page, request }) => {
  let cut: (() => void) | undefined;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => ws.send(m));
    ws.onMessage((m) => server.send(m));
    cut = () => { ws.close({ code: 4000, reason: "cut by the test" }); server.close({ code: 1000 }); };
  });
  const k = await keptWithImage(page, request, "Kept image, failed read");
  await k.refuse();
  let fail = true;
  await page.route(`**/api/sessions/${k.a}/draft/files/*`, (r) => (fail && r.request().method() === "GET" ? r.fulfill({ status: 503, body: "restarting" }) : r.fallback()));
  await page.reload();
  const retry = saved(page).getByRole("button", { name: "Retry send" });
  await expect(saved(page)).toContainText("first.png");
  await expect(retry).toBeDisabled();
  await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
  await expect(retry).toBeDisabled();
  fail = false;
  cut!();
  await expect(retry).toBeEnabled({ timeout: 20_000 });
  await expect(saved(page).getByRole("button", { name: "Restore draft" })).toBeEnabled();
  await request.delete(`/api/sessions/${k.a}`);
});

// EXTRA-S16. A first message the daemon refused after the owner moved on is
// kept in the New box, which nobody is looking at: the New session button
// carries the mark, with the list open and folded, until the item is gone.
test("the New session button marks a message kept in the New box", async ({ page, request }) => {
  const elsewhere = (await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Elsewhere meanwhile" } })).json()).session.id as string;
  const go = Promise.withResolvers<void>();
  await page.route("**/api/sessions", async (r) => {
    if (r.request().method() !== "POST") return r.fallback();
    await go.promise;
    await r.continue({ postData: JSON.stringify({ ...r.request().postDataJSON(), workspace: "/nonexistent/keel-e2e" }) });
  });
  await page.goto("/");
  const box = page.getByTestId("new-composer");
  const button = page.getByTestId("new-session");
  const mark = button.getByTestId("new-unsent-mark");
  await expect(mark).toHaveCount(0);
  await box.getByTestId("composer").fill("Start in a folder that is gone.");
  await box.getByTestId("composer").press("Enter");
  // The owner moved on before the answer came.
  await page.locator(`[data-testid="session-row"][data-session="${elsewhere}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/s/${elsewhere}`));
  const refused = page.waitForResponse((r) => r.url().endsWith("/api/sessions") && r.request().method() === "POST" && r.status() === 400);
  go.resolve();
  await refused;
  await expect(mark).toHaveText("not sent");
  await expect(button).toHaveAccessibleName("New session, a first message was not sent");
  await shoot(page, "kept-01-new-session-mark");
  // Folded, the button keeps a mark of its own.
  await page.getByRole("button", { name: "Fold the session list" }).click();
  await expect(mark).toBeVisible();
  await shoot(page, "kept-02-new-session-mark-folded");
  await page.getByRole("button", { name: "Show the session list" }).click();
  // The item is where the mark says, and discarding it clears the mark.
  await button.click();
  await expect(box.getByTestId("saved-draft")).toContainText("Start in a folder that is gone.");
  await box.getByTestId("saved-draft").getByRole("button", { name: "Discard" }).click();
  await expect(mark).toHaveCount(0);
  await expect(button).toHaveAccessibleName("New session");
  await request.delete(`/api/sessions/${elsewhere}`);
});

// EXTRA-S17. A message whose answer was lost after the daemon took it shows
// as unconfirmed. The daemon keeps what it stored under each send's own id:
// once it says it holds this one, the item says nothing the owner needs and
// goes, with its mark on the row. A send is never taken for delivered by its
// words: one that did not arrive stays, also when the same words arrived
// under another send.
test("an unconfirmed send clears itself once the daemon holds it, by its id and not its words", async ({ page, request }) => {
  const a = (await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Unconfirmed, then seen" } })).json()).session.id as string;
  const messages = `/api/sessions/${a}/messages`;
  const row = page.locator(`[data-testid="session-row"][data-session="${a}"]`);
  // What the daemon holds of a send, asked by its id.
  expect(await (await request.get(`/api/sessions/${a}/sends/never-sent`)).json()).toEqual({ stored: false });
  await page.goto(`/s/${a}`);
  const ids: string[] = [];
  await page.route(messages, async (r) => {
    ids.push(r.request().postDataJSON().client_id);
    expect((await r.fetch()).status()).toBe(201);
    await r.fulfill({ status: 502, json: { error: "The proxy lost the daemon." } });
  }, { times: 1 });
  await composer(page).fill("Arrived, though nobody said so.");
  await composer(page).press("Enter");
  await expect(page.getByTestId("user-message").filter({ hasText: "Arrived, though nobody said so." })).toHaveCount(1);
  await expect(saved(page)).toHaveCount(0);
  await expect(row).not.toHaveAttribute("data-watch", "need");
  await expect(page.getByTestId("turn-end")).toHaveCount(1, { timeout: 30_000 });
  expect((await (await request.get(`/api/sessions/${a}/sends/${ids[0]}`)).json()).stored).toBe(true);

  // The same words twice: the first is still out when the second fails without reaching the daemon.
  // The first then arrives. Its prompt is not the second's: the second stays for the owner.
  const late = Promise.withResolvers<void>();
  let posts = 0;
  await page.route(messages, async (r) => {
    if (++posts === 1) { await late.promise; return r.fallback(); }
    await r.fulfill({ status: 502, json: { error: "The proxy lost the daemon." } });
  });
  await composer(page).fill("continue");
  await composer(page).press("Enter");
  await expect.poll(() => posts).toBe(1);
  await composer(page).fill("continue");
  await composer(page).press("Enter");
  await expect(saved(page)).toContainText("Delivery unconfirmed");
  late.resolve();
  await expect(page.getByTestId("user-message").filter({ hasText: "continue" })).toHaveCount(1);
  await expect(page.getByTestId("turn-end")).toHaveCount(2, { timeout: 30_000 });
  await expect(saved(page)).toHaveCount(1);
  await expect(saved(page)).toContainText("Delivery unconfirmed");
  await expect(row).toHaveAttribute("data-watch", "need");
  await expect(row.getByTestId("row-why")).toHaveText("A message's delivery is unconfirmed");
  const texts = (await (await request.get(`/api/sessions/${a}`)).json()).events.filter((e: any) => e.kind === "user").map((e: any) => e.data.text);
  expect(texts).toEqual(["Arrived, though nobody said so.", "continue"]);
  await request.delete(`/api/sessions/${a}`);
});

// One question about a send is out at a time. A prompt that arrives while an
// earlier answer ("not stored") is still on its way is asked about when that
// answer returns: it was given before the prompt, and nothing else would ask
// again until the session's next message or a reconnect.
test("a send that arrives while an earlier question about it is out is asked about again", async ({ page, request }) => {
  const a = (await (await request.post("/api/sessions", { data: { model: HAIKU, title: "Asked too early" } })).json()).session.id as string;
  const messages = `/api/sessions/${a}/messages`;
  await page.goto(`/s/${a}`);
  // The message does not reach the daemon yet, and the page is told the proxy lost it.
  let body: Record<string, unknown> | undefined;
  await page.route(messages, async (r) => {
    body = r.request().postDataJSON();
    await r.fulfill({ status: 502, json: { error: "The proxy lost the daemon." } });
  }, { times: 1 });
  // The page's first question about it is answered by the daemon ("not stored") and held on its way back.
  const back = Promise.withResolvers<void>();
  let questions = 0;
  await page.route(`**/api/sessions/${a}/sends/*`, async (r) => {
    if (++questions > 1) return r.fallback();
    const answer = await r.fetch();
    expect(await answer.json()).toEqual({ stored: false });
    await back.promise;
    await r.fulfill({ response: answer });
  });
  await composer(page).fill("Late, but it got there.");
  await composer(page).press("Enter");
  await expect(saved(page)).toContainText("Delivery unconfirmed");
  await expect.poll(() => questions).toBe(1);
  // Now it arrives, under the same send id, while that answer is still out.
  expect((await request.post(messages, { data: body })).status()).toBe(201);
  await expect(page.getByTestId("user-message").filter({ hasText: "Late, but it got there." })).toHaveCount(1);
  await expect(saved(page)).toHaveCount(1);
  back.resolve();
  // The old answer changes nothing; the question asked again clears the item.
  await expect(saved(page)).toHaveCount(0, { timeout: 10_000 });
  expect(questions).toBe(2);
  await request.delete(`/api/sessions/${a}`);
});
