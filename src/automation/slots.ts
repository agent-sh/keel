// The line for a session's agent slots. Pure: agents.ts keeps one per parent.
//
// A session's limit counts its agents that work. An agent that waits holds no
// slot; when its wake comes and every slot is taken, it joins the line at the
// time it parked, so it never loses its place to an agent asked for after
// that. A spawn that finds no room joins at the time it was asked. A slot
// that frees goes to the earliest place; places of one time keep their order.

export type Place = { key: string; at: number; go: () => void };

export class Line {
  private places: Place[] = [];

  get length() { return this.places.length; }
  has(key: string) { return this.places.some((p) => p.key === key); }
  keys() { return this.places.map((p) => p.key); }

  // Joins in order of `at`; a key already in line keeps its place.
  join(p: Place): boolean {
    if (this.has(p.key)) return false;
    const i = this.places.findIndex((q) => q.at > p.at);
    if (i < 0) this.places.push(p);
    else this.places.splice(i, 0, p);
    return true;
  }

  leave(key: string): boolean {
    const n = this.places.length;
    this.places = this.places.filter((p) => p.key !== key);
    return this.places.length < n;
  }

  // How many places are before a place at `at` (the ones of an earlier time).
  ahead(at: number) { return this.places.filter((p) => p.at < at).length; }

  shift(): Place | undefined { return this.places.shift(); }
}

// The words of a refusal at the limit: how many work and how many wait.
export function limitWords(o: { limit: number; working: number; reserved: number; line: number; waiting: number }): string {
  const work = o.working + o.reserved;
  const parts = [`${work} ${work === 1 ? "works" : "work"}`];
  if (o.line) parts.push(`${o.line} more ${o.line === 1 ? "waits" : "wait"} for a slot`);
  const waits = o.waiting ? `; ${o.waiting} ${o.waiting === 1 ? "agent waits on a wait of its own and holds" : "agents wait on waits of their own and hold"} no slot` : "";
  return `AGENT_LIMIT: ${o.limit} agent slots of this session are in use (${parts.join(", ")}${waits}).`;
}
