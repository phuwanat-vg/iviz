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
 * does not change.
 *
 * The pair need not be one for the whole robot. mission_runner can give each
 * station its own (`/station/conveyor1/request` and `/answer`), so a screen at
 * that station only sees its own questions. iViz listens on the pair set in
 * the Dashboard, and also on every pair it learns about from the runner's
 * `request` events, which name both topics. Each request remembers the answer
 * topic that goes with the topic it came in on, so one iViz answers every
 * station on the right topic.
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
  /** The topic it arrived on, and the one its answer goes back on. */
  requestTopic: string;
  answerTopic: string;
  /** Local time it arrived, for ordering and timeouts. */
  received: number;
}

export interface AskTopics {
  requestTopic: string;
  answerTopic: string;
}

/** A request/answer pair other than the Dashboard's, learned this session. */
export interface StationTopics extends AskTopics {
  station?: string;
}

type AnswerListener = (id: string, answer: string, by: string) => void;

export class AskChannel {
  #conn: FoxgloveConnection;
  #topics: () => AskTopics;
  #pending: AskRequest[] = [];
  /** The Dashboard's pair. */
  #unsubscribe: (() => void)[] = [];
  #subscribedTo = "";
  /** Pairs learned from the runner, keyed by request topic. */
  #stations = new Map<string, StationTopics>();
  #stationSubs = new Map<string, () => void>();
  /** Answer topics by request id, kept after a request is gone so a late answer by hand still goes to the right place. */
  #answerTopicById = new Map<string, string>();
  #changeListeners = new Set<() => void>();
  #answerListeners = new Set<AnswerListener>();
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

  /** Subscribe the Dashboard's two topics, or re-subscribe after they were changed. */
  start(): void {
    const { requestTopic, answerTopic } = this.#topics();
    const key = `${requestTopic}|${answerTopic}`;
    if (key === this.#subscribedTo) return;
    this.stop();
    this.#subscribedTo = key;
    if (requestTopic !== "" && answerTopic !== "") {
      this.#unsubscribe.push(this.#conn.subscribe(requestTopic, (msg) => this.#onRequest(msg, requestTopic, answerTopic)));
      this.#unsubscribe.push(this.#conn.subscribe(answerTopic, (msg) => this.#onAnswer(msg)));
    }
    // A learned pair may now be the Dashboard's, or have stopped being it.
    for (const station of [...this.#stations.values()]) this.#listenStation(station);
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

  /** Station pairs learned this session, besides the Dashboard's. */
  get stations(): StationTopics[] {
    const { requestTopic, answerTopic } = this.#topics();
    return [...this.#stations.values()].filter((s) => s.requestTopic !== requestTopic || s.answerTopic !== answerTopic);
  }

  onChange(listener: () => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  /** Every answer seen on a listened answer topic, including answers from other clients. */
  onAnswer(listener: AnswerListener): () => void {
    this.#answerListeners.add(listener);
    return () => this.#answerListeners.delete(listener);
  }

  /** Where the answer for `id` goes: the topic that came with its request, else the Dashboard's. */
  answerTopicFor(id: string): string {
    return this.#pending.find((p) => p.id === id)?.answerTopic ?? this.#answerTopicById.get(id) ?? this.#topics().answerTopic;
  }

  /**
   * A request the runner reported on `/mission/event`, with the two topics it
   * chose. The pair is listened on from now on, so an answer from someone
   * else clears the card and the next request at that station arrives
   * straight from its topic too.
   */
  addRequest(body: unknown, requestTopic: string, answerTopic: string): void {
    if (requestTopic === "" || answerTopic === "") return;
    const request = parseRequest(body, requestTopic, answerTopic);
    this.learn({ requestTopic, answerTopic, station: request?.station });
    if (request) this.#upsert(request);
  }

  /** Listen on a station's pair for the rest of the session. */
  learn(station: StationTopics): void {
    if (station.requestTopic === "" || station.answerTopic === "") return;
    const known = this.#stations.get(station.requestTopic);
    if (known && known.answerTopic === station.answerTopic) {
      if (station.station && !known.station) {
        known.station = station.station;
        this.#emitChange();
      }
      return;
    }
    const entry = { ...station };
    this.#stations.set(station.requestTopic, entry);
    this.#listenStation(entry);
    this.#emitChange();
  }

  /** A request known to be answered, e.g. from the runner's `request.answered`. */
  markAnswered(id: string, answer: string, by: string): void {
    this.#remove(id, answer, by);
  }

  /** Answer on the topic that goes with the request, or on `topic` when given; drops it from the pending list. */
  answer(id: string, answer: string, by = "iviz", topic?: string): boolean {
    const target = topic !== undefined && topic !== "" ? topic : this.answerTopicFor(id);
    const ok = this.#publish(target, { id, answer, by });
    if (ok) this.#remove(id, answer, by);
    return ok;
  }

  #listenStation(station: StationTopics): void {
    const { requestTopic, answerTopic } = this.#topics();
    this.#stationSubs.get(station.requestTopic)?.();
    this.#stationSubs.delete(station.requestTopic);
    const subs: (() => void)[] = [];
    // The Dashboard's own topics are listened on already.
    if (station.requestTopic !== requestTopic) {
      subs.push(this.#conn.subscribe(station.requestTopic, (msg) => this.#onRequest(msg, station.requestTopic, station.answerTopic)));
    }
    if (station.answerTopic !== answerTopic) {
      subs.push(this.#conn.subscribe(station.answerTopic, (msg) => this.#onAnswer(msg)));
    }
    this.#stationSubs.set(station.requestTopic, () => subs.forEach((un) => un()));
  }

  #publish(topic: string, payload: Record<string, unknown>): boolean {
    if (topic === "") return false;
    return this.#conn.publish(topic, "std_msgs/msg/String", STRING_SCHEMA, { data: JSON.stringify(payload) });
  }

  #onRequest(msg: unknown, requestTopic: string, answerTopic: string): void {
    const request = parseRequest(parseJsonMessage(msg), requestTopic, answerTopic);
    if (request) this.#upsert(request);
  }

  #upsert(request: AskRequest): void {
    this.#lastRequestId = request.id;
    this.#answerTopicById.set(request.id, request.answerTopic);
    if (this.#answerTopicById.size > 50) {
      const oldest = this.#answerTopicById.keys().next().value;
      if (oldest !== undefined) this.#answerTopicById.delete(oldest);
    }
    const at = this.#pending.findIndex((p) => p.id === request.id);
    if (at >= 0) {
      // Seen twice, on its topic and in the runner's event: keep when it first arrived.
      this.#pending[at] = { ...request, received: this.#pending[at]!.received };
      return;
    }
    this.#pending = [...this.#pending, request].slice(-10);
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

function parseRequest(body: unknown, requestTopic: string, answerTopic: string): AskRequest | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Record<string, unknown>;
  const id = typeof b.id === "string" ? b.id : "";
  const text = typeof b.text === "string" ? b.text : "";
  if (id === "" || text === "") return undefined;
  const options = Array.isArray(b.options) ? b.options.filter((o): o is string => typeof o === "string") : [];
  return {
    id,
    text,
    options: options.length > 0 ? options : ["OK"],
    default: typeof b.default === "string" ? b.default : undefined,
    timeoutSec: typeof b.timeout_s === "number" ? b.timeout_s : undefined,
    station: typeof b.station === "string" ? b.station : undefined,
    source: typeof b.source === "string" ? b.source : undefined,
    requestTopic,
    answerTopic,
    received: Date.now(),
  };
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
