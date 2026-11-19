// Writes a stand-in Firebase service account for the mobile e2e: a fresh RSA
// key and a token_uri on the spec's stand-in push service.
// Usage: bun fcm-account.ts <config-dir>/fcm-service-account.json [port]
import { generateKeyPairSync } from "node:crypto";

const [file, port = process.env.KEEL_TEST_FCM_PORT ?? "47993"] = process.argv.slice(2);
if (!file) throw new Error("usage: fcm-account.ts <file> [port]");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
await Bun.write(file, JSON.stringify({
  type: "service_account",
  project_id: "keel-e2e",
  client_email: "e2e@keel-e2e.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  token_uri: `http://127.0.0.1:${port}/token`,
}, null, 2));
