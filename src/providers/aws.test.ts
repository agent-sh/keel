import { expect, test } from "bun:test";
import { EventStreamDecoder, sigv4 } from "./aws.ts";

// AWS SigV4 test suite, "get-vanilla" and "post-vanilla".
const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const now = new Date("2015-08-30T12:36:00Z");

test("sigv4 matches the AWS test vectors", () => {
  const get = sigv4({ method: "GET", url: "https://example.amazonaws.com/", body: "", region: "us-east-1", service: "service", creds, now });
  expect(get.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  const post = sigv4({ method: "POST", url: "https://example.amazonaws.com/", body: "", region: "us-east-1", service: "service", creds, now });
  expect(post.authorization).toEndWith("Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b");
});

// One event-stream frame with string headers and a payload.
function frame(headers: Record<string, string>, payload: string): Uint8Array {
  const enc = new TextEncoder();
  const hs: number[] = [];
  for (const [k, v] of Object.entries(headers)) {
    const kb = enc.encode(k), vb = enc.encode(v);
    hs.push(kb.length, ...kb, 7, vb.length >> 8, vb.length & 255, ...vb);
  }
  const pb = enc.encode(payload);
  const total = 12 + hs.length + pb.length + 4;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, total);
  v.setUint32(4, hs.length);
  out.set(hs, 12);
  out.set(pb, 12 + hs.length);
  return out;
}

test("event stream frames become the SSE events they carry, across split chunks", () => {
  const ev = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } };
  const chunk = frame({ ":message-type": "event", ":event-type": "chunk", ":content-type": "application/json" }, JSON.stringify({ bytes: Buffer.from(JSON.stringify(ev)).toString("base64") }));
  const both = new Uint8Array([...chunk, ...chunk]);
  const d = new EventStreamDecoder();
  const got = [...d.push(both.subarray(0, 7)), ...d.push(both.subarray(7, chunk.length + 3)), ...d.push(both.subarray(chunk.length + 3))];
  expect(got).toEqual([{ event: "content_block_delta", data: JSON.stringify(ev) }, { event: "content_block_delta", data: JSON.stringify(ev) }]);
  const ex = frame({ ":message-type": "exception", ":exception-type": "throttlingException" }, JSON.stringify({ message: "Too many requests" }));
  expect(() => new EventStreamDecoder().push(ex)).toThrow(expect.objectContaining({ kind: "rate" }));
});
