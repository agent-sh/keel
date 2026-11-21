// The real engine and store over a state folder, with the scripted stand-in
// as the only model: for the tests of prompt delivery (the queue, steers, a
// daemon killed between accepting a prompt and running it), which need the
// real turn loop and the real database and cannot be timed from a page.
import { join } from "node:path";
import { Bus } from "../core/bus.ts";
import { Store } from "../core/store.ts";
import type { Message } from "../core/types.ts";
import { ScriptedProvider } from "../providers/scripted.ts";
import type { Delta, ModelInfo, ProviderRequest } from "../providers/types.ts";
import { Engine } from "./turn.ts";

export type RigHooks = {
  // Runs while a turn resolves its provider, before the turn has started.
  setup?: () => Promise<void>;
  // Runs before the stand-in answers a request (hold a turn open, act mid-turn).
  request?: (req: ProviderRequest) => Promise<void>;
};

const texts = (messages: Message[]) =>
  messages.filter((m) => m.role === "user").flatMap((m) => (m.content as any[]).filter((b) => b.type === "text").map((b) => String(b.text)));

// Rejects when the request is stopped: a held request ends like a cut stream.
export const untilStopped = (req: ProviderRequest) =>
  new Promise<void>((_, reject) => {
    const stop = () => reject(new Error("stopped"));
    if (req.signal?.aborted) stop();
    else req.signal?.addEventListener("abort", stop, { once: true });
  });

export function rig(stateDir: string, hooks: RigHooks = {}) {
  const store = new Store(stateDir);
  const scripted = new ScriptedProvider();
  const info: ModelInfo = { id: "scripted:stand-in", provider: "scripted", model: "stand-in", name: "Scripted stand-in", family: "other", context: 100_000, output: 2_000, tools: false, efforts: [], billing: "unknown" };
  // The owner's and the harness's words each model request carried, in order.
  const requests: string[][] = [];
  const provider = {
    id: "scripted", family: "other" as const, available: () => true, list: () => scripted.list(),
    stream: async (req: ProviderRequest, onDelta: (d: Delta) => void) => {
      requests.push(texts(req.messages));
      await hooks.request?.(req);
      return scripted.stream(req, onDelta);
    },
  };
  const providers = { resolve: async () => { await hooks.setup?.(); return { provider, info }; }, models: async () => [info], current: () => [info] };
  const errors = { capture: (_source: string, e: unknown) => ({ id: "captured", message: String((e as Error)?.message ?? e) }) };
  const engine = new Engine(store, new Bus(), providers as any, errors as any, join(stateDir, "spill"));
  // The system prompt is not what these tests are about: no files are read for it.
  (engine as any).systemOf = async () => ({ text: "A stand-in system prompt.", split: 0 });
  const session = () => store.createSession({ model: info.id, workspace: stateDir });
  return { store, engine, requests, session };
}

// The stored prompts a queued row became, by the row's id.
export const promptsOf = (store: Store, sessionId: string, queueId: string) =>
  store.events(sessionId).filter((e) => e.kind === "user" && e.data.queue_id === queueId);

// What the crash tests queue: words and an attachment the owner was told are queued.
export const QUEUED = { text: "queued while the first turn ran", images: [{ type: "image" as const, media_type: "image/png", data: "iVBORw0KGgo=" }] };
// What they send to an idle session.
export const SENT = { text: "sent just before the daemon went down", images: QUEUED.images };
