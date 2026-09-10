import { Group, Matrix4, Object3D, Material, BufferGeometry } from "three";
import type { TfTree } from "../../ros/TfTree";

export type SettingDef =
  | { type: "number"; label: string; min?: number; max?: number; step?: number }
  | { type: "select"; label: string; options: readonly string[] }
  | { type: "boolean"; label: string }
  | { type: "color"; label: string }
  | { type: "text"; label: string };

export type SettingsSchema = Record<string, SettingDef>;
export type SettingValue = number | string | boolean;
export type SettingsValues = Record<string, SettingValue>;

export interface LayerContext {
  tf: TfTree;
  fixedFrame: string;
  nowMs: number;
}

const _m = new Matrix4();

/**
 * A layer renders one topic into the scene. `root` is re-parented into the
 * fixed frame every render via TF; subclasses only care about message frames.
 */
export abstract class Layer {
  readonly root = new Group();
  readonly topic: string;
  readonly schemaName: string;
  /** frame_id from the most recent message header */
  frameId = "";
  visible = true;
  /** Human-readable problem, e.g. missing TF. Empty when healthy. */
  status = "";
  lastMessageMs = 0;
  messageCount = 0;

  abstract readonly schema: SettingsSchema;
  readonly settings: SettingsValues;

  constructor(topic: string, schemaName: string, defaults: SettingsValues, initial?: Partial<SettingsValues>) {
    this.topic = topic;
    this.schemaName = schemaName;
    const merged: SettingsValues = { ...defaults };
    for (const [k, v] of Object.entries(initial ?? {})) {
      if (v !== undefined && k in defaults) merged[k] = v;
    }
    this.settings = merged;
    this.root.matrixAutoUpdate = false;
    this.root.name = topic;
  }

  abstract onMessage(msg: unknown, receiveMs: number): void;

  /** Called every render frame. Default: move root into the fixed frame. */
  update(ctx: LayerContext): void {
    this.applyTf(ctx, this.root, this.frameId);
  }

  /** Points drawn by this layer, for the stats overlay. */
  get pointCount(): number {
    return 0;
  }

  setSetting(key: string, value: SettingValue): void {
    if (this.settings[key] === value) return;
    this.settings[key] = value;
    this.onSettingsChanged(key);
  }

  protected onSettingsChanged(_key: string): void {
    /* subclasses override */
  }

  /** Fixed frame changed; accumulated data in the old frame is no longer valid. */
  onFixedFrameChanged(): void {
    /* subclasses override */
  }

  num(key: string): number {
    return Number(this.settings[key]);
  }
  str(key: string): string {
    return String(this.settings[key]);
  }
  bool(key: string): boolean {
    return Boolean(this.settings[key]);
  }

  /**
   * Set `obj.matrix` to T_fixed_frame. Hides the object and records a status
   * when the transform is unavailable. Returns true on success.
   */
  protected applyTf(ctx: LayerContext, obj: Object3D, frame: string): boolean {
    if (!this.visible) {
      obj.visible = false;
      return false;
    }
    if (!frame) {
      // No message yet.
      obj.visible = false;
      return false;
    }
    if (ctx.tf.lookup(ctx.fixedFrame, frame, _m)) {
      obj.matrix.copy(_m);
      obj.matrixAutoUpdate = false;
      obj.visible = true;
      if (this.status.startsWith("No TF")) this.status = "";
      return true;
    }
    obj.visible = false;
    this.status = `No TF ${ctx.fixedFrame} ← ${frame}`;
    return false;
  }

  dispose(): void {
    disposeObject(this.root);
  }
}

export function disposeObject(obj: Object3D): void {
  obj.traverse((o) => {
    const anyO = o as unknown as { geometry?: BufferGeometry; material?: Material | Material[] };
    anyO.geometry?.dispose();
    const m = anyO.material;
    if (Array.isArray(m)) m.forEach((x) => x.dispose());
    else m?.dispose();
  });
  obj.clear();
}
