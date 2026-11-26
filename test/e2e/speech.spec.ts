import { expect, test, type Page } from "./isolate.ts";
import { HEARD, SPEECH_ID, startSpeechEndpoint, STT, TTS } from "./fixtures/speech-endpoint.ts";
import { endsAre, setPanes, shoot } from "./shots.ts";

// Feature: dictation into the message box and conversation mode, each with a key. The speech comes from a stand-in
// (a recognizer and a voice the page finds where a browser's own are, or a provider that lists speech models), so no
// microphone, speaker or paid model is involved: the words are given by the spec, the turn is the scripted model's.
const SCRIPTED = "scripted:stand-in";

// A microphone the browser makes up (a tone), which it allows without asking: the recording path runs for real.
test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } });

// What a browser has under `SpeechRecognition` and `speechSynthesis`, written by hand: a recognizer the spec makes
// speak, and a voice that records what it was asked to say.
const BROWSER = () => {
  const w = window as any;
  w.__recs = [];
  w.__spoken = [];
  // `__hold`: a voice that keeps reading until it is cancelled (a long reply); `__cancelled` counts the cancels.
  w.__hold = false; w.__cancelled = 0; w.__held = null;
  w.__holdStop = false;
  class Rec {
    lang = ""; continuous = false; interimResults = false; onresult: any; onend: any; onerror: any; on = false;
    constructor() { w.__recs.push(this); }
    start() { this.on = true; }
    stop() { this.on = false; if (!w.__holdStop) setTimeout(() => this.end(), 0); }
    abort() { this.on = false; }
    end() { this.on = false; this.onend?.(); }
    // What the recognizer holds: what it is sure of, and what it is still hearing.
    hear(final: string, interim = "") {
      const one = (t: string, isFinal: boolean) => Object.assign([{ transcript: t }], { isFinal });
      this.onresult?.({ results: [...(final ? [one(final, true)] : []), ...(interim ? [one(interim, false)] : [])] });
    }
  }
  w.SpeechRecognition = w.webkitSpeechRecognition = Rec;
  class Utterance { text: string; lang = ""; onend: any; onerror: any; constructor(t: string) { this.text = t; } }
  w.SpeechSynthesisUtterance = Utterance;
  Object.defineProperty(w, "speechSynthesis", {
    configurable: true,
    value: {
      getVoices: () => [{ name: "Stand-in" }],
      speak: (u: any) => { w.__spoken.push(u.text); if (w.__hold) w.__held = u; else setTimeout(() => u.onend?.(), 40); },
      cancel: () => { w.__cancelled++; const u = w.__held; w.__held = null; u?.onerror?.({ error: "canceled" }); },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
};
const hear = (page: Page, final: string, interim = "") => page.evaluate(([f, i]) => (window as any).__recs.at(-1).hear(f, i), [final, interim] as const);
const live = (page: Page) => page.evaluate(() => (window as any).__recs.filter((r: any) => r.on).length);

async function session(page: Page, request: any, prefs: Record<string, unknown> = {}) {
  const r = await request.post("/api/sessions", { data: { model: SCRIPTED, title: "Speech" } });
  test.skip(!r.ok(), "needs the scripted provider (KEEL_SCRIPTED_PROVIDER=1)");
  const id = (await r.json()).session.id as string;
  await page.addInitScript((p) => localStorage.setItem("keel.speech", JSON.stringify({ silenceMs: 700, ...p })), prefs);
  await page.goto(`/s/${id}`);
  await expect(page.getByTestId("composer")).toBeVisible();
  return id;
}

test("dictation puts the words in the box, by the button and by the key, and the box stays editable", async ({ page, request }) => {
  await page.addInitScript(BROWSER);
  await session(page, request);
  const box = page.getByTestId("composer");
  const band = page.getByTestId("speech-band");

  // The key is in the shortcut sheet.
  await page.keyboard.press("Control+/");
  await expect(page.locator('[data-testid="shortcut-row"][data-keys="alt+shift+d"]')).toContainText("Dictate");
  await expect(page.locator('[data-testid="shortcut-row"][data-keys="alt+shift+v"]')).toContainText("conversation mode");
  await page.keyboard.press("Escape");

  // The button: words already typed stay, the heard words go at the caret, interim words show as they come.
  await box.fill("Please");
  await page.getByTestId("dictate").click();
  await expect(band).toHaveAttribute("data-mode", "dictation");
  await expect(page.getByTestId("speech-state")).toHaveText("Listening");
  await expect(page.getByTestId("speech-way")).toHaveText("Browser speech recognition");
  await hear(page, "", "fix the");
  await expect(box).toHaveValue("Please fix the");
  await hear(page, "fix the flaky", "test");
  await expect(box).toHaveValue("Please fix the flaky test");
  await shoot(page, "speech-01-dictating");
  await page.getByTestId("speech-end").click();
  await expect(band).toBeHidden();
  await expect(box).toHaveValue("Please fix the flaky test");
  expect(await live(page)).toBe(0);
  // Editable before it is sent: the caret is at the end of the words, typing goes on from there.
  await page.keyboard.type(" now");
  await expect(box).toHaveValue("Please fix the flaky test now");
  await box.fill("");

  // The key: a tap starts, a second tap ends, and Esc ends it too, keeping the words.
  await box.focus();
  await page.keyboard.press("Alt+Shift+D");
  await expect(band).toBeVisible();
  await hear(page, "second try");
  await expect(box).toHaveValue("second try");
  await page.keyboard.press("Alt+Shift+D");
  await expect(band).toBeHidden();
  await expect(box).toHaveValue("second try");
  await box.focus();
  await page.keyboard.press("Alt+Shift+D");
  await expect(band).toBeVisible();
  await hear(page, "and a third");
  await page.keyboard.press("Escape");
  await expect(band).toBeHidden();
  await expect(box).toHaveValue("second try and a third");
  expect(await live(page)).toBe(0);
});

test("send waits for the final dictation and still belongs to the same draft", async ({ page, request }) => {
  await page.addInitScript(BROWSER);
  const id = await session(page, request);
  await setPanes(page, 1);
  const other = (await (await request.post("/api/sessions", { data: { model: SCRIPTED, title: "Another box" } })).json()).session.id as string;
  const box = page.getByTestId("composer");
  const send = page.getByTestId("send");
  const messages = page.getByTestId("user-message");
  const state = page.getByTestId("speech-state");
  await page.evaluate(() => { (window as any).__holdStop = true; });
  const start = async (draft: string) => {
    await box.fill(draft);
    await page.getByTestId("dictate").click();
    await expect(state).toHaveText("Listening");
  };
  const finish = () => page.evaluate(() => (window as any).__recs.at(-1).end());
  const sendKey = () => box.press("Enter");

  await start("Please");
  await hear(page, "", "check");
  await expect(box).toHaveValue("Please check");
  await send.click();
  await expect(state).toHaveText("Transcribing");
  expect(await live(page)).toBe(0);
  await expect(messages).toHaveCount(0);
  await sendKey();
  await shoot(page, "speech-send-pending");
  await hear(page, "check the final words");
  await finish();
  await endsAre(page, 1);
  await expect(messages).toHaveText(["Please check the final words"]);
  await expect(box).toHaveValue("");

  // A failed finalization keeps the text that was already in the box, including the words heard so far.
  await start("Keep");
  await hear(page, "", "this draft");
  await sendKey();
  await expect(state).toHaveText("Transcribing");
  await page.evaluate(() => (window as any).__recs.at(-1).onerror?.({ error: "audio-capture" }));
  await finish();
  await expect(page.getByTestId("speech-error")).toContainText("No microphone was found");
  await expect(box).toHaveValue("Keep this draft");
  await expect(messages).toHaveCount(1);
  await shoot(page, "speech-send-retry");
  await send.click();
  await endsAre(page, 2);
  await expect(messages).toHaveText(["Please check the final words", "Keep this draft"]);

  // Switching boxes leaves late words with the original draft, without sending to either session.
  await start("Original box");
  await send.click();
  await expect(state).toHaveText("Transcribing");
  const open = async (sid: string) => {
    await page.locator(`[data-testid="session-row"][data-session="${sid}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/s/${sid}$`));
    await expect(box).toBeVisible();
  };
  await open(other);
  await box.fill("Another draft");
  await hear(page, "not for this box");
  await finish();
  await expect(box).toHaveValue("Another draft");
  await expect(messages).toHaveCount(0);
  await open(id);
  await expect(box).toHaveValue("Original box not for this box");
  await expect(messages).toHaveCount(2);

  // Returning before the final words can arrive must not overwrite a new edit in the original box.
  await start("One more draft");
  await send.click();
  await expect(state).toHaveText("Transcribing");
  await open(other);
  await open(id);
  await box.fill("Changed after returning");
  await hear(page, "with more words");
  await finish();
  await expect(box).toHaveValue("Changed after returning");
  await expect(page.getByTestId("saved-draft").filter({ hasText: "One more draft with more words" })).toBeVisible();
  await expect(messages).toHaveCount(2);
  await shoot(page, "speech-send-parked");

  // An edit made while waiting is not the draft that Send authorized, even when the box was empty.
  await start("");
  await send.click();
  await expect(state).toHaveText("Transcribing");
  await box.fill("New draft");
  await hear(page, "late words");
  await finish();
  await expect(state).toBeHidden();
  await expect(box).toHaveValue("New draft");
  await expect(page.getByTestId("saved-draft").filter({ hasText: "late words" })).toBeVisible();
  await expect(messages).toHaveCount(2);
});

test("a browser with no recognizer and no speech model says so instead of failing in silence", async ({ page, request }) => {
  await page.addInitScript(() => { const w = window as any; delete w.SpeechRecognition; delete w.webkitSpeechRecognition; w.SpeechRecognition = w.webkitSpeechRecognition = undefined; });
  await session(page, request);
  const models = await (await request.get("/api/speech")).json();
  test.skip(models.models.some((m: any) => m.kind === "stt"), "needs a daemon whose providers list no speech to text model");
  await page.getByTestId("dictate").click();
  await expect(page.getByTestId("speech-error")).toContainText("no speech recognition");
  await expect(page.getByTestId("speech-band")).toBeHidden();
});

test("conversation: speak, it is sent when you stop, the reply is read aloud, it listens again, Esc ends it", async ({ page, request }) => {
  await page.addInitScript(BROWSER);
  await session(page, request);
  const band = page.getByTestId("speech-band");
  const state = page.getByTestId("speech-state");

  await page.getByTestId("converse").click();
  await expect(band).toHaveAttribute("data-mode", "conversation");
  await expect(state).toHaveText("Listening");
  await expect(page.getByTestId("speech-way")).toContainText("Browser speech recognition, read aloud by Browser voice");
  // What is being said shows as it comes. The words are the scripted model's cue for its reply.
  await hear(page, "", "tell me");
  await expect(page.getByTestId("speech-heard")).toHaveText("tell me");
  await hear(page, "tell me script:say The tests all pass.");
  await shoot(page, "speech-02-conversation-listening");
  // Quiet ends the message: it is sent as the owner's own, and the page says the session works, then speaks.
  await expect(page.getByTestId("user-message").last()).toContainText("tell me script:say The tests all pass.");
  await expect(state).toHaveText(/Thinking|Speaking|Listening/);
  await expect.poll(() => page.evaluate(() => (window as any).__spoken)).toEqual(["The tests all pass."]);
  // Then it listens again, with a recognizer of its own and nothing left from the first message.
  await expect(state).toHaveText("Listening");
  await expect(page.getByTestId("speech-heard")).toHaveCount(0);
  expect(await live(page)).toBe(1);

  // A second turn, then Esc ends it at once: the microphone is closed and the band is gone.
  await hear(page, "once more script:say Done twice.");
  await expect.poll(() => page.evaluate(() => (window as any).__spoken.length)).toBe(2);
  await expect(state).toHaveText("Listening");
  await page.keyboard.press("Escape");
  await expect(band).toBeHidden();
  expect(await live(page)).toBe(0);
  await expect(page.getByTestId("user-message")).toHaveCount(2);

  // The key turns it on and off too.
  await page.keyboard.press("Alt+Shift+V");
  await expect(band).toBeVisible();
  await page.keyboard.press("Alt+Shift+V");
  await expect(band).toBeHidden();
  expect(await live(page)).toBe(0);
});

test("a reply is read by the provider's voice when the owner chose it", async ({ page, request }) => {
  const fake = await startSpeechEndpoint();
  try {
    await request.put(`/api/providers/endpoints/${SPEECH_ID}`, { data: { config: { id: SPEECH_ID, label: "Speech E2E", base_url: `${fake.url}/v1`, wire: "chat_completions", auth: "none" } } });
    await page.addInitScript(BROWSER);
    await session(page, request, { say: "model", voice: "nova" });
    await page.getByTestId("converse").click();
    await expect(page.getByTestId("speech-way")).toHaveText(`Browser speech recognition, read aloud by ${TTS} (Speech E2E)`);
    await hear(page, "go script:say Read this one.");
    await expect.poll(() => fake.asked.spoken).toEqual([{ model: TTS, input: "Read this one.", voice: "nova" }]);
    await expect(page.getByTestId("speech-state")).toHaveText("Listening");
    // The browser's own voice was not used.
    expect(await page.evaluate(() => (window as any).__spoken)).toEqual([]);
    await page.getByTestId("converse").click();
    await expect(page.getByTestId("speech-band")).toBeHidden();
  } finally {
    await request.delete(`/api/providers/endpoints/${SPEECH_ID}`);
    fake.server.close();
  }
});

test("the Speech settings say which way is used now", async ({ page, request }) => {
  await page.addInitScript(BROWSER);
  await page.goto("/settings/speech");
  await expect(page.getByTestId("speech-listen-now")).toHaveText("Browser speech recognition");
  await expect(page.getByTestId("speech-say-now")).toHaveText("Browser voice");
  await shoot(page, "speech-04-settings");
  void request;
});


test("a speech model of a provider hears the dictation and speaks the reply when the browser has none", async ({ page, request, context }) => {
  const fake = await startSpeechEndpoint();
  try {
    await request.put(`/api/providers/endpoints/${SPEECH_ID}`, { data: { config: { id: SPEECH_ID, label: "Speech E2E", base_url: `${fake.url}/v1`, wire: "chat_completions", auth: "none" } } });
    const found = await (await request.get("/api/speech?fresh=1")).json();
    expect(found.models.map((m: any) => `${m.route} ${m.kind}`).sort()).toEqual([`${SPEECH_ID}:${TTS} tts`, `${SPEECH_ID}:${STT} stt`]);
    await context.grantPermissions(["microphone"]);
    // The page's own recognizer and voice are gone (a browser or a web view without them).
    await page.addInitScript(() => {
      const w = window as any;
      w.SpeechRecognition = w.webkitSpeechRecognition = undefined;
      // The recorder's own pieces, counted: the spec ends the recording once it holds some.
      w.__pieces = 0;
      const start = MediaRecorder.prototype.start;
      MediaRecorder.prototype.start = function (...a) { this.addEventListener("dataavailable", () => w.__pieces++); return start.apply(this, a); };
    });
    await session(page, request);
    await page.getByTestId("dictate").click();
    await expect(page.getByTestId("speech-way")).toHaveText(`${STT} (Speech E2E)`);
    await expect(page.getByTestId("speech-state")).toHaveText("Listening");
    // Once the recorder holds some, end it: the recording goes to the model and its words land in the box.
    await expect.poll(() => page.evaluate(() => (window as any).__pieces)).toBeGreaterThan(5);
    await page.getByTestId("speech-end").click();
    await expect(page.getByTestId("composer")).toHaveValue(HEARD);
    expect(fake.asked.heard).toHaveLength(1);
    expect(fake.asked.heard[0]!.model).toBe(STT);
    expect(fake.asked.heard[0]!.bytes).toBeGreaterThan(1500);
    await shoot(page, "speech-03-model");
  } finally {
    await request.delete(`/api/providers/endpoints/${SPEECH_ID}`);
    fake.server.close();
  }
});

test("voices: a provider that lists them is asked about once, and the pick is kept; one that lists none is shown its own words", async ({ page, request }) => {
  const listed = await startSpeechEndpoint({ voices: ["ember", "vale"] });
  try {
    await request.put(`/api/providers/endpoints/${SPEECH_ID}`, { data: { config: { id: SPEECH_ID, label: "Speech E2E", base_url: `${listed.url}/v1`, wire: "chat_completions", auth: "none" } } });
    const found = await (await request.get("/api/speech?fresh=1")).json();
    expect(found.models.find((m: any) => m.kind === "tts").voices).toEqual(["ember", "vale"]);
    await page.addInitScript(BROWSER);
    await session(page, request, { say: "model" });
    // Settings > Speech offers them, and none is chosen yet.
    await page.goto("/settings/speech");
    const list = page.getByTestId("speech-voice-list");
    await expect(list).toContainText("Choose a voice");
    await list.click();
    await expect(page.getByRole("option")).toHaveText(["Choose a voice", "ember", "vale"]);
    await page.keyboard.press("Escape");
    await page.goBack();
    // The first reply asks, and nothing is sent until the owner picks.
    await page.getByTestId("converse").click();
    await expect(page.getByTestId("speech-state")).toHaveText("Listening");
    await hear(page, "go script:say Read this one.");
    await expect(page.getByTestId("speech-voice-ask")).toBeVisible();
    await page.getByTestId("speech-voice-pick").click();
    await expect(page.getByRole("option")).toHaveText(["ember", "vale"]);
    expect(listed.asked.spoken).toEqual([]);
    await page.keyboard.press("Escape");
    await shoot(page, "speech-06-voice-ask");
    await page.getByTestId("speech-voice-pick").click();
    await page.getByRole("option", { name: "vale" }).click();
    await page.getByTestId("speech-voice-use").click();
    await expect.poll(() => listed.asked.spoken).toEqual([{ model: TTS, input: "Read this one.", voice: "vale" }]);
    await expect(page.getByTestId("speech-voice-ask")).toHaveCount(0);
    await expect(page.getByTestId("speech-state")).toHaveText("Listening");
    // The pick is kept: the next reply is read at once.
    await hear(page, "again script:say And this.");
    await expect.poll(() => listed.asked.spoken.map((s) => s.voice)).toEqual(["vale", "vale"]);
    await page.getByTestId("converse").click();
  } finally {
    await request.delete(`/api/providers/endpoints/${SPEECH_ID}`);
    listed.server.close();
  }

  const strict = await startSpeechEndpoint({ strict: true });
  try {
    await request.put(`/api/providers/endpoints/${SPEECH_ID}`, { data: { config: { id: SPEECH_ID, label: "Speech E2E", base_url: `${strict.url}/v1`, wire: "chat_completions", auth: "none" } } });
    await page.addInitScript(() => localStorage.removeItem("keel.speech"));
    await session(page, request, { say: "model" });
    await page.getByTestId("converse").click();
    await expect(page.getByTestId("speech-state")).toHaveText("Listening");
    await hear(page, "go script:say Read this one.");
    // No name of ours went first: the provider refused the text, and its words are shown for the owner to choose from.
    await expect(page.getByTestId("speech-voice-why")).toContainText("ash, coral, sage");
    expect(strict.asked.spoken).toEqual([{ model: TTS, input: "Read this one.", voice: undefined }]);
    await page.getByTestId("speech-voice-name").fill("coral");
    await page.getByTestId("speech-voice-name").press("Enter");
    await expect.poll(() => strict.asked.spoken.at(-1)).toEqual({ model: TTS, input: "Read this one.", voice: "coral" });
    await expect(page.getByTestId("speech-state")).toHaveText("Listening");
    await page.getByTestId("converse").click();
  } finally {
    await request.delete(`/api/providers/endpoints/${SPEECH_ID}`);
    strict.server.close();
  }
});

const REPLY = "The tests all pass and the build is green.";

test("barge-in: speech over a reply stops the reading and starts the next message; the reply's own words heard back do not", async ({ page, request }) => {
  await page.addInitScript(BROWSER);
  await session(page, request);
  await page.evaluate(() => { (window as any).__hold = true; });
  const state = page.getByTestId("speech-state");
  await page.getByTestId("converse").click();
  await expect(state).toHaveText("Listening");
  await hear(page, `tell me script:say ${REPLY}`);
  await expect.poll(() => page.evaluate(() => (window as any).__spoken)).toEqual([REPLY]);
  await expect(state).toHaveText("Speaking");
  await expect(page.getByTestId("speech-way")).toContainText("read aloud by Browser voice");
  // A recognizer runs over the reading (the one that heard the message was closed when it was sent).
  expect(await live(page)).toBe(1);
  // The reply's own words coming back through the microphone are not speech.
  await hear(page, "", "the tests all pass");
  await hear(page, "", "and the build is green");
  await expect(state).toHaveText("Speaking");
  expect(await page.evaluate(() => (window as any).__cancelled)).toBe(0);
  // The owner speaks over it: the reading stops at once and the words are the start of the next message.
  await hear(page, "", "wait stop");
  await expect(state).toHaveText("Listening");
  await expect(page.getByTestId("speech-heard")).toHaveText("wait stop");
  expect(await page.evaluate(() => (window as any).__cancelled)).toBe(1);
  await shoot(page, "speech-05-barge-in");
  await page.evaluate(() => { (window as any).__hold = false; });
  await hear(page, "wait stop script:say Stopped.");
  await expect(page.getByTestId("user-message").last()).toContainText("wait stop script:say Stopped.");
  await expect.poll(() => page.evaluate(() => (window as any).__spoken)).toEqual([REPLY, "Stopped."]);
  await expect(state).toHaveText("Listening");
  expect(await live(page)).toBe(1);
});

test("barge-in off in Settings > Speech: the reply is read to its end and nothing listens meanwhile", async ({ page, request }) => {
  await page.addInitScript(BROWSER);
  await session(page, request, { barge: false });
  await page.evaluate(() => { (window as any).__hold = true; });
  await page.getByTestId("converse").click();
  await expect(page.getByTestId("speech-state")).toHaveText("Listening");
  await hear(page, `tell me script:say ${REPLY}`);
  await expect(page.getByTestId("speech-state")).toHaveText("Speaking");
  expect(await live(page)).toBe(0);
  await page.evaluate(() => { const w = window as any; const u = w.__held; w.__held = null; u.onend(); });
  await expect(page.getByTestId("speech-state")).toHaveText("Listening");
  expect(await live(page)).toBe(1);
});

test("narrow: the speech line and Settings > Speech at 390x844 in both themes", async ({ page, request }) => {
  await page.addInitScript(BROWSER);
  await page.setViewportSize({ width: 390, height: 844 });
  await session(page, request);
  // (On a phone the tools rest behind a button until it is tapped.)
  const more = page.getByTestId("composer-open");
  if (await more.isVisible()) await more.click();
  await page.getByTestId("converse").click();
  await expect(page.getByTestId("speech-state")).toHaveText("Listening");
  await hear(page, "", "tell me about the tests please and then some");
  await expect(page.getByTestId("speech-band")).toBeVisible();
  const band = await page.getByTestId("speech-band").boundingBox();
  expect(band!.x + band!.width).toBeLessThanOrEqual(390);
  // End stays in view: the way the words are heard is a line of its own on a phone.
  const end = await page.getByTestId("speech-end").boundingBox();
  expect(end!.x + end!.width).toBeLessThanOrEqual(390);
  await expect(page.getByTestId("speech-heard")).toBeVisible();
  await shoot(page, "speech-07-narrow-band");
  await page.keyboard.press("Escape");
  await page.goto("/settings/speech");
  await expect(page.getByTestId("speech-settings")).toBeVisible();
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scroll).toBeLessThanOrEqual(390);
  await shoot(page, "speech-08-narrow-settings");
});

// A touch screen has no keys to press: the Settings a phone shows name none (Speech, the helper, General), and a desk keeps them.
test("Settings on a touch screen name no keys", async ({ browser, baseURL, page }) => {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await ctx.newPage();
  const KEYS = /\b(Ctrl|Alt|Shift|Esc)\b/;
  try {
    for (const [section, words] of [["speech", "Hear with"], ["helper", "One conversation that never ends"], ["general", "Text size"]] as const) {
      await phone.goto(`/settings/${section}`);
      const scroll = phone.getByTestId("settings-scroll");
      await expect(scroll).toContainText(words);
      expect(await scroll.innerText(), `no key named in ${section} on a touch screen`).not.toMatch(KEYS);
    }
    await phone.goto("/settings/speech");
    await expect(phone.getByTestId("speech-settings")).toContainText("Dictate into the message box, or talk with a session");
    await shoot(phone, "speech-05-settings-touch");
  } finally {
    await ctx.close();
  }
  // At a desk the keys are named.
  await page.goto("/settings/speech");
  await expect(page.getByTestId("speech-settings")).toContainText(/Dictate into the message box \(Alt Shift D\)/);
});
