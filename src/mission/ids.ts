/**
 * Id generation, deep cloning and path helpers. A "list path" addresses an
 * array of steps (`["flow"]`, `["flow", 1, "body"]`,
 * `["flow", 2, "on_fail", "before_retry"]`); a "step path" is a list path
 * plus an index.
 */

import type { Mission, Path, Step, Trigger } from "./types";
import { isRecord } from "./types";

/** Keys of a step type that hold nested step lists. */
export const CONTAINER_KEYS: Readonly<Record<string, readonly string[]>> = {
  if: ["then", "else"],
  loop: ["body"],
};

export const BEFORE_RETRY_PATH: readonly string[] = ["on_fail", "before_retry"];

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

export function randomBase36(length = 6): string {
  let out = "";
  const buf = new Uint8Array(length);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") crypto.getRandomValues(buf);
  else for (let i = 0; i < length; i++) buf[i] = Math.floor(Math.random() * 256);
  for (let i = 0; i < length; i++) out += BASE36[buf[i]! % 36];
  return out;
}

export function genId(prefix: "s" | "t" | "i" | "r", taken?: ReadonlySet<string>): string {
  for (;;) {
    const id = `${prefix}_${randomBase36()}`;
    if (!taken || !taken.has(id)) return id;
  }
}

export function deepClone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Compact JSON with sorted keys (same shape as the runner's canonical_json). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

// ---- walking ----------------------------------------------------------------

export interface StepVisit {
  step: Step;
  /** Path of the step itself, e.g. ["flow", 1, "body", 0]. */
  path: Path;
  /** The array holding the step. */
  list: Step[];
  index: number;
  /** Nearest enclosing step (container or on_fail owner) or null at top level. */
  parent: Step | null;
  /** Types of enclosing steps, outermost first. */
  ancestors: Step[];
}

export function* walkList(list: Step[], listPath: Path, ancestors: Step[] = []): Generator<StepVisit> {
  for (let i = 0; i < list.length; i++) {
    const step = list[i]!;
    const path = [...listPath, i];
    yield { step, path, list, index: i, parent: ancestors[ancestors.length - 1] ?? null, ancestors };
    yield* walkChildren(step, path, ancestors);
  }
}

export function* walkChildren(step: Step, path: Path, ancestors: Step[] = []): Generator<StepVisit> {
  const inner = [...ancestors, step];
  for (const key of CONTAINER_KEYS[step.type] ?? []) {
    const nested = step[key];
    if (Array.isArray(nested)) yield* walkList(nested as Step[], [...path, key], inner);
  }
  const before = step.on_fail?.before_retry;
  if (Array.isArray(before)) yield* walkList(before, [...path, ...BEFORE_RETRY_PATH], inner);
}

/** Depth-first over flow, on_abort, containers and before_retry lists. */
export function* walkSteps(mission: Mission): Generator<StepVisit> {
  yield* walkList(mission.flow ?? [], ["flow"]);
  yield* walkList(mission.on_abort ?? [], ["on_abort"]);
}

export function allStepIds(mission: Mission): Set<string> {
  const ids = new Set<string>();
  for (const v of walkSteps(mission)) if (typeof v.step.id === "string") ids.add(v.step.id);
  return ids;
}

export function findStep(mission: Mission, id: string): StepVisit | null {
  for (const v of walkSteps(mission)) if (v.step.id === id) return v;
  return null;
}

/** Resolve a list path to the array it addresses (creating nothing). */
export function getList(mission: Mission, listPath: Path): Step[] | null {
  let node: unknown = mission;
  for (const seg of listPath) {
    if (Array.isArray(node) && typeof seg === "number") node = node[seg];
    else if (isRecord(node) && typeof seg === "string") node = node[seg];
    else return null;
    if (node === undefined) return null;
  }
  return Array.isArray(node) ? (node as Step[]) : null;
}

/** Resolve a list path, creating missing arrays (`else`, `before_retry`). */
export function ensureList(mission: Mission, listPath: Path): Step[] | null {
  let node: unknown = mission;
  for (let i = 0; i < listPath.length; i++) {
    const seg = listPath[i]!;
    const last = i === listPath.length - 1;
    if (Array.isArray(node) && typeof seg === "number") {
      node = node[seg];
    } else if (isRecord(node) && typeof seg === "string") {
      if (node[seg] === undefined) node[seg] = last ? [] : {};
      node = node[seg];
    } else return null;
    if (node === undefined) return null;
  }
  return Array.isArray(node) ? (node as Step[]) : null;
}

export function getStepAt(mission: Mission, path: Path): Step | null {
  if (path.length === 0) return null;
  const list = getList(mission, path.slice(0, -1));
  const idx = path[path.length - 1];
  if (!list || typeof idx !== "number") return null;
  return list[idx] ?? null;
}

export function pathKey(path: Path): string {
  return path.map(String).join("/");
}

/** True when `child` is `parent` or lies inside it. */
export function pathWithin(child: Path, parent: Path): boolean {
  if (child.length < parent.length) return false;
  for (let i = 0; i < parent.length; i++) if (child[i] !== parent[i]) return false;
  return true;
}

// ---- id assignment -------------------------------------------------------------

/** Give ids to steps and triggers that lack one. Existing ids are never changed. Returns the number of ids added. */
export function assignIds(mission: Mission): number {
  const taken = allStepIds(mission);
  let added = 0;
  for (const v of walkSteps(mission)) {
    if (typeof v.step.id === "string" && v.step.id !== "") continue;
    const id = genId("s", taken);
    taken.add(id);
    v.step.id = id;
    added++;
  }
  const tTaken = new Set<string>();
  for (const t of [...(mission.triggers ?? []), ...(mission.interrupts ?? [])]) if (typeof t.id === "string") tTaken.add(t.id);
  const assign = (list: Trigger[] | undefined, prefix: "t" | "i"): void => {
    for (const t of list ?? []) {
      if (typeof t.id === "string" && t.id !== "") continue;
      const id = genId(prefix, tTaken);
      tTaken.add(id);
      t.id = id;
      added++;
    }
  };
  assign(mission.triggers, "t");
  assign(mission.interrupts, "i");
  return added;
}

/** Clone a step subtree giving every step a fresh id. */
export function cloneStepWithFreshIds(step: Step, taken: Set<string>): Step {
  const copy = deepClone(step);
  const renumber = (s: Step): void => {
    const id = genId("s", taken);
    taken.add(id);
    s.id = id;
    for (const key of CONTAINER_KEYS[s.type] ?? []) {
      const nested = s[key];
      if (Array.isArray(nested)) for (const child of nested as Step[]) renumber(child);
    }
    for (const child of s.on_fail?.before_retry ?? []) renumber(child);
  };
  renumber(copy);
  return copy;
}

export function countSteps(steps: Step[]): number {
  let n = 0;
  for (const _ of walkList(steps, [])) n++;
  return n;
}

/** Step ids that are nested below a step (excluding itself). */
export function nestedStepCount(step: Step): number {
  let n = 0;
  for (const _ of walkChildren(step, [])) n++;
  return n;
}
