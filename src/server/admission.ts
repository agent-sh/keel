// Checks every API request passes before its handler: a module that must turn
// requests away for a while (a draining daemon) adds one. The first answer wins.
type Check = (req: Request, path: string) => Response | undefined;
const checks: Check[] = [];
export const addAdmission = (c: Check) => void checks.push(c);
export function admit(req: Request): Response | undefined {
  if (!checks.length) return undefined;
  const path = new URL(req.url).pathname;
  for (const c of checks) {
    const r = c(req, path);
    if (r) return r;
  }
  return undefined;
}
