import {
  AxesHelper,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Group,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Sprite,
  SpriteMaterial,
  Vector3,
} from "three";
import { Layer, disposeObject } from "./Layer";
import type { LayerContext, SettingsSchema, SettingsValues } from "./Layer";

const SCHEMA: SettingsSchema = {
  axisSize: { type: "number", label: "Axis size (m)", min: 0.05, max: 3, step: 0.05 },
  showNames: { type: "boolean", label: "Show frame names" },
  showLinks: { type: "boolean", label: "Show parent links" },
};

const DEFAULTS: SettingsValues = { axisSize: 0.3, showNames: true, showLinks: true };

interface FrameVis {
  group: Group;
  axes: AxesHelper;
  label?: Sprite;
}

const _m = new Matrix4();
const _a = new Vector3();
const _b = new Vector3();

/** Draws every TF frame as an axes triad, like rviz's TF display. Not tied to a topic. */
export class TfLayer extends Layer {
  readonly schema = SCHEMA;
  #frames = new Map<string, FrameVis>();
  #links: LineSegments<BufferGeometry, LineBasicMaterial>;
  #labelCache = new Map<string, CanvasTexture>();

  constructor(initial?: Partial<SettingsValues>) {
    super("TF", "tf2_msgs/msg/TFMessage", DEFAULTS, initial);
    this.#links = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0x9aa4b2 }));
    this.#links.frustumCulled = false;
    this.root.add(this.#links);
  }

  onMessage(): void {
    /* TF data flows through TfTree directly */
  }

  update(ctx: LayerContext): void {
    this.root.matrix.identity();
    this.root.visible = this.visible;
    if (!this.visible) return;
    const frames = ctx.tf.frames();
    const size = this.num("axisSize");
    const showNames = this.bool("showNames");
    const seen = new Set<string>();
    const linkPts: number[] = [];

    for (const f of frames) {
      seen.add(f);
      let vis = this.#frames.get(f);
      if (!vis) {
        const group = new Group();
        group.matrixAutoUpdate = false;
        const axes = new AxesHelper(1);
        group.add(axes);
        vis = { group, axes };
        this.root.add(group);
        this.#frames.set(f, vis);
      }
      vis.axes.scale.setScalar(size);
      if (showNames && !vis.label) {
        vis.label = this.#makeLabel(f);
        vis.group.add(vis.label);
      } else if (!showNames && vis.label) {
        vis.group.remove(vis.label);
        vis.label.material.dispose();
        vis.label = undefined;
      }
      if (vis.label) {
        vis.label.position.set(0, 0, size * 1.1);
        vis.label.scale.set(size * 2.2, size * 0.55, 1);
      }
      if (ctx.tf.lookup(ctx.fixedFrame, f, _m)) {
        vis.group.matrix.copy(_m);
        vis.group.visible = true;
        const parent = ctx.tf.parentOf(f);
        if (this.bool("showLinks") && parent && ctx.tf.lookup(ctx.fixedFrame, parent, _m)) {
          _a.setFromMatrixPosition(vis.group.matrix);
          _b.setFromMatrixPosition(_m);
          linkPts.push(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z);
        }
      } else {
        vis.group.visible = false;
      }
    }
    for (const [name, vis] of this.#frames) {
      if (!seen.has(name)) {
        this.root.remove(vis.group);
        vis.axes.dispose();
        vis.label?.material.dispose();
        this.#frames.delete(name);
      }
    }
    const geom = new BufferGeometry();
    geom.setAttribute("position", new BufferAttribute(new Float32Array(linkPts), 3));
    const old = this.#links.geometry;
    this.#links.geometry = geom;
    old.dispose();
    this.#links.visible = linkPts.length > 0;
  }

  #makeLabel(text: string): Sprite {
    let tex = this.#labelCache.get(text);
    if (!tex) {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 64;
      const c = canvas.getContext("2d")!;
      c.clearRect(0, 0, 256, 64);
      c.font = "bold 28px system-ui, sans-serif";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.lineWidth = 6;
      c.strokeStyle = "rgba(0,0,0,0.85)";
      c.strokeText(text, 128, 32);
      c.fillStyle = "#ffffff";
      c.fillText(text, 128, 32);
      tex = new CanvasTexture(canvas);
      this.#labelCache.set(text, tex);
    }
    const mat = new SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    return new Sprite(mat);
  }

  dispose(): void {
    for (const t of this.#labelCache.values()) t.dispose();
    this.#labelCache.clear();
    disposeObject(this.root);
  }
}
