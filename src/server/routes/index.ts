import { automationRoutes } from "../../automation/index.ts";
import type { RouteModule } from "../app.ts";
import { checkpointRoutes } from "./checkpoints.ts";
import { lspRoutes } from "./lsp.ts";
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
import { mcpAppRoutes } from "./mcp-apps.ts";
import { voiceRoutes } from "./voice.ts";
import { speechRoutes } from "./speech.ts";
import { mobileRoutes } from "./mobile.ts";
import { permissionRoutes } from "./permissions.ts";
import { secretRoutes } from "./secrets.ts";
import { trustRoutes } from "./trust.ts";
import { nestedRoutes } from "./nested.ts";
import { agnixRoutes } from "./agnix.ts";
import { repeatRoutes } from "./repeat.ts";
import { pointerRoutes } from "./pointer.ts";
import { readRunRoutes } from "./read-runs.ts";
import { tierRoutes } from "./tiers.ts";
import { planRoutes } from "./plan.ts";
import { providersRoutes } from "./providers.ts";
import { providerSetupRoutes } from "./provider-setup.ts";
import { profileRoutes } from "./profile.ts";
import { pwaRoutes } from "./pwa.ts";
import { toolRoutes } from "./tools.ts";
import { usageRoutes } from "./usage.ts";
import { contentRouteRoutes } from "./content-routes.ts";
import { searchRoutes } from "./search.ts";
import { integrationRoutes } from "./integrations.ts";
import { importRoutes } from "./imports.ts";
import { outsideRoutes } from "./outside.ts";
import { portRoutes } from "./port.ts";
import { takeoverRoutes } from "./takeover.ts";
import { resumeRoutes } from "./resume.ts";
import { hookRoutes } from "./hooks.ts";
import { surfaceRoutes } from "./surfaces.ts";
import { pluginUnitRoutes } from "./plugin-units.ts";
import { workspaceRoutes } from "./workspace.ts";
import { worktreeRoutes } from "./worktrees.ts";
import { sessionPortRoutes } from "./session-ports.ts";
import { overlapRoutes } from "./overlaps.ts";
import { landingRoutes } from "./landing.ts";
import { stewardRoutes } from "./steward.ts";
import { boardRoutes } from "./board.ts";
import { treeReviewRoutes } from "./tree-review.ts";
import { readyRoutes } from "./ready.ts";
import { lanePlanRoutes } from "./lane-plans.ts";
import { reviewRoutes } from "./reviews.ts";
import { prReviewRoutes } from "./pr-reviews.ts";
import { turnRoutes } from "./turns.ts";
import { switchRoutes } from "./switch.ts";
import { accountRoutes } from "./accounts.ts";
import { safetyTrialRoutes } from "./safety-trial.ts";
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
import { modelTrialRoutes } from "./model-trials.ts";
import { settingTrialRoutes } from "./setting-trials.ts";
import { timelineRoutes } from "./timeline.ts";
import { hoursRoutes } from "./hours.ts";
import { ownerCompactRoutes } from "./owner-compact.ts";
import { lensRoutes } from "./lens.ts";
import { overviewRoutes } from "./overview.ts";
import { stateRoutes } from "./state.ts";
import { shellRoutes } from "./shell.ts";
import { checkRoutes } from "./checks.ts";
import { pictureRoutes } from "./pictures.ts";
import { egressRoutes } from "./egress.ts";
import { auditRoutes } from "./audit.ts";
import { pressRoutes } from "./presses.ts";
import { healthRoutes } from "./health.ts";
import { rulingRoutes } from "../../automation/rulings.ts";
import { lessonRoutes } from "../../automation/lessons.ts";

// Each feature module adds one line here.
// Each is listed under its name: a built binary's functions lose theirs, and a start says by name which module took its time (src/core/start-trace.ts).
const modules: Record<string, RouteModule> = {
  codeModeRoutes, // refuses run_code for a session on another machine before the gate asks about it
  repeatRoutes, // before the gate: a repeat it refuses needs no approval; it reads a result before others add to it
  tierRoutes,
  readRunRoutes, // beside repeatRoutes: its note goes on a read's result before others add to it
  permissionRoutes, // first: its beforeTool gate decides before the others run
  checkRoutes, // after the gate: a check is looked at (its files hashed) and answered only once the call may run
  planRoutes,
  pointerRoutes,
  trustRoutes, // protected files are watched around calls the gate let through
  nestedRoutes, // after trust: nested instruction files go through its filter
  agnixRoutes,
  checkpointRoutes,
  lspRoutes, // after trust and checkpoints: an edit's result gets its diagnostics last
  workspaceRoutes,
  pwaRoutes,
  remoteRoutes,
  mcpRoutes,
  mcpAppRoutes, // after mcpRoutes: it gives the manager its app keeper
  voiceRoutes, // after mcp: it bundles the say tool
  speechRoutes,
  toolRoutes,
  searchRoutes,
  providersRoutes,
  acpRoutes, // after permissions: the gate judges what an ACP agent asks for
  providerSetupRoutes,
  profileRoutes,
  worktreeRoutes,
  sessionPortRoutes, // after permissions: a session with the sandbox off gets a port range, and the portal names who holds a port
  overlapRoutes, // after worktrees: it reads the worktrees table
  landingRoutes, // after overlapRoutes: the queue orders and warns by its forecast
  boardRoutes, // after landingRoutes: the board reads the base the queue lands on
  treeReviewRoutes, // after boardRoutes: the tree review reads the board, the forecast and the queue
  readyRoutes, // after boardRoutes: the branches ready to land read the board and the queue
  lanePlanRoutes, // after overlapRoutes: a lane's branch is read through its forecast's bases
  pictureRoutes, // after boardRoutes: a run's end makes its tree's board old
  reviewRoutes,
  prReviewRoutes, // after reviews: it reads the reviewer model they keep; after permissions: its sessions are read-only
  turnRoutes,
  switchRoutes,
  accountRoutes,
  safetyTrialRoutes, // after permissions: it reads the gate
  buildPinRoutes,
  sideRoutes,
  treeRoutes,
  attachmentRoutes,
  usageRoutes,
  contentRouteRoutes,
  errorRoutes,
  resourceRoutes,
  healthRoutes, // reads what the others set up: hooks, MCP servers, providers, the settings
  adminRoutes,
  observeRoutes, // after admin: it reads the settings admin loads
  automationRoutes,
  stewardRoutes, // after automation: its turns are delivered through the automation's inputs, and its notice is an alert
  rulingRoutes, // after automation: a ruling's use is a row of the activity list
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
  outsideRoutes, // the sessions another harness runs here, read-only in the list while they run
  resumeRoutes, // the same for a conversation on an ssh machine: its state, wait or resume now
  hookRoutes,
  surfaceRoutes, // Settings: skills, agent files, instruction files, the hooks file, plugins.toml
  pluginUnitRoutes, // after mcp and hooks: plugins installed as one unit start their servers
  runRoutes, // the command line: keel run, keel send
  secretRoutes, // the last gate: a call runs with its secrets put back, after every hook saw the placeholder
  egressRoutes, // after the gates: a shell call that runs carries its tag to the sandbox proxy
  auditRoutes, // after egress: the roots cover its rows
  pressRoutes,
  telemetryRoutes, // its tool timing starts after every gate
  experimentRoutes, // after telemetry: a turn's row reads the calls telemetry wrote
  lessonRoutes, // after experiments: a lesson's trial is one of them
  modelTrialRoutes, // after experiments: a trial is one
  settingTrialRoutes, // after experiments: a trial of a setting is one too
  timelineRoutes, // reads what the others record: events, activity, errors, telemetry
  lensRoutes, // the Conversation lens: reads the events' index, their turn marks, the landing queue and the approvals
  hoursRoutes, // where a tree's hours went: reads the spans, turns, agents and waits the others record
  ownerCompactRoutes, // the owner's switch for compaction by price: reads the ledger telemetry writes
  overviewRoutes, // every session's state, failure and spend as one answer
  stateRoutes, // last: it reads every module's cards and records to tell each session's state
  shellRoutes, // after state: it reads the board the state routes make
};
export const routeModules: RouteModule[] = Object.entries(modules).map(([name, m]) => Object.defineProperty(m, "name", { value: name }));
