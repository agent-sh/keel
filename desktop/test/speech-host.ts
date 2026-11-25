// A stand-in provider for the end-to-end check's dictation case: it lists a chat model, a speech to
// text model and a text to speech model, and answers every recording with the same words (the browser
// specs' stand-in, test/e2e/fixtures/speech-endpoint.ts). It says READY with its address, then waits.
// Run: bun speech-host.ts
import { startSpeechEndpoint, HEARD } from "../../test/e2e/fixtures/speech-endpoint.ts";

const { url } = await startSpeechEndpoint();
console.log(`READY ${url} ${HEARD}`);
setInterval(() => {}, 60_000);
