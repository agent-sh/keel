// Per-session memory kept by the daemon (frozen system prompts, files read,
// skills sent) with a bound: past `max` sessions the least recently used one
// drops out, and a deleted session drops out of every map at once. Each user
// says what it costs to rebuild an entry that dropped out.
const maps = new Set<SessionMap<unknown>>();

export class SessionMap<V> {
  private m = new Map<string, V>();

  constructor(private max: number) {
    maps.add(this as SessionMap<unknown>);
  }

  get(id: string): V | undefined {
    const v = this.m.get(id);
    if (v !== undefined) {
      this.m.delete(id);
      this.m.set(id, v);
    }
    return v;
  }

  set(id: string, v: V): this {
    this.m.delete(id);
    this.m.set(id, v);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value!);
    return this;
  }

  delete(id: string) {
    return this.m.delete(id);
  }

  get size() {
    return this.m.size;
  }
}

export function forgetSession(id: string) {
  for (const m of maps) m.delete(id);
}
