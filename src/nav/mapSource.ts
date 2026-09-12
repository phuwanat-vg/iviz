/**
 * Getting the map when the topic will not deliver it.
 *
 * map_server and slam_toolbox publish `/map` once, latched (transient local).
 * A client that subscribes later only receives it if the whole QoS matches, so
 * the map can stay missing until something makes the publisher send again.
 * Both nodes also offer a `nav_msgs/srv/GetMap` service, which always answers
 * with the current map.
 */

import type { FoxgloveConnection } from "../net/FoxgloveConnection";
import type { OccupancyGrid } from "../ros/types";

const GET_MAP = "nav_msgs/srv/GetMap";

/**
 * A service that returns the map, preferring one whose name is related to
 * `topic` (`/map` → `/map_server/map`, `/slam_toolbox/map` → its own).
 */
export function findMapService(conn: FoxgloveConnection, topic?: string): string | undefined {
  const services = conn.services.filter((s) => s.type === GET_MAP);
  if (services.length === 0) return undefined;
  const parts = (topic ?? "").split("/").filter(Boolean);
  for (const part of parts) {
    const match = services.find((s) => s.name.includes(part));
    if (match) return match.name;
  }
  return services[0]!.name;
}

/** Ask the robot for the current map. */
export async function fetchMap(conn: FoxgloveConnection, topic?: string): Promise<OccupancyGrid> {
  const name = findMapService(conn, topic);
  if (!name) throw new Error("the robot offers no GetMap service (map_server or slam_toolbox)");
  const response = await conn.callService<{ map?: OccupancyGrid }>(name, {}, 20000);
  const map = response.map;
  if (!map || map.info === undefined) throw new Error(`${name} returned no map`);
  return map;
}
