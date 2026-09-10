import { BufferAttribute, BufferGeometry, Line, LineBasicMaterial } from "three";
import { Layer, disposeObject } from "./Layer";
import type { SettingsSchema, SettingsValues } from "./Layer";
import type { Path } from "../../ros/types";

const SCHEMA: SettingsSchema = {
  color: { type: "color", label: "Color" },
  opacity: { type: "number", label: "Opacity", min: 0.05, max: 1, step: 0.05 },
  zOffset: { type: "number", label: "Z offset (m)", min: -1, max: 1, step: 0.005 },
};

const DEFAULTS: SettingsValues = {
  color: "#20d060",
  opacity: 1,
  zOffset: 0.02,
};

/** nav_msgs/Path as a polyline. */
export class PathLayer extends Layer {
  readonly schema = SCHEMA;
  #line: Line<BufferGeometry, LineBasicMaterial>;

  constructor(topic: string, schemaName: string, initial?: Partial<SettingsValues>) {
    super(topic, schemaName, DEFAULTS, initial);
    if (topic.includes("local") && initial?.color === undefined) this.settings.color = "#ffb020";
    this.#line = new Line(new BufferGeometry(), new LineBasicMaterial({ color: this.str("color") }));
    this.#line.frustumCulled = false;
    this.root.add(this.#line);
    this.#applyMaterial();
  }

  onMessage(msg: unknown, receiveMs: number): void {
    const path = msg as Path;
    this.lastMessageMs = receiveMs;
    this.messageCount++;
    this.frameId = path.header.frame_id;
    const z = this.num("zOffset");
    const n = path.poses.length;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const p = path.poses[i]!.pose.position;
      pos[i * 3] = p.x;
      pos[i * 3 + 1] = p.y;
      pos[i * 3 + 2] = p.z + z;
    }
    const geom = new BufferGeometry();
    geom.setAttribute("position", new BufferAttribute(pos, 3));
    const old = this.#line.geometry;
    this.#line.geometry = geom;
    old.dispose();
    this.status = "";
  }

  protected onSettingsChanged(): void {
    this.#applyMaterial();
  }

  #applyMaterial(): void {
    const m = this.#line.material;
    m.color.set(this.str("color"));
    m.opacity = this.num("opacity");
    m.transparent = m.opacity < 1;
    m.needsUpdate = true;
  }

  dispose(): void {
    disposeObject(this.root);
  }
}
