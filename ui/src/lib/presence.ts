// Passkeys in the page: enroll this device, and sign one action when the
// daemon asks (a 428 from a remote device). The WebAuthn library loads only
// when a ceremony runs.
import { api, presenceHook } from "./store.ts";

// Why this page cannot run a passkey ceremony, or null when it can. WebAuthn
// needs a secure context and a name: the relying party is a domain or
// localhost, never an IP address, and the loopback address is refused too
// although it is a secure context. `localhost` is this page at localhost
// when the address is the loopback one.
export type PasskeyBlock = { why: string; localhost?: string };
export function passkeyBlock(): PasskeyBlock | null {
  if (typeof window === "undefined") return { why: "Passkeys need a browser." };
  const h = location.hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith("[")) {
    const loopback = h.startsWith("127.") || h === "[::1]";
    return {
      why: `A passkey is tied to a name, and this page is open at an address (${h}).`,
      localhost: loopback ? `${location.protocol}//localhost${location.port ? `:${location.port}` : ""}${location.pathname}` : undefined,
    };
  }
  if (!window.isSecureContext || !("PublicKeyCredential" in window)) return { why: `Passkeys work only over HTTPS or at localhost; this page is at ${location.origin}.` };
  return null;
}
export const passkeysUsable = () => passkeyBlock() === null;

export async function enroll(label: string, code?: string) {
  const { startRegistration } = await import("@simplewebauthn/browser");
  const { ceremony, options } = await api<{ ceremony: string; options: any }>("/api/owner-presence/register/start", { method: "POST", body: JSON.stringify({ code }) });
  const credential = await startRegistration({ optionsJSON: options });
  return api("/api/owner-presence/register/finish", { method: "POST", body: JSON.stringify({ ceremony, credential, label }) });
}

export async function sign(action: string): Promise<string | null> {
  const block = passkeyBlock();
  if (block) throw new Error(`This needs your passkey. ${block.why}${block.localhost ? " Open Keel at localhost." : ""}`);
  const { startAuthentication } = await import("@simplewebauthn/browser");
  const { ceremony, options } = await api<{ ceremony: string; options: any }>("/api/owner-presence/authenticate/start", { method: "POST", body: JSON.stringify({ action }) });
  let credential;
  try {
    credential = await startAuthentication({ optionsJSON: options });
  } catch (e) {
    if ((e as Error).name === "NotAllowedError" || (e as Error).name === "AbortError") return null; // the owner cancelled
    throw e;
  }
  const r = await api<{ receipt: string }>("/api/owner-presence/authenticate/finish", { method: "POST", body: JSON.stringify({ ceremony, credential }) });
  return r.receipt;
}

presenceHook.sign = sign;
