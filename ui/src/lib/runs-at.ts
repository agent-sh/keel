// Where an approval's command runs, as its card names it ("in <folder>, branch <b>").
type At = { cwd?: string; sub?: string; shell?: string; away?: true };
export type Where = { folder: string; branch?: string | null };
// The folder (and branch) an approval's command runs in, as its card names it: the folder it
// starts in (`at.cwd`, said when it is not the asker's own) wins over the asker's; the asker's
// branch goes with it only when that folder is the asker's or inside it.
export function runsAt(at: At | undefined, where?: Where, shell = true): Where | null {
  const cwd = at?.cwd;
  // (A card that is not a command's names no folder of the asker's: an edit's own path says where it is.)
  if (!cwd) return shell ? where ?? null : null;
  if (!where) return { folder: cwd };
  const root = where.folder.replace(/\/+$/, "");
  // (The daemon resolved the folder for real: a link inside the worktree that leads out of it is away.)
  const inside = !at?.away && (cwd === root || cwd.startsWith(`${root}/`));
  return inside ? { folder: cwd, branch: where.branch } : { folder: cwd };
}
