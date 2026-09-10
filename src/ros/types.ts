/** Minimal TypeScript views of the ROS 2 messages iViz consumes. */

export interface RosTime {
  sec: number;
  nanosec?: number;
  nsec?: number;
}

export interface Header {
  stamp: RosTime;
  frame_id: string;
}

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}
export interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}
export interface Pose {
  position: Vector3;
  orientation: Quaternion;
}

export interface PointField {
  name: string;
  offset: number;
  datatype: number;
  count: number;
}

export interface PointCloud2 {
  header: Header;
  height: number;
  width: number;
  fields: PointField[];
  is_bigendian: boolean;
  point_step: number;
  row_step: number;
  data: Uint8Array;
  is_dense: boolean;
}

export interface LivoxCustomPoint {
  offset_time: number;
  x: number;
  y: number;
  z: number;
  reflectivity: number;
  tag: number;
  line: number;
}

export interface LivoxCustomMsg {
  header: Header;
  timebase: bigint;
  point_num: number;
  lidar_id: number;
  points: LivoxCustomPoint[];
}

export interface LaserScan {
  header: Header;
  angle_min: number;
  angle_max: number;
  angle_increment: number;
  range_min: number;
  range_max: number;
  ranges: Float32Array;
  intensities: Float32Array;
}

export interface OccupancyGrid {
  header: Header;
  info: {
    resolution: number;
    width: number;
    height: number;
    origin: Pose;
  };
  data: Int8Array;
}

export interface PoseStamped {
  header: Header;
  pose: Pose;
}
export interface PoseWithCovarianceStamped {
  header: Header;
  pose: { pose: Pose; covariance: Float64Array };
}
export interface Path {
  header: Header;
  poses: PoseStamped[];
}
export interface Odometry {
  header: Header;
  child_frame_id: string;
  pose: { pose: Pose; covariance: Float64Array };
}
export interface PolygonStamped {
  header: Header;
  polygon: { points: Vector3[] };
}
export interface TransformStamped {
  header: Header;
  child_frame_id: string;
  transform: { translation: Vector3; rotation: Quaternion };
}
export interface TFMessage {
  transforms: TransformStamped[];
}

export function stampToSec(t: RosTime | undefined): number {
  if (!t) return 0;
  return t.sec + (t.nanosec ?? t.nsec ?? 0) * 1e-9;
}

/** "pkg/msg/Type" and "pkg/Type" both become "pkg/Type". */
export function normalizeSchemaName(name: string): string {
  return name.replace("/msg/", "/");
}
