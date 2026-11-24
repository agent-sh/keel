import { expect, test } from "bun:test";
import { bodyBytes, endpointOf, frameBytes, handshakeBytes, loopbackHost, plainWhy, pushFailure, requestBytes, takeTag } from "./egress-count.ts";

test("an address is its host and port, whatever form it is written in", () => {
  expect(endpointOf("https://API.Example.com/v1/messages?x=1")).toEqual({ host: "api.example.com", port: 443 });
  expect(endpointOf("http://127.0.0.1:8080/x")).toEqual({ host: "127.0.0.1", port: 8080 });
  expect(endpointOf("http://[::1]:9000/")).toEqual({ host: "::1", port: 9000 });
  expect(endpointOf("wss://h.example/socket")).toEqual({ host: "h.example", port: 443 });
  expect(endpointOf("ssh://git@code.example:2222/r.git")).toEqual({ host: "code.example", port: 2222 });
  expect(endpointOf("git://127.0.0.1:9418/repo")).toEqual({ host: "127.0.0.1", port: 9418 });
  // git's short ssh form, and a transport helper's address.
  expect(endpointOf("git@code.example:owner/repo.git")).toEqual({ host: "code.example", port: 22 });
  expect(endpointOf("code.example:repo.git")).toEqual({ host: "code.example", port: 22 });
  expect(endpointOf("ext::ssh://code.example/r")).toEqual({ host: "code.example", port: 22 });
  // The proxy's CONNECT target.
  expect(endpointOf("example.com:443")).toEqual({ host: "example.com", port: 443 });
  expect(endpointOf("example.com.:80")).toEqual({ host: "example.com", port: 80 });
  // A folder or file on this machine goes nowhere.
  expect(endpointOf("/srv/git/repo.git")).toBeNull();
  expect(endpointOf("../other")).toBeNull();
  expect(endpointOf("file:///srv/repo")).toBeNull();
  expect(endpointOf("origin")).toBeNull();
  expect(endpointOf("")).toBeNull();
});

test("loopback is named by name or by address", () => {
  for (const h of ["localhost", "LOCALHOST", "a.localhost", "127.0.0.1", "127.9.0.3", "::1", "[::1]"]) expect(loopbackHost(h)).toBe(true);
  for (const h of ["example.com", "10.0.0.1", "128.0.0.1", "localhost.example.com"]) expect(loopbackHost(h)).toBe(false);
});

test("a request's bytes are its request line, Host, headers and body", () => {
  const head = "POST /v1/x?y=1 HTTP/1.1\r\nHost: a.example:8443\r\n";
  const headers = "content-type: application/json\r\n";
  const body = JSON.stringify({ hello: "wörld" });
  expect(requestBytes({ method: "post", url: "https://a.example:8443/v1/x?y=1", headers: { "content-type": "application/json" }, body }))
    .toBe(Buffer.byteLength(head) + Buffer.byteLength(headers) + 2 + Buffer.byteLength(body));
  // A Host header given is counted once; headers as a Headers object or pairs count the same.
  const a = requestBytes({ url: "http://h/", headers: new Headers({ Host: "h", accept: "*/*" }) });
  const b = requestBytes({ url: "http://h/", headers: [["accept", "*/*"]] });
  expect(a).toBe(b);
  expect(a).toBe(Buffer.byteLength("GET / HTTP/1.1\r\nHost: h\r\naccept: */*\r\n\r\n"));
  // A body whose length is not known first: not counted rather than guessed.
  expect(requestBytes({ url: "http://h/", body: new ReadableStream() })).toBeNull();
});

test("a body's bytes are known for text, bytes, blobs and fields", () => {
  expect(bodyBytes(undefined)).toBe(0);
  expect(bodyBytes("é")).toBe(2);
  expect(bodyBytes(new Uint8Array(7))).toBe(7);
  expect(bodyBytes(new ArrayBuffer(5))).toBe(5);
  expect(bodyBytes(new Blob(["abc"]))).toBe(3);
  expect(bodyBytes(new URLSearchParams({ a: "b c" }))).toBe("a=b+c".length);
  expect(bodyBytes(new FormData())).toBeNull();
});

test("the relay's tag is taken off the head, and a head without one is left as it is", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const dec = (b: Uint8Array) => new TextDecoder().decode(b);
  const t = takeTag(enc("KEEL-TAG abc123\r\nCONNECT h:443 HTTP/1.1\r\n\r\n"));
  expect(t).not.toBe("need");
  if (t === "need") return;
  expect(t.tag).toBe("abc123");
  expect(dec(t.rest)).toBe("CONNECT h:443 HTTP/1.1\r\n\r\n");
  // Not yet long enough to tell.
  expect(takeTag(enc("KEEL"))).toBe("need");
  expect(takeTag(enc("KEEL-TAG abc"))).toBe("need");
  // No tag: the head whole.
  const plain = takeTag(enc("GET http://h/ HTTP/1.1\r\n\r\n"));
  expect(plain !== "need" && plain.tag === undefined && dec(plain.rest)).toBe("GET http://h/ HTTP/1.1\r\n\r\n");
  // A tag that is not one of ours names no call, and the request after it still goes on.
  const odd = takeTag(enc("KEEL-TAG ../x y\r\nGET / HTTP/1.1\r\n\r\n"));
  expect(odd !== "need" && odd.tag).toBe(undefined);
  expect(odd !== "need" && dec(odd.rest)).toBe("GET / HTTP/1.1\r\n\r\n");
});

test("a row's reason keeps no address: no user, path or query, and the short ssh form as its host", () => {
  expect(plainWhy("fatal: unable to access 'https://git.example/some/path.git?x=SECRET/': Could not resolve host: git.example"))
    .toBe("fatal: unable to access 'https://git.example': Could not resolve host: git.example");
  expect(plainWhy("Unable to connect: https://user:tok@api.example.com:8443/v1/x?key=abc")).toBe("Unable to connect: https://api.example.com");
  expect(plainWhy("fatal: Could not read from remote repository git@code.example:org/private.git")).toBe("fatal: Could not read from remote repository code.example");
  expect(plainWhy("GET api.example.com/v1/search?q=secret failed")).toBe("GET api.example.com failed");
  expect(plainWhy("upstream ws://[::1]:8080/path?a=b closed")).toBe("upstream ws://[::1] closed");
  expect(plainWhy("the query ?token=abc was refused")).not.toContain("abc");
  // Words that name no address are kept as they are.
  expect(plainWhy("connect ECONNREFUSED 127.0.0.1:9999")).toBe("connect ECONNREFUSED 127.0.0.1:9999");
  expect(plainWhy("a local or private address")).toBe("a local or private address");
});

test("a failed push is kept as its class, never git's words", () => {
  expect(pushFailure("To https://h/x.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'https://h/x.git?t=1'")).toBe("the push was refused");
  expect(pushFailure("remote: Permission to o/r.git denied.\nfatal: unable to access 'https://h/o/r.git/': The requested URL returned error: 403")).toBe("the sign-in was refused");
  expect(pushFailure("fatal: Authentication failed for 'https://h/o/r.git/'")).toBe("the sign-in was refused");
  expect(pushFailure("fatal: unable to access 'https://h/p.git?x=SECRET/': Could not resolve host: h")).toBe("the remote was unreachable");
  expect(pushFailure("ssh: connect to host h port 22: Connection refused")).toBe("the remote was unreachable");
  expect(pushFailure("something else entirely")).toBe("the push failed");
});

test("a socket's opening and its messages are counted as they go on the wire", () => {
  // The opening: a GET with the client's four upgrade headers, at the http address.
  const upgrade = "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + "x".repeat(24) + "\r\n";
  expect(handshakeBytes("wss://api.example/v1/responses", { authorization: "Bearer t" }))
    .toBe(Buffer.byteLength("GET /v1/responses HTTP/1.1\r\nHost: api.example\r\nauthorization: Bearer t\r\n" + upgrade + "\r\n"));
  // A client frame: two bytes, the longer length past 125 and past 65,535, and the mask.
  expect([frameBytes(0), frameBytes(125), frameBytes(126), frameBytes(65_535), frameBytes(65_536)]).toEqual([6, 131, 134, 65_543, 65_550]);
});
