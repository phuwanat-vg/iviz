import { FoxgloveClient } from "@foxglove/ws-protocol";
import type { Channel, ChannelId, ClientChannelId, ServerInfo, Service, ServiceId, SubscriptionId } from "@foxglove/ws-protocol";
import { MessageDecoder } from "../ros/MessageDecoder";

export type ConnectionState = "disconnected" | "connecting" | "connected";

export type MessageHandler = (msg: unknown, channel: Channel, receiveTimeMs: number) => void;

export interface TopicStats {
  hz: number;
  bytesPerSec: number;
  lastReceivedMs: number;
}

interface Subscription {
  handlers: Set<MessageHandler>;
  subscriptionId?: SubscriptionId;
  channelId?: ChannelId;
}

interface Publication {
  clientChannelId: ClientChannelId;
  schemaName: string;
  schema: string;
}

/** How one half (request or response) of a service is encoded on the wire. */
interface ServiceCodec {
  encoding: string;
  schemaName: string;
  schema: string;
  schemaEncoding?: string;
}

interface PendingCall {
  service: Service;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Listener<T> = (value: T) => void;

/**
 * Thin, reconnecting wrapper around FoxgloveClient that
 *  - tracks advertised channels by topic
 *  - lets callers subscribe by topic name before the channel exists
 *  - decodes CDR payloads into JS objects using the advertised schema
 *  - tracks advertised services and calls them with a promise per call
 *  - gathers per-topic and total bandwidth statistics
 */
export class FoxgloveConnection {
  readonly decoder = new MessageDecoder();

  #client?: FoxgloveClient;
  #ws?: WebSocket;
  #url = "";
  #intentionalClose = false;
  #reconnectTimer?: ReturnType<typeof setTimeout>;

  #state: ConnectionState = "disconnected";
  #serverInfo?: ServerInfo;
  #channels = new Map<ChannelId, Channel>();
  #channelsByTopic = new Map<string, Channel>();
  #subs = new Map<string, Subscription>();
  #subIdToTopic = new Map<SubscriptionId, string>();
  #pubs = new Map<string, Publication>();
  #services = new Map<ServiceId, Service>();
  #servicesByName = new Map<string, Service>();
  #pendingCalls = new Map<number, PendingCall>();
  #nextCallId = 1;

  // stats
  #windowBytes = 0;
  #windowMsgs = 0;
  #topicWindow = new Map<string, { bytes: number; msgs: number; last: number }>();
  #topicStats = new Map<string, TopicStats>();
  totalBytesPerSec = 0;
  totalMsgsPerSec = 0;

  #stateListeners = new Set<Listener<ConnectionState>>();
  #channelListeners = new Set<Listener<Channel[]>>();
  #serviceListeners = new Set<Listener<Service[]>>();
  #errorListeners = new Set<Listener<string>>();

  autoReconnect = true;

  get state(): ConnectionState {
    return this.#state;
  }
  get url(): string {
    return this.#url;
  }
  get serverInfo(): ServerInfo | undefined {
    return this.#serverInfo;
  }
  get channels(): Channel[] {
    return [...this.#channels.values()].sort((a, b) => a.topic.localeCompare(b.topic));
  }
  channelForTopic(topic: string): Channel | undefined {
    return this.#channelsByTopic.get(topic);
  }
  topicStats(topic: string): TopicStats | undefined {
    return this.#topicStats.get(topic);
  }
  isSubscribed(topic: string): boolean {
    return this.#subs.has(topic);
  }
  /** True when the bridge announced the "services" capability in its ServerInfo. */
  get supportsServices(): boolean {
    return this.#serverInfo?.capabilities.includes("services") ?? false;
  }
  get services(): Service[] {
    return [...this.#services.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  serviceForName(name: string): Service | undefined {
    return this.#servicesByName.get(name);
  }
  hasService(name: string): boolean {
    return this.#servicesByName.has(name);
  }

  onStateChange(l: Listener<ConnectionState>): () => void {
    this.#stateListeners.add(l);
    return () => this.#stateListeners.delete(l);
  }
  onChannelsChange(l: Listener<Channel[]>): () => void {
    this.#channelListeners.add(l);
    return () => this.#channelListeners.delete(l);
  }
  onServicesChange(l: Listener<Service[]>): () => void {
    this.#serviceListeners.add(l);
    return () => this.#serviceListeners.delete(l);
  }
  onError(l: Listener<string>): () => void {
    this.#errorListeners.add(l);
    return () => this.#errorListeners.delete(l);
  }

  connect(url: string): void {
    this.disconnect();
    this.#intentionalClose = false;
    this.#url = url;
    this.#open();
  }

  disconnect(): void {
    this.#intentionalClose = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    if (this.#client) {
      try {
        this.#client.close();
      } catch {
        /* ignore */
      }
    }
    this.#client = undefined;
    this.#ws = undefined;
    this.#resetSessionState();
    this.#setState("disconnected");
  }

  #open(): void {
    let ws: WebSocket;
    try {
      // ros-foxglove-bridge (C++) negotiates "foxglove.websocket.v1"; the newer
      // Foxglove-SDK based bridge insists on "foxglove.sdk.v1". Offer both.
      ws = new WebSocket(this.#url, [FoxgloveClient.SUPPORTED_SUBPROTOCOL, "foxglove.sdk.v1"]);
    } catch (err) {
      this.#emitError(`Invalid URL: ${String(err)}`);
      this.#setState("disconnected");
      return;
    }
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    const client = new FoxgloveClient({ ws });
    this.#client = client;
    this.#setState("connecting");

    client.on("open", () => {
      if (this.#ws !== ws) return;
      this.#setState("connected");
    });
    client.on("error", (err) => {
      if (this.#ws !== ws) return;
      this.#emitError(err.message || "WebSocket error");
    });
    client.on("close", () => {
      if (this.#ws !== ws) return;
      this.#client = undefined;
      this.#ws = undefined;
      this.#resetSessionState();
      this.#setState("disconnected");
      if (!this.#intentionalClose && this.autoReconnect) {
        this.#reconnectTimer = setTimeout(() => {
          this.#reconnectTimer = undefined;
          if (!this.#intentionalClose) this.#open();
        }, 2000);
      }
    });
    client.on("serverInfo", (info) => {
      if (this.#ws !== ws) return;
      this.#serverInfo = info;
      this.#emitChannels();
      this.#emitServices();
    });
    client.on("status", (status) => {
      if (status.level >= 2) this.#emitError(`Server: ${status.message}`);
    });
    client.on("advertise", (newChannels) => {
      if (this.#ws !== ws) return;
      for (const ch of newChannels) {
        this.#channels.set(ch.id, ch);
        this.#channelsByTopic.set(ch.topic, ch);
        const sub = this.#subs.get(ch.topic);
        if (sub && sub.subscriptionId === undefined) this.#doSubscribe(ch.topic, sub, ch);
      }
      this.#emitChannels();
    });
    client.on("unadvertise", (removed) => {
      if (this.#ws !== ws) return;
      for (const id of removed) {
        const ch = this.#channels.get(id);
        if (!ch) continue;
        this.#channels.delete(id);
        if (this.#channelsByTopic.get(ch.topic)?.id === id) this.#channelsByTopic.delete(ch.topic);
        const sub = this.#subs.get(ch.topic);
        if (sub?.channelId === id) {
          if (sub.subscriptionId !== undefined) this.#subIdToTopic.delete(sub.subscriptionId);
          sub.subscriptionId = undefined;
          sub.channelId = undefined;
        }
      }
      this.#emitChannels();
    });
    client.on("advertiseServices", (newServices) => {
      if (this.#ws !== ws) return;
      for (const svc of newServices) {
        this.#services.set(svc.id, svc);
        this.#servicesByName.set(svc.name, svc);
      }
      this.#emitServices();
    });
    client.on("unadvertiseServices", (removed) => {
      if (this.#ws !== ws) return;
      for (const id of removed) {
        const svc = this.#services.get(id);
        if (!svc) continue;
        this.#services.delete(id);
        if (this.#servicesByName.get(svc.name)?.id === id) this.#servicesByName.delete(svc.name);
      }
      this.#emitServices();
    });
    client.on("serviceCallResponse", (ev) => {
      if (this.#ws !== ws) return;
      const pending = this.#takePending(ev.callId);
      if (!pending) return;
      const res = serviceCodec(pending.service, "response");
      if (!res) {
        pending.reject(new Error(`Service ${pending.service.name} did not advertise a response schema`));
        return;
      }
      try {
        const reader = this.decoder.getReader(res.schemaName, res.schema, res.schemaEncoding);
        pending.resolve(reader.readMessage(ev.data));
      } catch (err) {
        pending.reject(new Error(`Decoding the response of ${pending.service.name} failed: ${String(err)}`));
      }
    });
    client.on("serviceCallFailure", (ev) => {
      if (this.#ws !== ws) return;
      const pending = this.#takePending(ev.callId);
      if (!pending) return;
      pending.reject(new Error(`Service ${pending.service.name} failed: ${ev.message}`));
    });
    client.on("message", (ev) => {
      if (this.#ws !== ws) return;
      const topic = this.#subIdToTopic.get(ev.subscriptionId);
      if (topic === undefined) return;
      const sub = this.#subs.get(topic);
      const ch = sub?.channelId !== undefined ? this.#channels.get(sub.channelId) : undefined;
      if (!sub || !ch) return;

      const now = performance.now();
      const bytes = ev.data.byteLength;
      this.#windowBytes += bytes;
      this.#windowMsgs += 1;
      let tw = this.#topicWindow.get(topic);
      if (!tw) {
        tw = { bytes: 0, msgs: 0, last: now };
        this.#topicWindow.set(topic, tw);
      }
      tw.bytes += bytes;
      tw.msgs += 1;
      tw.last = now;

      let decoded: unknown;
      try {
        const reader = this.decoder.getReader(ch.schemaName, ch.schema, ch.schemaEncoding);
        decoded = reader.readMessage(ev.data);
      } catch (err) {
        this.#emitError(`Decode failed on ${topic} (${ch.schemaName}): ${String(err)}`);
        return;
      }
      for (const h of sub.handlers) {
        try {
          h(decoded, ch, now);
        } catch (err) {
          console.error(`handler error on ${topic}`, err);
        }
      }
    });
  }

  #resetSessionState(): void {
    this.#serverInfo = undefined;
    this.#channels.clear();
    this.#channelsByTopic.clear();
    this.#subIdToTopic.clear();
    for (const sub of this.#subs.values()) {
      sub.subscriptionId = undefined;
      sub.channelId = undefined;
    }
    this.#pubs.clear();
    this.#services.clear();
    this.#servicesByName.clear();
    this.#failPendingCalls("connection closed");
    this.#topicWindow.clear();
    this.#topicStats.clear();
    this.totalBytesPerSec = 0;
    this.totalMsgsPerSec = 0;
    this.#emitChannels();
    this.#emitServices();
  }

  /**
   * Subscribe to a topic. Works before the channel is advertised; the actual
   * subscription is created as soon as the bridge advertises the topic.
   */
  subscribe(topic: string, handler: MessageHandler): () => void {
    let sub = this.#subs.get(topic);
    if (!sub) {
      sub = { handlers: new Set() };
      this.#subs.set(topic, sub);
    }
    sub.handlers.add(handler);
    const ch = this.#channelsByTopic.get(topic);
    if (ch && sub.subscriptionId === undefined) this.#doSubscribe(topic, sub, ch);
    return () => {
      const s = this.#subs.get(topic);
      if (!s) return;
      s.handlers.delete(handler);
      if (s.handlers.size === 0) {
        if (s.subscriptionId !== undefined && this.#client) {
          try {
            this.#client.unsubscribe(s.subscriptionId);
          } catch {
            /* ignore */
          }
          this.#subIdToTopic.delete(s.subscriptionId);
        }
        this.#subs.delete(topic);
        this.#topicWindow.delete(topic);
        this.#topicStats.delete(topic);
      }
    };
  }

  #doSubscribe(topic: string, sub: Subscription, ch: Channel): void {
    if (!this.#client) return;
    try {
      const id = this.#client.subscribe(ch.id);
      sub.subscriptionId = id;
      sub.channelId = ch.id;
      this.#subIdToTopic.set(id, topic);
    } catch (err) {
      this.#emitError(`Subscribe failed on ${topic}: ${String(err)}`);
    }
  }

  /** Publish a message. The topic is advertised on first use. */
  publish(topic: string, schemaName: string, schema: string, message: unknown): boolean {
    if (!this.#client || this.#state !== "connected") {
      this.#emitError("Not connected");
      return false;
    }
    let pub = this.#pubs.get(topic);
    if (!pub || pub.schemaName !== schemaName) {
      if (pub) this.#client.unadvertise(pub.clientChannelId);
      const clientChannelId = this.#client.advertise({
        topic,
        encoding: "cdr",
        schemaName,
        schema,
        schemaEncoding: "ros2msg",
      });
      pub = { clientChannelId, schemaName, schema };
      this.#pubs.set(topic, pub);
    }
    try {
      const writer = this.decoder.getWriter(schemaName, schema, "ros2msg");
      const bytes = writer.writeMessage(message);
      this.#client.sendMessage(pub.clientChannelId, bytes);
      return true;
    } catch (err) {
      this.#emitError(`Publish failed on ${topic}: ${String(err)}`);
      return false;
    }
  }

  /**
   * Call a ROS service advertised by the bridge and resolve with the decoded
   * response. Rejects with a descriptive Error when the bridge has no such
   * service, reports a failure, disconnects, or does not answer in time.
   */
  async callService<T = unknown>(name: string, request: unknown, timeoutMs = 30000): Promise<T> {
    const client = this.#client;
    if (!client || this.#state !== "connected") throw new Error(`Cannot call ${name}: not connected`);
    if (!this.supportsServices) throw new Error(`Cannot call ${name}: the bridge does not advertise services`);
    const service = this.#servicesByName.get(name);
    if (!service) throw new Error(`Cannot call ${name}: the bridge does not advertise this service`);
    const req = serviceCodec(service, "request");
    if (!req) throw new Error(`Cannot call ${name}: the bridge did not advertise a request schema`);

    let data: Uint8Array;
    try {
      const writer = this.decoder.getWriter(req.schemaName, req.schema, req.schemaEncoding);
      data = writer.writeMessage(request);
    } catch (err) {
      throw new Error(`Encoding the request for ${name} failed: ${String(err)}`);
    }

    const callId = this.#nextCallId++;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingCalls.delete(callId);
        reject(new Error(`Service ${name} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pendingCalls.set(callId, { service, resolve: (value) => resolve(value as T), reject, timer });
      try {
        client.sendServiceCallRequest({ serviceId: service.id, callId, encoding: req.encoding, data });
      } catch (err) {
        this.#takePending(callId);
        reject(new Error(`Sending the request for ${name} failed: ${String(err)}`));
      }
    });
  }

  /** Remove a pending call and stop its timeout, if it is still outstanding. */
  #takePending(callId: number): PendingCall | undefined {
    const pending = this.#pendingCalls.get(callId);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    this.#pendingCalls.delete(callId);
    return pending;
  }

  #failPendingCalls(reason: string): void {
    const pending = [...this.#pendingCalls.values()];
    this.#pendingCalls.clear();
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`Service ${p.service.name} did not complete: ${reason}`));
    }
  }

  #lastTickMs = performance.now();

  /** Call periodically (about once per second) to roll bandwidth statistics. */
  tickStats(): void {
    const now = performance.now();
    const s = Math.max(0.001, (now - this.#lastTickMs) / 1000);
    this.#lastTickMs = now;
    this.totalBytesPerSec = this.#windowBytes / s;
    this.totalMsgsPerSec = this.#windowMsgs / s;
    this.#windowBytes = 0;
    this.#windowMsgs = 0;
    for (const [topic, w] of this.#topicWindow) {
      this.#topicStats.set(topic, { hz: w.msgs / s, bytesPerSec: w.bytes / s, lastReceivedMs: w.last });
      w.bytes = 0;
      w.msgs = 0;
    }
  }

  #setState(s: ConnectionState): void {
    if (this.#state === s) return;
    this.#state = s;
    for (const l of this.#stateListeners) l(s);
  }
  #emitChannels(): void {
    const list = this.channels;
    for (const l of this.#channelListeners) l(list);
  }
  #emitServices(): void {
    const list = this.services;
    for (const l of this.#serviceListeners) l(list);
  }
  #emitError(msg: string): void {
    console.warn("[iViz]", msg);
    for (const l of this.#errorListeners) l(msg);
  }
}

/**
 * Describe how one half of a service is encoded. A ROS `.srv` file holds the
 * request and the response separated by `---`; the bridge advertises them
 * already split, so each half is parsed as an ordinary concatenated ros2msg
 * schema. Bridges older than ws-protocol 0.7 send bare `requestSchema` /
 * `responseSchema` strings instead of the `request` / `response` objects.
 */
function serviceCodec(service: Service, part: "request" | "response"): ServiceCodec | undefined {
  const def = part === "request" ? service.request : service.response;
  if (def) return def;
  const legacy = part === "request" ? service.requestSchema : service.responseSchema;
  if (legacy === undefined) return undefined;
  return { encoding: "cdr", schemaName: `${service.type}_${part === "request" ? "Request" : "Response"}`, schema: legacy, schemaEncoding: "ros2msg" };
}
