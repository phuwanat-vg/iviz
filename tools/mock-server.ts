/**
 * Mock foxglove_bridge for developing iViz without a robot.
 *
 *   npm run mock            # ws://localhost:8765
 *   npm run mock -- 9000    # custom port
 *
 * Simulates a robot driving in a circle inside a 12 x 12 m room and publishes
 * /tf, /tf_static, /Odometry, /scan, /cloud_registered (PointCloud2),
 * /livox/lidar (livox CustomMsg), /map, /local_costmap/costmap, /plan,
 * /footprint and /amcl_pose. Client publishes (goal_pose / initialpose) are
 * decoded and logged.
 *
 * It also stands in for mission_runner's ROS node so Route mode can be
 * developed without ROS: the `/mission/api` service (`mission_msgs/srv/Api`)
 * forwards to a runner's HTTP API and /mission/state and /mission/event
 * republish that runner's event stream. Point it at a sim runner with
 * MISSION_RUNNER_URL (default http://127.0.0.1:8080).
 *
 * Nav2 is simulated in mock-nav2.ts: the hidden action services and topics of
 * NavigateToPose, NavigateThroughPoses, FollowWaypoints and FollowPath, and
 * /map_saver/save_map. The robot drives in a circle until it gets a goal.
 */
import { createRequire } from "node:module";
import { WebSocket, WebSocketServer } from "ws";
import type { IWebSocket } from "@foxglove/ws-protocol";
import type { MessageWriter as MessageWriterT } from "@foxglove/rosmsg2-serialization";
import { SCHEMAS, normalizeRos2MsgText } from "../src/ros/schemas";
import type { SchemaName } from "../src/ros/schemas";
import { createNav2Sim } from "./mock-nav2";
import { createPromptSim } from "./mock-prompts";

// The @foxglove packages ship CommonJS without an "exports" map, so Node's ESM
// loader cannot see their named exports. Load them through require() instead.
const require = createRequire(import.meta.url);
const { FoxgloveServer } = require("@foxglove/ws-protocol") as typeof import("@foxglove/ws-protocol");
const { parse } = require("@foxglove/rosmsg") as typeof import("@foxglove/rosmsg");
const { MessageReader, MessageWriter } = require("@foxglove/rosmsg2-serialization") as typeof import("@foxglove/rosmsg2-serialization");

const port = Number(process.argv[2] ?? 8765);

const server = new FoxgloveServer({
  name: "iviz-mock-bridge",
  capabilities: ["clientPublish", "services", "connectionGraph", "parameters", "parametersSubscribe"],
  supportedEncodings: ["cdr"],
});

const writers = new Map<SchemaName, MessageWriterT>();
function writer(name: SchemaName): MessageWriterT {
  let w = writers.get(name);
  if (!w) {
    w = new MessageWriter(parse(normalizeRos2MsgText(SCHEMAS[name]), { ros2: true }));
    writers.set(name, w);
  }
  return w;
}

function channel(topic: string, schemaName: SchemaName): number {
  return server.addChannel({ topic, encoding: "cdr", schemaName, schema: SCHEMAS[schemaName], schemaEncoding: "ros2msg" });
}

const ch = {
  tf: channel("/tf", "tf2_msgs/msg/TFMessage"),
  tfStatic: channel("/tf_static", "tf2_msgs/msg/TFMessage"),
  odom: channel("/Odometry", "nav_msgs/msg/Odometry"),
  scan: channel("/scan", "sensor_msgs/msg/LaserScan"),
  cloud: channel("/cloud_registered", "sensor_msgs/msg/PointCloud2"),
  livox: channel("/livox/lidar", "livox_ros_driver2/msg/CustomMsg"),
  map: channel("/map", "nav_msgs/msg/OccupancyGrid"),
  costmap: channel("/local_costmap/costmap", "nav_msgs/msg/OccupancyGrid"),
  plan: channel("/plan", "nav_msgs/msg/Path"),
  footprint: channel("/local_costmap/published_footprint", "geometry_msgs/msg/PolygonStamped"),
  amcl: channel("/amcl_pose", "geometry_msgs/msg/PoseWithCovarianceStamped"),
  missionState: channel("/mission/state", "std_msgs/msg/String"),
  missionEvent: channel("/mission/event", "std_msgs/msg/String"),
  askRequest: channel("/iviz/request", "std_msgs/msg/String"),
  askAnswer: channel("/iviz/answer", "std_msgs/msg/String"),
};

const subscribed = new Set<number>();

// `--no-localization` imitates AMCL before it has an initial pose: there is no
// map -> odom transform, so the map frame is in no TF tree until iViz sends a
// pose estimate on /initialpose.
const NO_LOCALIZATION = process.argv.includes("--no-localization");
// `--auto-answer` stands in for a node of the user's that answers iViz's
// requests, which is how the contract is meant to work in production.
const AUTO_ANSWER = process.argv.includes("--auto-answer");
let localized = !NO_LOCALIZATION;

// Advertised but never published, to exercise the inactive-topic filter.
server.addChannel({ topic: "/mock_inactive", encoding: "cdr", schemaName: "std_msgs/msg/String", schema: "string data", schemaEncoding: "ros2msg" });

// Nav2 action servers, a map saver and a robot that drives to its goals.
const nav2 = createNav2Sim(server, subscribed, () => mapMessage());
server.on("subscribe", (id) => {
  subscribed.add(id);
  console.log(`[mock] subscribe channel ${id}`);
});
server.on("unsubscribe", (id) => {
  subscribed.delete(id);
  console.log(`[mock] unsubscribe channel ${id}`);
});
server.on("error", (err) => console.error("[mock] error", err));

// A handful of parameters, named the way a Nav2 robot names them, so the
// Parameters tab has something to set. They live in memory only, exactly like
// parameters on a running node.
const parameters = new Map<string, unknown>([
  ["/controller_server.controller_frequency", 20.0],
  ["/controller_server.FollowPath.max_vel_x", 0.26],
  ["/controller_server.FollowPath.max_vel_theta", 1.0],
  ["/controller_server.FollowPath.xy_goal_tolerance", 0.25],
  ["/controller_server.use_sim_time", false],
  ["/planner_server.expected_planner_frequency", 20.0],
  ["/planner_server.GridBased.tolerance", 0.5],
  ["/local_costmap/local_costmap.inflation_layer.inflation_radius", 0.55],
  ["/local_costmap/local_costmap.robot_radius", 0.22],
  ["/global_costmap/global_costmap.robot_radius", 0.22],
  ["/amcl.max_particles", 2000],
  ["/amcl.robot_model_type", "nav2_amcl::DifferentialMotionModel"],
  ["/bt_navigator.default_nav_to_pose_bt_xml", "navigate_to_pose_w_replanning_and_recovery.xml"],
]);

server.on("getParameters", (request, conn) => {
  const names = request.parameterNames.length > 0 ? request.parameterNames : [...parameters.keys()];
  const values = names.filter((n) => parameters.has(n)).map((n) => ({ name: n, value: parameters.get(n) as never }));
  console.log(`[mock] getParameters ${request.parameterNames.length === 0 ? "(all)" : request.parameterNames.join(", ")} -> ${values.length}`);
  if (conn) server.publishParameterValues(values, request.id, conn);
});

server.on("setParameters", (request, conn) => {
  const applied = request.parameters.map((p) => {
    // Nodes clamp what they will not take; max_vel_x stands in for that here.
    let value = p.value as unknown;
    if (p.name.endsWith("max_vel_x") && typeof value === "number") value = Math.min(value, 1.0);
    parameters.set(p.name, value);
    console.log(`[mock] setParameter ${p.name} = ${JSON.stringify(value)}`);
    return { name: p.name, value: value as never };
  });
  if (conn) server.publishParameterValues(applied, request.id, conn);
  server.updateParameterValues(applied);
});
server.on("advertise", (c) => console.log(`[mock] client advertised ${c.topic} (${c.schemaName})`));
server.on("message", ({ channel: c, data }) => {
  const schema = (SCHEMAS as Record<string, string>)[c.schemaName] ?? c.schema;
  if (!schema) {
    console.log(`[mock] client message on ${c.topic}: ${data.byteLength} bytes (no schema to decode)`);
    return;
  }
  try {
    const reader = new MessageReader(parse(normalizeRos2MsgText(schema), { ros2: true }));
    const msg = reader.readMessage(data) as Record<string, unknown>;
    if (c.topic === "/goal_pose") nav2.goalPose(msg);
    if (c.topic === "/iviz/request" && AUTO_ANSWER) {
      const body = JSON.parse(String(msg.data ?? "{}")) as { id?: string; options?: string[] };
      const answer = body.options?.[0] ?? "Continue";
      console.log(`[mock] adapter will answer "${answer}" for ${body.id} in 3 s`);
      setTimeout(() => {
        send(ch.askAnswer, "std_msgs/msg/String", { data: JSON.stringify({ id: body.id, answer, by: "mock-adapter" }) });
        console.log(`[mock] adapter answered "${answer}" for ${body.id}`);
      }, 3000);
    }
    if (c.topic === "/initialpose" && !localized) {
      localized = true;
      console.log("[mock] initial pose received, publishing map -> odom from now on");
    }
    console.log(`[mock] client message on ${c.topic}:`, JSON.stringify(msg, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  } catch (err) {
    console.log(`[mock] client message on ${c.topic}: decode failed`, err);
  }
});

// ---------------------------------------------------------------------------
// /mission/api: the mission_runner bridge
//
// On a robot, mission_runner advertises this service itself. A sim runner
// (`mission_runner run --sim`) has no ROS, only its HTTP API, so the mock
// bridge stands in for the ROS node: it advertises `mission_msgs/srv/Api`
// exactly as the robot does and forwards every call to the runner's HTTP API,
// and it republishes the runner's event stream on /mission/state and
// /mission/event. That gives iViz the real end-to-end path without ROS.
//
// A ROS .srv holds request and response separated by "---"; the protocol
// advertises the two halves separately, so each is an ordinary ros2msg schema.

const RUNNER_URL = (process.env.MISSION_RUNNER_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");

const MISSION_API_REQUEST = `string method
string path
string body_json`;
const MISSION_API_RESPONSE = `bool ok
int32 status
string body_json
string message`;

const missionApiId = server.addService({
  name: "/mission/api",
  type: "mission_msgs/srv/Api",
  request: { encoding: "cdr", schemaName: "mission_msgs/srv/Api_Request", schemaEncoding: "ros2msg", schema: MISSION_API_REQUEST },
  response: { encoding: "cdr", schemaName: "mission_msgs/srv/Api_Response", schemaEncoding: "ros2msg", schema: MISSION_API_RESPONSE },
});

const missionRequestReader = new MessageReader(parse(MISSION_API_REQUEST, { ros2: true }));
const missionResponseWriter = new MessageWriter(parse(MISSION_API_RESPONSE, { ros2: true }));

// mission_runner's ask_user step, so the Dashboard can be tried without a
// runner: `--prompt` asks a question every 20 s and serves /mission/answer.
const prompts = createPromptSim(
  server,
  (event) => send(ch.missionEvent, "std_msgs/msg/String", { data: JSON.stringify(event) }),
  process.argv.includes("--prompt"),
);

interface ApiRequest {
  method: string;
  path: string;
  body_json: string;
}

server.on("serviceCallRequest", (req, conn) => {
  if (nav2.handleServiceCall(req, conn)) return;
  if (prompts.handleServiceCall(req, conn)) return;
  const fail = (message: string) => {
    console.log(`[mock] service call ${req.callId} failed: ${message}`);
    server.sendServiceCallFailure({ op: "serviceCallFailure", serviceId: req.serviceId, callId: req.callId, message }, conn);
  };
  if (req.serviceId !== missionApiId) {
    fail(`unknown service ${req.serviceId}`);
    return;
  }
  let request: ApiRequest;
  try {
    request = missionRequestReader.readMessage(req.data) as ApiRequest;
  } catch (err) {
    fail(`request did not decode: ${String(err)}`);
    return;
  }
  const reply = (ok: boolean, status: number, bodyJson: string, message: string) => {
    const bytes = missionResponseWriter.writeMessage({ ok, status, body_json: bodyJson, message });
    server.sendServiceCallResponse({ serviceId: req.serviceId, callId: req.callId, encoding: "cdr", data: bytes }, conn);
  };
  void (async () => {
    const method = (request.method || "GET").toUpperCase();
    const path = request.path || "/api/status";
    try {
      const init: RequestInit = { method };
      if (request.body_json !== "" && method !== "GET") {
        init.body = request.body_json;
        init.headers = { "content-type": "application/json" };
      }
      const res = await fetch(`${RUNNER_URL}${path}`, init);
      const type = res.headers.get("content-type") ?? "";
      let body: string;
      if (type.startsWith("application/json") || type.startsWith("text/")) {
        body = await res.text();
      } else {
        // Binary replies come back the way the real service sends them.
        const buf = Buffer.from(await res.arrayBuffer());
        body = JSON.stringify({ content_type: type || "application/octet-stream", base64: buf.toString("base64") });
      }
      console.log(`[mock] /mission/api ${method} ${path} -> ${res.status}`);
      reply(res.ok, res.status, body, res.ok ? "" : `${method} ${path} failed`);
    } catch (err) {
      console.log(`[mock] /mission/api ${method} ${path} -> runner unreachable`);
      reply(false, 0, "", `mission_runner at ${RUNNER_URL} is unreachable: ${String(err)}`);
    }
  })();
});

// The runner's own event stream, republished on the two String topics the
// robot publishes. `status` events double as /mission/state, which is latched
// on a robot; here it is simply re-sent whenever the runner reports one, plus
// a slow poll so a client that connects late sees a state quickly.
let runnerWs: WebSocket | null = null;

function publishMission(id: number, payload: unknown): void {
  send(id, "std_msgs/msg/String", { data: JSON.stringify(payload) });
}

function connectRunnerEvents(): void {
  const url = `${RUNNER_URL.replace(/^http/, "ws")}/api/events`;
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch {
    setTimeout(connectRunnerEvents, 3000);
    return;
  }
  runnerWs = ws;
  ws.on("open", () => console.log(`[mock] mission_runner events connected (${url})`));
  ws.on("message", (data) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      return;
    }
    const type = (parsed as { type?: unknown }).type;
    if (type === "status") publishMission(ch.missionState, parsed);
    publishMission(ch.missionEvent, parsed);
  });
  const retry = () => {
    if (runnerWs === ws) {
      runnerWs = null;
      setTimeout(connectRunnerEvents, 3000);
    }
  };
  ws.on("close", retry);
  ws.on("error", retry);
}
connectRunnerEvents();

// Slow poll so /mission/state is populated even when the event socket is down.
setInterval(() => {
  if (!subscribed.has(ch.missionState)) return;
  if (runnerWs && runnerWs.readyState === 1) return;
  void (async () => {
    try {
      const res = await fetch(`${RUNNER_URL}/api/status`);
      if (!res.ok) return;
      publishMission(ch.missionState, await res.json());
    } catch {
      /* runner not running; iViz shows Route mode as unavailable data */
    }
  })();
}, 2000);

const wss = new WebSocketServer({
  port,
  handleProtocols: (protocols) => server.handleProtocols(protocols),
});
wss.on("listening", () => console.log(`[mock] foxglove ws server on ws://localhost:${port}`));
const sockets = new Set<import("ws").WebSocket>();
wss.on("connection", (conn, req) => {
  const name = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
  console.log(`[mock] client connected ${name}`);
  sockets.add(conn);
  conn.on("close", () => sockets.delete(conn));
  server.handleConnection(conn as unknown as IWebSocket, name);
});

/**
 * The connection graph a real bridge sends: the topics something publishes
 * right now. /mock_inactive is advertised but never published, so iViz can be
 * checked to hide topics that have no publisher.
 */
const PUBLISHED_TOPICS = [
  "/tf",
  "/tf_static",
  "/Odometry",
  "/scan",
  "/cloud_registered",
  "/livox/lidar",
  "/map",
  "/local_costmap/costmap",
  "/plan",
  "/local_costmap/published_footprint",
  "/amcl_pose",
];
setInterval(() => {
  if (sockets.size === 0) return;
  const update = JSON.stringify({
    op: "connectionGraphUpdate",
    publishedTopics: PUBLISHED_TOPICS.map((name) => ({ name, publisherIds: ["mock"] })),
    subscribedTopics: [],
    advertisedServices: [],
    removedTopics: [],
    removedServices: [],
  });
  for (const socket of sockets) socket.send(update);
}, 1000);

// ---------------------------------------------------------------------------
// World

const ROOM = 6; // half-size, meters
const CEIL = 3;
const PILLARS = [
  { x: 2, y: 2, r: 0.4 },
  { x: -3, y: 1, r: 0.5 },
  { x: 1, y: -3.5, r: 0.3 },
];
const DRIFT = { x: 0.3, y: -0.15 }; // map -> odom offset

function nowStamp() {
  const ms = Date.now();
  return { sec: Math.floor(ms / 1000), nanosec: (ms % 1000) * 1e6 };
}
function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n;
}
function robotPose(): { x: number; y: number; yaw: number } {
  return nav2.pose();
}
function yawQ(yaw: number) {
  return { x: 0, y: 0, z: Math.sin(yaw / 2), w: Math.cos(yaw / 2) };
}

/** Ray from (ox,oy) direction (dx,dy) against room walls and pillars, returns distance. */
function castRay2D(ox: number, oy: number, dx: number, dy: number): number {
  let best = Infinity;
  if (dx > 1e-9) best = Math.min(best, (ROOM - ox) / dx);
  if (dx < -1e-9) best = Math.min(best, (-ROOM - ox) / dx);
  if (dy > 1e-9) best = Math.min(best, (ROOM - oy) / dy);
  if (dy < -1e-9) best = Math.min(best, (-ROOM - oy) / dy);
  for (const p of PILLARS) {
    const fx = ox - p.x;
    const fy = oy - p.y;
    const b = 2 * (fx * dx + fy * dy);
    const c = fx * fx + fy * fy - p.r * p.r;
    const disc = b * b - 4 * c;
    if (disc < 0) continue;
    const t = (-b - Math.sqrt(disc)) / 2;
    if (t > 0 && t < best) best = t;
  }
  return best;
}

/** 3D ray against the room box (floor z=0, ceiling z=CEIL, walls, pillars). Returns [t, surface]. */
function castRay3D(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): [number, "wall" | "floor" | "ceil" | "pillar"] {
  let best = Infinity;
  let surf: "wall" | "floor" | "ceil" | "pillar" = "wall";
  const horiz = castRay2D(ox, oy, dx, dy);
  const hlen = Math.hypot(dx, dy);
  if (hlen > 1e-9 && Number.isFinite(horiz)) {
    best = horiz / hlen;
    // Was it a pillar?
    const hx = ox + dx * best;
    const hy = oy + dy * best;
    surf = Math.abs(Math.abs(hx) - ROOM) < 1e-3 || Math.abs(Math.abs(hy) - ROOM) < 1e-3 ? "wall" : "pillar";
  }
  if (dz < -1e-9) {
    const t = (0 - oz) / dz;
    if (t < best) {
      best = t;
      surf = "floor";
    }
  } else if (dz > 1e-9) {
    const t = (CEIL - oz) / dz;
    if (t < best) {
      best = t;
      surf = "ceil";
    }
  }
  return [best, surf];
}

function send(id: number, schema: SchemaName, msg: unknown): void {
  if (!subscribed.has(id)) return;
  const bytes = writer(schema).writeMessage(msg);
  server.sendMessage(id, nowNs(), bytes as unknown as BufferSource);
}

// ---------------------------------------------------------------------------
// Publishers

// /tf 30 Hz, /Odometry 30 Hz
setInterval(() => {
  const { x, y, yaw } = robotPose();
  const stamp = nowStamp();
  send(ch.tf, "tf2_msgs/msg/TFMessage", {
    transforms: [
      ...(localized
        ? [
            {
              header: { stamp, frame_id: "map" },
              child_frame_id: "odom",
              transform: { translation: { x: DRIFT.x, y: DRIFT.y, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
            },
          ]
        : []),
      {
        header: { stamp, frame_id: "odom" },
        child_frame_id: "base_link",
        transform: { translation: { x: x - DRIFT.x, y: y - DRIFT.y, z: 0 }, rotation: yawQ(yaw) },
      },
    ],
  });
  send(ch.odom, "nav_msgs/msg/Odometry", {
    header: { stamp, frame_id: "map" },
    child_frame_id: "base_link",
    pose: { pose: { position: { x, y, z: 0 }, orientation: yawQ(yaw) }, covariance: new Array(36).fill(0) },
    twist: { twist: { linear: { x: 0.5, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0.15 } }, covariance: new Array(36).fill(0) },
  });
}, 33);

// /tf_static 1 Hz
setInterval(() => {
  const stamp = nowStamp();
  send(ch.tfStatic, "tf2_msgs/msg/TFMessage", {
    transforms: [
      {
        header: { stamp, frame_id: "base_link" },
        child_frame_id: "laser",
        transform: { translation: { x: 0.2, y: 0, z: 0.3 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
      },
      {
        header: { stamp, frame_id: "base_link" },
        child_frame_id: "livox_frame",
        transform: { translation: { x: 0.1, y: 0, z: 0.5 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
      },
    ],
  });
}, 1000);

// /scan 10 Hz
setInterval(() => {
  const { x, y, yaw } = robotPose();
  const n = 360;
  const angleMin = -Math.PI;
  const inc = (2 * Math.PI) / n;
  const ranges = new Float32Array(n);
  const intens = new Float32Array(n);
  const lx = x + 0.2 * Math.cos(yaw);
  const ly = y + 0.2 * Math.sin(yaw);
  for (let i = 0; i < n; i++) {
    const a = yaw + angleMin + i * inc;
    const r = castRay2D(lx, ly, Math.cos(a), Math.sin(a)) + (Math.random() - 0.5) * 0.02;
    ranges[i] = r > 12 ? Infinity : r;
    intens[i] = 100 + Math.random() * 50;
  }
  send(ch.scan, "sensor_msgs/msg/LaserScan", {
    header: { stamp: nowStamp(), frame_id: "laser" },
    angle_min: angleMin,
    angle_max: angleMin + inc * (n - 1),
    angle_increment: inc,
    time_increment: 0,
    scan_time: 0.1,
    range_min: 0.1,
    range_max: 12,
    ranges,
    intensities: intens,
  });
}, 100);

// /cloud_registered (PointCloud2 in map) and /livox/lidar (CustomMsg in livox_frame) 10 Hz
setInterval(() => {
  if (!subscribed.has(ch.cloud) && !subscribed.has(ch.livox)) return;
  const { x, y, yaw } = robotPose();
  const oz = 0.5;
  const ox = x + 0.1 * Math.cos(yaw);
  const oy = y + 0.1 * Math.sin(yaw);
  const N = 6000;
  const world = new Float32Array(N * 4);
  let k = 0;
  for (let i = 0; i < N; i++) {
    // Livox-like non-repetitive pattern: random within a 70° x 70° FOV in front
    const az = yaw + (Math.random() - 0.5) * (70 * Math.PI) / 180;
    const el = (Math.random() - 0.5) * (70 * Math.PI) / 180;
    const dx = Math.cos(el) * Math.cos(az);
    const dy = Math.cos(el) * Math.sin(az);
    const dz = Math.sin(el);
    const [t, surf] = castRay3D(ox, oy, oz, dx, dy, dz);
    if (!Number.isFinite(t) || t > 40) continue;
    const noise = (Math.random() - 0.5) * 0.02;
    world[k * 4] = ox + dx * (t + noise);
    world[k * 4 + 1] = oy + dy * (t + noise);
    world[k * 4 + 2] = oz + dz * (t + noise);
    const base = surf === "floor" ? 20 : surf === "ceil" ? 35 : surf === "pillar" ? 90 : 60;
    world[k * 4 + 3] = base + Math.random() * 15;
    k++;
  }
  const stamp = nowStamp();

  if (subscribed.has(ch.cloud)) {
    const buf = new Uint8Array(k * 16);
    const dv = new DataView(buf.buffer);
    for (let i = 0; i < k; i++) {
      dv.setFloat32(i * 16, world[i * 4]!, true);
      dv.setFloat32(i * 16 + 4, world[i * 4 + 1]!, true);
      dv.setFloat32(i * 16 + 8, world[i * 4 + 2]!, true);
      dv.setFloat32(i * 16 + 12, world[i * 4 + 3]!, true);
    }
    send(ch.cloud, "sensor_msgs/msg/PointCloud2", {
      header: { stamp, frame_id: "map" },
      height: 1,
      width: k,
      fields: [
        { name: "x", offset: 0, datatype: 7, count: 1 },
        { name: "y", offset: 4, datatype: 7, count: 1 },
        { name: "z", offset: 8, datatype: 7, count: 1 },
        { name: "intensity", offset: 12, datatype: 7, count: 1 },
      ],
      is_bigendian: false,
      point_step: 16,
      row_step: k * 16,
      data: buf,
      is_dense: true,
    });
  }

  if (subscribed.has(ch.livox)) {
    // Transform world points into livox_frame (inverse of sensor pose).
    const c = Math.cos(-yaw);
    const s = Math.sin(-yaw);
    const points = [];
    for (let i = 0; i < k; i++) {
      const wx = world[i * 4]! - ox;
      const wy = world[i * 4 + 1]! - oy;
      const wz = world[i * 4 + 2]! - oz;
      points.push({
        offset_time: i * 1000,
        x: c * wx - s * wy,
        y: s * wx + c * wy,
        z: wz,
        reflectivity: Math.min(255, Math.round(world[i * 4 + 3]! * 2)),
        tag: 0,
        line: i % 4,
      });
    }
    send(ch.livox, "livox_ros_driver2/msg/CustomMsg", {
      header: { stamp, frame_id: "livox_frame" },
      timebase: nowNs(),
      point_num: points.length,
      lidar_id: 0,
      rsvd: [0, 0, 0],
      points,
    });
  }
}, 100);

// /map 1 Hz (static)
const MAP_RES = 0.05;
const MAP_W = Math.round((2 * ROOM) / MAP_RES) + 20;
const MAP_H = MAP_W;
const MAP_ORIGIN = -ROOM - 10 * MAP_RES;
const mapData = new Int8Array(MAP_W * MAP_H);
for (let j = 0; j < MAP_H; j++) {
  for (let i = 0; i < MAP_W; i++) {
    const wx = MAP_ORIGIN + (i + 0.5) * MAP_RES;
    const wy = MAP_ORIGIN + (j + 0.5) * MAP_RES;
    let v = 0;
    if (Math.abs(wx) > ROOM || Math.abs(wy) > ROOM) v = -1;
    if (Math.abs(Math.abs(wx) - ROOM) < MAP_RES && Math.abs(wy) <= ROOM + MAP_RES) v = 100;
    if (Math.abs(Math.abs(wy) - ROOM) < MAP_RES && Math.abs(wx) <= ROOM + MAP_RES) v = 100;
    for (const p of PILLARS) if (Math.hypot(wx - p.x, wy - p.y) <= p.r) v = 100;
    mapData[j * MAP_W + i] = v;
  }
}
function mapMessage(): Record<string, unknown> {
  return {
    header: { stamp: nowStamp(), frame_id: "map" },
    info: {
      map_load_time: nowStamp(),
      resolution: MAP_RES,
      width: MAP_W,
      height: MAP_H,
      origin: { position: { x: MAP_ORIGIN, y: MAP_ORIGIN, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
    },
    data: mapData,
  };
}

// `--map-once` imitates a latched map_server: the map goes out once, so a
// client that connects later never receives it and has to call GetMap.
const MAP_ONCE = process.argv.includes("--map-once");
let mapSent = false;
setInterval(() => {
  if (MAP_ONCE && mapSent) return;
  mapSent = true;
  send(ch.map, "nav_msgs/msg/OccupancyGrid", mapMessage());
}, 1000);

// /local_costmap/costmap 5 Hz (odom frame, rolling window around robot)
setInterval(() => {
  if (!subscribed.has(ch.costmap)) return;
  const { x, y } = robotPose();
  const res = 0.05;
  const w = 80;
  const ox = x - (w * res) / 2;
  const oy = y - (w * res) / 2;
  const data = new Int8Array(w * w);
  for (let j = 0; j < w; j++) {
    for (let i = 0; i < w; i++) {
      const wx = ox + (i + 0.5) * res;
      const wy = oy + (j + 0.5) * res;
      let d = Math.min(ROOM - Math.abs(wx), ROOM - Math.abs(wy));
      for (const p of PILLARS) d = Math.min(d, Math.hypot(wx - p.x, wy - p.y) - p.r);
      let v = 0;
      if (d <= 0.05) v = 100;
      else if (d < 0.3) v = 99;
      else if (d < 0.9) v = Math.round(98 * (1 - (d - 0.3) / 0.6));
      data[j * w + i] = v;
    }
  }
  send(ch.costmap, "nav_msgs/msg/OccupancyGrid", {
    header: { stamp: nowStamp(), frame_id: "odom" },
    info: {
      map_load_time: nowStamp(),
      resolution: res,
      width: w,
      height: w,
      origin: { position: { x: ox - DRIFT.x, y: oy - DRIFT.y, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
    },
    data,
  });
}, 200);

// /plan 2 Hz, /footprint 5 Hz, /amcl_pose 2 Hz
setInterval(() => {
  const stamp = nowStamp();
  const planned = nav2.plan();
  if (planned) {
    const poses = planned.map((p) => ({ header: { stamp, frame_id: "map" }, pose: { position: { x: p.x, y: p.y, z: 0 }, orientation: yawQ(p.yaw) } }));
    send(ch.plan, "nav_msgs/msg/Path", { header: { stamp, frame_id: "map" }, poses });
  }

  const { x, y, yaw } = robotPose();
  send(ch.amcl, "geometry_msgs/msg/PoseWithCovarianceStamped", {
    header: { stamp, frame_id: "map" },
    pose: {
      pose: { position: { x: x + (Math.random() - 0.5) * 0.05, y: y + (Math.random() - 0.5) * 0.05, z: 0 }, orientation: yawQ(yaw) },
      covariance: new Array(36).fill(0),
    },
  });
}, 500);

setInterval(() => {
  send(ch.footprint, "geometry_msgs/msg/PolygonStamped", {
    header: { stamp: nowStamp(), frame_id: "base_link" },
    polygon: {
      points: [
        { x: 0.35, y: 0.25, z: 0 },
        { x: 0.35, y: -0.25, z: 0 },
        { x: -0.35, y: -0.25, z: 0 },
        { x: -0.35, y: 0.25, z: 0 },
      ],
    },
  });
}, 200);

// `--ask` publishes a question on the shared request topic every 25 s, so iViz
// can be tried as the answering side of the ask/answer contract. Answers show
// up in this log, because any client publish is decoded and printed.
if (process.argv.includes("--ask")) {
  let asked = 0;
  setInterval(() => {
    asked += 1;
    const id = `mock-${asked}`;
    console.log(`[mock] asking on /iviz/request: ${id}`);
    send(ch.askRequest, "std_msgs/msg/String", {
      data: JSON.stringify({
        id,
        text: "Part placed on the fixture?",
        options: ["Continue", "Stop"],
        default: "Continue",
        station: "Station A",
        source: "mock",
        timeout_s: 120,
      }),
    });
  }, 25_000);
}
