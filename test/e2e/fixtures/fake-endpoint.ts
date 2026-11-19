// A stand-in OpenAI-compatible server for the add-a-provider e2e: it wants a
// bearer key, has its API under /v1 (the bare root answers with a web page),
// lists one model the way vLLM does, and streams answers that show what the
// probe looks for: a tool call when given tools, the color of an image, and
// cached tokens when a long prompt comes again. A second model takes no tools
// (it answers in text when given some); every chat request is recorded.
import { createServer, type Server } from "node:http";

export const FAKE_KEY = "lab-e2e-key-not-real";
export const FAKE_MODEL = "lab-coder";
export const FAKE_TEXT_MODEL = "lab-chat";
export type FakeRequest = { model: string; tools: number };

export function startFake(): Promise<{ url: string; server: Server; requests: FakeRequest[] }> {
  const seen = new Set<string>();
  const requests: FakeRequest[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      if (!path.startsWith("/v1/")) {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end("<!doctype html><title>Lab dashboard</title>");
      }
      if (req.headers.authorization !== `Bearer ${FAKE_KEY}`) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "missing or wrong API key" } }));
      }
      if (path === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: [FAKE_MODEL, FAKE_TEXT_MODEL].map((id) => ({ id, object: "model", owned_by: "vllm", max_model_len: 32768 })) }));
      }
      if (path !== "/v1/chat/completions") { res.writeHead(404); return res.end(); }
      const b = JSON.parse(body || "{}");
      requests.push({ model: b.model, tools: b.tools?.length ?? 0 });
      const all = JSON.stringify(b.messages ?? []);
      const sys = String(b.messages?.[0]?.content ?? "");
      const prompt = Math.ceil(all.length / 4);
      const cached = sys.length > 4000 && seen.has(sys) ? prompt - 20 : 0;
      if (sys.length > 4000) seen.add(sys);
      const chunk = (d: unknown) => res.write(`data: ${JSON.stringify(d)}\n\n`);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: "c1", object: "chat.completion.chunk", model: b.model };
      // The probe's tool (a session's tools get a plain answer, so its turn ends).
      if (b.model !== FAKE_TEXT_MODEL && b.tools?.some((t: any) => t.function?.name === "get_weather")) {
        chunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] } }] });
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        const text = all.includes("image_url") ? "Red" : b.reasoning_effort ? "391" : all.includes("Reply with the single word OK") ? "OK" : "Hello from the lab server.";
        if (b.reasoning_effort) chunk({ ...base, choices: [{ index: 0, delta: { reasoning_content: "17 times 23 is 391." } }] });
        chunk({ ...base, choices: [{ index: 0, delta: { content: text } }] });
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      chunk({ ...base, choices: [], usage: { prompt_tokens: prompt, completion_tokens: 3, prompt_tokens_details: { cached_tokens: cached } } });
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const a = server.address() as { port: number };
    resolve({ url: `http://127.0.0.1:${a.port}`, server, requests });
  }));
}
