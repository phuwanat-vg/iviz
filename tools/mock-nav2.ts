/**
 * A Nav2 stand-in for the mock bridge.
 *
 * Advertises the hidden services and topics of NavigateToPose,
 * NavigateThroughPoses, FollowWaypoints and FollowPath exactly as
 * foxglove_bridge does with `include_hidden:=true`, plus /map_saver/save_map.
 * The simulated robot drives in a circle until the first goal arrives, then
 * drives to whatever it is sent: straight to each pose, following a path, and
 * turning in place to the final heading. Cancel stops it where it is.
 */
import { createRequire } from "node:module";
import type { FoxgloveServer, IWebSocket, ServiceCallRequest } from "@foxglove/ws-protocol";
import type { MessageReader as MessageReaderT, MessageWriter as MessageWriterT } from "@foxglove/rosmsg2-serialization";
import { GOAL_STATUS_ARRAY, actionSchemas, fallbackServiceSchemas } from "../src/ros/nav2Schemas";
import { normalizeRos2MsgText } from "../src/ros/schemas";

const require = createRequire(import.meta.url);
const { parse } = require("@foxglove/rosmsg") as typeof import("@foxglove/rosmsg");
const { MessageReader, MessageWriter } = require("@foxglove/rosmsg2-serialization") as typeof import("@foxglove/rosmsg2-serialization");

export interface Pose {
  x: number;
  y: number;
  yaw: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Msg = Record<string, any>;
type Kind = "goal" | "through" | "waypoints" | "path";

export interface Nav2Sim {
  /** Robot pose in the map frame. */
  pose(): Pose;
  /** The plan to publish on /plan, if any. */
  plan(): Pose[] | undefined;
  /** A client published on /goal_pose, which bt_navigator turns into a goal. */
  goalPose(msg: Msg): void;
  /** Handle a call to one of the simulated services; false if it is not one. */
  handleServiceCall(req: ServiceCallRequest, conn: IWebSocket): boolean;
}

const STATUS = { EXECUTING: 2, SUCCEEDED: 4, CANCELED: 5, ABORTED: 6 } as const;
const SPEED = 0.6;
const TURN_RATE = 1.6;

const ACTION_DEFS: [name: string, type: string, kind: Kind][] = [
  ["/navigate_to_pose", "nav2_msgs/action/NavigateToPose", "goal"],
  ["/navigate_through_poses", "nav2_msgs/action/NavigateThroughPoses", "through"],
  ["/follow_waypoints", "nav2_msgs/action/FollowWaypoints", "waypoints"],
  ["/follow_path", "nav2_msgs/action/FollowPath", "path"],
];

interface Waiter {
  serviceId: number;
  callId: number;
  conn: IWebSocket;
}

interface SimAction {
  name: string;
  kind: Kind;
  statusChannel: number;
  feedbackChannel: number;
  feedbackSchema: string;
  getResultResponse: string;
  goals: Map<string, SimGoal>;
}

interface SimGoal {
  id: string;
  uuid: Uint8Array;
  action: SimAction;
  status: number;
  poses: Pose[];
  index: number;
  startMs: number;
  endMs?: number;
  stamp: { sec: number; nanosec: number };
  result: Msg;
  waiters: Waiter[];
}

const codecs = new Map<string, { reader: MessageReaderT; writer: MessageWriterT }>();
function codec(schema: string): { reader: MessageReaderT; writer: MessageWriterT } {
  let c = codecs.get(schema);
  if (!c) {
    const defs = parse(normalizeRos2MsgText(schema), { ros2: true });
    c = { reader: new MessageReader(defs), writer: new MessageWriter(defs) };
    codecs.set(schema, c);
  }
  return c;
}

export function createNav2Sim(server: FoxgloveServer, subscribed: ReadonlySet<number>): Nav2Sim {
  const t0 = Date.now();
  const robot: Pose = { x: 3.5, y: 0, yaw: Math.PI / 2 };
  let autopilot = true;
  let active: SimGoal | undefined;
  const handlers = new Map<number, (req: ServiceCallRequest, conn: IWebSocket) => void>();
  const actions: SimAction[] = [];

  const circlePose = (): Pose => {
    const t = (Date.now() - t0) / 1000;
    return { x: 3.5 * Math.cos(0.15 * t), y: 3.5 * Math.sin(0.15 * t), yaw: 0.15 * t + Math.PI / 2 };
  };

  const reply = (to: { serviceId: number; callId: number }, schema: string, msg: Msg, conn: IWebSocket): void => {
    try {
      const data = codec(schema).writer.writeMessage(msg);
      server.sendServiceCallResponse({ serviceId: to.serviceId, callId: to.callId, encoding: "cdr", data: data as unknown as DataView }, conn);
    } catch (err) {
      console.log(`[mock] nav2 reply failed: ${String(err)}`);
    }
  };

  const publish = (channel: number, schema: string, msg: Msg): void => {
    if (!subscribed.has(channel)) return;
    server.sendMessage(channel, BigInt(Date.now()) * 1_000_000n, codec(schema).writer.writeMessage(msg) as unknown as BufferSource);
  };

  const publishStatus = (action: SimAction): void => {
    const now = Date.now();
    for (const [id, g] of action.goals) if (g.endMs !== undefined && now - g.endMs > 60_000) action.goals.delete(id);
    publish(action.statusChannel, GOAL_STATUS_ARRAY, {
      status_list: [...action.goals.values()].map((g) => ({ goal_info: { goal_id: { uuid: g.uuid }, stamp: g.stamp }, status: g.status })),
    });
  };

  const finish = (g: SimGoal, status: number, message = ""): void => {
    if (g.status >= STATUS.SUCCEEDED) return;
    g.status = status;
    g.endMs = Date.now();
    g.result = {
      error_code: status === STATUS.ABORTED ? 9999 : 0,
      error_msg: message,
      missed_waypoints: [],
      result: { structure_needs_at_least_one_member: 0 },
    };
    for (const w of g.waiters) reply(w, g.action.getResultResponse, resultMessage(g), w.conn);
    g.waiters = [];
    if (active === g) active = undefined;
    publishStatus(g.action);
    const word = status === STATUS.SUCCEEDED ? "succeeded" : status === STATUS.CANCELED ? "canceled" : "aborted";
    console.log(`[mock] ${g.action.name} goal ${g.id.slice(0, 8)} ${word}${message ? `: ${message}` : ""}`);
  };

  const startGoal = (action: SimAction, uuid: Uint8Array, poses: Pose[]): boolean => {
    if (poses.length === 0) return false;
    if (active) finish(active, STATUS.ABORTED, "preempted by a new goal");
    if (autopilot) {
      Object.assign(robot, circlePose());
      autopilot = false;
    }
    const g: SimGoal = {
      id: hex(uuid),
      uuid,
      action,
      status: STATUS.EXECUTING,
      poses,
      index: 0,
      startMs: Date.now(),
      stamp: stampNow(),
      result: {},
      waiters: [],
    };
    action.goals.set(g.id, g);
    active = g;
    publishStatus(action);
    console.log(`[mock] ${action.name} goal ${g.id.slice(0, 8)} accepted, ${poses.length} pose${poses.length === 1 ? "" : "s"}`);
    return true;
  };

  // ----- action servers ----------------------------------------------------

  const cancelSchemas = fallbackServiceSchemas("action_msgs/srv/CancelGoal")!;
  for (const [name, type, kind] of ACTION_DEFS) {
    // Flattened, exactly as foxglove_bridge advertises action types.
    const s = actionSchemas(type, "flat")!;
    const service = (suffix: string, serviceType: string, request: string, response: string): number =>
      server.addService({
        name: `${name}/_action/${suffix}`,
        type: serviceType,
        request: { encoding: "cdr", schemaName: `${serviceType}_Request`, schemaEncoding: "ros2msg", schema: request },
        response: { encoding: "cdr", schemaName: `${serviceType}_Response`, schemaEncoding: "ros2msg", schema: response },
      });
    const action: SimAction = {
      name,
      kind,
      feedbackSchema: s.feedbackMessage,
      getResultResponse: s.getResultResponse,
      goals: new Map(),
      statusChannel: server.addChannel({ topic: `${name}/_action/status`, encoding: "cdr", schemaName: "action_msgs/msg/GoalStatusArray", schema: GOAL_STATUS_ARRAY, schemaEncoding: "ros2msg" }),
      feedbackChannel: server.addChannel({ topic: `${name}/_action/feedback`, encoding: "cdr", schemaName: `${type}_FeedbackMessage`, schema: s.feedbackMessage, schemaEncoding: "ros2msg" }),
    };
    actions.push(action);

    const sendGoal = service("send_goal", `${type}_SendGoal`, s.sendGoalRequest, s.sendGoalResponse);
    handlers.set(sendGoal, (req, conn) => {
      const m = codec(s.sendGoalRequest).reader.readMessage(req.data) as Msg;
      const accepted = startGoal(action, Uint8Array.from(m.goal_id.uuid), posesFromGoal(kind, m.goal ?? m));
      reply(req, s.sendGoalResponse, { accepted, stamp: stampNow() }, conn);
    });

    const getResult = service("get_result", `${type}_GetResult`, s.getResultRequest, s.getResultResponse);
    handlers.set(getResult, (req, conn) => {
      const m = codec(s.getResultRequest).reader.readMessage(req.data) as Msg;
      const g = action.goals.get(hex(m.goal_id.uuid));
      if (!g) reply(req, s.getResultResponse, { status: 0, result: {} }, conn);
      else if (g.status >= STATUS.SUCCEEDED) reply(req, s.getResultResponse, resultMessage(g), conn);
      else g.waiters.push({ serviceId: req.serviceId, callId: req.callId, conn });
    });

    const cancel = service("cancel_goal", "action_msgs/srv/CancelGoal", cancelSchemas.request, cancelSchemas.response);
    handlers.set(cancel, (req, conn) => {
      const m = codec(cancelSchemas.request).reader.readMessage(req.data) as Msg;
      const id = hex(m.goal_info.goal_id.uuid);
      const all = /^0+$/.test(id);
      const targets = [...action.goals.values()].filter((g) => g.status < STATUS.SUCCEEDED && (all || g.id === id));
      reply(
        req,
        cancelSchemas.response,
        { return_code: targets.length > 0 || all ? 0 : 2, goals_canceling: targets.map((g) => ({ goal_id: { uuid: g.uuid }, stamp: g.stamp })) },
        conn,
      );
      console.log(`[mock] ${name} cancel ${all ? "all goals" : id.slice(0, 8)} -> ${targets.length} canceled`);
      for (const g of targets) finish(g, STATUS.CANCELED);
    });
  }

  // ----- map saver ---------------------------------------------------------

  const saveMap = fallbackServiceSchemas("nav2_msgs/srv/SaveMap")!;
  const saverId = server.addService({
    name: "/map_saver/save_map",
    type: "nav2_msgs/srv/SaveMap",
    request: { encoding: "cdr", schemaName: "nav2_msgs/srv/SaveMap_Request", schemaEncoding: "ros2msg", schema: saveMap.request },
    response: { encoding: "cdr", schemaName: "nav2_msgs/srv/SaveMap_Response", schemaEncoding: "ros2msg", schema: saveMap.response },
  });
  handlers.set(saverId, (req, conn) => {
    const m = codec(saveMap.request).reader.readMessage(req.data) as Msg;
    console.log(`[mock] map_saver: would save ${m.map_topic} as ${m.map_url} (${m.image_format}, ${m.map_mode}, free ${m.free_thresh}, occupied ${m.occupied_thresh})`);
    reply(req, saveMap.response, { result: true }, conn);
  });

  // ----- motion ------------------------------------------------------------

  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const dt = Math.min(0.2, (now - lastTick) / 1000);
    lastTick = now;
    if (active) step(active, dt);
  }, 50);

  const step = (g: SimGoal, dt: number): void => {
    const last = g.poses.length - 1;
    const kind = g.action.kind;
    const dist = (p: Pose): number => Math.hypot(p.x - robot.x, p.y - robot.y);
    if (kind === "path") while (g.index < last && dist(g.poses[g.index]!) < 0.35) g.index++;
    if ((kind === "waypoints" || kind === "through") && g.index < last && dist(g.poses[g.index]!) < 0.15) g.index++;
    const target = g.poses[g.index]!;
    const d = dist(target);
    if (g.index === last && d < (kind === "waypoints" ? 0.15 : 0.06)) {
      if (kind === "goal" || kind === "through") {
        const err = wrap(target.yaw - robot.yaw);
        if (Math.abs(err) > 0.05) {
          robot.yaw = wrap(robot.yaw + clamp(err * 3, -TURN_RATE, TURN_RATE) * dt);
          return;
        }
      }
      finish(g, STATUS.SUCCEEDED);
      return;
    }
    const err = wrap(Math.atan2(target.y - robot.y, target.x - robot.x) - robot.yaw);
    robot.yaw = wrap(robot.yaw + clamp(err * 3, -TURN_RATE, TURN_RATE) * dt);
    if (Math.abs(err) < 0.7) {
      const v = Math.min(SPEED, d * 2 + 0.05);
      robot.x += Math.cos(robot.yaw) * v * dt;
      robot.y += Math.sin(robot.yaw) * v * dt;
    }
  };

  const remaining = (g: SimGoal): number => {
    let d = 0;
    let from: Pose = robot;
    for (let i = g.index; i < g.poses.length; i++) {
      d += Math.hypot(g.poses[i]!.x - from.x, g.poses[i]!.y - from.y);
      from = g.poses[i]!;
    }
    return d;
  };

  setInterval(() => {
    const g = active;
    if (!g) return;
    const d = remaining(g);
    let feedback: Msg;
    switch (g.action.kind) {
      case "goal":
      case "through":
        feedback = {
          current_pose: stamped(robot),
          navigation_time: duration((Date.now() - g.startMs) / 1000),
          estimated_time_remaining: duration(d / SPEED),
          number_of_recoveries: 0,
          distance_remaining: d,
          number_of_poses_remaining: g.poses.length - g.index,
        };
        break;
      case "waypoints":
        feedback = { current_waypoint: g.index };
        break;
      default:
        feedback = { distance_to_goal: d, speed: SPEED };
    }
    // Both shapes, so the message fits a flattened or a nested schema.
    publish(g.action.feedbackChannel, g.action.feedbackSchema, { ...feedback, goal_id: { uuid: g.uuid }, feedback });
  }, 100);

  setInterval(() => actions.forEach(publishStatus), 500);

  return {
    pose(): Pose {
      if (autopilot) Object.assign(robot, circlePose());
      return robot;
    },
    plan(): Pose[] | undefined {
      if (autopilot) {
        const t = (Date.now() - t0) / 1000;
        return Array.from({ length: 41 }, (_, i) => {
          const a = 0.15 * t + (i / 40) * (Math.PI / 2);
          return { x: 3.5 * Math.cos(a), y: 3.5 * Math.sin(a), yaw: a + Math.PI / 2 };
        });
      }
      const g = active;
      if (!g) return undefined;
      if (g.action.kind === "path") return g.poses.slice(g.index);
      return [{ ...robot }, ...g.poses.slice(g.index)];
    },
    goalPose(msg: Msg): void {
      const uuid = new Uint8Array(16);
      crypto.getRandomValues(uuid);
      startGoal(actions[0]!, uuid, [poseOf(msg)]);
    },
    handleServiceCall(req: ServiceCallRequest, conn: IWebSocket): boolean {
      const handler = handlers.get(req.serviceId);
      if (!handler) return false;
      try {
        handler(req, conn);
      } catch (err) {
        server.sendServiceCallFailure({ op: "serviceCallFailure", serviceId: req.serviceId, callId: req.callId, message: String(err) }, conn);
      }
      return true;
    },
  };
}

/** A get_result response in both shapes (flattened fields and a nested `result`). */
function resultMessage(g: SimGoal): Msg {
  return { ...g.result, status: g.status, result: g.result };
}

function posesFromGoal(kind: Kind, goal: Msg): Pose[] {
  const list = (arr: Msg[] | undefined): Pose[] => (arr ?? []).map(poseOf);
  switch (kind) {
    case "goal":
      return goal.pose ? [poseOf(goal.pose)] : [];
    case "path":
      return list(goal.path?.poses);
    default:
      return list(goal.poses);
  }
}

function poseOf(stampedPose: Msg): Pose {
  const p = stampedPose.pose.position;
  const q = stampedPose.pose.orientation;
  return { x: p.x, y: p.y, yaw: Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z)) };
}

function stamped(p: Pose): Msg {
  return {
    header: { stamp: stampNow(), frame_id: "map" },
    pose: { position: { x: p.x, y: p.y, z: 0 }, orientation: { x: 0, y: 0, z: Math.sin(p.yaw / 2), w: Math.cos(p.yaw / 2) } },
  };
}

function stampNow(): { sec: number; nanosec: number } {
  const ms = Date.now();
  return { sec: Math.floor(ms / 1000), nanosec: (ms % 1000) * 1e6 };
}

function duration(sec: number): { sec: number; nanosec: number } {
  const whole = Math.floor(sec);
  return { sec: whole, nanosec: Math.round((sec - whole) * 1e9) };
}

function hex(uuid: ArrayLike<number>): string {
  let s = "";
  for (let i = 0; i < uuid.length; i++) s += (uuid[i]! & 0xff).toString(16).padStart(2, "0");
  return s;
}

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
