import { normalizeSchemaName } from "../../ros/types";
import type { Layer, SettingsValues } from "./Layer";
import { LaserScanLayer } from "./LaserScanLayer";
import { OccupancyGridLayer } from "./OccupancyGridLayer";
import { PathLayer } from "./PathLayer";
import { PointCloudLayer } from "./PointCloudLayer";
import { PolygonLayer } from "./PolygonLayer";
import { PoseLayer } from "./PoseLayer";

type Ctor = new (topic: string, schemaName: string, initial?: Partial<SettingsValues>) => Layer;

const REGISTRY: Record<string, Ctor> = {
  "sensor_msgs/PointCloud2": PointCloudLayer,
  "livox_ros_driver2/CustomMsg": PointCloudLayer,
  "sensor_msgs/LaserScan": LaserScanLayer,
  "nav_msgs/OccupancyGrid": OccupancyGridLayer,
  "nav_msgs/Path": PathLayer,
  "nav_msgs/Odometry": PoseLayer,
  "geometry_msgs/PoseStamped": PoseLayer,
  "geometry_msgs/PoseWithCovarianceStamped": PoseLayer,
  "geometry_msgs/PolygonStamped": PolygonLayer,
};

export function isSupportedSchema(schemaName: string): boolean {
  return normalizeSchemaName(schemaName) in REGISTRY;
}

export function createLayer(topic: string, schemaName: string, initial?: Partial<SettingsValues>): Layer | undefined {
  const ctor = REGISTRY[normalizeSchemaName(schemaName)];
  return ctor ? new ctor(topic, schemaName, initial) : undefined;
}

/** Short label for the topic list, e.g. "PointCloud2". */
export function shortTypeName(schemaName: string): string {
  const n = normalizeSchemaName(schemaName);
  return n.slice(n.lastIndexOf("/") + 1);
}

export { TfLayer } from "./TfLayer";
export type { Layer, SettingsValues } from "./Layer";
