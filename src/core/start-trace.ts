// Where a start's time goes: the moments the daemon passes between its
// process's start and its first answer, and how long each feature module
// took to set itself up. One line of the log tells it after every start
// (`keel start: ...`), and the daemon's status carries the numbers, so a
// start that is slow on one store says where without a profiler.
const G = globalThis as { __keelStartTrace?: { marks: [string, number][]; modules: [string, number][] } };
const trace = () => (G.__keelStartTrace ??= { marks: [], modules: [] });

// A phase ends now. Times are from the process's start (the clock's origin).
export const startMark = (phase: string) => void trace().marks.push([phase, performance.now()]);
// A feature module took this long to set up.
export const moduleTook = (name: string, ms: number) => void trace().modules.push([name, ms]);
// A new start in the same process (a hot reload) is traced from its own beginning.
export function startTraceBegin() {
  G.__keelStartTrace = { marks: [["process", performance.now()]], modules: [] };
}

export type StartTimes = { total_ms: number; phases: Record<string, number>; slowest: { name: string; ms: number }[] };

// The phases in order, each with the time since the one before it, and the slowest modules.
export function startTimes(): StartTimes | undefined {
  const { marks, modules } = trace();
  if (marks.length < 2) return undefined;
  const phases: Record<string, number> = {};
  let before = 0;
  for (const [name, at] of marks) { phases[name] = Math.round(at - before); before = at; }
  const slowest = [...modules].sort((a, b) => b[1] - a[1]).slice(0, 8).filter(([, ms]) => ms >= 20).map(([name, ms]) => ({ name, ms: Math.round(ms) }));
  return { total_ms: Math.round(marks.at(-1)![1]), phases, slowest };
}

const secs = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
export function startTookLine(): string | undefined {
  const t = startTimes();
  if (!t) return undefined;
  const parts = Object.entries(t.phases).map(([name, ms]) => `${name} ${secs(ms)}`).join(", ");
  const slow = t.slowest.length ? `; slowest modules: ${t.slowest.map((m) => `${m.name} ${secs(m.ms)}`).join(", ")}` : "";
  return `keel start: ${secs(t.total_ms)} from the process's start to listening (${parts}${slow})`;
}
