/**
 * Quick connectivity probe for a foxglove_bridge:
 *   npx tsx tools/probe.ts ws://192.168.1.118:8765 [seconds]
 * Prints server info, advertised channels, and per-topic message rates.
 */
import { createRequire } from "node:module";
import WebSocket from "ws";

const require = createRequire(import.meta.url);
const { FoxgloveClient } = require("@foxglove/ws-protocol") as typeof import("@foxglove/ws-protocol");

const url = process.argv[2] ?? "ws://localhost:8765";
const seconds = Number(process.argv[3] ?? 5);

// Older ros-foxglove-bridge speaks "foxglove.websocket.v1"; the newer SDK-based
// bridge speaks "foxglove.sdk.v1". Offer both and let the server pick.
const ws = new WebSocket(url, [FoxgloveClient.SUPPORTED_SUBPROTOCOL, "foxglove.sdk.v1"]);
ws.on("open", () => console.log(`[probe] negotiated subprotocol: ${ws.protocol}`));
const client = new FoxgloveClient({ ws: ws as unknown as ConstructorParameters<typeof FoxgloveClient>[0]["ws"] });

const counts = new Map<number, { topic: string; n: number; bytes: number }>();

client.on("open", () => console.log(`[probe] connected ${url}`));
client.on("error", (e) => console.log(`[probe] error: ${e.message}`));
client.on("close", (e) => {
  console.log(`[probe] closed code=${(e as { code?: number }).code ?? "?"}`);
});
client.on("serverInfo", (info) => {
  console.log(`[probe] server: ${info.name}  capabilities: ${info.capabilities.join(", ")}`);
});
client.on("advertise", (channels) => {
  for (const ch of channels) {
    console.log(`[probe] topic ${ch.topic}  ${ch.schemaName}  (${ch.encoding}/${ch.schemaEncoding ?? "?"}, schema ${ch.schema.length} chars)`);
    const sub = client.subscribe(ch.id);
    counts.set(sub, { topic: ch.topic, n: 0, bytes: 0 });
  }
});
client.on("message", (m) => {
  const c = counts.get(m.subscriptionId);
  if (c) {
    c.n++;
    c.bytes += m.data.byteLength;
  }
});

setTimeout(() => {
  console.log(`[probe] rates over ${seconds}s:`);
  for (const c of counts.values()) {
    if (c.n > 0) console.log(`  ${c.topic.padEnd(40)} ${(c.n / seconds).toFixed(1).padStart(6)} Hz  ${(c.bytes / seconds / 1024).toFixed(1).padStart(8)} KB/s`);
  }
  client.close();
  process.exit(0);
}, seconds * 1000 + 1500);
