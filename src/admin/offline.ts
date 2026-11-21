// The offline runner's side of an experiment (scripts/bench/run.ts): what it
// keeps on disk about the runs it made, and how they reach the daemon.
//
// Every run gets a receipt, a name made once, and is written to a local
// receipt file before anything is sent. An upload sends every run the daemon
// has not acknowledged yet, so a lost answer or a daemon that was down costs
// nothing: the next attempt sends the same receipts and the daemon counts
// each once. The experiment is stopped on the daemon (which makes its report
// final) only when every run is acknowledged; until then the file is what
// the run is recovered from (`run.ts --resume FILE`).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { report, turnMetrics, type Experiment, type Report, type RunUpload } from "./experiments.ts";

// What a run's metrics are measured over: one scope for all of them, the
// same in the runner's own report and in what the daemon is sent.
export const RUN_SCOPE = "every model request of the run's turn: the working model's requests and the reader models' requests; side requests (a title, a summary) belong to no turn and are left out";
// A run's values for the experiment metrics, from its turn's rollup (the row
// a live turn is judged by too), so offline and live metrics mean the same:
// - requests: every request sent in the turn, failed attempts and retries included.
// - prompt_tokens, output_tokens: the tokens of the requests that were
//   answered (a failed attempt reports none).
// - cache_read_share: cache reads over prompt_tokens, of the same requests.
// - cost_usd: the cost of the same requests; left out when one of them has
//   no price, never counted as free. An experiment judged by cost names no
//   winner while a run of a compared arm lacks it.
// - ok: the task's check passed; ms: the run's wall time; error: the turn
//   ended in an error; tool_errors: failed tool calls of the turn.
// A run whose turn left no rollup reports only what the runner saw itself.
export function runMetrics(turn: Record<string, any> | undefined, run: { ok: boolean; ms: number }): Record<string, number> {
  const seen = { ok: run.ok ? 1 : 0, ms: run.ms };
  if (!turn) return seen;
  // No reply is rated in a run.
  const { thumbs_down: _none, ...m } = turnMetrics(turn);
  return { ...m, ...seen };
}

// The report over a set of runs, as the runner prints it and as the daemon
// computes it from the same uploads: one cluster per run, the task as stratum.
export function offlineReport(e: Experiment, runs: RunUpload[]): Report {
  return report(e, runs.map((r, i) => ({ arm: r.arm, cluster: `run-${i}`, stratum: r.task, m: r.metrics })));
}

export type Ledger = { daemon: string; experiment: string; label: string; runs: RunUpload[]; acked: string[]; stopped: boolean };
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
// A daemon that has not answered by then counts as not acknowledged: the run stays pending.
const ANSWER_MS = 60_000;

export class Uploads {
  // Why the last attempt left runs pending.
  problem = "";

  private constructor(readonly file: string, readonly ledger: Ledger, private fetch: Fetch) {}

  static start(file: string, to: Pick<Ledger, "daemon" | "experiment" | "label">, fetch: Fetch = globalThis.fetch): Uploads {
    const u = new Uploads(file, { ...to, runs: [], acked: [], stopped: false }, fetch);
    u.save();
    return u;
  }
  static open(file: string, fetch: Fetch = globalThis.fetch): Uploads {
    if (!existsSync(file)) throw new Error(`no receipt file ${file}`);
    return new Uploads(file, JSON.parse(readFileSync(file, "utf8")), fetch);
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.ledger, null, 1));
    renameSync(`${this.file}.tmp`, this.file);
  }

  get pending(): RunUpload[] {
    const acked = new Set(this.ledger.acked);
    return this.ledger.runs.filter((r) => !acked.has(r.receipt));
  }

  // A finished run: on disk first, sent later.
  add(run: RunUpload) {
    if (this.ledger.runs.some((r) => r.receipt === run.receipt)) throw new Error(`receipt ${run.receipt} is taken`);
    this.ledger.runs.push(run);
    this.save();
  }

  private async post(path: string, body: unknown): Promise<Response | null> {
    try {
      return await this.fetch(`${this.ledger.daemon}/api/experiments/${this.ledger.experiment}${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(ANSWER_MS),
      });
    } catch (e: any) {
      this.problem = `no answer from the daemon: ${e?.message ?? e}`;
      return null;
    }
  }

  // Sends every run the daemon has not acknowledged. True when none is left.
  async flush(): Promise<boolean> {
    const pending = this.pending;
    if (!pending.length) return true;
    const res = await this.post("/runs", { runs: pending });
    if (!res) return false;
    if (!res.ok) {
      this.problem = `the daemon refused the upload: ${res.status} ${(await res.text()).slice(0, 300)}`;
      return false;
    }
    this.ledger.acked.push(...pending.map((r) => r.receipt));
    this.problem = "";
    this.save();
    return true;
  }

  // Stops the experiment on the daemon, once it has acknowledged every run.
  async finalize(reason: string): Promise<{ finalized: boolean; pending: number; problem: string }> {
    if (!(await this.flush())) return { finalized: false, pending: this.pending.length, problem: this.problem };
    if (!this.ledger.stopped) {
      const res = await this.post("/stop", { reason });
      // 409: it is stopped already (an earlier stop whose answer was lost).
      const stopped = !!res && (res.ok || (res.status === 409 && /stopped/.test(await res.text())));
      if (!stopped) {
        if (res) this.problem = `the daemon did not stop the experiment: ${res.status}`;
        return { finalized: false, pending: 0, problem: this.problem };
      }
      this.ledger.stopped = true;
      this.save();
    }
    return { finalized: true, pending: 0, problem: "" };
  }
}
