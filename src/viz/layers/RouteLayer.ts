/**
 * Draws the route graph and the open mission in the scene, in the map frame.
 *
 * Points are discs with a name label and a heading arrow, tinted by kind.
 * Lanes are ribbons with one arrowhead when one-way and two when
 * bidirectional, thinner with the cap written along them when a lane limits
 * speed, and dashed red when blocked. The open mission's stops are numbered
 * and the planned order is highlighted on top of the lanes.
 *
 * Geometry is rebuilt only when the data changes (the store's `version`).
 * Hover, selection and run state only mutate materials, scales and one small
 * highlight mesh, so dragging a point across a large graph stays cheap.
 *
 * Text keeps a constant size on screen: labels are sprites scaled every frame
 * from the metres-per-pixel of the active camera, and labels that would
 * collide at the current zoom are hidden, least important first.
 */

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  DoubleSide,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
} from "three";
import { Layer, disposeObject } from "./Layer";
import type { LayerContext, SettingsSchema } from "./Layer";
import type { Viewer } from "../Viewer";
import type { RouteStore } from "../../mission/RouteStore";
import type { Edge, Site } from "../../mission/types";
import { pointOnSegment } from "../../mission/geometry";
import { planRoute, stopSite } from "../../mission/stops";

/** What a point or lane was hit by a click. */
export type RouteHit = { kind: "point"; name: string } | { kind: "lane"; index: number; x: number; y: number } | null;

export interface RouteRunState {
  /** Stop the robot is driving to or working at. */
  activeStop: number | null;
  /** Stops that finished successfully. */
  doneStops: ReadonlySet<number>;
  /** Stop that failed, if any. */
  failedStop: number | null;
}

export const EMPTY_RUN_STATE: RouteRunState = { activeStop: null, doneStops: new Set(), failedStop: null };

const COLORS = {
  // Mid tone on purpose: lanes have to read both on a white floor plan and on
  // the dark background when no map is loaded.
  lane: "#4a6da8",
  laneBlocked: "#ff5a6a",
  laneSlow: "#e0b445",
  laneHighlight: "#7ad0ff",
  route: "#38d6a6",
  driving: "#ffd040",
  done: "#3ccf7a",
  failed: "#ff5a6a",
  home: "#3ccf7a",
  dock: "#7aa2ff",
  station: "#f2b134",
  waypoint: "#b9c2d0",
  missing: "#ff5a6a",
} as const;

const LANE_WIDTH = 0.06;
const LANE_SLOW_WIDTH = 0.045;
const ROUTE_WIDTH = 0.14;
const HIGHLIGHT_WIDTH = 0.2;
const DISC_RADIUS = 0.16;
// Points are click targets first and dots second: they never get smaller than
// this on screen, and the picking tolerance below is generous on purpose.
const MIN_DISC_PX = 11;

// Widths are metres, so zoomed out a lane would thin to nothing. Each one also
// gets a floor in pixels, and the geometry is rebuilt when the zoom moves far
// enough for that floor to matter.
const MIN_LANE_PX = 4;
const MIN_LANE_SLOW_PX = 3;
const MIN_ROUTE_PX = 9;
const MIN_HIGHLIGHT_PX = 11;
const ZOOM_REBUILD_RATIO = 1.15;

const Z_LANE = 0.01;
const Z_ROUTE = 0.02;
const Z_HIGHLIGHT = 0.005;
const Z_HALO = 0.028;
const Z_DISC = 0.03;
const Z_ARROW = 0.035;
const Z_LABEL = 0.06;

const _screen = new Vector2();
const _world = new Vector3();

interface PointVisual {
  group: Group;
  disc: Mesh<CircleGeometry, MeshBasicMaterial>;
  halo: Mesh<RingGeometry, MeshBasicMaterial>;
  heading: Mesh<BufferGeometry, MeshBasicMaterial>;
  baseColor: Color;
  name: string;
}

interface LabelVisual {
  sprite: Sprite;
  widthPx: number;
  heightPx: number;
  anchor: Vector3;
  /** Higher wins when two labels overlap. */
  priority: number;
}

/**
 * A layer, so it is transformed into the fixed frame by the same TF machinery
 * as every other layer, but fed by the Route store instead of by a topic.
 */
export class RouteLayer extends Layer {
  readonly schema: SettingsSchema = {};

  #viewer: Viewer;
  #store: RouteStore;
  #version = -1;
  /** World metres per pixel the geometry was last built for. */
  #builtWpp = 0.02;

  #laneMesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  #routeMesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  #drivingMesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  #highlightMesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  #pointsGroup = new Group();
  #labelGroup = new Group();

  #points: PointVisual[] = [];
  #labels: LabelVisual[] = [];
  /** Lane endpoints in world coordinates, for hit-testing and highlighting. */
  #laneEnds: { ax: number; ay: number; bx: number; by: number }[] = [];
  #pendingMesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  #hover: RouteHit = null;
  #run: RouteRunState = EMPTY_RUN_STATE;
  #drivingLeg: [number, number][] = [];
  #lastLabelPass = 0;

  showLanes = true;
  showPoints = true;
  showRoute = true;

  constructor(viewer: Viewer, store: RouteStore) {
    super("route", "iviz/RouteGraph", {});
    this.#viewer = viewer;
    this.#store = store;
    this.#laneMesh = emptyMesh(COLORS.lane);
    this.#routeMesh = emptyMesh(COLORS.route);
    this.#drivingMesh = emptyMesh(COLORS.driving);
    this.#highlightMesh = emptyMesh(COLORS.laneHighlight);
    this.#pendingMesh = emptyMesh(COLORS.laneHighlight);
    this.#highlightMesh.material.opacity = 0.35;
    this.#drivingMesh.material.opacity = 0.9;
    this.root.add(this.#highlightMesh, this.#laneMesh, this.#routeMesh, this.#drivingMesh, this.#pendingMesh, this.#pointsGroup, this.#labelGroup);
  }

  onMessage(): void {
    /* fed by the store, not by a topic */
  }

  /** The lane currently being driven, so it can be animated. */
  setRunState(run: RouteRunState): void {
    this.#run = run;
    this.#applyRunColors();
  }

  /** The rubber band the Link tool draws while dragging from one point. */
  setPendingLink(from: { x: number; y: number } | null, to: { x: number; y: number } | null): void {
    const pos: number[] = [];
    const col: number[] = [];
    if (from && to) pushRibbon(pos, col, from.x, from.y, to.x, to.y, LANE_WIDTH, new Color(COLORS.laneHighlight), Z_ROUTE);
    setGeometry(this.#pendingMesh, pos, col);
  }

  setHover(hit: RouteHit): void {
    const same =
      (this.#hover === null && hit === null) ||
      (this.#hover?.kind === "point" && hit?.kind === "point" && this.#hover.name === hit.name) ||
      (this.#hover?.kind === "lane" && hit?.kind === "lane" && this.#hover.index === hit.index);
    if (same) return;
    this.#hover = hit;
    this.#applyHighlight();
  }
  get hover(): RouteHit {
    return this.#hover;
  }

  /**
   * What is under a world position, within `pixels` screen pixels. The route
   * graph lies on the ground plane, so the ray from the pointer is intersected
   * with that plane once (by the Viewer) and hit-testing is exact 2D geometry
   * from there, in 2D and in 3D alike.
   */
  pick(x: number, y: number, worldPerPixel: number, pixels = 18): RouteHit {
    const tol = worldPerPixel * pixels;
    let best: RouteHit = null;
    let bestDist = Infinity;
    for (const p of this.#points) {
      const site = this.#store.points[p.name];
      if (!site) continue;
      const d = Math.hypot(x - site.x, y - site.y);
      const r = Math.max(DISC_RADIUS, worldPerPixel * MIN_DISC_PX) + tol * 0.5;
      if (d <= r && d < bestDist) {
        bestDist = d;
        best = { kind: "point", name: p.name };
      }
    }
    if (best) return best;
    for (let i = 0; i < this.#laneEnds.length; i++) {
      const e = this.#laneEnds[i]!;
      const hit = pointOnSegment(x, y, e.ax, e.ay, e.bx, e.by);
      if (hit.dist <= tol && hit.dist < bestDist) {
        bestDist = hit.dist;
        best = { kind: "lane", index: i, x: hit.x, y: hit.y };
      }
    }
    return best;
  }

  override update(ctx: LayerContext): void {
    const wpp = this.#viewer.worldPerPixel(0, 0, 0);
    const zoomed = wpp > this.#builtWpp * ZOOM_REBUILD_RATIO || wpp < this.#builtWpp / ZOOM_REBUILD_RATIO;
    if (this.#version !== this.#store.version || zoomed) {
      this.#version = this.#store.version;
      this.frameId = this.#store.frame;
      this.#builtWpp = wpp;
      this.#rebuild();
    }
    this.#laneMesh.visible = this.showLanes;
    this.#routeMesh.visible = this.showRoute;
    this.#pointsGroup.visible = this.showPoints;
    this.#labelGroup.visible = this.showPoints || this.showLanes;
    if (!this.applyTf(ctx, this.root, this.frameId)) return;
    this.#scaleScreenSizes();
    if (ctx.nowMs - this.#lastLabelPass > 120) {
      this.#lastLabelPass = ctx.nowMs;
      this.#hideCollidingLabels();
    }
    this.#animateDriving(ctx.nowMs);
  }

  override dispose(): void {
    disposeObject(this.root);
  }

  // ---- geometry -----------------------------------------------------------

  #rebuild(): void {
    const sites = this.#store.points;
    const lanes = this.#store.lanes;
    const wpp = this.#builtWpp;
    const laneWidth = Math.max(LANE_WIDTH, wpp * MIN_LANE_PX);
    const laneSlowWidth = Math.max(LANE_SLOW_WIDTH, wpp * MIN_LANE_SLOW_PX);
    const routeWidth = Math.max(ROUTE_WIDTH, wpp * MIN_ROUTE_PX);

    // lanes
    const pos: number[] = [];
    const col: number[] = [];
    this.#laneEnds = [];
    const laneLabels: { text: string; x: number; y: number }[] = [];
    for (const lane of lanes) {
      const a = sites[lane.from];
      const b = sites[lane.to];
      if (!a || !b) {
        this.#laneEnds.push({ ax: 0, ay: 0, bx: 0, by: 0 });
        continue;
      }
      this.#laneEnds.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
      const slow = typeof lane.speed_mps === "number" && lane.speed_mps > 0;
      const color = new Color(lane.blocked ? COLORS.laneBlocked : slow ? COLORS.laneSlow : COLORS.lane);
      const width = slow ? laneSlowWidth : laneWidth;
      if (lane.blocked) pushDashes(pos, col, a.x, a.y, b.x, b.y, width, color, Z_LANE);
      else pushRibbon(pos, col, a.x, a.y, b.x, b.y, width, color, Z_LANE);
      pushLaneArrows(pos, col, lane, a, b, color);
      if (slow) laneLabels.push({ text: `${lane.speed_mps} m/s`, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    }
    setGeometry(this.#laneMesh, pos, col);

    // the planned route through the mission's stops, on top of the lanes
    const stops = this.#store.stops;
    const legs = planRoute(stops, sites, lanes, this.#store.mission);
    const rpos: number[] = [];
    const rcol: number[] = [];
    this.#legRanges = [];
    for (const leg of legs) {
      const color = new Color(leg.problem ? COLORS.failed : COLORS.route);
      const start = rpos.length / 3;
      for (let i = 1; i < leg.route.length; i++) {
        const a = sites[leg.route[i - 1]!];
        const b = sites[leg.route[i]!];
        if (!a || !b) continue;
        pushRibbon(rpos, rcol, a.x, a.y, b.x, b.y, routeWidth, color, Z_ROUTE);
      }
      this.#legRanges.push({ stopIndex: leg.stopIndex, start, count: rpos.length / 3 - start, route: leg.route.slice() });
    }
    setGeometry(this.#routeMesh, rpos, rcol);
    this.#routeMesh.material.opacity = 0.9;
    this.#routeMesh.material.transparent = true;

    // points
    disposeObject(this.#pointsGroup);
    this.#points = [];
    const stopNumbers = new Map<string, number[]>();
    stops.forEach((stop, i) => {
      const site = stopSite(stop, this.#store.mission);
      if (site === null) return;
      const list = stopNumbers.get(site);
      if (list) list.push(i + 1);
      else stopNumbers.set(site, [i + 1]);
    });
    for (const [name, site] of Object.entries(sites)) {
      this.#points.push(this.#makePoint(name, site));
    }

    // labels
    disposeObject(this.#labelGroup);
    this.#labels = [];
    for (const [name, site] of Object.entries(sites)) {
      const nums = stopNumbers.get(name);
      const kind = site.kind ?? "station";
      this.#addLabel(name, site.x, site.y, {
        color: "#e6ecf6",
        background: "rgba(20,24,30,0.72)",
        priority: nums ? 100 : kind === "waypoint" ? 10 : 40,
        offsetRight: true,
      });
      if (nums) {
        this.#addLabel(nums.join(","), site.x, site.y, {
          color: "#0e1116",
          background: COLORS.route,
          priority: 200,
          bold: true,
          above: true,
        });
      }
    }
    for (const l of laneLabels) {
      this.#addLabel(l.text, l.x, l.y, { color: "#f5e2b0", background: "rgba(20,24,30,0.72)", priority: 30, small: true });
    }

    this.#applyRunColors();
    this.#applyHighlight();
    this.status = Object.keys(sites).length === 0 ? "Nothing drawn on this map yet" : "";
  }

  #legRanges: { stopIndex: number; start: number; count: number; route: string[] }[] = [];

  #makePoint(name: string, site: Site): PointVisual {
    const kind = site.kind ?? "station";
    const base = new Color(kind === "home" ? COLORS.home : kind === "dock" ? COLORS.dock : kind === "waypoint" ? COLORS.waypoint : COLORS.station);
    const disc = new Mesh(new CircleGeometry(DISC_RADIUS, 24), new MeshBasicMaterial({ color: base, depthTest: false, depthWrite: false, transparent: true }));
    disc.position.z = Z_DISC;
    disc.renderOrder = 12;
    const halo = new Mesh(new RingGeometry(DISC_RADIUS * 1.3, DISC_RADIUS * 1.85, 28), new MeshBasicMaterial({ color: COLORS.laneHighlight, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 }));
    halo.position.z = Z_HALO;
    halo.renderOrder = 11;
    halo.visible = false;
    const heading = new Mesh(headingGeometry(), new MeshBasicMaterial({ color: base, depthTest: false, depthWrite: false, transparent: true, side: DoubleSide }));
    heading.position.z = Z_ARROW;
    heading.renderOrder = 13;
    if (typeof site.yaw_deg === "number") heading.rotation.z = (site.yaw_deg * Math.PI) / 180;
    else heading.visible = false;
    const group = new Group();
    group.position.set(site.x, site.y, 0);
    group.add(halo, disc, heading);
    this.#pointsGroup.add(group);
    return { group, disc, halo, heading, baseColor: base, name };
  }

  #addLabel(
    text: string,
    x: number,
    y: number,
    opts: { color: string; background: string; priority: number; bold?: boolean; small?: boolean; offsetRight?: boolean; above?: boolean },
  ): void {
    const tex = textTexture(text, opts.color, opts.background, opts.bold === true, opts.small === true);
    const sprite = new Sprite(new SpriteMaterial({ map: tex.texture, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: true }));
    sprite.renderOrder = 20;
    sprite.position.set(x, y, Z_LABEL);
    // `center` shifts the sprite in screen space, so the offset survives orbiting.
    if (opts.offsetRight) sprite.center.set(-0.12, 0.5);
    else if (opts.above) sprite.center.set(0.5, -0.9);
    this.#labelGroup.add(sprite);
    this.#labels.push({ sprite, widthPx: tex.widthPx, heightPx: tex.heightPx, anchor: new Vector3(x, y, Z_LABEL), priority: opts.priority });
  }

  // ---- per-frame mutation -------------------------------------------------

  #scaleScreenSizes(): void {
    for (const p of this.#points) {
      const wpp = this.#viewer.worldPerPixel(p.group.position.x, p.group.position.y, 0);
      const s = Math.max(1, (wpp * MIN_DISC_PX) / DISC_RADIUS);
      p.group.scale.set(s, s, 1);
    }
    for (const l of this.#labels) {
      const wpp = this.#viewer.worldPerPixel(l.anchor.x, l.anchor.y, 0);
      l.sprite.scale.set(wpp * l.widthPx, wpp * l.heightPx, 1);
    }
  }

  /** Greedy screen-space declutter: the important labels win the space. */
  #hideCollidingLabels(): void {
    const taken: { x0: number; y0: number; x1: number; y1: number }[] = [];
    if (!this.#labelGroup.visible) return;
    const order = this.#labels.slice().sort((a, b) => b.priority - a.priority);
    for (const l of order) {
      _world.copy(l.anchor).applyMatrix4(this.root.matrix);
      if (!this.#viewer.projectToScreen(_world, _screen)) {
        l.sprite.visible = false;
        continue;
      }
      const w = l.widthPx;
      const h = l.heightPx;
      const cx = l.sprite.center.x;
      const cy = l.sprite.center.y;
      const x0 = _screen.x - cx * w;
      const y0 = _screen.y - (1 - cy) * h;
      const rect = { x0, y0, x1: x0 + w, y1: y0 + h };
      const clash = taken.some((t) => rect.x0 < t.x1 && rect.x1 > t.x0 && rect.y0 < t.y1 && rect.y1 > t.y0);
      l.sprite.visible = !clash;
      if (!clash) taken.push(rect);
    }
  }

  #applyHighlight(): void {
    const sel = this.#store.selection;
    for (const p of this.#points) {
      const selected = sel.kind === "point" && sel.name === p.name;
      const hovered = this.#hover?.kind === "point" && this.#hover.name === p.name;
      p.halo.visible = selected || hovered;
      // The selected point has to be unmistakable across the room: a wide,
      // opaque white ring. Hover is the same ring, smaller and softer.
      p.halo.material.color.set(selected ? "#ffffff" : COLORS.laneHighlight);
      p.halo.material.opacity = selected ? 1 : 0.6;
      const s = selected ? 1.4 : 1.1;
      p.halo.scale.set(s, s, 1);
    }
    // One wide ribbon under the hovered or selected lane; no full rebuild.
    const index = sel.kind === "lane" ? sel.index : this.#hover?.kind === "lane" ? this.#hover.index : -1;
    const e = index >= 0 ? this.#laneEnds[index] : undefined;
    const pos: number[] = [];
    const col: number[] = [];
    const selectedLane = sel.kind === "lane";
    if (e && (e.ax !== e.bx || e.ay !== e.by)) {
      const color = new Color(selectedLane ? "#ffffff" : COLORS.laneHighlight);
      const width = Math.max(HIGHLIGHT_WIDTH, this.#builtWpp * MIN_HIGHLIGHT_PX) * (selectedLane ? 1.5 : 1.1);
      pushRibbon(pos, col, e.ax, e.ay, e.bx, e.by, width, color, Z_HIGHLIGHT);
    }
    setGeometry(this.#highlightMesh, pos, col);
    this.#highlightMesh.material.opacity = selectedLane ? 0.85 : 0.5;
    this.#highlightMesh.material.transparent = true;
  }

  /** Colour the stops and pick out the leg being driven. */
  #applyRunColors(): void {
    const stops = this.#store.stops;
    const bySite = new Map<string, number>();
    stops.forEach((stop, i) => {
      const site = stopSite(stop, this.#store.mission);
      if (site !== null && !bySite.has(site)) bySite.set(site, i);
    });
    for (const p of this.#points) {
      const stopIndex = bySite.get(p.name);
      let color = p.baseColor;
      if (stopIndex !== undefined) {
        if (this.#run.failedStop === stopIndex) color = new Color(COLORS.failed);
        else if (this.#run.doneStops.has(stopIndex)) color = new Color(COLORS.done);
        else if (this.#run.activeStop === stopIndex) color = new Color(COLORS.driving);
      }
      p.disc.material.color.copy(color);
      p.heading.material.color.copy(color);
    }
    // The lane the robot is on: the leg that arrives at the active stop.
    this.#drivingLeg = [];
    const active = this.#run.activeStop;
    if (active !== null) {
      const leg = this.#legRanges.find((l) => l.stopIndex === active);
      if (leg) {
        const sites = this.#store.points;
        for (const name of leg.route) {
          const s = sites[name];
          if (s) this.#drivingLeg.push([s.x, s.y]);
        }
      }
    }
    if (this.#drivingLeg.length < 2) setGeometry(this.#drivingMesh, [], []);
  }

  /** A pulse travelling along the lane being driven. */
  #animateDriving(nowMs: number): void {
    if (this.#drivingLeg.length < 2) {
      this.#drivingMesh.visible = false;
      return;
    }
    this.#drivingMesh.visible = true;
    const total = this.#drivingLeg.reduce((sum, p, i) => (i === 0 ? 0 : sum + Math.hypot(p[0] - this.#drivingLeg[i - 1]![0], p[1] - this.#drivingLeg[i - 1]![1])), 0);
    if (total <= 0) return;
    const span = Math.min(1.2, total * 0.35);
    const head = ((nowMs / 900) % 1) * (total + span);
    const pos: number[] = [];
    const col: number[] = [];
    const color = new Color(COLORS.driving);
    let walked = 0;
    for (let i = 1; i < this.#drivingLeg.length; i++) {
      const a = this.#drivingLeg[i - 1]!;
      const b = this.#drivingLeg[i]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len <= 0) continue;
      const from = Math.max(walked, head - span);
      const to = Math.min(walked + len, head);
      if (to > from) {
        const t0 = (from - walked) / len;
        const t1 = (to - walked) / len;
        pushRibbon(
          pos,
          col,
          a[0] + (b[0] - a[0]) * t0,
          a[1] + (b[1] - a[1]) * t0,
          a[0] + (b[0] - a[0]) * t1,
          a[1] + (b[1] - a[1]) * t1,
          ROUTE_WIDTH * 1.1,
          color,
          Z_ROUTE + 0.002,
        );
      }
      walked += len;
    }
    setGeometry(this.#drivingMesh, pos, col);
  }
}

// ---- geometry helpers -------------------------------------------------------

function emptyMesh(color: string): Mesh<BufferGeometry, MeshBasicMaterial> {
  // Frustum culling is off, so the geometry must carry real (empty) attributes:
  // a BufferGeometry with no position attribute draws whatever is still bound,
  // which paints garbage over the map.
  const geom = new BufferGeometry();
  geom.setAttribute("position", new BufferAttribute(new Float32Array(0), 3));
  geom.setAttribute("color", new BufferAttribute(new Float32Array(0), 3));
  const mesh = new Mesh(geom, new MeshBasicMaterial({ color, vertexColors: true, depthTest: false, depthWrite: false, transparent: true }));
  mesh.frustumCulled = false;
  mesh.renderOrder = 8;
  mesh.visible = false;
  return mesh;
}

function setGeometry(mesh: Mesh<BufferGeometry, MeshBasicMaterial>, pos: number[], col: number[]): void {
  const geom = new BufferGeometry();
  geom.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  geom.setAttribute("color", new BufferAttribute(new Float32Array(col), 3));
  const old = mesh.geometry;
  mesh.geometry = geom;
  old.dispose();
  mesh.visible = pos.length > 0;
}

function pushVertex(pos: number[], col: number[], x: number, y: number, z: number, c: Color): void {
  pos.push(x, y, z);
  col.push(c.r, c.g, c.b);
}

/** Two triangles forming a band of `width` metres from a to b. */
function pushRibbon(pos: number[], col: number[], ax: number, ay: number, bx: number, by: number, width: number, c: Color, z: number): void {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const nx = (-dy / len) * (width / 2);
  const ny = (dx / len) * (width / 2);
  pushVertex(pos, col, ax + nx, ay + ny, z, c);
  pushVertex(pos, col, ax - nx, ay - ny, z, c);
  pushVertex(pos, col, bx - nx, by - ny, z, c);
  pushVertex(pos, col, ax + nx, ay + ny, z, c);
  pushVertex(pos, col, bx - nx, by - ny, z, c);
  pushVertex(pos, col, bx + nx, by + ny, z, c);
}

/** A dashed band: a blocked lane. */
function pushDashes(pos: number[], col: number[], ax: number, ay: number, bx: number, by: number, width: number, c: Color, z: number): void {
  const len = Math.hypot(bx - ax, by - ay);
  if (len < 1e-6) return;
  const dash = 0.28;
  const gap = 0.18;
  for (let s = 0; s < len; s += dash + gap) {
    const t0 = s / len;
    const t1 = Math.min(1, (s + dash) / len);
    pushRibbon(pos, col, ax + (bx - ax) * t0, ay + (by - ay) * t0, ax + (bx - ax) * t1, ay + (by - ay) * t1, width, c, z);
  }
}

function pushArrowHead(pos: number[], col: number[], x: number, y: number, dx: number, dy: number, size: number, c: Color, z: number): void {
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  pushVertex(pos, col, x + ux * size, y + uy * size, z, c);
  pushVertex(pos, col, x - ux * size * 0.4 + px * size * 0.6, y - uy * size * 0.4 + py * size * 0.6, z, c);
  pushVertex(pos, col, x - ux * size * 0.4 - px * size * 0.6, y - uy * size * 0.4 - py * size * 0.6, z, c);
}

/** One arrowhead when the lane is one-way, two when it goes both ways. */
function pushLaneArrows(pos: number[], col: number[], lane: Edge, a: Site, b: Site, c: Color): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const size = Math.min(0.22, len * 0.22);
  if (lane.bidirectional === false) {
    pushArrowHead(pos, col, a.x + dx * 0.62, a.y + dy * 0.62, dx, dy, size, c, Z_LANE + 0.001);
  } else {
    pushArrowHead(pos, col, a.x + dx * 0.74, a.y + dy * 0.74, dx, dy, size, c, Z_LANE + 0.001);
    pushArrowHead(pos, col, a.x + dx * 0.26, a.y + dy * 0.26, -dx, -dy, size, c, Z_LANE + 0.001);
  }
}

/** The little triangle that shows a point's heading. */
function headingGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  const r = DISC_RADIUS;
  const verts = new Float32Array([r * 1.15, 0, 0, r * 0.35, r * 0.42, 0, r * 0.35, -r * 0.42, 0, r * 2.1, 0, 0, r * 1.15, r * 0.3, 0, r * 1.15, -r * 0.3, 0]);
  g.setAttribute("position", new BufferAttribute(verts, 3));
  return g;
}

// ---- text sprites -----------------------------------------------------------

interface TextTexture {
  texture: CanvasTexture;
  widthPx: number;
  heightPx: number;
}

const textCache = new Map<string, TextTexture>();

/**
 * Render a label to a canvas once and reuse it. `widthPx`/`heightPx` are the
 * on-screen size the sprite is scaled to every frame.
 */
function textTexture(text: string, color: string, background: string, bold: boolean, small: boolean): TextTexture {
  const key = `${text}|${color}|${background}|${bold ? 1 : 0}|${small ? 1 : 0}`;
  const cached = textCache.get(key);
  if (cached) return cached;
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const fontPx = small ? 10 : 12;
  const padX = 5;
  const padY = 3;
  const font = `${bold ? "600 " : ""}${fontPx}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const measure = document.createElement("canvas").getContext("2d");
  if (measure) measure.font = font;
  const textW = measure ? measure.measureText(text).width : text.length * fontPx * 0.6;
  const widthPx = Math.ceil(textW + padX * 2);
  const heightPx = fontPx + padY * 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(widthPx * dpr));
  canvas.height = Math.max(1, Math.ceil(heightPx * dpr));
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.scale(dpr, dpr);
    ctx.font = font;
    ctx.textBaseline = "middle";
    ctx.fillStyle = background;
    roundRect(ctx, 0, 0, widthPx, heightPx, 3);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(text, padX, heightPx / 2 + 0.5);
  }
  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  const out = { texture, widthPx, heightPx };
  if (textCache.size > 500) textCache.clear();
  textCache.set(key, out);
  return out;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
