import { Matrix4, Quaternion, Vector3 } from "three";
import type { TFMessage } from "./types";

interface Edge {
  parent: string;
  /** T_parent_child: maps child coordinates into parent coordinates */
  matrix: Matrix4;
  isStatic: boolean;
  receivedAt: number;
}

const _v = new Vector3();
const _q = new Quaternion();
const _s = new Vector3(1, 1, 1);
const _m = new Matrix4();

/**
 * Latest-value transform tree (no time interpolation). Good enough for live
 * visualization and cheap to evaluate every render frame.
 */
export class TfTree {
  #edges = new Map<string, Edge>(); // keyed by child frame
  #version = 0;

  /** Increments whenever the set of frames changes (not on every update). */
  get version(): number {
    return this.#version;
  }

  clear(): void {
    this.#edges.clear();
    this.#version++;
  }

  applyMessage(msg: TFMessage, isStatic: boolean, now: number): void {
    for (const t of msg.transforms) {
      const parent = stripSlash(t.header.frame_id);
      const child = stripSlash(t.child_frame_id);
      if (!parent || !child || parent === child) continue;
      const tr = t.transform.translation;
      const ro = t.transform.rotation;
      _v.set(tr.x, tr.y, tr.z);
      _q.set(ro.x, ro.y, ro.z, ro.w).normalize();
      const existing = this.#edges.get(child);
      if (existing) {
        if (existing.parent !== parent) this.#version++;
        existing.parent = parent;
        existing.matrix.compose(_v, _q, _s);
        existing.isStatic = isStatic;
        existing.receivedAt = now;
      } else {
        this.#edges.set(child, {
          parent,
          matrix: new Matrix4().compose(_v, _q, _s),
          isStatic,
          receivedAt: now,
        });
        this.#version++;
      }
    }
  }

  frames(): string[] {
    const set = new Set<string>();
    for (const [child, e] of this.#edges) {
      set.add(child);
      set.add(e.parent);
    }
    return [...set].sort();
  }

  roots(): string[] {
    const roots = new Set<string>();
    for (const e of this.#edges.values()) {
      if (!this.#edges.has(e.parent)) roots.add(e.parent);
    }
    return [...roots].sort();
  }

  parentOf(frame: string): string | undefined {
    return this.#edges.get(stripSlash(frame))?.parent;
  }

  hasFrame(frame: string): boolean {
    frame = stripSlash(frame);
    if (this.#edges.has(frame)) return true;
    for (const e of this.#edges.values()) if (e.parent === frame) return true;
    return false;
  }

  edges(): [child: string, parent: string][] {
    const out: [string, string][] = [];
    for (const [child, e] of this.#edges) out.push([child, e.parent]);
    return out;
  }

  /** Suggest a fixed frame: prefer common world frames, else the first root. */
  suggestFixedFrame(): string | undefined {
    const roots = this.roots();
    for (const pref of ["map", "camera_init", "odom", "world"]) {
      if (roots.includes(pref)) return pref;
    }
    return roots[0];
  }

  /**
   * Compute T_target_source (points in `source` -> `target`). Returns false if the
   * frames are not connected. Writes into `out`.
   */
  lookup(target: string, source: string, out: Matrix4): boolean {
    target = stripSlash(target);
    source = stripSlash(source);
    if (target === source) {
      out.identity();
      return true;
    }
    const srcChain = this.#chainToRoot(source);
    const tgtChain = this.#chainToRoot(target);
    if (!srcChain || !tgtChain) return false;
    if (srcChain.root !== tgtChain.root) return false;
    // out = inv(T_root_target) * T_root_source
    _m.copy(tgtChain.matrix).invert();
    out.multiplyMatrices(_m, srcChain.matrix);
    return true;
  }

  #chainToRoot(frame: string): { root: string; matrix: Matrix4 } | undefined {
    if (!this.hasFrame(frame)) return undefined;
    const m = new Matrix4();
    let cur = frame;
    let guard = 0;
    for (;;) {
      const e = this.#edges.get(cur);
      if (!e) break;
      m.premultiply(e.matrix); // m = T_parent_child * m
      cur = e.parent;
      if (++guard > 256) return undefined; // cycle protection
    }
    return { root: cur, matrix: m };
  }
}

function stripSlash(f: string): string {
  return f.startsWith("/") ? f.slice(1) : f;
}
