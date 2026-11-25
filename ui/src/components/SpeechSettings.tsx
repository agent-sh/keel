// Settings > Speech: how the owner's words are heard (dictation and conversation mode) and how replies are
// read aloud. Each is the browser's own where it has one, else a speech model one of the providers lists.
import { useEffect } from "react";
import { browserVoices, chooseListen, chooseSay, loadSpeechModels, recognizerCtor, setPrefs, usePrefs, useSpeechModels, voicesOf, type Way } from "../lib/speech.ts";
import { SILENCE_MS } from "../lib/talk-core.ts";
import { commandKeys } from "../lib/keys.ts";
import { Seg } from "./Seg.tsx";
import { Select } from "./Select.tsx";
import { Group, Notice, Page, SettingRow, Status } from "./settings/kit.tsx";

const WAYS: { value: Way; label: string }[] = [{ value: "auto", label: "Automatic" }, { value: "browser", label: "Browser" }, { value: "model", label: "A model" }];

export function SpeechSettings() {
  const p = usePrefs();
  const list = useSpeechModels();
  useEffect(() => { void loadSpeechModels(); }, []);
  const stt = (list?.models ?? []).filter((m) => m.kind === "stt");
  const tts = (list?.models ?? []).filter((m) => m.kind === "tts");
  const voices = voicesOf(p, list);
  const listen = chooseListen(p, list), say = chooseSay(p, list);
  const dictate = commandKeys("dictate"), converse = commandKeys("converse");
  return (
    <Page intro={`Dictate into the message box (${dictate}), or talk with a session (${converse}): you speak, the message goes when you stop, the reply is read aloud and it listens again. Esc ends it.`} testid="speech-settings">
      <Group title="Listening" hint="Turns what you say into text.">
        <SettingRow label="Hear with" hint={listen.way ? <>Used now: <span data-testid="speech-listen-now">{listen.way.label}</span></> : listen.why}>
          <Seg label="Hear with" value={p.listen} onChange={(v) => setPrefs({ listen: v })} options={WAYS} testid="speech-listen" />
        </SettingRow>
        <SettingRow label="Speech to text model" hint={stt.length ? "A recording is sent to this model of your provider." : "No provider lists one."}>
          <Select value={p.listenModel || stt[0]?.route || ""} onChange={(e) => setPrefs({ listenModel: e.target.value })} disabled={!stt.length} aria-label="Speech to text model" data-testid="speech-listen-model" className="w-72 max-w-full">
            {stt.map((m) => <option key={m.route} value={m.route}>{m.model} ({m.provider_label})</option>)}
          </Select>
        </SettingRow>
        <SettingRow label="Silence that ends a message" hint="In a conversation, quiet this long after you spoke sends it.">
          <label className="flex items-center gap-2 text-ui text-muted">
            <input type="number" min={400} max={10000} step={100} className="k-field k-field-sm w-24" aria-label="Silence in milliseconds" data-testid="speech-silence"
              value={p.silenceMs} onChange={(e) => setPrefs({ silenceMs: Math.min(10000, Math.max(400, Number(e.target.value) || SILENCE_MS)) })} />
            ms
          </label>
        </SettingRow>
        <SettingRow label="Language" hint="A language tag such as en-US or he-IL. Empty: the page's own.">
          <input className="k-field k-field-sm w-32" aria-label="Language" placeholder={navigator.language} value={p.lang} onChange={(e) => setPrefs({ lang: e.target.value })} data-testid="speech-lang" />
        </SettingRow>
      </Group>
      <Group title="Reading aloud" hint="Reads a reply when a conversation turn ends.">
        <SettingRow label="Read with" hint={say.way ? <>Used now: <span data-testid="speech-say-now">{say.way.label}</span></> : say.why}>
          <Seg label="Read with" value={p.say} onChange={(v) => setPrefs({ say: v })} options={WAYS} testid="speech-say" />
        </SettingRow>
        <SettingRow label="Text to speech model" hint={tts.length ? "A reply is sent to this model of your provider as text." : "No provider lists one."}>
          <Select value={p.sayModel || tts[0]?.route || ""} onChange={(e) => setPrefs({ sayModel: e.target.value })} disabled={!tts.length} aria-label="Text to speech model" data-testid="speech-say-model" className="w-72 max-w-full">
            {tts.map((m) => <option key={m.route} value={m.route}>{m.model} ({m.provider_label})</option>)}
          </Select>
        </SettingRow>
        {voices.length ? (
          <SettingRow label="Voice" hint="The voices this provider lists for the model. The first reply asks for one until you choose.">
            <Select value={voices.includes(p.voice) ? p.voice : ""} onChange={(e) => setPrefs({ voice: e.target.value })} aria-label="Voice" data-testid="speech-voice-list" className="w-72">
              <option value="" disabled>Choose a voice</option>
              {voices.map((v) => <option key={v} value={v}>{v}</option>)}
            </Select>
          </SettingRow>
        ) : (
          <SettingRow label="Voice" hint="This provider lists no voices. Type the name its documentation gives. Empty: none is sent, and if the provider needs one, the first reply shows what it says and asks you.">
            <input className="k-field k-field-sm w-32" aria-label="Voice" value={p.voice} onChange={(e) => setPrefs({ voice: e.target.value })} data-testid="speech-voice" />
          </SettingRow>
        )}
        <SettingRow label="Speak to interrupt" hint="Speech over a reply stops the reading and starts listening. On speakers the reply can come back through the microphone: the input cancels echo, and the reply's own words heard back are not taken as speech. Turn it off if your replies cut themselves off.">
          <Seg label="Speak to interrupt" value={p.barge ? "on" : "off"} onChange={(v) => setPrefs({ barge: v === "on" })} options={[{ value: "on", label: "On" }, { value: "off", label: "Off" }]} testid="speech-barge" />
        </SettingRow>
      </Group>
      <Group title="This browser">
        <SettingRow label="Speech recognition"><Status tone={recognizerCtor() ? "ok" : "quiet"}>{recognizerCtor() ? "Present" : "None"}</Status></SettingRow>
        <SettingRow label="Voices"><Status tone={browserVoices() ? "ok" : "quiet"}>{browserVoices() ? `${browserVoices()}` : "None"}</Status></SettingRow>
      </Group>
      {list?.failed.map((f) => <Notice key={f.provider} tone="warn" title={`${f.provider} could not be asked for speech models`}>{f.error}</Notice>)}
    </Page>
  );
}
