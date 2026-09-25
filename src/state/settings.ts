import type { SettingsValues } from "../viz/layers/Layer";
import type { Pose2D } from "../nav/NavController";
import type { ExportFormat, PathVertex, WaypointFormat } from "../nav/pathShape";

export interface PersistedLayer {
  topic: string;
  schemaName: string;
  visible: boolean;
  settings: SettingsValues;
}

export interface AppSettings {
  url: string;
  autoConnect: boolean;
  fixedFrame: string; // "" = auto
  mode: "2d" | "3d";
  followFrame: string;
  showGrid: boolean;
  showTf: boolean;
  tfSettings: SettingsValues;
  layers: PersistedLayer[];
  goalTopic: string;
  initialPoseTopic: string;
  poseFrame: string; // "" = fixed frame
  /** Route mode open, and the mission it had open. */
  routeOpen: boolean;
  routeMission: string;
  /** Navigation panel shown on the right. */
  navOpen: boolean;
  /** List topics that nothing publishes right now. */
  showInactiveTopics: boolean;
  /** Which tab the right-hand panel shows. */
  dockTab: DockTab;
  /** Service calls pinned as buttons on the dashboard. */
  servicePins: ServicePin[];
  /** The ask/answer topics iViz shares with any other answerer. */
  ask: AskSettings;
  /** Which parts of the Dashboard's Missions section are open. */
  missions: MissionsSettings;
  /** Driving by hand from the Teleop tab. */
  teleop: TeleopSettings;
  nav: NavSettings;
}

export interface MissionsSettings {
  listOpen: boolean;
  historyOpen: boolean;
}

export const DEFAULT_MISSIONS_SETTINGS: MissionsSettings = {
  listOpen: true,
  historyOpen: true,
};

export type DockTab = "nav" | "services" | "dashboard" | "params" | "teleop";

export interface TeleopSettings {
  /** Where the velocity goes, usually /cmd_vel. */
  topic: string;
  /** Auto takes the topic's type when the robot already has it, else Twist. */
  type: "auto" | "twist" | "stamped";
  /** header.frame_id of a TwistStamped. */
  frameId: string;
  /** header.stamp of a TwistStamped: zero lets the receiver use its own clock. */
  stamp: "zero" | "pc";
  /** Speeds used while a direction is held. */
  linear: number;
  angular: number;
  /** Top of the sliders. */
  maxLinear: number;
  maxAngular: number;
  rateHz: number;
  /** Keys drive the robot while the Teleop tab is open. */
  keyboard: boolean;
}

export const DEFAULT_TELEOP: TeleopSettings = {
  topic: "/cmd_vel",
  type: "auto",
  frameId: "base_link",
  stamp: "zero",
  linear: 0.2,
  angular: 0.5,
  maxLinear: 1.0,
  maxAngular: 2.0,
  rateHz: 10,
  keyboard: false,
};

/**
 * Where requests for a human decision arrive and where answers go. Any node
 * can use the same two topics, so iViz can be replaced by an adapter later.
 */
export interface AskSettings {
  requestTopic: string;
  answerTopic: string;
}

export const DEFAULT_ASK_SETTINGS: AskSettings = {
  requestTopic: "/iviz/request",
  answerTopic: "/iviz/answer",
};

/** A service call saved as a dashboard button. */
export interface ServicePin {
  label: string;
  service: string;
  type: string;
  /** The request as JSON text, exactly as it was filled in. */
  request: string;
}

export interface NavSettings {
  /** Nav2 action names. */
  navigateToPose: string;
  followWaypoints: string;
  navigateThroughPoses: string;
  followPath: string;
  /** Robot base frame, used to resume a path from where the robot stands. */
  robotFrame: string;
  /** Plugin names for FollowPath; empty lets controller_server use its only one. */
  controllerId: string;
  goalCheckerId: string;
  progressCheckerId: string;
  /** Bumped when saved defaults need migrating. */
  idsRevision: number;
  waypointMode: "waypoints" | "through";
  loop: boolean;
  /** Frame the drafted waypoints and path were placed in. */
  draftFrame: string;
  waypoints: Pose2D[];
  /** The drawn path: clicked points, each with the bend of the segment after it. */
  path: PathVertex[];
  /** How the path is copied out as coordinates. */
  pathExport: PathExportSettings;
  /** How the waypoints are copied out as coordinates. */
  waypointExport: WaypointExportSettings;
  mapTopic: string;
}

export interface PathExportSettings {
  /** Largest distance between two copied points, in metres. */
  step: number;
  format: ExportFormat;
  /** Begin the list with `(rx, ry)`, the robot position read in the script. */
  robotStart: boolean;
  decimals: number;
}

export const DEFAULT_PATH_EXPORT: PathExportSettings = { step: 0.2, format: "xy", robotStart: true, decimals: 3 };

export interface WaypointExportSettings {
  format: WaypointFormat;
  decimals: number;
}

export const DEFAULT_WAYPOINT_EXPORT: WaypointExportSettings = { format: "xyyaw", decimals: 3 };

export const DEFAULT_NAV_SETTINGS: NavSettings = {
  navigateToPose: "/navigate_to_pose",
  followWaypoints: "/follow_waypoints",
  navigateThroughPoses: "/navigate_through_poses",
  followPath: "/follow_path",
  robotFrame: "base_link",
  // Empty: controller_server uses the only plugin it loaded, whatever its name.
  controllerId: "",
  goalCheckerId: "",
  progressCheckerId: "",
  idsRevision: 2,
  waypointMode: "waypoints",
  loop: false,
  draftFrame: "",
  waypoints: [],
  path: [],
  pathExport: DEFAULT_PATH_EXPORT,
  waypointExport: DEFAULT_WAYPOINT_EXPORT,
  mapTopic: "/map",
};

const KEY = "iviz.settings.v1";

export const DEFAULT_SETTINGS: AppSettings = {
  url: "ws://localhost:8765",
  autoConnect: false,
  fixedFrame: "",
  mode: "3d",
  followFrame: "",
  showGrid: true,
  showTf: true,
  tfSettings: {},
  layers: [],
  goalTopic: "/goal_pose",
  initialPoseTopic: "/initialpose",
  poseFrame: "",
  routeOpen: false,
  routeMission: "",
  navOpen: true,
  showInactiveTopics: false,
  dockTab: "nav",
  servicePins: [],
  ask: DEFAULT_ASK_SETTINGS,
  missions: DEFAULT_MISSIONS_SETTINGS,
  teleop: DEFAULT_TELEOP,
  nav: DEFAULT_NAV_SETTINGS,
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, missions: { ...DEFAULT_MISSIONS_SETTINGS }, teleop: { ...DEFAULT_TELEOP } };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const nav = { ...DEFAULT_NAV_SETTINGS, ...(parsed.nav ?? {}) };
    // 0.2.0 and 0.2.1 saved nav2_bringup's example plugin names as defaults,
    // which fail on robots that name them differently. Blank them once, so
    // controller_server picks the plugin it has.
    if ((parsed.nav?.idsRevision ?? 1) < 2) {
      if (nav.controllerId === "FollowPath") nav.controllerId = "";
      if (nav.goalCheckerId === "general_goal_checker") nav.goalCheckerId = "";
      if (nav.progressCheckerId === "progress_checker") nav.progressCheckerId = "";
    }
    nav.idsRevision = 2;
    if (!Array.isArray(nav.waypoints)) nav.waypoints = [];
    if (!Array.isArray(nav.path)) nav.path = [];
    nav.pathExport = { ...DEFAULT_PATH_EXPORT, ...(parsed.nav?.pathExport ?? {}) };
    nav.waypointExport = { ...DEFAULT_WAYPOINT_EXPORT, ...(parsed.nav?.waypointExport ?? {}) };
    if (!Array.isArray(parsed.servicePins)) parsed.servicePins = [];
    const ask = { ...DEFAULT_ASK_SETTINGS, ...(parsed.ask ?? {}) };
    const missions = { ...DEFAULT_MISSIONS_SETTINGS, ...(parsed.missions ?? {}) };
    const teleop = { ...DEFAULT_TELEOP, ...(parsed.teleop ?? {}) };
    return { ...DEFAULT_SETTINGS, ...parsed, layers: Array.isArray(parsed.layers) ? parsed.layers : [], ask, missions, teleop, nav };
  } catch {
    return { ...DEFAULT_SETTINGS, missions: { ...DEFAULT_MISSIONS_SETTINGS }, teleop: { ...DEFAULT_TELEOP }, nav: { ...DEFAULT_NAV_SETTINGS } };
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
export function saveSettings(s: AppSettings): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* storage unavailable */
    }
  }, 300);
}
