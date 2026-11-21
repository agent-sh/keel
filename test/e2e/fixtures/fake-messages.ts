// A stand-in for a provider on the Anthropic Messages wire, for specs that
// need to see a request as that wire carries it (the system blocks, the
// deferred tools). It records every request body and answers with a short
// text and a usage that reports a cache read, so the session counts as warm.
// A prompt that says `LOAD-TOOL <name>` is answered once with a ToolSearch
// call for that tool, the way a model loads a deferred tool.
import { createServer, type Server } from "node:http";

export function startFakeMessages(): Promise<{ url: string; server: Server; bodies: any[] }> {
  const bodies: any[] = [];
  const usage = { input_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, output_tokens: 3 };
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => {
      if (req.method !== "POST" || !(req.url ?? "").endsWith("/v1/messages")) { res.writeHead(404); return res.end(); }
      const body = JSON.parse(text || "{}");
      bodies.push(body);
      const last = body.messages?.at(-1);
      const said = JSON.stringify(last ?? "");
      const load = last?.role === "user" && !said.includes('"tool_result"') ? /LOAD-TOOL ([A-Za-z0-9_-]+)/.exec(said)?.[1] : undefined;
      const start = { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: body.model, content: [], usage: { ...usage, output_tokens: 1 } } };
      const events = load
        ? [
            start,
            { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${bodies.length}`, name: "ToolSearch", input: {} } },
            { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ query: `select:${load}` }) } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
            { type: "message_stop" },
          ]
        : [
            start,
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Fake reply." } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
            { type: "message_stop" },
          ];
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ id: "msg_fake", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "Fake reply." }], stop_reason: "end_turn", usage }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
    });
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server, bodies })));
}
