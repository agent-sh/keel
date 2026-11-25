// Speech in the message box: a mic that dictates into it, a button that turns conversation mode on, and
// the line above the box that says what is happening (listening, thinking, speaking), which way the
// words are heard, and how to stop. The state mark is the session's own.
import { useState } from "react";
import { AudioLines, Mic, Square, X } from "lucide-react";
import { STATE_WORD } from "../../../src/core/state-words.ts";
import { dismissDictationError, stopDictation, toggleDictation, useDictation } from "../lib/dictation.ts";
import { commandKeys, composing } from "../lib/keys.ts";
import { chooseVoice, dismissConversationError, skipVoice, stop as endConversation, toggleConversation, useConversation } from "../lib/talk.ts";
import { useStore } from "../lib/store.ts";
import { useWatch } from "../lib/watch.ts";
import { cn } from "../lib/utils.ts";
import { Mark } from "./Mark.tsx";
import { Select } from "./Select.tsx";

const button = "grid size-8 shrink-0 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg aria-pressed:bg-accent-soft aria-pressed:text-accent";
const withKeys = (what: string, id: string) => { const k = commandKeys(id); return k ? `${what} (${k})` : what; };

export function SpeechButtons({ sid }: { sid: string | undefined }) {
  const d = useDictation();
  const c = useConversation();
  const talking = !!sid && c.sid === sid && c.phase !== "off";
  const dictating = d.phase !== "idle";
  return (
    <>
      <button
        type="button"
        data-testid="dictate"
        aria-pressed={dictating}
        aria-label={dictating ? "Stop dictating" : "Dictate"}
        title={dictating ? withKeys("Stop dictating", "dictate") : withKeys("Dictate: speak, and the words go in the box", "dictate")}
        disabled={talking}
        onClick={() => toggleDictation()}
        className={cn(button, "k-dictate relative disabled:opacity-40")}
      >
        <Mic className="size-4" />
        {dictating && <span className="absolute right-1.5 top-1.5 size-1.5 animate-pulse-dot rounded-full bg-accent" />}
      </button>
      {sid && (
        <button
          type="button"
          data-testid="converse"
          aria-pressed={talking}
          aria-label={talking ? "End the conversation" : "Talk with this session"}
          title={talking ? withKeys("End the conversation (Esc also ends it)", "converse") : withKeys("Conversation: speak a message, hear the reply, and go on", "converse")}
          disabled={dictating}
          onClick={() => toggleConversation(sid)}
          className={cn(button, "disabled:opacity-40")}
        >
          <AudioLines className="size-4" />
        </button>
      )}
    </>
  );
}

// What the line says while the mode is on. In a conversation the word is the turn's: what the session does
// is its own mark and word (working, needs you), what the owner's side does is listening or speaking.
function word(phase: string, recording: string | null, watchWord: string): string {
  if (phase === "listening") return recording === "transcribing" ? "Transcribing" : "Listening";
  if (phase === "speaking") return "Speaking";
  return recording === "transcribing" ? "Transcribing" : watchWord === STATE_WORD.need ? watchWord : "Thinking";
}

export function SpeechBand({ sid }: { sid: string | undefined }) {
  const d = useDictation();
  const c = useConversation();
  const session = useStore((s) => (sid ? s.sessions[sid] : undefined));
  const w = useWatch(session);
  const talking = !!sid && c.sid === sid && c.phase !== "off";
  const dictating = d.phase !== "idle" && d.box === (sid ?? "start");
  const error = (talking ? null : c.sid === sid || (!sid && !c.sid) ? c.error : null) ?? (d.box === null || d.box === (sid ?? "start") ? d.error : null);
  if (!talking && !dictating && !error) return null;

  const line = "flex min-h-8 items-center gap-2 px-4 pt-1.5 text-caption";
  if (!talking && !dictating && error) {
    return (
      <div className={cn(line, "text-danger")} role="alert" data-testid="speech-error">
        <span className="min-w-0 flex-1">{error}</span>
        <button type="button" aria-label="Dismiss" onClick={() => { dismissDictationError(); dismissConversationError(); }} className="grid size-6 place-items-center rounded-md hover:bg-hover"><X className="size-3.5" /></button>
      </div>
    );
  }
  const phase = talking ? c.phase : "listening";
  const state = talking ? word(c.phase, c.recording, STATE_WORD[w]) : d.phase === "transcribing" ? "Transcribing" : "Listening";
  const how = talking ? c.listenLabel : d.label;
  const heard = talking ? c.heard : "";
  return (
    <>
    <div className={cn(line, "text-muted max-sm:flex-wrap")} role="status" data-testid="speech-band" data-mode={talking ? "conversation" : "dictation"} data-phase={phase} data-state={state.toLowerCase()}>
      <Mark w={talking ? w : "work"} />
      <span className="font-medium text-fg" data-testid="speech-state">{state}</span>
      {heard && <span className="min-w-0 flex-1 truncate italic" data-testid="speech-heard">{heard}</span>}
      {!heard && <span className="flex-1" />}
      {/* (On a phone the way is a line of its own under the words, so End stays in view.) */}
      <span className="min-w-0 truncate text-faint max-sm:order-last max-sm:basis-full" data-testid="speech-way">{how}{talking && c.sayLabel ? `, read aloud by ${c.sayLabel}` : ""}</span>
      <button
        type="button"
        data-testid="speech-end"
        onClick={() => (talking ? endConversation() : stopDictation())}
        className="flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-fg hover:bg-hover"
        title={talking ? "End the conversation (Esc)" : "Stop dictating (Esc)"}
      >
        <Square className="size-3 fill-current" />
        {talking ? "End" : "Stop"}
      </button>
    </div>
    {talking && c.voiceAsk && <VoiceAsk key={c.voiceAsk.text} ask={c.voiceAsk} />}
    {talking && c.note && !c.voiceAsk && <p className="px-4 pt-0.5 text-caption text-faint" data-testid="speech-note">{c.note}</p>}
    </>
  );
}

// The reply waits on a voice. A provider that lists voices gives a list; one that does not says what it takes (its own
// words, shown as text) and the owner types a name. No name of ours is sent in its place.
function VoiceAsk({ ask }: { ask: { text: string; voices: string[] } }) {
  const [name, setName] = useState(ask.voices[0] ?? "");
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pt-1 text-caption text-muted" data-testid="speech-voice-ask">
      <span className="min-w-0 basis-full break-words sm:basis-auto sm:flex-1" data-testid="speech-voice-why">{ask.text}</span>
      {ask.voices.length ? (
        <Select value={name} onChange={(e) => setName(e.target.value)} aria-label="Voice" data-testid="speech-voice-pick" className="w-40">
          {ask.voices.map((v) => <option key={v} value={v}>{v}</option>)}
        </Select>
      ) : (
        <input className="k-field k-field-sm w-36" aria-label="Voice name" placeholder="Voice name" value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (composing(e)) return; if (e.key === "Enter" && name.trim()) chooseVoice(name); }} data-testid="speech-voice-name" />
      )}
      <button type="button" data-testid="speech-voice-use" disabled={!name.trim()} onClick={() => chooseVoice(name)} className="h-6 rounded-md px-2 text-fg hover:bg-hover disabled:opacity-40">Use</button>
      <button type="button" data-testid="speech-voice-skip" onClick={() => skipVoice()} className="h-6 rounded-md px-2 hover:bg-hover">Skip</button>
    </div>
  );
}
