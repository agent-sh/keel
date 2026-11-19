// A change the daemon holds while background commands run in the folder (409
// with `jobs`): the owner is asked once whether to stop them, and the change
// is sent again with stop_shells. Any other failure goes on as it was.
import { confirmAction } from "../components/Confirm.tsx";

export async function stoppingShells<T>(run: (stop: boolean) => Promise<T>, o: { verb: string; where: string }): Promise<T | undefined> {
  try {
    return await run(false);
  } catch (e) {
    const jobs = (e as { body?: { jobs?: { command: string }[] } }).body?.jobs;
    if ((e as { status?: number }).status !== 409 || !jobs?.length) throw e;
    const ok = await confirmAction({
      title: "Stop its background commands?",
      body: `${jobs.map((j) => j.command.slice(0, 60)).join(", ")} still ${jobs.length > 1 ? "run" : "runs"} in ${o.where}. ${o.verb} stops ${jobs.length > 1 ? "them" : "it"}.`,
      action: `Stop and ${o.verb.toLowerCase()}`,
      danger: true,
    });
    return ok ? run(true) : undefined;
  }
}
