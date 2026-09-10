import type { SettingsValues } from "../viz/layers/Layer";

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
}

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
};

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed, layers: Array.isArray(parsed.layers) ? parsed.layers : [] };
  } catch {
    return { ...DEFAULT_SETTINGS };
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
