import { expect, test } from "bun:test";
import { configForPackage } from "./push.ts";

// A google-services.json as Firebase hands it out, with two Android apps.
const services = {
  project_info: { project_number: "123456789", project_id: "phone-push" },
  client: [
    { client_info: { mobilesdk_app_id: "1:123456789:android:aaa", android_client_info: { package_name: "dev.avifenesh.hermes" } }, api_key: [{ current_key: "key-h" }] },
    { client_info: { mobilesdk_app_id: "1:123456789:android:bbb", android_client_info: { package_name: "dev.avifenesh.keel" } }, api_key: [{ current_key: "key-k" }] },
  ],
};

test("each app gets its own entry of google-services.json", () => {
  expect(configForPackage(services, "dev.avifenesh.keel")).toEqual({ api_key: "key-k", app_id: "1:123456789:android:bbb", project_id: "phone-push", sender_id: "123456789" });
  expect(configForPackage(services, "dev.avifenesh.hermes")?.app_id).toBe("1:123456789:android:aaa");
  expect(configForPackage(services, "dev.example.other")).toBeNull();
  expect(configForPackage({ client: services.client }, "dev.avifenesh.keel")).toBeNull();
});
