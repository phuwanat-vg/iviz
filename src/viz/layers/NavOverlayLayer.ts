/**
 * Draws the navigation drafts and the running task on the map: numbered
 * waypoints with a heading arrow, the drawn path, and the progress of the
 * task iViz is driving. Markers keep a constant size on screen.
 */

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  Line,
  LineBasicMaterial,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  Shape,
  ShapeGeometry,
  Sprite,
  SpriteMaterial,
} from "three";
import { Layer, disposeObject } from "./Layer";
import type { LayerContext, SettingsSchema } from "./Layer";
import type { Viewer } from "../Viewer";
import type { Pose2D, TaskKind } from "../../nav/NavController";

export interface NavOverlayState {
  /** Frame the drafts are in. */
  frame: string;
  waypoints: Pose2D[];
  /** Vertices of the drawn path. */
  path: Pose2D[];
  /** The waypoint being placed, while the mouse is held. */
  preview?: Pose2D;
  active?: {
    kind: TaskKind;
    frame: string;
    poses: Pose2D[];
    index: number;
    running: boolean;
  };
}

const COLOR = {
  draft: "#f2b134",
  current: "#3ccf7a",
  done: "#6b7482",
  path: "#40c8ff",
  activePath: "#3ccf7a",
};

const MARKER_PX = 22;
const Z = 0.06;

interface Marker {
  x: number;
  y: number;
  group: Group;
  arrow: Mesh;
  label: Sprite;
}

export class NavOverlayLayer extends Layer {
  readonly schema: SettingsSchema = {};
  #viewer: Viewer;
  #state: NavOverlayState = { frame: "", waypoints: [], path: [] };
  #markers: Marker[] = [];
  #content = new Group();
  #textures = new Map<string, CanvasTexture>();
  #arrowGeometry: ShapeGeometry;

  constructor(viewer: Viewer) {
    super("Navigation", "iviz/nav_overlay", {});
    this.#viewer = viewer;
    const s = new Shape();
    s.moveTo(0.75, 0.42);
    s.lineTo(2.1, 0);
    s.lineTo(0.75, -0.42);
    s.closePath();
    this.#arrowGeometry = new ShapeGeometry(s);
    this.root.add(this.#content);
    this.root.renderOrder = 900;
  }

  onMessage(): void {
    /* driven by setState */
  }

  setState(state: NavOverlayState): void {
    this.#state = state;
    this.#rebuild();
  }

  update(ctx: LayerContext): void {
    const frame = this.#state.frame || this.#state.active?.frame || "";
    this.frameId = frame;
    if (!this.visible || !frame) {
      this.root.visible = false;
      return;
    }
    if (!this.applyTf(ctx, this.root, frame)) return;
    for (const m of this.#markers) {
      const s = this.#viewer.worldPerPixel(m.x, m.y, 0);
      m.arrow.scale.setScalar((MARKER_PX / 2) * s);
      m.label.scale.set(MARKER_PX * s, MARKER_PX * s, 1);
    }
  }

  dispose(): void {
    this.#clear();
    for (const t of this.#textures.values()) t.dispose();
    this.#textures.clear();
    this.#arrowGeometry.dispose();
    disposeObject(this.root);
  }

  // ----- drawing -----------------------------------------------------------

  #rebuild(): void {
    this.#clear();
    const st = this.#state;
    const active = st.active;
    const activeStops = active && active.kind !== "path";

    // Drawn path (draft), unless the same path is being followed.
    if (st.path.length > 0 && active?.kind !== "path") {
      this.#polyline(st.path, COLOR.path, 0.9);
      this.#dots(st.path, COLOR.path, 7);
    }

    if (active?.kind === "path") {
      const split = Math.min(active.index, active.poses.length - 1);
      if (split > 0) this.#polyline(active.poses.slice(0, split + 1), COLOR.done, 0.7);
      this.#polyline(active.poses.slice(split), COLOR.activePath, 1);
      const end = active.poses[active.poses.length - 1];
      if (end) this.#marker(end, "⚑", COLOR.activePath);
    }

    if (activeStops) {
      const poses = active.poses;
      if (poses.length > 1) this.#polyline(poses, COLOR.done, 0.6);
      poses.forEach((p, i) => {
        const color = i < active.index ? COLOR.done : i === active.index ? COLOR.current : COLOR.draft;
        this.#marker(p, active.kind === "goal" ? "⚑" : String(i + 1), color);
      });
    } else if (st.waypoints.length > 0) {
      if (st.waypoints.length > 1) this.#polyline(st.waypoints, COLOR.draft, 0.6);
      st.waypoints.forEach((p, i) => this.#marker(p, String(i + 1), COLOR.draft));
    }

    if (st.preview) this.#marker(st.preview, String(st.waypoints.length + 1), COLOR.current);
  }

  #clear(): void {
    for (const child of [...this.#content.children]) {
      this.#content.remove(child);
      child.traverse((o) => {
        const anyO = o as unknown as { geometry?: BufferGeometry; material?: { dispose(): void } };
        if (anyO.geometry && anyO.geometry !== this.#arrowGeometry) anyO.geometry.dispose();
        anyO.material?.dispose();
      });
    }
    this.#markers = [];
  }

  #polyline(points: Pose2D[], color: string, opacity: number): void {
    const pos = new Float32Array(points.length * 3);
    points.forEach((p, i) => pos.set([p.x, p.y, Z], i * 3));
    const geom = new BufferGeometry();
    geom.setAttribute("position", new BufferAttribute(pos, 3));
    const line = new Line(geom, new LineBasicMaterial({ color, transparent: true, opacity, depthTest: false }));
    line.frustumCulled = false;
    line.renderOrder = 900;
    this.#content.add(line);
  }

  #dots(points: Pose2D[], color: string, px: number): void {
    const pos = new Float32Array(points.length * 3);
    points.forEach((p, i) => pos.set([p.x, p.y, Z], i * 3));
    const geom = new BufferGeometry();
    geom.setAttribute("position", new BufferAttribute(pos, 3));
    const pts = new Points(geom, new PointsMaterial({ color, size: px, sizeAttenuation: false, depthTest: false }));
    pts.frustumCulled = false;
    pts.renderOrder = 901;
    this.#content.add(pts);
  }

  #marker(p: Pose2D, text: string, color: string): void {
    const group = new Group();
    group.position.set(p.x, p.y, Z);
    const arrow = new Mesh(this.#arrowGeometry, new MeshBasicMaterial({ color, depthTest: false, transparent: true }));
    arrow.rotation.z = p.yaw;
    arrow.renderOrder = 902;
    const label = new Sprite(new SpriteMaterial({ map: this.#texture(text, color), depthTest: false, transparent: true }));
    label.renderOrder = 903;
    group.add(arrow, label);
    this.#content.add(group);
    this.#markers.push({ x: p.x, y: p.y, group, arrow, label });
  }

  #texture(text: string, color: string): CanvasTexture {
    const key = `${text}|${color}`;
    let tex = this.#textures.get(key);
    if (tex) return tex;
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const c = canvas.getContext("2d")!;
    c.beginPath();
    c.arc(32, 32, 27, 0, Math.PI * 2);
    c.fillStyle = color;
    c.fill();
    c.lineWidth = 5;
    c.strokeStyle = "rgba(10, 12, 16, 0.85)";
    c.stroke();
    c.fillStyle = "#0b0e12";
    c.font = `bold ${text.length > 1 ? 26 : 32}px system-ui, sans-serif`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(text, 32, 34);
    tex = new CanvasTexture(canvas);
    tex.minFilter = LinearFilter;
    this.#textures.set(key, tex);
    return tex;
  }
}
