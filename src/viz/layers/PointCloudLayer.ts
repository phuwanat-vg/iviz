import { BufferAttribute, BufferGeometry, Points, ShaderMaterial } from "three";
import { Layer, disposeObject } from "./Layer";
import type { LayerContext, SettingsSchema, SettingsValues } from "./Layer";
import { COLORMAPS, COLOR_MODES, applyPointsMaterialOptions, createPointsMaterial } from "../PointsMaterial";
import type { ColorMode, Colormap } from "../PointsMaterial";
import type { LivoxCustomMsg, PointCloud2 } from "../../ros/types";
import { normalizeSchemaName } from "../../ros/types";

export interface ParsedCloud {
  count: number;
  positions: Float32Array;
  scalar: Float32Array;
  rgb?: Float32Array;
  min: number;
  max: number;
}

interface Frame {
  points: Points;
  count: number;
  frameId: string;
  /** true once its transform has been frozen in the fixed frame */
  baked: boolean;
}

const SCHEMA: SettingsSchema = {
  pointSize: { type: "number", label: "Point size (px)", min: 1, max: 12, step: 0.5 },
  colorMode: { type: "select", label: "Color by", options: COLOR_MODES },
  colormap: { type: "select", label: "Colormap", options: COLORMAPS },
  autoRange: { type: "boolean", label: "Auto min/max" },
  minValue: { type: "number", label: "Min", step: 0.1 },
  maxValue: { type: "number", label: "Max", step: 0.1 },
  flatColor: { type: "color", label: "Flat color" },
  opacity: { type: "number", label: "Opacity", min: 0.05, max: 1, step: 0.05 },
  zClip: { type: "boolean", label: "Clip by height" },
  zMin: { type: "number", label: "Z min (m)", step: 0.1 },
  zMax: { type: "number", label: "Z max (m)", step: 0.1 },
  decimate: { type: "number", label: "Keep every Nth point", min: 1, max: 20, step: 1 },
  accumulate: { type: "select", label: "Accumulate", options: ["off", "frames", "all"] },
  maxFrames: { type: "number", label: "Max frames", min: 1, max: 2000, step: 1 },
  maxPoints: { type: "number", label: "Max points (k)", min: 10, max: 20000, step: 10 },
};

const DEFAULTS: SettingsValues = {
  pointSize: 2,
  colorMode: "scalar",
  colormap: "turbo",
  autoRange: true,
  minValue: 0,
  maxValue: 100,
  flatColor: "#ffffff",
  opacity: 1,
  zClip: false,
  zMin: -1,
  zMax: 2,
  decimate: 1,
  accumulate: "off",
  maxFrames: 50,
  maxPoints: 3000,
};

/**
 * Renders sensor_msgs/PointCloud2 and livox_ros_driver2/CustomMsg.
 * Supports accumulating frames into a persistent map in the fixed frame,
 * which is what you want for FAST-LIO2's /cloud_registered output.
 */
export class PointCloudLayer extends Layer {
  readonly schema = SCHEMA;
  readonly material: ShaderMaterial;
  #frames: Frame[] = [];
  #total = 0;
  #emaMin = NaN;
  #emaMax = NaN;
  readonly isLivox: boolean;

  constructor(topic: string, schemaName: string, initial?: Partial<SettingsValues>) {
    super(topic, schemaName, DEFAULTS, initial);
    this.isLivox = normalizeSchemaName(schemaName) === "livox_ros_driver2/CustomMsg";
    this.material = createPointsMaterial();
    this.#applyMaterial();
  }

  get pointCount(): number {
    return this.visible ? this.#total : 0;
  }

  onMessage(msg: unknown, receiveMs: number): void {
    this.lastMessageMs = receiveMs;
    this.messageCount++;
    const decimate = Math.max(1, Math.floor(this.num("decimate")));
    let parsed: ParsedCloud | undefined;
    let frameId: string;
    try {
      if (this.isLivox) {
        const m = msg as LivoxCustomMsg;
        frameId = m.header.frame_id;
        parsed = parseLivox(m, decimate);
      } else {
        const m = msg as PointCloud2;
        frameId = m.header.frame_id;
        parsed = parsePointCloud2(m, decimate);
      }
    } catch (err) {
      this.status = `Parse error: ${String(err)}`;
      return;
    }
    if (!parsed) {
      this.status = "Unsupported point fields (need x, y, z)";
      return;
    }
    this.status = "";
    this.frameId = frameId;

    if (this.bool("autoRange") && parsed.count > 0) {
      const a = 0.2;
      this.#emaMin = Number.isNaN(this.#emaMin) ? parsed.min : this.#emaMin + a * (parsed.min - this.#emaMin);
      this.#emaMax = Number.isNaN(this.#emaMax) ? parsed.max : this.#emaMax + a * (parsed.max - this.#emaMax);
      this.#applyMaterial();
    }

    const geom = new BufferGeometry();
    geom.setAttribute("position", new BufferAttribute(parsed.positions, 3));
    geom.setAttribute("scalar", new BufferAttribute(parsed.scalar, 1));
    if (parsed.rgb) geom.setAttribute("rgb", new BufferAttribute(parsed.rgb, 3));
    geom.computeBoundingSphere();
    const points = new Points(geom, this.material);
    points.frustumCulled = false;
    points.matrixAutoUpdate = false;

    const accumulate = this.str("accumulate");
    if (accumulate === "off") this.#clearFrames();
    this.#frames.push({ points, count: parsed.count, frameId, baked: false });
    this.#total += parsed.count;
    this.root.add(points);
    this.#enforceLimits();
  }

  update(ctx: LayerContext): void {
    // Root stays at identity; each frame carries its own transform so that
    // accumulated frames stay put in the fixed frame while the newest one
    // follows live TF.
    this.root.matrix.identity();
    this.root.visible = this.visible;
    if (!this.visible) return;
    const last = this.#frames.length - 1;
    for (let i = 0; i < this.#frames.length; i++) {
      const f = this.#frames[i]!;
      if (f.baked) continue;
      const ok = this.applyTf(ctx, f.points, f.frameId);
      if (ok && i !== last) f.baked = true;
    }
  }

  onFixedFrameChanged(): void {
    // Baked transforms are expressed in the old fixed frame: drop history.
    const keep = this.#frames.pop();
    this.#clearFrames();
    if (keep) {
      keep.baked = false;
      this.#frames.push(keep);
      this.#total = keep.count;
      this.root.add(keep.points);
    }
  }

  protected onSettingsChanged(key: string): void {
    if (key === "accumulate" && this.str("accumulate") === "off") {
      const keep = this.#frames.pop();
      this.#clearFrames();
      if (keep) {
        this.#frames.push(keep);
        this.#total = keep.count;
        this.root.add(keep.points);
      }
    }
    if (key === "autoRange" || key === "colorMode") {
      this.#emaMin = NaN;
      this.#emaMax = NaN;
    }
    this.#enforceLimits();
    this.#applyMaterial();
  }

  clearAccumulated(): void {
    this.onFixedFrameChanged();
  }

  #enforceLimits(): void {
    const mode = this.str("accumulate");
    const maxFrames = mode === "frames" ? Math.max(1, this.num("maxFrames")) : Infinity;
    const maxPoints = Math.max(1000, this.num("maxPoints") * 1000);
    while (this.#frames.length > 1 && (this.#frames.length > maxFrames || this.#total > maxPoints)) {
      const f = this.#frames.shift()!;
      this.#total -= f.count;
      this.root.remove(f.points);
      f.points.geometry.dispose();
    }
  }

  #clearFrames(): void {
    for (const f of this.#frames) {
      this.root.remove(f.points);
      f.points.geometry.dispose();
    }
    this.#frames = [];
    this.#total = 0;
  }

  #applyMaterial(): void {
    const auto = this.bool("autoRange");
    let minV = this.num("minValue");
    let maxV = this.num("maxValue");
    if (auto && !Number.isNaN(this.#emaMin)) {
      minV = this.#emaMin;
      maxV = this.#emaMax;
    }
    if (maxV - minV < 1e-6) maxV = minV + 1e-6;
    applyPointsMaterialOptions(this.material, {
      pointSize: this.num("pointSize"),
      mode: this.str("colorMode") as ColorMode,
      colormap: this.str("colormap") as Colormap,
      minV,
      maxV,
      flatColor: this.str("flatColor"),
      opacity: this.num("opacity"),
      round: true,
      zMin: this.bool("zClip") ? this.num("zMin") : undefined,
      zMax: this.bool("zClip") ? this.num("zMax") : undefined,
    });
  }

  dispose(): void {
    this.#clearFrames();
    this.material.dispose();
    disposeObject(this.root);
  }
}

// ---------------------------------------------------------------------------
// Parsing

const enum DT {
  INT8 = 1,
  UINT8 = 2,
  INT16 = 3,
  UINT16 = 4,
  INT32 = 5,
  UINT32 = 6,
  FLOAT32 = 7,
  FLOAT64 = 8,
}

type Reader = (dv: DataView, off: number) => number;

function makeReader(datatype: number, little: boolean): Reader | undefined {
  switch (datatype) {
    case DT.INT8:
      return (dv, o) => dv.getInt8(o);
    case DT.UINT8:
      return (dv, o) => dv.getUint8(o);
    case DT.INT16:
      return (dv, o) => dv.getInt16(o, little);
    case DT.UINT16:
      return (dv, o) => dv.getUint16(o, little);
    case DT.INT32:
      return (dv, o) => dv.getInt32(o, little);
    case DT.UINT32:
      return (dv, o) => dv.getUint32(o, little);
    case DT.FLOAT32:
      return (dv, o) => dv.getFloat32(o, little);
    case DT.FLOAT64:
      return (dv, o) => dv.getFloat64(o, little);
    default:
      return undefined;
  }
}

/**
 * Convert PointCloud2 into flat Float32 buffers. Handles arbitrary field
 * layouts, big/little endian, and colors packed as rgb/rgba. Returns undefined
 * when x/y/z are missing.
 */
export function parsePointCloud2(msg: PointCloud2, decimate = 1): ParsedCloud | undefined {
  const fields = msg.fields;
  const little = !msg.is_bigendian;
  const fx = fields.find((f) => f.name === "x");
  const fy = fields.find((f) => f.name === "y");
  const fz = fields.find((f) => f.name === "z");
  if (!fx || !fy || !fz) return undefined;
  const rx = makeReader(fx.datatype, little);
  const ry = makeReader(fy.datatype, little);
  const rz = makeReader(fz.datatype, little);
  if (!rx || !ry || !rz) return undefined;

  const fScalar =
    fields.find((f) => f.name === "intensity") ??
    fields.find((f) => f.name === "reflectivity") ??
    fields.find((f) => f.name === "i") ??
    fields.find((f) => f.name === "intensities");
  const rScalar = fScalar ? makeReader(fScalar.datatype, little) : undefined;
  const fRgb = fields.find((f) => f.name === "rgb" || f.name === "rgba");

  const data = msg.data;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const step = msg.point_step;
  const width = msg.width;
  const height = Math.max(1, msg.height);
  const rowStep = msg.row_step > 0 ? msg.row_step : width * step;
  let total = width * height;
  if (step <= 0) return undefined;
  total = Math.min(total, Math.floor(data.byteLength / step));

  const cap = Math.ceil(total / decimate);
  const positions = new Float32Array(cap * 3);
  const scalar = new Float32Array(cap);
  const rgb = fRgb ? new Float32Array(cap * 3) : undefined;
  let n = 0;
  let min = Infinity;
  let max = -Infinity;

  for (let i = 0; i < total; i += decimate) {
    const row = height > 1 ? Math.floor(i / width) : 0;
    const col = height > 1 ? i - row * width : i;
    const off = row * rowStep + col * step;
    if (off + step > data.byteLength) break;
    const x = rx(dv, off + fx.offset);
    const y = ry(dv, off + fy.offset);
    const z = rz(dv, off + fz.offset);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    positions[n * 3] = x;
    positions[n * 3 + 1] = y;
    positions[n * 3 + 2] = z;
    let s = 0;
    if (rScalar && fScalar) {
      s = rScalar(dv, off + fScalar.offset);
      if (!Number.isFinite(s)) s = 0;
    } else {
      s = z;
    }
    scalar[n] = s;
    if (s < min) min = s;
    if (s > max) max = s;
    if (rgb && fRgb) {
      const packed = dv.getUint32(off + fRgb.offset, little);
      rgb[n * 3] = ((packed >> 16) & 0xff) / 255;
      rgb[n * 3 + 1] = ((packed >> 8) & 0xff) / 255;
      rgb[n * 3 + 2] = (packed & 0xff) / 255;
    }
    n++;
  }
  if (n === 0) {
    min = 0;
    max = 1;
  }
  return {
    count: n,
    positions: positions.subarray(0, n * 3),
    scalar: scalar.subarray(0, n),
    rgb: rgb?.subarray(0, n * 3),
    min,
    max,
  };
}

export function parseLivox(msg: LivoxCustomMsg, decimate = 1): ParsedCloud {
  const pts = msg.points;
  const total = pts.length;
  const cap = Math.ceil(total / decimate);
  const positions = new Float32Array(cap * 3);
  const scalar = new Float32Array(cap);
  let n = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < total; i += decimate) {
    const p = pts[i]!;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
    if (p.x === 0 && p.y === 0 && p.z === 0) continue; // Livox marks invalid returns as zeros
    positions[n * 3] = p.x;
    positions[n * 3 + 1] = p.y;
    positions[n * 3 + 2] = p.z;
    const s = p.reflectivity;
    scalar[n] = s;
    if (s < min) min = s;
    if (s > max) max = s;
    n++;
  }
  if (n === 0) {
    min = 0;
    max = 1;
  }
  return { count: n, positions: positions.subarray(0, n * 3), scalar: scalar.subarray(0, n), min, max };
}
