// A Claude Code or Codex session a terminal holds, answered from Keel's composer: the text goes through the drive
// (src/drive/drive.ts), so the owner's agent view types it into the open terminal. The session keeps its id and its
// transcript, the terminal stays its holder, and the reply comes into Keel's row as the harness writes it (the
// outside follower, service.ts). Held while the terminal's box shows a draft the owner has not sent
// (src/drive/box.ts) or a prompt is open there; the words are kept as sent (src/drive/sent.ts) before they go, so
// the harness's record of them, which reads as typed at its prompt, never counts as typed in a later copy.
import type { Store } from "../../core/store.ts";
import type { Raw } from "../../drive/agentview.ts";
import * as av from "../../drive/agentview.ts";
import { DriveError, toRow, type Drive, type Found } from "../../drive/drive.ts";
import { noteSent } from "../../drive/sent.ts";

type Source = { harness: string; source_id: string; path: string };

// The agent view's row of the session on this machine, live: by the harness's own id of it, or its transcript.
export function rowOf(raws: Raw[], src: Source): Raw | undefined {
  const ids = (r: Raw) => (src.harness === "codex" ? [r.thread, r.session] : [r.session]);
  return raws.find((r) => r.tool === src.harness && !r.host && r.live === true && (ids(r).includes(src.source_id) || (typeof r.transcript === "string" && r.transcript === src.path)));
}

export type Sent = { state: "typed" | "queued"; said: string };

export class Through {
  private going = new Map<string, Promise<{ sent: Sent } | { error: string; status: number }>>();
  constructor(private d: { store: Store; drive: Drive; source: (sessionId: string) => Source | undefined }) {}

  on(): boolean { return this.d.drive.configured(); }

  // Whether the agent view listed the session in its last list (no call: the bar's route is read often).
  listed(sessionId: string): boolean {
    const src = this.d.source(sessionId);
    return !!src && this.on() && !!rowOf(this.d.drive.cachedRaws(), src);
  }
  // The list read again when it is older than the drive's sharing time (a bar opened, a holder changed).
  async fresh(): Promise<void> {
    if (this.on()) await this.d.drive.raws().catch(() => undefined);
  }

  private async found(sessionId: string): Promise<Found> {
    const src = this.d.source(sessionId);
    if (!src) throw new DriveError("NOT_FOUND", "not a session of another harness");
    const raw = rowOf(await this.d.drive.raws(0).catch((e) => { throw new DriveError("NOT_AVAILABLE", (e as Error).message); }), src);
    if (!raw) throw new DriveError("NOT_FOUND", "the agent view does not list this session as open in a terminal now, so nothing can be typed there. Answer it in its terminal");
    return { host: "", key: av.nativeKey(raw), raw, row: toRow(raw) };
  }

  // A send by the owner, once for its key: a second press of the same draft is the first one's answer.
  send(sessionId: string, text: string, key: string): Promise<{ sent: Sent } | { error: string; status: number }> {
    const k = `${sessionId}\0${key}`;
    const had = this.d.store.db.query<{ said: string | null }, [string, string]>("SELECT said FROM outside_sends WHERE session_id = ? AND key = ? AND state = 'delivered'").get(sessionId, key);
    if (had) return Promise.resolve({ sent: { state: "typed", said: had.said ?? "" } });
    const now = this.going.get(k);
    if (now) return now;
    const p = this.run(sessionId, text, key).finally(() => this.going.delete(k));
    this.going.set(k, p);
    return p;
  }

  private async run(sessionId: string, text: string, key: string): Promise<{ sent: Sent } | { error: string; status: number }> {
    if (!text.trim()) return { error: "nothing to send", status: 400 };
    try {
      const f = await this.found(sessionId);
      const box = await this.d.drive.box(f, true);
      if (box === "draft") throw new DriveError("NOT_SENT", "Your unsent draft is in its terminal's box: a text typed now would go out inside it. Send it or clear it there, then send again. Nothing was sent.");
      // Kept before the words go; loosely when the box could not be read empty (sent-read.ts keysInto).
      noteSent(this.d.store, text, box !== "empty");
      const r = await this.d.drive.deliver(f, text);
      const sent: Sent = r.state === "submitted" ? { state: "typed", said: "Typed into its terminal." } : { state: "queued", said: "Waits until its terminal is ready, then is typed there." };
      this.d.store.db.query("INSERT OR IGNORE INTO outside_sends (id, session_id, key, text, state, offset, said, created) VALUES (?, ?, ?, ?, 'delivered', NULL, ?, ?)").run(Bun.randomUUIDv7(), sessionId, key, text, sent.said, Date.now());
      return { sent };
    } catch (e) {
      if (e instanceof DriveError) return { error: e.message, status: e.status };
      return { error: (e as Error).message, status: 500 };
    }
  }
}
