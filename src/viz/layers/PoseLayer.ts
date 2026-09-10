import {
  AxesHelper,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
} from "three";
import { Layer, disposeObject } from "./Layer";
import type { SettingsSchema, SettingsValues } from "./Layer";
import type { Odometry, Pose, PoseStamped, PoseWithCovarianceStamped } from "../../ros/types";
import { normalizeSchemaName } from "../../ros/types";

const SCHEMA: SettingsSchema = {
  shape: { type: "select", label: "Shape", options: ["arrow", "axes"] },
  size: { type: "number", label: "Size (m)", min: 0.05, max: 5, step: 0.05 },
  color: { type: "color", label: "Arrow color" },
  trail: { type: "number", label: "Trail length (0 = off)", min: 0, max: 5000, step: 10 },
  trailColor: { type: "color", label: "Trail color" },
};

const DEFAULTS: SettingsValues = {
  shape: "arrow",
  size: 0.5,
  color: "#ff3060",
  trail: 0,
  trailColor: "#ff8fa8",
};

/** Odometry / PoseStamped / PoseWithCovarianceStamped as an arrow or axes, with optional trail. */
export class PoseLayer extends Layer {
  readonly schema = SCHEMA;
  #marker = new Group();
  #arrow?: Group;
  #axes?: AxesHelper;
  #trail: Line<BufferGeometry, LineBasicMaterial>;
  #trailPts: number[] = [];
  #kind: "odom" | "pose" | "posecov";

  constructor(topic: string, schemaName: string, initial?: Partial<SettingsValues>) {
    super(topic, schemaName, DEFAULTS, initial);
    const n = normalizeSchemaName(schemaName);
    this.#kind = n === "nav_msgs/Odometry" ? "odom" : n === "geometry_msgs/PoseWithCovarianceStamped" ? "posecov" : "pose";
    if (this.#kind === "odom" && initial?.trail === undefined) this.settings.trail = 500;
    if (this.#kind === "odom" && initial?.color === undefined) this.settings.color = "#40a0ff";
    this.root.add(this.#marker);
    this.#trail = new Line(new BufferGeometry(), new LineBasicMaterial({ color: this.str("trailColor") }));
    this.#trail.frustumCulled = false;
    this.root.add(this.#trail);
    this.#buildShape();
  }

  onMessage(msg: unknown, receiveMs: number): void {
    this.lastMessageMs = receiveMs;
    this.messageCount++;
    let pose: Pose;
    let frame: string;
    if (this.#kind === "odom") {
      const m = msg as Odometry;
      pose = m.pose.pose;
      frame = m.header.frame_id;
    } else if (this.#kind === "posecov") {
      const m = msg as PoseWithCovarianceStamped;
      pose = m.pose.pose;
      frame = m.header.frame_id;
    } else {
      const m = msg as PoseStamped;
      pose = m.pose;
      frame = m.header.frame_id;
    }
    if (this.frameId !== frame) this.#trailPts = [];
    this.frameId = frame;
    const p = pose.position;
    const q = pose.orientation;
    this.#marker.position.set(p.x, p.y, p.z);
    const quat = new Quaternion(q.x, q.y, q.z, q.w);
    if (quat.lengthSq() < 1e-9) quat.identity();
    this.#marker.quaternion.copy(quat);

    const trailLen = Math.floor(this.num("trail"));
    if (trailLen > 0) {
      const pts = this.#trailPts;
      const last = pts.length;
      const dx = last ? p.x - pts[last - 3]! : Infinity;
      const dy = last ? p.y - pts[last - 2]! : Infinity;
      const dz = last ? p.z - pts[last - 1]! : Infinity;
      if (dx * dx + dy * dy + dz * dz > 1e-4) {
        pts.push(p.x, p.y, p.z);
        while (pts.length > trailLen * 3) pts.splice(0, 3);
        const geom = new BufferGeometry();
        geom.setAttribute("position", new BufferAttribute(new Float32Array(pts), 3));
        const old = this.#trail.geometry;
        this.#trail.geometry = geom;
        old.dispose();
      }
      this.#trail.visible = true;
    } else {
      this.#trail.visible = false;
    }
    this.status = "";
  }

  protected onSettingsChanged(key: string): void {
    if (key === "shape" || key === "size" || key === "color") this.#buildShape();
    if (key === "trailColor") this.#trail.material.color.set(this.str("trailColor"));
    if (key === "trail" && this.num("trail") === 0) {
      this.#trailPts = [];
      this.#trail.visible = false;
    }
  }

  #buildShape(): void {
    if (this.#arrow) {
      disposeObject(this.#arrow);
      this.#marker.remove(this.#arrow);
      this.#arrow = undefined;
    }
    if (this.#axes) {
      this.#axes.dispose();
      this.#marker.remove(this.#axes);
      this.#axes = undefined;
    }
    const size = this.num("size");
    if (this.str("shape") === "axes") {
      this.#axes = new AxesHelper(size);
      this.#marker.add(this.#axes);
      return;
    }
    // Arrow along +X (ROS forward).
    const color = new Color(this.str("color"));
    const mat = new MeshBasicMaterial({ color });
    const shaftLen = size * 0.65;
    const headLen = size * 0.35;
    const shaft = new Mesh(new CylinderGeometry(size * 0.06, size * 0.06, shaftLen, 12), mat);
    shaft.rotation.z = -Math.PI / 2;
    shaft.position.x = shaftLen / 2;
    const head = new Mesh(new ConeGeometry(size * 0.15, headLen, 16), mat);
    head.rotation.z = -Math.PI / 2;
    head.position.x = shaftLen + headLen / 2;
    const g = new Group();
    g.add(shaft, head);
    this.#arrow = g;
    this.#marker.add(g);
  }

  dispose(): void {
    disposeObject(this.root);
  }
}
