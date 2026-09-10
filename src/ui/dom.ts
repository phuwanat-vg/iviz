/**
 * The tiny DOM helpers the whole UI is built from. iViz has no runtime UI
 * framework: elements are created with `h()` and sections follow one pattern.
 */

import { icon } from "./icons";
import type { IconName } from "./icons";

export type Props = Record<string, string | number | boolean | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue;
    if (k === "class") el.className = String(v);
    else if (k === "text") el.textContent = String(v);
    else if (k === "style") el.setAttribute("style", String(v));
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  el.append(...children);
  return el;
}

export function section(title: string, body: (HTMLElement | string)[], collapsed = false, iconName?: IconName): HTMLElement {
  const caret = h("span", { class: "caret", text: "▾" });
  const head = h("div", { class: "section-title" }, caret, ...(iconName ? [icon(iconName)] : []), h("span", { text: title }));
  const sec = h("div", { class: `section${collapsed ? " collapsed" : ""}` }, head, h("div", { class: "section-body" }, ...body));
  head.addEventListener("click", () => sec.classList.toggle("collapsed"));
  return sec;
}

/** A labelled row, the standard control layout in the sidebar. */
export function row(label: string, ...controls: (Node | string)[]): HTMLElement {
  return h("div", { class: "row" }, h("label", { text: label }), ...controls);
}
