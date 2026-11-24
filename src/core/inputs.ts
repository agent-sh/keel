// Input the harness put in the conversation as a user message (a child's
// report, a wake, a task, a peer's message, a harness note): never the owner's
// words. Shared by the views that leave the workbench (ACP, exports).
export const INPUT_LABEL: Record<string, string> = {
  subagent: "Report from a child agent", task: "Task from the parent session", wait: "Wait update", wake: "Wait update",
  loop: "Loop run", goal: "Goal check", steer: "Steer", harness: "Keel note", peer: "Message from another session",
  channel: "Event from a connected source", checks_beside: "Checks beside the agent", steward: "PR Steward",
};

export function inputKind(d: any): string | null {
  if (typeof d?.kind === "string" && d.kind && INPUT_LABEL[d.kind]) return d.kind;
  if (String(d?.text ?? "").startsWith("<external_input")) return "peer";
  if (d?.origin === "harness" || d?.origin === "restart") return "harness";
  return null;
}
