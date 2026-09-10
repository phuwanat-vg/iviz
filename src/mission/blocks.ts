/**
 * Step and trigger registries: labels, groups, icons, parameter definitions
 * and one-line summaries. Every step type and event-source type of
 * mission.schema.json has an entry here.
 *
 * Ported from Mission/editor/src/model/blocks.ts; the `nav.follow_route`
 * block (a stop) was added here.
 */

import type { IconName } from "../ui/icons";
import type { EventSource, Mission, Step, Trigger } from "./types";
import { BT_TEMPLATES, EVENT_TYPES, STEP_TYPES, isRecord } from "./types";
import { cronToWords, hasExpression } from "./expressions";

export type ParamKind =
  | "number"
  | "integer"
  | "string"
  | "text"
  | "boolean"
  | "select"
  | "expression"
  | "value"
  | "pose"
  | "poses"
  | "points"
  | "site"
  | "map"
  | "connector"
  | "json"
  | "steps"
  | "behavior_tree"
  | "event_source"
  | "options";

export interface ParamDef {
  key: string;
  label: string;
  kind: ParamKind;
  options?: string[];
  default?: unknown;
  required?: boolean;
  help?: string;
  advanced?: boolean;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  /** number/integer: a `$ref` / `${expr}` string is also accepted (schema `numberOrExpr`). */
  allowExpr?: boolean;
}

export type BlockGroup = "Navigate" | "Behaviors" | "Map & costmap" | "Logic" | "Wait & ask" | "ROS" | "Connectors";
export const BLOCK_GROUPS: readonly BlockGroup[] = ["Navigate", "Behaviors", "Map & costmap", "Logic", "Wait & ask", "ROS", "Connectors"];

export interface SummaryCtx {
  mission: Mission;
}

export interface BlockDef {
  type: string;
  label: string;
  group: BlockGroup;
  icon: IconName;
  help: string;
  params: ParamDef[];
  /** One-line subtitle, e.g. "go_to_pose · Rack3 · retry 2". */
  summary(step: Step, ctx: SummaryCtx): string;
  /** Keys holding nested steps: ["then", "else"], ["body"]. */
  containers?: string[];
  /** Key into /api/capabilities.steps (defaults to the type). */
  capability?: string;
}

export interface TriggerDef {
  type: string;
  label: string;
  icon: IconName;
  help: string;
  params: ParamDef[];
  summary(spec: EventSource): string;
  capability?: string;
}

// ---- formatting helpers ---------------------------------------------------------

const SEP = " · ";

export function shortType(type: string): string {
  const i = type.indexOf(".");
  return i >= 0 ? type.slice(i + 1) : type;
}

export function fmtNum(v: unknown): string {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3)));
  if (typeof v === "string") return v;
  return String(v ?? "");
}

/** Short human text for a pose spec. */
export function poseText(pose: unknown): string {
  if (typeof pose === "string") return pose === "" ? "(no site)" : pose;
  if (Array.isArray(pose)) return `(${pose.map(fmtNum).join(", ")})`;
  if (isRecord(pose)) {
    if (typeof pose.site === "string") return pose.site === "" ? "(no site)" : pose.site + (pose.yaw_deg !== undefined ? ` @${fmtNum(pose.yaw_deg)}°` : "");
    if ("x" in pose || "y" in pose) {
      const yaw = pose.yaw_deg !== undefined ? `, ${fmtNum(pose.yaw_deg)}°` : "";
      const frame = typeof pose.frame === "string" && pose.frame !== "map" ? ` ${pose.frame}` : "";
      return `(${fmtNum(pose.x)}, ${fmtNum(pose.y)}${yaw})${frame}`;
    }
  }
  return "(no pose)";
}

export function posesText(list: unknown, noun = "poses"): string {
  if (!Array.isArray(list) || list.length === 0) return `no ${noun}`;
  const names = list.map(poseText);
  const joined = names.join(", ");
  if (joined.length <= 40) return joined;
  return `${list.length} ${noun}`;
}

function valueText(v: unknown): string {
  if (v === undefined) return "";
  if (typeof v === "string") return v.length > 40 ? `${v.slice(0, 37)}…` : v;
  const s = JSON.stringify(v) ?? "";
  return s.length > 40 ? `${s.slice(0, 37)}…` : s;
}

function onFailText(step: Step): string[] {
  const parts: string[] = [];
  const f = step.on_fail;
  if (f && isRecord(f)) {
    if (typeof f.retry === "number" && f.retry > 0) {
      let s = `retry ${f.retry}`;
      const before = Array.isArray(f.before_retry) ? (f.before_retry as Step[]) : [];
      if (before.length === 1 && before[0]) s += `, ${shortType(String(before[0].type)).replace(/_/g, " ")}`;
      else if (before.length > 1) s += `, ${before.length} steps before retry`;
      parts.push(s);
    }
    if (f.then === "continue") parts.push("continue on fail");
  }
  if (typeof step.timeout_s === "number") parts.push(`timeout ${fmtNum(step.timeout_s)} s`);
  return parts;
}

function summarize(step: Step, ...details: (string | undefined | false)[]): string {
  return [shortType(step.type), ...details.filter((d): d is string => typeof d === "string" && d !== ""), ...onFailText(step)].join(SEP);
}

// ---- shared parameter definitions -----------------------------------------------

const BT_PARAM: ParamDef = { key: "behavior_tree", label: "Behavior tree", kind: "behavior_tree", help: "XML file on the robot or a template with recoveries.", advanced: true };
const TIME_ALLOWANCE: ParamDef = { key: "time_allowance_s", label: "Time allowance (s)", kind: "number", default: 10, min: 0, advanced: true };
const START_POSE: ParamDef = { key: "start", label: "Start", kind: "pose", help: "Optional start pose; used only when 'Use start' is on.", advanced: true };
const PLANNER_ID: ParamDef = { key: "planner_id", label: "Planner id", kind: "string", default: "", placeholder: "GridBased", advanced: true };
const USE_START: ParamDef = { key: "use_start", label: "Use start", kind: "boolean", default: false, advanced: true };

// ---- step registry ----------------------------------------------------------------

const BLOCKS: BlockDef[] = [
  // Navigate
  {
    type: "nav.go_to_pose", label: "Go to pose", group: "Navigate", icon: "navigation",
    help: "Drive to one pose with Nav2 (goToPose). The result value is the final feedback.",
    params: [{ key: "pose", label: "Pose", kind: "pose", required: true }, BT_PARAM],
    summary: (s) => summarize(s, poseText(s.pose)),
  },
  {
    type: "nav.go_through_poses", label: "Go through poses", group: "Navigate", icon: "route",
    help: "Drive through several poses without stopping (goThroughPoses).",
    params: [{ key: "poses", label: "Poses", kind: "poses", required: true }, BT_PARAM],
    summary: (s) => summarize(s, posesText(s.poses)),
  },
  {
    type: "nav.follow_route", label: "Drive to stop", group: "Navigate", icon: "route",
    help: "Drive to a site along the lanes drawn in the route graph. This is what a stop compiles to.",
    params: [
      { key: "to", label: "To", kind: "site", required: true, help: "Destination site, or an expression that resolves to one." },
      { key: "from", label: "From", kind: "site", help: "Start site. Defaults to the graph node nearest the robot.", advanced: true },
      { key: "on_no_route", label: "When there is no route", kind: "select", options: ["fail", "direct"], default: "fail", advanced: true },
      { key: "apply_speed_limits", label: "Apply lane speed limits", kind: "boolean", default: false, advanced: true },
      BT_PARAM,
    ],
    summary: (s) => summarize(s, typeof s.to === "string" && s.to !== "" ? s.to : "(no destination)"),
  },
  {
    type: "nav.follow_waypoints", label: "Follow waypoints", group: "Navigate", icon: "waypoints",
    help: "Visit each waypoint in turn (followWaypoints). value.missed lists indexes that failed.",
    params: [{ key: "poses", label: "Waypoints", kind: "poses", required: true }],
    summary: (s) => summarize(s, posesText(s.poses, "waypoints")),
  },
  {
    type: "nav.follow_path", label: "Follow path", group: "Navigate", icon: "spline",
    help: "Follow a polyline built from points, or a path value from compute path / smooth path (followPath).",
    params: [
      { key: "points", label: "Points", kind: "points", help: "Polyline; ignored when Path is set. Paste 'x, y' lines to add many." },
      { key: "path", label: "Path", kind: "value", placeholder: "$plan.value", help: "Path value from nav.compute_path or nav.smooth_path." },
      { key: "from_robot", label: "Start from robot", kind: "boolean", default: true, help: "Prepend the robot's current position to the points." },
      { key: "spacing_m", label: "Spacing (m)", kind: "number", default: 0.05, min: 0.001, step: 0.01, advanced: true },
      { key: "controller_id", label: "Controller id", kind: "string", default: "", placeholder: "FollowPath", advanced: true },
      { key: "goal_checker_id", label: "Goal checker id", kind: "string", default: "", advanced: true },
    ],
    summary: (s) => summarize(s, typeof s.path === "string" && s.path !== "" ? `path ${s.path}` : posesText(s.points, "points")),
  },
  {
    type: "nav.compute_path", label: "Compute path", group: "Navigate", icon: "compass",
    help: "Plan a path to a goal without driving (getPath). Store it with Out and use it in Follow path or Smooth path.",
    params: [{ key: "goal", label: "Goal", kind: "pose", required: true }, START_POSE, PLANNER_ID, USE_START],
    summary: (s) => summarize(s, poseText(s.goal), typeof s.out === "string" ? `→ ${s.out}` : undefined),
  },
  {
    type: "nav.compute_path_through_poses", label: "Compute path through poses", group: "Navigate", icon: "compass",
    help: "Plan a path through several goals (getPathThroughPoses).",
    params: [{ key: "goals", label: "Goals", kind: "poses", required: true }, START_POSE, PLANNER_ID, USE_START],
    summary: (s) => summarize(s, posesText(s.goals, "goals"), typeof s.out === "string" ? `→ ${s.out}` : undefined),
  },
  {
    type: "nav.smooth_path", label: "Smooth path", group: "Navigate", icon: "spline",
    help: "Smooth a planned path (smoothPath).",
    params: [
      { key: "path", label: "Path", kind: "value", required: true, placeholder: "$plan.value" },
      { key: "smoother_id", label: "Smoother id", kind: "string", default: "", advanced: true },
      { key: "max_duration_s", label: "Max duration (s)", kind: "number", default: 2, min: 0, advanced: true },
      { key: "check_collision", label: "Check collision", kind: "boolean", default: false, advanced: true },
    ],
    summary: (s) => summarize(s, valueText(s.path), typeof s.out === "string" ? `→ ${s.out}` : undefined),
  },
  {
    type: "nav.wait_active", label: "Wait for Nav2", group: "Navigate", icon: "hourglass",
    help: "Block until Nav2 lifecycle nodes are active (waitUntilNav2Active). Set Timeout in Advanced to give up.",
    params: [],
    summary: (s) => summarize(s),
  },
  {
    type: "nav.set_initial_pose", label: "Set initial pose", group: "Navigate", icon: "locate",
    help: "Publish the robot's initial pose on /initialpose (AMCL).",
    params: [{ key: "pose", label: "Pose", kind: "pose", required: true }],
    summary: (s) => summarize(s, poseText(s.pose)),
  },
  {
    type: "nav.cancel", label: "Cancel navigation", group: "Navigate", icon: "xCircle",
    help: "Cancel any running Nav2 task.",
    params: [],
    summary: (s) => summarize(s),
  },
  // Behaviors
  {
    type: "nav.spin", label: "Spin", group: "Behaviors", icon: "rotate",
    help: "Rotate in place by an angle (spin).",
    params: [{ key: "angle_deg", label: "Angle (deg)", kind: "number", required: true, allowExpr: true, default: 90 }, TIME_ALLOWANCE],
    summary: (s) => summarize(s, `${fmtNum(s.angle_deg)}°`),
  },
  {
    type: "nav.backup", label: "Back up", group: "Behaviors", icon: "arrowLeft",
    help: "Drive backwards a distance (backup).",
    params: [
      { key: "distance_m", label: "Distance (m)", kind: "number", required: true, allowExpr: true, default: 0.3, min: 0, step: 0.05 },
      { key: "speed_mps", label: "Speed (m/s)", kind: "number", default: 0.15, allowExpr: true, min: 0, step: 0.05 },
      TIME_ALLOWANCE,
    ],
    summary: (s) => summarize(s, `${fmtNum(s.distance_m)} m`),
  },
  {
    type: "nav.drive_on_heading", label: "Drive on heading", group: "Behaviors", icon: "arrowRight",
    help: "Drive straight ahead a distance (driveOnHeading).",
    params: [
      { key: "distance_m", label: "Distance (m)", kind: "number", required: true, allowExpr: true, default: 0.5, min: 0, step: 0.05 },
      { key: "speed_mps", label: "Speed (m/s)", kind: "number", default: 0.15, allowExpr: true, min: 0, step: 0.05 },
      TIME_ALLOWANCE,
    ],
    summary: (s) => summarize(s, `${fmtNum(s.distance_m)} m`),
  },
  {
    type: "nav.dock", label: "Dock", group: "Behaviors", icon: "anchor",
    help: "Dock at a known dock id or a dock pose (Nav2 docking server).",
    params: [
      { key: "dock_id", label: "Dock id", kind: "string", placeholder: "home_dock", help: "Dock from the docking server configuration. Leave empty to use Dock pose." },
      { key: "dock_pose", label: "Dock pose", kind: "pose", advanced: true },
      { key: "dock_type", label: "Dock type", kind: "string", default: "", advanced: true },
      { key: "navigate_to_staging", label: "Navigate to staging", kind: "boolean", default: true, advanced: true },
    ],
    summary: (s) => summarize(s, typeof s.dock_id === "string" && s.dock_id !== "" ? s.dock_id : s.dock_pose !== undefined ? poseText(s.dock_pose) : "(no dock)"),
  },
  {
    type: "nav.undock", label: "Undock", group: "Behaviors", icon: "anchorOff",
    help: "Leave the dock (undockRobot).",
    params: [{ key: "dock_type", label: "Dock type", kind: "string", default: "", advanced: true }],
    summary: (s) => summarize(s),
  },
  // Map & costmap
  {
    type: "nav.change_map", label: "Change map", group: "Map & costmap", icon: "map",
    help: "Switch the Nav2 map and the active site set (changeMap).",
    params: [{ key: "map", label: "Map", kind: "map", required: true, help: "Map name from sites.json or an absolute .yaml path." }],
    summary: (s) => summarize(s, typeof s.map === "string" ? s.map : ""),
  },
  {
    type: "nav.clear_costmap", label: "Clear costmap", group: "Map & costmap", icon: "eraser",
    help: "Clear the local and/or global costmap.",
    params: [{ key: "which", label: "Which", kind: "select", options: ["all", "local", "global"], default: "all" }],
    summary: (s) => summarize(s, typeof s.which === "string" && s.which !== "all" ? s.which : undefined),
  },
  {
    type: "nav.lifecycle", label: "Nav2 lifecycle", group: "Map & costmap", icon: "power",
    help: "Start up or shut down the Nav2 lifecycle nodes.",
    params: [{ key: "action", label: "Action", kind: "select", options: ["startup", "shutdown"], required: true, default: "startup" }],
    summary: (s) => summarize(s, typeof s.action === "string" ? s.action : ""),
  },
  // Logic
  {
    type: "set", label: "Set variable", group: "Logic", icon: "variable",
    help: "Assign a value or expression result to a variable.",
    params: [
      { key: "var", label: "Variable", kind: "string", required: true, placeholder: "rounds" },
      { key: "value", label: "Value", kind: "value", required: true, placeholder: "${rounds + 1}" },
    ],
    summary: (s) => summarize(s, `${typeof s.var === "string" ? s.var : "?"} = ${valueText(s.value)}`),
  },
  {
    type: "if", label: "If", group: "Logic", icon: "gitBranch",
    help: "Run the 'then' steps when the condition is true, otherwise the 'else' steps.",
    params: [
      { key: "condition", label: "Condition", kind: "expression", required: true, placeholder: "answer.value == 'No'" },
      { key: "then", label: "Then", kind: "steps", required: true },
      { key: "else", label: "Else", kind: "steps" },
    ],
    containers: ["then", "else"],
    summary: (s) => summarize(s, typeof s.condition === "string" ? s.condition : ""),
  },
  {
    type: "loop", label: "Loop", group: "Logic", icon: "repeat",
    help: "Repeat the body a number of times, while a condition holds, or forever (use Break to exit).",
    params: [
      { key: "count", label: "Count", kind: "value", placeholder: "3 or $rounds", help: "Number of iterations. Leave empty for a while-loop or an endless loop." },
      { key: "while", label: "While", kind: "expression", placeholder: "battery > 0.3", help: "Repeat while this is true. Not together with Count." },
      { key: "body", label: "Body", kind: "steps", required: true },
    ],
    containers: ["body"],
    summary: (s) => summarize(s, s.count !== undefined ? `x ${valueText(s.count)}` : typeof s.while === "string" && s.while !== "" ? `while ${s.while}` : "forever"),
  },
  {
    type: "break", label: "Break", group: "Logic", icon: "logOut",
    help: "Exit the innermost loop.",
    params: [],
    summary: (s) => summarize(s),
  },
  {
    type: "end", label: "End mission", group: "Logic", icon: "octagon",
    help: "End the run early with a result.",
    params: [
      { key: "result", label: "Result", kind: "select", options: ["success", "failed"], default: "success" },
      { key: "message", label: "Message", kind: "string" },
    ],
    summary: (s) => summarize(s, typeof s.result === "string" ? s.result : "success", typeof s.message === "string" ? s.message : undefined),
  },
  {
    type: "log", label: "Log", group: "Logic", icon: "terminal",
    help: "Write a line to the run log. Text may interpolate ${expressions}.",
    params: [
      { key: "text", label: "Text", kind: "text", required: true, placeholder: "Lap ${i} done" },
      { key: "level", label: "Level", kind: "select", options: ["debug", "info", "warn", "error"], default: "info" },
    ],
    summary: (s) => summarize(s, typeof s.level === "string" && s.level !== "info" ? s.level : undefined, valueText(s.text)),
  },
  {
    type: "run_mission", label: "Run mission", group: "Logic", icon: "playCircle",
    help: "Run another mission inline and continue when it finishes.",
    params: [
      { key: "mission", label: "Mission", kind: "string", required: true, placeholder: "go_charge" },
      { key: "inputs", label: "Inputs", kind: "json", help: "Inputs for the sub-mission; values may use expressions." },
    ],
    summary: (s) => summarize(s, typeof s.mission === "string" ? s.mission : ""),
  },
  // Wait & ask
  {
    type: "wait", label: "Wait", group: "Wait & ask", icon: "clock",
    help: "Pause for a number of seconds.",
    params: [{ key: "seconds", label: "Seconds", kind: "number", required: true, allowExpr: true, default: 1, min: 0 }],
    summary: (s) => summarize(s, `${fmtNum(s.seconds)} s`),
  },
  {
    type: "wait_event", label: "Wait for event", group: "Wait & ask", icon: "radio",
    help: "Wait until an event source fires (PLC coil, MQTT message, topic, webhook...). The result value is the payload.",
    params: [
      { key: "source", label: "Event", kind: "event_source", required: true },
      { key: "on_timeout", label: "On timeout", kind: "select", options: ["abort", "continue"], default: "abort" },
    ],
    summary: (s) => summarize(s, isRecord(s.source) ? triggerSummary(s.source as EventSource) : "(no event)"),
  },
  {
    type: "ask_user", label: "Ask user", group: "Wait & ask", icon: "message",
    help: "Show a question on every connected UI and wait for an answer. Without a timeout the run waits forever.",
    params: [
      { key: "text", label: "Text", kind: "text", required: true, placeholder: "Do another round?" },
      { key: "options", label: "Options", kind: "options", default: ["Continue", "Stop"] },
      { key: "default", label: "Default", kind: "string", help: "Chosen automatically when nobody answers before the timeout." },
    ],
    summary: (s) => summarize(s, valueText(s.text), Array.isArray(s.options) ? `[${s.options.map(String).join(" / ")}]` : undefined),
  },
  // ROS
  {
    type: "ros.publish", label: "Publish topic", group: "ROS", icon: "send",
    help: "Publish one message on a topic.",
    params: [
      { key: "topic", label: "Topic", kind: "string", required: true, placeholder: "/mission/notice" },
      { key: "msg_type", label: "Message type", kind: "string", required: true, placeholder: "std_msgs/msg/String" },
      { key: "message", label: "Message", kind: "json", help: "Fields of the message as JSON; values may use expressions." },
    ],
    summary: (s) => summarize(s, typeof s.topic === "string" ? s.topic : "", typeof s.msg_type === "string" ? shortType(s.msg_type.replace("/msg/", ".")) : undefined),
  },
  {
    type: "ros.call_service", label: "Call service", group: "ROS", icon: "phone",
    help: "Call a ROS service and store the response as the result value.",
    params: [
      { key: "service", label: "Service", kind: "string", required: true, placeholder: "/reset" },
      { key: "srv_type", label: "Service type", kind: "string", required: true, placeholder: "std_srvs/srv/Trigger" },
      { key: "request", label: "Request", kind: "json" },
    ],
    summary: (s) => summarize(s, typeof s.service === "string" ? s.service : ""),
  },
  {
    type: "ros.call_action", label: "Call action", group: "ROS", icon: "zap",
    help: "Send a goal to any ROS action and wait for the result (route server, coverage...).",
    params: [
      { key: "action", label: "Action", kind: "string", required: true, placeholder: "/compute_route" },
      { key: "action_type", label: "Action type", kind: "string", required: true, placeholder: "nav2_msgs/action/ComputeRoute" },
      { key: "goal", label: "Goal", kind: "json" },
    ],
    summary: (s) => summarize(s, typeof s.action === "string" ? s.action : ""),
  },
  {
    type: "ros.set_param", label: "Set parameters", group: "ROS", icon: "sliders",
    help: "Set parameters on a node.",
    params: [
      { key: "node", label: "Node", kind: "string", required: true, placeholder: "/controller_server" },
      { key: "params", label: "Parameters", kind: "json", required: true, help: "name → value" },
    ],
    summary: (s) => summarize(s, typeof s.node === "string" ? s.node : "", isRecord(s.params) ? Object.keys(s.params).join(", ") : undefined),
  },
  // Connectors
  {
    type: "mqtt.publish", label: "MQTT publish", group: "Connectors", icon: "wifi",
    help: "Publish a payload through an MQTT connector configured on the robot.",
    params: [
      { key: "connector", label: "Connector", kind: "connector", required: true },
      { key: "topic", label: "Topic", kind: "string", required: true, placeholder: "robot/state" },
      { key: "payload", label: "Payload", kind: "value", placeholder: "NAVIGATING" },
      { key: "qos", label: "QoS", kind: "integer", default: 1, min: 0, max: 2, advanced: true },
      { key: "retain", label: "Retain", kind: "boolean", default: false, advanced: true },
    ],
    summary: (s) => summarize(s, typeof s.topic === "string" ? s.topic : "", valueText(s.payload)),
  },
  {
    type: "http.request", label: "HTTP request", group: "Connectors", icon: "globe",
    help: "Send an HTTP request. The result value is {status, body}.",
    params: [
      { key: "method", label: "Method", kind: "select", options: ["GET", "POST", "PUT", "PATCH", "DELETE"], default: "POST" },
      { key: "url", label: "URL", kind: "string", required: true, placeholder: "http://server/api/done" },
      { key: "headers", label: "Headers", kind: "json", advanced: true },
      { key: "body", label: "Body", kind: "value", advanced: true },
    ],
    summary: (s) => summarize(s, `${typeof s.method === "string" ? s.method : "POST"} ${typeof s.url === "string" ? s.url : ""}`),
  },
  {
    type: "modbus.write", label: "Modbus write", group: "Connectors", icon: "cpu",
    help: "Write a coil or holding register through a Modbus connector.",
    params: [
      { key: "connector", label: "Connector", kind: "connector", required: true },
      { key: "kind", label: "Kind", kind: "select", options: ["coil", "register"], default: "coil" },
      { key: "address", label: "Address", kind: "integer", required: true, min: 0, default: 0 },
      { key: "value", label: "Value", kind: "value", required: true, default: true },
    ],
    summary: (s) => summarize(s, `${typeof s.kind === "string" ? s.kind : "coil"} ${fmtNum(s.address)} = ${valueText(s.value)}`),
  },
  {
    type: "gpio.write", label: "GPIO write", group: "Connectors", icon: "circuit",
    help: "Set a GPIO output pin.",
    params: [
      { key: "pin", label: "Pin", kind: "integer", required: true, min: 0, default: 0 },
      { key: "value", label: "Value", kind: "value", required: true, default: true },
    ],
    summary: (s) => summarize(s, `pin ${fmtNum(s.pin)} = ${valueText(s.value)}`),
  },
];

const BLOCK_MAP = new Map(BLOCKS.map((b) => [b.type, b]));

export function blockDef(type: string): BlockDef | undefined {
  return BLOCK_MAP.get(type);
}

export function allBlocks(): readonly BlockDef[] {
  return BLOCKS;
}

export function blocksByGroup(): Map<BlockGroup, BlockDef[]> {
  const m = new Map<BlockGroup, BlockDef[]>();
  for (const g of BLOCK_GROUPS) m.set(g, []);
  for (const b of BLOCKS) m.get(b.group)!.push(b);
  return m;
}

/** Unknown types get a placeholder definition so the UI still renders them. */
export function blockDefOrUnknown(type: string): BlockDef {
  return (
    BLOCK_MAP.get(type) ?? {
      type,
      label: type || "(no type)",
      group: "Logic",
      icon: "alert",
      help: "Unknown step type. The runner will reject this mission.",
      params: [],
      summary: () => `unknown type '${type}'`,
    }
  );
}

export function stepTitle(step: Step): string {
  if (typeof step.name === "string" && step.name.trim() !== "") return step.name;
  return blockDefOrUnknown(step.type).label;
}

export function stepSummary(step: Step, ctx: SummaryCtx): string {
  try {
    return blockDefOrUnknown(step.type).summary(step, ctx);
  } catch {
    return shortType(step.type);
  }
}

/** Summary without the leading type name ("Rack3 · retry 2" instead of "go_to_pose · Rack3 · retry 2"); the list shows the type elsewhere. */
export function stepSummaryShort(step: Step, ctx: SummaryCtx): string {
  const full = stepSummary(step, ctx);
  const t = shortType(step.type);
  if (full === t) return "";
  return full.startsWith(t + SEP) ? full.slice(t.length + SEP.length) : full;
}

export function containerKeys(type: string): readonly string[] {
  return BLOCK_MAP.get(type)?.containers ?? [];
}

// ---- trigger registry -----------------------------------------------------------

function edgeArrow(edge: unknown, rising = "↑", falling = "↓", both = "↕"): string {
  if (edge === "rising") return ` ${rising}`;
  if (edge === "falling") return ` ${falling}`;
  if (edge === "both") return ` ${both}`;
  return "";
}

const TRIGGERS: TriggerDef[] = [
  {
    type: "ros.topic", label: "ROS topic", icon: "radio",
    help: "A message on a topic. The payload is the message as JSON.",
    params: [
      { key: "topic", label: "Topic", kind: "string", required: true, placeholder: "/battery_state" },
      { key: "msg_type", label: "Message type", kind: "string", placeholder: "sensor_msgs/msg/BatteryState", help: "Auto-detected when empty." },
    ],
    summary: (t) => `ROS ${t.topic ?? "?"}${t.when ? ` ${t.when}` : ""}${edgeArrow(t.edge)}`,
  },
  {
    type: "mqtt.subscribe", label: "MQTT message", icon: "wifi",
    help: "A message on an MQTT topic (wildcards allowed). The payload is the parsed JSON, or {text}.",
    params: [
      { key: "connector", label: "Connector", kind: "connector", required: true },
      { key: "topic", label: "Topic", kind: "string", required: true, placeholder: "robot/goal" },
    ],
    summary: (t) => `MQTT ${t.topic ?? "?"}${edgeArrow(t.edge)}`,
  },
  {
    type: "http.webhook", label: "Webhook", icon: "webhook",
    help: "POST /hooks/<path> on the runner. The JSON body is the payload.",
    params: [{ key: "path", label: "Path", kind: "string", required: true, placeholder: "pickup" }],
    summary: (t) => `POST /hooks/${t.path ?? "?"}`,
  },
  {
    type: "timer.cron", label: "Schedule", icon: "calendar",
    help: "A 5-field crontab expression in local time, e.g. '0 22 * * *'.",
    params: [{ key: "cron", label: "Cron", kind: "string", required: true, placeholder: "0 22 * * *" }],
    summary: (t) => (typeof t.cron === "string" ? cronToWords(t.cron) : "?"),
  },
  {
    type: "timer.interval", label: "Interval", icon: "timer",
    help: "Fires every N seconds.",
    params: [{ key: "seconds", label: "Seconds", kind: "number", required: true, min: 0.1, default: 60 }],
    summary: (t) => `every ${fmtNum(t.seconds)} s`,
  },
  {
    type: "timer.boot", label: "On boot", icon: "power",
    help: "Fires once after the runner starts.",
    params: [{ key: "delay_s", label: "Delay (s)", kind: "number", default: 0, min: 0 }],
    summary: (t) => `on boot${typeof t.delay_s === "number" && t.delay_s > 0 ? ` +${fmtNum(t.delay_s)} s` : ""}`,
  },
  {
    type: "gpio.input", label: "GPIO input", icon: "circuit",
    help: "An edge on a GPIO input pin.",
    params: [
      { key: "pin", label: "Pin", kind: "integer", required: true, min: 0, default: 17 },
      { key: "gpio_edge", label: "Edge", kind: "select", options: ["rising", "falling", "both"], default: "falling" },
      { key: "pull", label: "Pull", kind: "select", options: ["up", "down", "none"], default: "up", advanced: true },
      { key: "bounce_s", label: "Bounce (s)", kind: "number", default: 0.05, min: 0, advanced: true },
    ],
    summary: (t) => `GPIO ${fmtNum(t.pin)}${edgeArrow(t.gpio_edge ?? "falling")}`,
  },
  {
    type: "modbus.poll", label: "Modbus poll", icon: "cpu",
    help: "Polls a coil, discrete input or register. The payload is {value}.",
    params: [
      { key: "connector", label: "Connector", kind: "connector", required: true },
      { key: "kind", label: "Kind", kind: "select", options: ["coil", "discrete", "register"], default: "coil" },
      { key: "address", label: "Address", kind: "integer", required: true, min: 0, default: 0 },
      { key: "poll_s", label: "Poll (s)", kind: "number", default: 0.5, min: 0.01, advanced: true },
    ],
    summary: (t) => `${t.connector ?? "PLC"} ${t.kind ?? "coil"} ${fmtNum(t.address)}${edgeArrow(t.edge)}`,
  },
  {
    type: "mission.done", label: "Mission done", icon: "checkCircle",
    help: "Fires when another mission finishes.",
    params: [
      { key: "mission", label: "Mission", kind: "string", required: true },
      { key: "result", label: "Result", kind: "select", options: ["any", "success", "failed"], default: "any" },
    ],
    summary: (t) => `after ${t.mission ?? "?"}${t.result && t.result !== "any" ? ` (${t.result})` : ""}`,
  },
];

const TRIGGER_MAP = new Map(TRIGGERS.map((t) => [t.type, t]));

export function triggerDef(type: string): TriggerDef | undefined {
  return TRIGGER_MAP.get(type);
}

export function allTriggers(): readonly TriggerDef[] {
  return TRIGGERS;
}

export function triggerSummary(spec: EventSource): string {
  const def = TRIGGER_MAP.get(spec.type);
  if (!def) return `unknown '${spec.type}'`;
  try {
    return def.summary(spec);
  } catch {
    return spec.type;
  }
}

export function triggerIcon(type: string): IconName {
  return TRIGGER_MAP.get(type)?.icon ?? "alert";
}

// ---- defaults for new items -----------------------------------------------------

function kindDefault(def: ParamDef): unknown {
  if (def.default !== undefined) return def.default;
  switch (def.kind) {
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "select":
      return def.options?.[0] ?? "";
    case "steps":
    case "poses":
    case "points":
    case "options":
      return [];
    case "json":
      return {};
    case "event_source":
      return { type: "ros.topic", topic: "" };
    case "behavior_tree":
      return { template: "navigate_with_recovery" };
    default:
      return "";
  }
}

/** A new step of `type` with its required parameters filled with defaults. */
export function newStep(type: string, id: string): Step {
  const step: Step = { id, type };
  const def = BLOCK_MAP.get(type);
  if (def) {
    for (const p of def.params) if (p.required) step[p.key] = kindDefault(p);
    if (type === "nav.follow_path") step.points = [];
  }
  return step;
}

export function newTrigger(type: string, id: string): Trigger {
  const t: Trigger = { id, type };
  const def = TRIGGER_MAP.get(type);
  if (def) for (const p of def.params) if (p.required) t[p.key] = kindDefault(p);
  return t;
}

export function newEventSource(type: string): EventSource {
  const t: EventSource = { type };
  const def = TRIGGER_MAP.get(type);
  if (def) for (const p of def.params) if (p.required) t[p.key] = kindDefault(p);
  return t;
}

export function isKnownStepType(type: string): boolean {
  return (STEP_TYPES as readonly string[]).includes(type);
}

export function isKnownEventType(type: string): boolean {
  return (EVENT_TYPES as readonly string[]).includes(type);
}

export function isBtTemplateName(name: unknown): boolean {
  return typeof name === "string" && (BT_TEMPLATES as readonly string[]).includes(name);
}

/** Static site name referenced by a pose, or null for coordinates / expressions. */
export function poseSiteRef(pose: unknown): string | null {
  if (typeof pose === "string") return pose === "" || hasExpression(pose) ? null : pose;
  if (isRecord(pose) && typeof pose.site === "string") return pose.site === "" || hasExpression(pose.site) ? null : pose.site;
  return null;
}

export const POSE_PARAMS: Readonly<Record<string, readonly string[]>> = {
  "nav.set_initial_pose": ["pose"],
  "nav.follow_route": ["to", "from"],
  "nav.go_to_pose": ["pose"],
  "nav.compute_path": ["goal", "start"],
  "nav.dock": ["dock_pose"],
};
export const POSE_LIST_PARAMS: Readonly<Record<string, readonly string[]>> = {
  "nav.go_through_poses": ["poses"],
  "nav.follow_waypoints": ["poses"],
  "nav.follow_path": ["points"],
  "nav.compute_path_through_poses": ["goals"],
};
export const CONNECTOR_STEP_TYPES: ReadonlySet<string> = new Set(["mqtt.publish", "modbus.write"]);
export const CONNECTOR_EVENT_TYPES: ReadonlySet<string> = new Set(["mqtt.subscribe", "modbus.poll"]);

