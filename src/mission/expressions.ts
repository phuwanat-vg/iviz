/**
 * Expression helpers mirroring runner/mission_runner/expressions.py:
 * reference detection (`$name.path`, `${expr}`), interpolation scanning and a
 * light syntax check (balanced brackets and quotes, no empty expression).
 * The editor never evaluates expressions.
 */

import { isRecord } from "./types";

const REF_RE = /^\$([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]+\])*)$/;
const WHOLE_INTERP_RE = /^\$\{([^{}]*)\}$/;
const INTERP_RE = /\$\{([^{}]*)\}/g;

export const EXPRESSION_FUNCTIONS = ["abs", "min", "max", "len", "round", "int", "float", "str", "bool", "lower", "upper", "now", "distance", "hypot", "sqrt", "get"] as const;

/** True for strings of the form `$name.path` or `${...}` (whole string). */
export function isReference(value: unknown): value is string {
  return typeof value === "string" && (REF_RE.test(value) || WHOLE_INTERP_RE.test(value));
}

/** True when the string contains anything the runner would evaluate. */
export function hasExpression(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return value.includes("${") || REF_RE.test(value) || WHOLE_INTERP_RE.test(value);
}

/** Every expression string contained in `value` (deep), as the runner's collect_expressions. */
export function collectExpressions(value: unknown): string[] {
  const found: string[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      const m = REF_RE.exec(v);
      if (m) found.push(m[1]!);
      else if (v.includes("${")) for (const mm of v.matchAll(INTERP_RE)) found.push(mm[1]!);
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (isRecord(v)) Object.values(v).forEach(visit);
  };
  visit(value);
  return found;
}

/** Rewrite `$name` / `$.field` aliases outside string literals (runner's preprocess). */
export function preprocess(expr: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!;
    if (quote) {
      out += c;
      if (c === "\\" && i + 1 < expr.length) {
        out += expr[i + 1];
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      out += c;
      continue;
    }
    if (c === "$") {
      const next = expr[i + 1] ?? "";
      if (next === ".") {
        out += "payload.";
        i++;
        continue;
      }
      if (/[A-Za-z_]/.test(next)) continue;
    }
    out += c;
  }
  return out;
}

/**
 * Light syntax check: balanced (), [], {} and quotes, not empty, no dangling
 * binary operator. Returns an error message or null.
 */
export function checkExpression(expr: unknown): string | null {
  if (typeof expr !== "string") return "expression must be a string";
  const src = preprocess(expr).trim();
  if (src === "") return "empty expression";
  if (src.length > 2000) return "expression too long";
  const stack: string[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "(" || c === "[" || c === "{") stack.push(c);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== pairs[c]) return `unbalanced '${c}'`;
    }
  }
  if (quote) return "unterminated string";
  if (stack.length) return `unclosed '${stack[stack.length - 1]}'`;
  // Operator placement checks run on a copy with string literals blanked out.
  const bare = src.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''");
  if (/(?:==|!=|<=|>=|<|>|[+\-*/%])\s*$/.test(bare)) return "expression ends with an operator";
  if (/^\s*(?:==|!=|<=|>=|<|>|[*/%])/.test(bare)) return "expression starts with an operator";
  if (/\b(?:and|or|not|if|else|in)\s*$/.test(bare)) return "expression ends with a keyword";
  const dbl = /(?:==|!=|<=|>=|<|>)\s*(?:==|!=|<=|>=|<|>)/.exec(bare);
  if (dbl) return `unexpected '${dbl[0].replace(/\s+/g, "")}'`;
  if (/,\s*,|[(\[{]\s*,/.test(bare)) return "unexpected ','";
  return null;
}

/** Check every embedded expression of a value; returns the first problem. */
export function checkEmbeddedExpressions(value: unknown): string | null {
  for (const e of collectExpressions(value)) {
    const err = checkExpression(e);
    if (err) return `${err} in '${e}'`;
  }
  return null;
}

/** Render a 5-field cron string in words for the common daily/weekly forms. */
export function cronToWords(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hour) || dom !== "*" || mon !== "*") return cron;
  const time = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  if (dow === "*") return `${time} daily`;
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  if (/^[0-7]$/.test(dow)) return `${time} every ${names[Number(dow)]}`;
  if (/^[0-7](,[0-7])+$/.test(dow)) return `${time} ${dow.split(",").map((d) => names[Number(d)]).join(", ")}`;
  if (/^[0-7]-[0-7]$/.test(dow)) {
    const [a, b] = dow.split("-").map(Number) as [number, number];
    if (a === 1 && b === 5) return `${time} weekdays`;
    return `${time} ${names[a]}-${names[b]}`;
  }
  return cron;
}
