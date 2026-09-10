import { BufferAttribute, BufferGeometry, LineBasicMaterial, LineLoop } from "three";
import { Layer, disposeObject } from "./Layer";
import type { SettingsSchema, SettingsValues } from "./Layer";
import type { PolygonStamped } from "../../ros/types";

const SCHEMA: SettingsSchema = {
  color: { type: "color", label: "Color" },
  zOffset: { type: "number", label: "Z offset (m)", min: -1, max: 1, step: 0.005 },
};

const DEFAULTS: SettingsValues = { color: "#40e0ff", zOffset: 0.03 };

/** geometry_msgs/PolygonStamped (e.g. robot footprint). */
export class PolygonLayer extends Layer {
  readonly schema = SCHEMA;
  #loop: LineLoop<BufferGeometry, LineBasicMaterial>;

  constructor(topic: string, schemaName: string, initial?: Partial<SettingsValues>) {
    super(topic, schemaName, DEFAULTS, initial);
    this.#loop = new LineLoop(new BufferGeometry(), new LineBasicMaterial({ color: this.str("color") }));
    this.#loop.frustumCulled = false;
    this.root.add(this.#loop);
  }

  onMessage(msg: unknown, receiveMs: number): void {
    const m = msg as PolygonStamped;
    this.lastMessageMs = receiveMs;
    this.messageCount++;
    this.frameId = m.header.frame_id;
    const z = this.num("zOffset");
    const pts = m.polygon.points;
    const pos = new Float32Array(pts.length * 3);
    for (let i = 0; i < pts.length; i++) {
      pos[i * 3] = pts[i]!.x;
      pos[i * 3 + 1] = pts[i]!.y;
      pos[i * 3 + 2] = pts[i]!.z + z;
    }
    const geom = new BufferGeometry();
    geom.setAttribute("position", new BufferAttribute(pos, 3));
    const old = this.#loop.geometry;
    this.#loop.geometry = geom;
    old.dispose();
    this.status = "";
  }

  protected onSettingsChanged(): void {
    this.#loop.material.color.set(this.str("color"));
  }

  dispose(): void {
    disposeObject(this.root);
  }
}
