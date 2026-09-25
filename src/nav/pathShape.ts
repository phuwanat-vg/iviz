/**
 * The shape of a drawn path: straight or bent segments between the points the
 * user clicked, sampled at an even spacing for FollowPath or for copying out.
 *
 * Each segment may be bent into a quadratic Bézier curve. `bend` is how far
 * the middle of the curve sits from the middle of the straight line, in
 * metres, positive to the left of the direction of travel. The curve passes
 * through that point, so the handle the user drags sits on the line itself.
 * `skew` slides that point along the line; only splitting a bent segment
 * produces it, so the two halves trace exactly the curve they came from.
 */

import type { Pose2D } from "./NavController";

/** A clicked point of the path; `bend` shapes the segment that starts here. */
export interface PathVertex extends Pose2D {
  bend?: number;
  skew?: number;
}

interface Pt {
  x: number;
  y: number;
}

/** Fine steps per segment when measuring and sampling a curve. */
const FINE = 96;

/** The unit normal to the left of the segment a → b, or undefined when a and b coincide. */
function leftNormal(a: Pt, b: Pt): Pt | undefined {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return undefined;
  return { x: -dy / len, y: dx / len };
}

/** Where the middle of segment a → b's curve sits: off the chord's middle by `bend` across and `skew` along. */
function curveMiddle(a: PathVertex, b: Pt): Pt {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const n = leftNormal(a, b);
  if (!n) return { x: mx, y: my };
  const bend = a.bend ?? 0;
  const skew = a.skew ?? 0;
  // The chord direction is the normal turned back by 90°.
  return { x: mx + bend * n.x + skew * n.y, y: my + bend * n.y - skew * n.x };
}

/** The Bézier control point of segment a → b. The curve's middle is (a + 2c + b) / 4, so c sits twice as far out. */
function controlPoint(a: PathVertex, b: Pt): Pt {
  const m = curveMiddle(a, b);
  return { x: 2 * m.x - (a.x + b.x) / 2, y: 2 * m.y - (a.y + b.y) / 2 };
}

function bezier(a: Pt, c: Pt, b: Pt, t: number): Pt {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

function tangentYaw(a: Pt, c: Pt, b: Pt, t: number): number {
  const dx = 2 * (1 - t) * (c.x - a.x) + 2 * t * (b.x - c.x);
  const dy = 2 * (1 - t) * (c.y - a.y) + 2 * t * (b.y - c.y);
  return Math.atan2(dy, dx);
}

/** Where segment `i` has its bend handle: the middle of the curve. */
export function bendHandle(path: PathVertex[], i: number): Pt | undefined {
  const a = path[i];
  const b = path[i + 1];
  if (!a || !b) return undefined;
  return curveMiddle(a, b);
}

/** The bend that puts segment `i`'s handle closest to `p`: its distance off the straight line. */
export function bendToward(path: PathVertex[], i: number, p: Pt): number {
  const a = path[i];
  const b = path[i + 1];
  if (!a || !b) return 0;
  const n = leftNormal(a, b);
  if (!n) return 0;
  return (p.x - (a.x + b.x) / 2) * n.x + (p.y - (a.y + b.y) / 2) * n.y;
}

/** A fine polyline of one segment, first point included, with arc lengths. */
function fineSegment(a: PathVertex, b: PathVertex): { pts: Pt[]; lengths: number[]; c: Pt } {
  const c = controlPoint(a, b);
  const straight = Math.abs(a.bend ?? 0) < 1e-9 && Math.abs(a.skew ?? 0) < 1e-9;
  const steps = straight ? 1 : FINE;
  const pts: Pt[] = [];
  const lengths: number[] = [0];
  for (let k = 0; k <= steps; k++) {
    const p = bezier(a, c, b, k / steps);
    if (k > 0) {
      const q = pts[pts.length - 1]!;
      lengths.push(lengths[lengths.length - 1]! + Math.hypot(p.x - q.x, p.y - q.y));
    }
    pts.push(p);
  }
  return { pts, lengths, c };
}

/** Length of the drawn path along its curves, in metres. */
export function curvedLength(path: PathVertex[]): number {
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const { lengths } = fineSegment(path[i]!, path[i + 1]!);
    total += lengths[lengths.length - 1]!;
  }
  return total;
}

/** Length of segment `i` along its curve. */
export function segmentLength(path: PathVertex[], i: number): number {
  const a = path[i];
  const b = path[i + 1];
  if (!a || !b) return 0;
  const { lengths } = fineSegment(a, b);
  return lengths[lengths.length - 1]!;
}

/** The curve as a fine polyline, for drawing. */
export function curvePolyline(path: PathVertex[]): Pose2D[] {
  if (path.length < 2) return path.map((p) => ({ x: p.x, y: p.y, yaw: p.yaw }));
  const out: Pose2D[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const { pts } = fineSegment(path[i]!, path[i + 1]!);
    for (let k = i === 0 ? 0 : 1; k < pts.length; k++) out.push({ x: pts[k]!.x, y: pts[k]!.y, yaw: 0 });
  }
  return out;
}

/**
 * Poses along the path at most `step` metres apart, heading along the curve.
 *
 * Every clicked point is kept exactly, so a sharp corner is not cut; each
 * segment is divided into equal pieces no longer than `step`. The last pose
 * faces the way the path arrives, not an arbitrary 0°.
 */
export function samplePath(path: PathVertex[], step: number): Pose2D[] {
  if (path.length === 0) return [];
  if (path.length === 1) return [{ x: path[0]!.x, y: path[0]!.y, yaw: path[0]!.yaw }];
  const spacing = Math.max(0.005, step);
  const out: Pose2D[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const { pts, lengths, c } = fineSegment(a, b);
    const total = lengths[lengths.length - 1]!;
    if (total < 1e-6) continue;
    const n = Math.max(1, Math.ceil(total / spacing - 1e-9));
    const fineSteps = pts.length - 1;
    let j = 0;
    for (let k = 0; k < n; k++) {
      // Walk to the fine step holding this arc length, then interpolate inside it.
      const s = (total * k) / n;
      while (j < fineSteps - 1 && lengths[j + 1]! < s) j++;
      const span = lengths[j + 1]! - lengths[j]!;
      const f = span > 0 ? (s - lengths[j]!) / span : 0;
      const t = (j + f) / fineSteps;
      const p = k === 0 ? { x: a.x, y: a.y } : bezier(a, c, b, t);
      out.push({ x: p.x, y: p.y, yaw: tangentYaw(a, c, b, t) });
    }
  }
  const lastA = path[path.length - 2]!;
  const last = path[path.length - 1]!;
  const cLast = controlPoint(lastA, last);
  const endYaw = Math.hypot(last.x - lastA.x, last.y - lastA.y) > 1e-6 ? tangentYaw(lastA, cLast, last, 1) : out[out.length - 1]?.yaw ?? last.yaw;
  out.push({ x: last.x, y: last.y, yaw: endYaw });
  return out;
}

/** Split segment `i` at the middle of its curve into two bent segments that trace the same curve. */
export function splitSegment(path: PathVertex[], i: number): PathVertex[] {
  const a = path[i];
  const b = path[i + 1];
  if (!a || !b) return path;
  const c = controlPoint(a, b);
  const mid = bezier(a, c, b, 0.5);
  // De Casteljau: the halves' control points are halfway to c.
  const c1 = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 };
  const c2 = { x: (c.x + b.x) / 2, y: (c.y + b.y) / 2 };
  // A control point sits twice as far from the chord's middle as the curve's middle does.
  const shape = (p: Pt, cp: Pt, q: Pt): { bend?: number; skew?: number } => {
    const n = leftNormal(p, q);
    if (!n) return {};
    const dx = (cp.x - (p.x + q.x) / 2) / 2;
    const dy = (cp.y - (p.y + q.y) / 2) / 2;
    const bend = dx * n.x + dy * n.y;
    const skew = dx * n.y - dy * n.x;
    return { bend: Math.abs(bend) < 1e-9 ? undefined : bend, skew: Math.abs(skew) < 1e-9 ? undefined : skew };
  };
  const first: PathVertex = { ...a, ...shape(a, c1, mid) };
  const middle: PathVertex = { x: mid.x, y: mid.y, yaw: tangentYaw(a, c, b, 0.5), ...shape(mid, c2, b) };
  return [...path.slice(0, i), first, middle, ...path.slice(i + 1)];
}

export type ExportFormat = "xy" | "xyyaw" | "csv";

export interface ExportOptions {
  step: number;
  format: ExportFormat;
  /** Start the list with `(rx, ry),`, the robot position a script reads from TF. */
  robotStart: boolean;
  decimals: number;
  frame: string;
}

/** A list of poses as Python tuples, `make_pose(...)` calls, or CSV. */
function formatPoses(
  poses: Pose2D[],
  format: ExportFormat | WaypointFormat,
  decimals: number,
  summary: string,
  varName: string,
  robotStart: boolean,
): string {
  const d = Math.min(6, Math.max(0, Math.round(decimals)));
  const num = (v: number): string => {
    const s = v.toFixed(d);
    return s === `-${(0).toFixed(d)}` ? (0).toFixed(d) : s;
  };
  const deg = (yaw: number): string => {
    const s = ((yaw * 180) / Math.PI).toFixed(1);
    return s === "-0.0" ? "0.0" : s;
  };
  if (format === "csv") return ["x,y,yaw_deg", ...poses.map((p) => `${num(p.x)},${num(p.y)},${deg(p.yaw)}`)].join("\n");
  const row = (p: Pose2D): string => {
    if (format === "xyyaw") return `    (${num(p.x)}, ${num(p.y)}, ${deg(p.yaw)}),`;
    if (format === "make_pose") return `    make_pose(nav, ${num(p.x)}, ${num(p.y)}, ${deg(p.yaw)}),`;
    return `    (${num(p.x)}, ${num(p.y)}),`;
  };
  const note = format === "xyyaw" ? "; (x, y, yaw_deg)" : format === "make_pose" ? "; make_pose(nav, x, y, yaw_deg)" : "";
  const lines = [`# ${summary}${note}`, `${varName} = [`];
  if (robotStart) lines.push(format === "xyyaw" ? "    (rx, ry, 0.0)," : "    (rx, ry),");
  lines.push(...poses.map(row), "]");
  return lines.join("\n");
}

/** The sampled path as text to paste into code: a Python list or CSV. */
export function formatPath(path: PathVertex[], options: ExportOptions): { text: string; count: number } {
  const poses = samplePath(path, options.step);
  const summary = `${poses.length} points, at most ${options.step} m apart, ${curvedLength(path).toFixed(2)} m, frame ${options.frame || "(unset)"}`;
  return { text: formatPoses(poses, options.format, options.decimals, summary, "points", options.robotStart && options.format !== "csv"), count: poses.length };
}

export type WaypointFormat = "xyyaw" | "make_pose" | "xy" | "csv";

/**
 * Waypoints as text to paste into code. `make_pose` gives the calls a
 * nav2_simple_commander script builds its goals with, ready for
 * `nav.followWaypoints(goals)` or `nav.goThroughPoses(goals)`.
 */
export function formatWaypoints(poses: Pose2D[], options: { format: WaypointFormat; decimals: number; frame: string }): string {
  const summary = `${poses.length} waypoint${poses.length === 1 ? "" : "s"}, frame ${options.frame || "(unset)"}`;
  return formatPoses(poses, options.format, options.decimals, summary, options.format === "make_pose" ? "goals" : "waypoints", false);
}
