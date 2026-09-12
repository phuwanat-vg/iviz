/**
 * A form built from a ROS message definition, used to fill in a service
 * request by hand.
 *
 * Primitives get the control that fits them, structs nest in a collapsible
 * group, and arrays are typed as JSON. That keeps every shape reachable
 * without building a tree editor.
 */

import type { MessageDefinition, MessageDefinitionField } from "@foxglove/message-definition";
import { h, row } from "./dom";

const INT64_TYPES = new Set(["int64", "uint64"]);
const FLOAT_TYPES = new Set(["float32", "float64"]);
const INT_TYPES = new Set(["int8", "uint8", "int16", "uint16", "int32", "uint32", "byte", "char"]);

interface Built {
  element: HTMLElement;
  get: () => unknown;
  /** Editable fields, so callers can tell an empty request from a filled one. */
  count: number;
}

export class MessageForm {
  readonly element: HTMLElement;
  readonly fieldCount: number;
  #get: () => unknown;

  constructor(definitions: MessageDefinition[], initial?: Record<string, unknown>) {
    const byName = new Map<string, MessageDefinition>();
    for (const def of definitions) if (def.name) byName.set(normalizeName(def.name), def);
    const root = definitions.find((d) => d.name === undefined) ?? definitions[0] ?? { definitions: [] };
    const built = buildStruct(root, byName, initial ?? {}, 0);
    this.element = built.element;
    this.fieldCount = built.count;
    this.#get = built.get;
  }

  /** The request object. Throws with a readable message on bad input. */
  value(): Record<string, unknown> {
    return (this.#get() ?? {}) as Record<string, unknown>;
  }
}

function buildStruct(def: MessageDefinition, byName: Map<string, MessageDefinition>, initial: Record<string, unknown>, depth: number): Built {
  const container = h("div", { class: "msg-form" });
  const getters: [string, () => unknown][] = [];
  let count = 0;

  for (const field of def.definitions) {
    if (field.isConstant) continue;
    const preset = initial[field.name];
    const built = buildField(field, byName, preset, depth);
    container.appendChild(built.element);
    getters.push([field.name, built.get]);
    count += built.count;
  }
  if (def.definitions.every((f) => f.isConstant) || getters.length === 0) {
    container.appendChild(h("div", { class: "nav-note", text: "This request has no fields." }));
  }

  return {
    element: container,
    count,
    get: () => {
      const out: Record<string, unknown> = {};
      for (const [name, get] of getters) out[name] = get();
      return out;
    },
  };
}

function buildField(field: MessageDefinitionField, byName: Map<string, MessageDefinition>, preset: unknown, depth: number): Built {
  const label = `${field.name}`;
  const hint = `${field.type}${field.isArray ? (field.arrayLength ? `[${field.arrayLength}]` : "[]") : ""}`;

  if (field.isArray) {
    const initialText = preset === undefined ? (field.defaultValue !== undefined ? json(field.defaultValue) : "[]") : json(preset);
    const input = h("input", { type: "text", class: "msg-json", value: initialText, title: `${hint} as JSON` });
    return {
      element: row(label, input, typeHint(hint)),
      count: 1,
      get: () => parseJson(input.value, field.name),
    };
  }

  if (field.isComplex) {
    const nested = byName.get(normalizeName(field.type));
    if (!nested) {
      const input = h("input", { type: "text", class: "msg-json", value: preset === undefined ? "{}" : json(preset), title: `${hint} as JSON` });
      return { element: row(label, input, typeHint(hint)), count: 1, get: () => parseJson(input.value, field.name) };
    }
    const inner = buildStruct(nested, byName, isRecord(preset) ? preset : {}, depth + 1);
    const box = h("details", { class: "msg-group" }, h("summary", {}, h("span", { class: "name", text: label }), h("span", { class: "type", text: hint })), inner.element);
    if (depth < 1) box.open = true;
    return { element: box, count: inner.count, get: inner.get };
  }

  if (field.type === "bool") {
    const input = h("input", { type: "checkbox" });
    input.checked = preset === undefined ? field.defaultValue === true : Boolean(preset);
    return { element: row(label, input, typeHint(hint)), count: 1, get: () => input.checked };
  }

  if (field.type === "time" || field.type === "duration") {
    const stamp = isRecord(preset) ? preset : {};
    const sec = h("input", { type: "number", step: "1", value: String(stamp.sec ?? 0), title: "seconds" });
    const nanosec = h("input", { type: "number", step: "1", value: String(stamp.nanosec ?? stamp.nsec ?? 0), title: "nanoseconds" });
    const pair = h("span", { class: "msg-pair" }, sec, nanosec);
    return {
      element: row(label, pair, typeHint(`${hint} (sec, nanosec)`)),
      count: 1,
      get: () => ({ sec: Number(sec.value) || 0, nanosec: Number(nanosec.value) || 0 }),
    };
  }

  if (INT64_TYPES.has(field.type)) {
    const input = h("input", { type: "text", value: preset === undefined ? String(field.defaultValue ?? 0) : String(preset), title: hint });
    return {
      element: row(label, input, typeHint(hint)),
      count: 1,
      get: () => {
        const text = input.value.trim() || "0";
        try {
          return BigInt(text);
        } catch {
          throw new Error(`${field.name} must be a whole number`);
        }
      },
    };
  }

  if (FLOAT_TYPES.has(field.type) || INT_TYPES.has(field.type)) {
    const step = FLOAT_TYPES.has(field.type) ? "any" : "1";
    const input = h("input", { type: "number", step, value: preset === undefined ? String(field.defaultValue ?? 0) : String(preset), title: hint });
    return {
      element: row(label, input, typeHint(hint)),
      count: 1,
      get: () => {
        const value = Number(input.value);
        if (!Number.isFinite(value)) throw new Error(`${field.name} must be a number`);
        return value;
      },
    };
  }

  // string, wstring and anything unexpected
  const input = h("input", { type: "text", value: preset === undefined ? String(field.defaultValue ?? "") : String(preset), title: hint });
  return { element: row(label, input, typeHint(hint)), count: 1, get: () => input.value };
}

function typeHint(text: string): HTMLElement {
  return h("span", { class: "msg-type", text });
}

function parseJson(text: string, fieldName: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`${fieldName} is not valid JSON`);
  }
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function normalizeName(name: string): string {
  return name.replace(/\/(?:msg|srv|action)\//, "/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
