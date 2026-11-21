// Settings > Phone: pair the phone app with a one-time QR, see each paired
// phone with whether its alerts arrive, send a test push, revoke.
import { copyOrSay } from "../lib/copy.ts";
import { BellRing, Check, Copy, QrCode, Send, ShieldAlert, Smartphone, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, onFeature, reportError, failed } from "../lib/store.ts";
import { ago, cn, when } from "../lib/utils.ts";
import { confirmAction } from "./Confirm.tsx";
import { Card } from "./Settings.tsx";

type PushRec = { id: string; kind: string; sent_ms: number; ok: boolean; error?: string | null; acked_ms?: number | null };
type Device = {
  id: string; name: string; nolock: boolean; revoked: boolean; created: number; last_seen: number;
  push: { registered: boolean; unacknowledged: number; warning: boolean; receipts: boolean; last: PushRec | null; previous: PushRec | null };
};
type Bundle = { code: string; public_url: string; pair_link: string; hermes_link: string; qr_svg: string; expires_ms: number };
type Settings = { public_url: string; push: { configured: boolean; path: string } };

const since = (ms: number) => (ago(ms) === "now" ? "just now" : `${ago(ms)} ago`);
const button = "inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-raised px-3 text-ui font-medium hover:bg-hover disabled:opacity-50";

function Countdown({ until, onEnd }: { until: number; onEnd: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.round((until - now) / 1000));
  useEffect(() => { if (left === 0) onEnd(); }, [left, onEnd]);
  return <span className="tabular-nums">{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</span>;
}

function PairCard({ settings, paired }: { settings: Settings | null; paired: Device | null }) {
  const [url, setUrl] = useState("");
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [hermesCopied, setHermesCopied] = useState(false);
  useEffect(() => { if (settings && !url) setUrl(settings.public_url); }, [settings]);
  // The code is good once: a phone that paired closes it.
  useEffect(() => { if (paired) setBundle(null); }, [paired?.id]);
  const end = useCallback(() => setBundle(null), []);

  // Each request makes a new code on the daemon: while one is on its way a
  // second click asks for nothing (the ref holds between two clicks of one render).
  const [busy, setBusy] = useState(false);
  const asking = useRef(false);
  const show = async () => {
    if (asking.current) return;
    asking.current = true;
    setBusy(true);
    setError("");
    try {
      setBundle(await api<Bundle>("/api/mobile/pair", { method: "POST", body: JSON.stringify({ public_url: url }) }));
    } catch (e) {
      setError(failed(e, { at: "PhonePanel" }));
    } finally {
      asking.current = false;
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="py-4">
        <div className="text-base font-medium">Pair a phone</div>
        <div className="mt-0.5 text-ui text-muted">The phone app talks to this machine over the address it reaches it at, usually a tunnel. Each code pairs one phone, once.</div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            data-testid="pair-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://keel.example.com"
            spellCheck={false}
            className="h-8 min-w-0 flex-1 rounded-md border border-line bg-sunken px-2.5 font-mono text-caption outline-none placeholder:text-faint focus:border-accent"
          />
          <button type="button" data-testid="pair-show" onClick={show} disabled={!url.trim() || busy} aria-busy={busy} className={cn(button, "border-accent bg-accent text-accent-fg hover:bg-accent-hover")}>
            <QrCode className="size-3.5" /> {busy ? "Making a code" : bundle ? "New code" : "Show pairing code"}
          </button>
        </div>
        {error && <div className="mt-2 text-caption text-danger">{error}</div>}
        {paired && !bundle && (
          <div className="mt-3 flex items-center gap-2 rounded-md bg-accent-soft px-3 py-2 text-ui" data-testid="pair-done">
            <Check className="size-4 text-ok" /> Paired <span className="font-medium">{paired.name}</span>.
          </div>
        )}
        {bundle && (
          <div className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-center" data-testid="pair-bundle" data-link={bundle.pair_link}>
            <div className="size-48 shrink-0 overflow-hidden rounded-md border border-line bg-white p-1 shadow-1" data-testid="pair-qr" dangerouslySetInnerHTML={{ __html: bundle.qr_svg }} />
            <div className="min-w-0 flex-1 space-y-3 text-ui">
              <ol className="list-decimal space-y-1 pl-4 text-muted">
                <li>Open Keel on the phone and choose Scan code.</li>
                <li>Scan this code. The phone makes its own keys; approvals use a fingerprint or PIN.</li>
              </ol>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-xs bg-code px-2 py-1 font-mono text-caption text-muted">{bundle.pair_link}</code>
                <button
                  type="button"
                  aria-label="Copy the pairing link"
                  onClick={(e) => copyOrSay(bundle.pair_link, e.currentTarget).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); } })}
                  className="grid size-7 place-items-center rounded-md text-faint hover:bg-hover hover:text-fg"
                >
                  {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
                </button>
              </div>
              <div className="text-caption text-faint">
                Expires in <Countdown until={bundle.expires_ms} onEnd={end} />.{" "}
                <button
                  type="button"
                  data-testid="pair-hermes"
                  onClick={(e) => copyOrSay(bundle.hermes_link, e.currentTarget).then((ok) => { if (ok) { setHermesCopied(true); setTimeout(() => setHermesCopied(false), 1500); } })}
                  className="text-muted underline decoration-line-strong underline-offset-2 hover:text-fg"
                >
                  {hermesCopied ? "Copied the Hermes app link" : "Copy the link for the Hermes app"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function pushLine(d: Device): { text: string; tone: "ok" | "warn" | "muted" | "danger" } {
  const p = d.push;
  if (!p.registered) return { text: "No push token yet: open the app on the phone once", tone: "muted" };
  if (p.warning) return { text: `${p.unacknowledged} pushes in a row not confirmed by the phone`, tone: "warn" };
  const l = p.last;
  if (!l) return { text: p.previous ? "New push token, not tested yet" : "Push on, nothing sent yet", tone: "ok" };
  if (!l.ok && l.error === "sending") return { text: "Sending a push", tone: "muted" };
  if (!l.ok) return { text: `Last push failed: ${l.error ?? "refused"}`, tone: "danger" };
  // An app that never confirmed a push may not send receipts: unknown, not failed.
  const state = l.acked_ms ? "confirmed by the phone" : p.receipts ? "not confirmed yet" : p.unacknowledged > 1 ? "no receipt from this app yet" : "not confirmed yet";
  return { text: `Last push (${l.kind}) ${since(l.sent_ms)}, ${state}`, tone: l.acked_ms ? "ok" : "muted" };
}

function DeviceRow({ d, canPush, reload }: { d: Device; canPush: boolean; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const line = pushLine(d);
  const test = async () => {
    setBusy(true);
    setNote("");
    try {
      const r = await api<{ pushes: PushRec[] }>(`/api/mobile/devices/${d.id}/test-push`, { method: "POST" });
      setNote(r.pushes.every((p) => p.ok) ? "Sent. The row updates when the phone confirms it." : (r.pushes[0]?.error ?? "Not sent"));
    } catch (e) {
      setNote(failed(e, { at: "PhonePanel" }));
    } finally {
      setBusy(false);
      reload();
    }
  };
  const revoke = async () => {
    if (!(await confirmAction({ title: `Revoke ${d.name}?`, body: "The phone loses access at once and gets no more pushes. Pairing it again needs a new code.", action: "Revoke", danger: true }))) return;
    await api(`/api/mobile/devices/${d.id}`, { method: "DELETE" }).catch(reportError);
    reload();
  };
  return (
    <div className="flex gap-3 border-b border-line py-4 last:border-0" data-testid="phone-row" data-device={d.id}>
      <div className="grid size-9 shrink-0 place-items-center rounded-md bg-sunken text-muted"><Smartphone className="size-4.5" /></div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="truncate text-base font-medium">{d.name}</span>
          {d.nolock && (
            <span className="inline-flex items-center gap-1 rounded-xs bg-brass-soft px-1.5 text-micro text-brass" title="Without a screen lock the phone can approve once only and cannot prompt chats that run tools without asking">
              <ShieldAlert className="size-3" /> no screen lock
            </span>
          )}
          <span className="ml-auto text-caption tabular-nums text-faint" title={`Paired ${when(d.created * 1000)}`}>seen {since(d.last_seen * 1000)}</span>
        </div>
        <div className={cn("mt-1 flex items-center gap-1.5 text-ui", { ok: "text-muted", muted: "text-faint", warn: "text-warn", danger: "text-danger" }[line.tone])} data-testid="phone-push">
          <BellRing className={cn("size-3.5 shrink-0", line.tone === "ok" && "text-ok")} /> <span className="min-w-0 truncate">{line.text}</span>
        </div>
        {note && !d.push.last?.acked_ms && <div className="mt-1 text-caption text-muted" data-testid="phone-note">{note}</div>}
        <div className="mt-2.5 flex gap-2">
          <button type="button" data-testid="phone-test" disabled={busy || !canPush || !d.push.registered} onClick={test} className={button} title={canPush ? undefined : "Push is not set up on this machine"}>
            <Send className="size-3.5" /> Test push
          </button>
          <button type="button" data-testid="phone-revoke" onClick={revoke} className={cn(button, "text-danger hover:bg-danger-soft")}>
            <Trash2 className="size-3.5" /> Revoke
          </button>
        </div>
      </div>
    </div>
  );
}

export function PhoneSettings() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [openedAt] = useState(() => Date.now() / 1000);
  const load = useCallback(() => {
    api<{ devices: Device[] }>("/api/mobile/devices").then((r) => setDevices(r.devices), reportError);
    api<Settings>("/api/mobile/settings").then(setSettings, reportError);
  }, []);
  useEffect(() => {
    load();
    return onFeature({ frame: (f) => f.name === "mobile" && load(), reconnect: load });
  }, [load]);
  const active = (devices ?? []).filter((d) => !d.revoked);
  const revoked = (devices ?? []).filter((d) => d.revoked);
  const justPaired = active.find((d) => d.created >= openedAt) ?? null;

  return (
    <div className="space-y-6" data-testid="phone-panel">
      <PairCard settings={settings} paired={justPaired} />
      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-ui font-semibold text-muted">Paired phones</h3>
          {settings && (
            <span className={cn("text-caption", settings.push.configured ? "text-muted" : "text-faint")} data-testid="push-state" title={settings.push.path}>
              {settings.push.configured ? "Push is set up" : "Push is off: no service-account key"}
            </span>
          )}
        </div>
        <Card>
          {devices && !active.length && <div className="k-empty py-4">No phone is paired.</div>}
          {active.map((d) => <DeviceRow key={d.id} d={d} canPush={!!settings?.push.configured} reload={load} />)}
        </Card>
        {settings && !settings.push.configured && (
          <p className="mt-2 text-caption text-faint">To send alerts to the phone, put the service-account key of the app's Firebase project at <code className="font-mono">{settings.push.path}</code>.</p>
        )}
        {revoked.length > 0 && (
          <details className="mt-3 text-ui text-faint">
            <summary className="cursor-pointer select-none">{revoked.length} revoked</summary>
            <ul className="mt-1 space-y-0.5 pl-4">
              {revoked.map((d) => <li key={d.id}>{d.name} <span className="text-caption">paired {when(d.created * 1000)}</span></li>)}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}
