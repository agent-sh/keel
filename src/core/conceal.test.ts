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

// What is stored about a failure never holds a key-shaped string, known to Keel or not.
// (The shapes are put together here, so this file holds nothing a scanner reads as a key.)
test("a key-shaped string is hidden before a failure's text is stored", async () => {
  const { keyShaped, keyShapedDeep, scrubbed } = await import("./conceal.ts");
  const tail = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGH";
  const KEY = ["sk", "ant", "api03", `PLANTEDKEY${tail}`].join("-");
  expect(keyShaped(`echo marker ${KEY}; exit 5`)).toBe("echo marker <redacted>; exit 5");
  expect(scrubbed(`Exit code 5\n${KEY}`)).toBe("Exit code 5\n<redacted>");
  const shapes = [
    ["gh", "p_", tail.slice(0, 30)], ["github", "_pat_", `11ABCDEFG${tail.slice(0, 20)}`], ["xox", "b-", "0123456789-abcdefghij"], ["AK", "IA", "0123456789ABCDEF"],
    ["AI", "za", `SyA-${tail.slice(0, 20)}`], ["xa", "i-", tail.slice(0, 20)], ["ey", "J", `${tail.slice(0, 24)}.${tail.slice(0, 16)}.${tail.slice(10, 30)}`],
  ].map((parts) => parts.join(""));
  for (const k of shapes) expect(keyShaped(`token ${k} end`)).toBe("token <redacted> end");
  expect(keyShaped(`Authorization: ${"Bear"}er ${tail.slice(0, 20)}`)).toBe("Authorization: Bearer <redacted>");
  expect(keyShaped(`GET /v1/models?api_${"key"}=abc123&x=1`)).toBe("GET /v1/models?api_key=<redacted>&x=1");
  // Ordinary words, ids and paths stay as they are.
  const plain = "task-runner skipped 01a201a4-4253-74d6-ab8a-e1e0cd415773 at /home/user/sketch-book/skill.md: Exit code 4";
  expect(keyShaped(plain)).toBe(plain);
  expect(keyShapedDeep({ at: "tool", out: [`x ${KEY}`], n: 3, deep: { k: KEY } })).toEqual({ at: "tool", out: ["x <redacted>"], n: 3, deep: { k: "<redacted>" } });
});
