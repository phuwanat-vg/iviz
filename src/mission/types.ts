/**
 * TypeScript mirror of runner/mission_runner/schema/mission.schema.json and
 * sites.schema.json. Steps keep an index signature because every step type
 * carries its own parameters; typed views per step type are below.
 *
 * Ported from Mission/editor/src/model/types.ts. Changes made here: the
 * route-graph additions the schema already has but the web editor never grew —
 * `nav.follow_route` and a map's `edges`.
 */

export const MISSION_SCHEMA_ID = "mission/1" as const;
export const SITES_SCHEMA_ID = "sites/1" as const;

export const POLICIES = ["queue", "preempt", "preempt_latest", "reject_if_busy", "interrupt_and_resume"] as const;
export type Policy = (typeof POLICIES)[number];

export const INTERRUPT_POLICIES = ["interrupt_and_resume", "preempt"] as const;

export const INPUT_TYPES = ["site", "pose", "number", "string", "boolean", "json"] as const;
export type InputType = (typeof INPUT_TYPES)[number];

export interface InputDef {
  type: InputType;
  label?: string;
  description?: string;
  default?: unknown;
  required?: boolean;
}

/** A number, or `$name.path` / `${expression}` evaluated at run time. */
export type NumberOrExpr = number | string;

export interface PoseCoords {
  x: NumberOrExpr;
  y: NumberOrExpr;
  yaw_deg?: NumberOrExpr;
  frame?: string;
}
export interface PoseSite {
  site: string;
  yaw_deg?: NumberOrExpr;
}
/** Coordinates, a site reference, a site name or an expression string. */
export type Pose = PoseCoords | PoseSite | string;
/** A pose or `[x, y]` / `[x, y, yaw_deg]`. */
export type Point = Pose | number[];

export const BT_TEMPLATES = ["navigate_with_recovery", "navigate_through_poses_with_recovery"] as const;
export type BtTemplateName = (typeof BT_TEMPLATES)[number];
export const RECOVERIES = ["clear_costmap", "spin", "wait", "backup"] as const;
export type Recovery = (typeof RECOVERIES)[number];

export interface BtTemplate {
  template: BtTemplateName;
  retries?: number;
  recoveries?: Recovery[];
  replan_rate_hz?: number;
  spin_deg?: number;
  backup_m?: number;
  wait_s?: number;
  planner_id?: string;
  controller_id?: string;
}
export type BehaviorTree = string | BtTemplate;

export interface OnFail {
  retry?: number;
  retry_delay_s?: number;
  before_retry?: Step[];
  then?: "abort" | "continue";
}

export const STEP_TYPES = [
  "nav.wait_active", "nav.set_initial_pose", "nav.go_to_pose", "nav.go_through_poses",
  "nav.follow_route",
  "nav.follow_waypoints", "nav.follow_path", "nav.compute_path", "nav.compute_path_through_poses",
  "nav.smooth_path", "nav.spin", "nav.backup", "nav.drive_on_heading", "nav.change_map",
  "nav.clear_costmap", "nav.dock", "nav.undock", "nav.lifecycle", "nav.cancel",
  "ros.publish", "ros.call_service", "ros.call_action", "ros.set_param",
  "mqtt.publish", "http.request", "modbus.write", "gpio.write",
  "set", "if", "loop", "break", "wait", "wait_event", "ask_user", "log", "run_mission", "end",
] as const;
export type StepType = (typeof STEP_TYPES)[number];

/** Fields shared by every step (`stepBase` in the schema). */
export interface StepBase {
  id?: string;
  type: string;
  name?: string;
  enabled?: boolean;
  out?: string;
  timeout_s?: number;
  on_fail?: OnFail;
}

/** A step of any type. Type-specific parameters live next to the base fields. */
export interface Step extends StepBase {
  [param: string]: unknown;
}

// ---- typed views per step type (used by codegen and the inspector) --------

export interface GoToPoseStep extends StepBase { type: "nav.go_to_pose"; pose: Pose; behavior_tree?: BehaviorTree }
export interface SetInitialPoseStep extends StepBase { type: "nav.set_initial_pose"; pose: Pose }
export interface GoThroughPosesStep extends StepBase { type: "nav.go_through_poses"; poses: Pose[]; behavior_tree?: BehaviorTree }
export interface FollowWaypointsStep extends StepBase { type: "nav.follow_waypoints"; poses: Pose[] }
export interface FollowRouteStep extends StepBase {
  type: "nav.follow_route";
  /** Destination site, or an expression that resolves to one. */
  to: string;
  /** Start site; defaults to the graph node nearest the robot. */
  from?: string;
  on_no_route?: "fail" | "direct";
  apply_speed_limits?: boolean;
  behavior_tree?: BehaviorTree;
}
export interface FollowPathStep extends StepBase {
  type: "nav.follow_path"; points?: Point[]; path?: unknown; from_robot?: boolean; spacing_m?: number; controller_id?: string; goal_checker_id?: string;
}
export interface ComputePathStep extends StepBase { type: "nav.compute_path"; goal: Pose; start?: Pose; planner_id?: string; use_start?: boolean }
export interface ComputePathThroughPosesStep extends StepBase { type: "nav.compute_path_through_poses"; goals: Pose[]; start?: Pose; planner_id?: string; use_start?: boolean }
export interface SmoothPathStep extends StepBase { type: "nav.smooth_path"; path: unknown; smoother_id?: string; max_duration_s?: number; check_collision?: boolean }
export interface SpinStep extends StepBase { type: "nav.spin"; angle_deg: NumberOrExpr; time_allowance_s?: number }
export interface BackupStep extends StepBase { type: "nav.backup"; distance_m: NumberOrExpr; speed_mps?: NumberOrExpr; time_allowance_s?: number }
export interface DriveOnHeadingStep extends StepBase { type: "nav.drive_on_heading"; distance_m: NumberOrExpr; speed_mps?: NumberOrExpr; time_allowance_s?: number }
export interface ChangeMapStep extends StepBase { type: "nav.change_map"; map: string }
export interface ClearCostmapStep extends StepBase { type: "nav.clear_costmap"; which?: "all" | "local" | "global" }
export interface DockStep extends StepBase { type: "nav.dock"; dock_id?: string; dock_pose?: Pose; dock_type?: string; navigate_to_staging?: boolean }
export interface UndockStep extends StepBase { type: "nav.undock"; dock_type?: string }
export interface LifecycleStep extends StepBase { type: "nav.lifecycle"; action: "startup" | "shutdown" }
export interface RosPublishStep extends StepBase { type: "ros.publish"; topic: string; msg_type: string; message?: Record<string, unknown> }
export interface RosCallServiceStep extends StepBase { type: "ros.call_service"; service: string; srv_type: string; request?: Record<string, unknown> }
export interface RosCallActionStep extends StepBase { type: "ros.call_action"; action: string; action_type: string; goal?: Record<string, unknown> }
export interface RosSetParamStep extends StepBase { type: "ros.set_param"; node: string; params: Record<string, unknown> }
export interface MqttPublishStep extends StepBase { type: "mqtt.publish"; connector: string; topic: string; payload?: unknown; qos?: 0 | 1 | 2; retain?: boolean }
export interface HttpRequestStep extends StepBase { type: "http.request"; method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; url: string; headers?: Record<string, unknown>; body?: unknown }
export interface ModbusWriteStep extends StepBase { type: "modbus.write"; connector: string; kind?: "coil" | "register"; address: number; value: unknown }
export interface GpioWriteStep extends StepBase { type: "gpio.write"; pin: number; value: unknown }
export interface SetStep extends StepBase { type: "set"; var: string; value: unknown }
export interface IfStep extends StepBase { type: "if"; condition: string; then: Step[]; else?: Step[] }
export interface LoopStep extends StepBase { type: "loop"; count?: number | string; while?: string; body: Step[] }
export interface WaitStep extends StepBase { type: "wait"; seconds: number | string }
export interface WaitEventStep extends StepBase { type: "wait_event"; source: EventSource; on_timeout?: "abort" | "continue" }
export interface AskUserStep extends StepBase { type: "ask_user"; text: string; options?: string[]; default?: string }
export interface LogStep extends StepBase { type: "log"; text: string; level?: "debug" | "info" | "warn" | "error" }
export interface RunMissionStep extends StepBase { type: "run_mission"; mission: string; inputs?: Record<string, unknown> }
export interface EndStep extends StepBase { type: "end"; result?: "success" | "failed"; message?: string }

// ---- triggers --------------------------------------------------------------

export const EVENT_TYPES = [
  "ros.topic", "mqtt.subscribe", "http.webhook", "timer.cron", "timer.interval", "timer.boot", "gpio.input", "modbus.poll", "mission.done",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface EventSource {
  type: string;
  when?: string;
  edge?: "any" | "rising";
  debounce_s?: number;
  topic?: string;
  msg_type?: string;
  connector?: string;
  path?: string;
  cron?: string;
  seconds?: number;
  delay_s?: number;
  pin?: number;
  gpio_edge?: "rising" | "falling" | "both";
  pull?: "up" | "down" | "none";
  bounce_s?: number;
  kind?: "coil" | "discrete" | "register";
  address?: number;
  poll_s?: number;
  mission?: string;
  result?: "success" | "failed" | "any";
  [param: string]: unknown;
}

export interface Trigger extends EventSource {
  id?: string;
  name?: string;
  enabled?: boolean;
  policy?: Policy;
  priority?: number;
  set?: Record<string, string>;
}

export interface Interrupt extends Trigger {
  run: string;
}

export interface Mission {
  schema: typeof MISSION_SCHEMA_ID;
  name: string;
  title?: string;
  description?: string;
  version?: number;
  policy?: Policy;
  priority?: number;
  inputs?: Record<string, InputDef>;
  vars?: Record<string, unknown>;
  triggers?: Trigger[];
  interrupts?: Interrupt[];
  flow: Step[];
  on_abort?: Step[];
}

// ---- sites -----------------------------------------------------------------

export const SITE_KINDS = ["station", "dock", "waypoint", "home"] as const;
export type SiteKind = (typeof SITE_KINDS)[number];

export interface Site {
  x: number;
  y: number;
  yaw_deg?: number;
  kind?: SiteKind;
  dock_id?: string;
  dock_type?: string;
  notes?: string;
}

export const ZONE_KINDS = ["keepout", "speed_limit", "preferred", "work"] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];

/** A named polygon on a map: keep-out, speed limit, or a plain named area. */
export interface Zone {
  kind?: ZoneKind;
  /** Closed polygon in map coordinates, at least three [x, y] points. */
  polygon: [number, number][];
  /** speed_limit zones: the cap inside the polygon. */
  speed_mps?: number;
  /** Optional #rrggbb override for the editor. */
  color?: string;
  notes?: string;
}

/**
 * One lane of the route graph. Nodes are the map's sites; `nav.follow_route`
 * only ever drives along these.
 */
export interface Edge {
  from: string;
  to: string;
  /** false makes it one-way, from -> to. Absent means bidirectional. */
  bidirectional?: boolean;
  /** Cap while driving this lane. */
  speed_mps?: number;
  /** Temporarily closed; the planner routes around it. */
  blocked?: boolean;
  /** Multiplies the length when choosing a route (1 = neutral). */
  cost?: number;
  notes?: string;
}

export interface MapDef {
  file?: string;
  frame?: string;
  sites?: Record<string, Site>;
  edges?: Edge[];
  zones?: Record<string, Zone>;
}

export interface SitesDoc {
  schema: typeof SITES_SCHEMA_ID;
  default_map?: string;
  maps: Record<string, MapDef>;
}

// ---- validation findings ---------------------------------------------------

export type PathSegment = string | number;
export type Path = PathSegment[];

export interface Finding {
  level: "error" | "warning";
  path: Path;
  stepId?: string;
  message: string;
}

export interface ValidationResult {
  errors: Finding[];
  warnings: Finding[];
}

export const MISSION_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
export const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const STEP_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const RESERVED_NAMES = new Set(["last", "payload", "robot", "mission", "run_id", "current_map", "sites", "inputs", "True", "False", "None"]);
export const GLOBAL_MISSION = "global";

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function emptyMission(name = "new_mission"): Mission {
  return { schema: MISSION_SCHEMA_ID, name, title: "New mission", flow: [] };
}

export function emptySites(): SitesDoc {
  return { schema: SITES_SCHEMA_ID, maps: {} };
}
