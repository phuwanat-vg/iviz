/**
 * Everything Route mode edits: the route graph (a map's sites and lanes) and
 * the open mission's stops, with undo/redo and unsaved-changes tracking.
 *
 * The graph belongs to the map, not to a mission: it is saved with
 * `PUT /api/sites` and shared by every mission. A mission is saved separately
 * with `PUT /api/missions/{name}`, so the two dirty flags are independent.
 *
 * Undo is snapshot based (the documents are a few kilobytes); a drag calls
 * `beginEdit` once and `commit` once, so one drag is one undo entry.
 */

import type { Edge, Mission, Site, SiteKind, SitesDoc, Step } from "./types";
import { SITES_SCHEMA_ID } from "./types";
import { deepClone } from "./ids";
import { round1, round3, uniqueSiteName } from "./geometry";
import type { FlowModel, FlowSegment, Stop } from "./stops";
import { applyFlow, readFlow, reorderStops } from "./stops";

export type Selection =
  | { kind: "none" }
  | { kind: "point"; name: string }
  | { kind: "lane"; index: number }
  | { kind: "stop"; index: number };

export const NO_SELECTION: Selection = { kind: "none" };

interface Snapshot {
  sites: string;
  mission: string | null;
  label: string;
}

type Listener = (reason: "data" | "selection") => void;

const MAX_HISTORY = 100;

function emptySites(): SitesDoc {
  return { schema: SITES_SCHEMA_ID, maps: {} };
}

export class RouteStore {
  #sites: SitesDoc = emptySites();
  #mapName = "";
  #mission: Mission | null = null;
  #flow: FlowModel = readFlow(null);
  #sitesDirty = false;
  #missionDirty = false;
  #undo: Snapshot[] = [];
  #redo: Snapshot[] = [];
  #pending: Snapshot | null = null;
  #selection: Selection = NO_SELECTION;
  #listeners = new Set<Listener>();
  /** Bumped whenever the graph or the mission changes, so the layer can rebuild. */
  version = 0;

  onChange(l: Listener): () => void {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }

  // ---- documents ----------------------------------------------------------

  get sites(): SitesDoc {
    return this.#sites;
  }
  get mapName(): string {
    return this.#mapName;
  }
  get mapNames(): string[] {
    return Object.keys(this.#sites.maps ?? {});
  }
  get points(): Record<string, Site> {
    const map = this.#sites.maps?.[this.#mapName];
    if (!map) return {};
    if (!map.sites) map.sites = {};
    return map.sites;
  }
  get lanes(): Edge[] {
    const map = this.#sites.maps?.[this.#mapName];
    if (!map) return [];
    if (!map.edges) map.edges = [];
    return map.edges;
  }
  get frame(): string {
    return this.#sites.maps?.[this.#mapName]?.frame || "map";
  }
  get mission(): Mission | null {
    return this.#mission;
  }
  get flow(): FlowModel {
    return this.#flow;
  }
  get stops(): Stop[] {
    return this.#flow.stops;
  }
  get sitesDirty(): boolean {
    return this.#sitesDirty;
  }
  get missionDirty(): boolean {
    return this.#missionDirty;
  }
  get dirty(): boolean {
    return this.#sitesDirty || this.#missionDirty;
  }
  get canUndo(): boolean {
    return this.#undo.length > 0;
  }
  get canRedo(): boolean {
    return this.#redo.length > 0;
  }
  get undoLabel(): string {
    return this.#undo[this.#undo.length - 1]?.label ?? "";
  }

  /** Load a freshly fetched sites document; clears history and dirty state. */
  setSites(doc: SitesDoc, keepMap = true): void {
    this.#sites = doc && typeof doc === "object" ? doc : emptySites();
    if (!this.#sites.maps) this.#sites.maps = {};
    const names = Object.keys(this.#sites.maps);
    if (!keepMap || !this.#mapName || !names.includes(this.#mapName)) {
      this.#mapName = (this.#sites.default_map && names.includes(this.#sites.default_map) ? this.#sites.default_map : names[0]) ?? "";
    }
    this.#sitesDirty = false;
    this.#undo = [];
    this.#redo = [];
    this.#selection = NO_SELECTION;
    this.#emit("data");
  }

  setMapName(name: string): void {
    if (name === this.#mapName) return;
    this.#mapName = name;
    this.#selection = NO_SELECTION;
    this.#emit("data");
  }

  /** Load a mission (or none); clears the mission dirty flag and history. */
  setMission(mission: Mission | null): void {
    this.#mission = mission;
    this.#flow = readFlow(mission);
    this.#missionDirty = false;
    this.#undo = [];
    this.#redo = [];
    if (this.#selection.kind === "stop") this.#selection = NO_SELECTION;
    this.#emit("data");
  }

  markSitesSaved(): void {
    this.#sitesDirty = false;
    this.#emit("data");
  }
  markMissionSaved(): void {
    this.#missionDirty = false;
    this.#emit("data");
  }

  // ---- selection ----------------------------------------------------------

  get selection(): Selection {
    return this.#selection;
  }
  select(sel: Selection): void {
    if (sel.kind === this.#selection.kind) {
      if (sel.kind === "none") return;
      if (sel.kind === "point" && this.#selection.kind === "point" && sel.name === this.#selection.name) return;
      if (sel.kind === "lane" && this.#selection.kind === "lane" && sel.index === this.#selection.index) return;
      if (sel.kind === "stop" && this.#selection.kind === "stop" && sel.index === this.#selection.index) return;
    }
    this.#selection = sel;
    this.#emit("selection");
  }

  // ---- history ------------------------------------------------------------

  /** Take a snapshot before a change. Pair it with `commit` or `rollback`. */
  beginEdit(label: string): void {
    if (this.#pending) return;
    this.#pending = { sites: JSON.stringify(this.#sites), mission: this.#mission ? JSON.stringify(this.#mission) : null, label };
  }

  /** Finish an edit: pushes the snapshot when something actually changed. */
  commit(opts: { sites?: boolean; mission?: boolean } = {}): void {
    const pending = this.#pending;
    this.#pending = null;
    if (!pending) return;
    const sitesNow = JSON.stringify(this.#sites);
    const missionNow = this.#mission ? JSON.stringify(this.#mission) : null;
    if (sitesNow === pending.sites && missionNow === pending.mission) return;
    this.#undo.push(pending);
    if (this.#undo.length > MAX_HISTORY) this.#undo.shift();
    this.#redo = [];
    if (opts.sites !== false && sitesNow !== pending.sites) this.#sitesDirty = true;
    if (opts.mission !== false && missionNow !== pending.mission) this.#missionDirty = true;
    if (missionNow !== pending.mission && this.#mission) this.#flow = readFlow(this.#mission);
    this.version++;
    this.#emit("data");
  }

  /** Abandon an edit in progress and restore the snapshot. */
  rollback(): void {
    const pending = this.#pending;
    this.#pending = null;
    if (!pending) return;
    this.#restore(pending);
  }

  /** One edit in one call: `edit("Move point", () => { ... })`. */
  edit(label: string, fn: () => void, opts: { sites?: boolean; mission?: boolean } = {}): void {
    this.beginEdit(label);
    try {
      fn();
    } catch (err) {
      this.rollback();
      throw err;
    }
    this.commit(opts);
  }

  undo(): boolean {
    const snap = this.#undo.pop();
    if (!snap) return false;
    this.#redo.push(this.#swap(snap));
    return true;
  }

  redo(): boolean {
    const snap = this.#redo.pop();
    if (!snap) return false;
    this.#undo.push(this.#swap(snap));
    return true;
  }

  /** Restore a snapshot, returning the state it replaced. Only the half that
   *  actually changed becomes dirty, so undoing a map edit does not pretend
   *  the mission needs deploying. */
  #swap(snap: Snapshot): Snapshot {
    const current: Snapshot = { sites: JSON.stringify(this.#sites), mission: this.#mission ? JSON.stringify(this.#mission) : null, label: snap.label };
    this.#restore(snap);
    if (current.sites !== snap.sites) this.#sitesDirty = true;
    if (current.mission !== snap.mission) this.#missionDirty = true;
    return current;
  }

  #restore(snap: Snapshot): void {
    this.#sites = JSON.parse(snap.sites) as SitesDoc;
    this.#mission = snap.mission === null ? null : (JSON.parse(snap.mission) as Mission);
    this.#flow = readFlow(this.#mission);
    if (!this.mapNames.includes(this.#mapName)) this.#mapName = this.mapNames[0] ?? "";
    this.#clampSelection();
    this.version++;
    this.#emit("data");
  }

  #clampSelection(): void {
    const sel = this.#selection;
    if (sel.kind === "point" && !this.points[sel.name]) this.#selection = NO_SELECTION;
    else if (sel.kind === "lane" && sel.index >= this.lanes.length) this.#selection = NO_SELECTION;
    else if (sel.kind === "stop" && sel.index >= this.stops.length) this.#selection = NO_SELECTION;
  }

  // ---- graph edits --------------------------------------------------------

  /** Create a point and select it. Returns its name. */
  addPoint(x: number, y: number, yawDeg: number | null, kind: SiteKind = "waypoint", baseName = "P"): string {
    const name = uniqueSiteName(this.points, baseName);
    this.edit("Add point", () => {
      const site: Site = { x: round3(x), y: round3(y), kind };
      if (yawDeg !== null) site.yaw_deg = round1(yawDeg);
      this.points[name] = site;
    });
    this.select({ kind: "point", name });
    return name;
  }

  movePoint(name: string, x: number, y: number): void {
    const site = this.points[name];
    if (!site) return;
    site.x = round3(x);
    site.y = round3(y);
  }

  setPointYaw(name: string, yawDeg: number | null): void {
    const site = this.points[name];
    if (!site) return;
    if (yawDeg === null) delete site.yaw_deg;
    else site.yaw_deg = round1(yawDeg);
  }

  setPointKind(name: string, kind: SiteKind): void {
    const site = this.points[name];
    if (!site) return;
    this.edit("Change point kind", () => {
      site.kind = kind;
    });
  }

  /** Rename a point and every lane, stop and pose that referenced it. */
  renamePoint(from: string, to: string): string {
    const trimmed = to.trim();
    if (trimmed === "" || trimmed === from) return from;
    if (this.points[trimmed]) return from;
    this.edit("Rename point", () => {
      const site = this.points[from];
      if (!site) return;
      // Rebuild the record so the key order (and so the panel order) is stable.
      const rebuilt: Record<string, Site> = {};
      for (const [k, v] of Object.entries(this.points)) rebuilt[k === from ? trimmed : k] = v;
      const map = this.#sites.maps[this.#mapName];
      if (map) map.sites = rebuilt;
      for (const lane of this.lanes) {
        if (lane.from === from) lane.from = trimmed;
        if (lane.to === from) lane.to = trimmed;
      }
      this.#renameInMission(from, trimmed);
    });
    if (this.#selection.kind === "point" && this.#selection.name === from) this.select({ kind: "point", name: trimmed });
    return trimmed;
  }

  #renameInMission(from: string, to: string): void {
    if (!this.#mission) return;
    const visit = (value: unknown): unknown => {
      if (typeof value === "string") return value === from ? to : value;
      if (Array.isArray(value)) return value.map(visit);
      if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = visit(v);
        return out;
      }
      return value;
    };
    // Only rewrite the places that name a site, never free text.
    for (const step of this.#mission.flow ?? []) {
      if (step.type === "nav.follow_route") {
        if (step.to === from) step.to = to;
        if (step.from === from) step.from = to;
      } else if (typeof step.pose === "string" || Array.isArray(step.poses)) {
        if (step.pose === from) step.pose = to;
        if (Array.isArray(step.poses)) step.poses = (step.poses as unknown[]).map(visit);
      }
    }
    this.#flow = readFlow(this.#mission);
  }

  /** Points and stops that would break if `name` were removed. */
  referencesTo(name: string): string[] {
    const refs: string[] = [];
    for (const lane of this.lanes) {
      if (lane.from === name || lane.to === name) refs.push(`lane ${lane.from} → ${lane.to}`);
    }
    this.#flow.stops.forEach((stop, i) => {
      if (stop.step.to === name || stop.step.from === name) refs.push(`stop ${i + 1}`);
    });
    return refs;
  }

  deletePoint(name: string): void {
    this.edit("Delete point", () => {
      delete this.points[name];
      const map = this.#sites.maps[this.#mapName];
      if (map?.edges) map.edges = map.edges.filter((e) => e.from !== name && e.to !== name);
    });
    if (this.#selection.kind === "point" && this.#selection.name === name) this.select(NO_SELECTION);
  }

  /** Add a lane, unless one already joins the two points. Returns its index. */
  addLane(from: string, to: string, oneWay: boolean): number {
    if (from === to || !this.points[from] || !this.points[to]) return -1;
    const existing = this.lanes.findIndex((e) => (e.from === from && e.to === to) || (e.from === to && e.to === from));
    if (existing >= 0) return existing;
    let index = -1;
    this.edit("Add lane", () => {
      const lane: Edge = { from, to };
      if (oneWay) lane.bidirectional = false;
      this.lanes.push(lane);
      index = this.lanes.length - 1;
    });
    if (index >= 0) this.select({ kind: "lane", index });
    return index;
  }

  updateLane(index: number, patch: Partial<Edge>, label = "Change lane"): void {
    const lane = this.lanes[index];
    if (!lane) return;
    this.edit(label, () => {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete (lane as unknown as Record<string, unknown>)[k];
        else (lane as unknown as Record<string, unknown>)[k] = v;
      }
    });
  }

  deleteLane(index: number): void {
    if (!this.lanes[index]) return;
    this.edit("Delete lane", () => {
      this.lanes.splice(index, 1);
    });
    this.select(NO_SELECTION);
  }

  /** Drop a new point onto a lane: the lane becomes two, meeting at the point. */
  splitLane(index: number, x: number, y: number, baseName = "P"): string | null {
    const lane = this.lanes[index];
    if (!lane) return null;
    const name = uniqueSiteName(this.points, baseName);
    this.edit("Split lane", () => {
      this.points[name] = { x: round3(x), y: round3(y), kind: "waypoint" };
      const rest: Edge = { ...lane, from: name, to: lane.to };
      lane.to = name;
      this.lanes.splice(index + 1, 0, rest);
    });
    this.select({ kind: "point", name });
    return name;
  }

  // ---- mission edits ------------------------------------------------------

  #segments(): FlowSegment[] {
    return this.#flow.segments;
  }

  #syncFlow(): void {
    if (!this.#mission) return;
    applyFlow(this.#mission, this.#segments());
    this.#flow = readFlow(this.#mission);
  }

  addStop(site: string, index = -1): void {
    if (!this.#mission) return;
    this.edit("Add stop", () => {
      const step: Step = { id: nextStepId(this.#mission!, "stop"), type: "nav.follow_route", to: site };
      const segs = this.#segments();
      const seg: FlowSegment = { kind: "stop", stop: { step, actions: [] } };
      if (index < 0) segs.push(seg);
      else {
        const slots = segs.map((s, i) => (s.kind === "stop" ? i : -1)).filter((i) => i >= 0);
        const at = slots[index];
        segs.splice(at === undefined ? segs.length : at, 0, seg);
      }
      this.#syncFlow();
    });
    this.select({ kind: "stop", index: index < 0 ? this.#flow.stops.length - 1 : Math.min(index, this.#flow.stops.length - 1) });
  }

  removeStop(index: number): void {
    const stop = this.#flow.stops[index];
    if (!stop || !this.#mission) return;
    this.edit("Remove stop", () => {
      this.#flow.segments = this.#segments().filter((s) => s.kind !== "stop" || s.stop !== stop);
      this.#syncFlow();
    });
    this.select(NO_SELECTION);
  }

  moveStop(from: number, to: number): void {
    if (!this.#mission || from === to) return;
    this.edit("Reorder stops", () => {
      this.#flow.segments = reorderStops(this.#segments(), from, to);
      this.#syncFlow();
    });
    this.select({ kind: "stop", index: Math.max(0, Math.min(this.#flow.stops.length - 1, to)) });
  }

  setStopSite(index: number, site: string): void {
    const stop = this.#flow.stops[index];
    if (!stop) return;
    this.edit("Change stop", () => {
      stop.step.to = site;
      this.#syncFlow();
    });
  }

  addAction(stopIndex: number, step: Step): void {
    const stop = this.#flow.stops[stopIndex];
    if (!stop || !this.#mission) return;
    this.edit("Add action", () => {
      stop.actions.push(step);
      this.#syncFlow();
    });
  }

  removeAction(stopIndex: number, actionIndex: number): void {
    const stop = this.#flow.stops[stopIndex];
    if (!stop) return;
    this.edit("Remove action", () => {
      stop.actions.splice(actionIndex, 1);
      this.#syncFlow();
    });
  }

  moveAction(stopIndex: number, from: number, to: number): void {
    const stop = this.#flow.stops[stopIndex];
    if (!stop || from === to) return;
    this.edit("Reorder actions", () => {
      const [moved] = stop.actions.splice(from, 1);
      if (moved) stop.actions.splice(Math.max(0, Math.min(stop.actions.length, to)), 0, moved);
      this.#syncFlow();
    });
  }

  /** Set one parameter of a step that is already in the mission. */
  setStepParam(step: Step, key: string, value: unknown, label = "Edit action"): void {
    this.edit(label, () => {
      if (value === undefined) delete step[key];
      else step[key] = value;
      this.#syncFlow();
    });
  }

  // ---- misc ---------------------------------------------------------------

  /** A deep copy of the mission, for validation and deployment. */
  missionCopy(): Mission | null {
    return this.#mission ? deepClone(this.#mission) : null;
  }

  sitesCopy(): SitesDoc {
    return deepClone(this.#sites);
  }

  #emit(reason: "data" | "selection"): void {
    if (reason === "data") this.version++;
    for (const l of this.#listeners) l(reason);
  }
}

/** A step id of the form `<prefix>_<n>` that is not taken in this mission. */
export function nextStepId(mission: Mission, prefix: string): string {
  const taken = new Set<string>();
  const walk = (steps: Step[] | undefined): void => {
    for (const s of steps ?? []) {
      if (typeof s.id === "string") taken.add(s.id);
      for (const key of ["then", "else", "body"]) {
        const nested = s[key];
        if (Array.isArray(nested)) walk(nested as Step[]);
      }
    }
  };
  walk(mission.flow);
  walk(mission.on_abort);
  for (let i = 1; ; i++) {
    const id = `${prefix}_${i}`;
    if (!taken.has(id)) return id;
  }
}
