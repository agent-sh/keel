// What an answer on the approval cards may cover. Pure: the cards measure
// where they stand on screen (ApprovalCard.tsx, PlanCard.tsx), this decides
// from it. The one part that is not pure is when a reading is taken (the
// painted reader at the end): what counts as seen is what was painted. The
// rule behind all of it: an approval is never given for something the owner
// could not have read, or for a control that came under the hand a moment ago.
import type { Approval } from "../../../src/safety/gate.ts";
import { shownInPart } from "../../../src/safety/summary.ts";

// How long something must stand whole on screen, unmoved, before it counts:
// a request before it joins "allow all", an Allow before it acts, a changed
// "allow all" before it acts again. The time a browser's permission prompt
// holds its button for.
export const SETTLE_MS = 1000;
// A key answers sooner. The settle time above guards a hand that may have
// moved before it saw (a pointer over a control that slid there). A key press
// is judged by when it started instead: one that went down sooner than this
// after the request was painted may have been on its way before the owner saw
// it (meant for the request before), and answers nothing; one that goes down
// later was pressed with the request on screen. Simple visual reaction time,
// from a screen to a key, averages 231 ms in 1,469 adults, most between about
// 190 and 280 (Woods et al. 2015, Frontiers in Human Neuroscience 9:131), and
// a press already on its way takes about 200 to 250 ms more to call off
// (stop-signal reaction time; Verbruggen and Logan 2008, Trends in Cognitive
// Sciences 12:418). 300 ms is past both for most people, with a frame or two
// of a display's own delay to spare. A text must still be read before it is
// allowed: the lines a key may allow are those that stood in view this long.
export const KEY_MS = 300;
// How often the cards are read when nothing tells that they moved (a scroll,
// a resize and a change of the list each read at once, and so does a press).
export const READ_MS = 100;

// Where a thing stands on screen, and since when it has stood there whole.
export type Stand = { x: number; y: number; whole: boolean; since: number };

// The next reading of a thing. One that is whole in view where it was keeps
// its time; one that moved, or was cut by an edge or covered, starts again.
export function stand(prev: Stand | undefined, at: { x: number; y: number; whole: boolean }, now: number): Stand {
  if (prev?.whole && at.whole && Math.abs(prev.x - at.x) < 1 && Math.abs(prev.y - at.y) < 1) return prev;
  return { ...at, since: now };
}
export const settled = (s: Stand | undefined, now: number, ms = SETTLE_MS): boolean => !!s && s.whole && now - s.since >= ms;

// A request that is only ever answered on its own: high risk, a call the
// harness refused, one only the owner answers, one the daemon shows the start of.
export const alone = (a: Approval): boolean => a.risk !== "low" || a.kind === "refused" || !!a.once || shownInPart(a);

// One control of a card (its Allow once, its Always allow) between two readings.
// - `view`: where it stands on screen, whole or not.
// - `place`: where it stands in the list, whatever the list is scrolled to. It
//   starts again when the control's place in the list changes, and when the
//   list's own frame or length does (the caller passes no `prev.place` then).
// - `own`: its last move on screen was the owner's own scroll, with nothing
//   in the list changed.
export type Hold = { view: Stand; place: Stand; own: boolean };

// `gesture`: the owner is scrolling (a wheel, a finger, a key, the scroll bar).
// `listChanged`: the list's frame or length differs from the last reading.
export function hold(prev: Hold | undefined, at: { x: number; y: number; whole: boolean }, placed: { x: number; y: number }, gesture: boolean, listChanged: boolean, now: number): Hold {
  const view = stand(prev?.view, at, now);
  const place = stand(listChanged ? undefined : prev?.place, { ...placed, whole: true }, now);
  const moved = view !== prev?.view;
  return { view, place, own: moved ? !!prev && gesture && place === prev.place : !!prev?.own };
}

// May the control be pressed. The hazard is a control that came under the
// hand by something other than the hand: a card that has just arrived, a row
// that slid because the list changed, a scroll the page made. Each waits the
// settle time, whole on screen. A row that only moved with the owner's own
// scroll is theirs to press as soon as the scroll has ended, when the card is
// not new (`ripe`) and nothing in the list changed for the settle time.
export const pressable = (h: Hold | undefined, ripe: boolean, scrolling: boolean, now: number): boolean =>
  !!h && h.view.whole && (settled(h.view, now) || (h.own && ripe && !scrolling && settled(h.place, now)));
// The same for a key press: the control stood whole and still for KEY_MS, while no scroll moves it.
export const keyPressable = (h: Hold | undefined, scrolling: boolean, now: number): boolean =>
  !!h && h.view.whole && !scrolling && settled(h.view, now, KEY_MS);

// ---- The lines of a text the owner has had in view.
// A request is answered only for what was read, so a card keeps how much of
// its text has been in view: rows of the text, in the text's own coordinates
// (0 is the top of its first line), as sorted ranges. A line is seen when all
// of its height is in them. Only what was in view at a reading counts:
// - a view that stands counts once it has stood for the settle time: a card
//   that has just arrived, a view the page itself moved (opening a long text
//   jumps to its end, and what it jumped over was never in view);
// - while the owner scrolls, each view counts as it is read, with the one
//   they scrolled away from, but only a view that was painted: a reading
//   taken after the frame that drew it (`painted`, from the painted reader
//   below). A view the page scrolled to and moved on from before a paint
//   (a key handler's step, several steps in one frame) never stood on the
//   screen, and counts for nothing. A scroll is read once a frame, and its
//   painted views overlap, so what it passes is counted; a jump counts where
//   it lands. (A row the owner scrolled to is read as the scroll ends: its
//   answer still waits out the card's first second on the page.)
// `total`, `line`: the text's lines as it wraps now and a line's height (a text
// that wraps anew is another text: nothing of it was seen). `view`: the rows
// in view now; `since`: when exactly those came to be the ones in view;
// `shown`: the last painted view (where an own scroll left from).
type Rows = [number, number];
export type Lines = { total: number; line: number; seen: Rows[]; view: Rows | null; since: number; shown: Rows | null };

function withRows(seen: Rows[], [a, b]: Rows): Rows[] {
  const out: Rows[] = [];
  let lo = a, hi = b;
  for (const [x, y] of seen) {
    if (y < lo - 0.5 || x > hi + 0.5) out.push([x, y]);
    else { lo = Math.min(lo, x); hi = Math.max(hi, y); }
  }
  out.push([lo, hi]);
  return out.sort((p, q) => p[0] - q[0]);
}

// The next reading of a text. `own`: the view moved by the owner's own scroll
// since the last reading, with nothing else changed. `painted`: the reading
// was taken after the frame that drew this view was painted.
const sameRows = (a: Rows | null, b: Rows | null) => !!a && !!b && Math.abs(a[0] - b[0]) < 1 && Math.abs(a[1] - b[1]) < 1;
// `stood`: how long a view must stand for its lines to count (KEY_MS for what a key may allow).
export function sawLines(prev: Lines | undefined, at: { total: number; line: number; view: Rows | null; painted?: boolean }, own: boolean, now: number, stood = SETTLE_MS): Lines {
  const same = !!prev && prev.total === at.total && Math.abs(prev.line - at.line) < 0.01;
  let seen = same ? prev!.seen : [];
  const kept = sameRows(same ? prev!.view : null, at.view);
  const since = kept ? prev!.since : now;
  const left = same ? prev!.shown : null; // the painted view the owner's scroll left from
  if (at.view) {
    if (own && at.painted && !sameRows(left, at.view)) seen = withRows(left ? withRows(seen, left) : seen, at.view);
    else if (now - since >= stood) seen = withRows(seen, at.view);
  }
  return { total: at.total, line: at.line, seen, view: at.view, since, shown: at.painted ? at.view : left };
}

// The lines that have not been in view (`n`), and how many of those are not in
// view now either (`out`): those the owner has to bring into view. `begun`:
// some of the text is in view or has been, so the count is worth saying.
export function unseenLines(l: Lines | undefined): { n: number; out: number; begun: boolean } {
  if (!l) return { n: 1, out: 0, begun: false };
  const within = (rows: Rows[], i: number) => rows.some(([a, b]) => a <= i * l.line + 1 && b >= (i + 1) * l.line - 1);
  let n = 0, out = 0;
  for (let i = 0; i < l.total; i++) {
    if (within(l.seen, i)) continue;
    n++;
    if (!l.view || !within([l.view], i)) out++;
  }
  return { n, out, begun: !!l.view || n < l.total };
}

export type Batch = {
  tool: string;
  kind: Approval["kind"];
  waiting: number; // the tool's open requests, whatever they are
  ids: string[];   // the ones one answer may cover now, oldest first
};

// One batch per tool with two or more requests that could be answered
// together. `read` holds the requests whose text stands whole on screen and
// has for the settle time; `cutByBox` the ones whose text is longer than the
// box that shows it. A request joins only while it is in the first and not in
// the second: what is out of view, moving, covered or cut is left out, as the
// ones answered alone are.
export function batches(cards: Approval[], read: ReadonlySet<string>, cutByBox: ReadonlySet<string>): Batch[] {
  const by = new Map<string, Batch & { able: number }>();
  for (const a of cards) {
    if (a.state !== "pending") continue;
    const b = by.get(a.tool) ?? { tool: a.tool, kind: a.kind, waiting: 0, ids: [], able: 0 };
    by.set(a.tool, b);
    b.waiting++;
    if (alone(a) || cutByBox.has(a.id)) continue;
    b.able++;
    if (read.has(a.id)) b.ids.push(a.id);
  }
  return [...by.values()].filter((b) => b.able > 1).map(({ able: _able, ...b }) => b);
}

// The state of one "allow all" action between two readings.
export type Action = {
  covered: string[];       // what it names and would answer
  frozen: string[] | null; // while the pointer or the keyboard is on it and it can be pressed: what it covered then
  hold: number;            // it does not act before this time
  grown?: boolean;         // that hold is for a count that grew (another one that joins meanwhile starts it again)
  live: boolean;           // it can be pressed
};

// `ready` is the batch's ids now; `hot` says the pointer or the keyboard is on
// the action; `open` holds the requests that still wait.
// - While it is hot and can be pressed, what it covers only shrinks: a request
//   joins after the pointer and the keyboard have left it.
// - When everything it held is answered (elsewhere, or by itself), it starts
//   again from what is ready, after the settle time: the hand is still on it.
// - When it grows while it could be pressed (nothing on it: a finger gives no
//   warning), it shows the new count and does not act for the settle time, so
//   a press aimed at the old count lands on nothing.
// - From not pressable (too few ready, or still held) it becomes pressable
//   with what is ready then, as a prompt's button does after its delay.
export function nextAction(prev: Action | undefined, ready: string[], hot: boolean, now: number, open: ReadonlySet<string>): Action {
  const was = prev ?? { covered: [], frozen: null, hold: 0, live: false };
  let frozen = hot ? was.frozen : null;
  let hold = was.hold;
  let grown = !!was.grown && now < was.hold;
  if (frozen && !frozen.some((id) => open.has(id))) {
    frozen = null;
    hold = now + SETTLE_MS;
    grown = false;
  }
  const covered = frozen ? ready.filter((id) => frozen!.includes(id)) : ready;
  const grew = covered.some((id) => !was.covered.includes(id));
  // Only a count that grew where it could be pressed is held again. After the
  // action answered, the next rows stand for the settle time as they come
  // into view: that wait is the one hold, not a second one after it.
  if (!frozen && grew && (was.live || grown)) {
    hold = now + SETTLE_MS;
    grown = true;
  }
  const live = covered.length > 1 && now >= hold;
  if (hot && live && !frozen) frozen = covered;
  return { covered, frozen, hold, grown, live };
}
// The action has just answered: it does not act again for the settle time, wherever the rows stand.
export const spentAction = (now: number): Action => ({ covered: [], frozen: null, hold: now + SETTLE_MS, live: false });

const noun = (b: Pick<Batch, "kind">, n: number) => `${b.kind === "shell" ? "command" : b.kind === "edit" ? "change" : "call"}${n === 1 ? "" : "s"}`;
// "3 Bash commands", "2 Edit changes", "1 fetch call".
export const batchName = (b: Pick<Batch, "tool" | "kind">, n: number): string => `${n} ${b.tool} ${noun(b, n)}`;
// What the action says it covers: all of the tool's requests, or how many of them.
export const coverName = (b: Pick<Batch, "tool" | "kind" | "waiting">, n: number): string =>
  n === b.waiting ? `all ${batchName(b, n)}` : `${n} of ${batchName(b, b.waiting)}`;

// ---- The painted reader: when a reading of the lines in view is taken.
// What a reading counts as seen must have stood on the screen. A reading is
// asked for by whatever may have moved a view (a scroll, a resize, a step of
// End); it is taken once a frame, after that frame was painted: a frame's
// callback marks where the watched elements stand, a task posted from it runs
// after the paint, and the reading is taken there only if they still stand
// where they were marked (a key handled between the paint and the task moved
// them: that view was not painted, and the reading waits for the next frame).
// Asks within one frame are one reading: a view a later one replaced before
// the paint is never read. `then` runs after the reading it waited for.
export type PaintedReader = { ask: (then?: () => void) => void; stop: () => void };
export function paintedReader(watched: () => Element[], read: () => void): PaintedReader {
  let frame = 0, stopped = false;
  let waiting: (() => void)[] = [];
  const mark = () => watched().map((el) => { const r = el.getBoundingClientRect(); return `${Math.round(r.top * 10)}:${Math.round(r.bottom * 10)}:${el.scrollTop}`; }).join("|");
  const port = new MessageChannel();
  let marked = "";
  port.port1.onmessage = () => {
    if (stopped) return;
    if (mark() !== marked) return schedule();
    const then = waiting;
    waiting = [];
    read();
    for (const f of then) f();
  };
  const schedule = () => {
    if (frame || stopped) return;
    frame = requestAnimationFrame(() => { frame = 0; marked = mark(); port.port2.postMessage(0); });
  };
  return {
    ask: (then) => { if (then) waiting.push(then); schedule(); },
    stop: () => { stopped = true; cancelAnimationFrame(frame); waiting = []; port.port1.close(); },
  };
}

// Reads on through a text by steps (End, Page Down), each a move of the
// owner's own: a step is made only once the view before it was painted and
// read (two frames after the key, or after the reading of the step before),
// and its own view is read after it was painted. `step` moves the view and
// says whether it did; `end`: on to the end, else one step. `done` runs when
// the steps are over (the last one read, or no step left to make).
// `step` says "wait" while lines in view now were not counted as seen yet: the
// view the key found was not read after a paint (the key came in the frames
// after the text grew), or a reading found the list changed under it. A step
// then would carry those lines out of view unread, and End would stop short of
// the end with them still to read. The view is read again after the next paint
// and the step asked again. A view that stands counts within a settle time
// (sawLines); one that still does not after twice that is kept from counting
// by something else (a layer over it), and the steps end there.
export function readOnSteps(step: () => boolean | "wait", reader: PaintedReader, end: boolean, done?: () => void): void {
  const later = (f: () => void) => requestAnimationFrame(() => requestAnimationFrame(f));
  let waiting = 0;
  const next = () => {
    const did = step();
    if (did === "wait") {
      waiting ||= performance.now();
      if (performance.now() - waiting > 2 * SETTLE_MS) return done?.();
      return reader.ask(next);
    }
    waiting = 0;
    if (did) reader.ask(() => (end ? later(next) : done?.())); else done?.();
  };
  later(next);
}
