/**
 * Runs Nav2 tasks started from iViz and follows every goal on the robot.
 *
 * A task is a nav goal, a list of waypoints (FollowWaypoints or
 * NavigateThroughPoses) or a drawn path (FollowPath). Pause cancels the goal
 * on the robot but keeps the task and how far it got; Resume sends what is
 * left: the same goal, the waypoint the robot was heading to and the ones
 * after it, or the path from the point nearest to where the robot stands.
 * That works with any Nav2 setup and never touches the lifecycle of the
 * navigation stack.
 *
 * Cancel stops every goal on the four action servers, including goals sent
 * by RViz, scripts or a mission runner.
 */

import { ActionClient } from "../net/ActionClient";
import type { GoalHandle, GoalOutcome } from "../net/ActionClient";
import type { FoxgloveConnection } from "../net/FoxgloveConnection";

export interface Pose2D {
  x: number;
  y: number;
  yaw: number;
}

export type TaskKind = "goal" | "waypoints" | "through" | "path";

export interface NavTask {
  kind: TaskKind;
  /** Frame the poses are expressed in. */
  frame: string;
  /** Goal poses; for a path, the densified path. */
  poses: Pose2D[];
  loop: boolean;
  controllerId: string;
  goalCheckerId: string;
  progressCheckerId: string;
}

export type NavPhase = "idle" | "starting" | "running" | "canceling" | "paused" | "succeeded" | "canceled" | "aborted" | "rejected" | "error";

const FINISHED_PHASES: ReadonlySet<NavPhase> = new Set(["succeeded", "canceled", "aborted", "rejected", "error"]);

export interface NavProgress {
  /** Index into `task.poses` of the pose the robot is driving to. */
  index: number;
  distanceRemaining?: number;
  etaSec?: number;
  recoveries?: number;
  speed?: number;
  /** Completed laps of a looping waypoint task. */
  lap: number;
}

export interface NavActionNames {
  navigateToPose: string;
  followWaypoints: string;
  navigateThroughPoses: string;
  followPath: string;
}

export interface NavControllerOptions {
  conn: FoxgloveConnection;
  actions: () => NavActionNames;
  /** Where the robot is in `frame`, used to resume a path. */
  robotPose: (frame: string) => Pose2D | undefined;
}

export const KIND_LABEL: Record<TaskKind, string> = {
  goal: "Nav goal",
  waypoints: "Waypoints",
  through: "Through poses",
  path: "Follow path",
};

const KIND_ACTION: Record<TaskKind, keyof NavActionNames> = {
  goal: "navigateToPose",
  waypoints: "followWaypoints",
  through: "navigateThroughPoses",
  path: "followPath",
};

type Msg = Record<string, unknown>;
type Client = ActionClient<unknown, Msg, Msg>;
type Handle = GoalHandle<Msg, Msg>;

export class NavController {
  phase: NavPhase = "idle";
  task?: NavTask;
  progress: NavProgress = { index: 0, lap: 0 };
  message = "";

  #opts: NavControllerOptions;
  #clients = new Map<string, Client>();
  #client?: Client;
  #handle?: Handle;
  /** Bumped for every goal sent; stale callbacks compare against it. */
  #run = 0;
  #startIndex = 0;
  #pauseRequested = false;
  #listeners = new Set<() => void>();

  constructor(opts: NavControllerOptions) {
    this.#opts = opts;
    this.refreshActions();
    opts.conn.onServicesChange(() => this.#emit());
    opts.conn.onStateChange((state) => {
      // A finished task belongs to the robot it ran on. A paused one is kept,
      // so it can be resumed after a reconnect.
      if (state === "disconnected" && FINISHED_PHASES.has(this.phase)) this.dismiss();
      this.#emit();
    });
  }

  onChange(l: () => void): () => void {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }

  /** Re-read the action names from the settings. */
  refreshActions(): void {
    const a = this.#opts.actions();
    const names = new Set([a.navigateToPose, a.followWaypoints, a.navigateThroughPoses, a.followPath].map(normalizeName));
    for (const [name, client] of this.#clients) {
      if (names.has(name) || client === this.#client) continue;
      client.dispose();
      this.#clients.delete(name);
    }
    for (const name of names) this.#clientFor(name);
    this.#emit();
  }

  actionName(kind: TaskKind): string {
    return normalizeName(this.#opts.actions()[KIND_ACTION[kind]]);
  }

  /** Empty when `kind` can be started, otherwise why not. */
  unavailableReason(kind: TaskKind): string {
    const conn = this.#opts.conn;
    if (conn.state !== "connected") return "Not connected";
    if (!conn.supportsServices) return "This bridge cannot call services";
    const client = this.#clientFor(this.actionName(kind));
    if (client.available) return "";
    if (!conn.services.some((s) => s.name.includes("/_action/"))) return "foxglove_bridge hides Nav2 actions: restart it with include_hidden:=true";
    return `No ${client.name} action server on the robot`;
  }

  get active(): boolean {
    return this.phase === "starting" || this.phase === "running" || this.phase === "canceling";
  }

  /** Goals running on the robot that iViz did not start. */
  get foreignGoals(): number {
    let n = 0;
    for (const c of this.#clients.values()) n += c.activeGoalCount;
    const own = this.#handle && !this.#handle.finished && this.#handle.state !== "pending" ? 1 : 0;
    return Math.max(0, n - own);
  }

  get canPause(): boolean {
    return this.phase === "starting" || this.phase === "running";
  }
  get canResume(): boolean {
    return this.phase === "paused";
  }
  get canCancel(): boolean {
    return this.active || this.phase === "paused" || this.foreignGoals > 0;
  }

  async start(task: NavTask): Promise<void> {
    if (task.poses.length === 0) throw new Error("Nothing to drive to");
    const reason = this.unavailableReason(task.kind);
    if (reason) throw new Error(reason);
    // A goal on another action server does not preempt the running one.
    const previous = this.#handle;
    const previousClient = this.#client;
    const nextClient = this.#clientFor(this.actionName(task.kind));
    if (previous && previousClient && !previous.finished && previousClient !== nextClient) {
      previousClient.cancel(previous).catch(() => undefined);
    }
    this.task = task;
    this.progress = { index: 0, lap: 0 };
    this.#pauseRequested = false;
    await this.#send(0);
  }

  pause(): void {
    if (!this.canPause) return;
    this.#pauseRequested = true;
    this.#setPhase("canceling", "Pausing…");
    const handle = this.#handle;
    const client = this.#client;
    // While the goal is still being sent, #send cancels it once it is accepted.
    if (handle && client && !handle.finished) client.cancel(handle).catch((err) => this.#fail(err));
  }

  async resume(): Promise<void> {
    if (!this.canResume || !this.task) return;
    this.#pauseRequested = false;
    await this.#send(this.#resumeIndex());
  }

  async cancel(): Promise<void> {
    this.#pauseRequested = false;
    if (this.phase === "paused") {
      this.#run++;
      this.#setPhase("canceled", "Canceled");
    } else if (this.active) {
      this.#setPhase("canceling", "Canceling…");
    }
    const targets = [...this.#clients.values()].filter((c) => c.available && (c.activeGoalCount > 0 || c === this.#client));
    const results = await Promise.allSettled(targets.map((c) => c.cancelAll()));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) this.#fail(failed.reason);
  }

  /** Forget a finished task. */
  dismiss(): void {
    if (this.active || this.phase === "paused") return;
    this.task = undefined;
    this.progress = { index: 0, lap: 0 };
    this.#setPhase("idle", "");
  }

  dispose(): void {
    this.#run++;
    for (const c of this.#clients.values()) c.dispose();
    this.#clients.clear();
    this.#listeners.clear();
  }

  // ----- internals ---------------------------------------------------------

  #clientFor(name: string): Client {
    let client = this.#clients.get(name);
    if (!client) {
      client = new ActionClient<unknown, Msg, Msg>(this.#opts.conn, name);
      client.onStatusChange(() => this.#emit());
      this.#clients.set(name, client);
    }
    return client;
  }

  async #send(startIndex: number): Promise<void> {
    const task = this.task;
    if (!task) return;
    const run = ++this.#run;
    this.#startIndex = startIndex;
    this.progress = { index: startIndex, lap: this.progress.lap };
    this.#setPhase("starting", startIndex > 0 ? `Resuming from ${this.#stepLabel(task, startIndex)}` : "Sending goal…");

    const client = this.#clientFor(this.actionName(task.kind));
    this.#client = client;
    this.#handle = undefined;
    let handle: Handle;
    try {
      handle = await client.sendGoal(buildGoal(task, startIndex));
    } catch (err) {
      if (run === this.#run) this.#fail(err);
      return;
    }
    if (run !== this.#run) {
      if (!handle.finished) client.cancel(handle).catch(() => undefined);
      return;
    }
    this.#handle = handle;
    if (handle.state === "rejected") {
      this.#setPhase("rejected", `${client.name} rejected the goal`);
      return;
    }
    if (this.#pauseRequested) client.cancel(handle).catch((err) => this.#fail(err));
    else this.#setPhase("running", "");

    handle.onUpdate(() => {
      if (run !== this.#run) return;
      if (handle.state === "canceling" && this.phase === "running") this.#setPhase("canceling", "Canceling…");
      this.#onFeedback(task, handle);
    });
    const outcome = await handle.done;
    if (run !== this.#run) return;
    this.#onOutcome(task, outcome);
  }

  #onFeedback(task: NavTask, handle: Handle): void {
    const f = handle.feedback;
    if (!f) return;
    const last = task.poses.length - 1;
    const p: NavProgress = { ...this.progress };
    switch (task.kind) {
      case "goal":
      case "through": {
        p.distanceRemaining = num(f.distance_remaining);
        p.etaSec = duration(f.estimated_time_remaining);
        p.recoveries = num(f.number_of_recoveries);
        const remaining = num(f.number_of_poses_remaining);
        if (task.kind === "through" && remaining !== undefined) p.index = clamp(task.poses.length - remaining, this.#startIndex, last);
        break;
      }
      case "waypoints": {
        const current = num(f.current_waypoint);
        if (current !== undefined) p.index = clamp(this.#startIndex + current, 0, last);
        break;
      }
      case "path": {
        p.distanceRemaining = num(f.distance_to_goal);
        p.speed = num(f.speed);
        const pose = this.#opts.robotPose(task.frame);
        if (pose) p.index = nearestIndex(task.poses, pose, p.index);
        break;
      }
    }
    this.progress = p;
    this.#emit();
  }

  #onOutcome(task: NavTask, outcome: GoalOutcome<Msg>): void {
    const result = outcome.result;
    switch (outcome.state) {
      case "succeeded": {
        if (task.kind === "waypoints" && task.loop && !this.#pauseRequested) {
          this.progress = { index: 0, lap: this.progress.lap + 1 };
          void this.#send(0);
          return;
        }
        const missed = Array.isArray(result?.missed_waypoints) ? result.missed_waypoints.length : 0;
        this.progress = { ...this.progress, index: task.poses.length - 1, distanceRemaining: 0, etaSec: 0 };
        this.#setPhase("succeeded", missed > 0 ? `Finished, ${missed} waypoint${missed === 1 ? "" : "s"} missed` : "Arrived");
        return;
      }
      case "canceled":
      case "aborted":
        if (this.#pauseRequested) {
          this.#pauseRequested = false;
          this.#setPhase("paused", `Paused before ${this.#stepLabel(task, this.progress.index)}`);
        } else if (outcome.state === "canceled") {
          this.#setPhase("canceled", "Canceled");
        } else {
          this.#setPhase("aborted", errorText(result) || "Nav2 aborted the goal");
        }
        return;
      case "rejected":
        this.#setPhase("rejected", "The goal was rejected");
        return;
      default:
        this.#setPhase("error", `Lost track of the goal${outcome.note ? `: ${outcome.note}` : ""}`);
    }
  }

  #resumeIndex(): number {
    const task = this.task!;
    if (task.kind === "goal") return 0;
    if (task.kind === "path") {
      const pose = this.#opts.robotPose(task.frame);
      return pose ? nearestIndex(task.poses, pose, 0) : this.progress.index;
    }
    return clamp(this.progress.index, 0, task.poses.length - 1);
  }

  #stepLabel(task: NavTask, index: number): string {
    if (task.kind === "goal") return "the goal";
    if (task.kind === "path") return `${Math.round((index / Math.max(1, task.poses.length - 1)) * 100)}% of the path`;
    return `waypoint ${index + 1} of ${task.poses.length}`;
  }

  #fail(err: unknown): void {
    this.#pauseRequested = false;
    this.#setPhase("error", err instanceof Error ? err.message : String(err));
  }

  #setPhase(phase: NavPhase, message: string): void {
    this.phase = phase;
    this.message = message;
    this.#emit();
  }

  #emit(): void {
    for (const l of this.#listeners) l();
  }
}

// ---------------------------------------------------------------------------
// Goal messages

/**
 * Time zero means "the latest transform" to tf2, so goals are not rejected
 * when the PC clock and the robot clock disagree.
 */
const STAMP_ZERO = { sec: 0, nanosec: 0 };

function poseStamped(frame: string, p: Pose2D) {
  return {
    header: { stamp: STAMP_ZERO, frame_id: frame },
    pose: {
      position: { x: p.x, y: p.y, z: 0 },
      orientation: { x: 0, y: 0, z: Math.sin(p.yaw / 2), w: Math.cos(p.yaw / 2) },
    },
  };
}

/**
 * Build the goal for the part of a task from `startIndex` on. Fields a Nav2
 * version does not have are simply not serialized, so one object fits Jazzy
 * and later releases.
 */
export function buildGoal(task: NavTask, startIndex: number): Msg {
  const poses = task.poses.slice(startIndex).map((p) => poseStamped(task.frame, p));
  switch (task.kind) {
    case "goal":
      return { pose: poseStamped(task.frame, task.poses[0]!), behavior_tree: "" };
    case "waypoints":
      return { number_of_loops: 0, goal_index: 0, poses };
    case "through":
      return { poses, behavior_tree: "", goals: { header: { stamp: STAMP_ZERO, frame_id: task.frame }, goals: poses } };
    case "path":
      return {
        path: { header: { stamp: STAMP_ZERO, frame_id: task.frame }, poses },
        controller_id: task.controllerId,
        goal_checker_id: task.goalCheckerId,
        progress_checker_id: task.progressCheckerId,
      };
  }
}

// ---------------------------------------------------------------------------
// Geometry

/** Resample a polyline every `step` metres, heading along the line. */
export function densifyPath(vertices: Pose2D[], step = 0.05): Pose2D[] {
  if (vertices.length < 2) return vertices.map((v) => ({ ...v }));
  const out: Pose2D[] = [];
  for (let i = 0; i < vertices.length - 1; i++) {
    const a = vertices[i]!;
    const b = vertices[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-6) continue;
    const yaw = Math.atan2(b.y - a.y, b.x - a.x);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n, yaw });
  }
  const last = vertices[vertices.length - 1]!;
  out.push({ x: last.x, y: last.y, yaw: out.length ? out[out.length - 1]!.yaw : last.yaw });
  return out;
}

export function pathLength(points: Pose2D[]): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  return d;
}

function nearestIndex(points: Pose2D[], p: Pose2D, from: number): number {
  let best = clamp(from, 0, points.length - 1);
  let bestD = Infinity;
  for (let i = Math.max(0, from - 20); i < points.length; i++) {
    const d = (points[i]!.x - p.x) ** 2 + (points[i]!.y - p.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  return undefined;
}

function duration(v: unknown): number | undefined {
  if (!v || typeof v !== "object") return undefined;
  const d = v as { sec?: unknown; nanosec?: unknown; nsec?: unknown };
  const sec = num(d.sec);
  if (sec === undefined) return undefined;
  return sec + (num(d.nanosec) ?? num(d.nsec) ?? 0) * 1e-9;
}

function normalizeName(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function errorText(result: Msg | undefined): string {
  if (!result) return "";
  const msg = typeof result.error_msg === "string" ? result.error_msg.trim() : "";
  if (msg) return msg;
  const code = num(result.error_code);
  return code ? `Nav2 error code ${code}` : "";
}
