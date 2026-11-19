import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverPhone, isStop } from "./phone.ts";

test("the socket is found from the variable, the Hermes home, or beside a daemon's own config", () => {
  const home = mkdtempSync(join(tmpdir(), "phone-"));
  const env = (o: Record<string, string>) => (k: string) => o[k];
  expect("error" in discoverPhone(home, env({})) && (discoverPhone(home, env({})) as any).error).toContain("Hermes was not found");
  mkdirSync(join(home, ".hermes"));
  expect(discoverPhone(home, env({}))).toEqual({ socket: join(home, ".hermes/mobile/phone.sock") });
  expect(discoverPhone(home, env({ HERMES_HOME: "/h" }))).toEqual({ error: expect.any(String) } as any);
  expect(discoverPhone(home, env({ KEEL_CONFIG_DIR: "/s/dev/config" }))).toEqual({ socket: "/s/dev/phone/phone.sock" });
  expect(discoverPhone(home, env({ KEEL_PHONE_SOCKET: "/run/x.sock", HERMES_HOME: "/h" }))).toEqual({ socket: "/run/x.sock" });
});

test("the gateway's stop words are the owner's stop", () => {
  for (const e of ["phone control disarmed or revoked", "phone control re-armed", "phone control changed while queued", "Control changed; command cancelled"]) expect(isStop(e)).toBe(true);
  expect(isStop("phone did not answer within 25s (app offline, screen off, or service disabled)")).toBe(false);
});
