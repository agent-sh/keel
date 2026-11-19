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
