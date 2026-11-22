import { expect, test } from "bun:test";
import { streamConcealer } from "./conceal.ts";

// A value split across chunks, at every cut point, never comes out whole or in part.
test("a known value is replaced even when chunks split it", () => {
  const value = "fixture-sentinel-Zq7";
  const text = `before ${value} middle ${value}${value} after fixt`;
  for (let a = 1; a < text.length; a++) {
    const sc = streamConcealer([[value, "[value of $X]"]]);
    const out = Buffer.concat([sc.push(Buffer.from(text.slice(0, a))), sc.push(Buffer.from(text.slice(a))), sc.end()]).toString();
    expect(out).toBe(`before [value of $X] middle [value of $X][value of $X] after fixt`);
  }
  // Bytes of a multi-byte character cut between chunks come out whole.
  const sc = streamConcealer([["s3cr3t-é", "[secret:1]"]]);
  const b = Buffer.from("x s3cr3t-é ü");
  expect(Buffer.concat([sc.push(b.subarray(0, 9)), sc.push(b.subarray(9)), sc.end()]).toString()).toBe("x [secret:1] ü");
});

// What is stored about a failure, told to a model or written to the log never holds a
// key-shaped string, known to Keel or not. (The shapes are put together here, so this
// file holds nothing a scanner reads as a key.)
const j = (...p: string[]) => p.join("");
const tail = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH";
// The six kinds a failure's text carries most, each with a mark that must not survive.
export const SECRET_KINDS: [kind: string, text: string, mark: string][] = [
  ["provider key", j("sk-", "ant-api03-", "PLANTprov", tail), "PLANTprov"],
  ["GitHub token", j("ghp", "_PLANTgh", tail.slice(0, 30)), "PLANTgh"],
  ["AWS key and secret", j("AKIA", "PLANTAWS", "12345678", " aws_secret_access_key = ", "wJalrXUtnFEMI/K7MDENG/bPxRfiCY", "PLANTsec9"), "PLANT"],
  ["bearer header", j("Authorization: ", "Bearer ", "PLANTbearer", "0123456789abcdef"), "PLANTbearer"],
  ["URL with a password", j("https://deploy:", "PLANTurlpw9", "@git.example.com/repo.git"), "PLANTurlpw"],
  ["named value", j("DEPLOY_TOKEN", "=", "PLANTtok7f3a9c2e1b5d8"), "PLANTtok"],
];
test("the six kinds of secret are hidden, with the other common shapes", async () => {
  const { keyShaped, keyShapedDeep, scrubbed } = await import("./conceal.ts");
  for (const [kind, text, mark] of SECRET_KINDS) {
    for (const line of [`fatal: ${text} was rejected`, text, `Exit code 5\n${text}`, `error: "${text}"`, `failed with ${text}: ${text}, again`, `env GITHUB_TOKEN=${text}; ${text}.`]) expect(`${kind}: ${keyShaped(line)}`).not.toContain(mark);
    expect(`${kind}: ${scrubbed(`x ${text}`)}`).not.toContain(mark);
  }
  const KEY = SECRET_KINDS[0]![1];
  expect(keyShaped(`echo marker ${KEY}; exit 5`)).toBe("echo marker <redacted>; exit 5");
  const shapes = [
    ["github", "_pat_", `11ABCDEFG${tail.slice(0, 20)}`], ["xox", "b-", "0123456789-abcdefghij"], ["AK", "IA", "0123456789ABCDEF"],
    ["AI", "za", `SyA-${tail.slice(0, 20)}`], ["xa", "i-", tail.slice(0, 20)], ["ey", "J", `${tail.slice(0, 24)}.${tail.slice(0, 16)}.${tail.slice(10, 30)}`],
  ].map((parts) => parts.join(""));
  for (const k of shapes) expect(keyShaped(`token ${k} end`)).toBe("token <redacted> end");
  expect(keyShaped(`Authorization: ${"Bear"}er ${tail.slice(0, 20)}`)).toBe("Authorization: Bearer <redacted>");
  expect(keyShaped(`GET /v1/models?api_${"key"}=abc123def456&x=1`)).toBe("GET /v1/models?api_key=<redacted>&x=1");
  expect(keyShaped(j("-----BEGIN OPENSSH ", "PRIVATE KEY-----\n", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ", "PLANTpem", "AAAAAAAAAAAAAAAAAAAAAAAA\n-----END OPENSSH ", "PRIVATE KEY-----"))).not.toContain("PLANTpem");
  expect(keyShaped(j('"SecretAccessKey"', ': "', "wJalrXUtnFEMI/K7MDENG/bPxRfiCY", 'PLANTsecC"'))).not.toContain("PLANTsecC");
  expect(keyShapedDeep({ at: "tool", out: [`x ${KEY}`], n: 3, deep: { k: KEY } })).toEqual({ at: "tool", out: ["x <redacted>"], n: 3, deep: { k: "<redacted>" } });
});

// The scrub runs on what a person and a model read about a failure: a file name, a hash,
// an id or an assignment in code that it ate would make the failure unreadable.
test("ordinary lines pass the scrub unchanged", async () => {
  const { keyShaped } = await import("./conceal.ts");
  const ordinary = [
    // hashes and ids
    "commit 74d3746b32778b32a6cede971201681baeab64ed", "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "md5 d41d8cd98f00b204e9800998ecf8427e",
    "session 01a2023d-1cda-7373-8409-6d94cb93121f failed", "trace id 01a2023f440977adb9ec9150a9e850d7", "span 61fd7184d16d5434 parent 8f5c84593c2448b4",
    "blob sha512-Gi2Qw3Jv0Z1t0n5L5m2iJ2y3a9v0H5Vz8l1n4d7s6k3p0q2r5t8w1x4z7c0f3i6l9o2r5u8x1a4d7g0j3m6p9s2A== fetched", "Digest: sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    "uuid 550e8400-e29b-41d4-a716-446655440000", "request id req_011CSHoEeqs5C35K2UUqR7Fy", "build 20261122.3 (g7a36cddb)", "ETag: W/\"5e2f-18c9a7b3d40\"",
    // base64 of short strings
    "image name aW1hZ2UtbmFtZS1vZi1hLXNjcmVlbnNob3QucG5n (base64)", "payload aGVsbG8gd29ybGQ= decoded to hello world", "cursor eyJwYWdlIjoyfQ== is the next page", "data:text/plain;base64,SGVsbG8sIFdvcmxkIQ==",
    // file names and paths
    "sketch-book-of-drawings-and-other-things.pdf was not found", "skipping 12 files in /home/user/project/src", "task-runner exited with code 2", "desk-lamp-controller-firmware-v2 failed to flash",
    "ask-for-a-review-before-merging-this-branch", "risk-assessment-document-2026-final.docx", "/srv/app/sk-learn-notebooks-2026/readme.md: No such file or directory", "skeleton_loader_v2_final_0123456789.tsx changed",
    "open '/var/lib/keel/state/keys/session-keyring-2026.json': permission denied", "node_modules/.bin/eslint-config-prettier-check0123 not found", "xai-integration-tests-are-skipped-here.md", "AIzawa-san-notes-on-the-design-review.txt",
    "ghp is the prefix of a token, not a token", "xoxo from the team", "eyJ is how a JWT starts", "AKIAN is not a region",
    // sentences about keys
    "the key is under the mat", "monkey=banana is not a setting", "keyboard layout key=value pairs are parsed: lang=en", "Bearer of bad news: the build broke",
    "bearer authentication is not configured for this server", "token count 123456 exceeds 64000", "the token limit is 200000 and the turn used 180000", "password must be at least 12 characters",
    "error: lane 3 build failed at step 3", "fatal: remote rejected the push (protected branch)", "disk-usage: 81% of /dev/nvme0n1p2", "color #1e293b on #f8fafc",
    // URLs with query strings
    "https://example.com/billing?plan=pro&seats=5", "GET /api/errors?session=01a2023d-1bf8-71bd-ab57-e26ecf783f0c 200", "https://example.com/search?q=monkey+key&page=2&sort=newest", "GET /v1/items?cache_key=a1b2c3d4e5f6&next_page_token=abc123def456 404",
    "https://registry.npmjs.org/@scope%2fpackage/-/package-1.2.3.tgz", "https://user@example.com/repo.git", "postgres://localhost:5432/keel_test?sslmode=disable", "http://127.0.0.1:46862/v1/traces?batch=12&sig=none",
    "npm ERR! code E404 @scope/package-name-that-is-long", "ssh://git@github.com:22/owner/repo.git",
    // code with assignments
    "const key = items[index].id;", "let token = tokens.next();", "max_tokens=64000 temperature=0.2", "token_count: 18230, cache_key: turn-0012",
    "const password = process.env.DB_PASSWORD;", "secret = config.secrets.get(name)", "for (const [key, value] of Object.entries(map)) out[key] = value;", "tokens_sha256 = 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b",
    "api_key: ${API_KEY}", "token=<token>", "export PATH=/usr/local/bin:/usr/bin", "KEEL_STATE_DIR=/home/user/.local/share/keel/state",
    "Exit code 4", "task-runner skipped 01a201a4-4253-74d6-ab8a-e1e0cd415773 at /home/user/sketch-book/skill.md: Exit code 4",
  ];
  expect(ordinary.length).toBeGreaterThanOrEqual(60);
  expect(ordinary.filter((l) => keyShaped(l) !== l).map((l) => `${l}  ->  ${keyShaped(l)}`)).toEqual([]);
});
