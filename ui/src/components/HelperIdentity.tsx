// The helper's name and picture, in its settings (src/helper/persona.ts): the owner names it, then gives it a face,
// made by an image model of their own providers from a description they edit (a few to pick from) or uploaded.
// With no image model among their providers it says so and the upload is the way.
import { ImagePlus, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { imageModels, keelRepo, makeAvatars, pickAvatar, removeAvatar, setHelper, setKeelRepo, uploadAvatar, useHelper, type ImageModels, type KeelRepo } from "../lib/helper.ts";
import { composing } from "../lib/keys.ts";
import { reportError } from "../lib/store.ts";
import { HelperFace } from "./HelperFace.tsx";
import { Select } from "./Select.tsx";
import { Notice, SettingRow } from "./settings/kit.tsx";

const failed = (e: unknown) => (e instanceof Error ? e.message : String(e));
const HOWMANY = 4;

function Maker({ onClose }: { onClose: () => void }) {
  const view = useHelper((s) => s.view)!;
  const [found, setFound] = useState<ImageModels | null>(null);
  const [prompt, setPrompt] = useState(view.avatar_prompt);
  const [model, setModel] = useState(view.avatar_model ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    imageModels().then((m) => { setFound(m); setModel((cur) => (m.models.some((x) => x.id === cur) ? cur : m.models[0]?.id ?? "")); }, (e) => setErr(failed(e)));
  }, []);
  const make = () => {
    setBusy(true); setErr("");
    makeAvatars({ prompt, model, n: HOWMANY }).catch((e) => setErr(failed(e))).finally(() => setBusy(false));
  };
  const none = found && !found.models.length;
  return (
    <div className="k-pick" data-testid="helper-avatar-maker">
      {none && (
        <Notice tone="warn" testid="helper-avatar-none" title="No image model">
          None of your providers lists a model that makes pictures{found.failed.length ? ` (${found.failed.map((f) => f.label).join(", ")} could not be asked)` : ""}. Sign in to one that does (the ChatGPT plan, an OpenAI or Gemini key), or upload a picture.
        </Notice>
      )}
      {found && found.models.length > 0 && (
        <>
          <label className="k-pick-label" htmlFor="helper-avatar-prompt">Describe the character</label>
          <textarea id="helper-avatar-prompt" className="k-field k-pick-prompt" rows={3} maxLength={600} value={prompt} onChange={(e) => setPrompt(e.target.value)} data-testid="helper-avatar-prompt" />
          <div className="k-pick-row">
            <Select value={model} onChange={(e) => setModel(e.target.value)} aria-label="Image model" data-testid="helper-avatar-model" className="min-w-0 flex-1">
              {found.models.map((m) => <option key={m.id} value={m.id}>{m.name}{m.billing === "subscription" ? " (your plan)" : ""} - {m.provider}</option>)}
            </Select>
            <button type="button" className="k-btn" disabled={busy || !prompt.trim() || !model} onClick={make} data-testid="helper-avatar-make">
              <ImagePlus className="size-3.5" />{busy ? "Making" : view.candidates.length ? `Make ${HOWMANY} more` : `Make ${HOWMANY}`}
            </button>
          </div>
          <p className="k-pick-note">Asks {model ? found.models.find((m) => m.id === model)?.provider : "the provider"} for {HOWMANY} pictures, one request each, and keeps none until you pick one.</p>
        </>
      )}
      {!found && !err && <p className="k-pick-note" data-testid="helper-avatar-looking">Looking at your providers for image models.</p>}
      {err && <p className="k-pick-note" role="alert" data-testid="helper-avatar-error">{err}</p>}
      {view.candidates.length > 0 && (
        <ul className="k-pick-grid" data-testid="helper-avatar-candidates" aria-label="Pictures to pick from">
          {view.candidates.map((c, i) => (
            <li key={c.id}>
              <button type="button" className="k-pick-item" onClick={() => pickAvatar(c.id).then(onClose, (e) => setErr(failed(e)))} aria-label={`Use picture ${i + 1}`} data-testid="helper-avatar-candidate">
                <img src={c.url} alt="" draggable={false} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const WHERE = { running: "the checkout this daemon runs from", setting: "the folder you set", build: "the checkout this build was made from" } as const;

// Where an agent started on a bug of Keel works: found by itself (the daemon's checkout, or the one the binary was
// built from); the owner fills it once when that is gone or the binary was built somewhere else.
function KeelRepoRow() {
  const [found, setFound] = useState<KeelRepo | null>(null);
  const [dir, setDir] = useState("");
  const [err, setErr] = useState("");
  const load = () => keelRepo().then((r) => { setFound(r); setDir(r.setting ?? ""); setErr(""); }, (e) => setErr(failed(e)));
  useEffect(() => { load(); }, []);
  const save = () => {
    const to = dir.trim();
    if (to === (found?.setting ?? "")) return;
    setKeelRepo(to || null).then(load, (e) => setErr(failed(e)));
  };
  return (
    <SettingRow label="Keel's source" hint="The folder of a Keel checkout the helper starts an agent in when it finds a bug of Keel's. Found by itself where it can; set it when it says it cannot." testid="helper-repo-row">
      <div className="flex min-w-0 max-w-full flex-col items-start gap-1.5">
        <input className="k-field w-72 max-w-full" value={dir} placeholder="/path/to/keel" aria-label="Keel source folder" data-testid="helper-repo-input"
          onChange={(e) => setDir(e.target.value)} onBlur={save} onKeyDown={(e) => { if (composing(e)) return; if (e.key === "Enter") e.currentTarget.blur(); }} />
        {found && "repo" in found && <p className="k-pick-note max-w-full [overflow-wrap:anywhere]" data-testid="helper-repo-found">Using {found.repo.dir}: {WHERE[found.repo.from]}.</p>}
        {found && "problem" in found && <p className="k-pick-note max-w-full [overflow-wrap:anywhere]" role="status" data-testid="helper-repo-problem">{found.problem}</p>}
        {err && <p className="k-pick-note max-w-full [overflow-wrap:anywhere]" role="alert" data-testid="helper-repo-error">{err}</p>}
      </div>
    </SettingRow>
  );
}

export function HelperIdentity() {
  const view = useHelper((s) => s.view)!;
  const [name, setName] = useState(view.named ? view.name : "");
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState("");
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => setName(view.named ? view.name : ""), [view.name, view.named]);
  const save = () => {
    if ((view.named ? view.name : "") === name.trim()) return;
    setHelper({ name: name.trim() || null }).then(() => setErr(""), (e) => { setErr(failed(e)); setName(view.named ? view.name : ""); });
  };
  const upload = (f: File | undefined) => {
    if (!f) return;
    uploadAvatar(f).then(() => { setErr(""); setOpen(false); }, (e) => setErr(failed(e)));
    if (file.current) file.current.value = "";
  };
  return (
    <>
      <SettingRow label="Name" hint={`What it answers to, and what its conversation, the list and its notifications call it. Empty: Helper.`}>
        <input className="k-field w-44" value={name} maxLength={40} placeholder="Helper" aria-label="Helper name" data-testid="helper-name"
          onChange={(e) => setName(e.target.value)} onBlur={save} onKeyDown={(e) => { if (composing(e)) return; if (e.key === "Enter") e.currentTarget.blur(); }} />
      </SettingRow>
      <SettingRow label="Picture" hint="A cartoon face an image model of yours makes from a description you edit, or a picture you upload. It shows wherever the helper speaks." testid="helper-picture-row">
        <div className="flex items-center gap-3">
          <HelperFace size="set" testid="helper-picture" />
          <div className="flex flex-col items-start gap-1.5">
            <button type="button" className="k-btn" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="helper-avatar-open"><ImagePlus className="size-3.5" />Make one</button>
            <button type="button" className="k-btn" onClick={() => file.current?.click()} data-testid="helper-avatar-upload-button"><Upload className="size-3.5" />Upload</button>
            {view.avatar && <button type="button" className="k-btn" onClick={() => removeAvatar().catch(reportError)} data-testid="helper-avatar-remove"><Trash2 className="size-3.5" />Remove</button>}
          </div>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" aria-label="Upload a picture" data-testid="helper-avatar-upload" onChange={(e) => upload(e.currentTarget.files?.[0])} />
        </div>
      </SettingRow>
      <KeelRepoRow />
      {err && <p className="k-pick-note px-1" role="alert" data-testid="helper-identity-error">{err}</p>}
      {(open || view.candidates.length > 0) && <Maker onClose={() => setOpen(false)} />}
    </>
  );
}
