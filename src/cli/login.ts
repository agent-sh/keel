// keel login xai | keel logout xai: Keel's own Grok plan sign-in, with no
// daemon. A running daemon reads the saved grant at its next request.
import { XaiProvider } from "../providers/xai.ts";

const USAGE = "keel login xai    sign in with a Grok plan (prints an address and a code to approve)\nkeel logout xai   sign out and remove the saved grant";

async function login(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) return (console.log(USAGE), 0);
  if (argv[0] !== "xai") return (console.error(`keel login: name the provider: xai\n\n${USAGE}`), 3);
  const p = new XaiProvider();
  const failed = (s: { step?: string; error?: string }) => (console.error(`keel login xai: the sign-in failed at step \`${s.step ?? "device_code"}\`: ${s.error ?? "unknown"}`), 1);
  let s;
  try {
    s = await p.startSignIn();
  } catch {
    return failed(p.signInState());
  }
  const link = s.verification_uri_complete ?? s.verification_uri;
  console.log(link ? `Open ${link}\nand approve the sign-in (code ${s.user_code}).` : `Approve the sign-in with code ${s.user_code}.`);
  for (;;) {
    await Bun.sleep(1000);
    const st = p.signInState();
    if (st.state === "failed") return failed(st);
    if (st.state === "signed_in") break;
  }
  try {
    await p.list();
  } catch (e) {
    console.error(`keel login xai: signed in (the grant is saved), but the plan's models could not be listed: ${(e as Error).message}`);
    return 1;
  }
  console.log("Signed in to Grok. Keel keeps its own grant; the Grok CLI's sign-in is untouched.");
  return 0;
}

async function logout(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) return (console.log(USAGE), 0);
  if (argv[0] !== "xai") return (console.error(`keel logout: name the provider: xai\n\n${USAGE}`), 3);
  console.log((await new XaiProvider().signOut()) ? "Signed out of Grok; the grant is removed." : "Not signed in to Grok.");
  return 0;
}

export const loginCommands = { login, logout };
