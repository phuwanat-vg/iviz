/**
 * ROS 2 message definitions in the concatenated "ros2msg" format that
 * foxglove_bridge advertises. iViz normally receives schemas from the bridge at
 * runtime, so this file is only needed for:
 *   - messages iViz publishes (goal_pose / initialpose)
 *   - the mock server used for development without a robot
 */

const SEP = "\n================================================================================\n";

/**
 * @foxglove/rosmsg matches fully-qualified complex types by exact string, so a
 * schema that says `MSG: geometry_msgs/msg/Point` while a field says
 * `geometry_msgs/Point` fails to resolve. Bridges and bag recorders emit both
 * spellings, so collapse `pkg/msg/Type` to `pkg/Type` everywhere before parsing.
 */
export function normalizeRos2MsgText(text: string): string {
  return text.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\/msg\/([A-Za-z_][A-Za-z0-9_]*)/g, "$1/$2");
}

const HEADER = `MSG: std_msgs/msg/Header
builtin_interfaces/Time stamp
string frame_id`;

const POINT = `MSG: geometry_msgs/msg/Point
float64 x
float64 y
float64 z`;

const VECTOR3 = `MSG: geometry_msgs/msg/Vector3
float64 x
float64 y
float64 z`;

const QUATERNION = `MSG: geometry_msgs/msg/Quaternion
float64 x 0
float64 y 0
float64 z 0
float64 w 1`;

const POSE = `MSG: geometry_msgs/msg/Pose
geometry_msgs/Point position
geometry_msgs/Quaternion orientation`;

const POSE_WITH_COV = `MSG: geometry_msgs/msg/PoseWithCovariance
geometry_msgs/Pose pose
float64[36] covariance`;

const TWIST = `MSG: geometry_msgs/msg/Twist
geometry_msgs/Vector3 linear
geometry_msgs/Vector3 angular`;

const TWIST_WITH_COV = `MSG: geometry_msgs/msg/TwistWithCovariance
geometry_msgs/Twist twist
float64[36] covariance`;

const TRANSFORM = `MSG: geometry_msgs/msg/Transform
geometry_msgs/Vector3 translation
geometry_msgs/Quaternion rotation`;

const TRANSFORM_STAMPED = `MSG: geometry_msgs/msg/TransformStamped
std_msgs/Header header
string child_frame_id
geometry_msgs/Transform transform`;

const POSE_STAMPED_DEP = `MSG: geometry_msgs/msg/PoseStamped
std_msgs/Header header
geometry_msgs/Pose pose`;

const POINT_FIELD = `MSG: sensor_msgs/msg/PointField
uint8 INT8=1
uint8 UINT8=2
uint8 INT16=3
uint8 UINT16=4
uint8 INT32=5
uint8 UINT32=6
uint8 FLOAT32=7
uint8 FLOAT64=8
string name
uint32 offset
uint8 datatype
uint32 count`;

const MAP_META = `MSG: nav_msgs/msg/MapMetaData
builtin_interfaces/Time map_load_time
float32 resolution
uint32 width
uint32 height
geometry_msgs/Pose origin`;

const POINT32 = `MSG: geometry_msgs/msg/Point32
float32 x
float32 y
float32 z`;

const POLYGON = `MSG: geometry_msgs/msg/Polygon
geometry_msgs/Point32[] points`;

const LIVOX_POINT = `MSG: livox_ros_driver2/msg/CustomPoint
uint32 offset_time
float32 x
float32 y
float32 z
uint8 reflectivity
uint8 tag
uint8 line`;

function def(top: string, ...deps: string[]): string {
  return [top, ...deps].join(SEP);
}

export const SCHEMAS = {
  "std_msgs/msg/String": "string data",
  "geometry_msgs/msg/PoseStamped": def(
    `std_msgs/Header header
geometry_msgs/Pose pose`,
    HEADER,
    POSE,
    POINT,
    QUATERNION,
  ),
  "geometry_msgs/msg/PoseWithCovarianceStamped": def(
    `std_msgs/Header header
geometry_msgs/PoseWithCovariance pose`,
    HEADER,
    POSE_WITH_COV,
    POSE,
    POINT,
    QUATERNION,
  ),
  "geometry_msgs/msg/PolygonStamped": def(
    `std_msgs/Header header
geometry_msgs/Polygon polygon`,
    HEADER,
    POLYGON,
    POINT32,
  ),
  "sensor_msgs/msg/PointCloud2": def(
    `std_msgs/Header header
uint32 height
uint32 width
sensor_msgs/PointField[] fields
bool is_bigendian
uint32 point_step
uint32 row_step
uint8[] data
bool is_dense`,
    HEADER,
    POINT_FIELD,
  ),
  "sensor_msgs/msg/LaserScan": def(
    `std_msgs/Header header
float32 angle_min
float32 angle_max
float32 angle_increment
float32 time_increment
float32 scan_time
float32 range_min
float32 range_max
float32[] ranges
float32[] intensities`,
    HEADER,
  ),
  "nav_msgs/msg/OccupancyGrid": def(
    `std_msgs/Header header
nav_msgs/MapMetaData info
int8[] data`,
    HEADER,
    MAP_META,
    POSE,
    POINT,
    QUATERNION,
  ),
  "nav_msgs/msg/Path": def(
    `std_msgs/Header header
geometry_msgs/PoseStamped[] poses`,
    HEADER,
    POSE_STAMPED_DEP,
    POSE,
    POINT,
    QUATERNION,
  ),
  "nav_msgs/msg/Odometry": def(
    `std_msgs/Header header
string child_frame_id
geometry_msgs/PoseWithCovariance pose
geometry_msgs/TwistWithCovariance twist`,
    HEADER,
    POSE_WITH_COV,
    POSE,
    POINT,
    QUATERNION,
    TWIST_WITH_COV,
    TWIST,
    VECTOR3,
  ),
  "tf2_msgs/msg/TFMessage": def(
    `geometry_msgs/TransformStamped[] transforms`,
    TRANSFORM_STAMPED,
    HEADER,
    TRANSFORM,
    VECTOR3,
    QUATERNION,
  ),
  "livox_ros_driver2/msg/CustomMsg": def(
    `std_msgs/Header header
uint64 timebase
uint32 point_num
uint8 lidar_id
uint8[3] rsvd
livox_ros_driver2/CustomPoint[] points`,
    HEADER,
    LIVOX_POINT,
  ),
} as const;

export type SchemaName = keyof typeof SCHEMAS;
