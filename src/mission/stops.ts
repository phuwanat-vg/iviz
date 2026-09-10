/**
 * Compilation both ways between a mission's flat `flow` and the list of stops
 * the Route panel edits.
 *
 * A stop is one `nav.follow_route` step plus the action steps that follow it
 * in the flow. Anything that does not fit that shape — steps before the first
 * stop, and control flow (`if`, `loop`, `break`) — becomes an "other" segment:
 * it is shown in the panel's "Other steps" list, never edited away and never
 * dropped. Because the flow is modelled as an ordered list of segments and the
 * original step objects are reused, reading and writing round-trips exactly:
 * step ids and unknown fields survive.
 */

import type { Mission, Site, Step } from "./types";
import type { Edge } from "./types";
import { routeThroughGraph } from "./geometry";
import { hasExpression } from "./expressions";

export const STOP_TYPE = "nav.follow_route";

/** Step types that end a stop: their nested steps are not stop actions. */
const CONTROL_FLOW = new Set(["if", "loop", "break"]);

export interface Stop {
  /** The `nav.follow_route` step, reused as-is so its id and extra fields survive. */
  step: Step;
  /** Steps that follow it in the flat flow, in order. */
  actions: Step[];
}

export type FlowSegment = { kind: "stop"; stop: Stop } | { kind: "other"; step: Step; reason: string };

export interface FlowModel {
  segments: FlowSegment[];
  stops: Stop[];
  others: { step: Step; reason: string }[];
}

/** Split a mission's flow into stops and the steps that do not fit the pattern. */
export function readFlow(mission: Mission | null): FlowModel {
  const segments: FlowSegment[] = [];
  const flow = mission?.flow ?? [];
  let current: Stop | null = null;
  let seenStop = false;
  for (const step of flow) {
    const type = typeof step.type === "string" ? step.type : "";
    if (type === STOP_TYPE) {
      current = { step, actions: [] };
      seenStop = true;
      segments.push({ kind: "stop", stop: current });
      continue;
    }
    if (CONTROL_FLOW.has(type)) {
      current = null;
      segments.push({ kind: "other", step, reason: "control flow" });
      continue;
    }
    if (current) {
      current.actions.push(step);
      continue;
    }
    segments.push({ kind: "other", step, reason: seenStop ? "after control flow" : "before the first stop" });
  }
  const stops: Stop[] = [];
  const others: { step: Step; reason: string }[] = [];
  for (const s of segments) {
    if (s.kind === "stop") stops.push(s.stop);
    else others.push({ step: s.step, reason: s.reason });
  }
  // A mission with no stops at all has no "first stop" to be before.
  if (stops.length === 0) {
    for (const s of segments) if (s.kind === "other" && s.reason === "before the first stop") s.reason = "not part of a stop";
    for (const o of others) if (o.reason === "before the first stop") o.reason = "not part of a stop";
  }
  return { segments, stops, others };
}

/** Flatten segments back into a `flow`, in segment order. */
export function writeFlow(segments: readonly FlowSegment[]): Step[] {
  const flow: Step[] = [];
  for (const seg of segments) {
    if (seg.kind === "stop") {
      flow.push(seg.stop.step, ...seg.stop.actions);
    } else {
      flow.push(seg.step);
    }
  }
  return flow;
}

/** Write the segments into `mission.flow`, leaving everything else untouched. */
export function applyFlow(mission: Mission, segments: readonly FlowSegment[]): void {
  mission.flow = writeFlow(segments);
}

/**
 * Move the stop at `fromIndex` (counting stops only) to `toIndex`. Other
 * segments keep their absolute slot, so control flow does not travel with a
 * reordered stop.
 */
export function reorderStops(segments: FlowSegment[], fromIndex: number, toIndex: number): FlowSegment[] {
  const slots: number[] = [];
  segments.forEach((s, i) => {
    if (s.kind === "stop") slots.push(i);
  });
  if (fromIndex < 0 || fromIndex >= slots.length) return segments;
  const target = Math.max(0, Math.min(slots.length - 1, toIndex));
  const stops = slots.map((i) => (segments[i] as { kind: "stop"; stop: Stop }).stop);
  const [moved] = stops.splice(fromIndex, 1);
  if (!moved) return segments;
  stops.splice(target, 0, moved);
  const out = segments.slice();
  slots.forEach((slot, i) => {
    out[slot] = { kind: "stop", stop: stops[i]! };
  });
  return out;
}

export interface StopDestination {
  /** The site, when it can be known without running the mission. */
  site: string | null;
  /** The input or variable the destination comes from, when it is `$name`. */
  input: string | null;
  /** What the step actually says. */
  raw: string;
}

/**
 * Where a stop drives to. `to` is usually a site name; when it is `$name` the
 * declared default of that input (or variable) is used, which is what lets a
 * mission with parameterised stops still be drawn and edited on the map.
 */
export function stopDestination(stop: Stop, mission?: Mission | null): StopDestination {
  const to = typeof stop.step.to === "string" ? stop.step.to : "";
  if (to === "") return { site: null, input: null, raw: to };
  if (!hasExpression(to)) return { site: to, input: null, raw: to };
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(to);
  if (!m || !mission) return { site: null, input: null, raw: to };
  const name = m[1]!;
  const def = mission.inputs?.[name];
  const value = def ? def.default : mission.vars?.[name];
  return { site: typeof value === "string" && value !== "" ? value : null, input: name, raw: to };
}

/** The site a stop drives to, or null when it is only known at run time. */
export function stopSite(stop: Stop, mission?: Mission | null): string | null {
  return stopDestination(stop, mission).site;
}

/** Human label for a stop: its name, else its destination. */
export function stopLabel(stop: Stop): string {
  const name = stop.step.name;
  if (typeof name === "string" && name.trim() !== "") return name.trim();
  const to = stop.step.to;
  return typeof to === "string" && to !== "" ? to : "(no destination)";
}

export interface PlannedLeg {
  /** Site names along the lanes, from the previous stop to this one. */
  route: string[];
  /** Index of the stop this leg arrives at. */
  stopIndex: number;
  /** Set when the graph has no path; the mission cannot drive it. */
  problem: string;
}

/**
 * The route the robot takes through the stops, leg by leg, along the lanes.
 * The first stop has no leg unless `start` names the site to begin from.
 */
export function planRoute(stops: readonly Stop[], sites: Record<string, Site>, edges: readonly Edge[], mission?: Mission | null, start?: string | null): PlannedLeg[] {
  const legs: PlannedLeg[] = [];
  let from = start && sites[start] ? start : null;
  stops.forEach((stop, stopIndex) => {
    const to = stopSite(stop, mission);
    if (to === null) {
      from = null;
      return;
    }
    if (!sites[to]) {
      legs.push({ route: [], stopIndex, problem: `site '${to}' is not on this map` });
      from = null;
      return;
    }
    if (from !== null) {
      const route = routeThroughGraph(sites, edges, from, to);
      if (route) legs.push({ route, stopIndex, problem: "" });
      else legs.push({ route: [from, to], stopIndex, problem: `no lane route from ${from} to ${to}` });
    }
    from = to;
  });
  return legs;
}
