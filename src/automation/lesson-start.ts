// The lessons an agent starts with (src/automation/lessons.ts sets the reader
// while its routes are up): the block of its task that carries them, or "".
import type { Session } from "../core/types.ts";

export const lessonStart: { block?: (child: Session, agentId: string) => string } = {};
