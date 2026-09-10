import { BufferAttribute, BufferGeometry, Points, ShaderMaterial } from "three";
import { Layer, disposeObject } from "./Layer";
import type { SettingsSchema, SettingsValues } from "./Layer";
import { COLORMAPS, applyPointsMaterialOptions, createPointsMaterial } from "../PointsMaterial";
import type { ColorMode, Colormap } from "../PointsMaterial";
import type { LaserScan } from "../../ros/types";

const SCHEMA: SettingsSchema = {
  pointSize: { type: "number", label: "Point size (px)", min: 1, max: 12, step: 0.5 },
  colorMode: { type: "select", label: "Color by", options: ["flat", "intensity", "range"] },
  colormap: { type: "select", label: "Colormap", options: COLORMAPS },
  flatColor: { type: "color", label: "Flat color" },
  autoRange: { type: "boolean", label: "Auto min/max" },
  minValue: { type: "number", label: "Min", step: 0.1 },
  maxValue: { type: "number", label: "Max", step: 0.1 },
  opacity: { type: "number", label: "Opacity", min: 0.05, max: 1, step: 0.05 },
};

const DEFAULTS: SettingsValues = {
  pointSize: 3,
  colorMode: "flat",
  colormap: "rainbow",
  flatColor: "#ff4040",
  autoRange: true,
  minValue: 0,
  maxValue: 10,
  opacity: 1,
};

export class LaserScanLayer extends Layer {
  readonly schema = SCHEMA;
  readonly material: ShaderMaterial;
  #points: Points;
  #count = 0;
  #min = 0;
  #max = 1;

  constructor(topic: string, schemaName: string, initial?: Partial<SettingsValues>) {
    super(topic, schemaName, DEFAULTS, initial);
    this.material = createPointsMaterial();
    this.#points = new Points(new BufferGeometry(), this.material);
    this.#points.frustumCulled = false;
    this.root.add(this.#points);
    this.#applyMaterial();
  }

  get pointCount(): number {
    return this.visible ? this.#count : 0;
  }

  onMessage(msg: unknown, receiveMs: number): void {
    const scan = msg as LaserScan;
    this.lastMessageMs = receiveMs;
    this.messageCount++;
    this.frameId = scan.header.frame_id;
    const ranges = scan.ranges;
    const intens = scan.intensities;
    const useIntensity = this.str("colorMode") === "intensity" && intens && intens.length === ranges.length;
    const n = ranges.length;
    const positions = new Float32Array(n * 3);
    const scalar = new Float32Array(n);
    let k = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      const r = ranges[i]!;
      if (!Number.isFinite(r) || r < scan.range_min || r > scan.range_max) continue;
      const a = scan.angle_min + i * scan.angle_increment;
      positions[k * 3] = r * Math.cos(a);
      positions[k * 3 + 1] = r * Math.sin(a);
      positions[k * 3 + 2] = 0;
      const s = useIntensity ? intens[i]! : r;
      scalar[k] = s;
      if (s < min) min = s;
      if (s > max) max = s;
      k++;
    }
    this.#count = k;
    if (k > 0) {
      this.#min = min;
      this.#max = max;
    }
    const geom = new BufferGeometry();
    geom.setAttribute("position", new BufferAttribute(positions.subarray(0, k * 3), 3));
    geom.setAttribute("scalar", new BufferAttribute(scalar.subarray(0, k), 1));
    const old = this.#points.geometry;
    this.#points.geometry = geom;
    old.dispose();
    this.status = "";
    if (this.bool("autoRange")) this.#applyMaterial();
  }

  protected onSettingsChanged(): void {
    this.#applyMaterial();
  }

  #applyMaterial(): void {
    const mode = this.str("colorMode");
    let minV = this.num("minValue");
    let maxV = this.num("maxValue");
    if (this.bool("autoRange")) {
      minV = this.#min;
      maxV = this.#max;
    }
    if (maxV - minV < 1e-6) maxV = minV + 1e-6;
    applyPointsMaterialOptions(this.material, {
      pointSize: this.num("pointSize"),
      mode: (mode === "flat" ? "flat" : "scalar") as ColorMode,
      colormap: this.str("colormap") as Colormap,
      minV,
      maxV,
      flatColor: this.str("flatColor"),
      opacity: this.num("opacity"),
      round: true,
    });
  }

  dispose(): void {
    this.material.dispose();
    disposeObject(this.root);
  }
}
