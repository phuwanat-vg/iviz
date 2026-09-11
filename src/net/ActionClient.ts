/**
 * A ROS 2 action client over foxglove_bridge.
 *
 * The WebSocket protocol has no actions, but every ROS 2 action is built from
 * hidden services and topics (see src/ros/nav2Schemas.ts). A bridge started
 * with `include_hidden:=true` advertises them, and this client drives them:
 * send_goal to start, the status topic to follow every goal on the server,
 * the feedback topic for progress, get_result for the outcome, and
 * cancel_goal to stop.
 */

import type { FoxgloveConnection } from "./FoxgloveConnection";

export type GoalState = "pending" | "accepted" | "executing" | "canceling" | "succeeded" | "canceled" | "aborted" | "rejected" | "lost";

const STATUS_CODES: Record<number, GoalState> = {
  1: "accepted",
  2: "executing",
  3: "canceling",
  4: "succeeded",
  5: "canceled",
  6: "aborted",
};

const TERMINAL: ReadonlySet<GoalState> = new Set(["succeeded", "canceled", "aborted", "rejected", "lost"]);

export function isTerminal(state: GoalState): boolean {
  return TERMINAL.has(state);
}

interface UuidMsg {
  uuid: ArrayLike<number>;
}
interface GoalStatusMsg {
  goal_info: { goal_id: UuidMsg };
  status: number;
}
interface GoalStatusArrayMsg {
  status_list: GoalStatusMsg[];
}
interface FeedbackMessage<F> {
  goal_id: UuidMsg;
  feedback: F;
}

export function uuidHex(uuid: ArrayLike<number>): string {
  let s = "";
  for (let i = 0; i < uuid.length; i++) s += (uuid[i]! & 0xff).toString(16).padStart(2, "0");
  return s;
}

export interface GoalOutcome<R> {
  state: GoalState;
  result?: R;
  /** Why the outcome is not known in detail, e.g. get_result failed. */
  note?: string;
}

/** One goal sent by this client. */
export class GoalHandle<F, R> {
  readonly uuid: Uint8Array;
  readonly id: string;
  state: GoalState = "pending";
  feedback?: F;
  readonly done: Promise<GoalOutcome<R>>;
  #resolve!: (o: GoalOutcome<R>) => void;
  #listeners = new Set<() => void>();
  #finishTimer?: ReturnType<typeof setTimeout>;

  constructor(uuid: Uint8Array) {
    this.uuid = uuid;
    this.id = uuidHex(uuid);
    this.done = new Promise((resolve) => (this.#resolve = resolve));
  }

  get finished(): boolean {
    return isTerminal(this.state);
  }

  onUpdate(l: () => void): () => void {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }

  /** @internal */
  setState(state: GoalState): void {
    if (this.finished || state === this.state) return;
    this.state = state;
    this.#emit();
  }

  /** @internal */
  setFeedback(feedback: F): void {
    if (this.finished) return;
    this.feedback = feedback;
    this.#emit();
  }

  /** @internal */
  finish(outcome: GoalOutcome<R>): void {
    if (this.finished) return;
    if (this.#finishTimer) clearTimeout(this.#finishTimer);
    this.state = outcome.state;
    this.#emit();
    this.#resolve(outcome);
  }

  /**
   * The status topic reported a terminal state. get_result usually arrives at
   * the same moment with the error message, so give it a moment first.
   * @internal
   */
  finishSoon(state: GoalState): void {
    if (this.finished || this.#finishTimer) return;
    this.#finishTimer = setTimeout(() => this.finish({ state, note: "result not received" }), 1500);
  }

  #emit(): void {
    for (const l of this.#listeners) l();
  }
}

export class ActionClient<G, F, R> {
  readonly conn: FoxgloveConnection;
  /** Action name, e.g. `/navigate_to_pose`. */
  readonly name: string;

  #handles = new Map<string, GoalHandle<F, R>>();
  /** Latest status of every goal on the server, from the status topic. */
  #serverGoals = new Map<string, GoalState>();
  #unsubStatus?: () => void;
  #unsubFeedback?: () => void;
  #statusListeners = new Set<() => void>();

  constructor(conn: FoxgloveConnection, name: string) {
    this.conn = conn;
    this.name = name.startsWith("/") ? name : `/${name}`;
    this.#unsubStatus = conn.subscribe(`${this.name}/_action/status`, (msg) => this.#onStatus(msg as GoalStatusArrayMsg));
    conn.onStateChange((s) => {
      if (s !== "disconnected") return;
      this.#serverGoals.clear();
      for (const h of this.#handles.values()) h.finish({ state: "lost", note: "connection lost" });
      this.#handles.clear();
      this.#syncFeedback();
      this.#emitStatus();
    });
  }

  get sendGoalService(): string {
    return `${this.name}/_action/send_goal`;
  }

  /** The action server is reachable through the bridge. */
  get available(): boolean {
    return this.conn.state === "connected" && this.conn.hasService(this.sendGoalService);
  }

  /** Goals on the server that are still running, whoever sent them. */
  get activeGoalCount(): number {
    let n = 0;
    for (const s of this.#serverGoals.values()) if (!isTerminal(s)) n++;
    return n;
  }

  onStatusChange(l: () => void): () => void {
    this.#statusListeners.add(l);
    return () => this.#statusListeners.delete(l);
  }

  /** Send a goal. Resolves once the server accepted or rejected it. */
  async sendGoal(goal: G): Promise<GoalHandle<F, R>> {
    const uuid = new Uint8Array(16);
    crypto.getRandomValues(uuid);
    const handle = new GoalHandle<F, R>(uuid);
    this.#handles.set(handle.id, handle);
    this.#syncFeedback();
    handle.done.then(() => {
      this.#handles.delete(handle.id);
      this.#syncFeedback();
    });

    let response: { accepted: boolean };
    try {
      response = await this.conn.callService<{ accepted: boolean }>(this.sendGoalService, { goal_id: { uuid }, goal }, 15000);
    } catch (err) {
      handle.finish({ state: "lost", note: String(err instanceof Error ? err.message : err) });
      throw err;
    }
    if (!response.accepted) {
      handle.finish({ state: "rejected" });
      return handle;
    }
    handle.setState("accepted");
    // get_result answers when the goal ends, so it may stay open for a long time.
    this.conn
      .callService<{ status: number; result: R }>(`${this.name}/_action/get_result`, { goal_id: { uuid } }, 24 * 3600 * 1000)
      .then((r) => handle.finish({ state: STATUS_CODES[r.status] ?? "aborted", result: r.result }))
      .catch(() => {
        /* The status topic still reports the end of the goal. */
      });
    return handle;
  }

  /** Cancel one goal sent by this client. */
  async cancel(handle: GoalHandle<F, R>): Promise<void> {
    if (handle.finished) return;
    handle.setState("canceling");
    await this.#cancel(handle.uuid);
  }

  /** Cancel every goal on the server, including goals sent by other clients. */
  async cancelAll(): Promise<void> {
    for (const h of this.#handles.values()) h.setState("canceling");
    await this.#cancel(new Uint8Array(16));
  }

  dispose(): void {
    this.#unsubStatus?.();
    this.#unsubFeedback?.();
    this.#unsubStatus = undefined;
    this.#unsubFeedback = undefined;
  }

  async #cancel(uuid: Uint8Array): Promise<void> {
    // A zero UUID with a zero stamp means "all goals" to the action server.
    await this.conn.callService(`${this.name}/_action/cancel_goal`, { goal_info: { goal_id: { uuid }, stamp: { sec: 0, nanosec: 0 } } }, 10000);
  }

  #onStatus(msg: GoalStatusArrayMsg): void {
    this.#serverGoals.clear();
    for (const s of msg.status_list ?? []) {
      const id = uuidHex(s.goal_info.goal_id.uuid);
      const state = STATUS_CODES[s.status] ?? "pending";
      this.#serverGoals.set(id, state);
      const handle = this.#handles.get(id);
      if (!handle) continue;
      if (isTerminal(state)) handle.finishSoon(state);
      else handle.setState(state);
    }
    this.#emitStatus();
  }

  /** Feedback is only subscribed while this client has a goal running. */
  #syncFeedback(): void {
    const want = this.#handles.size > 0;
    if (want && !this.#unsubFeedback) {
      this.#unsubFeedback = this.conn.subscribe(`${this.name}/_action/feedback`, (msg) => {
        const m = msg as FeedbackMessage<F>;
        this.#handles.get(uuidHex(m.goal_id.uuid))?.setFeedback(m.feedback);
      });
    } else if (!want && this.#unsubFeedback) {
      this.#unsubFeedback();
      this.#unsubFeedback = undefined;
    }
  }

  #emitStatus(): void {
    for (const l of this.#statusListeners) l();
  }
}
