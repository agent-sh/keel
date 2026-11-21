import { automationRoutes } from "../../automation/index.ts";
import type { RouteModule } from "../app.ts";
import { checkpointRoutes } from "./checkpoints.ts";
import { codeModeRoutes } from "./codemode.ts";
import { draftRoutes } from "./drafts.ts";
import { errorRoutes } from "./errors.ts";
import { observeRoutes } from "./observe.ts";
import { adminRoutes } from "./admin.ts";
import { telemetryRoutes } from "./telemetry.ts";
import { driveRoutes } from "./drive.ts";
import { fleetRoutes } from "./fleet.ts";
import { resourceRoutes } from "./resources.ts";
import { mcpRoutes } from "./mcp.ts";
import { voiceRoutes } from "./voice.ts";
import { mobileRoutes } from "./mobile.ts";
import { permissionRoutes } from "./permissions.ts";
import { secretRoutes } from "./secrets.ts";
import { trustRoutes } from "./trust.ts";
import { nestedRoutes } from "./nested.ts";
import { repeatRoutes } from "./repeat.ts";
import { planRoutes } from "./plan.ts";
import { providersRoutes } from "./providers.ts";
import { providerSetupRoutes } from "./provider-setup.ts";
import { profileRoutes } from "./profile.ts";
import { pwaRoutes } from "./pwa.ts";
import { toolRoutes } from "./tools.ts";
import { usageRoutes } from "./usage.ts";
import { searchRoutes } from "./search.ts";
import { integrationRoutes } from "./integrations.ts";
import { importRoutes } from "./imports.ts";
import { portRoutes } from "./port.ts";
import { takeoverRoutes } from "./takeover.ts";
import { resumeRoutes } from "./resume.ts";
import { hookRoutes } from "./hooks.ts";
import { surfaceRoutes } from "./surfaces.ts";
import { workspaceRoutes } from "./workspace.ts";
import { worktreeRoutes } from "./worktrees.ts";
import { reviewRoutes } from "./reviews.ts";
import { turnRoutes } from "./turns.ts";
import { switchRoutes } from "./switch.ts";
import { buildPinRoutes } from "./build-pin.ts";
import { sideRoutes } from "./side.ts";
import { treeRoutes } from "./tree.ts";
import { attachmentRoutes } from "./attachments.ts";
import { runRoutes } from "./run.ts";
import { marksRoutes } from "./marks.ts";
import { projectRoutes } from "./projects.ts";
import { sessionFolderRoutes } from "./session-folders.ts";
import { artifactRoutes } from "./artifacts.ts";
import { convoRoutes } from "./convo.ts";
import { placesRoutes } from "./places.ts";
import { terminalRoutes } from "./terminal.ts";
import { remoteRoutes } from "./remote.ts";
import { acpRoutes } from "./acp.ts";
import { helperRoutes } from "./helper.ts";
import { experimentRoutes } from "./experiments.ts";
import { timelineRoutes } from "./timeline.ts";
import { overviewRoutes } from "./overview.ts";

// Each feature module adds one line here.
export const routeModules: RouteModule[] = [
  codeModeRoutes, // refuses run_code for a session on another machine before the gate asks about it
  repeatRoutes, // before the gate: a repeat it refuses needs no approval; it reads a result before others add to it
  permissionRoutes, // first: its beforeTool gate decides before the others run
  planRoutes,
  trustRoutes, // protected files are watched around calls the gate let through
  nestedRoutes, // after trust: nested instruction files go through its filter
  checkpointRoutes,
  workspaceRoutes,
  pwaRoutes,
  remoteRoutes,
  mcpRoutes,
  voiceRoutes, // after mcp: it bundles the say tool
  toolRoutes,
  searchRoutes,
  providersRoutes,
  acpRoutes, // after permissions: the gate judges what an ACP agent asks for
  providerSetupRoutes,
  profileRoutes,
  worktreeRoutes,
  reviewRoutes,
  turnRoutes,
  switchRoutes,
  buildPinRoutes,
  sideRoutes,
  treeRoutes,
  attachmentRoutes,
  usageRoutes,
  errorRoutes,
  resourceRoutes,
  adminRoutes,
  observeRoutes, // after admin: it reads the settings admin loads
  automationRoutes,
  integrationRoutes,
  helperRoutes, // after integrations: its note for a prompt follows the tacit memory note
  driveRoutes,
  fleetRoutes, // after the gates: sends a placed session's workspace calls to their machine
  terminalRoutes, // after fleet: a placed session's commands are asked of its machine
  mobileRoutes, // after automation: it registers the phone as an alert channel
  draftRoutes,
  marksRoutes, // after automation: unread marks are its alerts
  projectRoutes, // after permissions: a project's default mode goes through its gate
  sessionFolderRoutes,
  artifactRoutes, // after checkpoints: a turn's end reads the checkpoint that turn made
  convoRoutes,
  placesRoutes,
  importRoutes,
  portRoutes, // bring the setup of the other harnesses over
  takeoverRoutes, // taking over a session another harness runs
  resumeRoutes, // the same for a conversation on an ssh machine: its state, wait or resume now
  hookRoutes,
  surfaceRoutes, // Settings: skills, agent files, instruction files, the hooks file, plugins.toml
  runRoutes, // the command line: keel run, keel send
  secretRoutes, // the last gate: a call runs with its secrets put back, after every hook saw the placeholder
  telemetryRoutes, // its tool timing starts after every gate
  experimentRoutes, // after telemetry: a turn's row reads the calls telemetry wrote
  timelineRoutes, // reads what the others record: events, activity, errors, telemetry
  overviewRoutes, // every session's state, failure and spend as one answer
];
