import {
  AxesHelper,
  Color,
  ConeGeometry,
  CylinderGeometry,
  GridHelper,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MOUSE,
  OrthographicCamera,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { TfTree } from "../ros/TfTree";
import type { Layer } from "./layers/Layer";

export type ViewMode = "2d" | "3d";
/** The built-in pose tools plus the name of any tool registered with `registerTool`. */
export type PoseTool = "none" | "goal" | "initialpose";
export type ToolName = PoseTool | (string & {});

export interface PoseToolResult {
  kind: "goal" | "initialpose";
  x: number;
  y: number;
  yaw: number;
}

/** A pointer event already resolved onto the ground plane of the fixed frame. */
export interface ToolPointerEvent {
  /** Where the ray hit z = 0, or null when it misses (camera looking up). */
  world: Vector3 | null;
  button: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  pointerId: number;
  clientX: number;
  clientY: number;
  /** Metres per screen pixel at the hit point; use it for hit radii. */
  worldPerPixel: number;
  native: PointerEvent;
}

/**
 * A tool that owns the left mouse button while it is active. Camera navigation
 * stays available on the middle and right buttons, so the same mechanism works
 * in 2D and in 3D.
 */
export interface ViewerTool {
  cursor?: string;
  onPointerDown?(ev: ToolPointerEvent): void;
  onPointerMove?(ev: ToolPointerEvent): void;
  onPointerUp?(ev: ToolPointerEvent): void;
  onActivate?(): void;
  onDeactivate?(): void;
}

const _m = new Matrix4();
const _v = new Vector3();
const _v2 = new Vector3();
const GROUND = new Plane(new Vector3(0, 0, 1), 0);

/**
 * Owns the three.js scene, cameras, controls and the render loop.
 * The scene's world coordinates are the fixed frame (ROS: x forward, y left, z up).
 */
export class Viewer {
  readonly container: HTMLElement;
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly tf: TfTree;

  #layers = new Set<Layer>();
  #fixedFrame = "map";
  #mode: ViewMode = "3d";
  followFrame = "";

  #persp: PerspectiveCamera;
  #ortho: OrthographicCamera;
  #orbit: OrbitControls;
  #pan2d: Pan2DControls;

  #grid: GridHelper;
  #axes: AxesHelper;

  #tool: ToolName = "none";
  #customTools = new Map<string, ViewerTool>();
  onPoseTool?: (r: PoseToolResult) => void;
  /** Fired whenever the active tool changes, including auto-deactivation after use. */
  onToolChange?: (tool: ToolName) => void;
  #toolStart?: Vector3;
  #toolPreview: Group;
  #raycaster = new Raycaster();

  fps = 0;
  #frameCount = 0;
  #fpsTime = performance.now();
  #resizeObserver: ResizeObserver;

  constructor(container: HTMLElement, tf: TfTree) {
    this.container = container;
    this.tf = tf;
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.tabIndex = 0;
    container.appendChild(this.renderer.domElement);
    this.scene.background = new Color("#15181d");

    this.#persp = new PerspectiveCamera(60, 1, 0.05, 2000);
    this.#persp.up.set(0, 0, 1);
    this.#persp.position.set(-8, -8, 8);
    this.#persp.lookAt(0, 0, 0);
    this.#orbit = new OrbitControls(this.#persp, this.renderer.domElement);
    this.#orbit.enableDamping = true;
    this.#orbit.dampingFactor = 0.15;
    this.#orbit.maxPolarAngle = Math.PI * 0.499;
    this.#orbit.screenSpacePanning = false;

    this.#ortho = new OrthographicCamera(-10, 10, 10, -10, 0.1, 5000);
    this.#ortho.up.set(0, 1, 0);
    this.#ortho.position.set(0, 0, 1000);
    this.#ortho.lookAt(0, 0, 0);
    this.#pan2d = new Pan2DControls(this.#ortho, this.renderer.domElement);
    this.#pan2d.enabled = false;

    this.#grid = new GridHelper(200, 200, 0x3a4250, 0x262c36);
    this.#grid.rotation.x = Math.PI / 2;
    this.#grid.position.z = -0.002;
    this.scene.add(this.#grid);
    this.#axes = new AxesHelper(1);
    this.scene.add(this.#axes);

    this.#toolPreview = makeArrow("#ffd040", 1);
    this.#toolPreview.visible = false;
    this.scene.add(this.#toolPreview);

    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(container);
    this.#resize();

    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.#onPointerDown);
    el.addEventListener("pointermove", this.#onPointerMove);
    el.addEventListener("pointerup", this.#onPointerUp);
    el.addEventListener("contextmenu", (e) => e.preventDefault());

    this.renderer.setAnimationLoop(() => this.#frame());
  }

  // ----- public API -------------------------------------------------------

  get fixedFrame(): string {
    return this.#fixedFrame;
  }
  setFixedFrame(frame: string): void {
    if (frame === this.#fixedFrame) return;
    this.#fixedFrame = frame;
    for (const l of this.#layers) l.onFixedFrameChanged();
  }

  get mode(): ViewMode {
    return this.#mode;
  }
  setMode(mode: ViewMode): void {
    if (mode === this.#mode) return;
    this.#mode = mode;
    if (mode === "2d") {
      // Keep looking at the same spot.
      this.#pan2d.center.set(this.#orbit.target.x, this.#orbit.target.y);
      const dist = this.#persp.position.distanceTo(this.#orbit.target);
      this.#pan2d.metersPerPixel = (dist * 1.2) / Math.max(1, this.container.clientHeight);
    } else {
      this.#orbit.target.set(this.#pan2d.center.x, this.#pan2d.center.y, 0);
      const dist = this.#pan2d.metersPerPixel * this.container.clientHeight;
      this.#persp.position.set(this.#orbit.target.x - dist * 0.6, this.#orbit.target.y - dist * 0.6, dist * 0.7);
    }
    // Re-apply the current tool so it keeps the same grip on the new controls.
    this.#applyToolControls();
    this.#resize();
  }

  get tool(): ToolName {
    return this.#tool;
  }

  /**
   * Add a tool that takes over the left button while it is active. Camera
   * navigation keeps the middle and right buttons, unlike the pose tools which
   * take the whole view for one click-and-drag.
   */
  registerTool(name: string, tool: ViewerTool): void {
    this.#customTools.set(name, tool);
  }
  unregisterTool(name: string): void {
    if (this.#tool === name) this.setTool("none");
    this.#customTools.delete(name);
  }

  setTool(tool: ToolName): void {
    const changed = tool !== this.#tool;
    const previous = this.#customTools.get(this.#tool);
    this.#tool = tool;
    this.#toolStart = undefined;
    this.#toolPreview.visible = false;
    if (changed) previous?.onDeactivate?.();
    this.#applyToolControls();
    if (changed) {
      this.#customTools.get(tool)?.onActivate?.();
      this.onToolChange?.(tool);
    }
  }

  /** Give the controls and the cursor the grip the active tool asks for. */
  #applyToolControls(): void {
    const custom = this.#customTools.get(this.#tool);
    const free = this.#tool === "none";
    // Pose tools own the view; custom tools own only the left button.
    this.#orbit.enabled = (free || custom !== undefined) && this.#mode === "3d";
    this.#pan2d.enabled = (free || custom !== undefined) && this.#mode === "2d";
    this.#pan2d.allowLeftDrag = free;
    this.#orbit.mouseButtons.LEFT = custom ? null : MOUSE.ROTATE;
    this.renderer.domElement.style.cursor = custom ? (custom.cursor ?? "default") : free ? "" : "crosshair";
  }

  /** Change the cursor of the active custom tool (drag feedback). */
  setToolCursor(cursor: string): void {
    if (this.#customTools.has(this.#tool)) this.renderer.domElement.style.cursor = cursor;
  }

  set showGrid(v: boolean) {
    this.#grid.visible = v;
    this.#axes.visible = v;
  }
  get showGrid(): boolean {
    return this.#grid.visible;
  }

  get layers(): Layer[] {
    return [...this.#layers];
  }
  addLayer(layer: Layer): void {
    this.#layers.add(layer);
    this.scene.add(layer.root);
  }
  removeLayer(layer: Layer): void {
    this.#layers.delete(layer);
    this.scene.remove(layer.root);
    layer.dispose();
  }

  get pointCount(): number {
    let n = 0;
    for (const l of this.#layers) n += l.pointCount;
    return n;
  }

  /** Where a point on the ground plane lands on screen, in CSS pixels. */
  worldToScreenPoint(x: number, y: number, z = 0): { x: number; y: number } {
    const out = new Vector2();
    this.projectToScreen(_v2.set(x, y, z), out);
    return { x: out.x, y: out.y };
  }

  /** Move the camera so a world rectangle fills the view, with a margin. */
  frameBounds(minX: number, minY: number, maxX: number, maxY: number, marginM = 1.5): void {
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const w = Math.max(0.5, maxX - minX) + marginM * 2;
    const h = Math.max(0.5, maxY - minY) + marginM * 2;
    const { width, height } = this.viewSize;
    const mpp = Math.max(w / width, h / height);
    this.#pan2d.center.set(cx, cy);
    this.#pan2d.metersPerPixel = mpp;
    this.#orbit.target.set(cx, cy, 0);
    const dist = mpp * height;
    this.#persp.position.set(cx - dist * 0.5, cy - dist * 0.5, dist * 0.8);
    this.#resize();
  }

  resetView(): void {
    this.#orbit.target.set(0, 0, 0);
    this.#persp.position.set(-8, -8, 8);
    this.#pan2d.center.set(0, 0);
    this.#pan2d.metersPerPixel = 20 / Math.max(1, this.container.clientHeight);
    this.#resize();
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.#resizeObserver.disconnect();
    this.#orbit.dispose();
    this.#pan2d.dispose();
    for (const l of this.#layers) l.dispose();
    this.renderer.dispose();
  }

  // ----- internals --------------------------------------------------------

  #activeCamera(): PerspectiveCamera | OrthographicCamera {
    return this.#mode === "2d" ? this.#ortho : this.#persp;
  }

  #resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.#persp.aspect = w / h;
    this.#persp.updateProjectionMatrix();
    this.#pan2d.resize(w, h);
  }

  #frame(): void {
    const now = performance.now();
    const ctx = { tf: this.tf, fixedFrame: this.#fixedFrame, nowMs: now };
    for (const l of this.#layers) l.update(ctx);

    if (this.followFrame && this.tf.lookup(this.#fixedFrame, this.followFrame, _m)) {
      _v.setFromMatrixPosition(_m);
      if (this.#mode === "3d") {
        const dx = _v.x - this.#orbit.target.x;
        const dy = _v.y - this.#orbit.target.y;
        this.#orbit.target.x = _v.x;
        this.#orbit.target.y = _v.y;
        this.#persp.position.x += dx;
        this.#persp.position.y += dy;
      } else {
        this.#pan2d.center.set(_v.x, _v.y);
      }
    }

    if (this.#mode === "3d") this.#orbit.update();
    else this.#pan2d.update();
    this.renderer.render(this.scene, this.#activeCamera());

    this.#frameCount++;
    if (now - this.#fpsTime >= 1000) {
      this.fps = (this.#frameCount * 1000) / (now - this.#fpsTime);
      this.#frameCount = 0;
      this.#fpsTime = now;
    }
  }

  #groundPoint(ev: { clientX: number; clientY: number }, out: Vector3): boolean {
    return this.groundPointFromClient(ev.clientX, ev.clientY, out);
  }

  /**
   * Where the ray through a screen position hits the ground plane of the fixed
   * frame. Route mode uses this both to place new things and to hit-test the
   * route graph, which lies on that plane.
   */
  groundPointFromClient(clientX: number, clientY: number, out: Vector3): boolean {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.#raycaster.setFromCamera(ndc, this.#activeCamera());
    return this.#raycaster.ray.intersectPlane(GROUND, out) !== null;
  }

  /** The camera the view is currently rendered with. */
  get activeCamera(): PerspectiveCamera | OrthographicCamera {
    return this.#activeCamera();
  }

  /** Size of the canvas in CSS pixels. */
  get viewSize(): { width: number; height: number } {
    return { width: Math.max(1, this.container.clientWidth), height: Math.max(1, this.container.clientHeight) };
  }

  /**
   * Metres per screen pixel at a world position. Constant for the orthographic
   * 2D camera; distance dependent for the 3D one. Route mode sizes discs,
   * labels and hit radii with it so they stay usable at every zoom.
   */
  worldPerPixel(x = 0, y = 0, z = 0): number {
    const h = Math.max(1, this.container.clientHeight);
    if (this.#mode === "2d") return this.#pan2d.metersPerPixel;
    const d = this.#persp.position.distanceTo(_v.set(x, y, z));
    return (2 * d * Math.tan((this.#persp.fov * Math.PI) / 360)) / h;
  }

  /** Project a world point to CSS pixels inside the canvas. False when behind the camera. */
  projectToScreen(p: Vector3, out: Vector2): boolean {
    _v.copy(p).project(this.#activeCamera());
    if (_v.z < -1 || _v.z > 1) return false;
    const { width, height } = this.viewSize;
    out.set(((_v.x + 1) / 2) * width, ((1 - _v.y) / 2) * height);
    return true;
  }

  #toolEvent(ev: PointerEvent): ToolPointerEvent {
    const p = new Vector3();
    const hit = this.#groundPoint(ev, p);
    return {
      world: hit ? p : null,
      button: ev.button,
      shiftKey: ev.shiftKey,
      ctrlKey: ev.ctrlKey,
      altKey: ev.altKey,
      pointerId: ev.pointerId,
      clientX: ev.clientX,
      clientY: ev.clientY,
      worldPerPixel: this.worldPerPixel(p.x, p.y, 0),
      native: ev,
    };
  }

  #onPointerDown = (ev: PointerEvent): void => {
    const custom = this.#customTools.get(this.#tool);
    if (custom) {
      if (ev.button === 0) {
        this.renderer.domElement.setPointerCapture(ev.pointerId);
        custom.onPointerDown?.(this.#toolEvent(ev));
      }
      return;
    }
    if (this.#tool === "none" || ev.button !== 0) return;
    const p = new Vector3();
    if (!this.#groundPoint(ev, p)) return;
    this.#toolStart = p;
    this.#toolPreview.position.copy(p);
    this.#toolPreview.rotation.set(0, 0, 0);
    this.#toolPreview.visible = true;
    this.renderer.domElement.setPointerCapture(ev.pointerId);
  };

  #onPointerMove = (ev: PointerEvent): void => {
    const custom = this.#customTools.get(this.#tool);
    if (custom) {
      custom.onPointerMove?.(this.#toolEvent(ev));
      return;
    }
    if (!this.#toolStart) return;
    const p = new Vector3();
    if (!this.#groundPoint(ev, p)) return;
    const yaw = Math.atan2(p.y - this.#toolStart.y, p.x - this.#toolStart.x);
    this.#toolPreview.rotation.set(0, 0, yaw);
  };

  #onPointerUp = (ev: PointerEvent): void => {
    const custom = this.#customTools.get(this.#tool);
    if (custom) {
      if (ev.button === 0) {
        if (this.renderer.domElement.hasPointerCapture(ev.pointerId)) this.renderer.domElement.releasePointerCapture(ev.pointerId);
        custom.onPointerUp?.(this.#toolEvent(ev));
      }
      return;
    }
    if (!this.#toolStart || this.#tool === "none") return;
    const start = this.#toolStart;
    this.#toolStart = undefined;
    this.#toolPreview.visible = false;
    const p = new Vector3();
    let yaw = 0;
    if (this.#groundPoint(ev, p)) {
      const dx = p.x - start.x;
      const dy = p.y - start.y;
      if (dx * dx + dy * dy > 0.01) yaw = Math.atan2(dy, dx);
    }
    const kind = this.#tool === "goal" ? "goal" : "initialpose";
    this.setTool("none");
    this.onPoseTool?.({ kind, x: start.x, y: start.y, yaw });
  };
}

/** Simple top-down pan/zoom controller for the orthographic camera. */
class Pan2DControls {
  enabled = true;
  /** False while an editing tool owns the left button; middle and right still pan. */
  allowLeftDrag = true;
  readonly center = new Vector2(0, 0);
  metersPerPixel = 0.02;
  #camera: OrthographicCamera;
  #el: HTMLElement;
  #w = 1;
  #h = 1;
  #dragging = false;
  #last = new Vector2();

  constructor(camera: OrthographicCamera, el: HTMLElement) {
    this.#camera = camera;
    this.#el = el;
    el.addEventListener("pointerdown", this.#down);
    el.addEventListener("pointermove", this.#move);
    el.addEventListener("pointerup", this.#up);
    el.addEventListener("pointercancel", this.#up);
    el.addEventListener("wheel", this.#wheel, { passive: false });
  }

  resize(w: number, h: number): void {
    this.#w = w;
    this.#h = h;
    this.update();
  }

  update(): void {
    const hw = (this.#w / 2) * this.metersPerPixel;
    const hh = (this.#h / 2) * this.metersPerPixel;
    this.#camera.left = -hw;
    this.#camera.right = hw;
    this.#camera.top = hh;
    this.#camera.bottom = -hh;
    this.#camera.position.set(this.center.x, this.center.y, 1000);
    this.#camera.lookAt(this.center.x, this.center.y, 0);
    this.#camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.#el.removeEventListener("pointerdown", this.#down);
    this.#el.removeEventListener("pointermove", this.#move);
    this.#el.removeEventListener("pointerup", this.#up);
    this.#el.removeEventListener("pointercancel", this.#up);
    this.#el.removeEventListener("wheel", this.#wheel);
  }

  #down = (ev: PointerEvent): void => {
    if (!this.enabled) return;
    if (ev.button !== 0 && ev.button !== 1 && ev.button !== 2) return;
    if (ev.button === 0 && !this.allowLeftDrag) return;
    this.#dragging = true;
    this.#last.set(ev.clientX, ev.clientY);
    this.#el.setPointerCapture(ev.pointerId);
  };
  #move = (ev: PointerEvent): void => {
    if (!this.enabled || !this.#dragging) return;
    const dx = ev.clientX - this.#last.x;
    const dy = ev.clientY - this.#last.y;
    this.#last.set(ev.clientX, ev.clientY);
    this.center.x -= dx * this.metersPerPixel;
    this.center.y += dy * this.metersPerPixel;
  };
  #up = (): void => {
    this.#dragging = false;
  };
  #wheel = (ev: WheelEvent): void => {
    if (!this.enabled) return;
    ev.preventDefault();
    const rect = this.#el.getBoundingClientRect();
    const px = ev.clientX - rect.left - rect.width / 2;
    const py = ev.clientY - rect.top - rect.height / 2;
    const before = this.metersPerPixel;
    const factor = Math.exp(ev.deltaY * 0.0015);
    this.metersPerPixel = Math.min(5, Math.max(0.0005, before * factor));
    // Keep the world point under the cursor fixed.
    const d = before - this.metersPerPixel;
    this.center.x += px * d;
    this.center.y -= py * d;
  };
}

function makeArrow(color: string, size: number): Group {
  const mat = new MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 });
  const shaftLen = size * 0.65;
  const headLen = size * 0.35;
  const shaft = new Mesh(new CylinderGeometry(size * 0.05, size * 0.05, shaftLen, 12), mat);
  shaft.rotation.z = -Math.PI / 2;
  shaft.position.x = shaftLen / 2;
  const head = new Mesh(new ConeGeometry(size * 0.14, headLen, 16), mat);
  head.rotation.z = -Math.PI / 2;
  head.position.x = shaftLen + headLen / 2;
  const g = new Group();
  g.add(shaft, head);
  g.renderOrder = 999;
  return g;
}
