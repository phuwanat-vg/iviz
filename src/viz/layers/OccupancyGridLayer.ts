import {
  DataTexture,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  PlaneGeometry,
  Quaternion,
  RGBAFormat,
  Vector3,
} from "three";
import { Layer, disposeObject } from "./Layer";
import type { SettingsSchema, SettingsValues } from "./Layer";
import type { OccupancyGrid } from "../../ros/types";

const SCHEMA: SettingsSchema = {
  scheme: { type: "select", label: "Color scheme", options: ["map", "costmap", "raw"] },
  opacity: { type: "number", label: "Opacity", min: 0.05, max: 1, step: 0.05 },
  zOffset: { type: "number", label: "Z offset (m)", min: -1, max: 1, step: 0.005 },
};

const DEFAULTS: SettingsValues = {
  scheme: "map",
  opacity: 1,
  zOffset: 0,
};

/** Renders nav_msgs/OccupancyGrid as a textured plane, like rviz's Map display. */
export class OccupancyGridLayer extends Layer {
  readonly schema = SCHEMA;
  #mesh?: Mesh<PlaneGeometry, MeshBasicMaterial>;
  #texture?: DataTexture;
  #last?: OccupancyGrid;
  #w = 0;
  #h = 0;

  constructor(topic: string, schemaName: string, initial?: Partial<SettingsValues>) {
    super(topic, schemaName, DEFAULTS, initial);
    if (topic.toLowerCase().includes("costmap") && initial?.scheme === undefined) {
      this.settings.scheme = "costmap";
      this.settings.zOffset = 0.01;
    }
  }

  onMessage(msg: unknown, receiveMs: number): void {
    const grid = msg as OccupancyGrid;
    this.lastMessageMs = receiveMs;
    this.messageCount++;
    this.frameId = grid.header.frame_id;
    this.#last = grid;
    this.#rebuild();
  }

  protected onSettingsChanged(key: string): void {
    if (key === "scheme") this.#rebuild();
    else this.#applyMaterial();
  }

  #rebuild(): void {
    const grid = this.#last;
    if (!grid) return;
    const { width, height, resolution, origin } = grid.info;
    if (width === 0 || height === 0) return;
    const pixels = new Uint8Array(width * height * 4);
    const scheme = this.str("scheme");
    const data = grid.data;
    const n = Math.min(width * height, data.length);
    for (let i = 0; i < n; i++) {
      const v = data[i]!;
      const o = i * 4;
      colorize(scheme, v, pixels, o);
    }

    if (!this.#texture || this.#w !== width || this.#h !== height) {
      this.#texture?.dispose();
      this.#texture = new DataTexture(pixels, width, height, RGBAFormat);
      this.#texture.magFilter = NearestFilter;
      this.#texture.minFilter = NearestFilter;
      this.#texture.flipY = false;
      this.#w = width;
      this.#h = height;
      if (this.#mesh) {
        this.#mesh.material.map = this.#texture;
        this.#mesh.material.needsUpdate = true;
      }
    } else {
      this.#texture.image.data = pixels;
    }
    this.#texture.needsUpdate = true;

    const wM = width * resolution;
    const hM = height * resolution;
    if (!this.#mesh) {
      const mat = new MeshBasicMaterial({ map: this.#texture, side: DoubleSide, transparent: true });
      this.#mesh = new Mesh(new PlaneGeometry(1, 1), mat);
      this.root.add(this.#mesh);
      this.#applyMaterial();
    }
    // Plane is centered; grid origin is its lower-left corner in the origin pose frame.
    const mesh = this.#mesh;
    mesh.scale.set(wM, hM, 1);
    const q = new Quaternion(origin.orientation.x, origin.orientation.y, origin.orientation.z, origin.orientation.w);
    if (q.lengthSq() < 1e-9) q.identity();
    const center = new Vector3(wM / 2, hM / 2, this.num("zOffset")).applyQuaternion(q);
    mesh.position.set(origin.position.x + center.x, origin.position.y + center.y, origin.position.z + center.z);
    mesh.quaternion.copy(q);
    this.status = "";
  }

  #applyMaterial(): void {
    if (!this.#mesh) return;
    const op = this.num("opacity");
    this.#mesh.material.opacity = op;
    this.#mesh.material.depthWrite = op >= 1;
    this.#mesh.material.needsUpdate = true;
    if (this.#last) {
      const z = this.num("zOffset");
      const q = this.#mesh.quaternion;
      const { width, height, resolution, origin } = this.#last.info;
      const center = new Vector3((width * resolution) / 2, (height * resolution) / 2, z).applyQuaternion(q);
      this.#mesh.position.set(origin.position.x + center.x, origin.position.y + center.y, origin.position.z + center.z);
    }
  }

  dispose(): void {
    this.#texture?.dispose();
    disposeObject(this.root);
  }
}

function colorize(scheme: string, v: number, out: Uint8Array, o: number): void {
  if (scheme === "costmap") {
    // Mirrors rviz's costmap palette.
    if (v === 0) {
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 0;
      out[o + 3] = 0;
    } else if (v >= 1 && v <= 98) {
      const t = v / 98;
      out[o] = Math.round(t * 255);
      out[o + 1] = 0;
      out[o + 2] = Math.round(255 - t * 255);
      out[o + 3] = 170;
    } else if (v === 99) {
      out[o] = 0;
      out[o + 1] = 255;
      out[o + 2] = 255;
      out[o + 3] = 220;
    } else if (v === 100) {
      out[o] = 255;
      out[o + 1] = 0;
      out[o + 2] = 255;
      out[o + 3] = 230;
    } else if (v < 0) {
      out[o] = 112;
      out[o + 1] = 137;
      out[o + 2] = 134;
      out[o + 3] = 120;
    } else {
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 0;
      out[o + 3] = 0;
    }
    return;
  }
  if (scheme === "raw") {
    const g = v < 0 ? 0 : Math.round((v / 100) * 255);
    out[o] = g;
    out[o + 1] = g;
    out[o + 2] = g;
    out[o + 3] = 255;
    return;
  }
  // "map": unknown grey, free white, occupied black
  if (v < 0) {
    out[o] = 96;
    out[o + 1] = 96;
    out[o + 2] = 96;
    out[o + 3] = 255;
  } else {
    const g = Math.round(255 - (Math.min(100, v) / 100) * 255);
    out[o] = g;
    out[o + 1] = g;
    out[o + 2] = g;
    out[o + 3] = 255;
  }
}
