import { expect, test } from "bun:test";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { detect, ordinaryValue, publicNames, StreamScan, Vault, wordSwap } from "./secrets.ts";

const GH = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
const AWS = "AKIA" + "QWERTYUIOPASDFGH";

test("token formats and secret-sounding assignments are found, plain code is not", () => {
  expect(detect(`token ${GH} here`).map((h) => h.kind)).toEqual(["GitHub token"]);
  expect(detect(`export AWS_ACCESS_KEY_ID=${AWS}`)[0]!.value).toBe(AWS);
  expect(detect("API_KEY=9fK2mQx7Lp3Zr8Tw")[0]!.value).toBe("9fK2mQx7Lp3Zr8Tw");
  expect(detect("postgres://app:s3cretPa55w0rd@db.internal:5432/x")[0]!.value).toBe("s3cretPa55w0rd");
  expect(detect("const token = getToken(); max_tokens = 4096; password = os.environ['PASSWORD']")).toEqual([]);
  expect(detect("API_KEY=$API_KEY and TOKEN=${TOKEN}")).toEqual([]);
});

// What a coding session prints all day is not a credential: a name that only
// contains a secret word, a hash, a cursor, a revision or code. Taking one
// would hide it from the model and change the history it was sent in.
test("hashes, cursors, revisions and code under token-ish names are not secrets", () => {
  const h64 = "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d", h40 = h64.slice(3, 43);
  for (const text of [
    `tokens_sha256: "${h64}"`, `'tokenizer_revision': '${h40}'`, `tokenizer.json: sha256=${h64}`,
    `"next_page_token": "CAESEgoQMjAyNi0xMS0yMA"`, "self.token_key_norm = RMSNorm2d_eps1e5",
    "if self.per_token_activation:\n            hidden2=self.act_fn2_scaled", "detokenize_fn=sentencepiece_v2_decode",
    "password_reset_test_id: case_0042_expired_link", "secret_scanning_cache_key=v3-linux-x86_64-bun1.4.2",
    "max_new_tokens=512, tokens_per_s=130.1337679319463", "GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}",
    "api_key = load_key2(cfg)", "token = self.cfg.auth2.token_value",
  ]) expect({ text, hits: detect(text) }).toEqual({ text, hits: [] });
  const v = "Ab3dEf9hJk2mNp5qRs8tUv1wXy4zA7cE";
  for (const [text, value] of [
    [`export DB_PASSWORD='${v.slice(0, 18)}'`, v.slice(0, 18)], [`"client_secret": "${v}"`, v], [`authToken: "${v}"`, v],
    [`self.api_key = "${v}"`, v], [`curl -H "X-Api-Key: ${v}" https://x.example`, v], [`GITHUB_TOKEN=${h40}`, h40], [`refresh_token=${v}`, v],
  ] as [string, string][]) expect({ text, value: detect(text)[0]?.value }).toEqual({ text, value });
});

// The login name, the host's name and the home path's folders are on every
// line a session prints. A keyring label has the shape of a URL with a
// password: the login name taken there was replaced in every path of every
// session, and no path with a placeholder in it opens. The word a document
// writes where a credential goes is not one either.
test("the machine's own names and template words are never secrets", () => {
  const url = (head: string, pw: string, host: string) => head + ":" + pw + "@" + host;
  publicNames.add("jordanlee");
  const label = url("keyring:https://github.com", "jordanlee", "copilot-cli");
  expect(detect(label)).toEqual([]);
  const v = new Vault();
  expect(v.redact(`${label}\n/home/jordanlee/projects/app`, "s1", "output")).toBe(`${label}\n/home/jordanlee/projects/app`);
  expect(v.list()).toEqual([]);
  for (const pw of ["<token>", "$DB_PASSWORD", "${DB_PASSWORD}", "{{redis_password}}", "password", "TOKEN", "********"]) {
    const text = url("postgres://app", pw, "db.internal:5432/x");
    expect({ text, hits: detect(text) }).toEqual({ text, hits: [] });
  }
  // A real one is still taken, and so is a login name nobody declared public.
  expect(detect(url("postgres://app", "s3cretPass9", "db.internal:5432/x"))[0]!.value).toBe("s3cretPass9");
  expect(detect(url("keyring:https://github.com", "samrivera", "copilot-cli"))[0]!.kind).toBe("password in a URL");
});

test("a value is one placeholder, put back only in its sessions, and named for commands", () => {
  const v = new Vault();
  const a = v.redact(`use ${GH} please`, "s1", "prompt");
  expect(a).toMatch(/^use \[secret:[0-9a-f]{8}\] please$/);
  expect(v.redact(`again ${GH}`, "s1", "output")).toBe(a.replace("use", "again").replace(" please", ""));
  expect(v.redact(`echo ${GH.slice(0, 20)}`, "s1", "prompt")).toMatch(/^echo \[secret:[0-9a-f]{8}\]$/);
  const ph = a.match(/\[secret:[0-9a-f]{8}\]/)![0];
  const sh = new Set(["command"]);
  expect(Object.values(v.reveal({ command: `curl -H "Authorization: token ${ph}"` }, "s1", sh).env)).toEqual([GH]);
  expect(v.reveal({ command: ph }, "other", sh).value.command).toBe(ph);
  v.parentOf = (s) => (s === "child" ? "s1" : null);
  expect(Object.values(v.reveal({ command: ph }, "child", sh).env)).toEqual([GH]);
  const id = v.list("s1")[0]!.id;
  v.rename(id, "GITHUB_TOKEN");
  expect(v.env("s1")).toEqual({ GITHUB_TOKEN: GH });
  expect(v.redact(`out: ${GH}`, "s1", "output")).toBe("out: [value of $GITHUB_TOKEN]");
  expect(() => v.rename(id, "LD_PRELOAD")).toThrow();
  // Images and signatures stay byte-exact.
  const ev = v.redactDeep({ blocks: [{ type: "text", text: GH, signature: GH }, { type: "image", data: GH }] }, "s1", "output");
  expect(ev.blocks[0]!.text).toBe("[value of $GITHUB_TOKEN]");
  expect(ev.blocks[0]!.signature).toBe(GH);
  expect((ev.blocks[1] as any).data).toBe(GH);
});

// A placeholder in a shell command is a quoted variable on the child only: a
// value full of shell syntax arrives byte for byte wherever the placeholder
// stands (bare, in either quotes, in $( )), and none of it runs.
test("a secret in a shell command arrives exact and runs nothing", () => {
  const v = new Vault();
  const value = `it's "q" $HOME \`touch pwned\` $(touch pwned2)\nline2 \\ end`;
  const e = v.add(value, "test", "card", "s1", "FIX");
  const dir = join(process.env.TMPDIR ?? join(process.env.HOME!, ".cache"), `shell-refs-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
  for (const cmd of [
    "printf %s [value of $FIX] | sha256sum",
    "printf %s '[value of $FIX]' | sha256sum",
    `printf %s "[value of $FIX]" | sha256sum`,
    `printf %s "$(printf %s [secret:${e.id}])" | sha256sum`,
    "printf %s $'[value of $FIX]' | sha256sum",
  ]) {
    const r = v.reveal({ command: cmd, description: "uses [value of $FIX]" }, "s1", new Set(["command"]));
    expect(r.value.command).not.toContain("pwned");
    expect(r.value.description).toBe("uses [value of $FIX]");
    const p = Bun.spawnSync(["bash", "-c", r.value.command], { cwd: dir, env: { PATH: process.env.PATH!, ...r.env } });
    expect({ cmd, out: p.stdout.toString().split(" ")[0] }).toEqual({ cmd, out: sha(value) });
  }
  expect(readdirSync(dir)).toEqual([]);
  // A field that is not a script keeps the placeholder: only a command uses a credential.
  expect(v.reveal({ content: "[value of $FIX]" }, "s1", new Set(["command"])).value.content).toBe("[value of $FIX]");
});

// A heredoc body: an unquoted one (<<EOF) expands a variable but takes quotes
// as text, so it gets a bare reference and the value arrives exact; a quoted
// one (<<'EOF') expands nothing, so its placeholder is reported, never spliced.
test("a secret in a heredoc arrives exact, or is refused where nothing expands", () => {
  const v = new Vault();
  const value = `it's "q" $HOME \`touch pwned\` $(touch pwned2) \\ end`;
  const e = v.add(value, "test", "card", "s1", "FIX");
  const dir = join(process.env.TMPDIR ?? join(process.env.HOME!, ".cache"), `heredoc-refs-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
  const sh = new Set(["command"]);
  for (const cmd of [
    "cat <<EOF | sha256sum\n[value of $FIX]\nEOF",
    `cat <<-END | sha256sum\n\t[secret:${e.id}]\n\tEND`,
    "cat <<EOF | sha256sum; echo '[value of $FIX]' >/dev/null\n[value of $FIX]\nEOF",
  ]) {
    const r = v.reveal({ command: cmd }, "s1", sh);
    expect(r.stuck).toEqual([]);
    const p = Bun.spawnSync(["bash", "-c", r.value.command], { cwd: dir, env: { PATH: process.env.PATH!, ...r.env } });
    expect({ cmd, out: p.stdout.toString().split(" ")[0] }).toEqual({ cmd, out: sha(`${value}\n`) });
  }
  expect(readdirSync(dir)).toEqual([]);
  for (const cmd of ["cat <<'EOF'\n[value of $FIX]\nEOF", `cat <<"EOF"\nx [value of $FIX]\nEOF`, "cat <<\\EOF\n[value of $FIX]\nEOF"]) {
    const r = v.reveal({ command: cmd }, "s1", sh);
    expect({ cmd, stuck: r.stuck }).toEqual({ cmd, stuck: ["[value of $FIX]"] });
    expect(r.value.command).not.toContain(value);
  }
  // After the quoted heredoc ends, the command goes on as usual.
  const after = v.reveal({ command: "cat <<'EOF'\nplain\nEOF\nprintf %s [value of $FIX] | sha256sum" }, "s1", sh);
  expect(after.stuck).toEqual([]);
  expect(Bun.spawnSync(["bash", "-c", after.value.command], { cwd: dir, env: { PATH: process.env.PATH!, ...after.env } }).stdout.toString()).toContain(sha(value));
});

// The last mask before a request: every string holding a known value is
// masked wherever it sits, a tool call's input at any depth included (its
// field names say nothing); only the provider's own bytes at their known
// places stay byte-exact.
test("the request mask covers every field but the provider's own bytes", () => {
  const v = new Vault();
  const value = "fixture-raw-value-0123456789";
  v.add(value, "test", "card", "s1", "FIX");
  const call = (input: unknown) => [{ role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input }] }];
  for (const [name, input] of [
    ["text", { text: value }],
    ["data", { data: value }],
    ["signature", { signature: value }],
    ["opaque", { opaque: value }],
    ["an object typed image", { nested: { type: "image", data: value } }],
    ["an object typed thinking", { deep: [{ type: "thinking", thinking: value }] }],
  ] as const) {
    const out = JSON.stringify(v.mask(call(input)));
    expect({ name, has: out.includes(value) }).toEqual({ name, has: false });
    expect(out).toContain("[value of $FIX]");
  }
  // A tool result's text and an image in it.
  const img = { type: "image", media_type: "image/png", data: value };
  const res = v.mask([{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text: value }, img] }] }]) as any;
  expect(res[0].content[0].content[0].text).toBe("[value of $FIX]");
  expect(res[0].content[0].content[1]).toBe(img);
  // The provider's bytes stay: an image's data, a signed thinking block, a tool call's signature.
  const signed = { type: "thinking", thinking: value, signature: "sig", bind: "b1" };
  const redacted = { type: "redacted_thinking", data: value, bind: "b2" };
  const msgs = [{ role: "user", content: [img] }, { role: "assistant", content: [signed, redacted, { type: "tool_use", id: "t", name: "x", input: {}, signature: value }] }];
  const kept = v.mask(msgs) as any;
  expect(kept[0]).toBe(msgs[0]);
  expect(kept[1].content[0]).toBe(signed);
  expect(kept[1].content[1]).toBe(redacted);
  expect(kept[1].content[2].signature).toBe(value);
  // Nothing known: the same objects.
  const clean = [{ role: "user", content: [{ type: "text", text: "plain" }] }];
  expect(v.mask(clean)).toBe(clean);
});

// A value found late is masked going forward only: what a model was sent goes
// again byte for byte (its cache and signed thinking stay), what is new is
// masked, and another model gets none of it.
test("a value found later never changes history already sent", () => {
  const v = new Vault();
  const value = "fixture-late-value-0123456789";
  const m1 = { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: `printed ${value}` }] };
  const first = v.maskSent("s1 m", [m1]);
  expect(first[0]).toBe(m1);
  v.add(value, "test", "output", "s1");
  const m2 = { role: "user", content: [{ type: "text", text: `again ${value}` }] };
  const second = v.maskSent("s1 m", [m1, m2]) as any[];
  expect(second[0]).toBe(m1);
  expect(JSON.stringify(second[1])).not.toContain(value);
  expect(JSON.stringify(v.maskSent("s1 other", [m1, m2]))).not.toContain(value);
});

// A value a rule found by its name is a known value: stored text holds it
// nowhere, in the same string or in another string of the same event. A copy
// left would go masked in the next request and as stored after a restart,
// which forgets the value: the cached history would change there.
test("a value found by its name is replaced wherever else the stored text holds it", () => {
  const v = new Vault();
  const value = ["k9Xq", "7Lm2pQ8", "rT4w"].join("");
  const one = v.redact(`API_KEY=${value} and again ${value}`, "s1", "prompt");
  expect(one).not.toContain(value);
  expect(one.match(/\[secret:[0-9a-f]{8}\]/g)).toHaveLength(2);
  const other = ["x2Mn", "8Qw4Ze", "6Yp1"].join("");
  const deep = v.redactDeep({ content: [{ type: "text", text: `bare ${other}` }, { type: "text", text: `TOKEN=${other}` }] }, "s1", "output");
  expect(JSON.stringify(deep)).not.toContain(other);
});

// A message that went masked (a value its stored event holds was found after
// it was stored: another result of the same batch) goes the same after a
// restart, when no value is known: the bytes the provider cached.
test("a message sent masked goes the same after a restart", () => {
  const rows = new Map<string, Map<string, string>>();
  const log = {
    load: (key: string) => [...(rows.get(key) ?? [])],
    save: (key: string, mark: string, m: string) => void (rows.get(key) ?? rows.set(key, new Map()).get(key)!).set(mark, m),
  };
  const value = ["fixture", "late", "value", "0123456789"].join("-");
  const m1 = { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: `bare ${value}` }, { type: "tool_result", tool_use_id: "b", content: "API_KEY=[secret:00000000]" }] };
  const before = new Vault();
  before.sentLog = log;
  before.add(value, "test", "output", "s1");
  const sent = JSON.stringify(before.maskSent("s1 m", [m1]));
  expect(sent).not.toContain(value);
  const m2 = { role: "assistant", content: [{ type: "text", text: "next" }] };
  const after = new Vault();
  after.sentLog = log;
  const again = after.maskSent("s1 m", [m1, m2]);
  expect(JSON.stringify(again[0])).toBe(JSON.stringify(JSON.parse(sent)[0]));
  expect(again[1]).toBe(m2);
});

// After a restart (a new Vault, the same key and ledger) a value seen again
// has its old placeholder, and one whose value is gone is told apart from
// text that only looks like a placeholder.
test("placeholders outlive a restart and a forgotten one is named", () => {
  const key = new Uint8Array(32).fill(7);
  const ids = new Set<string>();
  const ledger = { issued: (id: string) => void ids.add(id), has: (id: string) => ids.has(id) };
  const before = new Vault();
  before.useKey(key);
  before.ledger = ledger;
  const ph = before.redact(`token ${GH}`, "s1", "output").split(" ")[1]!;
  const after = new Vault();
  after.useKey(key);
  after.ledger = ledger;
  const cmd = { command: `./verify ${ph} [secret:1a2b3c4d] [value of $NOPE]`, description: ph };
  expect(after.placeholders(cmd, "s1", new Set(["command"]))).toEqual({ held: [], gone: [ph, "[value of $NOPE]"] });
  expect(after.redact(`again ${GH}`, "s1", "output")).toBe(`again ${ph}`);
  expect(after.placeholders(cmd, "s1", new Set(["command"]))).toEqual({ held: [ph], gone: ["[value of $NOPE]"] });
  expect(after.placeholders({ content: { nested: [ph] } }, "other")).toEqual({ held: [], gone: [ph] });
});

// A reply streams a few characters at a time, and a secret is cut by the end
// of a piece wherever the model's tokens fall. What is shown of the stream is
// what redact() makes of the whole text: no piece gives out the start of a
// secret before the piece that completes it has been seen.
test("a secret cut by a piece's end is caught: a stream in pieces reads as the whole text redacted", () => {
  const key = Array.from({ length: 16 }, (_, i) => "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj".slice(0, 60) + String(1000 + i)).join("\n");
  const texts = [
    `Here is the token ${GH} and more text after it.`,
    `first export AWS_ACCESS_KEY_ID=${AWS} then run the deploy, please`,
    `set API_KEY = "a8Kq2mZx91LpQw7RtY3v" in the file and go on`,
    `curl -H "Authorization: Bearer abcDEF123456ghiJKL789mno" https://example.test/x`,
    `the database is at postgres://app:s3cr3tPassw0rd99@db.internal:5432/app for now`,
    `intro\n-----BEGIN RSA PRIVATE KEY-----\n${key}\n-----END RSA PRIVATE KEY-----\noutro text here`,
    `nothing secret here: const token = getToken(); max_tokens = 4096; a path /usr/local/bin and words`,
    `中文说明 ${GH} 之后的文字，没有空格的一段话继续写下去直到结束`,
    `a long run ${"x".repeat(700)}${GH}${"y".repeat(700)} ends`,
    `two in a row ${GH} ${AWS} done`,
    `the owner's pass phrase is correct horse battery staple and then more words follow it`,
  ];
  const known = "correct horse battery staple";
  // (One key for every vault here: a value has the same placeholder in each.)
  const KEY = new Uint8Array(32).fill(7);
  let rnd = 9;
  const rand = (n: number) => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) % n);
  let pieces = 0, held = 0;
  for (const text of texts) {
    const whole = new Vault();
    whole.useKey(KEY);
    whole.add(known, "password", "prompt", "s");
    const want = whole.redact(text, "s", "output");
    // Every place to cut once, then cuts at random (a few characters a piece, as a model streams).
    const cuts: number[][] = Array.from({ length: text.length - 1 }, (_, i) => [i + 1]);
    for (let n = 0; n < 60; n++) {
      const at: number[] = [];
      for (let i = 1 + rand(6); i < text.length; i += 1 + rand(9)) at.push(i);
      cuts.push(at);
    }
    for (const at of cuts) {
      const v = new Vault();
      v.useKey(KEY);
      v.add(known, "password", "prompt", "s");
      const scan = new StreamScan(v);
      let out = "", from = 0;
      for (const to of [...at, text.length]) {
        const got = scan.piece("k", "s", text.slice(from, to));
        // Nothing that is given out holds the start of a secret the whole text has.
        for (const h of detect(text)) if (h.end > to) expect({ text: text.slice(0, 40), at, leaked: (out + got).includes(h.value.slice(0, 12)) }).toEqual({ text: text.slice(0, 40), at, leaked: false });
        if (!got && to < text.length) held++;
        out += got;
        from = to;
        pieces++;
      }
      out += scan.end("k", "s");
      expect({ at, out }).toEqual({ at, out: want });
    }
  }
  // The pieces did cut secrets, and some pieces waited.
  expect(pieces).toBeGreaterThan(5000);
  expect(held).toBeGreaterThan(500);
  // And what is given out from a place on is what the whole reads from that place.
  const v = new Vault();
  expect(v.redactTail(`token ${GH} here`, 0, "s", "output")).toBe(v.redact(`token ${GH} here`, "s", "output"));
  expect(v.redactTail(`API_KEY=${AWS} here`, 8, "s", "output")).toBe(v.redact(`API_KEY=${AWS} here`, "s", "output").slice(8));
  expect(v.redactTail(`token ${GH} here`, 10, "s", "output")).toBe(`${v.redact(GH, "s", "output")} here`);
});

// A value ordinary text holds as it is: a word, a short number, a run of a
// few characters. Real keys (token formats, long random values) are none.
test("a value that ordinary text holds is told apart from a key", () => {
  for (const v of ["lantern", "Harbor", "SESAME", "changeme", "well-known", "don't", "café", "1234", "20261121", "abc", "aaaabbbb", "121212121212", "blue moon"]) expect({ v, plain: !!ordinaryValue(v) }).toEqual({ v, plain: true });
  for (const v of [GH, AWS, "s3cretPa55w0rd", "deploy-k2j4h5-Zx9", "qWeRtYzXcV", "Xk9#q2", "0123456789abcdef0123456789abcdef01234567", "correct horse battery staple"]) expect({ v, plain: ordinaryValue(v) }).toEqual({ v, plain: null });
});

// A word is 12 letters at most: a longer run of letters in one case is
// likelier a key than a word, and is hidden wherever it stands.
test("a run of letters past twelve is a key, not a word", () => {
  for (const v of ["unbelievable", "Encyclopedia"]) expect({ v, plain: ordinaryValue(v) }).toEqual({ v, plain: "is a word" });
  for (const v of ["qzmwkxjvbnprt", "QZMWKXJVBNPRTLA", "Unbelievablenesses"]) expect({ v, plain: ordinaryValue(v) }).toEqual({ v, plain: null });
});

// A secret whose value is the word a placeholder is made of ("secret",
// "value") never cuts into a placeholder already in the text.
test("an ordinary value inside a placeholder is the placeholder's", () => {
  // (Put together here: written whole, a placeholder of a secret no daemon holds.)
  const id = "[sec" + "ret:ab12cd34]", named = "[value of $" + "TOKEN_VALUE]";
  expect(wordSwap(`see ${id} and the secret`, "secret", "[P]")).toBe(`see ${id} and the [P]`);
  expect(wordSwap(`${named} value`, "value", "[P]")).toBe(`${named} [P]`);
  const v = new Vault();
  v.add(GH, "a setting", "card", "s1", undefined, { given: true });
  v.add("secret", "a setting", "card", "s1", undefined, { given: true });
  const out = v.redact(`key ${GH}; the secret`, "s1", "output");
  expect(out).toMatch(/^key \[secret:[0-9a-f]{8}\]; the \[secret:[0-9a-f]{8}\]$/);
});

// The gate's checks (a URL that carries a secret, a call Auto must not
// review) see a key anywhere and an ordinary value of eight or more where it
// stands as a word: a real key that looks like a word still asks.
test("the gate is told of an ordinary value of eight or more as a whole word", () => {
  const v = new Vault();
  v.add("pinecones", "given secret", "card", "s1", undefined, { given: true });
  v.add("harbor", "given secret", "card", "s1", undefined, { given: true });
  v.add(GH, "given secret", "card", "s1", undefined, { given: true });
  expect(v.holdsValue("https://example.com/?q=pinecones")).toBe(true);
  expect(v.holdsValue("curl -d \u201cpinecones\u201d")).toBe(true);
  expect(v.holdsValue("https://example.com/pineconesx")).toBe(false);
  expect(v.holdsValue("https://example.com/?q=harbor")).toBe(false);
  expect(v.holdsValue(`x${GH}x`)).toBe(true);
  expect(v.pairs().map(([x]) => x)).toEqual([GH]);
});

const PH = /\[secret:[0-9a-f]{8}\]/;

// A secret whose value is a word (the owner gave "lantern"): the model's own
// words keep it (a reply, a tool call's input, an agent's prompt), so nothing
// the model wrote turns into a placeholder that a command would expand. Tool
// output still hides it, as a whole word only.
test("a secret that is an ordinary word never replaces the model's own words", () => {
  const v = new Vault();
  v.add("lantern", "given secret", "card", "s1", undefined, { given: true });
  const ph = v.list("s1")[0]!.placeholder;
  const call = { blocks: [{ type: "text", text: "I will ask an agent about the lantern." }, { type: "tool_use", id: "t1", name: "Agent", input: { description: "Check the lantern", prompt: "Read the lantern folder and report." } }] };
  expect(v.redactDeep(call, "s1", "output", "own")).toEqual(call);
  expect(v.redact("Look at the lantern notes", "s1", "prompt", "own")).toBe("Look at the lantern notes");
  expect(v.redact("the lantern is lit; lanterns and lanternfish stay", "s1", "output")).toBe(`the ${ph} is lit; lanterns and lanternfish stay`);
  const msgs = [
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Agent", input: { prompt: "the lantern folder" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "lantern: on" }, { type: "text", text: "about the lantern" }] },
  ];
  const masked = v.mask(msgs) as any[];
  expect(masked[0]).toBe(msgs[0]);
  expect(masked[1].content[0].content).toBe(`${ph}: on`);
  expect(masked[1].content[1].text).toBe("about the lantern");
  expect(v.pairs().map(([x]) => x)).not.toContain("lantern");
  // A reply as it streams is the model's own words too.
  const scan = new StreamScan(v);
  expect(scan.piece("k", "s1", "the lan") + scan.piece("k", "s1", "tern is fine") + scan.end("k", "s1")).toBe("the lantern is fine");
  // A placeholder the model wrote itself still runs with the value.
  expect(Object.values(v.reveal({ command: `echo ${ph}` }, "s1", new Set(["command"])).env)).toEqual(["lantern"]);
  // A real key stays hidden in the model's own words, as before.
  expect(v.redact(`run with ${GH}`, "s1", "output", "own")).toMatch(/^run with \[secret:[0-9a-f]{8}\]$/);
});

// A word found where a credential stands (a password in a URL) is hidden
// there, and only there: the word elsewhere is ordinary text.
test("a word found as a URL's password is hidden in the URL only", () => {
  const v = new Vault();
  const url = v.redact("connect to redis://app:sesame@db.internal:6379/0", "s1", "output");
  expect(url).toMatch(/^connect to redis:\/\/app:\[secret:[0-9a-f]{8}\]@db\.internal:6379\/0$/);
  expect(v.redact("open sesame now", "s1", "output")).toBe("open sesame now");
  expect(v.redact("say sesame", "s1", "prompt", "own")).toBe("say sesame");
  expect(JSON.stringify(v.mask([{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "sesame up" }] }]))).toContain("sesame up");
  expect(PH.test(url)).toBe(true);
});

// The owner is told once that a value they gave will match ordinary text,
// and not again after a restart (the same value has the same id).
test("a secret that is an ordinary word is warned of once", () => {
  const key = new Uint8Array(32).fill(3);
  const warned = new Set<string>();
  const ledger = { issued: () => {}, has: () => false, warned: (id: string) => warned.has(id), warn: (id: string) => void warned.add(id) };
  const told: string[] = [];
  const v = new Vault();
  v.useKey(key);
  v.ledger = ledger;
  v.on((ev) => { if (ev.type === "ordinary") told.push(ev.secret.id); });
  v.add("harbor", "a setting", "card", null, undefined, { given: true });
  v.add("harbor", "a setting", "card", "s1", undefined, { given: true });
  v.add(GH, "a setting", "card", null, undefined, { given: true });
  v.add("meadow", "given secret", "card", "s1", undefined, { given: true, confirmed: true });
  expect(told.length).toBe(1);
  expect(v.list().find((m) => m.id === told[0])!.ordinary).toBeTruthy();
  const again = new Vault();
  again.useKey(key);
  again.ledger = ledger;
  again.on((ev) => { if (ev.type === "ordinary") told.push(ev.secret.id); });
  again.add("harbor", "a setting", "card", null, undefined, { given: true });
  expect(told.length).toBe(1);
});

// A forgotten secret says which sessions held it, so a frame can name them (a frame that names no session
// is not relayed to another machine, src/core/outside.ts).
test("forgetting a secret tells the sessions that held it", () => {
  const v = new Vault();
  const told: unknown[] = [];
  v.on((ev) => { if (ev.type === "forgotten") told.push(ev); });
  const id = v.add(GH, "token", "card", "s1", undefined, { given: true }).id;
  v.add(GH, "token", "card", "s2", undefined, { given: true });
  expect(v.forget(id)).toBe(true);
  expect(told).toEqual([{ type: "forgotten", id, sessions: ["s1", "s2"] }]);
});

test("a piece of a known key is the key, cut; a short piece or an ordinary word is not", () => {
  const key = "sk-live-9f8e7d6c5b4a39281706";
  const v = new Vault();
  v.add(key, "token", "card", null, undefined, { given: true });
  expect(v.partOfValue(key.slice(4, 16))).toBe(true);
  expect(v.partOfValue(key.slice(0, 6))).toBe(true);
  expect(v.partOfValue(key.slice(0, 5))).toBe(false);
  expect(v.partOfValue("pricing plans")).toBe(false);
});
