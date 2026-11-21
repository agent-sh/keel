// Client state of projects (src/server/routes/projects.ts): the list, who is
// in which, loaded once and again on each "projects" frame and reconnect.
import { useSyncExternalStore } from "react";
import type { Project } from "../../../src/server/routes/projects.ts";
import { api, getState as appState, onFeature, readAtOpen, reportError } from "./store.ts";
import { navigate, savePref, setUI } from "./ui.ts";

export type { Project };
type State = { projects: Project[]; members: Record<string, string>; loaded: boolean };
let state: State = { projects: [], members: {}, loaded: false };
const subs = new Set<() => void>();
const set = (p: Partial<State>) => { state = { ...state, ...p }; subs.forEach((f) => f()); };

const read = () => api<{ projects: Project[]; members: Record<string, string> }>("/api/projects").then((r) => set({ ...r, loaded: true }));
export const loadProjects = () => read().catch(reportError);
onFeature({ frame: (f) => { if (f.name === "projects") loadProjects(); }, reconnect: readAtOpen(read) });

export const getProjects = () => state;
export const subscribeProjects = (f: () => void) => (subs.add(f), () => void subs.delete(f));
export function useProjects<T>(sel: (s: State) => T): T {
  return useSyncExternalStore((f) => (subs.add(f), () => subs.delete(f)), () => sel(state));
}

// The project that holds a folder most closely (what a new session there joins).
export function projectOfFolder(path: string): Project | undefined {
  let best: Project | undefined, len = -1;
  for (const p of state.projects) for (const f of p.folders) if ((path === f || path.startsWith(`${f}/`)) && f.length > len) { best = p; len = f.length; }
  return best;
}

export const projects = {
  create: (body: Partial<Project>) => api<{ project: Project }>("/api/projects", { method: "POST", body: JSON.stringify(body) }).then((r) => { loadProjects(); return r.project; }),
  patch: (id: string, body: Partial<Project>) => api<{ project: Project }>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }).then((r) => { loadProjects(); return r.project; }),
  remove: (id: string) => api(`/api/projects/${id}`, { method: "DELETE" }).then(() => loadProjects()),
  // A session put in a project, taken out of all ("none"), or back to its folder's (null).
  move: (sessionId: string, project: string | null) => api(`/api/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify({ project }) }).then(() => loadProjects()),
};

// A new session in the project: the start box opens on its primary folder and default model.
export function newInProject(p: Project) {
  if (p.folders[0]) savePref("newWorkspace", p.folders[0]);
  setUI({ newProject: p.id, newModel: p.defaults.model && appState().models.some((m) => m.id === p.defaults.model) ? p.defaults.model : "" });
  navigate({ name: "new" });
}

// A new project, named and opened at once.
export async function createProject(folder?: string) {
  const p = await projects.create({ name: `Project ${state.projects.length + 1}`, ...(folder ? { folders: [folder] } : {}) });
  navigate({ name: "project", id: p.id });
  return p;
}
