/**
 * The ask/answer contract between the robot and whoever answers.
 *
 * Two `std_msgs/String` topics carrying JSON, so anything can take either
 * side and nothing has to know about iViz:
 *
 *   request topic  {"id","text","options",["default"],["timeout_s"],["station"],["source"]}
 *   answer topic   {"id","answer",["by"]}
 *
 * The asker publishes a request and waits for an answer with the same `id`.
 * iViz answers from its Dashboard while a system is being tried out; later a
 * node, a PLC adapter or a button box can answer instead, and the asking side
 * does not change. iViz's own station stops publish requests through here too,
 * so an external answerer can drive them.
 *
 * A blocking service (mission_runner's `/mission/answer`) covers the case
 * where the asker wants a call rather than a topic; that path lives in
 * MissionApi.
 */

import type { FoxgloveConnection } from "../net/FoxgloveConnection";
import { SCHEMAS } from "../ros/schemas";

const STRING_SCHEMA = SCHEMAS["std_msgs/msg/String"];

export interface AskRequest {
  id: string;
  text: string;
  options: string[];
  default?: string;
  timeoutSec?: number;
  station?: string;
  source?: string;
  /** Local time it arrived, for ordering and timeouts. */
  received: number;
}

export interface AskTopics {
  requestTopic: string;
  answerTopic: string;
}

type AnswerListener = (id: string, answer: string, by: string) => void;

export class AskChannel {
  #conn: FoxgloveConnection;
  #topics: () => AskTopics;
  #pending: AskRequest[] = [];
  #unsubscribe: (() => void)[] = [];
  #changeListeners = new Set<() => void>();
  #answerListeners = new Set<AnswerListener>();
  #subscribedTo = "";
  #lastRequestId = "";

  constructor(conn: FoxgloveConnection, topics: () => AskTopics) {
    this.#conn = conn;
    this.#topics = topics;
    conn.onStateChange((state) => {
      if (state !== "disconnected") return;
      this.#pending = [];
      this.#emitChange();
    });
  }

  /** Subscribe the two topics, or re-subscribe after they were changed. */
  start(): void {
    const { requestTopic, answerTopic } = this.#topics();
    const key = `${requestTopic}|${answerTopic}`;
    if (key === this.#subscribedTo) return;
    this.stop();
    this.#subscribedTo = key;
    if (requestTopic === "" || answerTopic === "") return;
    this.#unsubscribe.push(this.#conn.subscribe(requestTopic, (msg) => this.#onRequest(msg)));
    this.#unsubscribe.push(this.#conn.subscribe(answerTopic, (msg) => this.#onAnswer(msg)));
  }

  stop(): void {
    for (const un of this.#unsubscribe) un();
    this.#unsubscribe = [];
    this.#subscribedTo = "";
  }

  get pending(): AskRequest[] {
    return this.#pending;
  }

  /** The id of the most recent request, answered or not. */
  get lastRequestId(): string {
    return this.#lastRequestId;
  }

  onChange(listener: () => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  /** Every answer seen on the topic, including answers from other clients. */
  onAnswer(listener: AnswerListener): () => void {
    this.#answerListeners.add(listener);
    return () => this.#answerListeners.delete(listener);
  }

  /** Publish a request, for iViz's own station stops. */
  ask(request: { id: string; text: string; options: string[]; default?: string; timeoutSec?: number; station?: string }): boolean {
    const payload: Record<string, unknown> = {
      id: request.id,
      text: request.text,
      options: request.options,
      source: "iviz",
    };
    if (request.default !== undefined) payload.default = request.default;
    if (request.timeoutSec !== undefined) payload.timeout_s = request.timeoutSec;
    if (request.station !== undefined) payload.station = request.station;
    return this.#publish(this.#topics().requestTopic, payload);
  }

  /** Answer a request; drops it from the pending list. */
  answer(id: string, answer: string, by = "iviz"): boolean {
    const ok = this.#publish(this.#topics().answerTopic, { id, answer, by });
    if (ok) this.#remove(id, answer, by);
    return ok;
  }

  #publish(topic: string, payload: Record<string, unknown>): boolean {
    if (topic === "") return false;
    return this.#conn.publish(topic, "std_msgs/msg/String", STRING_SCHEMA, { data: JSON.stringify(payload) });
  }

  #onRequest(msg: unknown): void {
    const body = parseJsonMessage(msg);
    if (!body) return;
    const id = typeof body.id === "string" ? body.id : "";
    const text = typeof body.text === "string" ? body.text : "";
    if (id === "" || text === "") return;
    const options = Array.isArray(body.options) ? body.options.filter((o): o is string => typeof o === "string") : [];
    const request: AskRequest = {
      id,
      text,
      options: options.length > 0 ? options : ["OK"],
      default: typeof body.default === "string" ? body.default : undefined,
      timeoutSec: typeof body.timeout_s === "number" ? body.timeout_s : undefined,
      station: typeof body.station === "string" ? body.station : undefined,
      source: typeof body.source === "string" ? body.source : undefined,
      received: Date.now(),
    };
    this.#lastRequestId = id;
    const at = this.#pending.findIndex((p) => p.id === id);
    if (at >= 0) this.#pending[at] = request;
    else this.#pending = [...this.#pending, request].slice(-10);
    this.#emitChange();
  }

  #onAnswer(msg: unknown): void {
    const body = parseJsonMessage(msg);
    if (!body) return;
    const id = typeof body.id === "string" ? body.id : "";
    const answer = typeof body.answer === "string" ? body.answer : "";
    if (id === "") return;
    this.#remove(id, answer, typeof body.by === "string" ? body.by : "");
  }

  #remove(id: string, answer: string, by: string): void {
    const before = this.#pending.length;
    this.#pending = this.#pending.filter((p) => p.id !== id);
    for (const l of this.#answerListeners) l(id, answer, by);
    if (this.#pending.length !== before) this.#emitChange();
  }

  #emitChange(): void {
    for (const l of this.#changeListeners) l();
  }
}

function parseJsonMessage(msg: unknown): Record<string, unknown> | undefined {
  const data = (msg as { data?: unknown } | undefined)?.data;
  if (typeof data !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
