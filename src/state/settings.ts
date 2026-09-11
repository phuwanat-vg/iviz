import type { SettingsValues } from "../viz/layers/Layer";
import type { Pose2D } from "../nav/NavController";

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
  nav: NavSettings;
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
  path: Pose2D[];
  mapTopic: string;
}

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
  nav: DEFAULT_NAV_SETTINGS,
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
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
    return { ...DEFAULT_SETTINGS, ...parsed, layers: Array.isArray(parsed.layers) ? parsed.layers : [], nav };
  } catch {
    return { ...DEFAULT_SETTINGS, nav: { ...DEFAULT_NAV_SETTINGS } };
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
