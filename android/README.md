# Keel for Android

The phone app for a Keel daemon you run: the session list with each session's
state, a session's transcript and composer, approval and question cards, push
for what needs you, and usage. It is a separate app from Hermes for Android and
can sit beside it on the same phone.

| | |
| --- | --- |
| Package | `dev.avifenesh.keel` (debug builds: `dev.avifenesh.keel.debug`, QA builds: `dev.avifenesh.keel.qa`) |
| Pairing link | `keel://pair?u=<daemon address>&c=<one-time code>&n=<name>` |
| Android | 12 or later (API 31) |

## How it reaches the daemon

The daemon serves the mobile `/v1` surface (`src/integrations/mobile/v1.ts`).
The phone reaches it over HTTPS at an address you choose, usually a private
network proxy in front of the daemon's local port. Plain HTTP is refused in
release builds; debug and QA builds also take it for a daemon on this machine
(see The QA build).

1. On the computer: Settings, then Phone. Enter the address the phone reaches
   the daemon at and show a pairing code (or run `keel pair --url <address>`).
2. On the phone: open Keel and scan the code, or open the link. The `/pair` page
   of the daemon also hands the code to the app.
3. The phone makes two P-256 keys in the Android Keystore. One signs every
   request (method, path and query, time, body hash). The other needs your
   fingerprint or screen lock and signs each approval
   (`approve2\n<id>\n<choice>\n<sha256(answer)>\n<time>`). The daemon checks
   both and refuses a replay.

Unpairing (Settings, then Unpair) deletes the phone's keys and asks the daemon
to revoke it. When the daemon does not confirm (it is out of reach), the app
says so on the pairing screen: revoke the phone in Settings, then Phone, on the
computer. A phone with no screen lock can approve once only.

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

## The wire

`src/integrations/mobile/contract/wire.json` is the wire between the daemon and
the app, written once: the bytes that are signed, the fields the app reads of
every answer, stream frame and push, and the bodies the app sends, each with
examples. It is checked in both directions, with no phone, push service or
model. The daemon's tests (`src/integrations/mobile/v1.test.ts`) send every
listed field under its name and type. The app's unit tests (`ContractTest.kt`,
which reads the same file) have a reader for every listed field, and read the
app's own sources: the daemon's answers are read as JSON in `Wire.kt` and
`Feed.kt` only, and a field read there that no shape names fails the build's
tests. A change to the wire starts in that file.

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

## The QA build

```bash
./gradlew :app:assembleQa        # app/build/outputs/apk/qa/
```

The QA build type is the release build made testable against a dev daemon. It
is for checking the minified app, never for distribution.

| | QA | Release |
| --- | --- | --- |
| Package | `dev.avifenesh.keel.qa`, named Keel QA, version name ending `-qa` | `dev.avifenesh.keel` |
| Code | The release settings: R8 minification, shrunk resources, the same ProGuard rules | The same |
| Signing | The Android debug key; no keystore file is needed | Your release key; the build fails without it |
| Plain HTTP | Only to `10.0.2.2` (the emulator's host), `127.0.0.1` and `localhost`, without subdomains | Refused everywhere |

Every other address needs HTTPS in the QA build too. The three addresses are
the ones in `app/src/qa/res/xml/network_security.xml`; the debug build has the
same list. A real phone reaches a daemon on the computer at `127.0.0.1` through
`adb reverse tcp:<port> tcp:<port>`; the emulator reaches it at `10.0.2.2`.

Because the package differs, a QA build installs beside the release and debug
builds, pairs on its own, and needs its own Android app entry in the Firebase
project to receive push. It is signed with a key that every Android SDK has,
so it proves nothing about who built it.

## Layout

| Path | What |
| --- | --- |
| `Net.kt` | encrypted preferences, Keystore keys, the signed HTTP client, pairing |
| `Wire.kt` | the daemon's shapes and the signed messages, as pure functions |
| `Feed.kt` | what the app holds of the daemon and how sync answers and stream frames change it, as plain state |
| `Hub.kt` | the event stream, opened from the cursor, and the requests the screens make |
| `Approve.kt` | the biometric approval and the lock-screen approve activity |
| `Push.kt` | notifications, Firebase push, the background check |
| `ui/Theme.kt` | the design tokens (the workbench's colors and type) |
| `ui/` | the screens and their parts |

The connection code is adapted from Hermes for Android; see `NOTICE`.
