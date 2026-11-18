import { expect, test } from "bun:test";
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
  expect(v.reveal({ command: `curl -H "Authorization: token ${ph}"` }, "s1").value.command).toContain(GH);
  expect(v.reveal({ command: ph }, "other").value.command).toBe(ph);
  v.parentOf = (s) => (s === "child" ? "s1" : null);
  expect(v.reveal({ command: ph }, "child").value.command).toBe(GH);
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
