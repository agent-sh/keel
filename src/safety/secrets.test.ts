import { expect, test } from "bun:test";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { detect, Vault } from "./secrets.ts";

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
