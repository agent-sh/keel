// Stand-in Anthropic-style and Gemini-style servers whose model listing comes
// in two pages, for the add-a-provider e2e. The first page names the second
// (`last_id` with `has_more`, or `nextPageToken`); with `loop` the second page
// names itself again, as a server whose pages never end does. Every listing
// request is recorded by its query.
import { createServer, type Server } from "node:http";

export const PAGE_ONE = "lab-page-one";
export const PAGE_TWO = "lab-page-two";

export function startPaged(wire: "anthropic" | "gemini", o: { loop?: boolean } = {}): Promise<{ url: string; server: Server; listings: string[] }> {
  const listings: string[] = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const send = (body: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (wire === "anthropic" && u.pathname === "/v1/models") {
      listings.push(u.search);
      const second = u.searchParams.get("after_id") === PAGE_ONE;
      const id = second ? PAGE_TWO : PAGE_ONE;
      return send({ data: [{ id, display_name: id, max_input_tokens: 65536 }], has_more: !second || !!o.loop, last_id: second && o.loop ? PAGE_ONE : id });
    }
    if (wire === "gemini" && u.pathname === "/v1beta/models") {
      listings.push(u.search);
      const second = u.searchParams.get("pageToken") === "page-2";
      const id = second ? PAGE_TWO : PAGE_ONE;
      return send({ models: [{ name: `models/${id}`, displayName: id, inputTokenLimit: 65536, supportedGenerationMethods: ["generateContent"] }], ...(!second || o.loop ? { nextPageToken: "page-2" } : {}) });
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const a = server.address() as { port: number };
    resolve({ url: `http://127.0.0.1:${a.port}`, server, listings });
  }));
}
