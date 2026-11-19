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
