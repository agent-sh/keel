import type { Session } from "../../../src/core/types.ts";

// A top-level session of this daemon: an agent's session holds no words of the owner's, and another harness's none Keel ties.
export const hasAsks = (s: Pick<Session, "parent_id" | "outside" | "machine"> | undefined) => !!s && !s.parent_id && !s.outside && !s.machine;
