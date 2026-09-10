/**
 * Structural and semantic validation of a mission document. Mirrors the
 * checks of runner/mission_runner/model.py:validate_mission plus the
 * parameter shapes declared in the block registry. Findings are split into
 * errors (block deploy) and warnings.
 */

import type { Finding, Mission, Path, SitesDoc, ValidationResult } from "./types";
import { IDENTIFIER_RE, INPUT_TYPES, INTERRUPT_POLICIES, MISSION_NAME_RE, POLICIES, RESERVED_NAMES, STEP_ID_RE, GLOBAL_MISSION, isRecord } from "./types";
import type { ParamDef } from "./blocks";
import {
  CONNECTOR_EVENT_TYPES,
  CONNECTOR_STEP_TYPES,
  POSE_LIST_PARAMS,
  POSE_PARAMS,
  blockDef,
  containerKeys,
  isBtTemplateName,
  isKnownEventType,
  isKnownStepType,
  poseSiteRef,
  triggerDef,
} from "./blocks";
import { checkEmbeddedExpressions, checkExpression, hasExpression } from "./expressions";

export interface CapabilityInfo {
  available: boolean;
  reason?: string;
}

export interface ValidateContext {
  /** sites.json; null/undefined = unknown (site checks are skipped). */
  sites?: SitesDoc | null;
  /** Map the mission is validated against; defaults to sites.default_map. */
  activeMap?: string | null;
  /** Names of missions on the runner; null/undefined = unknown. */
  missions?: readonly string[] | null;
  /** Connector names configured on the robot; null/undefined = unknown. */
  connectors?: readonly string[] | null;
  capabilities?: { steps?: Record<string, CapabilityInfo>; triggers?: Record<string, CapabilityInfo> } | null;
}

class Collector {
  errors: Finding[] = [];
  warnings: Finding[] = [];
  err(path: Path, message: string, stepId?: string): void {
    this.errors.push(stepId ? { level: "error", path, stepId, message } : { level: "error", path, message });
  }
  warn(path: Path, message: string, stepId?: string): void {
    this.warnings.push(stepId ? { level: "warning", path, stepId, message } : { level: "warning", path, message });
  }
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNumOrExpr = (v: unknown): boolean => isNum(v) || (typeof v === "string" && v.startsWith("$"));

export function isValidPose(v: unknown): boolean {
  if (typeof v === "string") return v !== "";
  if (!isRecord(v)) return false;
  if ("site" in v) return typeof v.site === "string" && v.site !== "" && (v.yaw_deg === undefined || isNumOrExpr(v.yaw_deg)) && Object.keys(v).every((k) => k === "site" || k === "yaw_deg");
  if (!("x" in v) || !("y" in v)) return false;
  if (!isNumOrExpr(v.x) || !isNumOrExpr(v.y)) return false;
  if (v.yaw_deg !== undefined && !isNumOrExpr(v.yaw_deg)) return false;
  if (v.frame !== undefined && typeof v.frame !== "string") return false;
  return Object.keys(v).every((k) => ["x", "y", "yaw_deg", "frame"].includes(k));
}

export function isValidPoint(v: unknown): boolean {
  if (Array.isArray(v)) return (v.length === 2 || v.length === 3) && v.every(isNum);
  return isValidPose(v);
}

function checkParam(c: Collector, def: ParamDef, value: unknown, path: Path, sid: string | undefined, ctx: ValidateContext): void {
  const label = def.label;
  const bad = (what: string): void => c.err(path, `${label}: ${what}`, sid);
  switch (def.kind) {
    case "number":
    case "integer": {
      if (typeof value === "string" && def.allowExpr) {
        if (!value.startsWith("$")) bad("must be a number or a $expression");
        else if (hasExpression(value)) {
          const e = checkEmbeddedExpressions(value);
          if (e) c.warn(path, `${label}: ${e}`, sid);
        }
        return;
      }
      if (!isNum(value)) return bad(def.allowExpr ? "must be a number or a $expression" : "must be a number");
      if (def.kind === "integer" && !Number.isInteger(value)) return bad("must be an integer");
      if (def.min !== undefined && value < def.min) return bad(`must be at least ${def.min}`);
      if (def.max !== undefined && value > def.max) return bad(`must be at most ${def.max}`);
      return;
    }
    case "string":
    case "text":
    case "site":
    case "map":
    case "connector":
      if (typeof value !== "string") return bad("must be a string");
      if (def.required && value.trim() === "") return bad("is required");
      if (hasExpression(value)) {
        const e = checkEmbeddedExpressions(value);
        if (e) c.warn(path, `${label}: ${e}`, sid);
      }
      return;
    case "boolean":
      if (typeof value !== "boolean") bad("must be true or false");
      return;
    case "select":
      if (typeof value !== "string" || !(def.options ?? []).includes(value)) bad(`must be one of ${(def.options ?? []).join(", ")}`);
      return;
    case "expression": {
      if (typeof value !== "string") return bad("must be an expression string");
      if (value.trim() === "") return def.required ? bad("is required") : undefined;
      const e = checkExpression(value);
      if (e) c.warn(path, `${label}: ${e}`, sid);
      return;
    }
    case "value": {
      const e = checkEmbeddedExpressions(value);
      if (e) c.warn(path, `${label}: ${e}`, sid);
      return;
    }
    case "pose":
      if (!isValidPose(value)) return bad("must be a site name, {x, y, yaw_deg} or an expression");
      {
        const e = checkEmbeddedExpressions(value);
        if (e) c.warn(path, `${label}: ${e}`, sid);
      }
      return;
    case "poses":
    case "points": {
      if (!Array.isArray(value)) return bad("must be a list");
      if (value.length === 0) return bad("needs at least one entry");
      const ok = def.kind === "points" ? isValidPoint : isValidPose;
      value.forEach((p, i) => {
        if (!ok(p)) c.err([...path, i], `${label} ${i + 1}: not a valid ${def.kind === "points" ? "point" : "pose"}`, sid);
        else {
          const e = checkEmbeddedExpressions(p);
          if (e) c.warn([...path, i], `${label} ${i + 1}: ${e}`, sid);
        }
      });
      return;
    }
    case "json":
      if (!isRecord(value)) return bad("must be a JSON object");
      {
        const e = checkEmbeddedExpressions(value);
        if (e) c.warn(path, `${label}: ${e}`, sid);
      }
      return;
    case "steps":
      if (!Array.isArray(value)) bad("must be a list of steps");
      return;
    case "options":
      if (!Array.isArray(value) || value.length === 0 || !value.every((o) => typeof o === "string")) bad("must be a list of at least one text option");
      return;
    case "behavior_tree":
      if (typeof value === "string") {
        if (value.trim() === "") bad("file path is empty");
        return;
      }
      if (!isRecord(value)) return bad("must be a file path or a template");
      if (!isBtTemplateName(value.template)) return bad("unknown template");
      if (value.retries !== undefined && (!Number.isInteger(value.retries) || (value.retries as number) < 0 || (value.retries as number) > 20)) bad("retries must be 0-20");
      if (value.recoveries !== undefined && (!Array.isArray(value.recoveries) || !value.recoveries.every((r) => ["clear_costmap", "spin", "wait", "backup"].includes(String(r))))) bad("unknown recovery");
      if (value.replan_rate_hz !== undefined && (!isNum(value.replan_rate_hz) || value.replan_rate_hz < 0.1 || value.replan_rate_hz > 20)) bad("replan rate must be 0.1-20 Hz");
      for (const k of ["spin_deg", "backup_m", "wait_s"]) if (value[k] !== undefined && !isNum(value[k])) bad(`${k} must be a number`);
      for (const k of ["planner_id", "controller_id"]) if (value[k] !== undefined && typeof value[k] !== "string") bad(`${k} must be a string`);
      return;
    case "event_source":
      if (!isRecord(value)) return bad("must be an event source");
      checkEventSource(c, value, path, sid, ctx);
      return;
    default:
      return;
  }
}

function checkEventSource(c: Collector, src: Record<string, unknown>, path: Path, sid: string | undefined, ctx: ValidateContext): void {
  const type = typeof src.type === "string" ? src.type : "";
  if (!isKnownEventType(type)) {
    c.err([...path, "type"], `unknown event source '${type}'`, sid);
    return;
  }
  const def = triggerDef(type)!;
  for (const p of def.params) {
    const v = src[p.key];
    if (v === undefined) {
      if (p.required) c.err([...path, p.key], `${p.label} is required`, sid);
      continue;
    }
    checkParam(c, p, v, [...path, p.key], sid, ctx);
  }
  if (src.when !== undefined) {
    if (typeof src.when !== "string") c.err([...path, "when"], "when must be an expression string", sid);
    else if (src.when.trim() !== "") {
      const e = checkExpression(src.when);
      if (e) c.warn([...path, "when"], `when: ${e}`, sid);
    }
  }
  if (src.edge !== undefined && src.edge !== "any" && src.edge !== "rising") c.err([...path, "edge"], "edge must be 'any' or 'rising'", sid);
  if (src.debounce_s !== undefined && (!isNum(src.debounce_s) || src.debounce_s < 0)) c.err([...path, "debounce_s"], "debounce must be a number >= 0", sid);
  if (CONNECTOR_EVENT_TYPES.has(type) && ctx.connectors && typeof src.connector === "string" && !ctx.connectors.includes(src.connector)) {
    c.warn([...path, "connector"], `connector '${src.connector}' is not configured on the robot`, sid);
  }
  const cap = ctx.capabilities?.triggers?.[type];
  if (cap && cap.available === false) c.warn(path, `'${type}' is not available on this robot${cap.reason ? `: ${cap.reason}` : ""}`, sid);
}

interface WalkCtx {
  c: Collector;
  ctx: ValidateContext;
  mission: Mission;
  seenIds: Map<string, Path>;
  knownSites: Set<string> | null;
  otherMapSites: Set<string>;
  hasChangeMap: boolean;
  unattended: boolean;
}

function walkSteps(w: WalkCtx, list: unknown, listPath: Path, inLoop: boolean): void {
  if (!Array.isArray(list)) return;
  list.forEach((step, i) => {
    const path = [...listPath, i];
    if (!isRecord(step)) {
      w.c.err(path, "step must be an object");
      return;
    }
    checkStep(w, step, path, inLoop);
  });
}

function checkStep(w: WalkCtx, step: Record<string, unknown>, path: Path, inLoop: boolean): void {
  const { c, ctx } = w;
  const sid = typeof step.id === "string" ? step.id : undefined;
  const type = typeof step.type === "string" ? step.type : "";

  if (sid !== undefined) {
    if (!STEP_ID_RE.test(sid)) c.err([...path, "id"], `invalid step id '${sid}'`, sid);
    if (w.seenIds.has(sid)) c.err([...path, "id"], `duplicate step id '${sid}'`, sid);
    else w.seenIds.set(sid, path);
  } else if (step.id !== undefined) c.err([...path, "id"], "id must be a string");

  if (!isKnownStepType(type)) {
    c.err([...path, "type"], `unknown step type '${type}'`, sid);
    return;
  }
  const def = blockDef(type)!;

  // common fields
  if (step.name !== undefined && (typeof step.name !== "string" || step.name.length > 120)) c.err([...path, "name"], "name must be a string of at most 120 characters", sid);
  if (step.enabled !== undefined && typeof step.enabled !== "boolean") c.err([...path, "enabled"], "enabled must be true or false", sid);
  if (step.out !== undefined) {
    if (typeof step.out !== "string" || !IDENTIFIER_RE.test(step.out)) c.err([...path, "out"], "out must be a variable name (letters, digits, _)", sid);
    else if (RESERVED_NAMES.has(step.out)) c.err([...path, "out"], `'${step.out}' is a reserved name`, sid);
  }
  if (step.timeout_s !== undefined && (!isNum(step.timeout_s) || step.timeout_s <= 0)) c.err([...path, "timeout_s"], "timeout must be a number > 0", sid);
  if (step.on_fail !== undefined) {
    const f = step.on_fail;
    if (!isRecord(f)) c.err([...path, "on_fail"], "on_fail must be an object", sid);
    else {
      if (f.retry !== undefined && (!Number.isInteger(f.retry) || (f.retry as number) < 0 || (f.retry as number) > 100)) c.err([...path, "on_fail", "retry"], "retry must be an integer 0-100", sid);
      if (f.retry_delay_s !== undefined && (!isNum(f.retry_delay_s) || f.retry_delay_s < 0)) c.err([...path, "on_fail", "retry_delay_s"], "retry delay must be a number >= 0", sid);
      if (f.then !== undefined && f.then !== "abort" && f.then !== "continue") c.err([...path, "on_fail", "then"], "then must be 'abort' or 'continue'", sid);
      if (f.before_retry !== undefined && !Array.isArray(f.before_retry)) c.err([...path, "on_fail", "before_retry"], "before_retry must be a list of steps", sid);
      for (const k of Object.keys(f)) if (!["retry", "retry_delay_s", "before_retry", "then"].includes(k)) c.err([...path, "on_fail", k], `unknown on_fail field '${k}'`, sid);
    }
  }

  // type-specific parameters
  for (const p of def.params) {
    const v = step[p.key];
    if (v === undefined) {
      if (p.required) c.err([...path, p.key], `${p.label} is required`, sid);
      continue;
    }
    checkParam(c, p, v, [...path, p.key], sid, ctx);
  }
  if (type === "nav.follow_path" && step.points === undefined && step.path === undefined) c.err(path, "Follow path needs points or a path", sid);
  if (type === "if" && !Array.isArray(step.then)) c.err([...path, "then"], "'if' needs a 'then' list", sid);
  if (type === "loop") {
    if (step.count !== undefined && step.while !== undefined) c.err(path, "loop takes either 'count' or 'while', not both", sid);
    if (step.count !== undefined && !(Number.isInteger(step.count) && (step.count as number) >= 0) && typeof step.count !== "string") c.err([...path, "count"], "count must be an integer >= 0 or an expression", sid);
  }
  if (type === "break" && !inLoop) c.err(path, "'break' must be inside a loop", sid);
  if (type === "set" && typeof step.var === "string") {
    if (!IDENTIFIER_RE.test(step.var)) c.err([...path, "var"], "variable name must be letters, digits or _", sid);
    else if (RESERVED_NAMES.has(step.var)) c.err([...path, "var"], `'${step.var}' is a reserved name`, sid);
  }
  if (type === "ask_user") {
    const opts = Array.isArray(step.options) ? step.options.map(String) : ["Continue", "Stop"];
    if (typeof step.default === "string" && !opts.includes(step.default)) c.err([...path, "default"], `default '${step.default}' is not one of the options`, sid);
    if (step.timeout_s === undefined && w.unattended) c.warn(path, "ask_user without a timeout can block an unattended robot forever", sid);
  }
  if (type === "run_mission" && typeof step.mission === "string") {
    if (step.mission === w.mission.name) c.err([...path, "mission"], "a mission cannot run itself", sid);
    else if (ctx.missions && !ctx.missions.includes(step.mission)) c.err([...path, "mission"], `unknown mission '${step.mission}'`, sid);
  }
  if (CONNECTOR_STEP_TYPES.has(type) && ctx.connectors && typeof step.connector === "string" && !ctx.connectors.includes(step.connector)) {
    c.warn([...path, "connector"], `connector '${step.connector}' is not configured on the robot`, sid);
  }
  if (step.enabled === false) c.warn(path, "step is disabled", sid);
  const cap = ctx.capabilities?.steps?.[def.capability ?? type];
  if (cap && cap.available === false) c.warn(path, `'${type}' is not available on this robot${cap.reason ? `: ${cap.reason}` : ""}`, sid);

  // sites
  if (w.knownSites) {
    const refs: [Path, unknown][] = [];
    for (const key of POSE_PARAMS[type] ?? []) if (step[key] !== undefined) refs.push([[...path, key], step[key]]);
    for (const key of POSE_LIST_PARAMS[type] ?? []) {
      const list = step[key];
      if (Array.isArray(list)) list.forEach((v, i) => refs.push([[...path, key, i], v]));
    }
    for (const [rpath, value] of refs) {
      const site = poseSiteRef(value);
      if (site === null || w.knownSites.has(site)) continue;
      if (w.otherMapSites.has(site)) {
        if (!w.hasChangeMap) c.warn(rpath, `site '${site}' is not in the active map (defined in another map)`, sid);
      } else c.warn(rpath, `site '${site}' not found in the active map`, sid);
    }
    if (type === "nav.change_map" && typeof step.map === "string" && step.map !== "" && ctx.sites && !(step.map in ctx.sites.maps) && !step.map.endsWith(".yaml")) {
      c.warn([...path, "map"], `map '${step.map}' is not defined in sites.json`, sid);
    }
  }

  // nested lists
  for (const key of containerKeys(type)) if (step[key] !== undefined) walkSteps(w, step[key], [...path, key], inLoop || type === "loop");
  if (isRecord(step.on_fail) && Array.isArray(step.on_fail.before_retry)) walkSteps(w, step.on_fail.before_retry, [...path, "on_fail", "before_retry"], inLoop);
}

function checkTrigger(w: WalkCtx, t: Record<string, unknown>, path: Path, kind: "triggers" | "interrupts", seen: Set<string>): void {
  const { c, ctx } = w;
  if (t.id !== undefined) {
    if (typeof t.id !== "string" || !STEP_ID_RE.test(t.id)) c.err([...path, "id"], "invalid id");
    else if (seen.has(t.id)) c.err([...path, "id"], `duplicate ${kind.slice(0, -1)} id '${t.id}'`);
    else seen.add(t.id);
  }
  const type = typeof t.type === "string" ? t.type : "";
  if (!isKnownEventType(type)) {
    c.err([...path, "type"], `unknown ${kind.slice(0, -1)} type '${type}'`);
    return;
  }
  checkEventSource(c, t, path, undefined, ctx);
  if (t.name !== undefined && typeof t.name !== "string") c.err([...path, "name"], "name must be a string");
  if (t.enabled !== undefined && typeof t.enabled !== "boolean") c.err([...path, "enabled"], "enabled must be true or false");
  if (t.enabled === false) c.warn(path, `${kind.slice(0, -1)} is disabled`);
  const policies: readonly string[] = kind === "interrupts" ? INTERRUPT_POLICIES : POLICIES;
  if (t.policy !== undefined && (typeof t.policy !== "string" || !policies.includes(t.policy))) c.err([...path, "policy"], `policy must be one of ${policies.join(", ")}`);
  if (t.priority !== undefined && (!Number.isInteger(t.priority) || (t.priority as number) < 0 || (t.priority as number) > 100)) c.err([...path, "priority"], "priority must be an integer 0-100");
  if (t.set !== undefined) {
    if (!isRecord(t.set)) c.err([...path, "set"], "set must be an object of name → expression");
    else {
      const declared = new Set([...Object.keys(w.mission.inputs ?? {}), ...Object.keys(w.mission.vars ?? {})]);
      for (const [k, v] of Object.entries(t.set)) {
        if (!IDENTIFIER_RE.test(k)) c.err([...path, "set", k], `'${k}' is not a valid variable name`);
        if (typeof v !== "string") c.err([...path, "set", k], "must be an expression string");
        else {
          const e = checkExpression(v);
          if (e) c.warn([...path, "set", k], `${k}: ${e}`);
        }
        if (!declared.has(k)) c.warn([...path, "set", k], `'${k}' is not a declared input; it will still be set as a variable`);
      }
    }
  }
  if (kind === "interrupts") {
    if (typeof t.run !== "string" || t.run.trim() === "") c.err([...path, "run"], "interrupt needs a mission to run");
    else if (t.run === w.mission.name) c.err([...path, "run"], "an interrupt cannot run its own mission");
    else if (ctx.missions && !ctx.missions.includes(t.run)) c.err([...path, "run"], `unknown mission '${t.run}'`);
  } else if (t.run !== undefined) c.warn([...path, "run"], "'run' is ignored on triggers (only interrupts run another mission)");
  if (type === "mission.done" && ctx.missions && typeof t.mission === "string" && !ctx.missions.includes(t.mission)) c.warn([...path, "mission"], `unknown mission '${t.mission}'`);
}

/** Validate a document that may or may not be a well-formed mission. */
export function validate(doc: unknown, ctx: ValidateContext = {}): ValidationResult {
  const c = new Collector();
  if (!isRecord(doc)) {
    c.err([], "mission must be a JSON object");
    return { errors: c.errors, warnings: c.warnings };
  }
  if (doc.schema !== "mission/1") c.err(["schema"], "schema must be \"mission/1\"");
  const name = typeof doc.name === "string" ? doc.name : "";
  if (typeof doc.name !== "string") c.err(["name"], "name is required");
  else if (!MISSION_NAME_RE.test(name)) c.err(["name"], "invalid mission name: lowercase letters, digits, _ and -, starting with a letter, at most 64 characters");
  if (doc.title !== undefined && (typeof doc.title !== "string" || doc.title.length > 120)) c.err(["title"], "title must be a string of at most 120 characters");
  if (doc.description !== undefined && typeof doc.description !== "string") c.err(["description"], "description must be a string");
  if (doc.version !== undefined && (!Number.isInteger(doc.version) || (doc.version as number) < 1)) c.err(["version"], "version must be an integer >= 1");
  if (doc.policy !== undefined && (typeof doc.policy !== "string" || !(POLICIES as readonly string[]).includes(doc.policy))) c.err(["policy"], `policy must be one of ${POLICIES.join(", ")}`);
  if (doc.priority !== undefined && (!Number.isInteger(doc.priority) || (doc.priority as number) < 0 || (doc.priority as number) > 100)) c.err(["priority"], "priority must be an integer 0-100");
  for (const k of Object.keys(doc)) {
    if (!["schema", "name", "title", "description", "version", "policy", "priority", "inputs", "vars", "triggers", "interrupts", "flow", "on_abort"].includes(k)) c.err([k], `unknown field '${k}'`);
  }

  if (doc.inputs !== undefined) {
    if (!isRecord(doc.inputs)) c.err(["inputs"], "inputs must be an object");
    else {
      for (const [k, v] of Object.entries(doc.inputs)) {
        if (!IDENTIFIER_RE.test(k)) c.err(["inputs", k], `'${k}' is not a valid input name`);
        else if (RESERVED_NAMES.has(k)) c.err(["inputs", k], `'${k}' is a reserved name`);
        if (!isRecord(v)) c.err(["inputs", k], "input must be an object with a type");
        else {
          if (typeof v.type !== "string" || !(INPUT_TYPES as readonly string[]).includes(v.type)) c.err(["inputs", k, "type"], `type must be one of ${INPUT_TYPES.join(", ")}`);
          if (v.label !== undefined && typeof v.label !== "string") c.err(["inputs", k, "label"], "label must be a string");
          if (v.required !== undefined && typeof v.required !== "boolean") c.err(["inputs", k, "required"], "required must be true or false");
          for (const kk of Object.keys(v)) if (!["type", "label", "description", "default", "required"].includes(kk)) c.err(["inputs", k, kk], `unknown input field '${kk}'`);
        }
      }
    }
  }
  if (doc.vars !== undefined) {
    if (!isRecord(doc.vars)) c.err(["vars"], "vars must be an object");
    else
      for (const k of Object.keys(doc.vars)) {
        if (!IDENTIFIER_RE.test(k)) c.err(["vars", k], `'${k}' is not a valid variable name`);
        else if (RESERVED_NAMES.has(k)) c.err(["vars", k], `'${k}' is a reserved name`);
      }
  }
  if (!Array.isArray(doc.flow)) c.err(["flow"], "flow must be a list of steps");
  if (doc.on_abort !== undefined && !Array.isArray(doc.on_abort)) c.err(["on_abort"], "on_abort must be a list of steps");
  if (doc.triggers !== undefined && !Array.isArray(doc.triggers)) c.err(["triggers"], "triggers must be a list");
  if (doc.interrupts !== undefined && !Array.isArray(doc.interrupts)) c.err(["interrupts"], "interrupts must be a list");

  const mission = doc as unknown as Mission;
  const isGlobal = name === GLOBAL_MISSION;
  const triggers = Array.isArray(doc.triggers) ? doc.triggers : [];
  const interrupts = Array.isArray(doc.interrupts) ? doc.interrupts : [];
  const flow = Array.isArray(doc.flow) ? doc.flow : [];

  if (isGlobal && flow.length > 0) c.warn(["flow"], "the global mission's flow is ignored; only its interrupts are used");
  if (!isGlobal && flow.length === 0) c.warn(["flow"], "mission has no steps");

  // sites known?
  let knownSites: Set<string> | null = null;
  const otherMapSites = new Set<string>();
  if (ctx.sites && isRecord(ctx.sites.maps)) {
    const active = ctx.activeMap ?? ctx.sites.default_map ?? Object.keys(ctx.sites.maps)[0] ?? null;
    knownSites = new Set<string>();
    for (const [mapName, m] of Object.entries(ctx.sites.maps)) {
      const names = Object.keys(m.sites ?? {});
      if (mapName === active) names.forEach((n) => knownSites!.add(n));
      else names.forEach((n) => otherMapSites.add(n));
    }
  }
  const hasChangeMap = JSON.stringify(flow).includes('"nav.change_map"');

  const w: WalkCtx = {
    c,
    ctx,
    mission,
    seenIds: new Map(),
    knownSites,
    otherMapSites,
    hasChangeMap,
    unattended: !isGlobal && (triggers.length > 0 || interrupts.length > 0),
  };
  walkSteps(w, flow, ["flow"], false);
  if (Array.isArray(doc.on_abort)) walkSteps(w, doc.on_abort, ["on_abort"], false);

  for (const [kind, list] of [["triggers", triggers], ["interrupts", interrupts]] as const) {
    const seen = new Set<string>();
    list.forEach((t, i) => {
      if (!isRecord(t)) c.err([kind, i], `${kind.slice(0, -1)} must be an object`);
      else checkTrigger(w, t, [kind, i], kind, seen);
    });
  }

  // required inputs without default need a trigger 'set' or a caller
  if (isRecord(doc.inputs) && triggers.length > 0) {
    for (const [k, v] of Object.entries(doc.inputs)) {
      if (!isRecord(v) || v.required !== true || v.default !== undefined) continue;
      const setByTrigger = triggers.some((t) => isRecord(t) && isRecord(t.set) && k in t.set);
      if (!setByTrigger) c.warn(["inputs", k], `required input '${k}' is not set by any trigger`);
    }
  }

  return { errors: c.errors, warnings: c.warnings };
}

/** Findings grouped by step id (for badges). Findings without a step id go under "". */
export function findingsByStep(result: ValidationResult): Map<string, Finding[]> {
  const m = new Map<string, Finding[]>();
  for (const f of [...result.errors, ...result.warnings]) {
    const key = f.stepId ?? "";
    const arr = m.get(key);
    if (arr) arr.push(f);
    else m.set(key, [f]);
  }
  return m;
}

/** Findings whose path starts with `prefix`. */
export function findingsUnder(result: ValidationResult, prefix: Path): Finding[] {
  const out: Finding[] = [];
  for (const f of [...result.errors, ...result.warnings]) {
    if (f.path.length < prefix.length) continue;
    let ok = true;
    for (let i = 0; i < prefix.length; i++) if (f.path[i] !== prefix[i]) ok = false;
    if (ok) out.push(f);
  }
  return out;
}

export function pathToString(path: Path): string {
  return path.length === 0 ? "(mission)" : path.map((p) => (typeof p === "number" ? `[${p}]` : p)).join(".").replace(/\.\[/g, "[");
}
