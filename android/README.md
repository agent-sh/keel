# Keel for Android

The phone app for a Keel daemon you run: the session list with each session's
state, a session's transcript and composer, approval and question cards, push
for what needs you, and usage. It is a separate app from Hermes for Android and
can sit beside it on the same phone.

| | |
| --- | --- |
| Package | `dev.avifenesh.keel` (debug builds: `dev.avifenesh.keel.debug`) |
| Pairing link | `keel://pair?u=<daemon address>&c=<one-time code>&n=<name>` |
| Android | 12 or later (API 31) |

## How it reaches the daemon

The daemon serves the mobile `/v1` surface (`src/integrations/mobile/v1.ts`).
The phone reaches it over HTTPS at an address you choose, usually a private
network proxy in front of the daemon's local port. Plain HTTP is refused in
release builds.

1. On the computer: Settings, then Phone. Enter the address the phone reaches
   the daemon at and show a pairing code (or run `keel pair --url <address>`).
2. On the phone: open Keel and scan the code, or open the link. The `/pair` page
   of the daemon also hands the code to the app.
3. The phone makes two P-256 keys in the Android Keystore. One signs every
   request (method, path and query, time, body hash). The other needs your
   fingerprint or screen lock and signs each approval
   (`approve2\n<id>\n<choice>\n<sha256(answer)>\n<time>`). The daemon checks
   both and refuses a replay.

Unpairing (Settings, then Unpair) revokes the phone on the daemon and deletes
its keys. A phone with no screen lock can approve once only.

## Push

Push is optional. Without it the app keeps a live event stream while it is open
and checks for open cards every 15 minutes in the background.

To turn push on, the daemon's config folder needs two files from a Firebase
project that has an Android app registered for `dev.avifenesh.keel`:

- `fcm-service-account.json`: a service-account key of the project.
- `google-services.json`: the client file Firebase gives for the project. The
  daemon serves each app its own entry (`/v1/push-config?app=<package>`).

The app registers its push token on its next start, or from Settings, then
Check again. Pushes carry ids and one line of text, not the conversation.

## Build

JDK 21 and the Android SDK (platform 37).

```bash
cd android
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
# release: a properties file with storeFile, storePassword, keyAlias, keyPassword
./gradlew -PkeelSigning=/path/to/keystore.properties :app:assembleRelease
./gradlew --stop
```

A release build without signing fails; there is no debug-key fallback.

## Layout

| Path | What |
| --- | --- |
| `Net.kt` | encrypted preferences, Keystore keys, the signed HTTP client, pairing |
| `Wire.kt` | the daemon's shapes and the signed messages, as pure functions |
| `Hub.kt` | sync from the global cursor, then the event stream |
| `Approve.kt` | the biometric approval and the lock-screen approve activity |
| `Push.kt` | notifications, Firebase push, the background check |
| `ui/Theme.kt` | the design tokens (the workbench's colors and type) |
| `ui/` | the screens and their parts |

The connection code is adapted from Hermes for Android; see `NOTICE`.
