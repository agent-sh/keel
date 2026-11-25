// A stand-in OpenAI-compatible provider that takes speech: it lists a chat model, a speech to text model and a
// text to speech model, answers every recording with the same words, and answers every text with a short
// silent recording. What it was asked is recorded, so a spec can say which model heard and which spoke.
import { createServer, type Server } from "node:http";

export const SPEECH_ID = "speech-e2e";
export const HEARD = "dictated by the stand-in model";
export const STT = "stand-in-whisper";
export const TTS = "stand-in-tts";

// 0.3 s of silence, 8 kHz, 8 bit: a recording a page can play to its end.
function wav(): Buffer {
  const n = 2400, h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + n, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34); h.write("data", 36); h.writeUInt32LE(n, 40);
  return Buffer.concat([h, Buffer.alloc(n, 128)]);
}

export type Asked = { heard: { model: string; bytes: number }[]; spoken: { model: string; input: string; voice: string }[] };

export function startSpeechEndpoint(): Promise<{ url: string; server: Server; asked: Asked }> {
  const asked: Asked = { heard: [], spoken: [] };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const path = (req.url ?? "").split("?")[0];
      if (path === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: ["stand-in-chat", STT, TTS].map((id) => ({ id, object: "model" })) }));
      }
      if (path === "/v1/audio/transcriptions") {
        // A multipart form: the model is the field after its name.
        const model = /name="model"\r\n\r\n([^\r]+)/.exec(body.toString("latin1"))?.[1] ?? "";
        asked.heard.push({ model, bytes: body.length });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ text: HEARD }));
      }
      if (path === "/v1/audio/speech") {
        const b = JSON.parse(body.toString() || "{}");
        asked.spoken.push({ model: b.model, input: b.input, voice: b.voice });
        res.writeHead(200, { "content-type": "audio/wav" });
        return res.end(wav());
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const a = server.address() as { port: number };
    resolve({ url: `http://127.0.0.1:${a.port}`, server, asked });
  }));
}
