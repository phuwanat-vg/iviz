/**
 * The whole mission_runner API over the one connection iViz already has.
 *
 * `mission_runner` advertises the ROS service `/mission/api`
 * (`mission_msgs/srv/Api`): `{method, path, body_json}` -> `{ok, status,
 * body_json, message}`, where `path` and the bodies are exactly the HTTP API in
 * Mission/docs/runner-api.md. Live state arrives on `/mission/state` and
 * `/mission/event`, both `std_msgs/msg/String` carrying JSON.
 *
 * Everything here degrades cleanly: when the bridge has no `services`
 * capability or does not advertise `/mission/api`, `available` is false and
 * `unavailableReason` says why. iViz stays a viewer.
 */

import type { FoxgloveConnection } from "../net/FoxgloveConnection";
import type { Mission, Path, SitesDoc } from "./types";

export const MISSION_API_SERVICE = "/mission/api";
export const MISSION_STATE_TOPIC = "/mission/state";
export const MISSION_EVENT_TOPIC = "/mission/event";

// ---- API shapes (runner-api.md) --------------------------------------------

export type RunStatus = "queued" | "running" | "paused" | "suspended" | "succeeded" | "failed" | "canceled";

export interface RobotState {
  x: number;
  y: number;
  yaw_deg: number;
  frame?: string;
  battery?: number | null;
  nav_active?: boolean;
}

export interface StepRef {
  id: string;
  name?: string;
  path?: Path;
  started_at?: string;
}

export interface Feedback {
  distance_remaining?: number;
  recoveries?: number;
  eta_s?: number;
}

export interface Run {
  id: string;
  mission: string;
  inputs?: Record<string, unknown>;
  source?: { kind: string; id?: string; detail?: string };
  priority?: number;
  status: RunStatus;
  started_at?: string | null;
  finished_at?: string | null;
  step?: StepRef | null;
  error?: string;
  feedback?: Feedback | null;
}

export interface Prompt {
  id: string;
  run_id?: string;
  mission?: string;
  text: string;
  options: string[];
  default?: string | null;
  expires_at?: string | null;
}

export interface ConnectorState {
  type: string;
  connected?: boolean;
  config?: Record<string, unknown>;
}

export interface RunnerStatus {
  runner?: { version?: string; uptime_s?: number; backend?: string; home?: string };
  state: "idle" | "running" | "paused";
  run: Run | null;
  queue?: Run[];
  suspended?: Run[];
  robot?: RobotState | null;
  current_map?: string | null;
  connectors?: Record<string, ConnectorState>;
  prompt?: Prompt | null;
}

export interface ApiFinding {
  path?: Path;
  message: string;
}

export interface MissionSummary {
  name: string;
  title?: string;
  description?: string;
  version?: number;
  updated_at?: string;
  triggers?: string[];
  interrupts?: string[];
  steps?: number;
  sha256?: string;
  state?: "idle" | "running" | "queued" | "suspended";
  trigger_problems?: string[];
  errors?: ApiFinding[];
}

export interface CapabilityInfo {
  available: boolean;
  reason?: string;
}

export interface Capabilities {
  backend?: string;
  steps?: Record<string, CapabilityInfo>;
  triggers?: Record<string, CapabilityInfo>;
  connectors?: string[];
  ros_distro?: string;
}

export interface SaveResult {
  ok: boolean;
  name?: string;
  version?: number;
  sha256?: string;
  warnings?: ApiFinding[];
  errors?: ApiFinding[];
}

export interface RunAccepted {
  accepted: boolean;
  run_id?: string;
  reason?: string;
}

/** One `/mission/event` message. Fields depend on `type` (see runner-api.md). */
export interface RunnerEvent {
  type: string;
  run?: Run;
  run_id?: string;
  step_id?: string;
  path?: Path;
  name?: string;
  step_type?: string;
  result?: { ok: boolean; status: string; error?: string };
  feedback?: Feedback;
  prompt?: Prompt;
  answer?: string;
  names?: string[];
  t?: string;
  level?: string;
  text?: string;
}

/** An error the runner reported, carrying its HTTP status and findings. */
export class MissionApiError extends Error {
  readonly status: number;
  readonly errors: ApiFinding[];
  constructor(message: string, status: number, errors: ApiFinding[] = []) {
    super(message);
    this.name = "MissionApiError";
    this.status = status;
    this.errors = errors;
  }
}

interface ApiResponse {
  ok: boolean;
  status: number;
  body_json: string;
  message: string;
}

type Listener<T> = (value: T) => void;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class MissionApi {
  readonly #conn: FoxgloveConnection;
  #available = false;
  #availabilityListeners = new Set<Listener<boolean>>();
  #statusListeners = new Set<Listener<RunnerStatus>>();
  #eventListeners = new Set<Listener<RunnerEvent>>();
  #unsubState?: () => void;
  #unsubEvent?: () => void;
  #lastStatus: RunnerStatus | null = null;

  constructor(conn: FoxgloveConnection) {
    this.#conn = conn;
    conn.onServicesChange(() => this.#refreshAvailability());
    conn.onStateChange(() => this.#refreshAvailability());
    this.#available = this.#compute();
  }

  /** True when `/mission/api` can be called right now. */
  get available(): boolean {
    return this.#available;
  }

  /** Why Route mode is off, or "" when it is on. */
  get unavailableReason(): string {
    if (this.#conn.state !== "connected") return "Not connected to a bridge.";
    if (!this.#conn.supportsServices) return "This bridge does not advertise the services capability, so mission_runner cannot be reached.";
    if (!this.#conn.hasService(MISSION_API_SERVICE)) return `The bridge does not advertise ${MISSION_API_SERVICE}. Start mission_runner (with mission_msgs built) on the robot.`;
    return "";
  }

  /** The most recent `/mission/state`, or null when none has arrived. */
  get lastStatus(): RunnerStatus | null {
    return this.#lastStatus;
  }

  onAvailabilityChange(l: Listener<boolean>): () => void {
    this.#availabilityListeners.add(l);
    return () => this.#availabilityListeners.delete(l);
  }
  onStatus(l: Listener<RunnerStatus>): () => void {
    this.#statusListeners.add(l);
    return () => this.#statusListeners.delete(l);
  }
  onEvent(l: Listener<RunnerEvent>): () => void {
    this.#eventListeners.add(l);
    return () => this.#eventListeners.delete(l);
  }

  /** Subscribe to `/mission/state` and `/mission/event`. Safe to call twice. */
  startLiveState(): void {
    if (!this.#unsubState) {
      this.#unsubState = this.#conn.subscribe(MISSION_STATE_TOPIC, (msg) => {
        const parsed = parseStringMessage(msg);
        if (!isRecord(parsed) || typeof parsed.state !== "string") return;
        const status = parsed as unknown as RunnerStatus;
        this.#lastStatus = status;
        for (const l of this.#statusListeners) l(status);
      });
    }
    if (!this.#unsubEvent) {
      this.#unsubEvent = this.#conn.subscribe(MISSION_EVENT_TOPIC, (msg) => {
        const parsed = parseStringMessage(msg);
        if (!isRecord(parsed) || typeof parsed.type !== "string") return;
        const ev = parsed as unknown as RunnerEvent;
        // The runner also streams full status snapshots as events.
        if (ev.type === "status" && typeof (parsed as { state?: unknown }).state === "string") {
          const status = parsed as unknown as RunnerStatus;
          this.#lastStatus = status;
          for (const l of this.#statusListeners) l(status);
        }
        for (const l of this.#eventListeners) l(ev);
      });
    }
  }

  stopLiveState(): void {
    this.#unsubState?.();
    this.#unsubEvent?.();
    this.#unsubState = undefined;
    this.#unsubEvent = undefined;
  }

  // ---- verbs --------------------------------------------------------------

  async get<T>(path: string): Promise<T> {
    return await this.#call<T>("GET", path);
  }
  async post<T>(path: string, body?: unknown): Promise<T> {
    return await this.#call<T>("POST", path, body);
  }
  async put<T>(path: string, body?: unknown): Promise<T> {
    return await this.#call<T>("PUT", path, body);
  }
  async del<T>(path: string, body?: unknown): Promise<T> {
    return await this.#call<T>("DELETE", path, body);
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const reason = this.unavailableReason;
    if (reason) throw new MissionApiError(reason, 0);
    let res: ApiResponse;
    try {
      res = await this.#conn.callService<ApiResponse>(MISSION_API_SERVICE, {
        method,
        path,
        body_json: body === undefined ? "" : JSON.stringify(body),
      });
    } catch (err) {
      throw new MissionApiError(err instanceof Error ? err.message : String(err), 0);
    }
    const status = Number(res.status) || 0;
    let parsed: unknown = undefined;
    if (typeof res.body_json === "string" && res.body_json !== "") {
      try {
        parsed = JSON.parse(res.body_json);
      } catch {
        if (res.ok !== false && status < 400) throw new MissionApiError(`${method} ${path} returned a body that is not JSON`, status);
      }
    }
    if (res.ok === false || status >= 400) {
      const detail = isRecord(parsed) && typeof parsed.error === "string" && parsed.error !== "" ? parsed.error : res.message || `${method} ${path} failed with ${status || "no status"}`;
      const errors = isRecord(parsed) && Array.isArray(parsed.errors) ? (parsed.errors as ApiFinding[]) : [];
      throw new MissionApiError(detail, status, errors);
    }
    return parsed as T;
  }

  // ---- typed helpers ------------------------------------------------------

  async status(): Promise<RunnerStatus> {
    return await this.get<RunnerStatus>("/api/status");
  }
  async missions(): Promise<MissionSummary[]> {
    const list = await this.get<MissionSummary[]>("/api/missions");
    return Array.isArray(list) ? list : [];
  }
  async mission(name: string): Promise<Mission> {
    return await this.get<Mission>(`/api/missions/${encodeURIComponent(name)}`);
  }
  async saveMission(doc: Mission): Promise<SaveResult> {
    return await this.put<SaveResult>(`/api/missions/${encodeURIComponent(doc.name)}`, doc);
  }
  async deleteMission(name: string): Promise<void> {
    await this.del<unknown>(`/api/missions/${encodeURIComponent(name)}`);
  }
  async validateMission(doc: Mission): Promise<SaveResult> {
    return await this.post<SaveResult>("/api/missions/validate", doc);
  }
  async sites(): Promise<SitesDoc> {
    return await this.get<SitesDoc>("/api/sites");
  }
  async saveSites(doc: SitesDoc): Promise<unknown> {
    return await this.put<unknown>("/api/sites", doc);
  }
  async robotPose(): Promise<{ x: number; y: number; yaw_deg: number; frame?: string }> {
    return await this.get("/api/robot/pose");
  }
  async connectors(): Promise<Record<string, ConnectorState>> {
    const c = await this.get<Record<string, ConnectorState>>("/api/connectors");
    return isRecord(c) ? c : {};
  }
  async capabilities(): Promise<Capabilities> {
    return await this.get<Capabilities>("/api/capabilities");
  }
  async run(name: string, inputs?: Record<string, unknown>): Promise<RunAccepted> {
    return await this.post<RunAccepted>(`/api/missions/${encodeURIComponent(name)}/run`, inputs ? { inputs } : {});
  }
  async stop(): Promise<unknown> {
    return await this.post<unknown>("/api/stop", {});
  }
  /** Pause the active run. Without an id the one from the last status is used. */
  async pause(runId?: string): Promise<unknown> {
    const id = runId ?? this.#lastStatus?.run?.id;
    if (!id) throw new MissionApiError("Nothing is running.", 0);
    return await this.post<unknown>(`/api/runs/${encodeURIComponent(id)}/pause`, {});
  }
  async resume(runId?: string): Promise<unknown> {
    const id = runId ?? this.#lastStatus?.run?.id;
    if (!id) throw new MissionApiError("Nothing is paused.", 0);
    return await this.post<unknown>(`/api/runs/${encodeURIComponent(id)}/resume`, {});
  }
  async answerPrompt(id: string, answer: string): Promise<unknown> {
    return await this.post<unknown>(`/api/prompt/${encodeURIComponent(id)}/answer`, { answer });
  }

  // ---- internals ----------------------------------------------------------

  #compute(): boolean {
    return this.#conn.state === "connected" && this.#conn.supportsServices && this.#conn.hasService(MISSION_API_SERVICE);
  }

  #refreshAvailability(): void {
    const now = this.#compute();
    if (now === this.#available) return;
    this.#available = now;
    if (!now) this.#lastStatus = null;
    for (const l of this.#availabilityListeners) l(now);
  }
}

/** Parse the JSON carried by a `std_msgs/msg/String` message. */
function parseStringMessage(msg: unknown): unknown {
  if (!isRecord(msg) || typeof msg.data !== "string" || msg.data === "") return undefined;
  try {
    return JSON.parse(msg.data);
  } catch {
    return undefined;
  }
}
