/**
 * The Route mode editing tools. They plug into the Viewer's tool mechanism
 * (`registerTool`), so they share the ground-plane raycast and the camera
 * grip with the existing Nav Goal / Pose Estimate tools; the difference is
 * that a route tool only takes the left button, leaving middle-drag pan and
 * right-drag orbit alive while editing. That is what makes editing work in 3D
 * as well as in the 2D top-down view Route mode starts in.
 */

import type { Viewer } from "../viz/Viewer";
import type { ToolPointerEvent, ViewerTool } from "../viz/Viewer";
import type { RouteLayer, RouteHit } from "../viz/layers/RouteLayer";
import type { RouteStore } from "../mission/RouteStore";
import { headingDeg, nearestSite } from "../mission/geometry";

export const TOOL_SELECT = "route.select";
export const TOOL_POINT = "route.point";
export const TOOL_LINK = "route.link";
export const ROUTE_TOOLS = [TOOL_SELECT, TOOL_POINT, TOOL_LINK] as const;

/** Drag further than this (in screen pixels) and it counts as a drag, not a click. */
const DRAG_PX = 4;
/** How close to a point's heading arrow tip counts as grabbing the arrow. */
const ARROW_GRAB_PX = 14;
/** Snap radius when a link or a new point lands near an existing one. */
const SNAP_PX = 16;

export interface RouteToolHost {
  viewer: Viewer;
  store: RouteStore;
  layer: RouteLayer;
  /** Ask for a name for a point that was just created, over the map. */
  promptName(name: string, x: number, y: number): void;
  /** Redraw the panel. */
  refresh(): void;
  /**
   * Offered every point click before the selection changes. Return true to
   * consume it, which is how "Add stop → click a point on the map" works.
   */
  onPointPicked?(name: string): boolean;
  /**
   * What the tool is about to do, while a drag is live ("Home → Conveyor1"),
   * or null when there is nothing to say. Shown under the tool bar.
   */
  onDragHint?(text: string | null): void;
}

type DragMode = "none" | "move" | "yaw" | "link" | "place";

export class RouteTools {
  #host: RouteToolHost;
  #mode: DragMode = "none";
  #startX = 0;
  #startY = 0;
  #startClientX = 0;
  #startClientY = 0;
  #target = "";
  #moved = false;
  #registered: string[] = [];

  constructor(host: RouteToolHost) {
    this.#host = host;
    const { viewer } = host;
    viewer.registerTool(TOOL_SELECT, this.#select());
    viewer.registerTool(TOOL_POINT, this.#point());
    viewer.registerTool(TOOL_LINK, this.#link());
    this.#registered = [TOOL_SELECT, TOOL_POINT, TOOL_LINK];
  }

  dispose(): void {
    for (const name of this.#registered) this.#host.viewer.unregisterTool(name);
    this.#registered = [];
  }

  /** One line saying what the armed tool does, shown under the tool bar. */
  static hintFor(tool: string): string {
    switch (tool) {
      case TOOL_SELECT:
        return "Click a point or a lane to see it. Drag a point to move it, drag its arrow to turn it, Del deletes it.";
      case TOOL_POINT:
        return "Click the floor to add a point. Drag before you let go to say which way the robot faces there.";
      case TOOL_LINK:
        return "Drag from one point to another to draw a lane. Hold Shift while you drag for a one-way lane.";
      default:
        return "";
    }
  }

  // ---- tools --------------------------------------------------------------

  #select(): ViewerTool {
    return {
      cursor: "default",
      onPointerDown: (ev) => {
        if (!ev.world) return;
        this.#begin(ev);
        const hit = this.#host.layer.pick(ev.world.x, ev.world.y, ev.worldPerPixel);
        const arrow = this.#arrowGrab(ev);
        if (arrow) {
          this.#mode = "yaw";
          this.#target = arrow;
          this.#host.store.select({ kind: "point", name: arrow });
          this.#host.store.beginEdit("Set heading");
          this.#host.viewer.setToolCursor("grabbing");
          return;
        }
        if (hit?.kind === "point") {
          if (this.#host.onPointPicked?.(hit.name) === true) {
            this.#end();
            return;
          }
          this.#mode = "move";
          this.#target = hit.name;
          this.#host.store.select({ kind: "point", name: hit.name });
          this.#host.store.beginEdit("Move point");
          this.#host.viewer.setToolCursor("grabbing");
        } else if (hit?.kind === "lane") {
          this.#host.store.select({ kind: "lane", index: hit.index });
        } else {
          this.#host.store.select({ kind: "none" });
        }
        this.#host.refresh();
      },
      onPointerMove: (ev) => {
        if (!ev.world) return;
        if (this.#mode === "none") {
          this.#hover(ev);
          return;
        }
        this.#markMoved(ev);
        if (!this.#moved) return;
        if (this.#mode === "move") {
          this.#host.store.movePoint(this.#target, ev.world.x, ev.world.y);
          this.#host.store.version++;
        } else if (this.#mode === "yaw") {
          const site = this.#host.store.points[this.#target];
          if (site) {
            this.#host.store.setPointYaw(this.#target, headingDeg(ev.world.x - site.x, ev.world.y - site.y));
            this.#host.store.version++;
          }
        }
      },
      onPointerUp: () => {
        if (this.#mode === "move" || this.#mode === "yaw") {
          if (this.#moved) this.#host.store.commit({ sites: true });
          else this.#host.store.rollback();
        }
        this.#end();
      },
    };
  }

  #point(): ViewerTool {
    return {
      cursor: "crosshair",
      onPointerDown: (ev) => {
        if (!ev.world) return;
        this.#begin(ev);
        this.#mode = "place";
      },
      onPointerMove: (ev) => {
        if (this.#mode === "none") {
          this.#hover(ev);
          return;
        }
        this.#markMoved(ev);
        if (this.#moved && ev.world) this.#host.layer.setPendingLink({ x: this.#startX, y: this.#startY }, { x: ev.world.x, y: ev.world.y });
      },
      onPointerUp: (ev) => {
        if (this.#mode !== "place") return this.#end();
        this.#host.layer.setPendingLink(null, null);
        const store = this.#host.store;
        const yaw = this.#moved && ev.world ? headingDeg(ev.world.x - this.#startX, ev.world.y - this.#startY) : null;
        const onLane = this.#host.layer.pick(this.#startX, this.#startY, ev.worldPerPixel, 10);
        let name: string | null;
        if (onLane?.kind === "lane") {
          name = store.splitLane(onLane.index, this.#startX, this.#startY);
          if (name !== null && yaw !== null) store.edit("Set heading", () => store.setPointYaw(name!, yaw));
        } else if (onLane?.kind === "point") {
          name = null; // do not stack a point on top of another
        } else {
          name = store.addPoint(this.#startX, this.#startY, yaw);
        }
        this.#end();
        if (name !== null) this.#host.promptName(name, this.#startX, this.#startY);
        this.#host.refresh();
      },
    };
  }

  #link(): ViewerTool {
    return {
      cursor: "crosshair",
      onPointerDown: (ev) => {
        if (!ev.world) return;
        this.#begin(ev);
        const hit = this.#host.layer.pick(ev.world.x, ev.world.y, ev.worldPerPixel);
        if (hit?.kind === "point") {
          this.#mode = "link";
          this.#target = hit.name;
        } else if (hit?.kind === "lane") {
          this.#host.store.select({ kind: "lane", index: hit.index });
          this.#host.refresh();
        }
      },
      onPointerMove: (ev) => {
        if (this.#mode !== "link") {
          this.#hover(ev);
          return;
        }
        this.#markMoved(ev);
        const from = this.#host.store.points[this.#target];
        if (from && ev.world) {
          const snap = this.#snapTarget(ev);
          const to = snap && snap !== this.#target ? this.#host.store.points[snap] : undefined;
          this.#host.layer.setPendingLink({ x: from.x, y: from.y }, to ? { x: to.x, y: to.y } : { x: ev.world.x, y: ev.world.y });
          this.#host.layer.setHover(snap ? { kind: "point", name: snap } : null);
          // Say what is about to be connected, so a lane is never a surprise.
          const arrow = ev.shiftKey ? "→" : "↔";
          const target = snap && snap !== this.#target ? snap : "…";
          const suffix = snap && snap !== this.#target ? (ev.shiftKey ? " — one-way, let go to draw it" : " — let go to draw it") : " — drop on a point to connect it";
          this.#host.onDragHint?.(`${this.#target} ${arrow} ${target}${suffix}`);
        }
      },
      onPointerUp: (ev) => {
        if (this.#mode !== "link") return this.#end();
        this.#host.layer.setPendingLink(null, null);
        const snap = this.#snapTarget(ev);
        if (snap && snap !== this.#target) this.#host.store.addLane(this.#target, snap, ev.shiftKey);
        this.#end();
        this.#host.refresh();
      },
    };
  }

  // ---- shared -------------------------------------------------------------

  #begin(ev: ToolPointerEvent): void {
    this.#startX = ev.world?.x ?? 0;
    this.#startY = ev.world?.y ?? 0;
    this.#startClientX = ev.clientX;
    this.#startClientY = ev.clientY;
    this.#moved = false;
    this.#mode = "none";
  }

  #end(): void {
    this.#mode = "none";
    this.#target = "";
    this.#moved = false;
    this.#host.onDragHint?.(null);
    this.#host.layer.setPendingLink(null, null);
    this.#host.viewer.setToolCursor(this.#host.viewer.tool === TOOL_SELECT ? "default" : "crosshair");
  }

  #markMoved(ev: ToolPointerEvent): void {
    if (this.#moved) return;
    if (Math.hypot(ev.clientX - this.#startClientX, ev.clientY - this.#startClientY) > DRAG_PX) this.#moved = true;
  }

  #hover(ev: ToolPointerEvent): void {
    if (!ev.world) return;
    const hit: RouteHit = this.#host.layer.pick(ev.world.x, ev.world.y, ev.worldPerPixel);
    this.#host.layer.setHover(hit);
    if (this.#host.viewer.tool === TOOL_SELECT) {
      this.#host.viewer.setToolCursor(this.#arrowGrab(ev) ? "grab" : hit ? "pointer" : "default");
    }
  }

  /** The selected point whose heading arrow tip is under the pointer, if any. */
  #arrowGrab(ev: ToolPointerEvent): string | null {
    const sel = this.#host.store.selection;
    if (sel.kind !== "point" || !ev.world) return null;
    const site = this.#host.store.points[sel.name];
    if (!site || typeof site.yaw_deg !== "number") return null;
    // The arrow reaches about 2.1 disc radii; the tip is the grab handle.
    const reach = Math.max(0.34, ev.worldPerPixel * 15);
    const rad = (site.yaw_deg * Math.PI) / 180;
    const tipX = site.x + Math.cos(rad) * reach;
    const tipY = site.y + Math.sin(rad) * reach;
    return Math.hypot(ev.world.x - tipX, ev.world.y - tipY) <= ev.worldPerPixel * ARROW_GRAB_PX ? sel.name : null;
  }

  #snapTarget(ev: ToolPointerEvent): string | null {
    if (!ev.world) return null;
    const hit = this.#host.layer.pick(ev.world.x, ev.world.y, ev.worldPerPixel);
    if (hit?.kind === "point") return hit.name;
    return nearestSite(this.#host.store.points, ev.world.x, ev.world.y, ev.worldPerPixel * SNAP_PX);
  }
}
