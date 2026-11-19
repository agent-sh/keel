// Passkeys in the page: enroll this device, and sign one action when the
// daemon asks (a 428 from a remote device). The WebAuthn library loads only
// when a ceremony runs.
import { api, presenceHook } from "./store.ts";

export const passkeysUsable = () => typeof window !== "undefined" && window.isSecureContext && "PublicKeyCredential" in window;

export async function enroll(label: string, code?: string) {
  const { startRegistration } = await import("@simplewebauthn/browser");
  const { ceremony, options } = await api<{ ceremony: string; options: any }>("/api/owner-presence/register/start", { method: "POST", body: JSON.stringify({ code }) });
  const credential = await startRegistration({ optionsJSON: options });
  return api("/api/owner-presence/register/finish", { method: "POST", body: JSON.stringify({ ceremony, credential, label }) });
}

export async function sign(action: string): Promise<string | null> {
  if (!passkeysUsable()) throw new Error("This needs your passkey, and passkeys work only over HTTPS or at localhost.");
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
