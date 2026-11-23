# Keel for Android

The phone app for a Keel daemon you run: the session list with each session's
state, a session's transcript and composer, photos and files sent with a
message, approval and question cards, push for what needs you, and usage. It is a separate app from Hermes for Android and
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

## Reading a request before allowing it

The daemon allows a request only for text that was shown. A permission card
carries the whole text to judge (`text`, each hidden character written as its
code point), notes on what in it can mislead, where it runs and why it is
asked, and `hold`: why Allow needs the text read first (long, cut, marked,
high risk, or run somewhere a line does not say). An empty `hold` means one
line shows all of it.

- The card draws the whole text in a box that scrolls. For a held request the
  Allow buttons wait until the text was scrolled to its end (or fits the box);
  Deny is always live. The allow then says `seen: "whole"`.
- A standing answer stores a rule, and its button names it: "Allow echo * for
  this session" (`grants`). It settles no held request that waits beside it.
- A notification shows a line, and collapsed only its start. It offers Allow
  once only where the daemon says the collapsed line shows the whole request
  (`glance`: the tool and the text in 40 characters, the limit Android's guide
  gives for content text, with no run of spaces), and Open and Deny for the
  rest. It never gives a standing answer.
- Allow once on a notification opens a sheet over the lock screen with the
  session's name and the whole line, and asks for the fingerprint from there.
  The prompt itself carries no text of the request: a prompt's subtitle is cut.
- An allow the daemon holds is answered 409 with a sentence ("Open the request
  to read it first: it is 41 lines long."), and the card stays open. The app
  shows the sentence under the card, or as a toast when the answer came from a
  notification.

## Plans

A plan the model presents in plan mode is a card in the session and under
Needs you. It shows the whole plan and allows an approval only once it was
scrolled to its end. Approve: edits run starts the work in auto edits;
Approve: each change asks starts it in ask (the one a phone with no screen
lock offers). Keep planning opens a box for what to change and sends the plan
back with it. A plan's notification opens the session; it allows nothing.

## Starting a task

The plus on the session list opens the start sheet: what the session should
do, where (the folders this machine's sessions worked in, newest first, or
another machine of the fleet, in the folder granted there), and on which
model. Each starts on what the daemon would pick by itself, so a task can be
typed and started at once. The first message is sent with it.

## Agents

A session that started agents shows them under its header as one line: how
many, how many work, fail or need you. Tapped, it opens the tree: each agent
under the one that started it, oldest first, with its state, and an agent
that needs you opens it by itself. An agent's row opens its session, which
leads back up to its starter; Back returns to where it was opened from. The
session list counts the agents at work under a session.

## Changes

The file mark in a session's header opens what the session changed in its
folder, read from its checkpoints: the files since its first turn, then each
turn's files, newest first, with the lines added and removed and a mark for a
file changed outside the session's work. A file opens its diff, one file at a
time, with long lines wrapped under their numbers. It is read-only; reverting
is done on the computer. A session whose files are on another machine says so.

## Photos and files

The paperclip beside the message box offers Photos (the system photo picker,
no storage permission) and Files (the system file picker). Each pick goes up
at once (`POST /v1/upload`), so Send carries only the ids. A file over the
daemon's limit (`/v1/me` says it) is refused before its bytes are read. A
photo larger than the edge the daemon stores at, or in a type a model does not
read (HEIC, AVIF), is written as JPEG at that edge first; a PNG stays PNG.
Send waits for every pick to be stored. The sent message shows its photos as
pictures (a tap opens one whole) and its files by name and size.

## Offline

The phone keeps its last sync: every session's row, the open cards, and the
newest messages of the recent sessions, with the place in the daemon's events
it is level at. It sits in the app's private files, sealed with the same
Keystore key as the token, excluded from backup and device transfer, and is
deleted on unpairing. A cold start shows it at once, says
"Offline · last synced 14:32" while the computer is out of reach, and opens
the stream from that place, so only what changed since comes over the
network. Running turns are not kept: a cold start never says a turn runs
that it cannot see.

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
# the screens' own tests, on the emulator or a phone that adb sees (they uninstall the debug app after)
./gradlew :app:connectedDebugAndroidTest
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
| `ui/Start.kt` | the start sheet: a new session's task, folder, machine and model |
| `ui/Agents.kt` | a session's agents, as a tree |
| `ui/Changes.kt` | a session's changes and one file's diff |
| `Cache.kt` | the last sync kept on the phone, sealed |
| `Attach.kt` | what is picked for the next message: read, fitted, uploaded; the transcript's images |
| `Approve.kt` | the biometric approval and the lock-screen approve activity |
| `Push.kt` | notifications, Firebase push, the background check |
| `ui/Theme.kt` | the design tokens (the workbench's colors and type) |
| `ui/` | the screens and their parts |

The connection code is adapted from Hermes for Android; see `NOTICE`.
