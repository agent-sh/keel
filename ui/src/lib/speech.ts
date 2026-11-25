// Speech in and out for the page: what the owner chose, what is there to choose from, and the two
// ways to listen (the browser's own recognizer, or a recording sent to a speech model of the owner's
// providers) and to speak (the browser's voice, or a provider's text to speech). Dictation
// (lib/dictation.ts) and conversation mode (lib/talk.ts) both stand on this. Which one is used is
// always said on screen: `label`.
import { useSyncExternalStore } from "react";
import { shellMicrophone } from "./shell.ts";
import { api, failed } from "./store.ts";
import { pieces, SILENCE_MS, VAD_START, vadStep } from "./talk-core.ts";

// ---- what the owner chose ----

export type Way = "auto" | "browser" | "model";
export type Prefs = { listen: Way; listenModel: string; say: Way; sayModel: string; voice: string; silenceMs: number; lang: string };
const KEY = "keel.speech";
const FALLBACK: Prefs = { listen: "auto", listenModel: "", say: "auto", sayModel: "", voice: "", silenceMs: SILENCE_MS, lang: "" };
let prefs: Prefs = (() => {
  try { return { ...FALLBACK, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") }; } catch { return FALLBACK; }
})();
const subs = new Set<() => void>();
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
export const getPrefs = () => prefs;
export function setPrefs(p: Partial<Prefs>) {
  prefs = { ...prefs, ...p };
  localStorage.setItem(KEY, JSON.stringify(prefs));
  subs.forEach((f) => f());
}
export const usePrefs = () => useSyncExternalStore(subscribe, getPrefs);
// The language the recognizer and the model are told: the owner's, else the page's.
export const langOf = (p = prefs) => p.lang.trim() || navigator.language || "en-US";

// ---- what there is to choose from ----

export type SpeechModel = { route: string; provider: string; provider_label: string; model: string; kind: "stt" | "tts" };
type Listing = { models: SpeechModel[]; failed: { provider: string; error: string }[] };
let listing: Listing | null = null;
let listingOut: Promise<Listing> | null = null;
export const speechModels = () => listing;
export function loadSpeechModels(fresh = false): Promise<Listing> {
  if (listing && !fresh) return Promise.resolve(listing);
  if (listingOut && !fresh) return listingOut;
  listingOut = api<Listing>(`/api/speech${fresh ? "?fresh=1" : ""}`)
    .then((l) => (listing = l))
    .catch((e) => { failed(e, { at: "speech models" }); return (listing ??= { models: [], failed: [] }); })
    .finally(() => { listingOut = null; subs.forEach((f) => f()); });
  return listingOut;
}
export const useSpeechModels = () => useSyncExternalStore(subscribe, speechModels);

// ---- which way, and its name on screen ----

type RecognitionCtor = new () => any;
export const recognizerCtor = (): RecognitionCtor | undefined => (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
const canRecord = () => !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
const named = (m: SpeechModel) => `${m.model} (${m.provider_label})`;

export type Way1 = { source: "browser" | "model"; route?: string; label: string };
export type Chosen = { way: Way1 } | { way: null; why: string };

// Listening: the browser's recognizer where there is one, else the speech model the owner chose, else the
// first speech to text model a provider lists. `auto` is that order; the owner can pin either.
export function chooseListen(p = prefs, l = listing): Chosen {
  const stt = (l?.models ?? []).filter((m) => m.kind === "stt");
  const model = (): Chosen => {
    if (!stt.length) return { way: null, why: "No provider lists a speech to text model." };
    if (!canRecord()) return { way: null, why: "This page cannot record: a microphone needs a secure address (localhost or https)." };
    const m = stt.find((x) => x.route === p.listenModel) ?? stt[0]!;
    return { way: { source: "model", route: m.route, label: named(m) } };
  };
  const browser = (): Chosen => (recognizerCtor() ? { way: { source: "browser", label: "Browser speech recognition" } } : { way: null, why: "This browser has no speech recognition." });
  if (p.listen === "browser") return browser();
  if (p.listen === "model") return model();
  const b = browser();
  if (b.way) return b;
  const m = model();
  return m.way ? m : { way: null, why: "This browser has no speech recognition, and no provider lists a speech to text model." };
}

// Speaking: the browser's voice when it has one, else a provider's text to speech.
export function chooseSay(p = prefs, l = listing, voices = browserVoices()): Chosen {
  const tts = (l?.models ?? []).filter((m) => m.kind === "tts");
  const model = (): Chosen => {
    if (!tts.length) return { way: null, why: "No provider lists a text to speech model." };
    const m = tts.find((x) => x.route === p.sayModel) ?? tts[0]!;
    return { way: { source: "model", route: m.route, label: named(m) } };
  };
  const browser = (): Chosen => (voices > 0 ? { way: { source: "browser", label: "Browser voice" } } : { way: null, why: "This browser has no voice." });
  if (p.say === "browser") return browser();
  if (p.say === "model") return model();
  const b = browser();
  if (b.way) return b;
  const m = model();
  return m.way ? m : { way: null, why: "This browser has no voice, and no provider lists a text to speech model." };
}
export const browserVoices = () => (window.speechSynthesis && typeof SpeechSynthesisUtterance !== "undefined" ? (window.speechSynthesis.getVoices?.().length ?? 0) : 0);

// ---- listening ----

export type Hear = { stop: () => void; cancel: () => void };
export type HearOpts = {
  way: Way1;
  lang: string;
  silenceMs?: number;            // a recording ends by itself after speech and this much quiet
  onWords?: (final: string, interim: string) => void;
  onState?: (s: "recording" | "transcribing") => void;
  onDone: (text: string, why: "stopped" | "silence" | "ended") => void;
  onFail: (message: string, retryOnModel?: boolean) => void;
};

const RECORD_MAX_MS = 10 * 60_000;

export function hear(o: HearOpts): Hear {
  return o.way.source === "browser" ? hearBrowser(o) : hearRecording(o);
}

// What a recognizer's error says to the owner. `retry`: the browser's own service is what failed.
function said(code: string): { text: string; retry: boolean } {
  switch (code) {
    case "not-allowed": return { text: "The microphone is blocked for this page. Allow it in the browser's address bar.", retry: false };
    case "service-not-allowed": return { text: "This browser does not let the page use its speech service.", retry: true };
    case "network": return { text: "The browser's speech service did not answer.", retry: true };
    case "language-not-supported": return { text: "The browser's recognizer does not know this language.", retry: true };
    case "audio-capture": return { text: "No microphone was found.", retry: false };
    default: return { text: `The browser's recognizer stopped: ${code}.`, retry: true };
  }
}

function hearBrowser(o: HearOpts): Hear {
  const Ctor = recognizerCtor()!;
  const r = new Ctor();
  r.lang = o.lang;
  r.continuous = true;
  r.interimResults = true;
  let final = "", interim = "", asked: "stopped" | null = null, over = false, failedOnce = false;
  const finish = (why: "stopped" | "ended") => { if (over) return; over = true; o.onDone(`${final} ${interim}`.replace(/\s+/g, " ").trim(), why); };
  r.onresult = (e: any) => {
    let f = "", i = "";
    for (let k = 0; k < e.results.length; k++) (e.results[k].isFinal ? (f += e.results[k][0].transcript) : (i += e.results[k][0].transcript));
    final = f.trim(); interim = i.trim();
    o.onWords?.(final, interim);
  };
  r.onerror = (e: any) => {
    // Quiet for a while is not a failure: the recognizer ends and listening goes on.
    if (e.error === "no-speech" || e.error === "aborted") return;
    failedOnce = true;
    over = true;
    const s = said(String(e.error));
    o.onFail(s.text, s.retry);
  };
  r.onend = () => { if (!failedOnce) finish(asked ? "stopped" : "ended"); };
  try { r.start(); } catch (e) { over = true; o.onFail(`The browser's recognizer would not start: ${(e as Error).message}`, true); }
  return {
    stop: () => { asked = "stopped"; try { r.stop(); } catch { finish("stopped"); } },
    cancel: () => { over = true; try { r.abort(); } catch {} },
  };
}

function recorderType(): string | undefined {
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((t) => MediaRecorder.isTypeSupported?.(t));
}

function hearRecording(o: HearOpts): Hear {
  let over = false, stream: MediaStream | undefined, rec: MediaRecorder | undefined, ctx: AudioContext | undefined, stopBeat: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let why: "stopped" | "silence" = "stopped";
  let discard = false;
  const release = () => { stopBeat?.(); clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); void ctx?.close().catch(() => {}); };
  const end = (w: "stopped" | "silence") => { if (rec && rec.state !== "inactive") { why = w; rec.stop(); } };
  // In the desktop app the microphone is the app's to give, once, at the owner's press (desktop/README.md).
  shellMicrophone().then(() => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })).then((s) => {
    if (over) return s.getTracks().forEach((t) => t.stop());
    stream = s;
    const type = recorderType();
    rec = new MediaRecorder(s, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      release();
      if (discard || over) return;
      o.onState?.("transcribing");
      try {
        const blob = new Blob(chunks, { type: rec!.mimeType || type || "audio/webm" });
        // Nothing recorded, or too little to hold words (a tap of the key): nothing to send.
        if (blob.size < 1500) return o.onDone("", why);
        const lang = o.lang.split("-")[0] ?? "";
        const r = await fetch(`/api/speech/transcribe?route=${encodeURIComponent(o.way.route!)}${lang ? `&lang=${encodeURIComponent(lang)}` : ""}`, { method: "POST", headers: { "content-type": blob.type.split(";")[0]! }, body: blob });
        const b = await r.json().catch(() => ({}));
        if (!r.ok) return o.onFail(String(b.error ?? `HTTP ${r.status}`));
        if (!over) o.onDone(String(b.text ?? ""), why);
      } catch (e) {
        o.onFail(failed(e, { at: "transcribe" }));
      }
    };
    rec.start(250);
    o.onState?.("recording");
    timer = setTimeout(() => end("stopped"), RECORD_MAX_MS);
    if (o.silenceMs !== undefined) {
      const AC = window.AudioContext ?? (window as any).webkitAudioContext;
      ctx = new AC();
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      ctx.createMediaStreamSource(s).connect(an);
      const buf = new Float32Array(an.fftSize);
      let v = VAD_START;
      // Not the page's clock: a conversation goes on while the window is behind another.
      let beat: ReturnType<typeof setTimeout>;
      const listen = () => {
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const x of buf) sum += x * x;
        v = vadStep(v, Math.sqrt(sum / buf.length), Date.now(), o.silenceMs!);
        if (v.ended) end("silence");
        else beat = setTimeout(listen, 100);
      };
      beat = setTimeout(listen, 100);
      stopBeat = () => clearTimeout(beat);
    }
  }).catch((e: any) => {
    release();
    if (over) return;
    over = true;
    o.onFail(e?.name === "NotAllowedError" ? "The microphone is blocked for this page. Allow it in the browser's address bar." : e?.name === "NotFoundError" ? "No microphone was found." : `The microphone did not open: ${e?.message ?? e}`);
  });
  return {
    stop: () => end("stopped"),
    cancel: () => { over = true; discard = true; if (rec && rec.state !== "inactive") rec.stop(); else release(); },
  };
}

// ---- speaking ----

let hush1: (() => void) | null = null;
export function hush() { hush1?.(); hush1 = null; }

// Reads `text` aloud and settles when it is done or hushed. A failure to speak is thrown (the reply is
// still on screen; the caller says so).
export async function speak(text: string, way: Way1, p = prefs): Promise<void> {
  hush();
  let stopped = false;
  const stops: (() => void)[] = [];
  hush1 = () => { stopped = true; stops.forEach((f) => f()); };
  const mine = hush1;
  try {
    if (way.source === "browser") {
      for (const part of pieces(text, 220)) {
        if (stopped) return;
        await new Promise<void>((done, fail) => {
          const u = new SpeechSynthesisUtterance(part);
          u.lang = langOf(p);
          u.onend = () => done();
          u.onerror = (e: any) => (e?.error === "canceled" || e?.error === "interrupted" ? done() : fail(new Error(`The browser's voice failed: ${e?.error ?? "unknown"}`)));
          stops.push(() => { window.speechSynthesis.cancel(); done(); });
          window.speechSynthesis.speak(u);
        });
      }
      return;
    }
    // A provider's voice: each piece is asked for while the one before plays.
    const ctl = new AbortController();
    stops.push(() => ctl.abort());
    const fetchPiece = async (part: string) => {
      const r = await fetch("/api/speech/speak", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ route: way.route, text: part, voice: p.voice }), signal: ctl.signal });
      if (!r.ok) throw new Error(String(((await r.json().catch(() => ({}))) as any).error ?? `HTTP ${r.status}`));
      return URL.createObjectURL(await r.blob());
    };
    const parts = pieces(text, 3500);
    let next = parts[0] ? fetchPiece(parts[0]) : undefined;
    for (let i = 0; i < parts.length; i++) {
      const url = await next!;
      next = parts[i + 1] ? fetchPiece(parts[i + 1]!) : undefined;
      next?.catch(() => {});
      if (stopped) return void URL.revokeObjectURL(url);
      await new Promise<void>((done, fail) => {
        const a = new Audio(url);
        stops.push(() => { a.pause(); done(); });
        a.onended = () => done();
        a.onerror = () => fail(new Error("The audio could not be played."));
        a.play().catch((e) => fail(e));
      }).finally(() => URL.revokeObjectURL(url));
    }
  } catch (e) {
    if (stopped || (e as Error).name === "AbortError") return;
    throw e;
  } finally {
    if (hush1 === mine) hush1 = null;
  }
}

// Browsers fill their voice list after the page loads: wait for it, a moment at most.
export function voicesReady(): Promise<void> {
  const s = window.speechSynthesis;
  if (!s || browserVoices() > 0) return Promise.resolve();
  return new Promise((done) => {
    const finish = () => { s.removeEventListener?.("voiceschanged", finish); clearTimeout(t); done(); };
    const t = setTimeout(finish, 400);
    s.addEventListener?.("voiceschanged", finish);
  });
}
